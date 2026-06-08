'use strict';

require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cron = require('node-cron');
const { fetchAllData } = require('./data');
const { runICTAnalysis } = require('./ict');
const { isKillZone, killZoneStatus } = require('./killzone');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

let latestData = null;
let signalHistory = [];

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

async function runScan() {
  try {
    const { candles15m, candles5m, quote } = await fetchAllData();
    const analysis = runICTAnalysis(candles15m, candles5m);
    const kzStatus = killZoneStatus();

    const payload = {
      type: 'update',
      timestamp: new Date().toISOString(),
      quote,
      analysis: {
        bias: analysis.bias,
        mss: analysis.mss,
        orderBlocks: analysis.orderBlocks,
        fvgs: analysis.fvgs,
        liquidity: analysis.liquidity
      },
      kzStatus,
      signals: isKillZone() ? analysis.signals : []
    };

    if (isKillZone() && analysis.signals.length > 0) {
      for (const sig of analysis.signals) {
        signalHistory.unshift({ ...sig, id: Date.now() });
        if (signalHistory.length > 50) signalHistory.pop();
      }
    }

    payload.signalHistory = signalHistory.slice(0, 10);
    latestData = payload;
    broadcast(payload);
    return payload;
  } catch (err) {
    const errPayload = { type: 'error', message: err.message };
    broadcast(errPayload);
    throw err;
  }
}

// REST endpoint — initial page load data
app.get('/api/data', async (req, res) => {
  try {
    if (latestData) return res.json(latestData);
    const data = await runScan();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve the dashboard HTML
app.get('/', (req, res) => {
  res.send(getDashboardHTML());
});

// WebSocket connection
wss.on('connection', (ws) => {
  if (latestData) ws.send(JSON.stringify(latestData));
  ws.on('message', async (msg) => {
    const data = JSON.parse(msg.toString());
    if (data.type === 'scan') {
      try {
        await runScan();
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: e.message }));
      }
    }
  });
});

// Scheduled scans
cron.schedule('*/5 * * * *', async () => {
  if (isKillZone()) await runScan().catch(() => {});
});
cron.schedule('*/15 * * * *', async () => {
  if (!isKillZone()) await runScan().catch(() => {});
});

server.listen(PORT, async () => {
  console.log(`\n  DJ30 Signal Bot Dashboard running at http://localhost:${PORT}\n`);
  await runScan().catch(e => console.error('Initial scan error:', e.message));
});

