'use strict';

const axios = require('axios');
require('dotenv').config();

const TOKEN   = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function send(text) {
  if (!TOKEN || !CHAT_ID) {
    console.log('[Telegram] Skipped — TOKEN or CHAT_ID not set in .env');
    return;
  }
  try {
    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      chat_id:    CHAT_ID,
      text,
      parse_mode: 'HTML',
    }, { timeout: 8000 });
  } catch (e) {
    console.log('[Telegram] Send failed:', e.message);
  }
}

// Permission alert — fired when 5m engine reaches PERMISSION_GRANTED
// This is Stage 1 only: we tell the trader to switch to 1m and look for entry
function permissionMessage(perm) {
  const arrow = perm.direction === 'SHORT' ? '🔴' : '🟢';
  const time  = new Date().toUTCString().slice(0, 25);

  return (
`${arrow} <b>${perm.direction} PERMISSION — ${perm.instrument}</b>
🕐 ${time} UTC

<b>5m Setup Complete</b>
• Sweep: ${perm.sweep.levelName}
• MSS:   ${perm.mss.type} @ ${perm.mss.level.toFixed(2)}
• FVG:   ${perm.fvg.bottom.toFixed(2)} – ${perm.fvg.top.toFixed(2)} (mid ${perm.fvg.mid.toFixed(2)})

<b>Action:</b> Switch to 1m chart — look for 1m sweep → 1m MSS → 1m FVG entry.
Direction: <b>${perm.direction}</b> only.`
  );
}

module.exports = { send, permissionMessage };
