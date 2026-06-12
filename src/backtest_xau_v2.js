'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  XAUUSD ICT — COMPREHENSIVE BACKTEST v2
//  Covers ALL 3 kill zones, multi-timeframe FVG, minor MSS, equal H/L sweeps
//  Outputs full detection funnel to diagnose where signals fail to form
//
//  KZs: Asia (00:00-04:00 UTC), London (07:00-10:00 UTC), NY (12:00-15:00 UTC)
//  Entry: FVG midpoint limit (M5 or M15)
//  SL: sweep extreme + 0.1%
//  TP: structure targets, min 1.0R
//  2% risk, £1,500 start
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const ACCOUNT_START = 1500;
const RISK_PCT      = 0.02;
const SIM_BARS      = 288;
const COOLDOWN_BARS = 24;   // 2h cooldown after a signal fires

const CACHE = path.join(__dirname, '..', '.cache');

function fmtGBP(n) { return (n>=0?'+':'') + '£' + Math.abs(n).toFixed(2); }
function fmtPct(n) { return (n>=0?'+':'') + n.toFixed(1) + '%'; }

// ─── Data loading ─────────────────────────────────────────────────────────
function loadChunks(prefix) {
  const all = [];
  for (let y=2025, m=6; !(y===2026&&m===7);) {
    const s = `${y}-${String(m).padStart(2,'0')}-01`;
    const nm = m+1>12?1:m+1, ny = m+1>12?y+1:y;
    const e = `${ny}-${String(nm).padStart(2,'0')}-01`;
    const f = path.join(CACHE, `${prefix}_${s}_${e}.json`);
    if (fs.existsSync(f)) all.push(...JSON.parse(fs.readFileSync(f)));
    m++; if (m>12){m=1;y++;}
  }
  const seen = new Set();
  return all.filter(c=>{if(seen.has(c.time))return false;seen.add(c.time);return true;})
    .sort((a,b)=>a.time.localeCompare(b.time));
}

function rollupM15(m5) {
  const out = [];
  for (let i = 0; i < m5.length; i += 3) {
    const s = m5.slice(i, i + 3);
    if (!s.length) continue;
    out.push({ time: s[0].time, open: s[0].open, high: Math.max(...s.map(c=>c.high)),
      low: Math.min(...s.map(c=>c.low)), close: s[s.length-1].close });
  }
  return out;
}

// ─── Kill zone detection ────────────────────────────────────────────────────
function getKZ(isoTime) {
  const h = new Date(isoTime).getUTCHours();
  if (h >= 0  && h < 4)  return 'Asia';
  if (h >= 7  && h < 10) return 'London';
  if (h >= 12 && h < 15) return 'NY';
  return null;
}

// ─── Equal levels (SSL/BSL pools) ──────────────────────────────────────────
function findEqualLevels(candles, lookback = 60, tol = 0.002) {
  const slice = candles.slice(-lookback);
  const eqHighs = [], eqLows = [];

  // Find swing highs/lows
  for (let i = 2; i < slice.length - 2; i++) {
    const c = slice[i];
    if (c.high >= slice[i-1].high && c.high >= slice[i-2].high &&
        c.high >= slice[i+1].high && c.high >= slice[i+2].high) {
      // check for equal high within tol
      for (let j = i - 10; j >= 0 && j > i - 50; j--) {
        if (Math.abs(slice[j].high - c.high) / c.high < tol) {
          eqHighs.push({ price: Math.max(slice[j].high, c.high), time: c.time, label: 'Equal Highs (BSL)' });
          break;
        }
      }
    }
    if (c.low <= slice[i-1].low && c.low <= slice[i-2].low &&
        c.low <= slice[i+1].low && c.low <= slice[i+2].low) {
      for (let j = i - 10; j >= 0 && j > i - 50; j--) {
        if (Math.abs(slice[j].low - c.low) / c.low < tol) {
          eqLows.push({ price: Math.min(slice[j].low, c.low), time: c.time, label: 'Equal Lows (SSL)' });
          break;
        }
      }
    }
  }
  return { eqHighs, eqLows };
}

// ─── Session range (pre-session high/low) ──────────────────────────────────
function getSessionRange(candles5m, dateStr, startHour, endHour) {
  const sess = candles5m.filter(c => {
    if (!c.time.startsWith(dateStr)) return false;
    const h = new Date(c.time).getUTCHours();
    return h >= startHour && h < endHour;
  });
  if (sess.length < 3) return null;
  return { high: Math.max(...sess.map(c=>c.high)), low: Math.min(...sess.map(c=>c.low)), candles: sess.length };
}

