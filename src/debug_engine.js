'use strict';

require('dotenv').config();
const { fetchCandles } = require('./data');
const { Engine5m }     = require('./engine5m');

const SYMBOL    = 'DIA';
const NAME      = 'DJ30';
const WINDOW_5M = 150;

function toNY(t) {
  const str = new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York' });
  const ny  = new Date(str);
  return { h: ny.getHours(), m: ny.getMinutes(), day: ny.getDay(), date: ny };
}
function isWeekday(t) { return toNY(t).day >= 1 && toNY(t).day <= 5; }
function inKZ(t) {
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
  const engine  = new Engine5m(NAME);
  let lastDay   = null;

  console.log(`\nTotal candles: ${candles.length}`);
  console.log(`Range: ${candles[0].time} → ${candles[candles.length-1].time}\n`);

  // Count how many candles fall in KZ
  const kzCandles = candles.filter(c => inKZ(c.time));
  console.log(`KZ candles found: ${kzCandles.length}`);
  if (kzCandles.length) {
    console.log(`First KZ candle: ${kzCandles[0].time}  NY: ${JSON.stringify(toNY(kzCandles[0].time))}`);
    console.log(`Last  KZ candle: ${kzCandles[kzCandles.length-1].time}`);
  }
  console.log('');

  for (let i = WINDOW_5M; i < candles.length; i++) {
    const c   = candles[i];
    const kz  = inKZ(c.time);
    const day = sk(c.time);

    if (!isWeekday(c.time)) continue;

    if (day !== lastDay) {
      lastDay = day;
      console.log(`\n── ${day} ──`);
    }

    const win    = candles.slice(i - WINDOW_5M + 1, i + 1);
    const result = engine.tick(day, win, kz);

    // Print every tick regardless of KZ
    const nyT  = toNY(c.time);
    const nyHM = `${String(nyT.h).padStart(2,'0')}:${String(nyT.m).padStart(2,'0')} NY`;
    const kzMark = kz ? '[KZ]' : '    ';
    console.log(`  ${kzMark} ${c.time.slice(11,16)} UTC (${nyHM})  state:${result.state.padEnd(18)}  pH:${result.debug.pivotHigh?.toFixed(2)??'--'}  pL:${result.debug.pivotLow?.toFixed(2)??'--'}  ${result.waitReason.slice(0,60)}`);
  }
}

run().catch(e => console.error('Error:', e.message));
