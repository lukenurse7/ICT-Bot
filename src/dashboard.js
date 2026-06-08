'use strict';

require('dotenv').config();
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const { fetchAll: xauFetch }          = require('./data_xau');
const { runAnalysis }                 = require('./ict_xau');
const { sessionStatus, getAsiaSessionBounds, isWeekday } = require('./sessions');
const { fetchAllData: dj30Fetch }     = require('./data');
const { runICTAnalysis }              = require('./ict');
const { isKillZone, killZoneStatus }  = require('./killzone');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = process.env.PORT || 3000;

let latestXAU  = null;
let latestDJ30 = null;
let signalHistory = [];   // last 20 signals across both instruments

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

// ─── XAUUSD scan ─────────────────────────────────────────────────────────────
async function scanXAU() {
  if (!isWeekday()) return;
  const session     = sessionStatus();
  const alwaysActive = { ...session, active: true };
  const data        = await xauFetch();
  const asia        = getAsiaSessionBounds(data.h1);
  const result      = runAnalysis(data, asia, alwaysActive);

  latestXAU = {
    price:      result.quote.price,
    changePct:  result.quote.changePct,
    high:       result.quote.high,
    low:        result.quote.low,
    bias:       result.htf.bias,
    daily:      result.htf.daily,
    h4:         result.htf.h4,
    session:    session.label,
    sweep:      result.sweepResult.mostRecent,
    mss:        result.mss,
    fvg:        result.fvg,
    confluence: result.confluence,
    waitReason: result.waitReason,
    lvls:       result.lvls,
    signal:     result.signal,
    timestamp:  new Date().toISOString()
  };

  if (result.signal) {
    const sig = { ...result.signal, instrument: 'XAUUSD', id: `XAU_${Date.now()}` };
    signalHistory.unshift(sig);
    if (signalHistory.length > 20) signalHistory.pop();
    broadcast({ type: 'signal', signal: sig });
  }

  return latestXAU;
}

// ─── DJ30 scan ───────────────────────────────────────────────────────────────
async function scanDJ30() {
  const kz = killZoneStatus();
  const { candles15m, candles5m, quote } = await dj30Fetch();
  const analysis = runICTAnalysis(candles15m, candles5m);

  latestDJ30 = {
    price:     quote.price,
    changePct: quote.changePct,
    bias:      analysis.bias,
    kzActive:  isKillZone(),
    kzStatus:  kz.message,
    mss:       analysis.mss,
    liquidity: analysis.liquidity,
    signals:   isKillZone() ? analysis.signals : [],
    timestamp: new Date().toISOString()
  };

  if (isKillZone() && analysis.signals.length > 0) {
    for (const s of analysis.signals) {
      const sig = { ...s, instrument: 'DJ30', id: `DJ30_${Date.now()}` };
      signalHistory.unshift(sig);
      if (signalHistory.length > 20) signalHistory.pop();
      broadcast({ type: 'signal', signal: sig });
    }
  }

  return latestDJ30;
}

// ─── Combined scan ────────────────────────────────────────────────────────────
async function runScan() {
  const results = await Promise.allSettled([scanXAU(), scanDJ30()]);
  const xauErr  = results[0].status === 'rejected' ? results[0].reason?.message : null;
  const dj30Err = results[1].status === 'rejected' ? results[1].reason?.message : null;

  broadcast({
    type:          'update',
    timestamp:     new Date().toISOString(),
    xau:           latestXAU,
    dj30:          latestDJ30,
    signalHistory: signalHistory.slice(0, 20),
    errors:        { xau: xauErr, dj30: dj30Err }
  });
}

// ─── HTTP / WebSocket ─────────────────────────────────────────────────────────
app.get('/api/data', (req, res) => {
  res.json({ xau: latestXAU, dj30: latestDJ30, signalHistory });
});

app.get('/', (req, res) => res.send(getDashboardHTML()));

wss.on('connection', ws => {
  // Send current state immediately on connect
  ws.send(JSON.stringify({
    type: 'update', timestamp: new Date().toISOString(),
    xau: latestXAU, dj30: latestDJ30, signalHistory
  }));
  ws.on('message', async msg => {
    const d = JSON.parse(msg.toString());
    if (d.type === 'scan') await runScan().catch(() => {});
  });
});

