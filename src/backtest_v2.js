'use strict';

// ─── Dual-Timeframe Backtest (5m Permission + 1m Entry) ──────────────────────
// Usage:
//   node src/backtest_v2.js          → DJ30 (DIA)
//   node src/backtest_v2.js NAS100   → NAS100 (QQQ)
//   node src/backtest_v2.js --debug  → full candle-by-candle trace

require('dotenv').config();
const { fetchCandles } = require('./data');
const { Engine5m }     = require('./engine5m');
const { Engine1m }     = require('./engine1m');

const args    = process.argv.slice(2);
const DEBUG   = args.includes('--debug');
const inst    = args.find(a => !a.startsWith('--')) || 'NAS100';
const SYMBOL  = inst === 'DJ30' ? 'DIA' : 'QQQ';    // ETF proxies — confirmed working on TwelveData
const NAME    = inst === 'DJ30'  ? 'DJ30' : 'NAS100';

const WINDOW_5M    = 150;   // rolling context window fed to 5m engine each tick
const FETCH_SIZE   = 5000;  // request maximum data; API caps it at plan limit

// ─── Time helpers (New York timezone) ────────────────────────────────────────
function toNY(timeStr) {
  const str = new Date(timeStr).toLocaleString('en-US', { timeZone: 'America/New_York' });
  const ny  = new Date(str);
  return { h: ny.getHours(), m: ny.getMinutes(), day: ny.getDay(), date: ny };
}
function isWeekday(t) { const { day } = toNY(t); return day >= 1 && day <= 5; }
function inKZ(t) {
  if (!isWeekday(t)) return false;
  const { h, m } = toNY(t);
  const mins = h * 60 + m;
  return mins >= 8 * 60 + 30 && mins < 11 * 60;
}
function sessionKey(t) {
  const { date } = toNY(t);
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function nyHHMM(t) {
  const { h, m } = toNY(t);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

// ─── 1m candle slice helpers ─────────────────────────────────────────────────
function get1mSlice(candles1m, startTime, minutes) {
  const start = new Date(startTime).getTime();
  const end   = start + minutes * 60 * 1000;
  return candles1m.filter(c => {
    const t = new Date(c.time).getTime();
    return t >= start && t <= end;
  });
}

// ─── Outcome check: did TP1 or SL get hit first after entry? ─────────────────
// Time-stop: if neither hit within lookMins, close at market (TIME_STOP result)
function checkOutcome(candles1m, signal, fromTime, lookMins = 420) {
  const window = get1mSlice(candles1m, fromTime, lookMins);
  if (!window.length) return { result: 'NO_DATA', bars: 0 };
  const isShort = signal.direction === 'SHORT';
  for (let i = 0; i < window.length; i++) {
    const c = window[i];
    if (isShort) {
      if (c.high >= signal.sl)  return { result: 'SL', bars: i + 1 };
      if (c.low  <= signal.tp1) return { result: 'TP', bars: i + 1 };
    } else {
      if (c.low  <= signal.sl)  return { result: 'SL', bars: i + 1 };
      if (c.high >= signal.tp1) return { result: 'TP', bars: i + 1 };
    }
  }
  // Time-stop: closed at end of window, record closing price vs entry
  const last = window[window.length - 1];
  const closePrice = last?.close ?? signal.entry;
  const pnl = isShort ? signal.entry - closePrice : closePrice - signal.entry;
  return { result: 'TIME_STOP', bars: window.length, closePrice, pnl: parseFloat(pnl.toFixed(2)) };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function runBacktest() {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  ICT Bot — Dual-Timeframe Backtest`);
  console.log(`  Instrument : ${NAME} (${SYMBOL})`);
  console.log(`  Strategy   : NY KZ 08:30–11:00 | 5m H/L → 1m Sweep → 1m MSS → 1m FVG → Entry`);
  console.log(`  Config     : TP_R=${process.env.TP_R||'2.0(default)'}  SL_BUFFER=${process.env.SL_BUFFER||'0.50(default)'}  MIN_RISK=${process.env.MIN_RISK_PTS||'0.30(default)'}  MAX_1M_BARS=${process.env.MAX_1M_BARS||'90(default)'}`);
  console.log(`${'═'.repeat(70)}\n`);
  console.log(`  Fetching data (this may take a moment)...`);

  let candles5m, candles1m;
  try {
    [candles5m, candles1m] = await Promise.all([
      fetchCandles(SYMBOL, '5min', FETCH_SIZE),
      fetchCandles(SYMBOL, '1min', FETCH_SIZE),
    ]);
  } catch (e) {
    console.error(`\n  ✗ Data fetch failed: ${e.message}`);
    console.error(`  Check your TWELVEDATA_API_KEY in Railway environment variables.\n`);
    process.exit(1);
  }

  console.log(`  5m candles : ${candles5m.length}  (${candles5m[0].time.slice(0,10)} → ${candles5m[candles5m.length-1].time.slice(0,10)})`);
  console.log(`  1m candles : ${candles1m.length}  (${candles1m[0].time.slice(0,10)} → ${candles1m[candles1m.length-1].time.slice(0,10)})`);

  const usable5m = candles5m.length - WINDOW_5M;
  if (usable5m < 50) {
    console.error(`\n  ✗ Not enough 5m data. Need at least ${WINDOW_5M + 50} candles, got ${candles5m.length}.`);
    console.error(`  On TwelveData free plan you only get ~500 candles ≈ 5 trading days.`);
    console.error(`  Upgrade your plan for longer backtests.\n`);
    process.exit(1);
  }

  console.log(`  Backtesting : ${usable5m} 5m bars (≈ ${Math.round(usable5m / 78)} trading days)\n`);
  console.log(`${'─'.repeat(70)}`);

  const engine5m = new Engine5m(NAME);
  const engine1m = new Engine1m(NAME);

  // Per-day tracking
  let currentDay       = null;
  let dayState         = null;    // accumulates what happened each day
  const signals        = [];
  let totalDays        = 0;

  function printDaySummary() {
    if (!dayState) return;
    const { date, gotPermission, gotSweep, gotMSS, gotFVG, gotEntry, signal, outcome } = dayState;

    // Progress icons: 5m levels → 1m sweep → 1m MSS → 1m FVG → Entry
    const steps = [
      gotPermission ? '✓ 5m Levels' : '✗ 5m Levels',
      gotSweep      ? '✓ 1m Sweep'  : '✗ 1m Sweep',
      gotMSS        ? '✓ 1m MSS'    : '✗ 1m MSS',
      gotFVG        ? '✓ 1m FVG'    : '✗ 1m FVG',
      gotEntry      ? '✓ Entry'      : '✗ Entry',
    ].join('  →  ');

    console.log(`  ${steps}`);
    if (gotEntry && signal) {
      const dir = signal.direction === 'SHORT' ? '▼ SHORT' : '▲ LONG';
      console.log(`  ${dir}  Entry:${signal.entry}  SL:${signal.sl}  TP:${signal.tp1}  Risk:${signal.riskPts}pts  RR:${signal.rr}`);
      if (signal.sweep1m) console.log(`  1m sweep: ${signal.sweep1m}  MSS: ${signal.mss1m}  FVG: ${signal.fvg1m}`);
      if (dayState.entry1mTime) console.log(`  1m entry at ${nyHHMM(dayState.entry1mTime)} NY`);
      if (outcome) {
        const o = outcome.result === 'TP'  ? `  ✅ TP HIT in ${outcome.bars} mins`
                : outcome.result === 'SL'  ? `  ❌ SL HIT in ${outcome.bars} mins`
                : `  ⏳ Still open after 4hrs`;
        console.log(o);
      }
    }
    console.log('');
  }

  for (let i = WINDOW_5M; i < candles5m.length; i++) {
    const bar  = candles5m[i];
    const sk   = sessionKey(bar.time);
    const kz   = inKZ(bar.time);
    const wday = isWeekday(bar.time);

    if (!wday) continue;

    // New day
    if (sk !== currentDay) {
      printDaySummary();
      currentDay = sk;
      totalDays++;
      dayState = { date: sk, gotPermission: false, gotSweep: false, gotMSS: false, gotFVG: false, gotEntry: false, signal: null, outcome: null };
      console.log(`  ── ${sk} ─────────────────────────────────────────────────`);
    }

    const win5m = candles5m.slice(i - WINDOW_5M + 1, i + 1);
    const r5    = engine5m.tick(sk, win5m, kz);

    // Track 5m permission
    if (r5.permissionGranted && !dayState.gotPermission) {
      dayState.gotPermission = true;
      if (DEBUG) console.log(`    [${nyHHMM(bar.time)}] 5m levels locked: H:${r5.permission.targetHigh?.toFixed(2)} L:${r5.permission.targetLow?.toFixed(2)}`);
    }

    // DEBUG: print every candle in KZ
    if (DEBUG && kz) {
      console.log(`    [${nyHHMM(bar.time)}] ${r5.state.padEnd(18)} pH:${r5.debug.pivotHigh?.toFixed(2)??'--'} pL:${r5.debug.pivotLow?.toFixed(2)??'--'}  ${r5.waitReason.slice(0,50)}`);
    }

    // 5m permission granted — now switch to 1m
    if (r5.permissionGranted && r5.permission && !dayState.gotEntry) {
      if (DEBUG) console.log(`\n    ★ 5m PERMISSION GRANTED at ${nyHHMM(bar.time)} NY — switching to 1m`);
      if (DEBUG) console.log(`      5m H: ${r5.permission.targetHigh?.toFixed(2)}  L: ${r5.permission.targetLow?.toFixed(2)}`);

      engine1m.activate(r5.permission);

      // Prior 30 mins of 1m candles for structure context + full KZ session forward
      const permMs   = new Date(bar.time).getTime();
      const prior1m  = get1mSlice(candles1m, new Date(permMs - 30 * 60 * 1000).toISOString(), 30);
      const fwd1m    = get1mSlice(candles1m, bar.time, 150);  // up to 11:00 NY KZ close

      if (DEBUG) console.log(`      1m context: ${prior1m.length} prior + ${fwd1m.length} forward candles`);

      let signalCount = 0;
      for (let j = 1; j <= fwd1m.length; j++) {
        if (signalCount >= 1) break;  // one signal per session
        const slice = [...prior1m, ...fwd1m.slice(0, j)];
        const r1    = engine1m.tick(slice);

        if (DEBUG && r1.state !== 'IDLE') {
          const cur = fwd1m[j - 1];
          console.log(`      1m [${nyHHMM(cur.time)}] ${r1.state.padEnd(10)} ${r1.waitReason.slice(0,50)}`);
        }

        // Track 1m milestones from engine state
        if (r1.state === 'SWEPT' || r1.state === 'MSS' || r1.state === 'ENTRY_WATCH' || r1.state === 'ENTRY')
          dayState.gotSweep = true;
        if (r1.state === 'MSS' || r1.state === 'ENTRY_WATCH' || r1.state === 'ENTRY')
          dayState.gotMSS = true;
        if (r1.state === 'ENTRY_WATCH' || r1.state === 'ENTRY')
          dayState.gotFVG = true;

        if (r1.entryReady && r1.signal) {
          const entrySignal = r1.signal;
          const entryTime   = fwd1m[j - 1]?.time;
          dayState.gotEntry    = true;
          dayState.signal      = entrySignal;
          dayState.entry1mTime = entryTime;
          signalCount++;

          // Check TP1/SL outcome — 7hr window covers full trading day from any KZ entry
          const outcome = checkOutcome(candles1m, entrySignal, entryTime || bar.time, 420);
          dayState.outcome = outcome;

          signals.push({ date: sk, ...entrySignal, outcome });

          // Re-activate for another setup in the same session
          engine1m.activate(r5.permission);
        }
      }

      if (signalCount === 0) {
        if (DEBUG) console.log(`      1m: no entry found in 150 mins after permission`);
      }
    }
  }

  // Print final day
  printDaySummary();

  // ─── Summary ─────────────────────────────────────────────────────────────
  const tp    = signals.filter(s => s.outcome?.result === 'TP').length;
  const sl    = signals.filter(s => s.outcome?.result === 'SL').length;
  const ts    = signals.filter(s => s.outcome?.result === 'TIME_STOP').length;
  const open  = signals.filter(s => s.outcome?.result === 'OPEN' || s.outcome?.result === 'NO_DATA').length;
  const total = signals.length;

  // Count how many days had each milestone
  // (We count from signals array + dayState tracking — approximate)
  console.log(`${'═'.repeat(70)}`);
  console.log(`  BACKTEST SUMMARY — ${NAME}`);
  console.log(`${'═'.repeat(70)}`);
  console.log(`  Trading days in dataset : ${totalDays}`);
  console.log(`  Days with full entry    : ${total}`);
  console.log('');
  if (total > 0) {
    console.log(`  TP hit     : ${tp}  (${Math.round(tp/total*100)}%)  ← min(opposing 5m level, 2R)`);
    console.log(`  SL hit     : ${sl}  (${Math.round(sl/total*100)}%)`);
    console.log(`  Time-stop  : ${ts}  (${Math.round(ts/total*100)}%)  ← closed end of day (7hr window)`);
    console.log(`  No data    : ${open}`);
    console.log('');
    console.log('  Per-signal detail:');
    for (const s of signals) {
      const dir = s.direction === 'SHORT' ? '▼' : '▲';
      const o   = s.outcome?.result === 'TP'        ? '✅ TP  '
                : s.outcome?.result === 'SL'        ? '❌ SL  '
                : s.outcome?.result === 'TIME_STOP' ? `🕐 TS  `
                : '⏳     ';
      console.log(`    ${s.date}  ${dir} ${s.direction.padEnd(5)}  Entry:${s.entry}  SL:${s.sl}  TP1:${s.tp1}  Risk:${s.riskPts}pts  ${o} (${s.outcome?.bars ?? '?'}m)`);
    }
  } else {
    console.log(`  No complete signals found.`);
    console.log(`  Tip: run with --debug flag to see why setups are not completing:`);
    console.log(`       node src/backtest_v2.js --debug`);
  }
  console.log(`\n${'═'.repeat(70)}\n`);
}

runBacktest().catch(e => {
  console.error('\n  Error:', e.message);
  process.exit(1);
});
