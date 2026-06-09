'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  DJ30 ICT — 3 MONTH BACKTEST
//  DJ30 strategy: Kill Zone IS the bias filter — no HTF bias gate needed
//  NY Open (12-15 UTC) and London (07-09 UTC) provide the directional event
//    • Kill zone only (London 07-09, NY 12-15 UTC) — this replaces HTF bias
//    • 80% min confluence
//    • Liquidity sweep → MSS/BOS/CHoCH → FVG confirmation candle
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
const TP1_R         = 1.5;
const SIM_BARS      = 288;   // 24h of 5m bars
const MIN_SCORE     = 80;
const COOLDOWN      = 36;    // 3h in 5m bars

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

function htfBiasFromCandles(daily, h4) {
  function swings(arr) {
    const highs = [], lows = [];
    for (let i = 2; i < arr.length - 2; i++) {
      const c = arr[i];
      if (c.high > arr[i-1].high && c.high > arr[i-2].high && c.high > arr[i+1].high && c.high > arr[i+2].high) highs.push(c.high);
      if (c.low  < arr[i-1].low  && c.low  < arr[i-2].low  && c.low  < arr[i+1].low  && c.low  < arr[i+2].low)  lows.push(c.low);
    }
    return { highs, lows };
  }
  function bias({ highs, lows }) {
    if (highs.length < 2 || lows.length < 2) return 'ranging';
    const hh = highs[highs.length-1] > highs[highs.length-2];
    const hl = lows[lows.length-1]   > lows[lows.length-2];
    const lh = highs[highs.length-1] < highs[highs.length-2];
    const ll = lows[lows.length-1]   < lows[lows.length-2];
    if (hh && hl) return 'bullish';
    if (lh && ll) return 'bearish';
    return 'ranging';
  }
  const db = bias(swings(daily)), h4b = bias(swings(h4));
  if (db === 'bullish' && h4b === 'bullish') return 'bullish';
  if (db === 'bearish' && h4b === 'bearish') return 'bearish';
  if (db === 'bullish' && h4b === 'bearish') return 'pullback_in_bull';
  if (db === 'bearish' && h4b === 'bullish') return 'pullback_in_bear';
  return 'ranging';
}

function htfAligned(bias, dir) {
  return (dir === 'bull' && (bias === 'bullish' || bias === 'pullback_in_bear'))
      || (dir === 'bear' && (bias === 'bearish' || bias === 'pullback_in_bull'));
}

