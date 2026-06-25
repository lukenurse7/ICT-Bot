'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  DJ30 ICT — SAME-DAY EXIT BACKTEST  (Jun 2025 → Jun 2026)
//  Aligned to video checklist:
//   1. Pre-KZ 5m swing highs/lows (BSL/SSL) marked before 13:30 UTC
//   2. Sweep of pre-KZ level during kill zone (13:30–16:00 UTC)
//   3. MSS + displacement on 5m (approximation — 1m not available full-year)
//   4. FVG in displacement → limit order at zone boundary (no wick confirmation)
//   5. SL at MSS swing point (not generic swing lookback)
//   6. TP at opposing pre-KZ liquidity
//   7. Force-close 21:00 UTC same day
// ═══════════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const ACCOUNT_START = parseFloat(process.env.ACCOUNT_START || '2000');
const RISK_PCT      = 0.02;
const TP1_R         = 1.5;
const TP2_R         = parseFloat(process.env.TP2_R || '2.0');
const TP3_R         = parseFloat(process.env.TP3_R || '2.5');
const MIN_SCORE     = 75;          // KZ+SWEEP+MSS+FVG = 100; need all 4
const COOLDOWN      = 36;          // 3h cooldown in 5m bars
const DAY_END_HOUR  = 21;
const MIN_RISK_PTS  = parseFloat(process.env.MIN_RISK_PTS || '25');

const CACHE       = path.join(__dirname, '..', '.cache');
const PRICE_SCALE = parseFloat(process.env.DJ30_PRICE_SCALE) || 99.7724;

// ─── Data Loading ─────────────────────────────────────────────────────────────
function loadCached(interval, startYear, startMonth, endYear, endMonth) {
  const all = [];
  let y = startYear, m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    const s  = `${y}-${String(m).padStart(2,'0')}-01`;
    const nm = m + 1 > 12 ? 1 : m + 1;
    const ny = m + 1 > 12 ? y + 1 : y;
    const e  = `${ny}-${String(nm).padStart(2,'0')}-01`;
    const f  = path.join(CACHE, `dj30_${interval}_${s}_${e}.json`);
    if (fs.existsSync(f)) all.push(...JSON.parse(fs.readFileSync(f)));
    m++; if (m > 12) { m = 1; y++; }
  }
  const seen = new Set();
  return all
    .filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
    .sort((a, b) => new Date(a.time) - new Date(b.time))
    .map(c => ({ time: c.time, open: c.open*PRICE_SCALE, high: c.high*PRICE_SCALE,
                 low: c.low*PRICE_SCALE, close: c.close*PRICE_SCALE, volume: c.volume||0 }));
}

// ─── ICT Engine — Video Checklist Aligned ────────────────────────────────────

// Step 1: Liquidity Levels — session-gap filtered intraday swing H/L
// Same approach as live ict.js: use current session's swing highs (BSL) and lows
// (SSL), restricted to candles after the most recent >30min gap (session boundary).
function buildPreKZLevels(candles5m) {
  const GAP_MS = 30 * 60 * 1000;
  let sessionStart = 0;
  for (let i = candles5m.length - 1; i > 0; i--) {
    const gap = new Date(candles5m[i].time).getTime() - new Date(candles5m[i-1].time).getTime();
    if (gap > GAP_MS) { sessionStart = i; break; }
  }
  const sess = candles5m.slice(sessionStart);
  if (sess.length < 5) return { levels: [] };

  const raw = [];
  for (let i = 1; i < sess.length - 1; i++) {
    const c = sess[i];
    if (c.high > sess[i-1].high && c.high > sess[i+1].high)
      raw.push({ price: c.high, type: 'BSL', name: `Intraday H ${c.time.slice(11,16)}` });
    if (c.low < sess[i-1].low && c.low < sess[i+1].low)
      raw.push({ price: c.low,  type: 'SSL', name: `Intraday L ${c.time.slice(11,16)}` });
  }

  const levels = [];
  for (const lvl of raw) {
    if (!levels.find(d => d.type === lvl.type && Math.abs(d.price - lvl.price) / lvl.price < 0.0005))
      levels.push(lvl);
  }
  return { levels };
}

