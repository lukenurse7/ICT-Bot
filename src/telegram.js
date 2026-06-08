'use strict';

const axios = require('axios');

const TOKEN   = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BASE    = `https://api.telegram.org/bot${TOKEN}`;

async function send(text) {
  if (!TOKEN || !CHAT_ID) return;
  try {
    await axios.post(`${BASE}/sendMessage`, {
      chat_id:    CHAT_ID,
      text,
      parse_mode: 'HTML'
    }, { timeout: 8000 });
  } catch (e) {
    console.log('[Telegram] Send failed:', e.message);
  }
}

function signalMessage(sig) {
  const isLong = sig.direction === 'BUY' || sig.direction === 'long';
  const arrow  = isLong ? '🟢' : '🔴';
  const dir    = isLong ? 'BUY' : 'SELL';
  const instr  = sig.instrument || sig.symbol || 'XAUUSD';
  const grade  = sig.grade || '—';
  const score  = sig.confluence || sig.confluence || '—';

  const entry = parseFloat(sig.entry).toFixed(2);
  const sl    = parseFloat(sig.sl).toFixed(2);
  const tp1   = parseFloat(sig.tp1).toFixed(2);
  const tp2   = parseFloat(sig.tp2).toFixed(2);
  const tp3   = parseFloat(sig.tp3).toFixed(2);
  const rr    = sig.rr1 || sig.rr || '—';

  const setup = sig.setup || {};
  const sweep = setup.sweep?.levelName || sig.sweep || '';
  const mss   = setup.mss?.type || sig.mssType || '';

  const time  = new Date().toUTCString().slice(0, 25);

  return (
`${arrow} <b>${dir} — ${instr}</b>
📊 Confluence: <b>${score}%</b>  Grade: <b>${grade}</b>
🕐 ${time}

💰 <b>ENTRY</b>    <code>$${entry}</code>
🛑 <b>STOP LOSS</b> <code>$${sl}</code>
🎯 <b>TP1</b>      <code>$${tp1}</code>  <i>(1:1.5R — partial close)</i>
🎯 <b>TP2</b>      <code>$${tp2}</code>  <i>(1:${rr}R — full target)</i>
🎯 <b>TP3</b>      <code>$${tp3}</code>  <i>(extension)</i>

📋 <b>Setup</b>
• Sweep: ${sweep}
• MSS: ${mss}
• FVG: ${sig.hasFVG !== undefined ? (sig.hasFVG ? 'Yes ✅' : 'No') : (setup.fvg ? 'Yes ✅' : '—')}`
  );
}

function waitMessage(instr, step, detail) {
  const steps = { sweep: '1/3', mss: '2/3', fvg: '3/3' };
  return `⏳ <b>${instr}</b> — Step ${steps[step] || step}\n${detail}`;
}

function statusMessage(xau) {
  if (!xau) return;
  const bias = xau.bias?.toUpperCase().replace(/_/g,' ') || '—';
  const price = xau.price ? '$' + parseFloat(xau.price).toFixed(2) : '—';
  return (
`📡 <b>XAUUSD Scan</b>  ${new Date().toUTCString().slice(17,22)} UTC
Price: <code>${price}</code>  Bias: <b>${bias}</b>
Confluence: ${xau.confluence?.score || 0}% (Grade ${xau.confluence?.grade || '—'})
Status: ${xau.waitReason || 'Monitoring...'}`
  );
}

module.exports = { send, signalMessage, waitMessage, statusMessage };
