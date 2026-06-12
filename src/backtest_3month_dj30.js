'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  DJ30 ICT — 3 MONTH BACKTEST  (Market Execution Edition)
//  DJ30 strategy: Kill Zone IS the bias filter — no HTF bias gate needed
//  NY Open (12-15 UTC) and London (07-09 UTC) provide the directional event
//    • Kill zone only (London 07-09, NY 12-15 UTC) — this replaces HTF bias
//    • 80% min confluence
//    • Liquidity sweep → MSS/BOS/CHoCH → FVG confirmation candle
//    • ENTRY: open of the NEXT bar after signal fires (market execution)
//    • SL: just beyond sweep level (same as live)
//    • Multi-TF liquidity targets (TP2/TP3)
//    • 50% close TP1 @ 1.5R, BE stop, 25% TP2, 25% TP3
//    • 1% risk per trade, £1,000 start
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const axios = require('axios');
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const KEY    = process.env.TWELVEDATA_API_KEY;
const BASE   = 'https://api.twelvedata.com';
const SYMBOL = 'DIA';   // Dow Jones ETF — free-tier proxy for DJ30

// ─── Account settings ────────────────────────────────────────────────────────
const ACCOUNT_START = 1000;
const RISK_PCT      = 0.01;
const SIM_BARS      = 288;   // 24h of 5m bars
const MIN_SCORE     = 80;

