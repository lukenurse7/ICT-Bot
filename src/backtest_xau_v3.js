'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  XAUUSD ICT — BACKTEST v3
//  All 9 fixes applied:
//  1. No CHoCH — only BOS_UP / BOS_DOWN qualify as MSS
//  2. DUAL ENTRY MODE: FVG limit + market order at BOS close (compared)
//  3. FVG timing fix — only FVGs formed AFTER the sweep candle
//  4. No equal highs/lows sweep detection
//  5. Min wick $3 on sweeps
//  6. Inversion FVGs preferred (sorted first)
//  7. No SMA filter
//  8. London + Asia KZs only (NY dropped)
//  9. M15 BOS confirmation required alongside M5 BOS
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const ACCOUNT_START = 1500;
const RISK_PCT      = 0.02;
const SIM_BARS      = 288;
const COOLDOWN_BARS = 24;   // 2h cooldown per KZ session
const MIN_WICK      = 3;    // Fix #5: $3 min wick (was $2)

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

// ─── Kill zone detection — Fix #8: London + Asia only, no NY ──────────────
function getKZ(isoTime) {
  const h = new Date(isoTime).getUTCHours();
  if (h >= 0  && h < 4)  return 'Asia';
  if (h >= 7  && h < 10) return 'London';
  // NY removed — 26% WR, -42% return
  return null;
}

// ─── Session range ──────────────────────────────────────────────────────────
function getSessionRange(candles5m, dateStr, startHour, endHour) {
  const sess = candles5m.filter(c => {
    if (!c.time.startsWith(dateStr)) return false;
    const h = new Date(c.time).getUTCHours();
    return h >= startHour && h < endHour;
  });
  if (sess.length < 3) return null;
  return { high: Math.max(...sess.map(c=>c.high)), low: Math.min(...sess.map(c=>c.low)) };
}

// ─── Sweep detection — Fix #3,4,5 ─────────────────────────────────────────
// Returns sweep with sweepCandleIdx so FVG can be limited to post-sweep bars
function detectSweep(candles5m, kz, dateStr) {
  const recentBars = candles5m.slice(-30);
  const sweeps = [];
  const levels = [];

  // PDH/PDL from yesterday
  const yesterday = candles5m.filter(c => {
    const today = new Date(dateStr + 'T00:00:00Z');
    const yest  = new Date(today - 86400000);
    const t = new Date(c.time);
    return t >= yest && t < today;
  });
  if (yesterday.length) {
    levels.push({ price: Math.max(...yesterday.map(c=>c.high)), label: 'PDH', dir: 'bear' });
    levels.push({ price: Math.min(...yesterday.map(c=>c.low)),  label: 'PDL', dir: 'bull' });
  }

  // Session range sweeps
  if (kz === 'London') {
    const asia = getSessionRange(candles5m, dateStr, 0, 7);
    if (asia) {
      levels.push({ price: asia.high, label: 'Asia High', dir: 'bear' });
      levels.push({ price: asia.low,  label: 'Asia Low',  dir: 'bull' });
    }
  }
  if (kz === 'Asia') {
    if (yesterday.length) {
      levels.push({ price: Math.max(...yesterday.map(c=>c.high)), label: 'Prev Day High', dir: 'bear' });
      levels.push({ price: Math.min(...yesterday.map(c=>c.low)),  label: 'Prev Day Low',  dir: 'bull' });
    }
  }

  // Fix #4: NO equal highs/lows — removed entirely

  for (const lvl of levels) {
    for (let back = 0; back < Math.min(24, recentBars.length - 1); back++) {
      const c = recentBars[recentBars.length - 1 - back];
      const kzH = new Date(c.time).getUTCHours();
      const inKZ = (kz==='Asia' && kzH>=0 && kzH<4) || (kz==='London' && kzH>=7 && kzH<10);
      if (!inKZ) continue;

      if (lvl.dir === 'bear' && c.high > lvl.price && c.close < lvl.price && (c.high - lvl.price) >= MIN_WICK) {
        sweeps.push({ dir: 'bear', level: lvl.price, levelName: lvl.label,
          sweepHigh: c.high, sweepCandle: c, barsAgo: back, sweepBarIdx: recentBars.length - 1 - back });
        break;
      }
      if (lvl.dir === 'bull' && c.low < lvl.price && c.close > lvl.price && (lvl.price - c.low) >= MIN_WICK) {
        sweeps.push({ dir: 'bull', level: lvl.price, levelName: lvl.label,
          sweepLow: c.low, sweepCandle: c, barsAgo: back, sweepBarIdx: recentBars.length - 1 - back });
        break;
      }
    }
  }

  if (!sweeps.length) return null;
  sweeps.sort((a, b) => a.barsAgo - b.barsAgo);
  return sweeps[0];
}

