'use strict';

const { Engine5m } = require('./engine5m');
const { Engine1m } = require('./engine1m');

function c(time, open, high, low, close) {
  return { time, open, high, low, close };
}

// ─── Test 1: 5m engine reaches PERMISSION_GRANTED ────────────────────────────
function test5mEngine() {
  console.log('\n── Test 1: 5m engine permission flow ──');
  const engine = new Engine5m('TEST');

  const base = [];
  let ts = 1700000000;
  const step = 5 * 60;

  for (let i = 0; i < 50; i++) { base.push(c(new Date(ts*1000).toISOString(),99,99.3,98.7,99)); ts+=step; }
  for (let i = 0; i < 3; i++)  { base.push(c(new Date(ts*1000).toISOString(),99,99.2,98.8,99)); ts+=step; }
  base.push(c(new Date(ts*1000).toISOString(),99.5,100.5,99.3,99.8)); ts+=step; // swing HIGH=100.5
  for (let i = 0; i < 3; i++)  { base.push(c(new Date(ts*1000).toISOString(),99,99.2,98.8,99)); ts+=step; }
  for (let i = 0; i < 3; i++)  { base.push(c(new Date(ts*1000).toISOString(),99,99.2,98.8,99)); ts+=step; }
  base.push(c(new Date(ts*1000).toISOString(),98.5,98.8,97.3,97.5)); ts+=step; // swing LOW=97.3
  for (let i = 0; i < 3; i++)  { base.push(c(new Date(ts*1000).toISOString(),99,99.2,98.8,99)); ts+=step; }
  while (base.length < 140)    { base.push(c(new Date(ts*1000).toISOString(),99,99.2,98.8,99)); ts+=step; }

  for (let i = 50; i < base.length; i++) {
    engine.tick('2024-01-01', base.slice(i-50, i+1), false);
  }

  let r = engine.tick('2024-01-02', base.slice(-51), true);
  console.log(`KZ open: state=${r.state}  permissionGranted=${r.permissionGranted}`);
  if (r.permissionGranted) {
    console.log(`  targetHigh=${r.permission.targetHigh}  targetLow=${r.permission.targetLow}`);
    console.log('  ✅ PASS');
    return r.permission;
  } else {
    console.log('  ❌ FAIL\n  waitReason:', r.waitReason);
    return null;
  }
}

// ─── Test 2: 1m engine — mirrors the Python reference self-test ──────────────
// 5m: swing HIGH=110, swing LOW=90
// 1m: sweep of 110, bearish MSS breaks prior swing low, FVG in impulse leg,
//     retrace into FVG triggers ENTRY
function test1mEngine(permission5m) {
  console.log('\n── Test 2: 1m engine entry flow ──');
  if (!permission5m) { console.log('  SKIP'); return; }

  // Override permission with controlled levels matching the Python test
  const perm = { ...permission5m, targetHigh: 110, targetLow: 90 };
  const engine = new Engine1m('TEST');
  engine.activate(perm);

  // candles matching Python reference:
  // prior structure: a confirmed 1m swing LOW at 102 (bar index 2)
  // sweep of 110: bar 4 (high=112, close=108 — wick above 110)
  // FVG: bar5.low=104 > bar7.high=103 → gap 103–104
  // MSS: bar 8 closes at 96 < swing low 102
  // retrace: bar 9 high=104 enters FVG 103–104

  const candles = [
    c('t0', 104, 106, 103, 105),
    c('t1', 105, 107, 104, 106),
    c('t2', 106, 105, 102, 103),  // confirmed swing LOW = 102
    c('t3', 103, 108, 103, 107),
    c('t4', 107, 112, 106, 108),  // SWEEP of 110 (wick 112)
    c('t5', 108, 109, 104, 105),  // FVG candle a: low=104
    c('t6', 105, 105, 100, 101),  // displacement down
    c('t7', 101, 103,  99, 100),  // FVG candle c: high=103 < a.low=104 → FVG 103–104
    c('t8', 100, 101,  95,  96),  // MSS: close=96 < swing low 102
    c('t9',  96, 106,  96, 103),  // retrace into FVG (high=106 enters 105–106)
  ];

  let r;
  for (let j = 1; j <= candles.length; j++) {
    r = engine.tick(candles.slice(0, j));
    console.log(`  bar${j-1}: state=${r.state.padEnd(12)} ${r.waitReason.slice(0,60)}`);
    if (r.entryReady) break;
  }

  if (r.entryReady && r.signal) {
    const s = r.signal;
    console.log(`\n  Direction: ${s.direction}`);
    console.log(`  Entry: ${s.entry}  SL: ${s.sl}  TP1: ${s.tp1}  Risk: ${s.riskPts}pts`);
    if (s.direction === 'SHORT' && s.sl > s.entry) {
      console.log('  SL above entry ✓');
      console.log('  ✅ PASS');
    } else {
      console.log('  ❌ FAIL — SL on wrong side');
    }
  } else {
    console.log('  ❌ FAIL — no entry signal');
    console.log('  last state:', r?.waitReason);
  }
}

const perm = test5mEngine();
test1mEngine(perm);
