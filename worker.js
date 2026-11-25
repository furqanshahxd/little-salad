// XAUUSD Grid Terminal – single-file Cloudflare Worker (UI + 24/7 server-side bot)
// Deploy: put this file next to a wrangler.toml containing:
//
// name = "xau-grid"
// main = "worker.js"
// compatibility_date = "2025-01-01"
// [[durable_objects.bindings]]
// name = "BOT"
// class_name = "GridBot"
// [[migrations]]
// tag = "v1"
// new_sqlite_classes = ["GridBot"]
// [triggers]
// crons = ["*/5 * * * *"]
//
// then run: npx wrangler deploy
// Admin key for closing positions is the ADMIN_KEY constant below
import { DurableObject } from "cloudflare:workers";

const ADMIN_KEY = "eOyxzCwMmeVS76X_ZLU45Jus"; // asked once when you press Close on a position
const CFG = { grids: 68, lo: 3200, hi: 3981, cap: 100, lev: 17, fee: 0.05 };
const TICK = 3000, STALE = 15000, HINT = "weur"; // HINT: Binance blocks US IPs, so run the bot in Europe
const SP = (CFG.hi - CFG.lo) / CFG.grids, NT = CFG.cap * CFG.lev / CFG.grids;
const lv = k => CFG.lo + k * SP;
const idxOf = p => Math.max(-1, Math.min(CFG.grids, Math.floor((p - CFG.lo) / SP)));
const BN = "https://fapi.binance.com/fapi/v1/", BY = "https://api.bybit.com/v5/market/";
const TF = { "1m": ["1m", "1"], "5m": ["5m", "5"], "15m": ["15m", "15"], "1h": ["1h", "60"], "4h": ["4h", "240"], "1d": ["1d", "D"] };
const J = async u => { const r = await fetch(u, { signal: AbortSignal.timeout(6000) }); if (!r.ok) throw new Error(new URL(u).host + " HTTP " + r.status); return r.json(); };

async function feed() {
  const e = [];
  try { const b = await J(BN + "ticker/24hr?symbol=XAUUSDT"); return { price: +b.lastPrice, chg: +b.priceChange, pct: +b.priceChangePercent, src: "Binance" }; } catch (x) { e.push(x.message); }
  try { const r = (await J(BY + "tickers?category=linear&symbol=XAUUSDT")).result.list[0], p = +r.lastPrice; return { price: p, chg: p - +r.prevPrice24h, pct: +r.price24hPcnt * 100, src: "Bybit" }; } catch (x) { e.push(x.message); }
  throw new Error(e.join(" | "));
}
const cc = new Map();
async function candles(tf) {
  const c = cc.get(tf); if (c && Date.now() - c.t < 20000) return c.d;
  let d;
  try { d = (await J(BN + "klines?symbol=XAUUSDT&interval=" + TF[tf][0] + "&limit=300")).map(r => ({ time: Math.floor(r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4] })); }
  catch (x) { d = (await J(BY + "kline?category=linear&symbol=XAUUSDT&interval=" + TF[tf][1] + "&limit=300")).result.list.reverse().map(r => ({ time: Math.floor(r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4] })); }
  cc.set(tf, { t: Date.now(), d }); return d;
}