// ─── MSS detection — Fix #1: BOS only, no CHoCH ───────────────────────────
// Fix #9: M15 confirmation required for BOS
function detectMSS(candles5m, candles15m, sweepDir) {
  const w5 = candles5m.slice(-20);
  const w15 = candles15m ? candles15m.slice(-10) : [];
  if (w5.length < 5) return { confirmed: false, reason: 'insufficient bars' };

  // Check M5 BOS
  let m5BOS = false, m5Level = 0, m5Type = null;
  if (sweepDir === 'bear') {
    let swingLow = Infinity;
    for (let i = 1; i < w5.length - 1; i++) {
      if (w5[i].low < w5[i-1].low && w5[i].low < w5[i+1].low) swingLow = Math.min(swingLow, w5[i].low);
    }
    if (swingLow < Infinity && w5[w5.length-1].close < swingLow) {
      m5BOS = true; m5Level = swingLow; m5Type = 'BOS_DOWN';
    }
  }
  if (sweepDir === 'bull') {
    let swingHigh = -Infinity;
    for (let i = 1; i < w5.length - 1; i++) {
      if (w5[i].high > w5[i-1].high && w5[i].high > w5[i+1].high) swingHigh = Math.max(swingHigh, w5[i].high);
    }
    if (swingHigh > -Infinity && w5[w5.length-1].close > swingHigh) {
      m5BOS = true; m5Level = swingHigh; m5Type = 'BOS_UP';
    }
  }

  if (!m5BOS) return { confirmed: false, reason: 'no M5 BOS' };

  // Fix #9: Verify M15 also shows a broken swing (doesn't need to be fresh — just aligned)
  if (w15.length >= 5) {
    let m15Aligned = false;
    if (sweepDir === 'bear') {
      const recentLow = Math.min(...w15.slice(-5).map(c=>c.low));
      const priorLow  = Math.min(...w15.slice(-10,-5).map(c=>c.low));
      // M15 should be making lower lows (bearish structure)
      if (recentLow <= priorLow * 1.001) m15Aligned = true;
    } else {
      const recentHigh = Math.max(...w15.slice(-5).map(c=>c.high));
      const priorHigh  = Math.max(...w15.slice(-10,-5).map(c=>c.high));
      if (recentHigh >= priorHigh * 0.999) m15Aligned = true;
    }
    if (!m15Aligned) return { confirmed: false, reason: 'M15 not aligned with M5 BOS' };
  }

  return { confirmed: true, type: m5Type, level: m5Level, grade: 'major',
           mssBar: w5[w5.length-1] };  // capture the BOS bar for market-order entry
}