// Step 2: Sweep of a session swing level (last 12 5m bars)
function detectSweep(candles5m) {
  const { levels } = buildPreKZLevels(candles5m);
  if (!levels.length) return { detected: false };

  const results = [];
  for (let back = 0; back <= 12; back++) {
    const idx = candles5m.length - 1 - back;
    if (idx < 0) break;
    const c = candles5m[idx];
    for (const lvl of levels) {
      if (lvl.type === 'BSL' && c.high > lvl.price && c.close < lvl.price)
        results.push({ dir: 'bear', level: lvl.price, levelName: lvl.name,
                       barsAgo: back, wick: c.high, sweepCandleIdx: idx, sweepCandleTime: c.time });
      if (lvl.type === 'SSL' && c.low < lvl.price && c.close > lvl.price)
        results.push({ dir: 'bull', level: lvl.price, levelName: lvl.name,
                       barsAgo: back, wick: c.low, sweepCandleIdx: idx, sweepCandleTime: c.time });
    }
  }
  if (!results.length) return { detected: false };
  results.sort((a, b) => a.barsAgo - b.barsAgo);
  return { detected: true, ...results[0] };
}

// Step 3: MSS on 5m (approximation of 1m for full-year backtest)
// Looks for a clear swing-point break with a displacement candle after the sweep.
function detectMSS5m(candles5m, sweepDir, sweepCandleTime) {
  const DISP_BODY_RATIO = 0.5; // 50% body/range — displacement candle
  const MIN_SWING_BARS  = 1;   // 1-bar pivot is sufficient on 5m

  const sweepTs = new Date(sweepCandleTime).getTime();
  const post    = candles5m.filter(c => new Date(c.time).getTime() > sweepTs).slice(0, 30);

  if (post.length < 5) return { confirmed: false };

  if (sweepDir === 'bear') {
    for (let i = MIN_SWING_BARS; i < post.length - MIN_SWING_BARS; i++) {
      if (post[i].low >= post[i-1].low || post[i].low >= post[i+1].low) continue;
      const swingLevel = post[i].low;
      for (let j = i + 1; j < post.length; j++) {
        const c    = post[j];
        if (c.close >= swingLevel) continue;
        const body  = c.open - c.close;
        const range = c.high - c.low;
        if (range > 0 && body / range >= DISP_BODY_RATIO)
          return { confirmed: true, type: 'MSS_BEAR', swingLevel,
                   swingTime: post[i].time, dispCandleIdx: j, dispCandle: c, mssTime: c.time };
      }
    }
  }

  if (sweepDir === 'bull') {
    for (let i = MIN_SWING_BARS; i < post.length - MIN_SWING_BARS; i++) {
      if (post[i].high <= post[i-1].high || post[i].high <= post[i+1].high) continue;
      const swingLevel = post[i].high;
      for (let j = i + 1; j < post.length; j++) {
        const c    = post[j];
        if (c.close <= swingLevel) continue;
        const body  = c.close - c.open;
        const range = c.high - c.low;
        if (range > 0 && body / range >= DISP_BODY_RATIO)
          return { confirmed: true, type: 'MSS_BULL', swingLevel,
                   swingTime: post[i].time, dispCandleIdx: j, dispCandle: c, mssTime: c.time };
      }
    }
  }

  return { confirmed: false };
}

// Step 4: FVG in the 5m displacement window (approximation of 1m FVG)
// No confirmation wick — just find the zone and set limit at its boundary.
function detectFVG5m(candles5m, sweepDir, sweepCandleTime, mss) {
  if (!mss.confirmed) return { found: false };

  const sweepTs = new Date(sweepCandleTime).getTime();
  const post    = candles5m.filter(c => new Date(c.time).getTime() > sweepTs).slice(0, 30);

  const di    = mss.dispCandleIdx;
  const start = Math.max(0, di - 3);
  const end   = Math.min(post.length - 1, di + 3);

  const candidates = [];
  for (let i = start; i <= end - 2; i++) {
    const c0 = post[i], c2 = post[i + 2];
    if (!c0 || !c2) continue;
    if (sweepDir === 'bear' && c2.high < c0.low) {
      const size = c0.low - c2.high;
      if (size > 0) candidates.push({ top: c0.low, bottom: c2.high, size, zoneFormedAt: c2.time });
    }
    if (sweepDir === 'bull' && c2.low > c0.high) {
      const size = c2.low - c0.high;
      if (size > 0) candidates.push({ top: c2.low, bottom: c0.high, size, zoneFormedAt: c2.time });
    }
  }

  if (!candidates.length) return { found: false };
  const best = candidates.sort((a, b) => b.size - a.size)[0];

  // Limit order at FVG boundary:
  // Bull → limit BUY at top of FVG (price retraces down into gap)
  // Bear → limit SELL at bottom of FVG (price retraces up into gap)
  const entryPrice = sweepDir === 'bull' ? best.top : best.bottom;

  return { found: true, top: best.top, bottom: best.bottom, size: best.size,
           entryPrice, entryZone: `${best.bottom.toFixed(2)}–${best.top.toFixed(2)}`,
           zoneFormedAt: best.zoneFormedAt, inFVG: true };
}