// Scan every 60s
setInterval(() => runScan().catch(() => {}), 60_000);

server.listen(PORT, async () => {
  console.log(`\n  ◆ ICT Dashboard → http://localhost:${PORT}\n`);
  await runScan().catch(e => console.error('Initial scan error:', e.message));
});

module.exports = { server };

// ─── Dashboard HTML ───────────────────────────────────────────────────────────
function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ICT Signal Bot</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0a0a0a;--bg2:#111;--bg3:#161616;--bg4:#1c1c1c;
  --border:rgba(255,255,255,0.07);--border2:rgba(255,255,255,0.12);
  --text:#f0f0f0;--text2:#999;--text3:#555;
  --green:#4ade80;--red:#f87171;--amber:#fbbf24;--blue:#60a5fa;--purple:#a78bfa;
}
body{background:var(--bg);color:var(--text);font-family:'SF Mono','Fira Code',monospace;font-size:13px;min-height:100vh}
/* Header */
.hdr{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;border-bottom:1px solid var(--border);position:sticky;top:0;z-index:10;background:var(--bg)}
.hdr-title{font-size:13px;font-weight:700;letter-spacing:.06em}
.hdr-sub{font-size:10px;color:var(--text3);margin-top:2px}
.hdr-right{display:flex;gap:8px;align-items:center}
.pill{display:flex;align-items:center;gap:5px;font-size:10px;padding:4px 10px;border-radius:20px;border:1px solid var(--border);color:var(--text2);cursor:pointer;background:transparent;font-family:inherit;letter-spacing:.03em;transition:all .15s}
.pill:hover{border-color:var(--text2);color:var(--text)}
.dot{width:6px;height:6px;border-radius:50%;background:var(--text3)}
.dot.live{background:var(--green);animation:blink 2s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.25}}
/* Alert banner */
#alert-bar{display:none;position:fixed;top:0;left:0;right:0;z-index:100;padding:14px 24px;font-size:13px;font-weight:600;letter-spacing:.04em;cursor:pointer;animation:slideDown .3s ease}
@keyframes slideDown{from{transform:translateY(-100%)}to{transform:translateY(0)}}
#alert-bar.buy{background:rgba(74,222,128,.95);color:#000}
#alert-bar.sell{background:rgba(248,113,113,.95);color:#000}
/* Instruments row */
.inst-row{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--border);border-bottom:1px solid var(--border)}
.inst{background:var(--bg2);padding:16px 24px}
.inst-name{font-size:10px;color:var(--text3);letter-spacing:.07em;text-transform:uppercase;margin-bottom:8px}
.inst-price{font-size:26px;font-weight:700;letter-spacing:-.01em}
.inst-meta{display:flex;gap:16px;margin-top:6px;font-size:11px;color:var(--text2)}
.badge{display:inline-block;padding:2px 8px;border-radius:3px;font-size:10px;font-weight:600;letter-spacing:.04em;border:1px solid}
.badge-bull{color:var(--green);border-color:rgba(74,222,128,.35);background:rgba(74,222,128,.08)}
.badge-bear{color:var(--red);border-color:rgba(248,113,113,.35);background:rgba(248,113,113,.08)}
.badge-range{color:var(--amber);border-color:rgba(251,191,36,.35);background:rgba(251,191,36,.08)}
.badge-kz{color:var(--green);border-color:rgba(74,222,128,.35);background:rgba(74,222,128,.08)}
.badge-off{color:var(--text3);border-color:var(--border);background:transparent}
/* Steps */
.steps{padding:14px 24px;border-bottom:1px solid var(--border);background:var(--bg2)}
.steps-title{font-size:10px;color:var(--text3);letter-spacing:.07em;text-transform:uppercase;margin-bottom:10px}
.step-row{display:flex;align-items:center;gap:10px;padding:5px 0}
.step-icon{width:18px;text-align:center;font-size:12px}
.step-label{color:var(--text2);width:90px;flex-shrink:0}
.step-value{color:var(--text);flex:1}
.step-row.done .step-label{color:var(--green)}
.step-row.waiting .step-label{color:var(--text3)}
/* Confluence bar */
.conf-wrap{padding:14px 24px;border-bottom:1px solid var(--border)}
.conf-top{display:flex;justify-content:space-between;margin-bottom:8px;font-size:11px}
.conf-track{height:6px;background:var(--bg4);border-radius:3px;overflow:hidden}
.conf-fill{height:100%;border-radius:3px;transition:width .6s ease,background .6s}
/* Signal cards */
.sigs-section{padding:16px 24px}
.sigs-hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.sigs-title{font-size:10px;color:var(--text3);letter-spacing:.07em;text-transform:uppercase}
.sig-card{background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:14px 16px;margin-bottom:8px;position:relative;overflow:hidden}
.sig-card::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px}
.sig-card.buy::before{background:var(--green)}
.sig-card.sell::before{background:var(--red)}
.sig-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.sig-dir{font-size:14px;font-weight:700;letter-spacing:.04em}
.sig-meta{font-size:10px;color:var(--text3)}
.levels-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-bottom:10px}
.lvl{background:var(--bg4);border-radius:4px;padding:8px 10px}
.lvl-lbl{font-size:9px;color:var(--text3);letter-spacing:.04em;text-transform:uppercase;margin-bottom:4px}
.lvl-val{font-size:12px;font-weight:600}
.sig-footer{display:flex;align-items:center;gap:10px}
.sig-bar-wrap{flex:1;height:3px;background:var(--bg4);border-radius:2px;overflow:hidden}
.sig-bar{height:100%;border-radius:2px;transition:width .5s}
.sig-score{font-size:10px;color:var(--text2);min-width:36px;text-align:right}
.sig-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:8px}
.tag{font-size:9px;padding:2px 6px;border-radius:3px;border:1px solid var(--border);color:var(--text3)}
.empty{text-align:center;padding:32px;color:var(--text3);font-size:12px}
/* Footer */
.footer{padding:8px 24px;border-top:1px solid var(--border);font-size:10px;color:var(--text3);display:flex;justify-content:space-between}
</style>
</head>
<body>