// ─── FVG detection — Fix #3,6: post-sweep only, inversion preferred ────────
function detectFVG(candles5m, candles15m, sweepDir, sweepBarIdx) {
  const results = [];

  function scanTF(candles, tf, startIdx) {
    // startIdx: only look at FVGs formed AT OR AFTER the sweep candle
    const w = candles.slice(Math.max(0, startIdx), candles.length);
    for (let i = 1; i < w.length - 1; i++) {
      const c0 = w[i-1], c1 = w[i], c2 = w[i+1];

      if (sweepDir === 'bear' && c2.high < c0.low) {
        const size = c0.low - c2.high;
        if (size < 1.0) continue;  // ignore tiny FVGs
        results.push({ type: 'bearish', tf, top: c0.low, bottom: c2.high, size,
          midpoint: (c0.low + c2.high) / 2, candleTime: c1.time, recency: w.length - 1 - i,
          priority: 1 });
      }
      if (sweepDir === 'bull' && c2.low > c0.high) {
        const size = c2.low - c0.high;
        if (size < 1.0) continue;
        results.push({ type: 'bullish', tf, top: c2.low, bottom: c0.high, size,
          midpoint: (c2.low + c0.high) / 2, candleTime: c1.time, recency: w.length - 1 - i,
          priority: 1 });
      }

      // Fix #6: Inversion FVGs — higher priority
      if (sweepDir === 'bear' && c2.low > c0.high) {
        const last = candles[candles.length - 1];
        if (last.close < c0.high) {
          const size = c2.low - c0.high;
          if (size < 1.0) continue;
          results.push({ type: 'inversion_bear', tf, top: c2.low, bottom: c0.high, size,
            midpoint: (c2.low + c0.high) / 2, candleTime: c1.time, recency: w.length - 1 - i,
            priority: 0 });  // priority 0 = first in sort
        }
      }
      if (sweepDir === 'bull' && c2.high < c0.low) {
        const last = candles[candles.length - 1];
        if (last.close > c0.low) {
          const size = c0.low - c2.high;
          if (size < 1.0) continue;
          results.push({ type: 'inversion_bull', tf, top: c0.low, bottom: c2.high, size,
            midpoint: (c0.low + c2.high) / 2, candleTime: c1.time, recency: w.length - 1 - i,
            priority: 0 });
        }
      }
    }
  }

  // For M5: sweepBarIdx is the index within the slice5m window
  scanTF(candles5m, 'M5', sweepBarIdx);

  if (candles15m && candles15m.length >= 5) {
    // For M15: approximate sweep position — use last 15 bars
    const m15StartIdx = Math.max(0, candles15m.length - 15);
    scanTF(candles15m, 'M15', m15StartIdx);
  }

  if (!results.length) return null;
  // Fix #6: Sort by priority (inversions first), then recency, then size
  results.sort((a, b) => a.priority !== b.priority ? a.priority - b.priority
    : a.recency !== b.recency ? a.recency - b.recency : b.size - a.size);
  return results[0];
}

// ─── Liquidity TPs ──────────────────────────────────────────────────────────
function liquidityTPs(dir, entry, risk, candles5m, h1) {
  const isLong = dir === 'bull';
  const MIN_R = 1.0, MAX_R = 10.0;
  const candidates = [];
  function rOf(p) { return Math.abs(p - entry) / risk; }
  function ok(p)  { return (isLong ? p > entry : p < entry) && rOf(p) >= MIN_R && rOf(p) <= MAX_R; }

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
    if (isLong  && c.high > c1h[i-1].high && c.high > c1h[i-2].high && c.high > c1h[i+1].high && ok(c.high))
      candidates.push({ price: c.high, r: rOf(c.high), desc: '1H swing high' });
    if (!isLong && c.low  < c1h[i-1].low  && c.low  < c1h[i-2].low  && c.low  < c1h[i+1].low  && ok(c.low))
      candidates.push({ price: c.low,  r: rOf(c.low),  desc: '1H swing low' });
  }
  candidates.sort((a, b) => a.r - b.r);
  const deduped = [];
  for (const c of candidates) {
    if (!deduped.find(d => Math.abs(d.price - c.price) / entry <= 0.0005)) deduped.push(c);
  }
  const t1o = deduped[0];
  const tp1 = t1o ? t1o.price : (isLong ? entry + risk*2 : entry - risk*2);
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

