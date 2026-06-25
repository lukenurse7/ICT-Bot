'use strict';

// ─── 5m Permission Engine Backtest ───────────────────────────────────────────
// Replays all candles in time order through the Engine5m state machine.
// The engine receives a rolling window of the last 150 candles at each tick
// (so it always has prior-day context to build confirmed pivots from).
// Engine state resets at the start of each new NY KZ session.

require('dotenv').config();
const { fetchCandles } = require('./data');
const { Engine5m }     = require('./engine5m');

const SYMBOL = process.argv[2] === 'NAS100' ? 'QQQ' : 'DIA';
const NAME   = process.argv[2] === 'NAS100' ? 'NAS100' : 'DJ30';
const WINDOW = 150;  // rolling candle window passed to engine each tick

// NY Kill Zone in UTC — 13:30-16:30 covers both EST and EDT
const KZ_START = 13 * 60 + 30;
const KZ_END   = 16 * 60 + 30;

function toUTCMins(timeStr) {
  const d = new Date(timeStr);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function isWeekday(timeStr) {
  const day = new Date(timeStr).getUTCDay();
  return day >= 1 && day <= 5;
}

function isInKZ(timeStr) {
  if (!isWeekday(timeStr)) return false;
  const m = toUTCMins(timeStr);
  return m >= KZ_START && m < KZ_END;
}

// NY date key — UTC date is fine for our KZ window (13:30-16:30 UTC)
function sessionKey(timeStr) {
  return timeStr.slice(0, 10);
}

async function runBacktest() {
  console.log(`\n  ICT 5m Permission Engine — Backtest`);
  console.log(`  Instrument: ${NAME} (${SYMBOL})`);
  console.log(`  Fetching 5 days of 5m data...\n`);

  const candles = await fetchCandles(SYMBOL, '5min', 500);

  console.log(`  Got ${candles.length} candles`);
  console.log(`  From: ${candles[0].time}`);
  console.log(`  To:   ${candles[candles.length - 1].time}\n`);
  console.log('  ' + '─'.repeat(70));

  const engine       = new Engine5m(NAME);
  let totalSignals   = 0;
  let currentDay     = null;
  let signalFiredToday = false;

  // Walk through every candle in time order
  for (let i = WINDOW; i < candles.length; i++) {
    const latest = candles[i];
    const sk     = sessionKey(latest.time);
    const inKZ   = isInKZ(latest.time);

    // New day — print header, reset signal flag
    if (sk !== currentDay) {
      if (currentDay && !signalFiredToday) {
        console.log('    No signal fired during KZ');
      }
      currentDay = sk;
      signalFiredToday = false;
      if (isWeekday(latest.time)) {
        console.log(`\n  📅 ${sk}`);
      }
    }

    if (!isWeekday(latest.time)) continue;

    // Pass rolling window of last WINDOW candles
    const window = candles.slice(i - WINDOW + 1, i + 1);
    const result = engine.tick(sk, window, inKZ);

    // Print state transitions
    if (inKZ) {
      const d = result.debug;
      const stateStr = `    [${latest.time.slice(11,16)}] ${result.state.padEnd(18)} pivH:${d.pivotHigh?.toFixed(2) ?? '—'} pivL:${d.pivotLow?.toFixed(2) ?? '—'}  ${result.waitReason}`;
      console.log(stateStr);
    }

    if (result.permissionGranted && !signalFiredToday) {
      signalFiredToday = true;
      totalSignals++;

      const perm        = result.permission;
      const sweepCandle = perm.sweep.sweepCandle;
      const mssCandle   = perm.mss.mssCandle;
      const fvg         = perm.fvg;

      console.log(`\n  ★ ${perm.direction} PERMISSION — ${latest.time}`);
      console.log(`    Sweep:  ${perm.sweep.levelName}`);
      console.log(`            wick to ${perm.sweep.dir === 'bear' ? sweepCandle.high.toFixed(2) : sweepCandle.low.toFixed(2)}, close ${sweepCandle.close.toFixed(2)}`);
      console.log(`    MSS:    ${perm.mss.type} @ ${perm.mss.level.toFixed(2)}, close ${mssCandle.close.toFixed(2)}`);
      console.log(`    FVG:    ${fvg.bottom.toFixed(2)} – ${fvg.top.toFixed(2)}  mid ${fvg.mid.toFixed(2)}  size ${fvg.size.toFixed(2)}`);

      // What did price do in the next 30 minutes (6 candles)?
      const next6     = candles.slice(i + 1, i + 7);
      if (next6.length) {
        const highAfter = Math.max(...next6.map(c => c.high));
        const lowAfter  = Math.min(...next6.map(c => c.low));
        const moveDir   = perm.direction === 'SHORT' ? fvg.mid - lowAfter : highAfter - fvg.mid;
        const worked    = moveDir > 0 ? '✅' : '❌';
        console.log(`    After:  30m high ${highAfter.toFixed(2)}  low ${lowAfter.toFixed(2)}  → move ${moveDir.toFixed(2)} pts ${worked}`);
      }
      console.log('');
    }
  }

  if (currentDay && !signalFiredToday) {
    console.log('    No signal fired during KZ');
  }

  console.log('\n  ' + '─'.repeat(70));
  console.log(`\n  Total signals: ${totalSignals}\n`);
}

runBacktest().catch(e => console.error('Backtest error:', e.message));
