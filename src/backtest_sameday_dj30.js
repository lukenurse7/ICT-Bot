'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  DJ30 ICT — SAME-DAY EXIT BACKTEST  (Jun 2025 → Jun 2026)
//  Matches the CURRENT live engine exactly:
//   - Kill zone: 13:30–16:00 UTC
//   - SL: swing high/low of last 5 candles (matches src/ict.js)
//   - TP2 ≥2.5R, TP3 ≥3.5R (liquidity-based, fallback to fixed)
//   - Every trade is FORCE-CLOSED at 21:00 UTC same day if not resolved —
//     no overnight holds, ever.
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const ACCOUNT_START = parseFloat(process.env.ACCOUNT_START || '2000');
const RISK_PCT      = 0.02;
const TP1_R         = 1.5;
const TP2_R         = parseFloat(process.env.TP2_R || '2.5');
const TP3_R         = parseFloat(process.env.TP3_R || '3.5');
const MIN_SCORE     = parseFloat(process.env.MIN_SCORE || '80');
const COOLDOWN      = 36;        // 3h in 5m bars
const DAY_END_HOUR  = 21;        // force-close at 21:00 UTC (NYSE close window)

const CACHE = path.join(__dirname, '..', '.cache');
const PRICE_SCALE = parseFloat(process.env.DJ30_PRICE_SCALE) || 99.7724;

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
    .map(c => ({
      time:   c.time,
      open:   c.open  * PRICE_SCALE,
      high:   c.high  * PRICE_SCALE,
      low:    c.low   * PRICE_SCALE,
      close:  c.close * PRICE_SCALE,
      volume: c.volume || 0
    }));
}

// Loads the single-file 1m cache (TwelveData caps 1min outputsize at 5000 bars
// per request, so this only covers a ~3-week window, not the full backtest period).
function load1mCache() {
  const files = fs.existsSync(CACHE)
    ? fs.readdirSync(CACHE).filter(f => f.startsWith('dj30_1min_'))
    : [];
  const all = [];
  for (const f of files) all.push(...JSON.parse(fs.readFileSync(path.join(CACHE, f))));
  const seen = new Set();
  return all
    .filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
    .sort((a, b) => new Date(a.time) - new Date(b.time))
    .map(c => ({
      time: c.time,
      open:  c.open  * PRICE_SCALE,
      high:  c.high  * PRICE_SCALE,
      low:   c.low   * PRICE_SCALE,
      close: c.close * PRICE_SCALE,
      volume: c.volume || 0
    }));
}

function rollup(src, factor) {
  const out = [];
  for (let i = 0; i < src.length; i += factor) {
    const s = src.slice(i, i + factor);
    if (!s.length) continue;
    out.push({ time: s[0].time, open: s[0].open,
      high: Math.max(...s.map(c => c.high)),
      low:  Math.min(...s.map(c => c.low)),
      close: s[s.length-1].close,
      volume: s.reduce((a, c) => a + (c.volume||0), 0) });
  }
  return out;
}

// ─── ICT engine (identical logic to live src/ict.js) ──────────────────────────