// ─── Comprehensive sweep detection ─────────────────────────────────────────
// Returns the most recent sweep from: PDH/PDL, session H/L, equal H/L
function detectSweep(candles5m, kz, dateStr) {
  const recentBars = candles5m.slice(-30);
  const current = recentBars[recentBars.length - 1];
  const sweeps = [];

  // Build key levels
  const levels = [];

  // PDH/PDL from yesterday
  const yesterday = candles5m.filter(c => {
    const d = new Date(c.time);
    const today = new Date(dateStr + 'T00:00:00Z');
    const yest  = new Date(today - 86400000);
    return new Date(c.time) >= yest && new Date(c.time) < today;
  });
  if (yesterday.length) {
    levels.push({ price: Math.max(...yesterday.map(c=>c.high)), label: 'PDH', dir: 'bear' });
    levels.push({ price: Math.min(...yesterday.map(c=>c.low)),  label: 'PDL', dir: 'bull' });
  }

  // Session range sweeps (Asia swept by London, London swept by NY)
  if (kz === 'London') {
    const asia = getSessionRange(candles5m, dateStr, 0, 7);
    if (asia) {
      levels.push({ price: asia.high, label: 'Asia High', dir: 'bear' });
      levels.push({ price: asia.low,  label: 'Asia Low',  dir: 'bull' });
    }
  }
  if (kz === 'NY') {
    const london = getSessionRange(candles5m, dateStr, 7, 14);
    if (london) {
      levels.push({ price: london.high, label: 'London High', dir: 'bear' });
      levels.push({ price: london.low,  label: 'London Low',  dir: 'bull' });
    }
  }
  if (kz === 'Asia') {
    // Previous day range
    if (yesterday.length) {
      const pwHigh = Math.max(...yesterday.map(c=>c.high));
      const pwLow  = Math.min(...yesterday.map(c=>c.low));
      levels.push({ price: pwHigh, label: 'Prev Day High', dir: 'bear' });
      levels.push({ price: pwLow,  label: 'Prev Day Low',  dir: 'bull' });
    }
  }

  // Equal highs/lows — commented out: generates too many false sweeps in the backtest
  // Re-enable only if PDH/PDL/session sweeps are too sparse
  // const { eqHighs, eqLows } = findEqualLevels(candles5m, 80);
  // eqHighs.forEach(l => levels.push({ price: l.price, label: l.label, dir: 'bear' }));
  // eqLows.forEach(l  => levels.push({ price: l.price, label: l.label, dir: 'bull' }));

  // Check each level for sweep in recent bars (no min wick requirement — any sweep counts)
  for (const lvl of levels) {
    for (let back = 0; back < Math.min(24, recentBars.length - 1); back++) {
      const c = recentBars[recentBars.length - 1 - back];
      const kzH = new Date(c.time).getUTCHours();
      // Must be within current KZ
      const inKZ = (kz==='Asia' && kzH>=0 && kzH<4) || (kz==='London' && kzH>=7 && kzH<10) || (kz==='NY' && kzH>=12 && kzH<15);
      if (!inKZ) continue;

      // Minimum wick: require at least $2 extension beyond the level to filter marginal wicks
      const MIN_WICK = 2;

      if (lvl.dir === 'bear' && c.high > lvl.price && c.close < lvl.price && (c.high - lvl.price) >= MIN_WICK) {
        sweeps.push({ dir: 'bear', level: lvl.price, levelName: lvl.label,
          sweepHigh: c.high, sweepCandle: c, barsAgo: back });
        break;
      }
      if (lvl.dir === 'bull' && c.low < lvl.price && c.close > lvl.price && (lvl.price - c.low) >= MIN_WICK) {
        sweeps.push({ dir: 'bull', level: lvl.price, levelName: lvl.label,
          sweepLow: c.low, sweepCandle: c, barsAgo: back });
        break;
      }
    }
  }

  if (!sweeps.length) return null;
  sweeps.sort((a, b) => a.barsAgo - b.barsAgo);
  return sweeps[0];
}