// Step 5: Simulate limit fill on 5m — find first candle that touches the limit price
function findLimitFill5m(period5m, fvg, sweepDir, fromTime, dayEnd) {
  const fromTs = new Date(fromTime).getTime();
  const endTs  = new Date(dayEnd).getTime();
  for (const c of period5m) {
    const t = new Date(c.time).getTime();
    if (t <= fromTs) continue;
    if (t > endTs)   break;
    if (sweepDir === 'bull' && c.low  <= fvg.entryPrice) return { price: fvg.entryPrice, time: c.time };
    if (sweepDir === 'bear' && c.high >= fvg.entryPrice) return { price: fvg.entryPrice, time: c.time };
  }
  return null; // limit never triggered same day
}

// Step 6 & 7: Opposing pre-KZ liquidity for TPs
function opposingLiquidityTPs(dir, entry, risk, candles5m, nowIso, h1Candles) {
  const isLong = dir === 'bull';
  const { levels } = buildPreKZLevels(candles5m);

  const opposing = levels
    .filter(l => isLong
      ? l.type === 'BSL' && l.price > entry + risk * 1.0
      : l.type === 'SSL' && l.price < entry - risk * 1.0)
    .sort((a, b) => isLong ? a.price - b.price : b.price - a.price);

  const h1w = (h1Candles || []).slice(-24);
  const h1t = [];
  for (let i = 2; i < h1w.length - 2; i++) {
    const c = h1w[i];
    if (isLong && c.high > h1w[i-1].high && c.high > h1w[i-2].high && c.high > h1w[i+1].high)
      h1t.push({ price: c.high, name: '1H swing high' });
    if (!isLong && c.low < h1w[i-1].low && c.low < h1w[i-2].low && c.low < h1w[i+1].low)
      h1t.push({ price: c.low, name: '1H swing low' });
  }

  const fallback = r => isLong ? entry + risk * r : entry - risk * r;
  const pool = [...opposing, ...h1t];

  const tp1cands = pool.filter(t => isLong ? t.price >= fallback(TP1_R) : t.price <= fallback(TP1_R))
    .sort((a,b) => isLong ? a.price-b.price : b.price-a.price);
  const tp2cands = pool.filter(t => isLong ? t.price >= fallback(TP2_R) : t.price <= fallback(TP2_R))
    .sort((a,b) => isLong ? a.price-b.price : b.price-a.price);
  const tp3cands = pool.filter(t => isLong ? t.price >= fallback(TP3_R) : t.price <= fallback(TP3_R))
    .sort((a,b) => isLong ? a.price-b.price : b.price-a.price);

  const tp1 = tp1cands[0] || { price: fallback(TP1_R), name: `Fixed ${TP1_R}R` };
  const tp2 = tp2cands[0] || { price: fallback(TP2_R), name: `Fixed ${TP2_R}R` };
  const tp3 = tp3cands[0] || { price: fallback(TP3_R), name: `Fixed ${TP3_R}R` };

  return { tp1: tp1.price, tp1Desc: tp1.name||tp1.desc,
           tp2: tp2.price, tp2Desc: tp2.name||tp2.desc,
           tp3: tp3.price, tp3Desc: tp3.name||tp3.desc };
}