// ─── Dashboard HTML ─────────────────────────────────────────────────────────
function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DJ30 Signal Bot</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #0d0d0d; --bg2: #141414; --bg3: #1a1a1a; --border: rgba(255,255,255,0.08);
    --text: #f0f0f0; --text2: #888; --text3: #555;
    --green: #4ade80; --red: #f87171; --amber: #fbbf24; --blue: #60a5fa; --purple: #a78bfa;
  }
  body { background: var(--bg); color: var(--text); font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; }
  .header { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; border-bottom: 1px solid var(--border); }
  .header-title { font-size: 14px; font-weight: 600; letter-spacing: 0.05em; color: var(--text); }
  .header-sub { font-size: 11px; color: var(--text3); margin-top: 2px; }
  .kz-badge { display: flex; align-items: center; gap: 6px; font-size: 11px; padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border); color: var(--text2); }
  .kz-badge.active { border-color: var(--green); color: var(--green); }
  .kz-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text3); }
  .kz-dot.active { background: var(--green); animation: pulse 2s infinite; }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
  .scan-btn { background: transparent; border: 1px solid var(--border); color: var(--text2); padding: 6px 14px; border-radius: 4px; cursor: pointer; font-family: inherit; font-size: 11px; letter-spacing: 0.04em; transition: all 0.15s; }
  .scan-btn:hover { border-color: var(--text2); color: var(--text); }
  .grid4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: var(--border); border-bottom: 1px solid var(--border); }
  .metric { background: var(--bg); padding: 16px 20px; }
  .metric-label { font-size: 10px; color: var(--text3); letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 6px; }
  .metric-value { font-size: 22px; font-weight: 600; }
  .metric-sub { font-size: 11px; color: var(--text3); margin-top: 3px; }
  .green { color: var(--green); } .red { color: var(--red); } .amber { color: var(--amber); } .blue { color: var(--blue); }
  .body { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--border); min-height: 300px; }
  .panel { background: var(--bg2); padding: 16px 20px; }
  .panel-title { font-size: 10px; color: var(--text3); letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 14px; }
  .row { display: flex; align-items: center; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border); }
  .row:last-child { border-bottom: none; }
  .row-label { color: var(--text2); }
  .row-value { color: var(--text); font-weight: 500; }
  .tag { display: inline-block; font-size: 9px; letter-spacing: 0.05em; padding: 2px 6px; border-radius: 3px; margin: 1px; border: 1px solid; }
  .tag-ob { color: var(--blue); border-color: rgba(96,165,250,0.3); background: rgba(96,165,250,0.08); }
  .tag-fvg { color: var(--amber); border-color: rgba(251,191,36,0.3); background: rgba(251,191,36,0.08); }
  .tag-mss { color: var(--green); border-color: rgba(74,222,128,0.3); background: rgba(74,222,128,0.08); }
  .tag-liq { color: var(--purple); border-color: rgba(167,139,250,0.3); background: rgba(167,139,250,0.08); }
  .tag-kz { color: var(--text2); border-color: var(--border); background: transparent; }
  .signals-section { background: var(--bg3); border-top: 1px solid var(--border); padding: 16px 20px; }
  .sig-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
  .sig-title { font-size: 10px; color: var(--text3); letter-spacing: 0.06em; text-transform: uppercase; }
  .signal-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; padding: 14px 16px; margin-bottom: 8px; }
  .signal-card.long { border-left: 2px solid var(--green); }
  .signal-card.short { border-left: 2px solid var(--red); }
  .sig-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
  .sig-dir { font-size: 13px; font-weight: 700; letter-spacing: 0.04em; }
  .sig-time { font-size: 10px; color: var(--text3); }
  .levels { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 10px 0; }
  .level { background: var(--bg3); border-radius: 4px; padding: 6px 10px; }
  .level-lbl { font-size: 9px; color: var(--text3); letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 3px; }
  .level-val { font-size: 13px; font-weight: 600; }
  .conf-row { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
  .conf-bar-wrap { flex: 1; height: 3px; background: var(--bg3); border-radius: 2px; overflow: hidden; }
  .conf-bar { height: 100%; border-radius: 2px; background: var(--green); transition: width 0.5s; }
  .conf-pct { font-size: 11px; color: var(--text2); min-width: 32px; text-align: right; }
  .empty { text-align: center; padding: 40px; color: var(--text3); }
  .log { background: var(--bg); border-top: 1px solid var(--border); padding: 10px 20px; font-size: 10px; color: var(--text3); max-height: 60px; overflow-y: auto; line-height: 2; }
  .error-banner { background: rgba(248,113,113,0.1); border: 1px solid rgba(248,113,113,0.3); color: var(--red); padding: 10px 16px; font-size: 11px; margin: 8px 20px; border-radius: 4px; display: none; }
</style>
</head>
<body>

<div class="header">
  <div>
    <div class="header-title">DJ30 ICT SIGNAL BOT</div>
    <div class="header-sub">NY Kill Zone · 14:00–16:00 GMT · Real-time via TwelveData</div>
  </div>
  <div style="display:flex; gap:10px; align-items:center;">
    <div class="kz-badge" id="kz-badge">
      <div class="kz-dot" id="kz-dot"></div>
      <span id="kz-text">Checking...</span>
    </div>
    <button class="scan-btn" onclick="requestScan()">↻ Scan now</button>
  </div>
</div>

<div id="error-banner" class="error-banner"></div>

<div class="grid4">
  <div class="metric"><div class="metric-label">DJ30</div><div class="metric-value" id="m-price">—</div><div class="metric-sub" id="m-change">—</div></div>
  <div class="metric"><div class="metric-label">HTF Bias</div><div class="metric-value" id="m-bias">—</div><div class="metric-sub" id="m-bias-sub">4H structure</div></div>
  <div class="metric"><div class="metric-label">Signals today</div><div class="metric-value" id="m-sigs">0</div><div class="metric-sub">session</div></div>
  <div class="metric"><div class="metric-label">Last scan</div><div class="metric-value" style="font-size:14px;" id="m-scan">—</div><div class="metric-sub" id="m-next">—</div></div>
</div>

<div class="body">
  <div class="panel">
    <div class="panel-title">Market Structure</div>
    <div class="row"><span class="row-label">MSS type</span><span class="row-value" id="p-mss">—</span></div>
    <div class="row"><span class="row-label">MSS level</span><span class="row-value" id="p-mss-lvl">—</span></div>
    <div class="row"><span class="row-label">Bull OB</span><span class="row-value" id="p-ob-bull">—</span></div>
    <div class="row"><span class="row-label">Bear OB</span><span class="row-value" id="p-ob-bear">—</span></div>
    <div class="row"><span class="row-label">BSL (above)</span><span class="row-value amber" id="p-bsl">—</span></div>
    <div class="row"><span class="row-label">SSL (below)</span><span class="row-value amber" id="p-ssl">—</span></div>
  </div>
  <div class="panel">
    <div class="panel-title">Confluences (5m)</div>
    <div class="row"><span class="row-label">Bullish FVG</span><span class="row-value" id="p-fvg-bull">—</span></div>
    <div class="row"><span class="row-label">Bearish FVG</span><span class="row-value" id="p-fvg-bear">—</span></div>
    <div class="row"><span class="row-label">Active FVGs</span><span class="row-value blue" id="p-fvg-count">—</span></div>
    <div class="row"><span class="row-label">Bull OB (5m)</span><span class="row-value" id="p-ob5-bull">—</span></div>
    <div class="row"><span class="row-label">Bear OB (5m)</span><span class="row-value" id="p-ob5-bear">—</span></div>
    <div class="row"><span class="row-label">EQ Bull OB</span><span class="row-value" id="p-eq">—</span></div>
  </div>
</div>

<div class="signals-section">
  <div class="sig-header">
    <span class="sig-title">Signals</span>
    <span style="font-size:10px; color:var(--text3);" id="sig-note">Kill Zone only</span>
  </div>
  <div id="signals-container">
    <div class="empty">Waiting for scan data...</div>
  </div>
</div>

<div class="log" id="log">Connecting to data feed...</div>

<script>
const fmt = p => p ? Math.round(p).toLocaleString('en-GB') : '—';
const fmtTime = iso => { const d = new Date(iso); return d.toTimeString().slice(0,8) + ' GMT'; };

let ws;
let sigCount = 0;

function connect() {
  ws = new WebSocket('ws://' + location.host);
  ws.onopen = () => addLog('Connected to signal bot');
  ws.onclose = () => { addLog('Connection lost — reconnecting...'); setTimeout(connect, 3000); };
  ws.onerror = () => addLog('WebSocket error');
  ws.onmessage = e => {
    const data = JSON.parse(e.data);
    if (data.type === 'error') {
      showError(data.message);
      return;
    }
    if (data.type === 'update') render(data);
  };
}

function requestScan() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'scan' }));
    addLog('Manual scan triggered...');
  }
}