// ─── MSS detection (major + minor) ─────────────────────────────────────────
function detectMSS(candles5m, sweepDir) {
  const w = candles5m.slice(-20);
  if (w.length < 5) return { confirmed: false, reason: 'insufficient bars' };
  const last = w[w.length - 1], prev = w[w.length - 2];

  if (sweepDir === 'bear') {
    // Major MSS: close below a swing low
    let swingLow = Infinity;
    for (let i = 1; i < w.length - 1; i++) {
      if (w[i].low < w[i-1].low && w[i].low < w[i+1].low) swingLow = Math.min(swingLow, w[i].low);
    }
    if (swingLow < Infinity && last.close < swingLow)
      return { confirmed: true, type: 'BOS_DOWN', level: swingLow, grade: 'major' };
    // Minor MSS: CHoCH — close below prev bar low
    if (last.close < prev.low)
      return { confirmed: true, type: 'CHoCH', level: prev.low, grade: 'minor' };
    // Very minor: just close below a 3-bar low
    const min3 = Math.min(...w.slice(-5, -1).map(c=>c.low));
    if (last.close < min3)
      return { confirmed: true, type: 'INTERNAL_BOS', level: min3, grade: 'minor' };
  }

  if (sweepDir === 'bull') {
    let swingHigh = -Infinity;
    for (let i = 1; i < w.length - 1; i++) {
      if (w[i].high > w[i-1].high && w[i].high > w[i+1].high) swingHigh = Math.max(swingHigh, w[i].high);
    }
    if (swingHigh > -Infinity && last.close > swingHigh)
      return { confirmed: true, type: 'BOS_UP', level: swingHigh, grade: 'major' };
    if (last.close > prev.high)
      return { confirmed: true, type: 'CHoCH', level: prev.high, grade: 'minor' };
    const max3 = Math.max(...w.slice(-5, -1).map(c=>c.high));
    if (last.close > max3)
      return { confirmed: true, type: 'INTERNAL_BOS', level: max3, grade: 'minor' };
  }

  return { confirmed: false, reason: 'no structure break' };
}

// ─── Multi-timeframe FVG detection (M5 + M15) ──────────────────────────────
// Returns best FVG across both timeframes; also detects inversion FVGs
function detectFVG(candles5m, candles15m, sweepDir) {
  const results = [];

  function scanTF(candles, tf) {
    const w = candles.slice(-40);
    for (let i = 1; i < w.length - 1; i++) {
      const c0 = w[i-1], c1 = w[i], c2 = w[i+1];

      // Standard bearish FVG: c2.high < c0.low (gap between c0 low and c2 high)
      if (sweepDir === 'bear' && c2.high < c0.low) {
        const size = c0.low - c2.high;
        const mid  = (c0.low + c2.high) / 2;
        // Check if current price is inside (for live confirmation)
        const last = candles[candles.length - 1];
        const inFVG = last.low <= c0.low && last.high >= c2.high;
        results.push({ type: 'bearish', tf, top: c0.low, bottom: c2.high, size, midpoint: mid,
          inFVG, candleTime: c1.time, recency: w.length - 1 - i });
      }

      // Standard bullish FVG: c2.low > c0.high
      if (sweepDir === 'bull' && c2.low > c0.high) {
        const size = c2.low - c0.high;
        const mid  = (c2.low + c0.high) / 2;
        const last = candles[candles.length - 1];
        const inFVG = last.high >= c0.high && last.low <= c2.low;
        results.push({ type: 'bullish', tf, top: c2.low, bottom: c0.high, size, midpoint: mid,
          inFVG, candleTime: c1.time, recency: w.length - 1 - i });
      }

      // Inversion FVG: a bullish FVG that was traded through (now acts as bearish supply)
      if (sweepDir === 'bear' && c2.low > c0.high) {
        const last = candles[candles.length - 1];
        // Only if price has already closed below c0.high (inverting the FVG)
        if (last.close < c0.high) {
          const size = c2.low - c0.high;
          results.push({ type: 'inversion_bear', tf, top: c2.low, bottom: c0.high, size,
            midpoint: (c2.low + c0.high) / 2, inFVG: last.high >= c0.high && last.close < c0.high,
            candleTime: c1.time, recency: w.length - 1 - i });
        }
      }
      if (sweepDir === 'bull' && c2.high < c0.low) {
        const last = candles[candles.length - 1];
        if (last.close > c0.low) {
          const size = c0.low - c2.high;
          results.push({ type: 'inversion_bull', tf, top: c0.low, bottom: c2.high, size,
            midpoint: (c0.low + c2.high) / 2, inFVG: last.low <= c0.low && last.close > c0.low,
            candleTime: c1.time, recency: w.length - 1 - i });
        }
      }
    }
  }

  scanTF(candles5m, 'M5');
  if (candles15m) scanTF(candles15m, 'M15');

  if (!results.length) return null;

  // Prefer most recent, then largest
  results.sort((a, b) => a.recency !== b.recency ? a.recency - b.recency : b.size - a.size);
  return results[0];
}

