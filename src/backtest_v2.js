'use strict';

// ─── Dual-Timeframe Backtest (5m Permission + 1m Entry) ──────────────────────
// Fetches 5m + 1m historical data, replays both engines in time order,
// and prints every entry signal with post-signal outcome.

require('dotenv').config();
const { fetchCandles } = require('./data');
const { Engine5m }     = require('./engine5m');
const { Engine1m }     = require('./engine1m');

const SYMBOL = process.argv[2] === 'NAS100' ? 'QQQ' : 'DIA';
const NAME   = process.argv[2] === 'NAS100' ? 'NAS100' : 'DJ30';
const WINDOW_5M = 150;  // rolling context window for 5m engine

// KZ window in UTC minutes
const KZ_START = 13 * 60 + 30;
const KZ_END   = 16 * 60 + 30;

function utcMins(timeStr) {
  const d = new Date(timeStr);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function isWeekday(timeStr) {
  const d = new Date(timeStr).getUTCDay();
  return d >= 1 && d <= 5;
}

function inKZ(timeStr) {
  if (!isWeekday(timeStr)) return false;
  const m = utcMins(timeStr);
  return m >= KZ_START && m < KZ_END;
}

function sessionKey(timeStr) {
  return timeStr.slice(0, 10);
}

// Find 1m candles within a time range (from startTime onwards, up to N minutes)
function get1mWindow(candles1m, startTime, minutes = 60) {
  const start = new Date(startTime).getTime();
  const end   = start + minutes * 60 * 1000;
  return candles1m.filter(c => {
    const t = new Date(c.time).getTime();
    return t >= start && t <= end;
  });
}

// Check outcome: did price reach TP1 or SL first in the next N candles?
function checkOutcome(candles1m, signal, afterTime, lookforwardMins = 120) {
  const window = get1mWindow(candles1m, afterTime, lookforwardMins);
  if (!window.length) return { result: 'NO_DATA' };

  const isShort = signal.direction === 'SHORT';
  for (const c of window) {
    if (isShort) {
      if (c.low  <= signal.tp1) return { result: 'TP1', bars: window.indexOf(c) + 1 };
      if (c.high >= signal.sl)  return { result: 'SL',  bars: window.indexOf(c) + 1 };
    } else {
      if (c.high >= signal.tp1) return { result: 'TP1', bars: window.indexOf(c) + 1 };
      if (c.low  <= signal.sl)  return { result: 'SL',  bars: window.indexOf(c) + 1 };
    }
  }
  return { result: 'OPEN', bars: window.length };
}

async function runBacktest() {
  console.log(`\n  ══ ICT Dual-Timeframe Backtest ══`);
  console.log(`  Instrument: ${NAME} (${SYMBOL})`);
  console.log(`  Fetching data...\n`);

  const [candles5m, candles1m] = await Promise.all([
    fetchCandles(SYMBOL, '5min', 500),
    fetchCandles(SYMBOL, '1min', 500),
  ]);

  console.log(`  5m: ${candles5m.length} candles  ${candles5m[0].time} → ${candles5m[candles5m.length-1].time}`);
  console.log(`  1m: ${candles1m.length} candles  ${candles1m[0].time} → ${candles1m[candles1m.length-1].time}`);
  console.log(`\n  ${'─'.repeat(65)}`);

  const engine5m = new Engine5m(NAME);
  const engine1m = new Engine1m(NAME);

  let currentDay           = null;
  let signalFiredToday     = false;
  let totalSignals         = 0;
  let tp1Hits = 0, slHits = 0;

  for (let i = WINDOW_5M; i < candles5m.length; i++) {
    const bar5m = candles5m[i];
    const sk    = sessionKey(bar5m.time);
    const kz    = inKZ(bar5m.time);

    if (sk !== currentDay) {
      if (currentDay && !signalFiredToday) {
        console.log(`    No signal`);
      }
      currentDay       = sk;
      signalFiredToday = false;
      if (isWeekday(bar5m.time)) {
        process.stdout.write(`\n  📅 ${sk}  `);
      }
    }

    if (!isWeekday(bar5m.time)) continue;

    const window5m = candles5m.slice(i - WINDOW_5M + 1, i + 1);
    const r5       = engine5m.tick(sk, window5m, kz);

    // When 5m grants permission, run 1m engine on 1m candles from that moment
    if (r5.permissionGranted && r5.permission && !signalFiredToday) {
      engine1m.activate(r5.permission);

      // Get 1m candles from permission time onwards (up to 30 mins)
      const kzCandles1m = get1mWindow(candles1m, bar5m.time, 30);

      let entrySignal = null;
      for (let j = 5; j <= kzCandles1m.length; j++) {
        const slice1m = kzCandles1m.slice(0, j);
        const r1      = engine1m.tick(slice1m);
        if (r1.entryReady && r1.signal) {
          entrySignal = r1.signal;
          engine1m._reset();
          break;
        }
      }

      if (entrySignal) {
        signalFiredToday = true;
        totalSignals++;

        const outcome = checkOutcome(candles1m, entrySignal, bar5m.time, 120);
        const outcomeStr = outcome.result === 'TP1'
          ? `✅ TP1 hit (${outcome.bars}m)`
          : outcome.result === 'SL'
          ? `❌ SL hit (${outcome.bars}m)`
          : `⏳ ${outcome.result}`;

        if (outcome.result === 'TP1') tp1Hits++;
        if (outcome.result === 'SL')  slHits++;

        console.log(`${entrySignal.direction}`);
        console.log(`    5m: ${r5.permission.sweep.levelName} → ${r5.permission.mss.type}`);
        console.log(`    1m: ${entrySignal.sweep1m} → ${entrySignal.mss1m}`);
        console.log(`    Entry ${entrySignal.entry}  SL ${entrySignal.sl}  TP1 ${entrySignal.tp1}  Risk ${entrySignal.riskPts}pts`);
        console.log(`    Outcome: ${outcomeStr}`);
      } else {
        process.stdout.write(`(5m ok, no 1m entry)  `);
      }
    }
  }

  if (currentDay && !signalFiredToday) console.log(`    No signal`);

  const tradingDays = [...new Set(
    candles5m.filter(c => isWeekday(c.time)).map(c => sessionKey(c.time))
  )].length;

  console.log(`\n  ${'─'.repeat(65)}`);
  console.log(`\n  Results`);
  console.log(`  Trading days:  ${tradingDays}`);
  console.log(`  Total signals: ${totalSignals}`);
  console.log(`  TP1 hits:      ${tp1Hits}  (${totalSignals ? Math.round(tp1Hits/totalSignals*100) : 0}%)`);
  console.log(`  SL hits:       ${slHits}  (${totalSignals ? Math.round(slHits/totalSignals*100) : 0}%)`);
  console.log('');
}

runBacktest().catch(e => console.error('Error:', e.message));
