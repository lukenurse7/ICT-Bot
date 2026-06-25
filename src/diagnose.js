'use strict';

// Diagnostic — shows raw data during KZ to find why no sweeps are detected

require('dotenv').config();
const { fetchCandles } = require('./data');
const { latestPivots } = require('./swings');

const SYMBOL = process.argv[2] === 'NAS100' ? 'QQQ' : 'DIA';
const NAME   = process.argv[2] === 'NAS100' ? 'NAS100' : 'DJ30';
const WINDOW = 150;

function toNY(t) {
  const str = new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York' });
  const ny  = new Date(str);
  return { h: ny.getHours(), m: ny.getMinutes(), day: ny.getDay(), date: ny };
}
function isWeekday(t) { return toNY(t).day >= 1 && toNY(t).day <= 5; }
function inKZ(t)      {
  if (!isWeekday(t)) return false;
  const { h, m } = toNY(t);
  const mins = h * 60 + m;
  return mins >= 8 * 60 + 30 && mins < 11 * 60;
}
function sk(t) {
  const { date } = toNY(t);
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}

async function run() {
  const candles = await fetchCandles(SYMBOL, '5min', 500);
  console.log(`\n  ${NAME} — ${candles.length} candles, ${candles[0].time} → ${candles[candles.length-1].time}\n`);

  let lastDay = null;

  for (let i = WINDOW; i < candles.length; i++) {
    const c   = candles[i];
    const day = sk(c.time);

    if (!isWeekday(c.time)) continue;

    // Print pivot levels at KZ open each day
    if (day !== lastDay && inKZ(c.time)) {
      lastDay = day;
      const win     = candles.slice(i - WINDOW + 1, i + 1);
      const pivots  = latestPivots(win, 3);
      const pH      = pivots.lastHigh?.price;
      const pL      = pivots.lastLow?.price;
      console.log(`\n── ${day} ──`);
      console.log(`  Pivot High: ${pH?.toFixed(2) ?? 'NONE'}`);
      console.log(`  Pivot Low:  ${pL?.toFixed(2) ?? 'NONE'}`);
      console.log(`  ${'Time'.padEnd(20)} ${'Open'.padStart(8)} ${'High'.padStart(8)} ${'Low'.padStart(8)} ${'Close'.padStart(8)}  Sweep?`);
    }

    if (!inKZ(c.time)) continue;

    const win    = candles.slice(i - WINDOW + 1, i + 1);
    const pivots = latestPivots(win, 3);
    const pH     = pivots.lastHigh?.price;
    const pL     = pivots.lastLow?.price;

    const bearSweep = pH && c.high > pH && c.close < pH;
    const bullSweep = pL && c.low  < pL && c.close > pL;
    const closeToH  = pH && Math.abs(c.high - pH) / pH < 0.002;
    const closeToL  = pL && Math.abs(c.low  - pL) / pL < 0.002;

    const note = bearSweep ? '🔴 BEAR SWEEP'
               : bullSweep ? '🟢 BULL SWEEP'
               : closeToH  ? `  near H (${((c.high - pH) / pH * 100).toFixed(3)}%)`
               : closeToL  ? `  near L (${((pL - c.low)  / pL * 100).toFixed(3)}%)`
               : '';

    console.log(`  ${c.time.padEnd(20)} ${c.open.toFixed(2).padStart(8)} ${c.high.toFixed(2).padStart(8)} ${c.low.toFixed(2).padStart(8)} ${c.close.toFixed(2).padStart(8)}  ${note}`);
  }
}

run().catch(e => console.error('Error:', e.message));