function detectSweep(candles15m, candles5m) {
  const LOOKBACK = 50;
  const recent15 = candles15m.slice(-LOOKBACK);
  const last5    = candles5m[candles5m.length - 1];
  const levels   = [];

  for (let i = 2; i < recent15.length - 1; i++) {
    const c = recent15[i];
    const prev = recent15.slice(Math.max(0, i-10), i);
    const eqH = prev.find(p => Math.abs(p.high - c.high) / c.high < 0.0005);
    if (eqH) levels.push({ price: Math.max(c.high, eqH.high), type: 'BSL', name: 'Equal Highs (BSL)' });
    const eqL = prev.find(p => Math.abs(p.low - c.low) / c.low < 0.0005);
    if (eqL) levels.push({ price: Math.min(c.low, eqL.low), type: 'SSL', name: 'Equal Lows (SSL)' });
  }

  // Prev day H/L
  const yesterday = candles15m.slice(-100).filter(c => {
    const h = new Date(c.time).getUTCHours(); return h >= 21 || h < 2;
  });
  if (yesterday.length) {
    levels.push({ price: Math.max(...yesterday.map(c => c.high)), type: 'BSL', name: 'Prev Day High' });
    levels.push({ price: Math.min(...yesterday.map(c => c.low)),  type: 'SSL', name: 'Prev Day Low' });
  }

  const results = [];
  for (const lvl of levels) {
    if (lvl.type === 'BSL' && last5.high > lvl.price && last5.close < lvl.price)
      results.push({ dir: 'bear', level: lvl.price, levelName: lvl.name, barsAgo: 0 });
    if (lvl.type === 'SSL' && last5.low < lvl.price && last5.close > lvl.price)
      results.push({ dir: 'bull', level: lvl.price, levelName: lvl.name, barsAgo: 0 });
  }

  for (let back = 1; back <= 12; back++) {
    const idx = candles5m.length - 1 - back;
    if (idx < 0) break;
    const c = candles5m[idx];
    for (const lvl of levels) {
      if (lvl.type === 'BSL' && c.high > lvl.price && c.close < lvl.price)
        results.push({ dir: 'bear', level: lvl.price, levelName: lvl.name, barsAgo: back });
      if (lvl.type === 'SSL' && c.low < lvl.price && c.close > lvl.price)
        results.push({ dir: 'bull', level: lvl.price, levelName: lvl.name, barsAgo: back });
    }
  }

  if (!results.length) return { detected: false };
  results.sort((a, b) => a.barsAgo - b.barsAgo);
  return { detected: true, ...results[0] };
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
  const minTP  = isLong ? entry + risk * 1.5 : entry - risk * 1.5;
  const maxR   = 4.0;
  const candidates = [];

  const c5 = candles5m.slice(-60);
  for (let i = 2; i < c5.length - 1; i++) {
    const c = c5[i], prev = c5.slice(Math.max(0, i-8), i);
    if (isLong) {
      const eq = prev.find(p => Math.abs(p.high - c.high) / c.high < 0.001);
      if (eq) candidates.push({ price: Math.max(c.high, eq.high), desc: '5m equal highs' });
    } else {
      const eq = prev.find(p => Math.abs(p.low - c.low) / c.low < 0.001);
      if (eq) candidates.push({ price: Math.min(c.low, eq.low), desc: '5m equal lows' });
    }
  }

  const c1h = h1Candles.slice(-24);
  for (let i = 2; i < c1h.length - 2; i++) {
    const c = c1h[i];
    if (isLong && c.high > c1h[i-1].high && c.high > c1h[i-2].high && c.high > c1h[i+1].high)
      candidates.push({ price: c.high, desc: '1H swing high' });
    if (!isLong && c.low < c1h[i-1].low && c.low < c1h[i-2].low && c.low < c1h[i+1].low)
      candidates.push({ price: c.low, desc: '1H swing low' });
  }

  const valid = candidates
    .filter(t => isLong ? t.price > minTP && t.price < entry + risk * maxR
                        : t.price < minTP && t.price > entry - risk * maxR)
    .sort((a, b) => isLong ? a.price - b.price : b.price - a.price);

  const tp2obj = valid[0] || { price: isLong ? entry + risk*2.5 : entry - risk*2.5, desc: 'Fixed 2.5R' };
  const tp3obj = valid[1] || { price: isLong ? entry + risk*3.5 : entry - risk*3.5, desc: 'Fixed 3.5R' };
  return { tp2: tp2obj.price, tp2Desc: tp2obj.desc, tp3: tp3obj.price, tp3Desc: tp3obj.desc };
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
function simulateOutcome(dir, entry, sl, tp1, tp2, tp3, futureCandles) {
  let tp1Hit = false, currentSL = sl;
  for (const c of futureCandles) {
    const slHit  = dir === 'bull' ? c.low <= currentSL : c.high >= currentSL;
    const tp1Hit_ = dir === 'bull' ? c.high >= tp1 : c.low <= tp1;
    const tp2Hit  = dir === 'bull' ? c.high >= tp2 : c.low <= tp2;
    const tp3Hit  = dir === 'bull' ? c.high >= tp3 : c.low <= tp3;

    if (!tp1Hit) {
      if (slHit)   return { result: 'LOSS',       pnlR: -1,                                   exits: ['Full loss at SL'] };
      if (tp3Hit)  return { result: 'WIN_TP3',    pnlR: 0.5*TP1_R+0.25*2.5+0.25*3.5,         exits: ['50%@TP1','25%@TP2','25%@TP3'] };
      if (tp2Hit)  return { result: 'WIN_TP2',    pnlR: 0.5*TP1_R+0.5*2.5,                   exits: ['50%@TP1','50%@TP2'] };
      if (tp1Hit_) { tp1Hit = true; currentSL = entry; }
    } else {
      if (slHit)   return { result: 'WIN_TP1_BE', pnlR: 0.5*TP1_R,                            exits: ['50%@TP1','50% BE'] };
      if (tp3Hit)  return { result: 'WIN_TP3',    pnlR: 0.5*TP1_R+0.25*2.5+0.25*3.5,         exits: ['50%@TP1','25%@TP2','25%@TP3'] };
      if (tp2Hit)  return { result: 'WIN_TP2',    pnlR: 0.5*TP1_R+0.5*2.5,                   exits: ['50%@TP1','50%@TP2'] };
    }
  }
  if (tp1Hit) return { result: 'WIN_TP1_OPEN', pnlR: 0.5*TP1_R, exits: ['50%@TP1','50% open'] };
  return { result: 'OPEN', pnlR: null, exits: [] };
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
  console.log('\n' + chalk.bold.cyan('  ◆ DJ30 ICT — 3 MONTH BACKTEST'));
  console.log(chalk.gray('  HTF Bias filter ON  |  Kill Zone only  |  80% min score  |  1% risk  |  £1,000 start\n'));

  const range = threeMonthRange();
  console.log(chalk.gray(`  Period: ${range.label}\n`));
  console.log(chalk.gray('  Fetching data in monthly chunks...\n'));

  const all5m  = await fetchChunked('5min',  4500, 4); await wait(15000);
  const all15m = await fetchChunked('15min', 1500, 4); await wait(15000);
  const allH1  = await fetchChunked('1h',    750,  4); await wait(15000);

  process.stdout.write(chalk.gray('  Fetching 4H candles...'));
  const allH4 = await fetchWithRetry({ symbol: SYMBOL, interval: '4h', outputsize: 200 }, '4h_3m')
    .catch(() => { process.stdout.write(chalk.yellow(' using rollup\n')); return rollup(allH1, 4); });
  await wait(10000);

  process.stdout.write(chalk.gray('  Fetching Daily candles...'));
  const allDaily = await fetchWithRetry({ symbol: SYMBOL, interval: '1day', outputsize: 90 }, '1day_3m')
    .catch(() => { process.stdout.write(chalk.yellow(' using rollup\n')); return rollup(allH1, 24); });

  console.log(chalk.green('\n  ✓ Data assembled'));

  const period5m = all5m.filter(c => {
    const t = new Date(c.time); return t >= range.start && t <= range.end;
  });
  console.log(chalk.gray(`  5m bars in range: ${period5m.length}\n`));
  if (!period5m.length) { console.log(chalk.red('  No data.')); return; }

  // ─── Backtest loop ──────────────────────────────────────────────────────────
  const signals    = [];
  let lastBar      = -999;
  let balance      = ACCOUNT_START;
  let peakBalance  = ACCOUNT_START;
  let maxDrawdown  = 0;

  for (let i = 50; i < period5m.length - 1; i++) {
    const bar  = period5m[i];
    const time = new Date(bar.time);

    if (i - lastBar < COOLDOWN) continue;
    if (!isKillZone(bar.time)) continue;

    const slice5m  = all5m.filter(c  => new Date(c.time) <= time);
    const slice15m = all15m.filter(c => new Date(c.time) <= time);
    const sliceH1  = allH1.filter(c  => new Date(c.time) <= time);

    if (slice5m.length < 40 || allH4.length < 6 || allDaily.length < 5) continue;

    let bias, sweep, mss, fvg, conf;
    try {
      sweep = detectSweep(slice15m, slice5m);
      mss   = sweep.detected ? detectMSS(slice5m, sweep.dir) : { confirmed: false };
      fvg   = (sweep.detected && mss.confirmed) ? detectFVG(slice5m, sweep.dir) : { found: false };
      conf  = sweep.dir ? scoreConf(sweep, mss, fvg) : { score: 0, grade: 'D' };
    } catch (e) { continue; }

    const dir = sweep.dir;
    if (!dir || !mss.confirmed || !fvg.inFVG || conf.score < MIN_SCORE) continue;

    const isLong  = dir === 'bull';
    const entry   = isLong ? fvg.bottom + fvg.size * 0.5 : fvg.top - fvg.size * 0.5;
    const sl      = isLong
      ? sweep.level - sweep.level * 0.001
      : sweep.level + sweep.level * 0.001;
    const risk    = Math.abs(entry - sl);
    if (risk <= 0 || risk > entry * 0.015) continue;  // skip if SL > 1.5% away (sanity check)

    const tp1 = isLong ? entry + risk * TP1_R : entry - risk * TP1_R;
    const { tp2, tp2Desc, tp3, tp3Desc } = liquidityTPs(dir, entry, risk, slice5m, sliceH1);

    const future  = period5m.slice(i + 1, i + SIM_BARS);
    const outcome = simulateOutcome(dir, entry, sl, tp1, tp2, tp3, future);

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
      sl: parseFloat(sl.toFixed(2)), tp1: parseFloat(tp1.toFixed(2)),
      tp2: parseFloat(tp2.toFixed(2)), tp3: parseFloat(tp3.toFixed(2)),
      risk: parseFloat(risk.toFixed(2)),
      score: conf.score, grade: conf.grade,
      session: sessionLabel(bar.time), htfBias: bias,
      sweep: sweep.levelName, mssType: mss.type,
      tp2Desc, tp3Desc,
      riskGBP: parseFloat(riskGBP.toFixed(2)),
      pnlGBP:  pnlGBP !== null ? parseFloat(pnlGBP.toFixed(2)) : null,
      balanceAfter: pnlGBP !== null ? parseFloat(balance.toFixed(2)) : null,
      ...outcome
    });

    lastBar = i;
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
      chalk.gray(`  TP1 `) + chalk.green(`$${s.tp1}`) +
      chalk.gray(`  TP2 `) + chalk.green(`$${s.tp2}`) + chalk.gray(` (${s.tp2Desc})`)
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
    settings: { symbol: 'DJ30/DIA', startBalance: ACCOUNT_START, riskPct: RISK_PCT*100, minConfluence: MIN_SCORE },
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
