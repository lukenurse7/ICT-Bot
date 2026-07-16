'use strict';

// ─── TradingView Webhook Receiver ─────────────────────────────────────────────
// TradingView fires a POST to /webhook when an ICT alert triggers.
// We receive it, format it, and forward to Telegram.

require('dotenv').config();
const express = require('express');
const tg      = require('./telegram');

const PORT   = process.env.PORT || 3000;
const SECRET = process.env.WEBHOOK_SECRET || '';   // optional — set in Railway env vars

const app = express();
app.use(express.json());
app.use(express.text()); // TradingView sometimes sends plain text

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ICT Webhook Server running' }));

// ─── TradingView webhook endpoint ─────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  try {
    // Optional secret check
    const incomingSecret = req.query.secret || req.headers['x-webhook-secret'];
    if (SECRET && incomingSecret !== SECRET) {
      console.log('  [webhook] Rejected — wrong secret');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Parse body — TradingView can send JSON or plain text
    let payload = req.body;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { payload = { raw: payload }; }
    }

    console.log('\n  [webhook] Received:', JSON.stringify(payload));

    const {
      direction,   // "LONG" or "SHORT"
      symbol,      // e.g. "NAS100", "DJ30"
      entry,
      sl,
      tp,
      rr,
      risk,
      sweep,
      mss,
      fvg,
      time,
      raw,
    } = payload;

    // If we got a structured signal, send a formatted Telegram alert
    if (direction && entry && sl && tp) {
      const dir   = direction === 'SHORT' ? '▼ SHORT' : '▲ LONG';
      const emoji = direction === 'SHORT' ? '🔴' : '🟢';
      const inst  = symbol || 'NAS100';
      const ts    = time ? `\n🕐 <b>Time:</b> ${time}` : '';

      const msg = [
        `${emoji} <b>ICT SIGNAL — ${dir} ${inst}</b>`,
        ``,
        `📍 <b>Entry:</b>  ${entry}`,
        `🛑 <b>SL:</b>     ${sl}`,
        `🎯 <b>TP:</b>     ${tp}`,
        rr   ? `📊 <b>RR:</b>     ${rr}` : '',
        risk ? `⚡ <b>Risk:</b>   ${risk} pts` : '',
        ``,
        sweep ? `• Sweep:  ${sweep}` : '',
        mss   ? `• MSS:    ${mss}`   : '',
        fvg   ? `• FVG:    ${fvg}`   : '',
        ts,
        ``,
        `<i>Source: TradingView alert</i>`,
      ].filter(l => l !== '').join('\n');

      await tg.sendRaw(msg);
      console.log(`  [webhook] ✅ Telegram alert sent — ${dir} ${inst} @ ${entry}`);
      return res.json({ ok: true, forwarded: true });
    }

    // Unknown payload — forward raw so you still see it in Telegram
    if (raw || Object.keys(payload).length) {
      const rawMsg = `⚠️ <b>ICT Webhook — unstructured alert</b>\n\n<code>${JSON.stringify(payload, null, 2)}</code>`;
      await tg.sendRaw(rawMsg);
      return res.json({ ok: true, forwarded: 'raw' });
    }

    res.json({ ok: true, note: 'empty payload, nothing sent' });
  } catch (err) {
    console.error('  [webhook] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  ✅ ICT Webhook Server listening on port ${PORT}`);
  console.log(`  POST signals to: https://<your-railway-url>/webhook\n`);
  tg.sendRaw('🤖 <b>ICT Webhook Server started</b>\nReady to receive TradingView alerts.');
});
