'use strict';

// ─── Unit test for Engine5m + Engine1m using synthetic candles ─────────────────

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
  const t0   = 1700000000;
  let ts     = t0;
  const step = 5 * 60;

  // 50 flat candles at 99
  for (let i = 0; i < 50; i++) {
    base.push(c(new Date(ts * 1000).toISOString(), 99, 99.3, 98.7, 99));
    ts += step;
  }
  // Swing high formation
  for (let i = 0; i < 3; i++) { base.push(c(new Date(ts * 1000).toISOString(), 99, 99.2, 98.8, 99)); ts += step; }
  base.push(c(new Date(ts * 1000).toISOString(), 99.5, 100.5, 99.3, 99.8)); ts += step; // swing HIGH = 100.5
  for (let i = 0; i < 3; i++) { base.push(c(new Date(ts * 1000).toISOString(), 99, 99.2, 98.8, 99)); ts += step; }
  // Swing low formation
  for (let i = 0; i < 3; i++) { base.push(c(new Date(ts * 1000).toISOString(), 99, 99.2, 98.8, 99)); ts += step; }
  base.push(c(new Date(ts * 1000).toISOString(), 98.5, 98.8, 97.3, 97.5)); ts += step; // swing LOW = 97.3
  for (let i = 0; i < 3; i++) { base.push(c(new Date(ts * 1000).toISOString(), 99, 99.2, 98.8, 99)); ts += step; }
  // Fill to 140 candles
  while (base.length < 140) { base.push(c(new Date(ts * 1000).toISOString(), 99, 99.2, 98.8, 99)); ts += step; }

  // Run engine pre-KZ to build pivots
  for (let i = 50; i < base.length; i++) {
    engine.tick('2024-01-01', base.slice(i - 50, i + 1), false);
  }

  // KZ opens — engine should grant permission immediately with both levels
  let r = engine.tick('2024-01-02', base.slice(-51), true);
  console.log(`KZ open: state=${r.state}  permissionGranted=${r.permissionGranted}`);

  if (r.permissionGranted) {
    console.log(`  targetHigh=${r.permission.targetHigh}  targetLow=${r.permission.targetLow}`);
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

  // targetHigh = 100.5, targetLow = 97.3
  const targetHigh = permission5m.targetHigh;

  const candles = [];
  let ts = 1700100000;
  const step = 60;

  // 30 flat candles at 99
  for (let i = 0; i < 30; i++) {
    candles.push(c(new Date(ts * 1000).toISOString(), 99, 99.3, 98.7, 99)); ts += step;
  }

  // Sweep of 5m targetHigh (100.5): wick above, close back below
  candles.push(c(new Date(ts * 1000).toISOString(), 99.8, 101.0, 99.5, 99.3)); ts += step;
  let r = engine.tick([...candles]);
  console.log(`After sweep:     state=${r.state}  ${r.waitReason.slice(0, 70)}`);

  // 1m MSS: displacement bearish candle breaking below recent swing low
  // First create a small local low to break
  candles.push(c(new Date(ts * 1000).toISOString(), 99.2, 99.4, 98.8, 98.9)); ts += step;
  candles.push(c(new Date(ts * 1000).toISOString(), 98.9, 99.0, 98.5, 98.6)); ts += step; // local low ~98.5
  candles.push(c(new Date(ts * 1000).toISOString(), 98.6, 98.7, 98.4, 98.5)); ts += step;
  // Displacement down: big bearish candle closing below 98.5
  candles.push(c(new Date(ts * 1000).toISOString(), 98.5, 98.6, 96.8, 96.9)); ts += step;
  r = engine.tick([...candles]);
  console.log(`After MSS:       state=${r.state}  ${r.waitReason.slice(0, 70)}`);

  // FVG: need c2.high < c0.low to form bear FVG
  // c0 already pushed above. displacement was last candle. now push c2
  candles.push(c(new Date(ts * 1000).toISOString(), 97.0, 97.5, 96.8, 97.1)); ts += step; // c2: high 97.5, need < c0.low
  r = engine.tick([...candles]);
  console.log(`After FVG push:  state=${r.state}  ${r.waitReason.slice(0, 70)}`);

  // If still in MSS, try a cleaner 3-candle FVG sequence
  if (r.state === 'MSS') {
    // c0 at 98.5 (low), c1 displacement, c2 with high below c0.low
    candles.push(c(new Date(ts * 1000).toISOString(), 98.4, 98.5, 98.1, 98.2)); ts += step; // new c0
    candles.push(c(new Date(ts * 1000).toISOString(), 98.0, 98.1, 96.0, 96.2)); ts += step; // c1 displacement
    candles.push(c(new Date(ts * 1000).toISOString(), 96.3, 97.0, 96.1, 96.5)); ts += step; // c2 high=97.0 < c0.low=98.1 ✓ → FVG 97.0–98.1
    r = engine.tick([...candles]);
    console.log(`After 2nd FVG:   state=${r.state}  ${r.waitReason.slice(0, 70)}`);
  }

  // Price rallies back to FVG entry level (c2.high of the FVG)
  if (r.state === 'ENTRY_WATCH') {
    // Must reach the entryLevel shown in the waitReason
    candles.push(c(new Date(ts * 1000).toISOString(), 96.5, 99.5, 96.3, 96.8)); ts += step;
    r = engine.tick([...candles]);
    console.log(`After retest:    state=${r.state}  entryReady=${r.entryReady}`);
  }

  if (r.entryReady && r.signal) {
    const s = r.signal;
    console.log(`  Direction: ${s.direction}`);
    console.log(`  Entry: ${s.entry}  SL: ${s.sl}  TP1: ${s.tp1}  TP2: ${s.tp2}  Risk: ${s.riskPts}pts`);
    console.log(`  ${s.entryLevel}`);
    console.log('  ✅ PASS');
  } else {
    console.log('  ❌ FAIL — no entry signal');
    console.log('  waitReason:', r.waitReason);
  }
}

const perm = test5mEngine();
test1mEngine(perm);
