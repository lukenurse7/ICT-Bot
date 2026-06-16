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

// ─── DJ30 signal message ──────────────────────────────────────────────────────
function signalMessage(sig) {
  const isLong = sig.direction === 'BUY' || sig.direction === 'long';
  const arrow  = isLong ? '🟢' : '🔴';
  const dir    = isLong ? '▲ BUY' : '▼ SELL';

  const entry = parseFloat(sig.entry).toFixed(2);
  const sl    = parseFloat(sig.sl).toFixed(2);
  const tp1   = parseFloat(sig.tp1).toFixed(2);
  const tp2   = parseFloat(sig.tp2).toFixed(2);
  const tp3   = parseFloat(sig.tp3).toFixed(2);
  const pts   = sig.stopPoints || Math.round(Math.abs(sig.entry - sig.sl));

  const sweep = sig.sweep   || '—';
  const mss   = sig.mssType || '—';
  const score = sig.confluence || '—';
  const grade = sig.grade      || '—';
  const bias  = (sig.htfBias || '—').toUpperCase().replace(/_/g, ' ');

  const time = new Date().toUTCString().slice(0, 25);

  return [
    `${arrow} <b>DJ30  ${dir}</b>`,
    ``,
    `📊 Score: <b>${score}%</b>  Grade: <b>${grade}</b>  Bias: <b>${bias}</b>`,
    `🕐 <code>${time} UTC</code>`,
    ``,
    `💰 <b>ENTRY</b>     <code>$${entry}</code>`,
    `🛑 <b>STOP LOSS</b>  <code>$${sl}</code>  <i>(${pts} pts)</i>`,
    ``,
    `🎯 <b>TP1</b>  <code>$${tp1}</code>  <i>— close 50% here, move SL to BE</i>`,
    `🎯 <b>TP2</b>  <code>$${tp2}</code>  <i>(${sig.tp2Desc || '—'})</i>`,
    `🎯 <b>TP3</b>  <code>$${tp3}</code>  <i>(${sig.tp3Desc || 'extension'})</i>`,
    ``,
    `📋 Sweep: <b>${sweep}</b>  →  MSS: <b>${mss}</b>  →  FVG: ✅`,
    ``,
    `⚠️ <i>Kill zone signal — NY open 13:30–16:00 GMT only</i>`,
  ].join('\n');
}

module.exports = { send, signalMessage };