function addLog(msg) {
  const log = document.getElementById('log');
  const t = new Date().toTimeString().slice(0,8);
  log.textContent = '[' + t + '] ' + msg;
}

function showError(msg) {
  const b = document.getElementById('error-banner');
  b.style.display = 'block';
  b.textContent = '✗ ' + msg;
}

function render(data) {
  document.getElementById('error-banner').style.display = 'none';

  // KZ status
  const kzActive = data.kzStatus.active;
  const badge = document.getElementById('kz-badge');
  const dot = document.getElementById('kz-dot');
  badge.className = 'kz-badge' + (kzActive ? ' active' : '');
  dot.className = 'kz-dot' + (kzActive ? ' active' : '');
  document.getElementById('kz-text').textContent = data.kzStatus.message;

  // Quote
  const q = data.quote;
  document.getElementById('m-price').textContent = fmt(q.price);
  const chgEl = document.getElementById('m-change');
  chgEl.textContent = (q.changePct > 0 ? '+' : '') + q.changePct.toFixed(2) + '%';
  chgEl.className = 'metric-sub ' + (q.changePct >= 0 ? 'green' : 'red');

  // Bias
  const bias = data.analysis.bias;
  const biasEl = document.getElementById('m-bias');
  biasEl.textContent = bias.toUpperCase();
  biasEl.className = 'metric-value ' + (bias === 'bullish' ? 'green' : bias === 'bearish' ? 'red' : 'amber');

  // Scan time
  document.getElementById('m-scan').textContent = fmtTime(data.timestamp).slice(0,5);
  document.getElementById('m-next').textContent = 'auto-refresh 5m';

  // Structure panel
  const mss = data.analysis.mss;
  document.getElementById('p-mss').textContent = mss ? mss.type.replace('_', ' ') : 'none';
  document.getElementById('p-mss').className = 'row-value ' + (mss ? (mss.type.includes('bull') ? 'green' : 'red') : '');
  document.getElementById('p-mss-lvl').textContent = mss ? fmt(mss.level) : '—';

  const obs = data.analysis.orderBlocks;
  document.getElementById('p-ob-bull').textContent = obs.bullish ? fmt(obs.bullish.low) + '–' + fmt(obs.bullish.high) : 'none';
  document.getElementById('p-ob-bear').textContent = obs.bearish ? fmt(obs.bearish.low) + '–' + fmt(obs.bearish.high) : 'none';
  document.getElementById('p-ob5-bull').textContent = obs.bullish ? fmt(obs.bullish.eq) + ' EQ' : 'none';
  document.getElementById('p-ob5-bear').textContent = obs.bearish ? fmt(obs.bearish.eq) + ' EQ' : 'none';
  document.getElementById('p-eq').textContent = obs.bullish ? fmt(obs.bullish.eq) : '—';

  const liq = data.analysis.liquidity;
  document.getElementById('p-bsl').textContent = liq.nearestBSL ? fmt(liq.nearestBSL) : '—';
  document.getElementById('p-ssl').textContent = liq.nearestSSL ? fmt(liq.nearestSSL) : '—';

  const fvgs = data.analysis.fvgs;
  document.getElementById('p-fvg-bull').textContent = fvgs.bullish ? fmt(fvgs.bullish.bottom) + '–' + fmt(fvgs.bullish.top) : 'none';
  document.getElementById('p-fvg-bear').textContent = fvgs.bearish ? fmt(fvgs.bearish.bottom) + '–' + fmt(fvgs.bearish.top) : 'none';
  document.getElementById('p-fvg-count').textContent = fvgs.all ? fvgs.all.length + ' active' : '0';

  // Signals
  const sigs = data.signals || [];
  const history = data.signalHistory || [];
  const allSigs = [...sigs, ...history.filter(s => !sigs.find(x => x.timestamp === s.timestamp))];

  sigCount = history.length;
  document.getElementById('m-sigs').textContent = sigCount;

  const container = document.getElementById('signals-container');
  if (allSigs.length === 0) {
    container.innerHTML = '<div class="empty">' + (kzActive ? 'No high-confluence setup detected yet' : 'Signals only generated during Kill Zone (14:00–16:00 GMT)') + '</div>';
  } else {
    container.innerHTML = '';
    for (const sig of allSigs.slice(0, 5)) {
      const isLong = sig.direction === 'long';
      const tagHtml = sig.tags.map(t => {
        const cls = t.includes('OB') ? 'tag-ob' : t.includes('FVG') ? 'tag-fvg' : t.includes('MSS') || t.includes('BOS') ? 'tag-mss' : t.includes('LIQ') ? 'tag-liq' : 'tag-kz';
        return '<span class="tag ' + cls + '">' + t + '</span>';
      }).join('');

      const card = document.createElement('div');
      card.className = 'signal-card ' + sig.direction;
      card.innerHTML =
        '<div class="sig-top">' +
          '<div style="display:flex;align-items:center;gap:10px;">' +
            '<span class="sig-dir ' + (isLong ? 'green' : 'red') + '">' + (isLong ? '▲ LONG' : '▼ SHORT') + ' — DJ30</span>' +
            '<span>' + tagHtml + '</span>' +
          '</div>' +
          '<span class="sig-time">' + (sig.timestamp ? fmtTime(sig.timestamp) : '') + '</span>' +
        '</div>' +
        '<div class="levels">' +
          '<div class="level"><div class="level-lbl">Entry</div><div class="level-val">' + fmt(sig.entry) + '</div></div>' +
          '<div class="level"><div class="level-lbl">Stop loss</div><div class="level-val red">' + fmt(sig.sl) + '</div></div>' +
          '<div class="level"><div class="level-lbl">TP1</div><div class="level-val green">' + fmt(sig.tp1) + '</div></div>' +
          '<div class="level"><div class="level-lbl">TP2</div><div class="level-val green">' + fmt(sig.tp2) + '</div></div>' +
        '</div>' +
        '<div class="conf-row">' +
          '<span style="font-size:10px;color:var(--text3);">Confluence</span>' +
          '<div class="conf-bar-wrap"><div class="conf-bar" style="width:' + sig.confluence + '%;"></div></div>' +
          '<span class="conf-pct">' + sig.confluence + '%</span>' +
          '<span style="font-size:10px;color:var(--text3);">R:R 1:' + sig.rr + '</span>' +
        '</div>';
      container.appendChild(card);
    }
  }

  addLog('Data updated · bias: ' + data.analysis.bias + ' · signals: ' + sigs.length);
}

connect();
</script>
</body>
</html>`;
}

module.exports = { app, server };
