'use strict';

// ─── 5m Permission Engine Backtest ───────────────────────────────────────────
// Replays historical 5m candles day by day through the Engine5m state machine
// and prints every signal that would have fired, with context to verify quality.

require('dotenv').config();
const { fetchCandles }  = require('./data');
const { Engine5m }      = require('./engine5m');
const { INSTRUMENTS }   = require('./config');

const SYMBOL = process.argv[2] === 'NAS100' ? 'QQQ' : 'DIA';
const NAME   = process.argv[2] === 'NAS100' ? 'NAS100' : 'DJ30';

// NY Kill Zone hours in UTC — approximate (handles EST/EDT)
// 08:30 NY = 13:30 UTC (EDT, Mar-Nov) or 14:30 UTC (EST, Nov-Mar)
// We use 13:30-16:30 UTC to cover both
const KZ_START_UTC = 13.5;  // 13:30
const KZ_END_UTC   = 16.5;  // 16:30

function utcHour(timeStr) {
  return new Date(timeStr).getUTCHours() + new Date(timeStr).getUTCMinutes() / 60;
}

function dateStr(timeStr) {
  return timeStr.slice(0, 10);
}

function isInKZ(timeStr) {
  const day = new Date(timeStr).getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = utcHour(timeStr);
  return h >= KZ_START_UTC && h < KZ_END_UTC;
}

async function runBacktest() {
  console.log(`\n  ICT 5m Permission Engine — Backtest`);
  console.log(`  Instrument: ${NAME} (${SYMBOL})`);
  console.log(`  Fetching 5 days of 5m data...\n`);

  // Fetch 5 days worth of 5m candles (5 days * 8h KZ window * 12 candles/h = ~480 candles)
  const candles = await fetchCandles(SYMBOL, '5min', 500);

  console.log(`  Got ${candles.length} candles from ${candles[0].time} to ${candles[candles.length-1].time}\n`);
  console.log('  ' + '─'.repeat(70));

  // Group candles by date
  const byDate = {};
  for (const c of candles) {
    const d = dateStr(c.time);
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(c);
  }

  const dates = Object.keys(byDate).sort();
  let totalSignals = 0;

  for (const date of dates) {
    const engine = new Engine5m(NAME);
    const dayCandlesFull = byDate[date];

    // Skip weekends
    const day = new Date(date).getUTCDay();
    if (day === 0 || day === 6) continue;

    console.log(`\n  📅 ${date}`);

    let signalFired = false;

    // Replay candles one by one, simulating live scanning
    for (let i = 10; i <= dayCandlesFull.length; i++) {
      const slice  = dayCandlesFull.slice(0, i);
      const latest = slice[slice.length - 1];
      const inKZ   = isInKZ(latest.time);

      const result = engine.tick(date, slice, inKZ);

      if (result.permissionGranted && !signalFired) {
        signalFired = true;
        totalSignals++;

        const perm = result.permission;
        const sweepCandle = perm.sweep.sweepCandle;
        const mssCandle   = perm.mss.mssCandle;
        const fvg         = perm.fvg;

        console.log(`\n  ★ PERMISSION GRANTED — ${perm.direction}`);
        console.log(`    Time:      ${latest.time}`);
        console.log(`    Direction: ${perm.direction}`);
        console.log(`\n    1. SWEEP   ${perm.sweep.levelName}`);
        console.log(`               Candle: ${sweepCandle.time}`);
        console.log(`               High: ${sweepCandle.high.toFixed(2)}  Low: ${sweepCandle.low.toFixed(2)}  Close: ${sweepCandle.close.toFixed(2)}`);
        console.log(`\n    2. MSS     ${perm.mss.type} @ ${perm.mss.level.toFixed(2)}`);
        console.log(`               Candle: ${mssCandle.time}`);
        console.log(`               High: ${mssCandle.high.toFixed(2)}  Low: ${mssCandle.low.toFixed(2)}  Close: ${mssCandle.close.toFixed(2)}`);
        console.log(`\n    3. FVG     ${fvg.bottom.toFixed(2)} – ${fvg.top.toFixed(2)}  (mid ${fvg.mid.toFixed(2)})  size: ${fvg.size.toFixed(2)}`);
        console.log(`               Direction: ${fvg.dir}  Time: ${fvg.time}`);

        // Show what price did after the signal (next 6 candles = 30 mins)
        const afterIdx = dayCandlesFull.indexOf(latest);
        const next6    = dayCandlesFull.slice(afterIdx + 1, afterIdx + 7);
        if (next6.length) {
          const highAfter = Math.max(...next6.map(c => c.high));
          const lowAfter  = Math.min(...next6.map(c => c.low));
          console.log(`\n    Post-signal (30m): High ${highAfter.toFixed(2)}  Low ${lowAfter.toFixed(2)}`);
          if (perm.direction === 'SHORT') {
            const move = fvg.mid - lowAfter;
            console.log(`    Max move in signal direction: ${move.toFixed(2)} pts ${move > 0 ? '✅' : '❌'}`);
          } else {
            const move = highAfter - fvg.mid;
            console.log(`    Max move in signal direction: ${move.toFixed(2)} pts ${move > 0 ? '✅' : '❌'}`);
          }
        }
        console.log('');
      }
    }

    if (!signalFired) {
      console.log('    No signal fired today');
    }
  }

  console.log('\n  ' + '─'.repeat(70));
  console.log(`\n  Total signals over period: ${totalSignals}`);
  console.log(`  Across ${dates.filter(d => { const day = new Date(d).getUTCDay(); return day >= 1 && day <= 5; }).length} trading days\n`);
}

runBacktest().catch(e => console.error('Backtest error:', e.message));