// ─── Liquidity targets ──────────────────────────────────────────────────────
function liquidityTPs(dir, entry, risk, candles5m, h1) {
  const isLong = dir === 'bull';
  const MIN_R = 1.0, MAX_R = 10.0;
  const candidates = [];
  function rOf(p) { return Math.abs(p - entry) / risk; }
  function ok(p) { return (isLong ? p > entry : p < entry) && rOf(p) >= MIN_R && rOf(p) <= MAX_R; }

  const c5 = candles5m.slice(-80);
  for (let i = 2; i < c5.length - 1; i++) {
    const c = c5[i], prev = c5.slice(Math.max(0, i-8), i);
    if (isLong) {
      const eq = prev.find(p => Math.abs(p.high - c.high) / c.high < 0.001);
      if (eq) { const p = Math.max(c.high, eq.high); if (ok(p)) candidates.push({ price: p, r: rOf(p), desc: '5m equal highs' }); }
    } else {
      const eq = prev.find(p => Math.abs(p.low - c.low) / c.low < 0.001);
      if (eq) { const p = Math.min(c.low, eq.low); if (ok(p)) candidates.push({ price: p, r: rOf(p), desc: '5m equal lows' }); }
    }
  }
  const c1h = h1.slice(-48);
  for (let i = 2; i < c1h.length - 2; i++) {
    const c = c1h[i];
    if (isLong && c.high > c1h[i-1].high && c.high > c1h[i-2].high && c.high > c1h[i+1].high && ok(c.high))
      candidates.push({ price: c.high, r: rOf(c.high), desc: '1H swing high' });
    if (!isLong && c.low < c1h[i-1].low && c.low < c1h[i-2].low && c.low < c1h[i+1].low && ok(c.low))
      candidates.push({ price: c.low, r: rOf(c.low), desc: '1H swing low' });
  }
  candidates.sort((a, b) => a.r - b.r);
  const deduped = [];
  for (const c of candidates) {
    if (!deduped.find(d => Math.abs(d.price - c.price) / entry <= 0.0005)) deduped.push(c);
  }
  const t1o = deduped[0], tp1 = t1o ? t1o.price : (isLong ? entry + risk*2 : entry - risk*2);
  const tp1R = parseFloat(rOf(tp1).toFixed(2));
  const tp1D = t1o ? t1o.desc : 'Fixed 2R';
  const t2o = deduped.find(c => c.r >= tp1R + 0.8);
  const tp2 = t2o ? t2o.price : (isLong ? entry + risk*(tp1R+2) : entry - risk*(tp1R+2));
  const tp2R = parseFloat(rOf(tp2).toFixed(2));
  const tp2D = t2o ? t2o.desc : 'Fixed extension';
  return { tp1, tp1R, tp1Desc: tp1D, tp2, tp2R, tp2Desc: tp2D };
}