export class GridBot extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.M = { price: null, t: 0, fails: 0, err: "", src: "", chg: null, pct: null }; this.lastT = 0; this.dirty = false;
    ctx.blockConcurrencyWhile(async () => {
      this.S = await ctx.storage.get("S"); this.lastT = (await ctx.storage.get("T")) || 0;
      if (!this.S) { this.S = { cash: CFG.cap, realized: 0, fees: 0, pos: [], closed: [], log: [], marks: [], lastIdx: null, nid: 1, startedAt: Date.now(), stats: { secured: 0, grossWin: 0, grossLoss: 0, wins: 0, losses: 0, n: 0, manual: 0 } }; this.log("Bot started with $" + CFG.cap + " available margin"); await this.save(); }
    });
  }
  live() { return this.M.t && Date.now() - this.M.t < STALE; }
  log(msg, c = "") { this.S.log.push({ t: Date.now(), msg, c }); this.dirty = true; }
  async save() { const S = this.S; S.log = S.log.slice(-300); S.closed = S.closed.slice(-500); S.marks = S.marks.slice(-600); this.dirty = false; await this.ctx.storage.put("S", S); }
  open(dir, k, tgt) {
    const S = this.S, L = lv(k), margin = NT / CFG.lev, fee = NT * CFG.fee / 100, side = dir > 0 ? "BUY" : "SELL";
    if (S.cash < margin + fee) return this.log("Skipped " + side + " @ " + L.toFixed(2) + ": insufficient available balance", "text-warning");
    S.cash -= margin + fee; S.fees += fee; S.realized -= fee;
    S.pos.push({ id: S.nid++, dir, entryK: k, tgtK: tgt, entry: L, qty: NT / L, margin, fee, t: Date.now() });
    S.marks.push({ t: Date.now(), s: dir > 0 ? "buy" : "sell" });
    this.log(side + " (open " + (dir > 0 ? "long" : "short") + ") " + (NT / L).toFixed(5) + " oz @ " + L.toFixed(2) + " · target " + lv(tgt).toFixed(2), dir > 0 ? "up" : "dn");
  }
  close(p, L, manual) {
    const S = this.S, st = S.stats, gross = p.dir * (L - p.entry) * p.qty, fee = p.qty * L * CFG.fee / 100, net = gross - p.fee - fee;
    S.cash += p.margin + gross - fee; S.fees += fee; S.realized += gross - fee; S.pos = S.pos.filter(x => x.id !== p.id);
    S.closed.push({ id: p.id, dir: p.dir, entry: p.entry, exit: L, qty: p.qty, fees: p.fee + fee, pnl: net, t0: p.t, t1: Date.now(), manual: !!manual });
    S.marks.push({ t: Date.now(), s: p.dir > 0 ? "sell" : "buy" });
    st.secured += net; st.n++; if (manual) st.manual++; if (net >= 0) { st.wins++; st.grossWin += net; } else { st.losses++; st.grossLoss += net; }
    this.log((manual ? "MANUAL CLOSE " : "") + (p.dir > 0 ? "SELL (close long)" : "BUY (close short)") + " " + p.qty.toFixed(5) + " oz @ " + L.toFixed(2) + " · net PnL " + (net >= 0 ? "+" : "−") + "$" + Math.abs(net).toFixed(2), net >= 0 ? "up" : "dn");
  }
  cross(k, dir) {
    const S = this.S, n = CFG.grids;
    if (dir === "dn") { const sh = S.pos.find(p => p.dir < 0 && p.tgtK === k); if (sh) this.close(sh, lv(k)); else if (k < n && !S.pos.some(p => p.entryK === k)) this.open(1, k, k + 1); }
    else { const lg = S.pos.find(p => p.dir > 0 && p.tgtK === k); if (lg) this.close(lg, lv(k)); else if (k >= 1 && !S.pos.some(p => p.entryK === k)) this.open(-1, k, k - 1); }
  }
  process(p) {
    const S = this.S, i = idxOf(p), a = S.lastIdx, gap = Date.now() - this.lastT > 90000;
    if (a === null || gap) { S.lastIdx = i; this.log("Monitoring from price " + p.toFixed(2) + (gap && a !== null ? " (resynced after a data gap)" : "")); return; }
    if (i < a) for (let k = a; k > i; k--) this.cross(k, "dn"); else if (i > a) for (let k = a + 1; k <= i; k++) this.cross(k, "up");
    if (i !== a) { S.lastIdx = i; this.dirty = true; }
  }
  async tick() {
    try {
      const f = await feed(); if (!isFinite(f.price) || f.price <= 0) throw new Error("Feed returned no valid price");
      Object.assign(this.M, f, { t: Date.now(), fails: 0, err: "" }); this.process(f.price); this.lastT = Date.now(); await this.ctx.storage.put("T", this.lastT);
    } catch (e) { this.M.fails++; this.M.err = e.message; }
    if (this.dirty) await this.save();
  }
  async alarm() { try { await this.tick(); } catch (e) { console.error(e); } finally { await this.ctx.storage.setAlarm(Date.now() + TICK); } }
  async state() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 200);
    const S = this.S; return { cfg: CFG, live: !!this.live(), M: this.M, S: { ...S, closed: S.closed.slice(-150), log: S.log.slice(-150) } };
  }
  async closeById(id) {
    const p = this.S.pos.find(x => x.id === id); if (!p) throw new Error("Position #" + id + " is not open");
    if (!this.live()) throw new Error("No live price right now, try again in a few seconds");
    this.close(p, this.M.price, true); await this.save(); return this.state();
  }
}