// ─── Date helpers ────────────────────────────────────────────────────────────
function fmt(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function fmtDT(iso) {
  const d = new Date(iso);
  return `${fmt(d)} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} UTC`;
}
function fmtGBP(n) { return '£' + n.toFixed(2); }

function threeMonthRange() {
  const now = new Date();
  const day = now.getUTCDay();
  const daysToLastFri = day === 0 ? 1 : (day >= 6 ? day - 5 : day + 2);
  const end = new Date(now);
  end.setUTCDate(now.getUTCDate() - daysToLastFri);
  end.setUTCHours(23, 59, 59, 0);
  const start = new Date(end);
  start.setUTCMonth(start.getUTCMonth() - 3);
  start.setUTCHours(0, 0, 0, 0);
  return { start, end, label: `${fmt(start)} → ${fmt(end)}` };
}

// ─── Disk cache ──────────────────────────────────────────────────────────────
const CACHE_DIR = path.join(__dirname, '..', '.cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

const wait = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(params, label) {
  const cacheFile = path.join(CACHE_DIR, `dj30_${label}.json`);
  if (fs.existsSync(cacheFile)) {
    process.stdout.write(chalk.gray(` (cached)\n`));
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      const delay = [30000, 60000, 90000, 120000][attempt-1] || 120000;
      process.stdout.write(chalk.yellow(` rate-limited, retry in ${delay/1000}s...\n`));
      await wait(delay);
    }
    try {
      const r = await axios.get(`${BASE}/time_series`, {
        params: { ...params, apikey: KEY, format: 'JSON', timezone: 'UTC' },
        timeout: 25000
      });
      if (r.data.status === 'error') throw new Error(`TwelveData: ${r.data.message}`);
      if (!r.data.values?.length) throw new Error('No data returned');
      const candles = r.data.values.reverse().map(c => ({
        time: c.datetime, open: parseFloat(c.open), high: parseFloat(c.high),
        low: parseFloat(c.low), close: parseFloat(c.close), volume: parseFloat(c.volume || 0)
      }));
      fs.writeFileSync(cacheFile, JSON.stringify(candles));
      process.stdout.write(chalk.green(` ✓ ${candles.length} bars\n`));
      return candles;
    } catch (e) {
      if (e.response?.status === 429 || e.message.includes('429')) { lastErr = e; continue; }
      throw e;
    }
  }
  throw lastErr || new Error('Max retries exceeded');
}

async function fetchChunked(interval, outputsize, months) {
  const now = new Date();
  const allCandles = [];
  for (let m = months - 1; m >= 0; m--) {
    const endDate = new Date(now);
    endDate.setUTCMonth(now.getUTCMonth() - m);
    endDate.setUTCDate(1);
    endDate.setUTCHours(0,0,0,0);
    const startDate = new Date(endDate);
    startDate.setUTCMonth(startDate.getUTCMonth() - 1);
    const label = `${interval}_${fmt(startDate)}_${fmt(endDate)}`;
    process.stdout.write(chalk.gray(`  ${interval} chunk ${fmt(startDate)}...`));
    try {
      const chunk = await fetchWithRetry({
        symbol: SYMBOL, interval, outputsize,
        start_date: `${fmt(startDate)} 00:00:00`,
        end_date:   `${fmt(endDate)} 23:59:59`
      }, label);
      allCandles.push(...chunk);
      await wait(8000);
    } catch (e) {
      process.stdout.write(chalk.yellow(` skipped: ${e.message.slice(0,50)}\n`));
    }
  }
  const seen = new Set();
  return allCandles
    .filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
    .sort((a, b) => new Date(a.time) - new Date(b.time));
}

function rollup(src, factor) {
  const out = [];
  for (let i = 0; i < src.length; i += factor) {
    const s = src.slice(i, i + factor);
    if (!s.length) continue;
    out.push({ time: s[0].time, open: s[0].open, high: Math.max(...s.map(c => c.high)),
      low: Math.min(...s.map(c => c.low)), close: s[s.length-1].close,
      volume: s.reduce((a, c) => a + c.volume, 0) });
  }
  return out;
}

// ─── ICT Engine (mirrors ict.js logic inline for backtest precision) ─────────

// ─── Pre-NY range from 5m candles (07:00–13:55 UTC on the given date) ────────
function getPreNYRange(candles5m, dateStr) {
  const session = candles5m.filter(c => {
    if (!c.time.startsWith(dateStr)) return false;
    const h = new Date(c.time).getUTCHours();
    const m = new Date(c.time).getUTCMinutes();
    const mins = h * 60 + m;
    return mins >= 7 * 60 && mins < 14 * 60;
  });
  if (session.length < 3) return null;
  return {
    high: Math.max(...session.map(c => c.high)),
    low:  Math.min(...session.map(c => c.low)),
    candles: session.length
  };
}

// ─── Judas sweep: wick beyond pre-NY range H/L, close back inside ────────────
// Scans the last few 5m bars in the NY window (14:00–16:00 UTC) for a sweep
function detectSweep(candles5m, preNYRange) {
  if (!preNYRange) return { detected: false };

  // Look back up to 12 bars (1 hour) within NY window for a fresh sweep
  for (let back = 0; back <= 12; back++) {
    const idx = candles5m.length - 1 - back;
    if (idx < 0) break;
    const c = candles5m[idx];
    const h = new Date(c.time).getUTCHours();
    if (h < 14 || h >= 16) continue;

    if (c.high > preNYRange.high && c.close < preNYRange.high)
      return { detected: true, dir: 'bear', level: preNYRange.high, levelName: 'Pre-NY High (BSL)', sweepCandle: c, barsAgo: back };
    if (c.low < preNYRange.low && c.close > preNYRange.low)
      return { detected: true, dir: 'bull', level: preNYRange.low,  levelName: 'Pre-NY Low (SSL)',  sweepCandle: c, barsAgo: back };
  }

  return { detected: false };
}

function detectMSS(candles5m, sweepDir) {
  const window = candles5m.slice(-20);
  if (window.length < 5) return { confirmed: false };

  if (sweepDir === 'bear') {
    let swingLow = Infinity;
    for (let i = 0; i < window.length - 3; i++) {
      const c = window[i];
      if (c.low < (window[i-1]?.low ?? Infinity) && c.low < (window[i+1]?.low ?? Infinity))
        swingLow = Math.min(swingLow, c.low);
    }
    const last = window[window.length - 1], prev = window[window.length - 2];
    if (swingLow < Infinity && last.close < swingLow)
      return { confirmed: true, type: 'BOS_DOWN', level: swingLow };
    if (last.close < prev.low)
      return { confirmed: true, type: 'CHoCH', level: prev.low };
  }

  if (sweepDir === 'bull') {
    let swingHigh = -Infinity;
    for (let i = 0; i < window.length - 3; i++) {
      const c = window[i];
      if (c.high > (window[i-1]?.high ?? -Infinity) && c.high > (window[i+1]?.high ?? -Infinity))
        swingHigh = Math.max(swingHigh, c.high);
    }
    const last = window[window.length - 1], prev = window[window.length - 2];
    if (swingHigh > -Infinity && last.close > swingHigh)
      return { confirmed: true, type: 'BOS_UP', level: swingHigh };
    if (last.close > prev.high)
      return { confirmed: true, type: 'CHoCH', level: prev.high };
  }

  return { confirmed: false };
}

function detectFVG(candles5m, sweepDir) {
  const window = candles5m.slice(-30);
  const candidates = [];
  for (let i = 0; i < window.length - 2; i++) {
    const c0 = window[i], c2 = window[i + 2];
    if (sweepDir === 'bear' && c2.high < c0.low) {
      const size = c0.low - c2.high;
      if (size > 0) candidates.push({ top: c0.low, bottom: c2.high, size });
    }
    if (sweepDir === 'bull' && c2.low > c0.high) {
      const size = c2.low - c0.high;
      if (size > 0) candidates.push({ top: c2.low, bottom: c0.high, size });
    }
  }
  if (!candidates.length) return { found: false };

  const best = candidates.slice(-3).sort((a, b) => b.size - a.size)[0];
  const prev = window[window.length - 2];
  let confirmed = false;

  if (sweepDir === 'bear') {
    const wickedIn = prev.high >= best.bottom;
    const closedBack = prev.close <= best.top;
    confirmed = wickedIn && closedBack && (prev.high - best.bottom) >= best.size * 0.5;
  } else {
    const wickedIn = prev.low <= best.top;
    const closedBack = prev.close >= best.bottom;
    confirmed = wickedIn && closedBack && (best.top - prev.low) >= best.size * 0.5;
  }

  return { found: true, top: best.top, bottom: best.bottom, size: best.size, inFVG: confirmed };
}

function liquidityTPs(dir, entry, risk, candles5m, h1Candles) {
  const isLong = dir === 'bull';
  const MIN_R  = 1.0;
  const MAX_R  = 8.0;
  const candidates = [];

  function rOf(p) { return Math.abs(p - entry) / risk; }
  function validSide(p) { return isLong ? p > entry : p < entry; }
  function inRange(p) { return rOf(p) >= MIN_R && rOf(p) <= MAX_R; }

  const c5 = candles5m.slice(-60);
  for (let i = 2; i < c5.length - 1; i++) {
    const c = c5[i], prev = c5.slice(Math.max(0, i-8), i);
    if (isLong) {
      const eq = prev.find(p => Math.abs(p.high - c.high) / c.high < 0.001);
      if (eq) {
        const price = Math.max(c.high, eq.high);
        if (validSide(price) && inRange(price))
          candidates.push({ price, r: rOf(price), desc: '5m equal highs', priority: 1 });
      }
    } else {
      const eq = prev.find(p => Math.abs(p.low - c.low) / c.low < 0.001);
      if (eq) {
        const price = Math.min(c.low, eq.low);
        if (validSide(price) && inRange(price))
          candidates.push({ price, r: rOf(price), desc: '5m equal lows', priority: 1 });
      }
    }
  }

  const c1h = h1Candles.slice(-24);
  for (let i = 2; i < c1h.length - 2; i++) {
    const c = c1h[i];
    if (isLong && c.high > c1h[i-1].high && c.high > c1h[i-2].high && c.high > c1h[i+1].high) {
      if (validSide(c.high) && inRange(c.high))
        candidates.push({ price: c.high, r: rOf(c.high), desc: '1H swing high', priority: 2 });
    }
    if (!isLong && c.low < c1h[i-1].low && c.low < c1h[i-2].low && c.low < c1h[i+1].low) {
      if (validSide(c.low) && inRange(c.low))
        candidates.push({ price: c.low, r: rOf(c.low), desc: '1H swing low', priority: 2 });
    }
  }

  candidates.sort((a, b) => a.r !== b.r ? a.r - b.r : a.priority - b.priority);

  // Deduplicate nearby levels (within 0.05% of price)
  const deduped = [];
  for (const c of candidates) {
    const tol = entry * 0.0005;
    if (!deduped.find(d => Math.abs(d.price - c.price) <= tol)) deduped.push(c);
  }

  const tp1Obj  = deduped[0] || null;
  const tp1     = tp1Obj ? tp1Obj.price : parseFloat((isLong ? entry + risk * 2 : entry - risk * 2).toFixed(2));
  const tp1R    = parseFloat(rOf(tp1).toFixed(2));
  const tp1Desc = tp1Obj ? tp1Obj.desc : 'Fixed 2R (no structure)';

  const tp2Candidates = deduped.filter(c => c.r >= tp1R + 1.0);
  const tp2Obj  = tp2Candidates[0] || null;
  const tp2     = tp2Obj ? tp2Obj.price : parseFloat((isLong ? entry + risk * (tp1R + 2) : entry - risk * (tp1R + 2)).toFixed(2));
  const tp2R    = parseFloat(rOf(tp2).toFixed(2));
  const tp2Desc = tp2Obj ? tp2Obj.desc : 'Fixed extension (no structure beyond TP1)';

  return { tp1, tp1R, tp1Desc, tp2, tp2R, tp2Desc };
}

function scoreConf(sweep, mss, fvg) {
  let score = 25;  // KZ = 25pts (enforced by loop gate, replaces HTF bias)
  if (sweep.detected)  { score += 25; }
  if (mss.confirmed)   { score += 25; }
  if (fvg.found)       { score += 15; }
  if (fvg.inFVG)       { score += 10; }
  const grade = score >= 90 ? 'A+' : score >= 80 ? 'A' : score >= 70 ? 'B' : score >= 60 ? 'C' : 'D';
  return { score: Math.min(score, 100), grade };
}

// ─── Trade simulation ────────────────────────────────────────────────────────
function simulateOutcome(dir, entry, sl, tp1, tp2, tp1R, tp2R, futureCandles) {
  let tp1Hit = false, currentSL = sl;
  for (const c of futureCandles) {
    const slHit   = dir === 'bull' ? c.low  <= currentSL : c.high >= currentSL;
    const tp1Hit_ = dir === 'bull' ? c.high >= tp1       : c.low  <= tp1;
    const tp2Hit  = dir === 'bull' ? c.high >= tp2       : c.low  <= tp2;
    if (!tp1Hit) {
      if (slHit)   return { result: 'LOSS',       pnlR: -1 };
      if (tp2Hit)  return { result: 'WIN_TP2',    pnlR: +(0.5 * tp1R + 0.5 * tp2R).toFixed(2) };
      if (tp1Hit_) { tp1Hit = true; currentSL = entry; }
    } else {
      if (slHit)   return { result: 'WIN_TP1_BE', pnlR: +(0.5 * tp1R).toFixed(2) };
      if (tp2Hit)  return { result: 'WIN_TP2',    pnlR: +(0.5 * tp1R + 0.5 * tp2R).toFixed(2) };
    }
  }
  if (tp1Hit) return { result: 'WIN_TP1_OPEN', pnlR: +(0.5 * tp1R).toFixed(2) };
  return { result: 'OPEN', pnlR: null };
}

function isKillZone(iso) {
  const h = new Date(iso).getUTCHours();
  return (h >= 7 && h < 9) || (h >= 12 && h < 15);
}

function sessionLabel(iso) {
  const h = new Date(iso).getUTCHours();
  if (h >= 7  && h < 9)  return '🟡 London KZ';
  if (h >= 12 && h < 15) return '🟢 NY KZ';
  return 'Off-hours';
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function run() {
  console.clear();
  console.log('\n' + chalk.bold.cyan('  ◆ DJ30 ICT — 3 MONTH BACKTEST  [MARKET EXECUTION]'));
  console.log(chalk.gray('  HTF Bias filter ON  |  Kill Zone only  |  80% min score  |  1% risk  |  £1,000 start\n'));

  const range = threeMonthRange();
  console.log(chalk.gray(`  Period: ${range.label}\n`));
  console.log(chalk.gray('  Fetching data in monthly chunks...\n'));

  const all5m  = await fetchChunked('5min',  4500, 4); await wait(15000);
  const allH1  = await fetchChunked('1h',    750,  4); await wait(15000);

  console.log(chalk.green('\n  ✓ Data assembled'));

  const period5m = all5m.filter(c => {
    const t = new Date(c.time); return t >= range.start && t <= range.end;
  });
  console.log(chalk.gray(`  5m bars in range: ${period5m.length}\n`));
  if (!period5m.length) { console.log(chalk.red('  No data.')); return; }

  // ─── Backtest loop ──────────────────────────────────────────────────────────
  const signals    = [];
  let balance      = ACCOUNT_START;
  let peakBalance  = ACCOUNT_START;
  let maxDrawdown  = 0;

  // One signal per KZ session per day
  const firedSessions = new Set();

  for (let i = 50; i < period5m.length - 1; i++) {
    const bar    = period5m[i];
    const time   = new Date(bar.time);
    const dateStr = bar.time.slice(0, 10);

    // Only scan during NY KZ (14:00–16:00 UTC)
    const h = time.getUTCHours();
    if (h < 14 || h >= 16) continue;

    // One signal per day
    const sessionKey = `${dateStr}_NY`;
    if (firedSessions.has(sessionKey)) continue;

    const slice5m = all5m.filter(c  => new Date(c.time) <= time);
    const sliceH1 = allH1.filter(c  => new Date(c.time) <= time);

    if (slice5m.length < 40 || sliceH1.length < 4) continue;

    // Build pre-NY range from 5m candles on this date
    const preNY = getPreNYRange(slice5m, dateStr);
    if (!preNY) continue;

    let sweep, mss, fvg, conf;
    try {
      sweep = detectSweep(slice5m, preNY);
      mss   = sweep.detected ? detectMSS(slice5m, sweep.dir) : { confirmed: false };
      fvg   = (sweep.detected && mss.confirmed) ? detectFVG(slice5m, sweep.dir) : { found: false };
      conf  = sweep.dir ? scoreConf(sweep, mss, fvg) : { score: 0, grade: 'D' };
    } catch (e) { continue; }

    const dir = sweep.dir;
    if (!dir || !mss.confirmed || !fvg.inFVG || conf.score < MIN_SCORE) continue;

    const isLong  = dir === 'bull';
    // FVG midpoint as limit entry (like live bot)
    const entry   = parseFloat(((fvg.top + fvg.bottom) / 2).toFixed(2));
    // SL: beyond sweep candle extreme + 0.1% buffer
    const sl = isLong
      ? parseFloat((sweep.sweepCandle.low  - sweep.sweepCandle.low  * 0.001).toFixed(2))
      : parseFloat((sweep.sweepCandle.high + sweep.sweepCandle.high * 0.001).toFixed(2));
    const risk    = Math.abs(entry - sl);
    if (risk <= 0 || risk > entry * 0.015) continue;

    const { tp1, tp1R, tp1Desc, tp2, tp2R, tp2Desc } = liquidityTPs(dir, entry, risk, slice5m, sliceH1);

    // Simulate from bar AFTER entry bar (i+1 is entry bar, simulation starts at i+2)
    const future  = period5m.slice(i + 2, i + SIM_BARS);
    const outcome = simulateOutcome(dir, entry, sl, tp1, tp2, tp1R, tp2R, future);

    const riskGBP = balance * RISK_PCT;
    const pnlGBP  = outcome.pnlR != null ? outcome.pnlR * riskGBP : null;

    if (pnlGBP !== null) {
      balance += pnlGBP;
      if (balance > peakBalance) peakBalance = balance;
      const dd = ((peakBalance - balance) / peakBalance) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    signals.push({
      time: bar.time, dir: isLong ? 'BUY' : 'SELL',
      entry: parseFloat(entry.toFixed(2)),
      sl: parseFloat(sl.toFixed(2)),
      tp1: parseFloat(tp1.toFixed(2)), tp1R, tp1Desc,
      tp2: parseFloat(tp2.toFixed(2)), tp2R, tp2Desc,
      risk: parseFloat(risk.toFixed(2)),
      score: conf.score, grade: conf.grade,
      session: sessionLabel(bar.time),
      sweep: sweep.levelName, mssType: mss.type,
      preNYHigh: preNY.high, preNYLow: preNY.low,
      riskGBP: parseFloat(riskGBP.toFixed(2)),
      pnlGBP:  pnlGBP !== null ? parseFloat(pnlGBP.toFixed(2)) : null,
      balanceAfter: pnlGBP !== null ? parseFloat(balance.toFixed(2)) : null,
      ...outcome
    });

    firedSessions.add(sessionKey);
  }

  // ─── Print signals ──────────────────────────────────────────────────────────
  const sep = '═'.repeat(72);
  console.log('\n' + sep);
  console.log(chalk.bold.cyan('  SIGNAL REPORT — DJ30 — 3 MONTHS'));
  console.log(chalk.gray(`  ${range.label}  |  ${MIN_SCORE}% min  |  1% risk/trade`));
  console.log(sep);

  signals.forEach((s, idx) => {
    const isLong = s.dir === 'BUY';
    const color  = isLong ? chalk.green : chalk.red;
    const oc     = s.result?.startsWith('WIN') ? chalk.green : s.result === 'LOSS' ? chalk.red : chalk.yellow;
    const pnlStr = s.pnlR != null
      ? (s.pnlR > 0 ? chalk.green(`+${s.pnlR.toFixed(2)}R  +£${s.pnlGBP}`) : chalk.red(`${s.pnlR.toFixed(2)}R  £${s.pnlGBP}`))
      : chalk.yellow('open');

    console.log(
      '\n  ' + chalk.bold(`#${idx+1}`) + chalk.gray(` ${fmtDT(s.time)}  ${s.session}`) +
      '  ' + color(`${isLong?'▲':'▼'} ${s.dir}`) +
      chalk.gray(`  ${s.score}%  ${s.sweep} → ${s.mssType}`)
    );
    console.log(
      chalk.gray('  Entry ') + chalk.white(`$${s.entry}`) +
      chalk.gray('  SL ') + chalk.red(`$${s.sl}`) +
      chalk.gray(`  TP1 `) + chalk.green(`$${s.tp1}`) + chalk.gray(` (${s.tp1R}R · ${s.tp1Desc})`) +
      chalk.gray(`  TP2 `) + chalk.green(`$${s.tp2}`) + chalk.gray(` (${s.tp2R}R · ${s.tp2Desc})`)
    );
    console.log(
      chalk.gray('  → ') + oc(s.result || 'OPEN') + '  ' + pnlStr +
      (s.balanceAfter ? chalk.gray('  bal: ') + chalk.white(fmtGBP(s.balanceAfter)) : '')
    );
  });

  // ─── Summary ────────────────────────────────────────────────────────────────
  const closed = signals.filter(s => s.result !== 'OPEN' && s.pnlR !== null);
  const wins   = closed.filter(s => s.pnlR > 0);
  const losses = closed.filter(s => s.pnlR < 0);
  const totalR = closed.reduce((sum, s) => sum + s.pnlR, 0);
  const totalGBP = closed.reduce((sum, s) => sum + (s.pnlGBP || 0), 0);
  const wr     = closed.length ? ((wins.length / closed.length) * 100).toFixed(0) : 0;
  const pf     = losses.length
    ? (wins.reduce((s,x)=>s+x.pnlR,0) / Math.abs(losses.reduce((s,x)=>s+x.pnlR,0))).toFixed(2)
    : '∞';

  const byMonth = {};
  signals.forEach(s => {
    const d = new Date(s.time);
    const mk = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
    byMonth[mk] = byMonth[mk] || [];
    byMonth[mk].push(s);
  });

  console.log('\n\n' + sep);
  console.log(chalk.bold.cyan('  3-MONTH SUMMARY'));
  console.log(sep);
  console.log(chalk.gray('  Total signals:  ') + chalk.white(signals.length));
  console.log(chalk.gray('  Closed:         ') + chalk.white(closed.length));
  console.log(chalk.gray('  Wins:           ') + chalk.green(wins.length));
  console.log(chalk.gray('  Losses:         ') + chalk.red(losses.length));
  console.log(chalk.gray('  Win rate:       ') + (parseFloat(wr)>=50?chalk.green:chalk.red)(`${wr}%`));
  console.log(chalk.gray('  Net R:          ') + (totalR>=0?chalk.green(`+${totalR.toFixed(2)}R`):chalk.red(`${totalR.toFixed(2)}R`)));
  console.log(chalk.gray('  Profit factor:  ') + chalk.cyan(pf));

  console.log('\n' + chalk.bold.cyan('  ── ACCOUNT (£1,000 start, 1% risk) ──'));
  console.log(chalk.gray('  Start:          ') + chalk.white('£1,000.00'));
  console.log(chalk.gray('  End:            ') + (balance>=ACCOUNT_START?chalk.green:chalk.red)(fmtGBP(balance)));
  console.log(chalk.gray('  Net P&L:        ') + (totalGBP>=0?chalk.green(`+${fmtGBP(totalGBP)}`):chalk.red(fmtGBP(totalGBP))));
  console.log(chalk.gray('  Return:         ') + (totalGBP>=0?chalk.green:chalk.red)(`${((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)}%`));
  console.log(chalk.gray('  Peak balance:   ') + chalk.white(fmtGBP(peakBalance)));
  console.log(chalk.gray('  Max drawdown:   ') + chalk.yellow(`${maxDrawdown.toFixed(1)}%`));

  console.log(chalk.gray('\n  Month by month:'));
  Object.entries(byMonth).sort().forEach(([mo, sigs]) => {
    const mW = sigs.filter(s=>s.pnlR>0).length;
    const mL = sigs.filter(s=>s.pnlR<0).length;
    const mR = sigs.reduce((sum,s)=>sum+(s.pnlR||0),0);
    const mGBP = sigs.reduce((sum,s)=>sum+(s.pnlGBP||0),0);
    const mWR = (mW+mL)>0 ? Math.round(mW/(mW+mL)*100) : 0;
    console.log(
      chalk.gray(`    ${mo}  `) + chalk.white(`${sigs.length} signals`) + chalk.gray('  ') +
      chalk.green(`${mW}W`) + chalk.gray('/') + chalk.red(`${mL}L`) +
      chalk.gray(`  ${mWR}% WR  `) +
      (mR>=0?chalk.green(`+${mR.toFixed(1)}R`):chalk.red(`${mR.toFixed(1)}R`)) +
      chalk.gray('  ') + (mGBP>=0?chalk.green(`+${fmtGBP(mGBP)}`):chalk.red(fmtGBP(mGBP)))
    );
  });

  console.log(chalk.gray('\n  Session breakdown:'));
  const bySess = {};
  signals.forEach(s => { bySess[s.session] = (bySess[s.session]||[]).concat(s); });
  Object.entries(bySess).sort((a,b)=>b[1].length-a[1].length).forEach(([sess,sigs])=>{
    const sW = sigs.filter(s=>s.pnlR>0).length;
    const sL = sigs.filter(s=>s.pnlR<0).length;
    const sWR = (sW+sL)>0?Math.round(sW/(sW+sL)*100):0;
    console.log(chalk.gray(`    ${sess.padEnd(16)} ${sigs.length} signals  ${sW}W/${sL}L  ${sWR}% WR`));
  });

  console.log(chalk.gray('\n  Result breakdown:'));
  const byResult = {};
  signals.forEach(s => { byResult[s.result] = (byResult[s.result]||0)+1; });
  Object.entries(byResult).sort((a,b)=>b[1]-a[1]).forEach(([r,n])=>{
    const c = r?.startsWith('WIN') ? chalk.green : r==='LOSS' ? chalk.red : chalk.yellow;
    console.log(chalk.gray(`    ${c((r||'?').padEnd(16))}  ${n} trades`));
  });

  const reportPath = path.join(__dirname, '..', 'backtest_report_3month_dj30.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    period: range.label, generatedAt: new Date().toISOString(),
    settings: { symbol: 'DJ30/DIA', entryMethod: 'market_execution_next_bar_open', startBalance: ACCOUNT_START, riskPct: RISK_PCT*100, minConfluence: MIN_SCORE },
    account: {
      start: ACCOUNT_START, end: parseFloat(balance.toFixed(2)),
      netGBP: parseFloat(totalGBP.toFixed(2)),
      returnPct: parseFloat(((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)),
      maxDrawdown: parseFloat(maxDrawdown.toFixed(1)), peakBalance: parseFloat(peakBalance.toFixed(2))
    },
    stats: { total: signals.length, wins: wins.length, losses: losses.length, winRate: wr+'%', netR: totalR.toFixed(2), profitFactor: pf },
    byMonth: Object.fromEntries(Object.entries(byMonth).map(([mo,sigs])=>[mo,{
      signals: sigs.length, wins: sigs.filter(s=>s.pnlR>0).length,
      losses: sigs.filter(s=>s.pnlR<0).length,
      netR: sigs.reduce((s,x)=>s+(x.pnlR||0),0).toFixed(2),
      netGBP: sigs.reduce((s,x)=>s+(x.pnlGBP||0),0).toFixed(2)
    }])),
    signals
  }, null, 2));
  console.log(chalk.gray('\n  Report saved → backtest_report_3month_dj30.json'));
  console.log('\n' + sep + '\n');
}

run().catch(err => {
  console.log(chalk.red(`\n  ✗ Fatal: ${err.message}\n`));
  process.exit(1);
});