function scoreConf(sweep, mss, fvg) {
  let score = 25; const tags = ['KZ'];
  if (sweep.detected) { score += 25; tags.push('SWEEP'); }
  if (mss.confirmed)  { score += 25; tags.push('MSS'); }
  if (fvg.found)      { score += 25; tags.push('FVG'); }
  const grade = score >= 100 ? 'A+' : score >= 75 ? 'A' : 'B';
  return { score: Math.min(score, 100), grade };
}

// ─── Same-day outcome simulation ──────────────────────────────────────────────
function simulateOutcomeSameDay(dir, entry, sl, tp1, tp2, tp3, risk, futureCandles) {
  const isLong = dir === 'bull';
  let tp1Hit = false, currentSL = sl, lastClose = entry, lastTime = null;

  for (const c of futureCandles) {
    lastClose = c.close;
    lastTime  = c.time;
    const slHit   = isLong ? c.low  <= currentSL : c.high >= currentSL;
    const tp1Hit_ = isLong ? c.high >= tp1       : c.low  <= tp1;
    const tp2Hit  = isLong ? c.high >= tp2       : c.low  <= tp2;
    const tp3Hit  = isLong ? c.high >= tp3       : c.low  <= tp3;

    if (!tp1Hit) {
      if (slHit)   return { result: 'LOSS',    pnlR: -1, closeTime: c.time };
      if (tp3Hit)  return { result: 'WIN_TP3', pnlR: +(0.5*TP1_R + 0.25*TP2_R + 0.25*TP3_R).toFixed(2), closeTime: c.time };
      if (tp2Hit)  return { result: 'WIN_TP2', pnlR: +(0.5*TP1_R + 0.5*TP2_R).toFixed(2), closeTime: c.time };
      if (tp1Hit_) { tp1Hit = true; currentSL = entry; }
    } else {
      if (slHit)   return { result: 'WIN_BE',  pnlR: +(0.5*TP1_R).toFixed(2), closeTime: c.time };
      if (tp3Hit)  return { result: 'WIN_TP3', pnlR: +(0.5*TP1_R + 0.25*TP2_R + 0.25*TP3_R).toFixed(2), closeTime: c.time };
      if (tp2Hit)  return { result: 'WIN_TP2', pnlR: +(0.5*TP1_R + 0.5*TP2_R).toFixed(2), closeTime: c.time };
    }
  }

  const rAtClose = ((lastClose - entry) / risk) * (isLong ? 1 : -1);
  if (tp1Hit) {
    return { result: 'EOD_PARTIAL', pnlR: +(0.5*TP1_R + 0.5*Math.max(rAtClose, TP1_R)).toFixed(2), closeTime: lastTime };
  }
  const clamped = Math.max(rAtClose, -1);
  return { result: clamped >= 0 ? 'EOD_WIN' : 'EOD_LOSS', pnlR: +clamped.toFixed(2), closeTime: lastTime };
}