const HTML = `<!DOCTYPE html>
<html lang="en" data-bs-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>XAUUSD Grid Terminal</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js"></script>
<style>
:root{--bg:#15171a;--card:#1c1f23;--bd:#2b2f35;--gold:#d4a73a;--up:#2ebd85;--dn:#f0556a;--bs-body-bg:var(--bg);--bs-body-font-size:.875rem}
body{background:var(--bg);font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.tnum,td,.big{font-variant-numeric:tabular-nums}
.navbar,.box{background:var(--card);border:1px solid var(--bd);border-radius:6px}
.navbar{border-radius:0;border-width:0 0 1px}
.brand{font-weight:700;font-size:1.15rem;color:var(--gold);letter-spacing:.02em}
.box{padding:.85rem}.box h6{color:#9aa1ab;font-weight:600;margin-bottom:.6rem}
.big{font-size:2.1rem;font-weight:700;color:var(--gold);line-height:1}
.lbl{color:#8a919b;font-size:.75rem}.val{font-weight:600;font-size:1rem}
.up{color:var(--up)}.dn{color:var(--dn)}
.btn-gold{background:var(--gold);color:#16130a;border:0;font-weight:600}.btn-gold:hover{background:#e3b94c}
#chart{height:480px}
.table{--bs-table-bg:transparent;margin:0}.table th{color:#8a919b;font-weight:500;white-space:nowrap}
.scroll{max-height:320px;overflow:auto}
.nav-tabs .nav-link{color:#9aa1ab}.nav-tabs .nav-link.active{background:var(--card);color:var(--gold);border-color:var(--bd) var(--bd) var(--card)}
input.form-control,select.form-select{background:#14161a;font-size:.8rem}
@media(max-width:576px){#chart{height:360px}.big{font-size:1.7rem}}
</style>
</head>
<body>
<nav class="navbar px-3 py-2 gap-2 flex-wrap">
  <span class="brand">XAU/USD <small class="text-secondary fw-normal">Grid Terminal</small></span>
  <div class="d-flex gap-2 align-items-center flex-wrap ms-auto">
    <button id="bWd" class="badge text-bg-warning border-0" style="cursor:pointer">Withdraw</button><span id="feedB" class="badge"></span><span id="botB" class="badge"></span><span id="clock" class="small text-secondary tnum"></span>
  </div>
</nav>
<div id="toastBox" class="position-fixed top-0 end-0 p-3" style="z-index:1080"></div>
<div id="warn" class="alert alert-danger rounded-0 py-2 mb-0 small d-none"></div>
<main class="container-fluid p-3"><div class="row g-3">

  <div class="col-12 col-xl-4"><div class="box h-100">
    <h6>Market overview <span class="fw-normal">· external feed</span></h6>
    <div class="big" id="px">–</div>
    <div class="mt-2"><span id="chg" class="val">–</span> <span class="lbl">24h</span></div>
    <div class="row g-2 mt-1">
      <div class="col-12"><div class="lbl">Grid position</div><div class="val" id="gpos">–</div></div>
      <div class="col-6"><div class="lbl">Upper boundary</div><div class="val" id="up_">–</div></div>
      <div class="col-6"><div class="lbl">Lower boundary</div><div class="val" id="lo_">–</div></div>
      <div class="col-12"><div class="lbl">Last market update</div><div class="val" id="lastT">–</div></div>
    </div>
  </div></div>

  <div class="col-12 col-xl-8"><div class="box h-100">
    <h6>Account overview <span class="fw-normal text-secondary">· Funds are locked for 7 day period</span></h6>
    <div class="row g-3" id="acct"></div>
  </div></div>

  <div class="col-12 col-xl-8"><div class="box h-100">
    <h6>Bot status <span class="fw-normal text-secondary">· runs on the server, never stops</span></h6>
    <div class="row g-3">
      <div class="col-6 col-md-4"><div class="lbl">State</div><div class="val" id="bs_state">–</div></div>
      <div class="col-6 col-md-4"><div class="lbl">Running since</div><div class="val" id="bs_since">–</div></div>
      <div class="col-6 col-md-4"><div class="lbl">Net position</div><div class="val" id="bs_net">–</div></div>
      <div class="col-6 col-md-4"><div class="lbl">Open orders</div><div class="val" id="bs_ls">–</div></div>
      <div class="col-6 col-md-4"><div class="lbl">Margin used / free</div><div class="val" id="bs_margin">–</div></div>
      <div class="col-6 col-md-4"><div class="lbl">Next buy / sell level</div><div class="val" id="bs_near">–</div></div>
      <div class="col-12"><div class="lbl">Last action</div><div class="val small" id="bs_last">–</div></div>
    </div>
  </div></div>

  <div class="col-12 col-xl-4"><div class="box h-100">
    <h6>Secured profits <span class="fw-normal text-secondary">· closed trades, net of fees</span></h6>
    <div class="big" id="sec_total">–</div>
    <div class="row g-2 mt-1">
      <div class="col-6"><div class="lbl">Profit from winners</div><div class="val up" id="sec_win">–</div></div>
      <div class="col-6"><div class="lbl">Losses</div><div class="val dn" id="sec_loss">–</div></div>
      <div class="col-6"><div class="lbl">Win rate</div><div class="val" id="sec_rate">–</div></div>
      <div class="col-6"><div class="lbl">Closed / manual</div><div class="val" id="sec_n">–</div></div>
    </div>
  </div></div>

  <div class="col-12 col-xl-9"><div class="box">
    <div class="d-flex flex-wrap gap-2 mb-2">
      <div class="btn-group btn-group-sm" id="tfs"><button class="btn btn-outline-secondary" data-tf="1m">1m</button><button class="btn btn-outline-secondary" data-tf="5m">5m</button><button class="btn btn-outline-secondary" data-tf="15m">15m</button><button class="btn btn-outline-secondary" data-tf="1h">1h</button><button class="btn btn-outline-secondary" data-tf="4h">4h</button><button class="btn btn-outline-secondary" data-tf="1d">1D</button></div>
      <button class="btn btn-sm btn-outline-secondary ms-auto" id="bGrid">Toggle Grid</button>
      <button class="btn btn-sm btn-outline-secondary" id="bFit">Fit Chart</button>
    </div>
    <div id="chart"></div>
    <div class="lbl mt-1">Candles and price: configured feed (default Binance XAUUSDT perpetual, a live gold-spot-linked contract). Green lines = buy levels (below price), red = sell levels (above price); bright lines = nearest levels.</div>
  </div></div>

  <div class="col-12 col-xl-3"><div class="box h-100">
    <h6>Grid configuration</h6>
    <div class="row g-2 mb-2">
      <div class="col-6"><div class="lbl">Direction</div><div class="val">Neutral · Buy &amp; Sell</div></div>
      <div class="col-6"><div class="lbl">Type</div><div class="val">Arithmetic</div></div>
      <div class="col-6"><div class="lbl">Grids</div><div class="val" id="c_n"></div></div>
      <div class="col-6"><div class="lbl">Spacing</div><div class="val" id="c_sp"></div></div>
      <div class="col-6"><div class="lbl">Per-grid notional</div><div class="val" id="c_nt"></div></div>
      <div class="col-6"><div class="lbl">Fee / side</div><div class="val" id="c_fee"></div></div>
    </div>
    <div class="lbl">Fixed strategy, running 24/7 on the server.</div>
  </div></div>

  <div class="col-12"><div class="box">
    <ul class="nav nav-tabs mb-2" role="tablist">
      <li class="nav-item"><button class="nav-link active" data-bs-toggle="tab" data-bs-target="#t1">Open positions <span id="n1" class="badge text-bg-secondary"></span></button></li>
      <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#t2">Closed trades <span id="n2" class="badge text-bg-secondary"></span></button></li>
      <li class="nav-item"><button class="nav-link" data-bs-toggle="tab" data-bs-target="#t3">Transaction log</button></li>
    </ul>
    <div class="tab-content">
      <div class="tab-pane fade show active scroll" id="t1"></div>
      <div class="tab-pane fade scroll" id="t2"></div>
      <div class="tab-pane fade scroll" id="t3"></div>
    </div>
  </div></div>

</div></main>
<footer class="text-center text-secondary small py-3 border-top" style="border-color:var(--bd)!important">Developed by <a href="https://sfa.sfacorps.workers.dev" target="_blank" rel="noopener" class="text-warning text-decoration-none fw-semibold">SFA</a> · <a href="https://sfa.sfacorps.workers.dev" target="_blank" rel="noopener" class="text-secondary">sfa.sfacorps.workers.dev</a></footer>
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
<script>
'use strict';
const $ = id => document.getElementById(id);
const WITHDRAW_URL = 'https://www.binance.com/en/my/wallet/account/main/withdrawal/crypto'; // change to your own withdrawal page later
let S = { cfg: { grids: 68, lo: 3200, hi: 3981, cap: 100, lev: 17, fee: 0.05 }, cash: 0, realized: 0, fees: 0, pos: [], closed: [], log: [], marks: [], stats: {}, showGrid: true, tf: '15m' };
const M = { price: null, t: 0, fails: 0, err: '', chg: null, pct: null };
let LIVE = false;
const save = () => {};

/* ---------- grid math ---------- */
const spacing = () => (S.cfg.hi - S.cfg.lo) / S.cfg.grids;
const lv = k => S.cfg.lo + k * spacing();
const idxOf = p => Math.max(-1, Math.min(S.cfg.grids, Math.floor((p - S.cfg.lo) / spacing())));
const notional = () => S.cfg.cap * S.cfg.lev / S.cfg.grids;
const f2 = n => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const f5 = n => Number(n).toFixed(5);
const sgn = n => (n >= 0 ? '+' : '−') + '$' + f2(Math.abs(n));
const cls = n => n > 0 ? 'up' : n < 0 ? 'dn' : '';
const hms = t => t ? new Date(t).toLocaleTimeString() : '–';
const isLive = () => LIVE;
let candleSec = 900;
const mk = () => S.marks.filter(m => m.t).map(m => { const time = Math.floor(m.t / 1000 / candleSec) * candleSec;
  return m.s === 'buy' ? { time, position: 'belowBar', color: '#2ebd85', shape: 'arrowUp', text: 'B' } : { time, position: 'aboveBar', color: '#f0556a', shape: 'arrowDown', text: 'S' }; }).sort((a, b) => a.time - b.time);
function markTf() { document.querySelectorAll('#tfs button').forEach(b => b.classList.toggle('active', b.dataset.tf === S.tf)); }

const unreal = () => M.price == null ? 0 : S.pos.reduce((s, p) => s + p.dir * (M.price - p.entry) * p.qty, 0);

/* ---------- market data ---------- */
let chart, series, lastC = null, glines = [], gkey = '';
function apply(d) {
  S = Object.assign(d.S, { cfg: d.cfg, showGrid: S.showGrid, tf: S.tf }); Object.assign(M, d.M); LIVE = d.live;
  if (lastC && M.price != null) { const b = Math.floor(Date.now() / 1000 / candleSec) * candleSec, p = M.price;
    lastC = b > lastC.time ? { time: b, open: p, high: p, low: p, close: p } : { ...lastC, high: Math.max(lastC.high, p), low: Math.min(lastC.low, p), close: p }; series.update(lastC); }
}
async function sync() {
  try { const r = await fetch('/api/state', { cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status); apply(await r.json()); }
  catch (e) { M.err = 'Server unreachable: ' + e.message; LIVE = false; }
  render(); setTimeout(sync, 2000);
}
async function loadCandles() {
  try {
    const m = /^(\\d+)([mhd])$/.exec(S.tf); candleSec = +m[1] * { m: 60, h: 3600, d: 86400 }[m[2]];
    const rows = await (await fetch('/api/candles?tf=' + S.tf)).json();
    if (!Array.isArray(rows) || !rows.length) throw new Error('empty');
    series.setData(rows); lastC = rows[rows.length - 1]; series.setMarkers(mk());
  } catch (e) {}
  clearTimeout(window.__ct); window.__ct = setTimeout(loadCandles, 60000);
}

/* ---------- chart ---------- */
function initChart() {
  chart = LightweightCharts.createChart($('chart'), {
    layout: { background: { color: '#1c1f23' }, textColor: '#9aa1ab' },
    grid: { vertLines: { color: '#23272c' }, horzLines: { color: '#23272c' } },
    rightPriceScale: { borderColor: '#2b2f35' }, timeScale: { borderColor: '#2b2f35', timeVisible: true },
    crosshair: { mode: 0 }, autoSize: true
  });
  series = chart.addCandlestickSeries({ upColor: '#2ebd85', downColor: '#f0556a', borderVisible: false, wickUpColor: '#2ebd85', wickDownColor: '#f0556a', priceLineColor: '#d4a73a', priceLineWidth: 2,
    autoscaleInfoProvider: orig => {
      const r = orig(); if (!S.showGrid) return r;
      if (!r) return { priceRange: { minValue: S.cfg.lo, maxValue: S.cfg.hi } };
      return { priceRange: { minValue: Math.min(r.priceRange.minValue, S.cfg.lo), maxValue: Math.max(r.priceRange.maxValue, S.cfg.hi) }, margins: r.margins };
    } });
}
function drawGrid() {
  const i = M.price == null ? null : idxOf(M.price);
  const key = [S.showGrid, i, S.cfg.grids, S.cfg.lo, S.cfg.hi].join('|');
  if (key === gkey) return; gkey = key;
  glines.forEach(l => series.removePriceLine(l)); glines = [];
  if (!S.showGrid) return;
  const n = S.cfg.grids;
  for (let k = 0; k <= n; k++) {
    const L = lv(k), edge = k === 0 || k === n, buy = M.price == null ? false : L < M.price;
    const near = i !== null && (k === i || k === i + 1);
    const col = edge ? '#d4a73a' : M.price == null ? 'rgba(154,161,171,.55)' : buy ? (near ? '#2ebd85' : 'rgba(46,189,133,.65)') : (near ? '#f0556a' : 'rgba(240,85,106,.65)');
    glines.push(series.createPriceLine({ price: L, color: col, lineWidth: edge || near ? 2 : 1, lineStyle: 0,
      axisLabelVisible: edge || near, title: edge ? (k ? 'Upper' : 'Lower') : near ? (buy ? 'Buy' : 'Sell') : '' }));
  }
}

/* ---------- UI ---------- */
$('acct').innerHTML = ['Initial capital', 'Available balance', 'Total equity', 'Invested (margin)', 'Unrealized PnL', 'Realized PnL (net of fees)', 'Total trades', 'Fees paid']
  .map((l, i) => \`<div class="col-6 col-md-3"><div class="lbl">\${l}</div><div class="val big-sm" id="a\${i}">–</div></div>\`).join('');

function render() {
  const p = M.price, live = isLive();
  $('feedB').className = 'badge ' + (live ? 'text-bg-success' : 'text-bg-danger');
  $('feedB').textContent = live ? 'Feed live' : M.t ? 'Feed stale' : 'Feed offline';
  $('botB').className = 'badge text-bg-' + (live ? 'success' : 'warning');
  $('botB').textContent = live ? 'Bot running' : 'Bot waiting for live price';
  const w = $('warn');
  if (!live) { w.classList.remove('d-none'); w.textContent = (M.t ? \`Last market update \${new Date(M.t).toLocaleString()}. \` : 'Waiting for the first market price. ') + \`Trading is paused until a fresh live price arrives. \${M.err ? 'Error: ' + M.err + '.' : ''}\`; }
  else w.classList.add('d-none');
  $('px').textContent = p == null ? '–' : '$' + f2(p);
  $('chg').textContent = M.pct == null ? 'n/a' : \`\${M.chg >= 0 ? '+' : '−'}$\${f2(Math.abs(M.chg))} (\${M.pct >= 0 ? '+' : ''}\${M.pct.toFixed(2)}%)\`;
  $('chg').className = 'val ' + (M.pct == null ? '' : cls(M.pct));
  $('up_').textContent = '$' + f2(S.cfg.hi); $('lo_').textContent = '$' + f2(S.cfg.lo);
  $('lastT').textContent = M.t ? new Date(M.t).toLocaleString() : '–';
  if (p == null) $('gpos').textContent = '–';
  else { const i = idxOf(p); $('gpos').textContent = p < S.cfg.lo ? 'Below lower boundary: outside grid range' : p >= S.cfg.hi ? 'Above upper boundary: outside grid range' : \`Grid \${i + 1} of \${S.cfg.grids} · $\${f2(lv(i))} – $\${f2(lv(i + 1))}\`; }
  const u = unreal(), inv = S.pos.reduce((s, x) => s + x.margin, 0), eq = S.cash + inv + u;
  const a = [\`$\${f2(S.cfg.cap)}\`, \`$\${f2(S.cash)}\`, \`$\${f2(eq)}\`, \`$\${f2(inv)}\`, sgn(u), sgn(S.realized), S.closed.length + S.pos.length + ' orders · ' + S.closed.length + ' closed', \`$\${f5(S.fees)}\`];
  a.forEach((v, i) => { const e = $('a' + i); e.textContent = v; e.className = 'val ' + (i === 4 ? cls(u) : i === 5 ? cls(S.realized) : i === 2 ? cls(eq - S.cfg.cap) : ''); });
  $('c_n').textContent = S.cfg.grids; $('c_sp').textContent = '$' + spacing().toFixed(4); $('c_nt').textContent = '$' + f2(notional()); $('c_fee').textContent = S.cfg.fee + '%';
  const lg = S.pos.filter(x => x.dir > 0), sh = S.pos.filter(x => x.dir < 0), net = lg.reduce((s, x) => s + x.qty, 0) - sh.reduce((s, x) => s + x.qty, 0), st = S.stats || {};
  $('bs_state').textContent = live ? 'Running 24/7' : 'Waiting for live price'; $('bs_state').className = 'val ' + (live ? 'up' : 'text-warning');
  $('bs_since').textContent = S.startedAt ? new Date(S.startedAt).toLocaleString() : '–';
  $('bs_net').textContent = (net >= 0 ? 'Net long ' : 'Net short ') + f5(Math.abs(net)) + ' oz';
  $('bs_ls').textContent = lg.length + ' long · ' + sh.length + ' short';
  $('bs_margin').textContent = '$' + f2(inv) + ' / $' + f2(S.cash);
  $('bs_near').textContent = p == null || p < S.cfg.lo || p >= S.cfg.hi ? '–' : '$' + f2(lv(idxOf(p))) + ' / $' + f2(lv(idxOf(p) + 1));
  $('bs_last').textContent = S.log.length ? S.log[S.log.length - 1].msg : '–';
  $('sec_total').textContent = sgn(st.secured || 0); $('sec_total').className = 'big ' + cls(st.secured || 0);
  $('sec_win').textContent = sgn(st.grossWin || 0); $('sec_loss').textContent = sgn(st.grossLoss || 0);
  $('sec_rate').textContent = st.n ? (100 * st.wins / st.n).toFixed(1) + '%' : '–'; $('sec_n').textContent = (st.n || 0) + ' / ' + (st.manual || 0);
  drawGrid(); tables();
}
const th = a => '<thead><tr>' + a.map(x => \`<th>\${x}</th>\`).join('') + '</tr></thead>';
const empty = t => \`<div class="text-secondary p-2">\${t}</div>\`;
function tables() {
  $('n1').textContent = S.pos.length; $('n2').textContent = S.closed.length;
  $('t1').innerHTML = S.pos.length ? '<table class="table table-sm">' + th(['ID', 'Side', 'Entry', 'Target', 'Qty (oz)', 'Margin', 'Unrealized', 'Opened', '']) + '<tbody>' +
    S.pos.slice().reverse().map(x => { const u = M.price == null ? 0 : x.dir * (M.price - x.entry) * x.qty;
      return \`<tr><td>#\${x.id}</td><td class="\${x.dir > 0 ? 'up' : 'dn'}">\${x.dir > 0 ? 'Long (buy)' : 'Short (sell)'}</td><td>\${f2(x.entry)}</td><td>\${f2(lv(x.tgtK))}</td><td>\${f5(x.qty)}</td><td>$\${f2(x.margin)}</td><td class="\${cls(u)}">\${sgn(u)}</td><td>\${hms(x.t)}</td><td><button class="btn btn-sm btn-outline-danger py-0" data-close="\${x.id}">Close</button></td></tr>\`; }).join('') + '</tbody></table>' : empty('No open positions.');
  $('t2').innerHTML = S.closed.length ? '<table class="table table-sm">' + th(['ID', 'Side', 'Entry', 'Exit', 'Qty (oz)', 'Fees', 'Net PnL', 'Closed']) + '<tbody>' +
    S.closed.slice(-150).reverse().map(x => \`<tr><td>#\${x.id}</td><td class="\${x.dir > 0 ? 'up' : 'dn'}">\${x.dir > 0 ? 'Long' : 'Short'}\${x.manual ? ' · manual' : ''}</td><td>\${f2(x.entry)}</td><td>\${f2(x.exit)}</td><td>\${f5(x.qty)}</td><td>$\${f5(x.fees)}</td><td class="\${cls(x.pnl)}">\${sgn(x.pnl)}</td><td>\${new Date(x.t1).toLocaleString()}</td></tr>\`).join('') + '</tbody></table>' : empty('No closed trades yet.');
  $('t3').innerHTML = S.log.length ? '<table class="table table-sm"><tbody>' + S.log.slice(-150).reverse().map(x => \`<tr><td class="text-secondary" style="width:1%;white-space:nowrap">\${new Date(x.t).toLocaleString()}</td><td class="\${x.c}">\${x.msg}</td></tr>\`).join('') + '</tbody></table>' : empty('No activity yet.');
  if (series) series.setMarkers(mk());
}

/* ---------- controls ---------- */
$('bGrid').onclick = () => { S.showGrid = !S.showGrid; save(); render(); chart.priceScale('right').applyOptions({ autoScale: true }); };
$('bWd').onclick = () => {
  if (S.pos.length) { const d = document.createElement('div'); d.className = 'alert alert-danger shadow mb-2 py-2'; d.style.maxWidth = '360px';
    d.textContent = \`Withdrawal unavailable: \${S.pos.length} grid bot position\${S.pos.length > 1 ? 's are' : ' is'} still active.\`; $('toastBox').appendChild(d); setTimeout(() => d.remove(), 6000); return; }
  window.location.href = WITHDRAW_URL;
};
$('tfs').onclick = e => { const b = e.target.closest('[data-tf]'); if (!b) return;
  S.tf = b.dataset.tf; markTf(); lastC = null; loadCandles(); };
$('bFit').onclick = () => chart.timeScale().fitContent();
$('t1').onclick = async e => {
  const b = e.target.closest('[data-close]'); if (!b) return; const id = +b.dataset.close;
  if (!confirm('Close position #' + id + ' now at the market price?')) return;
  const toast = (m, c) => { const d = document.createElement('div'); d.className = 'alert alert-' + c + ' shadow mb-2 py-2'; d.style.maxWidth = '360px'; d.textContent = m; $('toastBox').appendChild(d); setTimeout(() => d.remove(), 6000); };
  const go = () => fetch('/api/close', { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': localStorage.getItem('adm') || '' }, body: JSON.stringify({ id }) });
  try {
    let r = await go();
    if (r.status === 401) { const k = prompt('Admin key'); if (!k) return; localStorage.setItem('adm', k); r = await go(); }
    const d = await r.json(); if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
    apply(d); render(); toast('Position #' + id + ' closed.', 'success');
  } catch (err) { toast('Could not close: ' + err.message, 'danger'); }
};

setInterval(() => { $('clock').textContent = new Date().toLocaleString(); render(); }, 1000);
initChart(); markTf(); render(); loadCandles(); sync();
</script>
</body>
</html>
`;
const bot = env => env.BOT.get(env.BOT.idFromName("main"), { locationHint: HINT });
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    try {
      if (u.pathname === "/api/state") return json(await bot(env).state());
      if (u.pathname === "/api/candles") { const tf = u.searchParams.get("tf") || "15m"; if (!TF[tf]) return json({ error: "bad tf" }, 400); return json(await candles(tf)); }
      if (u.pathname === "/api/close" && req.method === "POST") {
        if (req.headers.get("x-admin-key") !== (env.ADMIN_KEY || ADMIN_KEY)) return json({ error: "Admin key required" }, 401);
        return json(await bot(env).closeById(+(await req.json()).id));
      }
    } catch (e) { return json({ error: e.message }, 502); }
    return new Response(HTML, { headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" } });
  },
  async scheduled(_e, env, ctx) { ctx.waitUntil(bot(env).state()); } // safety net: re-arms the bot loop if it ever stopped
};