<div id="alert-bar" onclick="dismissAlert()">
  <span id="alert-text"></span>
  <span style="float:right;font-size:10px;opacity:.7">click to dismiss</span>
</div>

<div class="hdr">
  <div>
    <div class="hdr-title">◆ ICT SIGNAL BOT</div>
    <div class="hdr-sub">XAUUSD (24/5) · DJ30 (14:00–16:00 GMT) · Auto-updates every 60s</div>
  </div>
  <div class="hdr-right">
    <div class="pill" id="live-pill"><div class="dot" id="live-dot"></div><span id="live-text">Connecting...</span></div>
    <button class="pill" onclick="enableNotifications()">🔔 Notifications</button>
    <button class="pill" onclick="requestScan()">↻ Scan now</button>
  </div>
</div>

<!-- Instrument prices -->
<div class="inst-row">
  <div class="inst">
    <div class="inst-name">XAUUSD · Gold</div>
    <div style="display:flex;align-items:baseline;gap:10px">
      <div class="inst-price" id="xau-price">—</div>
      <span id="xau-chg" style="font-size:13px">—</span>
    </div>
    <div class="inst-meta">
      <span id="xau-hl">—</span>
      <span id="xau-session">—</span>
      <span id="xau-bias-badge"></span>
    </div>
  </div>
  <div class="inst">
    <div class="inst-name">DJ30 · US30</div>
    <div style="display:flex;align-items:baseline;gap:10px">
      <div class="inst-price" id="dj-price">—</div>
      <span id="dj-chg" style="font-size:13px">—</span>
    </div>
    <div class="inst-meta">
      <span id="dj-kz">—</span>
      <span id="dj-bias-badge"></span>
    </div>
  </div>
</div>