function isKillZone(iso) {
  const t = new Date(iso), h = t.getUTCHours(), m = t.getUTCMinutes();
  return h * 60 + m >= 13*60+30 && h * 60 + m < 16*60;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
function run() {
  console.clear();
  console.log('\n' + chalk.bold.white('  ■ DJ30 ICT — VIDEO CHECKLIST BACKTEST'));
  console.log(chalk.gray('  Period: Jun 2025 → Jun 2026'));
  console.log(chalk.gray('  Strategy: Pre-KZ sweep → 5m MSS+disp → FVG limit order → opposing liquidity TP'));
  console.log(chalk.gray('  £2,000 start | 2% risk | compounded | force-close 21:00 UTC\n'));

  const all5m = loadCached('5min', 2025, 5, 2026, 6);
  const allH1 = loadCached('1h',   2025, 5, 2026, 6);

  if (!all5m.length) { console.log(chalk.red('  ✗ No 5m data.')); process.exit(1); }

  const START    = new Date('2025-06-01T00:00:00Z');
  const END      = new Date('2026-06-16T23:59:59Z');
  const period5m = all5m.filter(c => { const t = new Date(c.time); return t >= START && t <= END; });

  console.log(chalk.gray(`  5m bars loaded:  ${all5m.length.toLocaleString()}`));
  console.log(chalk.gray(`  1h bars loaded:  ${allH1.length.toLocaleString()}`));
  console.log(chalk.gray(`  5m in period:    ${period5m.length.toLocaleString()}\n`));

  const signals = [];
  let lastBar = -999, balance = ACCOUNT_START, peak = ACCOUNT_START, maxDD = 0;

  for (let i = 60; i < period5m.length - 1; i++) {
    const bar = period5m[i];
    if (i - lastBar < COOLDOWN) continue;
    if (!isKillZone(bar.time))  continue;

    const time    = new Date(bar.time);
    const slice5m = all5m.filter(c => new Date(c.time) <= time);
    const sliceH1 = allH1.filter(c => new Date(c.time) <= time);
    if (slice5m.length < 40 || sliceH1.length < 6) continue;

    const nowIso = bar.time;
    let sweep, mss, fvg, conf;
    try {
      sweep = detectSweep(slice5m);
      mss   = sweep.detected ? detectMSS5m(slice5m, sweep.dir, sweep.sweepCandleTime) : { confirmed: false };
      fvg   = (sweep.detected && mss.confirmed) ? detectFVG5m(slice5m, sweep.dir, sweep.sweepCandleTime, mss) : { found: false };
      conf  = scoreConf(sweep, mss, fvg);
    } catch (e) { continue; }

    if (!sweep.detected || !mss.confirmed || !fvg.found || conf.score < MIN_SCORE) continue;

    const isLong = sweep.dir === 'bull';
    const dayEnd = new Date(Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate(), DAY_END_HOUR, 0, 0));

    // Wait for limit fill — price must retrace to FVG boundary on a future 5m candle
    const fill = findLimitFill5m(period5m, fvg, sweep.dir, fvg.zoneFormedAt, dayEnd);
    if (!fill) continue; // limit order never triggered same day

    const entry = fill.price;

    // SL at 1m MSS swing point (approximated here as 5m swing, 0.03% buffer)
    const slBuffer = mss.swingLevel * 0.0003;
    const sl = isLong ? mss.swingLevel - slBuffer : mss.swingLevel + slBuffer;

    if (isLong  && sl >= entry) continue;
    if (!isLong && sl <= entry) continue;

    const risk = Math.abs(entry - sl);
    if (risk < MIN_RISK_PTS || risk > entry * 0.02) continue;

    const { tp1, tp1Desc, tp2, tp2Desc, tp3, tp3Desc } =
      opposingLiquidityTPs(sweep.dir, entry, risk, slice5m, nowIso, sliceH1);

    const future = period5m.filter(c => {
      const t = new Date(c.time).getTime();
      return t > new Date(fill.time).getTime() && t <= dayEnd.getTime();
    });

    const outcome  = simulateOutcomeSameDay(sweep.dir, entry, sl, tp1, tp2, tp3, risk, future);
    const riskGBP  = balance * RISK_PCT;
    const pnlGBP   = outcome.pnlR != null ? outcome.pnlR * riskGBP : null;

    if (pnlGBP !== null) {
      balance += pnlGBP;
      if (balance > peak) peak = balance;
      const dd = (peak - balance) / peak * 100;
      if (dd > maxDD) maxDD = dd;
    }

    signals.push({
      time: bar.time, fillTime: fill.time, dir: isLong ? 'BUY' : 'SELL',
      entry: +entry.toFixed(2), sl: +sl.toFixed(2),
      tp1: +tp1.toFixed(2), tp2: +tp2.toFixed(2), tp3: +tp3.toFixed(2),
      tp1Desc, tp2Desc, tp3Desc,
      riskPts: +risk.toFixed(2), score: conf.score, grade: conf.grade,
      sweep: sweep.levelName, mssType: mss.type, mssSwing: +mss.swingLevel.toFixed(2),
      fvgTop: +fvg.top.toFixed(2), fvgBottom: +fvg.bottom.toFixed(2),
      riskGBP: +riskGBP.toFixed(2),
      pnlGBP:  pnlGBP !== null ? +pnlGBP.toFixed(2) : null,
      balanceAfter: pnlGBP !== null ? +balance.toFixed(2) : null,
      ...outcome
    });

    lastBar = i;
  }

  // ─── Results ──────────────────────────────────────────────────────────────
  const sep    = '═'.repeat(72);
  const closed = signals.filter(s => s.pnlR !== null);
  const wins   = closed.filter(s => s.pnlR > 0);
  const losses = closed.filter(s => s.pnlR < 0);
  const totalR = +closed.reduce((s, x) => s + x.pnlR, 0).toFixed(2);
  const totalP = +closed.reduce((s, x) => s + (x.pnlGBP||0), 0).toFixed(2);
  const wr     = closed.length ? Math.round(wins.length / closed.length * 100) : 0;
  const pf     = losses.length
    ? +(wins.reduce((s,x)=>s+x.pnlR,0) / Math.abs(losses.reduce((s,x)=>s+x.pnlR,0))).toFixed(2)
    : wins.length ? '∞' : 0;

  console.log(sep);
  console.log(chalk.bold('  ■ SAME-DAY EXIT RESULTS — VIDEO CHECKLIST'));
  console.log(sep);
  console.log(`  Trades:      ${closed.length}`);
  console.log(`  Wins:        ${wins.length}`);
  console.log(`  Losses:      ${losses.length}`);
  console.log(`  Win rate:    ${chalk.bold(wr + '%')}`);
  console.log(`  Net R:       ${totalR >= 0 ? chalk.green('+'+totalR+'R') : chalk.red(totalR+'R')}`);
  console.log(`  Prof. factor: ${pf}`);
  console.log();
  console.log('  ── ACCOUNT (£' + ACCOUNT_START.toLocaleString() + ' start · 2% risk · compounded) ──');
  console.log(`  Start:       £${ACCOUNT_START.toFixed(2)}`);
  console.log(`  End:         £${balance.toFixed(2)}`);
  console.log(`  Net P&L:     ${totalP >= 0 ? chalk.green('+£'+totalP.toFixed(2)) : chalk.red('−£'+Math.abs(totalP).toFixed(2))}`);
  console.log(`  Return:      ${((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)}%`);
  console.log(`  Peak bal:    £${peak.toFixed(2)}`);
  console.log(`  Max drawdown: ${maxDD.toFixed(1)}%`);
  console.log();

  const types = {};
  closed.forEach(s => { types[s.result] = (types[s.result]||0)+1; });
  console.log('  Result types:');
  Object.entries(types).sort((a,b)=>b[1]-a[1]).forEach(([r,n]) =>
    console.log(`    ${r.padEnd(16)}${n} trades  (${Math.round(n/closed.length*100)}%)`));
  console.log();

  const rpts = closed.map(s => s.riskPts);
  console.log('  Risk distance (pts):');
  console.log(`    min: ${Math.min(...rpts).toFixed(0)}  median: ${rpts.sort((a,b)=>a-b)[Math.floor(rpts.length/2)].toFixed(0)}  mean: ${(rpts.reduce((a,v)=>a+v,0)/rpts.length).toFixed(0)}  max: ${Math.max(...rpts).toFixed(0)}`);
  console.log('\n' + sep + '\n');

  fs.writeFileSync(
    path.join(__dirname, '..', 'backtest_report_sameday_dj30.json'),
    JSON.stringify({
      period: 'Jun 2025 → Jun 2026 (video checklist, same-day exit, force-close 21:00 UTC)',
      strategy: 'Pre-KZ sweep → 5m MSS+displacement → FVG limit order → opposing liquidity TP',
      generatedAt: new Date().toISOString(),
      settings: { symbol:'DJ30/DIA', start:ACCOUNT_START, riskPct:RISK_PCT*100,
                  minScore:MIN_SCORE, killZone:'13:30-16:00 UTC', forceCloseHour:DAY_END_HOUR,
                  note:'5m approximation of 1m MSS+FVG (full 1m history not available for full year)' },
      account: { start: ACCOUNT_START, end: +balance.toFixed(2), netGBP: +totalP.toFixed(2),
                 returnPct: +((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1),
                 maxDD: +maxDD.toFixed(1), peak: +peak.toFixed(2) },
      stats: { trades:closed.length, wins:wins.length, losses:losses.length, wr:wr+'%', netR:totalR, pf },
      signals
    }, null, 2)
  );
  console.log(chalk.gray('  Report → backtest_report_sameday_dj30.json\n'));
}

run();