function detectSweep(candles15m, candles5m) {
  const LOOKBACK = 100;
  const recent5  = candles5m.slice(-LOOKBACK);
  const last5    = candles5m[candles5m.length - 1];
  const levels   = [];

  for (let i = 2; i < recent5.length - 1; i++) {
    const c = recent5[i];
    const prev = recent5.slice(Math.max(0, i-10), i);
    const eqH = prev.find(p => Math.abs(p.high - c.high) / c.high < 0.0005);
    if (eqH) levels.push({ price: Math.max(c.high, eqH.high), type: 'BSL', name: 'Equal Highs (BSL)' });
    const eqL = prev.find(p => Math.abs(p.low - c.low) / c.low < 0.0005);
    if (eqL) levels.push({ price: Math.min(c.low, eqL.low), type: 'SSL', name: 'Equal Lows (SSL)' });
  }

  const yesterday = candles5m.slice(-300).filter(c => {
    const h = new Date(c.time).getUTCHours(); return h >= 21 || h < 2;
  });
  if (yesterday.length) {
    levels.push({ price: Math.max(...yesterday.map(c => c.high)), type: 'BSL', name: 'Prev Day High' });
    levels.push({ price: Math.min(...yesterday.map(c => c.low)),  type: 'SSL', name: 'Prev Day Low' });
  }

  const results = [];
  for (const lvl of levels) {
    if (lvl.type === 'BSL' && last5.high > lvl.price && last5.close < lvl.price)
      results.push({ dir: 'bear', level: lvl.price, levelName: lvl.name, barsAgo: 0, wick: last5.high });
    if (lvl.type === 'SSL' && last5.low < lvl.price && last5.close > lvl.price)
      results.push({ dir: 'bull', level: lvl.price, levelName: lvl.name, barsAgo: 0, wick: last5.low });
  }

  for (let back = 1; back <= 12; back++) {
    const idx = candles5m.length - 1 - back;
    if (idx < 0) break;
    const c = candles5m[idx];
    for (const lvl of levels) {
      if (lvl.type === 'BSL' && c.high > lvl.price && c.close < lvl.price)
        results.push({ dir: 'bear', level: lvl.price, levelName: lvl.name, barsAgo: back, wick: c.high });
      if (lvl.type === 'SSL' && c.low < lvl.price && c.close > lvl.price)
        results.push({ dir: 'bull', level: lvl.price, levelName: lvl.name, barsAgo: back, wick: c.low });
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
    const wickedIn   = prev.high >= best.bottom;
    const closedBack = prev.close <= best.top;
    confirmed = wickedIn && closedBack && (prev.high - best.bottom) >= best.size * 0.5;
  } else {
    const wickedIn   = prev.low <= best.top;
    const closedBack = prev.close >= best.bottom;
    confirmed = wickedIn && closedBack && (best.top - prev.low) >= best.size * 0.5;
  }

  return { found: true, top: best.top, bottom: best.bottom, size: best.size, inFVG: confirmed, zoneFormedAt: prev.time };
}

// 1m entry trigger: first 1m candle (after the zone exists) that wicks into the
// FVG zone and closes back out — the true, immediately-actionable fill, instead of
// waiting for the whole 5m candle to close (which is often already stale by then).
function findEntryTrigger1m(candles1m, fvg, sweepDir, notAfter) {
  if (!fvg.found || !fvg.zoneFormedAt || !candles1m || !candles1m.length) return null;
  const zoneStart = new Date(fvg.zoneFormedAt).getTime();
  const cutoff    = notAfter ? new Date(notAfter).getTime() : Infinity;
  for (const c of candles1m) {
    const t = new Date(c.time).getTime();
    if (t <= zoneStart) continue;
    if (t > cutoff) break;
    if (sweepDir === 'bear') {
      if (c.high >= fvg.bottom && c.close <= fvg.top) return { price: c.close, time: c.time };
    } else {
      if (c.low <= fvg.top && c.close >= fvg.bottom) return { price: c.close, time: c.time };
    }
  }
  return null;
}

// TP logic — identical to live src/ict.js: TP2 >= 2.5R, TP3 >= 3.5R
function liquidityTPs(dir, entry, risk, candles5m, h1Candles) {
  const isLong  = dir === 'bull';
  const minTP2  = isLong ? entry + risk * TP2_R : entry - risk * TP2_R;
  const minTP3  = isLong ? entry + risk * TP3_R : entry - risk * TP3_R;
  const maxR    = 5.0;
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

  const tp2candidates = candidates
    .filter(t => isLong ? t.price >= minTP2 && t.price < entry + risk * maxR
                        : t.price <= minTP2 && t.price > entry - risk * maxR)
    .sort((a, b) => isLong ? a.price - b.price : b.price - a.price);
  const tp3candidates = candidates
    .filter(t => isLong ? t.price >= minTP3 && t.price < entry + risk * maxR
                        : t.price <= minTP3 && t.price > entry - risk * maxR)
    .sort((a, b) => isLong ? a.price - b.price : b.price - a.price);

  const tp2obj = tp2candidates[0] || { price: isLong ? entry + risk*TP2_R : entry - risk*TP2_R, desc: `Fixed ${TP2_R}R` };
  const tp3obj = tp3candidates[0] || { price: isLong ? entry + risk*TP3_R : entry - risk*TP3_R, desc: `Fixed ${TP3_R}R` };
  return { tp2: tp2obj.price, tp2Desc: tp2obj.desc, tp3: tp3obj.price, tp3Desc: tp3obj.desc };
}

function scoreConf(sweep, mss, fvg) {
  let score = 25;
  if (sweep.detected) score += 25;
  if (mss.confirmed)  score += 25;
  if (fvg.found)       score += 15;
  if (fvg.inFVG)        score += 10;
  const grade = score >= 90 ? 'A+' : score >= 80 ? 'A' : score >= 70 ? 'B' : 'C';
  return { score: Math.min(score, 100), grade };
}

// ─── Same-day-only outcome simulation ──────────────────────────────────────────
// Trade is force-closed at 21:00 UTC same calendar day if neither TP nor SL hit.
function simulateOutcomeSameDay(dir, entry, sl, tp1, tp2, tp3, risk, futureCandles) {
  const isLong = dir === 'bull';
  let tp1Hit = false, currentSL = sl, lastClose = entry, lastTime = null;

  for (const c of futureCandles) {
    lastClose = c.close;
    lastTime  = c.time;
    const slHit   = isLong ? c.low <= currentSL : c.high >= currentSL;
    const tp1Hit_ = isLong ? c.high >= tp1 : c.low <= tp1;
    const tp2Hit  = isLong ? c.high >= tp2 : c.low <= tp2;
    const tp3Hit  = isLong ? c.high >= tp3 : c.low <= tp3;

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

  // Day ended — force close at last available price
  const rAtClose = ((lastClose - entry) / risk) * (isLong ? 1 : -1);
  if (tp1Hit) {
    // 50% locked at TP1 already; remaining 50% closes at whatever R it's at (floor TP1_R since SL is at BE)
    const runnerR = Math.max(rAtClose, TP1_R);
    return { result: 'EOD_PARTIAL', pnlR: +(0.5*TP1_R + 0.5*runnerR).toFixed(2), closeTime: lastTime };
  }
  // Full position still open, force close at day-end price
  const clamped = Math.max(rAtClose, -1);
  return { result: clamped >= 0 ? 'EOD_WIN' : 'EOD_LOSS', pnlR: +clamped.toFixed(2), closeTime: lastTime };
}

function isKillZone(iso) {
  const h = new Date(iso).getUTCHours();
  const m = new Date(iso).getUTCMinutes();
  const totalMins = h * 60 + m;
  return totalMins >= (13*60+30) && totalMins < 16*60;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
function run() {
  console.clear();
  console.log('\n' + chalk.bold.white('  ■ DJ30 ICT — SAME-DAY EXIT BACKTEST'));
  console.log(chalk.gray('  Period: Jun 2025 → Jun 2026'));
  console.log(chalk.gray('  £2,000 start | 2% risk per trade | fully compounded'));
  console.log(chalk.gray('  Kill Zone: 13:30–16:00 UTC | Force-close 21:00 UTC same day | 80% min score\n'));

  const all5m = loadCached('5min', 2025, 5, 2026, 6);
  const allH1 = loadCached('1h',  2025, 5, 2026, 6);
  const ENTRY_MODE = process.env.ENTRY_MODE || 'close'; // 'close' = legacy chase, 'wick' = FVG candle close, '1m' = real 1m entry trigger
  const all1m = ENTRY_MODE === '1m' ? load1mCache() : [];

  if (!all5m.length) {
    console.log(chalk.red('  ✗ No 5m data found.'));
    process.exit(1);
  }
  if (ENTRY_MODE === '1m' && !all1m.length) {
    console.log(chalk.red('  ✗ No 1m data found (run the 1m cache fetch first).'));
    process.exit(1);
  }

  const all15m = rollup(all5m, 3);

  let START = new Date('2025-06-01T00:00:00Z');
  let END   = new Date('2026-06-05T23:59:59Z');
  if (ENTRY_MODE === '1m') {
    // Real 1m data only covers the cached ~3-week window — restrict the backtest to it.
    START = new Date(all1m[0].time);
    END   = new Date(all1m[all1m.length - 1].time);
  }
  const period5m = all5m.filter(c => { const t = new Date(c.time); return t >= START && t <= END; });

  console.log(chalk.gray(`  5m bars loaded:  ${all5m.length.toLocaleString()}`));
  console.log(chalk.gray(`  1h bars loaded:  ${allH1.length.toLocaleString()}`));
  console.log(chalk.gray(`  5m in period:    ${period5m.length.toLocaleString()}\n`));

  const signals = [];
  let lastBar = -999, balance = ACCOUNT_START, peak = ACCOUNT_START, maxDD = 0;

  for (let i = 60; i < period5m.length - 1; i++) {
    const bar = period5m[i];
    if (i - lastBar < COOLDOWN) continue;
    if (!isKillZone(bar.time)) continue;

    const time = new Date(bar.time);
    const slice5m  = all5m.filter(c  => new Date(c.time) <= time);
    const slice15m = all15m.filter(c => new Date(c.time) <= time);
    const sliceH1  = allH1.filter(c  => new Date(c.time) <= time);

    if (slice5m.length < 40 || sliceH1.length < 6) continue;

    let sweep, mss, fvg, conf;
    try {
      sweep = detectSweep(slice15m, slice5m);
      mss   = sweep.detected ? detectMSS(slice5m, sweep.dir) : { confirmed: false };
      fvg   = (sweep.detected && mss.confirmed) ? detectFVG(slice5m, sweep.dir) : { found: false };
      conf  = sweep.dir ? scoreConf(sweep, mss, fvg) : { score: 0, grade: 'D' };
    } catch (e) { continue; }

    const dir = sweep.dir;
    if (!dir || !mss.confirmed || !fvg.inFVG || conf.score < MIN_SCORE) continue;

    const isLong = dir === 'bull';

    let entry, entryTriggerTime = bar.time;
    if (ENTRY_MODE === '1m') {
      // Day-end cutoff so we never "find" a trigger from the next trading day
      const dayEndCutoff = new Date(Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate(), DAY_END_HOUR, 0, 0));
      const trigger = findEntryTrigger1m(all1m, fvg, dir, dayEndCutoff);
      if (!trigger) continue; // zone never actually got retraced into on the 1m chart — no real fill
      entry = trigger.price;
      entryTriggerTime = trigger.time;
    } else if (ENTRY_MODE === 'wick') {
      entry = slice5m[slice5m.length - 2].close; // the candle that wicked into the FVG and closed back — true ICT entry, no extra lag candle
    } else {
      entry = bar.close; // legacy: wait one more candle (matches old live src/ict.js)
    }

    // SL: anchored to the actual liquidity-sweep wick (ICT invalidation point) when SL_MODE=wick,
    // else legacy swing high/low of last N candles (N tunable via SL_LOOKBACK)
    const SL_MODE = process.env.SL_MODE || 'swing';
    let sl;
    if (SL_MODE === 'wick' && sweep.wick != null) {
      sl = isLong ? sweep.wick - sweep.wick*0.0005 : sweep.wick + sweep.wick*0.0005;
    } else {
      const SL_LOOKBACK = parseInt(process.env.SL_LOOKBACK || '5', 10);
      const recent5   = slice5m.slice(-SL_LOOKBACK);
      const swingHigh = Math.max(...recent5.map(c => c.high));
      const swingLow  = Math.min(...recent5.map(c => c.low));
      sl = isLong ? swingLow - swingLow*0.0005 : swingHigh + swingHigh*0.0005;
    }

    if (isLong  && sl >= entry) continue;
    if (!isLong && sl <= entry) continue;

    const risk = Math.abs(entry - sl);
    const MIN_RISK_PTS = parseFloat(process.env.MIN_RISK_PTS || '0');
    if (risk <= 0 || risk > entry * 0.02 || risk < MIN_RISK_PTS) continue;

    const tp1 = isLong ? entry + risk * TP1_R : entry - risk * TP1_R;
    const { tp2, tp2Desc, tp3, tp3Desc } = liquidityTPs(dir, entry, risk, slice5m, sliceH1);

    // Force-close window: same UTC calendar day, up to 21:00 UTC
    const dayEnd = new Date(Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate(), DAY_END_HOUR, 0, 0));
    const entryTime = new Date(entryTriggerTime);
    const future = period5m.filter(c => { const t = new Date(c.time); return t > entryTime && t <= dayEnd; });

    const outcome = simulateOutcomeSameDay(dir, entry, sl, tp1, tp2, tp3, risk, future);

    const riskGBP = balance * RISK_PCT;
    const pnlGBP  = outcome.pnlR != null ? outcome.pnlR * riskGBP : null;

    if (pnlGBP !== null) {
      balance += pnlGBP;
      if (balance > peak) peak = balance;
      const dd = (peak - balance) / peak * 100;
      if (dd > maxDD) maxDD = dd;
    }

    signals.push({
      time: bar.time, entryTriggerTime, dir: isLong ? 'BUY' : 'SELL',
      entry: +entry.toFixed(2), sl: +sl.toFixed(2),
      tp1: +tp1.toFixed(2), tp2: +tp2.toFixed(2), tp3: +tp3.toFixed(2),
      riskPts: +risk.toFixed(2),
      score: conf.score, grade: conf.grade,
      sweep: sweep.levelName, mssType: mss.type,
      tp2Desc, tp3Desc,
      riskGBP: +riskGBP.toFixed(2),
      pnlGBP: pnlGBP !== null ? +pnlGBP.toFixed(2) : null,
      balanceAfter: pnlGBP !== null ? +balance.toFixed(2) : null,
      ...outcome
    });

    lastBar = i;
  }

  // ─── Results ─────────────────────────────────────────────────────────────
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
  console.log(chalk.bold.white('  ■ SAME-DAY EXIT RESULTS — DJ30'));
  console.log(sep);
  console.log(chalk.gray('  Trades:      ') + chalk.bold.white(closed.length));
  console.log(chalk.gray('  Wins:        ') + chalk.green(wins.length));
  console.log(chalk.gray('  Losses:      ') + chalk.red(losses.length));
  console.log(chalk.gray('  Win rate:    ') + (wr>=70?chalk.bold.green:wr>=50?chalk.yellow:chalk.red)(wr+'%'));
  console.log(chalk.gray('  Net R:       ') + (totalR>=0?chalk.green(`+${totalR}R`):chalk.red(`${totalR}R`)));
  console.log(chalk.gray('  Prof. factor:') + chalk.cyan(' '+pf));

  console.log('\n' + chalk.bold.white('  ── ACCOUNT (£2,000 start · 2% risk · compounded) ──'));
  console.log(chalk.gray('  Start:       ') + chalk.white('£2,000.00'));
  console.log(chalk.gray('  End:         ') + (balance>=ACCOUNT_START?chalk.bold.green:chalk.red)('£'+balance.toFixed(2)));
  console.log(chalk.gray('  Net P&L:     ') + (totalP>=0?chalk.green('+£'+totalP.toFixed(2)):chalk.red('£'+totalP.toFixed(2))));
  console.log(chalk.gray('  Return:      ') + (balance>=ACCOUNT_START?chalk.bold.green:chalk.red)(((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)+'%'));
  console.log(chalk.gray('  Peak bal:    ') + chalk.white('£'+peak.toFixed(2)));
  console.log(chalk.gray('  Max drawdown:') + chalk.yellow(' '+maxDD.toFixed(1)+'%'));

  console.log(chalk.gray('\n  Result types:'));
  const byResult = {};
  closed.forEach(s => { byResult[s.result] = (byResult[s.result]||0) + 1; });
  Object.entries(byResult).sort((a,b)=>b[1]-a[1]).forEach(([r,n]) => {
    const c = (r||'').includes('WIN') || (r||'').includes('EOD_WIN') || (r||'').includes('PARTIAL') ? chalk.green : chalk.red;
    console.log(chalk.gray(`    ${c((r||'?').padEnd(14))}  ${n} trades  (${Math.round(n/closed.length*100)}%)`));
  });

  // Risk distance stats
  const risks = closed.map(s => s.riskPts).sort((a,b)=>a-b);
  console.log(chalk.gray('\n  Risk distance (pts):'));
  console.log(chalk.gray(`    min: ${risks[0]?.toFixed(0)}  median: ${risks[Math.floor(risks.length/2)]?.toFixed(0)}  mean: ${(risks.reduce((a,b)=>a+b,0)/risks.length).toFixed(0)}  max: ${risks[risks.length-1]?.toFixed(0)}`));

  // Time-to-resolution stats (mins from entry to last candle used)
  console.log('\n' + sep + '\n');

  fs.writeFileSync(
    path.join(__dirname, '..', 'backtest_report_sameday_dj30.json'),
    JSON.stringify({
      period: 'Jun 2025 → Jun 2026 (same-day exit, force-close 21:00 UTC)',
      generatedAt: new Date().toISOString(),
      settings: { symbol:'DJ30/DIA', start:ACCOUNT_START, riskPct:RISK_PCT*100, minScore:MIN_SCORE, killZone: '13:30-16:00 UTC', forceCloseHour: DAY_END_HOUR },
      account: {
        start: ACCOUNT_START, end: +balance.toFixed(2),
        netGBP: +totalP.toFixed(2),
        returnPct: +((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1),
        maxDD: +maxDD.toFixed(1), peak: +peak.toFixed(2)
      },
      stats: { trades:closed.length, wins:wins.length, losses:losses.length, wr:wr+'%', netR:totalR, pf },
      signals
    }, null, 2)
  );
  console.log(chalk.gray('  Report → backtest_report_sameday_dj30.json\n'));
}

run();