<!-- XAUUSD setup steps -->
<div class="steps">
  <div class="steps-title">XAUUSD Setup Progress</div>
  <div class="step-row" id="step1">
    <div class="step-icon">1</div>
    <div class="step-label">Sweep</div>
    <div class="step-value" id="step1-val">Waiting...</div>
  </div>
  <div class="step-row" id="step2">
    <div class="step-icon">2</div>
    <div class="step-label">MSS / BOS</div>
    <div class="step-value" id="step2-val">—</div>
  </div>
  <div class="step-row" id="step3">
    <div class="step-icon">3</div>
    <div class="step-label">FVG Entry</div>
    <div class="step-value" id="step3-val">—</div>
  </div>
</div>

<!-- Confluence -->
<div class="conf-wrap">
  <div class="conf-top">
    <span style="color:var(--text2)">XAUUSD Confluence</span>
    <span id="conf-label" style="color:var(--text2)">—</span>
  </div>
  <div class="conf-track">
    <div class="conf-fill" id="conf-fill" style="width:0%;background:var(--text3)"></div>
  </div>
</div>

<!-- Signals -->
<div class="sigs-section">
  <div class="sigs-hdr">
    <span class="sigs-title">Signals</span>
    <span id="sigs-count" style="font-size:10px;color:var(--text3)">0 today</span>
  </div>
  <div id="sigs-container"><div class="empty">Connecting to bot...</div></div>
</div>

<div class="footer">
  <span id="footer-time">—</span>
  <span id="footer-status">—</span>
</div>

<script>
// ─── Audio alert (Web Audio API) ─────────────────────────────────────────────
function playAlert(type) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const freqs = type === 'buy' ? [440, 550, 660] : [660, 550, 440];
    freqs.forEach((f, i) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type      = 'sine';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.3, ctx.currentTime + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.12 + 0.25);
      osc.start(ctx.currentTime + i * 0.12);
      osc.stop(ctx.currentTime + i * 0.12 + 0.3);
    });
  } catch(e) {}
}

// ─── Browser push notifications ──────────────────────────────────────────────
let notifEnabled = false;
function enableNotifications() {
  if (!('Notification' in window)) { alert('Browser notifications not supported'); return; }
  Notification.requestPermission().then(p => {
    notifEnabled = p === 'granted';
    document.querySelector('[onclick="enableNotifications()"]').textContent =
      notifEnabled ? '🔔 On' : '🔔 Denied';
  });
}

function sendNotification(sig) {
  const isLong  = sig.direction === 'BUY' || sig.direction === 'long';
  const arrow   = isLong ? '▲' : '▼';
  const instr   = sig.instrument || sig.symbol || 'XAUUSD';
  const entry   = sig.entry || sig.entry;
  const title   = arrow + ' ' + (isLong ? 'BUY' : 'SELL') + ' ' + instr;
  const body    = 'Entry: ' + (entry?.toFixed?.(2) || entry) +
                  '  SL: '  + (sig.sl?.toFixed?.(2) || sig.sl) +
                  '  TP1: ' + (sig.tp1?.toFixed?.(2) || sig.tp1) +
                  '  Score: ' + (sig.confluence || sig.confluence) + '%';

  playAlert(isLong ? 'buy' : 'sell');

  // Alert bar
  const bar  = document.getElementById('alert-bar');
  const text = document.getElementById('alert-text');
  bar.className = isLong ? 'buy' : 'sell';
  text.textContent = title + '  |  ' + body;
  bar.style.display = 'block';
  setTimeout(dismissAlert, 15000);

  // Push notification
  if (notifEnabled) {
    new Notification(title, { body, icon: '', tag: 'ict-signal' });
  }
}

function dismissAlert() {
  document.getElementById('alert-bar').style.display = 'none';
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
let ws, reconnectTimer;
const seenSignals = new Set();

function connect() {
  ws = new WebSocket('ws://' + location.host);
  ws.onopen = () => {
    document.getElementById('live-dot').className  = 'dot live';
    document.getElementById('live-text').textContent = 'Live';
    setStatus('Connected');
  };
  ws.onclose = () => {
    document.getElementById('live-dot').className  = 'dot';
    document.getElementById('live-text').textContent = 'Reconnecting...';
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 4000);
  };
  ws.onmessage = e => {
    const d = JSON.parse(e.data);
    if (d.type === 'update') render(d);
    if (d.type === 'signal') {
      if (!seenSignals.has(d.signal.id)) {
        seenSignals.add(d.signal.id);
        sendNotification(d.signal);
      }
    }
  };
}

