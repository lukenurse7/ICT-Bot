'use strict';

// ─── Unit test for Engine5m + Engine1m using synthetic candles ─────────────────
// Verifies the full state machine without needing live API data.

const { Engine5m } = require('./engine5m');
const { Engine1m } = require('./engine1m');

// Build a simple candle
function c(time, open, high, low, close) {
  return { time, open, high, low, close };
}

// Build a series of flat candles at a given price
function flat(startIdx, count, price, step = 60) {
  return Array.from({ length: count }, (_, i) => {
    const t = new Date(startIdx * 1000 + i * step * 1000).toISOString();
    return c(t, price, price + 0.05, price - 0.05, price);
  });
}

// ─── Test 1: 5m engine reaches PERMISSION_GRANTED ────────────────────────────
function test5mEngine() {
  console.log('\n── Test 1: 5m engine permission flow ──');
  const engine = new Engine5m('TEST');

  // Build 150 candles with a clear swing high at 100, swing low at 98
  // Candles 1..50: base around 99
  // Candles 51..56: swing high at 100 (middle candle high, others low)
  // Candles 57..100: come back down to 99
  // Then KZ opens with a sweep of the high (wick above 100, close below)

  const base = [];
  const t0 = 1700000000; // arbitrary epoch
  let ts = t0;
  const step = 5 * 60; // 5 min in seconds

  // 50 flat candles at 99
  for (let i = 0; i < 50; i++) {
    base.push(c(new Date(ts * 1000).toISOString(), 99, 99.3, 98.7, 99));
    ts += step;
  }
  // Swing high formation (3 lower, 1 peak, 3 lower)
  for (let i = 0; i < 3; i++) { base.push(c(new Date(ts * 1000).toISOString(), 99, 99.2, 98.8, 99)); ts += step; }
  base.push(c(new Date(ts * 1000).toISOString(), 99.5, 100.5, 99.3, 99.8)); ts += step; // swing HIGH = 100.5
  for (let i = 0; i < 3; i++) { base.push(c(new Date(ts * 1000).toISOString(), 99, 99.2, 98.8, 99)); ts += step; }
  // Swing low formation
  for (let i = 0; i < 3; i++) { base.push(c(new Date(ts * 1000).toISOString(), 99, 99.2, 98.8, 99)); ts += step; }
  base.push(c(new Date(ts * 1000).toISOString(), 98.5, 98.8, 97.3, 97.5)); ts += step; // swing LOW = 97.3
  for (let i = 0; i < 3; i++) { base.push(c(new Date(ts * 1000).toISOString(), 99, 99.2, 98.8, 99)); ts += step; }
  // Fill to 140 candles
  while (base.length < 140) { base.push(c(new Date(ts * 1000).toISOString(), 99, 99.2, 98.8, 99)); ts += step; }

  // Run engine through pre-KZ candles to build pivot context
  for (let i = 50; i < base.length; i++) {
    const win = base.slice(i - 50, i + 1);
    engine.tick('2024-01-01', win, false); // outside KZ
  }

  // Now simulate KZ with a bear sweep (wick above pivot high 100.5, close below)
  const sweepCandle = c(new Date(ts * 1000).toISOString(), 99.8, 101.0, 99.5, 99.3); ts += step;
  base.push(sweepCandle);
  let r = engine.tick('2024-01-02', base.slice(-51), true);
  console.log(`After sweep:     state=${r.state}  permissionGranted=${r.permissionGranted}`);
  if (r.permissionGranted) {
    console.log(`  Direction: ${r.permission.direction}`);
    console.log(`  Sweep: ${r.permission.sweep.levelName}  dir=${r.permission.direction}`);
    console.log('  ✅ PASS');
    return r.permission;
  } else {
    console.log('  ❌ FAIL — permission not granted');
    console.log('  waitReason:', r.waitReason);
    return null;
  }
}

// ─── Test 2: 1m engine finds entry after 5m permission ───────────────────────
function test1mEngine(permission5m) {
  console.log('\n── Test 2: 1m engine entry flow ──');
  if (!permission5m) { console.log('  SKIP (no 5m permission)'); return; }

  const engine = new Engine1m('TEST');
  engine.activate(permission5m);

  const candles = [];
  let ts = 1700100000;
  const step = 60; // 1 min

  // Prior context: 30 flat candles around 97
  for (let i = 0; i < 30; i++) {
    candles.push(c(new Date(ts * 1000).toISOString(), 97, 97.3, 96.7, 97)); ts += step;
  }

  // Brief rally (creates swing high for SHORT sweep)
  for (let i = 0; i < 3; i++) { candles.push(c(new Date(ts * 1000).toISOString(), 97.2, 97.4, 97.0, 97.2)); ts += step; }
  candles.push(c(new Date(ts * 1000).toISOString(), 97.5, 98.5, 97.3, 97.4)); ts += step; // swing high 98.5
  for (let i = 0; i < 3; i++) { candles.push(c(new Date(ts * 1000).toISOString(), 97.2, 97.4, 97.0, 97.2)); ts += step; }

  // 1m sweep: wick above 98.5, close back below
  candles.push(c(new Date(ts * 1000).toISOString(), 97.5, 99.2, 97.3, 97.1)); ts += step;
  let r = engine.tick([...candles]);
  console.log(`After 1m sweep:  state=${r.state}  ${r.waitReason.slice(0, 60)}`);

  // 1m MSS: bearish close below swing low
  for (let i = 0; i < 3; i++) { candles.push(c(new Date(ts * 1000).toISOString(), 97.0, 97.1, 96.8, 96.9)); ts += step; }
  candles.push(c(new Date(ts * 1000).toISOString(), 96.8, 96.9, 95.5, 95.6)); ts += step; // BOS down
  r = engine.tick([...candles]);
  console.log(`After 1m MSS:    state=${r.state}  ${r.waitReason.slice(0, 60)}`);

  // 1m FVG: bear displacement
  candles.push(c(new Date(ts * 1000).toISOString(), 96.0, 96.2, 95.8, 95.9)); ts += step; // c0
  candles.push(c(new Date(ts * 1000).toISOString(), 95.8, 95.9, 94.5, 94.6)); ts += step; // c1 displacement
  candles.push(c(new Date(ts * 1000).toISOString(), 94.7, 95.0, 94.5, 94.8)); ts += step; // c2: high(95.0) < c0.low(95.8) ✓ → FVG: 95.0–95.8 mid=95.4
  r = engine.tick([...candles]);
  console.log(`After 1m FVG:    state=${r.state}  ${r.waitReason.slice(0,60)}`);

  // Retest: price rallies back UP into the FVG zone (95.0–95.8), wick enters from below
  candles.push(c(new Date(ts * 1000).toISOString(), 94.9, 95.5, 94.8, 95.0)); ts += step; // high=95.5 enters FVG ✓
  r = engine.tick([...candles]);
  console.log(`After retest:    state=${r.state}  entryReady=${r.entryReady}`);
  if (r.entryReady && r.signal) {
    const s = r.signal;
    console.log(`  Entry: ${s.entry}  SL: ${s.sl}  TP1: ${s.tp1}  Risk: ${s.riskPts}pts`);
    console.log('  ✅ PASS');
  } else {
    console.log('  ❌ FAIL — no entry signal');
    console.log('  waitReason:', r.waitReason);
  }
}

const perm = test5mEngine();
test1mEngine(perm);