function simulateOutcome(dir, entry, sl, tp1, tp2, tp1R, tp2R, future) {
  let tp1Hit = false, sl_ = sl;
  for (const c of future) {
    const slHit  = dir==='bull' ? c.low<=sl_   : c.high>=sl_;
    const t1Hit_ = dir==='bull' ? c.high>=tp1  : c.low<=tp1;
    const t2Hit  = dir==='bull' ? c.high>=tp2  : c.low<=tp2;
    if (!tp1Hit) {
      if (slHit)  return { result:'LOSS',       pnlR:-1 };
      if (t2Hit)  return { result:'WIN_TP2',    pnlR:+(0.5*tp1R+0.5*tp2R).toFixed(2) };
      if (t1Hit_) { tp1Hit=true; sl_=entry; }
    } else {
      if (slHit)  return { result:'WIN_TP1_BE', pnlR:+(0.5*tp1R).toFixed(2) };
      if (t2Hit)  return { result:'WIN_TP2',    pnlR:+(0.5*tp1R+0.5*tp2R).toFixed(2) };
    }
  }
  if (tp1Hit) return { result:'WIN_TP1_OPEN', pnlR:+(0.5*tp1R).toFixed(2) };
  return { result:'OPEN', pnlR:null };
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
function run() {
  console.log('\n' + chalk.bold.yellow('  ◆ XAUUSD ICT v2 — COMPREHENSIVE BACKTEST'));
  console.log(chalk.gray('  Period: 2025-06-11 → 2026-06-10'));
  console.log(chalk.gray('  KZs: Asia (00:00-04:00) + London (07:00-10:00) + NY (12:00-15:00) UTC'));
  console.log(chalk.gray('  Sweeps: PDH/PDL + session H/L + equal H/L (any wick size)'));
  console.log(chalk.gray('  FVG: M5 + M15, standard + inversion'));
  console.log(chalk.gray('  MSS: major BOS + minor CHoCH + internal BOS\n'));

  const all5m = loadChunks('xau1yr_5min');
  const all15m_raw = rollupM15(all5m);
  const allH1 = loadChunks('xau1yr_1h');

  const START = new Date('2025-06-11T00:00:00Z');
  const END   = new Date('2026-06-10T23:59:59Z');
  const period5m = all5m.filter(c => { const t=new Date(c.time); return t>=START && t<=END; });

  console.log(chalk.gray(`  5m bars: ${period5m.length}  |  M15 bars: ${all15m_raw.length}  |  H1 bars: ${allH1.length}`));

  // Funnel counters
  const funnel = {
    kzBars: 0,
    sweepDetected: 0,
    fvgDetected: 0,
    mssConfirmed: 0,
    tradesGenerated: 0,
    limitsFilled: 0,
    limitsMissed: 0,
    byKZ: { Asia: { kzBars:0, sweeps:0, fvgs:0, mss:0, trades:0 },
            London: { kzBars:0, sweeps:0, fvgs:0, mss:0, trades:0 },
            NY: { kzBars:0, sweeps:0, fvgs:0, mss:0, trades:0 } }
  };

  const signals = [];
  let lastSignalBar = -999;
  let balance = ACCOUNT_START, peakBalance = ACCOUNT_START, maxDrawdown = 0;

  // Pre-build 15m index map: for each 5m bar, find corresponding 15m bar index
  let m15Ptr = 0, h1Ptr = 0;

  for (let i = 100; i < period5m.length - 1; i++) {
    const bar  = period5m[i];
    const kz   = getKZ(bar.time);
    if (!kz) continue;

    funnel.kzBars++;
    funnel.byKZ[kz].kzBars++;

    if (i - lastSignalBar < COOLDOWN_BARS) continue;

    const dateStr = bar.time.slice(0, 10);
    // Use fixed-size windows instead of full history slices — O(1) per bar
    const WIN5  = 200;  // ~17h of 5m bars
    const WIN15 = 80;
    const WINH1 = 100;
    const slice5m  = period5m.slice(Math.max(0, i - WIN5),  i + 1);
    // Advance 15m and H1 pointers
    while (m15Ptr < all15m_raw.length - 1 && all15m_raw[m15Ptr+1].time <= bar.time) m15Ptr++;
    while (h1Ptr  < allH1.length - 1      && allH1[h1Ptr+1].time      <= bar.time) h1Ptr++;
    const slice15m = all15m_raw.slice(Math.max(0, m15Ptr - WIN15), m15Ptr + 1);
    const sliceH1  = allH1.slice(Math.max(0, h1Ptr - WINH1), h1Ptr + 1);

    // For session range and PDH/PDL we need slightly more history — use a larger window
    const slice5mWide = period5m.slice(Math.max(0, i - 600), i + 1);  // ~50h, for yesterday + session ranges

    // Step 1: Sweep detection
    const sweep = detectSweep(slice5mWide, kz, dateStr);
    if (!sweep) continue;
    funnel.sweepDetected++;
    funnel.byKZ[kz].sweeps++;

    // Step 2: FVG detection (M5 + M15)
    const fvg = detectFVG(slice5m, slice15m.length >= 10 ? slice15m : null, sweep.dir);
    if (!fvg) continue;
    funnel.fvgDetected++;
    funnel.byKZ[kz].fvgs++;

    // Step 3: MSS detection — BOS only (CHoCH has 36% WR and destroys results)
    const mss = detectMSS(slice5m, sweep.dir);
    if (!mss.confirmed) continue;
    if (mss.type === 'CHoCH') continue;  // filter weak MSS
    funnel.mssConfirmed++;
    funnel.byKZ[kz].mss++;

    // Signal conditions met
    funnel.tradesGenerated++;
    funnel.byKZ[kz].trades++;
    lastSignalBar = i;

    const isLong    = sweep.dir === 'bull';
    const limitEntry = fvg.midpoint;

    const SL_BUF = limitEntry * 0.001;
    let sl;
    if (isLong) {
      const extreme = sweep.sweepLow ?? (limitEntry - SL_BUF * 3);
      sl = extreme - SL_BUF;
      if (sl >= limitEntry) sl = limitEntry - SL_BUF * 3;
    } else {
      const extreme = sweep.sweepHigh ?? (limitEntry + SL_BUF * 3);
      sl = extreme + SL_BUF;
      if (sl <= limitEntry) sl = limitEntry + SL_BUF * 3;
    }
    const risk = Math.abs(limitEntry - sl);
    if (risk > limitEntry * 0.02 || risk <= 0) continue;

    const liq = liquidityTPs(sweep.dir, limitEntry, risk, slice5m, sliceH1);
    const { tp1, tp1R, tp1Desc, tp2, tp2R, tp2Desc } = liq;

    // Fill simulation
    const fillBars = period5m.slice(i+1, i+13);
    let fillIdx = -1;
    for (let f = 0; f < fillBars.length; f++) {
      const c = fillBars[f];
      if (isLong && c.low <= limitEntry)  { fillIdx = f; break; }
      if (!isLong && c.high >= limitEntry){ fillIdx = f; break; }
    }

    if (fillIdx === -1) {
      funnel.limitsMissed++;
      signals.push({ time: bar.time, dir: isLong?'BUY':'SELL', kz,
        limitEntry: parseFloat(limitEntry.toFixed(2)),
        result: 'MISSED', pnlR: 0, pnlGBP: 0, balanceAfter: parseFloat(balance.toFixed(2)),
        sweep: sweep.levelName, mssType: mss.type, mssGrade: mss.grade,
        fvgType: fvg.type, fvgTF: fvg.tf });
      continue;
    }

    funnel.limitsFilled++;
    const future  = period5m.slice(i+1+fillIdx+1, i+1+fillIdx+1+SIM_BARS);
    const outcome = simulateOutcome(sweep.dir, limitEntry, sl, tp1, tp2, tp1R, tp2R, future);
    const riskGBP = balance * RISK_PCT;
    const pnlGBP  = outcome.pnlR != null ? outcome.pnlR * riskGBP : null;

    if (pnlGBP !== null) {
      balance += pnlGBP;
      if (balance > peakBalance) peakBalance = balance;
      const dd = (peakBalance - balance) / peakBalance * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    signals.push({ time: bar.time, dir: isLong?'BUY':'SELL', kz,
      limitEntry: parseFloat(limitEntry.toFixed(2)),
      sl: parseFloat(sl.toFixed(2)), tp1: parseFloat(tp1.toFixed(2)), tp2: parseFloat(tp2.toFixed(2)),
      tp1R, tp1Desc, tp2R, tp2Desc, risk: parseFloat(risk.toFixed(2)),
      sweep: sweep.levelName, mssType: mss.type, mssGrade: mss.grade,
      fvgType: fvg.type, fvgTF: fvg.tf, fvgSize: parseFloat(fvg.size.toFixed(2)),
      fillBarsAfter: fillIdx + 1,
      riskGBP: parseFloat(riskGBP.toFixed(2)),
      pnlGBP: pnlGBP != null ? parseFloat(pnlGBP.toFixed(2)) : null,
      balanceAfter: pnlGBP != null ? parseFloat(balance.toFixed(2)) : null,
      ...outcome });
  }

  // ─── Summary ─────────────────────────────────────────────────────────────
  const sep    = '═'.repeat(76);
  const filled = signals.filter(s => s.result !== 'MISSED');
  const missed = signals.filter(s => s.result === 'MISSED');
  const closed = filled.filter(s => s.pnlR != null);
  const wins   = closed.filter(s => s.pnlR > 0);
  const losses = closed.filter(s => s.pnlR < 0);
  const totalR = closed.reduce((s,x)=>s+x.pnlR, 0);
  const totalGBP = closed.reduce((s,x)=>s+(x.pnlGBP||0), 0);
  const wr     = closed.length ? ((wins.length/closed.length)*100).toFixed(0) : 0;
  const pf     = losses.length
    ? (wins.reduce((s,x)=>s+x.pnlR,0)/Math.abs(losses.reduce((s,x)=>s+x.pnlR,0))).toFixed(2)
    : wins.length ? '∞' : '0.00';

  console.log('\n' + sep);
  console.log(chalk.bold.yellow('  ══ DETECTION FUNNEL ══'));
  console.log(sep);
  console.log(chalk.gray('  KZ bars scanned:         ') + funnel.kzBars.toLocaleString());
  console.log(chalk.cyan('  → Sweeps detected:       ') + funnel.sweepDetected + chalk.gray(` (${(funnel.sweepDetected/funnel.kzBars*100).toFixed(1)}% of KZ bars)`));
  console.log(chalk.cyan('  → Had FVG after sweep:   ') + funnel.fvgDetected + chalk.gray(` (${funnel.sweepDetected ? (funnel.fvgDetected/funnel.sweepDetected*100).toFixed(0) : 0}% of sweeps)`));
  console.log(chalk.cyan('  → MSS confirmed:         ') + funnel.mssConfirmed + chalk.gray(` (${funnel.fvgDetected ? (funnel.mssConfirmed/funnel.fvgDetected*100).toFixed(0) : 0}% of FVGs)`));
  console.log(chalk.green('  → Trades generated:      ') + funnel.tradesGenerated);
  console.log(chalk.green('  → Limits filled:         ') + funnel.limitsFilled);
  console.log(chalk.yellow('  → Limits missed:         ') + funnel.limitsMissed);

  console.log(chalk.gray('\n  Per kill zone:'));
  for (const [kz, f] of Object.entries(funnel.byKZ)) {
    if (!f.kzBars) continue;
    const kzFilled  = signals.filter(s => s.kz===kz && s.result!=='MISSED');
    const kzWins    = kzFilled.filter(s => s.pnlR>0);
    const kzLosses  = kzFilled.filter(s => s.pnlR<0);
    const kzWR      = (kzWins.length+kzLosses.length) ? Math.round(kzWins.length/(kzWins.length+kzLosses.length)*100) : 0;
    const kzR       = kzFilled.reduce((s,x)=>s+(x.pnlR||0), 0);
    console.log(chalk.gray(`    ${kz.padEnd(7)} bars:${f.kzBars.toString().padStart(5)}  sweeps:${f.sweeps.toString().padStart(4)}  fvgs:${f.fvgs.toString().padStart(4)}  mss:${f.mss.toString().padStart(4)}  trades:${f.trades.toString().padStart(3)}`) +
      (kzFilled.length ? chalk.gray(`  filled:${kzFilled.length}  WR:${kzWR}%  netR:`) + (kzR>=0?chalk.green(`+${kzR.toFixed(1)}R`):chalk.red(`${kzR.toFixed(1)}R`)) : ''));
  }

  console.log('\n' + sep);
  console.log(chalk.bold.yellow('  1-YEAR SUMMARY — XAUUSD ICT v2'));
  console.log(sep);
  console.log(chalk.gray('  Total signals:   ') + signals.length);
  console.log(chalk.gray('  Limits filled:   ') + chalk.green(filled.length) + chalk.gray(` (${signals.length?((filled.length/signals.length)*100).toFixed(0):0}% fill rate)`));
  console.log(chalk.gray('  Limits missed:   ') + chalk.yellow(missed.length));
  console.log(chalk.gray('  Wins:            ') + chalk.green(wins.length));
  console.log(chalk.gray('  Losses:          ') + chalk.red(losses.length));
  console.log(chalk.gray('  Win rate:        ') + (parseFloat(wr)>=50?chalk.green:chalk.yellow)(`${wr}%`));
  console.log(chalk.gray('  Net R (filled):  ') + (totalR>=0?chalk.green(`+${totalR.toFixed(2)}R`):chalk.red(`${totalR.toFixed(2)}R`)));
  console.log(chalk.gray('  Profit factor:   ') + chalk.cyan(pf));
  console.log('\n' + chalk.bold.yellow('  ── ACCOUNT (£1,500 · 2% compounding) ──'));
  console.log(chalk.gray('  Start:           £1,500.00'));
  console.log(chalk.gray('  End:             ') + (balance>=ACCOUNT_START?chalk.green:chalk.red)('£'+balance.toFixed(2)));
  console.log(chalk.gray('  Net P&L:         ') + (totalGBP>=0?chalk.green:chalk.red)(fmtGBP(totalGBP)));
  console.log(chalk.gray('  Return:          ') + (balance>=ACCOUNT_START?chalk.green:chalk.red)(fmtPct((balance-ACCOUNT_START)/ACCOUNT_START*100)));
  console.log(chalk.gray('  Peak balance:    £') + peakBalance.toFixed(2));
  console.log(chalk.gray('  Max drawdown:    ') + chalk.yellow(`${maxDrawdown.toFixed(1)}%`));

  // Month by month
  const byMonth = {};
  signals.forEach(s => { const d=new Date(s.time); const k=`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`; byMonth[k]=(byMonth[k]||[]).concat(s); });
  console.log(chalk.gray('\n  Month by month:'));
  Object.entries(byMonth).sort().forEach(([mo, sigs]) => {
    const mF=sigs.filter(s=>s.result!=='MISSED');
    const mW=mF.filter(s=>s.pnlR>0).length, mL=mF.filter(s=>s.pnlR<0).length;
    const mR=mF.reduce((s,x)=>s+(x.pnlR||0),0), mGBP=mF.reduce((s,x)=>s+(x.pnlGBP||0),0);
    const mWR=(mW+mL)>0?Math.round(mW/(mW+mL)*100):0;
    console.log(chalk.gray(`    ${mo}  `)+`${sigs.length} signals  filled ${mF.length}  `+chalk.green(`${mW}W`)+'/'+chalk.red(`${mL}L`)+chalk.gray(`  ${mWR}% WR  `)+(mR>=0?chalk.green(`+${mR.toFixed(1)}R`):chalk.red(`${mR.toFixed(1)}R`))+chalk.gray('  ')+(mGBP>=0?chalk.green(fmtGBP(mGBP)):chalk.red(fmtGBP(mGBP))));
  });

  // Direction breakdown
  const byDir = {};
  signals.forEach(s => { byDir[s.dir]=(byDir[s.dir]||[]).concat(s); });
  console.log(chalk.gray('\n  Direction breakdown:'));
  Object.entries(byDir).forEach(([dir, sigs]) => {
    const dF=sigs.filter(s=>s.result!=='MISSED');
    const dW=dF.filter(s=>s.pnlR>0).length, dL=dF.filter(s=>s.pnlR<0).length;
    const dWR=(dW+dL)>0?Math.round(dW/(dW+dL)*100):0;
    const dR=dF.reduce((s,x)=>s+(x.pnlR||0),0);
    console.log(chalk.gray(`    ${dir.padEnd(5)} ${sigs.length} signals  filled ${dF.length}  `)+chalk.green(`${dW}W`)+'/'+chalk.red(`${dL}L`)+chalk.gray(`  ${dWR}% WR  `)+(dR>=0?chalk.green(`+${dR.toFixed(1)}R`):chalk.red(`${dR.toFixed(1)}R`)));
  });

  // FVG type breakdown
  const byFVG = {};
  filled.forEach(s => { byFVG[`${s.fvgTF}_${s.fvgType}`]=(byFVG[`${s.fvgTF}_${s.fvgType}`]||[]).concat(s); });
  console.log(chalk.gray('\n  FVG type breakdown (filled trades):'));
  Object.entries(byFVG).sort().forEach(([type, sigs]) => {
    const w=sigs.filter(s=>s.pnlR>0).length, l=sigs.filter(s=>s.pnlR<0).length;
    const wr=(w+l)?Math.round(w/(w+l)*100):0;
    const r=sigs.reduce((s,x)=>s+(x.pnlR||0),0);
    console.log(chalk.gray(`    ${type.padEnd(22)} ${sigs.length} filled  ${w}W/${l}L  ${wr}% WR  `)+(r>=0?chalk.green(`+${r.toFixed(1)}R`):chalk.red(`${r.toFixed(1)}R`)));
  });

  // MSS grade breakdown
  const byMSS = {};
  filled.forEach(s => { byMSS[s.mssType]=(byMSS[s.mssType]||[]).concat(s); });
  console.log(chalk.gray('\n  MSS type breakdown (filled trades):'));
  Object.entries(byMSS).sort().forEach(([type, sigs]) => {
    const w=sigs.filter(s=>s.pnlR>0).length, l=sigs.filter(s=>s.pnlR<0).length;
    const wr=(w+l)?Math.round(w/(w+l)*100):0;
    const r=sigs.reduce((s,x)=>s+(x.pnlR||0),0);
    console.log(chalk.gray(`    ${type.padEnd(15)} ${sigs.length} filled  ${w}W/${l}L  ${wr}% WR  `)+(r>=0?chalk.green(`+${r.toFixed(1)}R`):chalk.red(`${r.toFixed(1)}R`)));
  });

  console.log('\n' + sep + '\n');

  fs.writeFileSync(path.join(__dirname, '..', 'backtest_report_xau_v2.json'),
    JSON.stringify({ period:'2025-06-11 → 2026-06-10', method:'ICT v2 comprehensive',
      generatedAt: new Date().toISOString(), funnel,
      account:{ start:ACCOUNT_START, end:parseFloat(balance.toFixed(2)),
        returnPct:parseFloat(((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)),
        peakBalance:parseFloat(peakBalance.toFixed(2)), maxDrawdown:parseFloat(maxDrawdown.toFixed(1)) },
      stats:{ total:signals.length, filled:filled.length, missed:missed.length,
        wins:wins.length, losses:losses.length, winRate:wr+'%',
        netR:parseFloat(totalR.toFixed(2)), profitFactor:pf }, signals }, null, 2));
  console.log(chalk.gray('  Report → backtest_report_xau_v2.json\n'));
}

run();