function requestScan() {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'scan' }));
}

function setStatus(msg) {
  document.getElementById('footer-status').textContent = msg;
}

// ─── Render ───────────────────────────────────────────────────────────────────
function fmtP(n, dec=2) { return n != null ? parseFloat(n).toFixed(dec) : '—'; }
function fmtT(iso) { if (!iso) return ''; const d = new Date(iso); return d.toUTCString().slice(17,22) + ' UTC'; }

function biasBadge(b) {
  if (!b) return '';
  const cls = b.includes('bull') ? 'badge-bull' : b.includes('bear') ? 'badge-bear' : 'badge-range';
  return '<span class="badge '+cls+'">'+b.toUpperCase().replace(/_/g,' ')+'</span>';
}

function render(d) {
  document.getElementById('footer-time').textContent = 'Last update: ' + fmtT(d.timestamp);

  // ── XAUUSD ───────────────────────────────────────────────────────────────────
  const x = d.xau;
  if (x) {
    document.getElementById('xau-price').textContent = '$' + fmtP(x.price);
    const xChg = document.getElementById('xau-chg');
    xChg.textContent = (x.changePct >= 0 ? '+' : '') + fmtP(x.changePct) + '%';
    xChg.style.color = x.changePct >= 0 ? 'var(--green)' : 'var(--red)';
    document.getElementById('xau-hl').textContent = 'H:'+fmtP(x.lvls?.pdh)+' L:'+fmtP(x.lvls?.pdl);
    document.getElementById('xau-session').textContent = x.session || '';
    document.getElementById('xau-bias-badge').innerHTML = biasBadge(x.bias);

    // Steps
    const hasSweep = !!x.sweep;
    const hasMSS   = x.mss?.confirmed;
    const hasFVG   = !!x.fvg;
    const inFVG    = x.fvg?.inFVG;

    function setStep(id, valId, done, text) {
      document.getElementById(id).className    = 'step-row ' + (done ? 'done' : 'waiting');
      document.getElementById(id).querySelector('.step-icon').textContent = done ? '✅' : '⏳';
      document.getElementById(valId).textContent = text;
    }

    setStep('step1','step1-val', hasSweep,
      hasSweep ? (x.sweep.dir==='bull'?'↓ SSL':'↑ BSL') + ' sweep on ' + x.sweep.levelName + ' (' + x.sweep.barsAgo + ' bars ago)' : 'Waiting for liquidity sweep');
    setStep('step2','step2-val', hasMSS,
      hasMSS ? x.mss.type + ' — ' + x.mss.description : (hasSweep ? 'Sweep detected — waiting for 5m BOS/MSS' : '—'));
    setStep('step3','step3-val', hasFVG && inFVG,
      hasFVG ? (inFVG ? '✓ Price inside FVG ' + x.fvg.entryZone : 'FVG ' + x.fvg.entryZone + ' — waiting for pullback') : (hasMSS ? 'MSS confirmed — waiting for FVG' : '—'));

    // Confluence
    const score = x.confluence?.score || 0;
    const grade = x.confluence?.grade || '—';
    const fill  = document.getElementById('conf-fill');
    fill.style.width      = score + '%';
    fill.style.background = score >= 80 ? 'var(--green)' : score >= 60 ? 'var(--amber)' : 'var(--red)';
    document.getElementById('conf-label').textContent = 'Grade ' + grade + '  ' + score + '/100';
    setStatus(x.waitReason || (x.signal ? 'Signal active' : 'Monitoring'));
  }

  // ── DJ30 ─────────────────────────────────────────────────────────────────────
  const dj = d.dj30;
  if (dj) {
    document.getElementById('dj-price').textContent = parseFloat(dj.price).toLocaleString('en-GB',{minimumFractionDigits:2});
    const djChg = document.getElementById('dj-chg');
    djChg.textContent = (dj.changePct >= 0 ? '+' : '') + fmtP(dj.changePct) + '%';
    djChg.style.color = dj.changePct >= 0 ? 'var(--green)' : 'var(--red)';
    const kzEl = document.getElementById('dj-kz');
    kzEl.textContent = dj.kzStatus;
    kzEl.style.color = dj.kzActive ? 'var(--green)' : 'var(--text3)';
    document.getElementById('dj-bias-badge').innerHTML = biasBadge(dj.bias);
  }

  // ── Signal cards ─────────────────────────────────────────────────────────────
  const allSigs = d.signalHistory || [];
  document.getElementById('sigs-count').textContent = allSigs.length + ' signal' + (allSigs.length !== 1 ? 's' : '');
  const container = document.getElementById('sigs-container');

  if (allSigs.length === 0) {
    // Show current wait status if no signals
    const waitMsg = d.xau?.waitReason || 'Monitoring — no signal yet';
    container.innerHTML = '<div class="empty">' + waitMsg + '</div>';
    return;
  }

  container.innerHTML = '';
  for (const sig of allSigs.slice(0, 10)) {
    const isLong  = sig.direction === 'BUY' || sig.direction === 'long';
    const instr   = sig.instrument || sig.symbol || 'XAUUSD';
    const dir     = isLong ? 'BUY' : 'SELL';
    const score   = sig.confluence || 0;
    const barClr  = score >= 80 ? 'var(--green)' : score >= 60 ? 'var(--amber)' : 'var(--red)';
    const entry   = sig.entry;
    const sl      = sig.sl;
    const tp1     = sig.tp1;
    const tp2     = sig.tp2;
    const tp3     = sig.tp3;
    const rr      = sig.rr1 || sig.rr || '—';

    const card = document.createElement('div');
    card.className = 'sig-card ' + (isLong ? 'buy' : 'sell');
    card.innerHTML =
      '<div class="sig-top">' +
        '<div>' +
          '<span class="sig-dir" style="color:' + (isLong?'var(--green)':'var(--red)') + '">' +
            (isLong?'▲ BUY':'▼ SELL') + ' — ' + instr +
          '</span>' +
          '&nbsp;&nbsp;<span class="badge ' + (isLong?'badge-bull':'badge-bear') + '">Grade ' + (sig.grade||'—') + '</span>' +
        '</div>' +
        '<span class="sig-meta">' + (fmtT(sig.timestamp)||'') + '</span>' +
      '</div>' +
      '<div class="levels-grid">' +
        '<div class="lvl"><div class="lvl-lbl">Entry</div><div class="lvl-val">' + fmtP(entry) + '</div></div>' +
        '<div class="lvl"><div class="lvl-lbl">Stop Loss</div><div class="lvl-val" style="color:var(--red)">' + fmtP(sl) + '</div></div>' +
        '<div class="lvl"><div class="lvl-lbl">TP1 (1:1.5R)</div><div class="lvl-val" style="color:var(--green)">' + fmtP(tp1) + '</div></div>' +
        '<div class="lvl"><div class="lvl-lbl">TP2</div><div class="lvl-val" style="color:var(--green)">' + fmtP(tp2) + '</div></div>' +
        '<div class="lvl"><div class="lvl-lbl">TP3</div><div class="lvl-val" style="color:var(--green)">' + fmtP(tp3) + '</div></div>' +
      '</div>' +
      '<div class="sig-footer">' +
        '<span style="font-size:10px;color:var(--text3)">Confluence</span>' +
        '<div class="sig-bar-wrap"><div class="sig-bar" style="width:'+score+'%;background:'+barClr+'"></div></div>' +
        '<span class="sig-score">'+score+'%</span>' +
        '<span style="font-size:10px;color:var(--text3)">R:R 1:'+rr+'</span>' +
      '</div>';
    container.appendChild(card);
  }
}

// Auto-request browser notification permission prompt note
document.addEventListener('DOMContentLoaded', () => {
  if (Notification.permission === 'granted') {
    notifEnabled = true;
    document.querySelector('[onclick="enableNotifications()"]').textContent = '🔔 On';
  }
});

connect();
</script>
</body>
</html>`;
}