// ─── MAIN ─────────────────────────────────────────────────────────────────
function run() {
  console.log('\n' + chalk.bold.yellow('  ◆ XAUUSD ICT v3 — ALL 9 FIXES + MARKET ORDER COMPARISON'));
  console.log(chalk.gray('  Period: 2025-06-11 → 2026-06-10'));
  console.log(chalk.gray('  KZs: Asia (00:00-04:00) + London (07:00-10:00) UTC  [NY dropped]'));
  console.log(chalk.gray('  Sweeps: PDH/PDL + session H/L, min wick $3, no equal H/L'));
  console.log(chalk.gray('  FVG: post-sweep only, M5+M15, inversion preferred'));
  console.log(chalk.gray('  MSS: BOS only (CHoCH excluded), M15 confirmation required'));
  console.log(chalk.gray('  Entry A: FVG midpoint limit'));
  console.log(chalk.gray('  Entry B: BOS close (market order)\n'));

  const all5m = loadChunks('xau1yr_5min');
  const all15m_raw = rollupM15(all5m);
  const allH1 = loadChunks('xau1yr_1h');

  const START = new Date('2025-06-11T00:00:00Z');
  const END   = new Date('2026-06-10T23:59:59Z');
  const period5m = all5m.filter(c => { const t=new Date(c.time); return t>=START && t<=END; });

  console.log(chalk.gray(`  5m bars: ${period5m.length}  |  M15 bars: ${all15m_raw.length}  |  H1 bars: ${allH1.length}`));

  const funnel = {
    kzBars: 0, sweepDetected: 0, fvgDetected: 0, mssConfirmed: 0,
    tradesGenerated: 0, limitsFilled: 0, limitsMissed: 0, marketOrders: 0,
    byKZ: {
      Asia:   { kzBars:0, sweeps:0, fvgs:0, mss:0, trades:0 },
      London: { kzBars:0, sweeps:0, fvgs:0, mss:0, trades:0 }
    }
  };

  // Two independent ledgers: limit entry vs market order entry
  const signalsLimit  = [];  // Entry A: FVG midpoint limit
  const signalsMarket = [];  // Entry B: BOS close market order

  const stateLimit  = { lastBar: -999, balance: ACCOUNT_START, peak: ACCOUNT_START, maxDD: 0 };
  const stateMarket = { lastBar: -999, balance: ACCOUNT_START, peak: ACCOUNT_START, maxDD: 0 };

  let m15Ptr = 0, h1Ptr = 0;

  for (let i = 100; i < period5m.length - 1; i++) {
    const bar = period5m[i];
    const kz  = getKZ(bar.time);
    if (!kz) continue;

    funnel.kzBars++;
    funnel.byKZ[kz].kzBars++;

    // Cooldown: both ledgers must be out of cooldown (use conservative max)
    const inCooldown = (i - stateLimit.lastBar < COOLDOWN_BARS) ||
                       (i - stateMarket.lastBar < COOLDOWN_BARS);
    if (inCooldown) continue;

    const dateStr = bar.time.slice(0, 10);
    const WIN5 = 200, WIN15 = 80, WINH1 = 100;
    const slice5m  = period5m.slice(Math.max(0, i - WIN5),  i + 1);

    while (m15Ptr < all15m_raw.length - 1 && all15m_raw[m15Ptr+1].time <= bar.time) m15Ptr++;
    while (h1Ptr  < allH1.length - 1      && allH1[h1Ptr+1].time      <= bar.time) h1Ptr++;
    const slice15m = all15m_raw.slice(Math.max(0, m15Ptr - WIN15), m15Ptr + 1);
    const sliceH1  = allH1.slice(Math.max(0, h1Ptr - WINH1), h1Ptr + 1);
    const slice5mWide = period5m.slice(Math.max(0, i - 600), i + 1);

    // Step 1: Sweep
    const sweep = detectSweep(slice5mWide, kz, dateStr);
    if (!sweep) continue;
    funnel.sweepDetected++;
    funnel.byKZ[kz].sweeps++;

    // Fix #3: FVG only after sweep candle
    // sweepBarIdx within slice5m (approximate: sweep.barsAgo from end)
    const sweepIdxInSlice = slice5m.length - 1 - sweep.barsAgo;

    // Step 2: FVG (post-sweep only)
    const fvg = detectFVG(slice5m, slice15m.length >= 10 ? slice15m : null, sweep.dir, sweepIdxInSlice);
    if (!fvg) continue;
    funnel.fvgDetected++;
    funnel.byKZ[kz].fvgs++;

    // Step 3: MSS (BOS only + M15 confirmation)
    const mss = detectMSS(slice5m, slice15m.length >= 10 ? slice15m : null, sweep.dir);
    if (!mss.confirmed) continue;
    funnel.mssConfirmed++;
    funnel.byKZ[kz].mss++;

    funnel.tradesGenerated++;
    funnel.byKZ[kz].trades++;

    const isLong = sweep.dir === 'bull';

    // ── ENTRY A: FVG midpoint limit ──────────────────────────────────────
    const limitEntry = fvg.midpoint;
    const SL_BUF_L   = limitEntry * 0.001;
    let slLimit;
    if (isLong) {
      const extreme = sweep.sweepLow ?? (limitEntry - SL_BUF_L * 3);
      slLimit = extreme - SL_BUF_L;
      if (slLimit >= limitEntry) slLimit = limitEntry - SL_BUF_L * 3;
    } else {
      const extreme = sweep.sweepHigh ?? (limitEntry + SL_BUF_L * 3);
      slLimit = extreme + SL_BUF_L;
      if (slLimit <= limitEntry) slLimit = limitEntry + SL_BUF_L * 3;
    }
    const riskLimit = Math.abs(limitEntry - slLimit);

    if (riskLimit > limitEntry * 0.02 && riskLimit > 0) {
      // Valid risk — try fill
      const fillBars = period5m.slice(i+1, i+13);
      let fillIdx = -1;
      for (let f = 0; f < fillBars.length; f++) {
        const c = fillBars[f];
        if (isLong && c.low <= limitEntry)   { fillIdx = f; break; }
        if (!isLong && c.high >= limitEntry) { fillIdx = f; break; }
      }

      const liqL = liquidityTPs(sweep.dir, limitEntry, riskLimit, slice5m, sliceH1);
      const { tp1:tp1L, tp1R:tp1RL, tp1Desc:tp1DL, tp2:tp2L, tp2R:tp2RL, tp2Desc:tp2DL } = liqL;

      if (fillIdx === -1) {
        funnel.limitsMissed++;
        signalsLimit.push({ time: bar.time, dir: isLong?'BUY':'SELL', kz,
          entry: parseFloat(limitEntry.toFixed(2)), entryMode: 'LIMIT',
          result: 'MISSED', pnlR: 0, pnlGBP: 0, balanceAfter: parseFloat(stateLimit.balance.toFixed(2)),
          sweep: sweep.levelName, mssType: mss.type, fvgType: fvg.type, fvgTF: fvg.tf });
      } else {
        funnel.limitsFilled++;
        stateLimit.lastBar = i;
        const future = period5m.slice(i+1+fillIdx+1, i+1+fillIdx+1+SIM_BARS);
        const outcome = simulateOutcome(sweep.dir, limitEntry, slLimit, tp1L, tp2L, tp1RL, tp2RL, future);
        const riskGBP = stateLimit.balance * RISK_PCT;
        const pnlGBP  = outcome.pnlR != null ? outcome.pnlR * riskGBP : null;
        if (pnlGBP !== null) {
          stateLimit.balance += pnlGBP;
          if (stateLimit.balance > stateLimit.peak) stateLimit.peak = stateLimit.balance;
          const dd = (stateLimit.peak - stateLimit.balance) / stateLimit.peak * 100;
          if (dd > stateLimit.maxDD) stateLimit.maxDD = dd;
        }
        signalsLimit.push({ time: bar.time, dir: isLong?'BUY':'SELL', kz,
          entry: parseFloat(limitEntry.toFixed(2)), entryMode: 'LIMIT',
          sl: parseFloat(slLimit.toFixed(2)), tp1: parseFloat(tp1L.toFixed(2)), tp2: parseFloat(tp2L.toFixed(2)),
          tp1R: tp1RL, tp1Desc: tp1DL, tp2R: tp2RL, tp2Desc: tp2DL,
          sweep: sweep.levelName, mssType: mss.type, fvgType: fvg.type, fvgTF: fvg.tf,
          fillBarsAfter: fillIdx + 1,
          riskGBP: parseFloat(riskGBP.toFixed(2)),
          pnlGBP: pnlGBP != null ? parseFloat(pnlGBP.toFixed(2)) : null,
          balanceAfter: parseFloat(stateLimit.balance.toFixed(2)),
          ...outcome });
      }
    }

    // ── ENTRY B: Market order at BOS close (Fix #2) ───────────────────────
    // Enter immediately at the close of the MSS (BOS) bar
    const mssBar    = mss.mssBar || slice5m[slice5m.length - 1];
    const mktEntry  = mssBar.close;
    const SL_BUF_M  = mktEntry * 0.001;
    let slMarket;
    if (isLong) {
      const extreme = sweep.sweepLow ?? (mktEntry - SL_BUF_M * 3);
      slMarket = extreme - SL_BUF_M;
      if (slMarket >= mktEntry) slMarket = mktEntry - SL_BUF_M * 3;
    } else {
      const extreme = sweep.sweepHigh ?? (mktEntry + SL_BUF_M * 3);
      slMarket = extreme + SL_BUF_M;
      if (slMarket <= mktEntry) slMarket = mktEntry + SL_BUF_M * 3;
    }
    const riskMarket = Math.abs(mktEntry - slMarket);
    if (riskMarket <= 0 || riskMarket > mktEntry * 0.02) continue;

    funnel.marketOrders++;
    stateMarket.lastBar = i;

    const liqM = liquidityTPs(sweep.dir, mktEntry, riskMarket, slice5m, sliceH1);
    const { tp1:tp1M, tp1R:tp1RM, tp1Desc:tp1DM, tp2:tp2M, tp2R:tp2RM, tp2Desc:tp2DM } = liqM;

    const futureM = period5m.slice(i+1, i+1+SIM_BARS);
    const outcomeM = simulateOutcome(sweep.dir, mktEntry, slMarket, tp1M, tp2M, tp1RM, tp2RM, futureM);
    const riskGBPm  = stateMarket.balance * RISK_PCT;
    const pnlGBPm   = outcomeM.pnlR != null ? outcomeM.pnlR * riskGBPm : null;
    if (pnlGBPm !== null) {
      stateMarket.balance += pnlGBPm;
      if (stateMarket.balance > stateMarket.peak) stateMarket.peak = stateMarket.balance;
      const dd = (stateMarket.peak - stateMarket.balance) / stateMarket.peak * 100;
      if (dd > stateMarket.maxDD) stateMarket.maxDD = dd;
    }
    signalsMarket.push({ time: bar.time, dir: isLong?'BUY':'SELL', kz,
      entry: parseFloat(mktEntry.toFixed(2)), entryMode: 'MARKET',
      sl: parseFloat(slMarket.toFixed(2)), tp1: parseFloat(tp1M.toFixed(2)), tp2: parseFloat(tp2M.toFixed(2)),
      tp1R: tp1RM, tp1Desc: tp1DM, tp2R: tp2RM, tp2Desc: tp2DM,
      sweep: sweep.levelName, mssType: mss.type, fvgType: fvg.type, fvgTF: fvg.tf,
      riskGBP: parseFloat(riskGBPm.toFixed(2)),
      pnlGBP: pnlGBPm != null ? parseFloat(pnlGBPm.toFixed(2)) : null,
      balanceAfter: parseFloat(stateMarket.balance.toFixed(2)),
      ...outcomeM });
  }

  // ─── Results helper ───────────────────────────────────────────────────────
  function printResults(label, signals, state, color) {
    const sep = '═'.repeat(76);
    const filled   = signals.filter(s => s.result !== 'MISSED');
    const missed   = signals.filter(s => s.result === 'MISSED');
    const closed   = filled.filter(s => s.pnlR != null);
    const wins     = closed.filter(s => s.pnlR > 0);
    const losses   = closed.filter(s => s.pnlR < 0);
    const totalR   = closed.reduce((s,x) => s + x.pnlR, 0);
    const totalGBP = closed.reduce((s,x) => s + (x.pnlGBP||0), 0);
    const wr       = closed.length ? ((wins.length / closed.length) * 100).toFixed(0) : 0;
    const pf       = losses.length
      ? (wins.reduce((s,x)=>s+x.pnlR,0) / Math.abs(losses.reduce((s,x)=>s+x.pnlR,0))).toFixed(2)
      : wins.length ? '∞' : '0.00';

    console.log('\n' + sep);
    console.log(color(`  ══ ${label} ══`));
    console.log(sep);
    console.log(chalk.gray('  Total signals:   ') + signals.length);
    if (missed.length > 0)
      console.log(chalk.gray('  Limits filled:   ') + chalk.green(filled.length) +
        chalk.gray(` (${signals.length?((filled.length/signals.length)*100).toFixed(0):0}% fill rate)`) +
        chalk.gray(`  Missed: ${missed.length}`));
    else
      console.log(chalk.gray('  Trades:          ') + chalk.green(filled.length));
    console.log(chalk.gray('  Wins:            ') + chalk.green(wins.length));
    console.log(chalk.gray('  Losses:          ') + chalk.red(losses.length));
    console.log(chalk.gray('  Win rate:        ') + (parseFloat(wr)>=50?chalk.green:chalk.yellow)(`${wr}%`));
    console.log(chalk.gray('  Net R:           ') + (totalR>=0?chalk.green(`+${totalR.toFixed(2)}R`):chalk.red(`${totalR.toFixed(2)}R`)));
    console.log(chalk.gray('  Profit factor:   ') + chalk.cyan(pf));
    console.log('\n' + color('  ── ACCOUNT (£1,500 · 2% compounding) ──'));
    console.log(chalk.gray('  Start:           £1,500.00'));
    console.log(chalk.gray('  End:             ') + (state.balance>=ACCOUNT_START?chalk.green:chalk.red)('£'+state.balance.toFixed(2)));
    console.log(chalk.gray('  Return:          ') + (state.balance>=ACCOUNT_START?chalk.green:chalk.red)(fmtPct((state.balance-ACCOUNT_START)/ACCOUNT_START*100)));
    console.log(chalk.gray('  Max drawdown:    ') + chalk.yellow(`${state.maxDD.toFixed(1)}%`));

    // By KZ
    console.log(chalk.gray('\n  By kill zone:'));
    for (const kzName of ['Asia', 'London']) {
      const kzSigs = filled.filter(s => s.kz === kzName);
      if (!kzSigs.length) continue;
      const kzClosed = kzSigs.filter(s => s.pnlR != null);
      const kzW = kzClosed.filter(s=>s.pnlR>0).length, kzL = kzClosed.filter(s=>s.pnlR<0).length;
      const kzWR = (kzW+kzL)>0 ? Math.round(kzW/(kzW+kzL)*100) : 0;
      const kzR = kzClosed.reduce((s,x)=>s+x.pnlR,0);
      console.log(chalk.gray(`    ${kzName.padEnd(7)} ${kzSigs.length} filled  ${kzW}W/${kzL}L  ${kzWR}% WR  `) +
        (kzR>=0?chalk.green(`+${kzR.toFixed(1)}R`):chalk.red(`${kzR.toFixed(1)}R`)));
    }

    // Direction
    console.log(chalk.gray('\n  By direction:'));
    for (const d of ['BUY','SELL']) {
      const ds = filled.filter(s=>s.dir===d);
      if (!ds.length) continue;
      const dc = ds.filter(s=>s.pnlR!=null);
      const dw=dc.filter(s=>s.pnlR>0).length, dl=dc.filter(s=>s.pnlR<0).length;
      const dwr=(dw+dl)?Math.round(dw/(dw+dl)*100):0;
      const dr=dc.reduce((s,x)=>s+x.pnlR,0);
      console.log(chalk.gray(`    ${d.padEnd(5)} ${ds.length} filled  ${dw}W/${dl}L  ${dwr}% WR  `) +
        (dr>=0?chalk.green(`+${dr.toFixed(1)}R`):chalk.red(`${dr.toFixed(1)}R`)));
    }

    // FVG type
    const byFVG = {};
    filled.forEach(s => { const k=`${s.fvgTF}_${s.fvgType}`; byFVG[k]=(byFVG[k]||[]).concat(s); });
    console.log(chalk.gray('\n  FVG type breakdown:'));
    Object.entries(byFVG).sort().forEach(([type, sigs]) => {
      const c = sigs.filter(s=>s.pnlR!=null);
      const w=c.filter(s=>s.pnlR>0).length, l=c.filter(s=>s.pnlR<0).length;
      const wr=(w+l)?Math.round(w/(w+l)*100):0;
      const r=c.reduce((s,x)=>s+x.pnlR,0);
      console.log(chalk.gray(`    ${type.padEnd(22)} ${c.length} trades  ${w}W/${l}L  ${wr}% WR  `) +
        (r>=0?chalk.green(`+${r.toFixed(1)}R`):chalk.red(`${r.toFixed(1)}R`)));
    });

    // Month by month
    const byMonth = {};
    filled.forEach(s => {
      const d=new Date(s.time), k=`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
      byMonth[k]=(byMonth[k]||[]).concat(s);
    });
    console.log(chalk.gray('\n  Month by month:'));
    Object.entries(byMonth).sort().forEach(([mo, sigs]) => {
      const c=sigs.filter(s=>s.pnlR!=null);
      const mW=c.filter(s=>s.pnlR>0).length, mL=c.filter(s=>s.pnlR<0).length;
      const mR=c.reduce((s,x)=>s+x.pnlR,0);
      const mWR=(mW+mL)>0?Math.round(mW/(mW+mL)*100):0;
      const mGBP=c.reduce((s,x)=>s+(x.pnlGBP||0),0);
      console.log(chalk.gray(`    ${mo}  `)+`${sigs.length} trades  `+chalk.green(`${mW}W`)+'/'+chalk.red(`${mL}L`)+
        chalk.gray(`  ${mWR}% WR  `)+(mR>=0?chalk.green(`+${mR.toFixed(1)}R`):chalk.red(`${mR.toFixed(1)}R`))+
        chalk.gray('  ')+(mGBP>=0?chalk.green(fmtGBP(mGBP)):chalk.red(fmtGBP(mGBP))));
    });

    return { total:signals.length, filled:filled.length, missed:missed.length,
      wins:wins.length, losses:losses.length, winRate:wr+'%',
      netR:parseFloat(totalR.toFixed(2)), profitFactor:pf,
      account:{ start:ACCOUNT_START, end:parseFloat(state.balance.toFixed(2)),
        returnPct:parseFloat(((state.balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)),
        maxDrawdown:parseFloat(state.maxDD.toFixed(1)) }};
  }

  // ─── Print funnel ─────────────────────────────────────────────────────────
  const sep = '═'.repeat(76);
  console.log('\n' + sep);
  console.log(chalk.bold.yellow('  ══ DETECTION FUNNEL ══'));
  console.log(sep);
  console.log(chalk.gray('  KZ bars scanned:         ') + funnel.kzBars.toLocaleString());
  console.log(chalk.cyan('  → Sweeps detected:       ') + funnel.sweepDetected + chalk.gray(` (${(funnel.sweepDetected/funnel.kzBars*100).toFixed(1)}%)`));
  console.log(chalk.cyan('  → Had FVG (post-sweep):  ') + funnel.fvgDetected   + chalk.gray(` (${funnel.sweepDetected?(funnel.fvgDetected/funnel.sweepDetected*100).toFixed(0):0}%)`));
  console.log(chalk.cyan('  → BOS confirmed (M5+M15):') + funnel.mssConfirmed  + chalk.gray(` (${funnel.fvgDetected?(funnel.mssConfirmed/funnel.fvgDetected*100).toFixed(0):0}%)`));
  console.log(chalk.green('  → Trades generated:      ') + funnel.tradesGenerated);
  console.log(chalk.green('  → Limit orders filled:   ') + funnel.limitsFilled);
  console.log(chalk.yellow('  → Limit orders missed:   ') + funnel.limitsMissed);
  console.log(chalk.green('  → Market orders:         ') + funnel.marketOrders);
  console.log(chalk.gray('\n  Per kill zone:'));
  for (const [kz, f] of Object.entries(funnel.byKZ)) {
    if (!f.kzBars) continue;
    console.log(chalk.gray(`    ${kz.padEnd(7)} bars:${f.kzBars.toString().padStart(5)}  sweeps:${f.sweeps.toString().padStart(4)}  fvgs:${f.fvgs.toString().padStart(4)}  bos:${f.mss.toString().padStart(4)}  trades:${f.trades.toString().padStart(3)}`));
  }

  const statsLimit  = printResults('ENTRY A — FVG LIMIT ORDER',   signalsLimit,  stateLimit,  chalk.bold.cyan);
  const statsMarket = printResults('ENTRY B — MARKET ORDER AT BOS CLOSE', signalsMarket, stateMarket, chalk.bold.magenta);

  // ─── Side-by-side comparison ──────────────────────────────────────────────
  console.log('\n' + sep);
  console.log(chalk.bold.white('  ══ ENTRY METHOD COMPARISON ══'));
  console.log(sep);
  console.log(chalk.gray('  Metric             FVG Limit           Market Order'));
  console.log(chalk.gray('  ─────────────────────────────────────────────────'));
  const fmt = (n, isR=false) => String(isR ? (n>=0?'+':'')+n.toFixed(2)+'R' : n).padStart(18);
  const row = (label, a, b) => console.log(chalk.gray(`  ${label.padEnd(18)} `) + chalk.cyan(String(a).padEnd(20)) + chalk.magenta(String(b)));
  row('Trades', statsLimit.filled + (statsLimit.missed||0) + ' sig / ' + statsLimit.filled + ' fill', statsMarket.filled + ' trades');
  row('Win Rate', statsLimit.winRate, statsMarket.winRate);
  row('Net R', (statsLimit.netR>=0?'+':'')+statsLimit.netR+'R', (statsMarket.netR>=0?'+':'')+statsMarket.netR+'R');
  row('Return', statsLimit.account.returnPct+'%', statsMarket.account.returnPct+'%');
  row('Max Drawdown', statsLimit.account.maxDrawdown+'%', statsMarket.account.maxDrawdown+'%');
  row('End Balance', '£'+statsLimit.account.end, '£'+statsMarket.account.end);
  console.log('\n' + sep + '\n');

  fs.writeFileSync(path.join(__dirname, '..', 'backtest_report_xau_v3.json'),
    JSON.stringify({ period:'2025-06-11 → 2026-06-10', method:'ICT v3 — 9 fixes applied',
      generatedAt: new Date().toISOString(), funnel,
      entryLimit: statsLimit, entryMarket: statsMarket,
      signalsLimit, signalsMarket }, null, 2));
  console.log(chalk.gray('  Report → backtest_report_xau_v3.json\n'));
}

run();
