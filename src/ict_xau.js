'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  ICT ANALYSIS ENGINE — XAUUSD
//  Model: HTF Bias → Liquidity Sweep → MSS (5m) → FVG entry → TP/SL
// ═══════════════════════════════════════════════════════════════════════════

// ─── 1. SWING STRUCTURE ─────────────────────────────────────────────────────

function findSwings(candles, lookback = 3) {
  const highs = [], lows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    const isHigh = candles.slice(i - lookback, i).every(x => x.high <= c.high) &&
                   candles.slice(i + 1, i + lookback + 1).every(x => x.high <= c.high);
    const isLow  = candles.slice(i - lookback, i).every(x => x.low  >= c.low)  &&
                   candles.slice(i + 1, i + lookback + 1).every(x => x.low  >= c.low);
    if (isHigh) highs.push({ price: c.high, time: c.time, index: i });
    if (isLow)  lows.push ({ price: c.low,  time: c.time, index: i });
  }
  return { highs, lows };
}

function htfBias(dailyCandles, h4Candles) {
  // Determine HTF bias from Daily + 4H structure
  const dSwings = findSwings(dailyCandles, 2);
  const h4Swings = findSwings(h4Candles, 3);

  function structureDir(swings) {
    const { highs, lows } = swings;
    if (highs.length < 2 || lows.length < 2) return 'ranging';
    const lastH = highs.slice(-2);
    const lastL = lows.slice(-2);
    const hh = lastH[1].price > lastH[0].price;
    const hl = lastL[1].price > lastL[0].price;
    const lh = lastH[1].price < lastH[0].price;
    const ll = lastL[1].price < lastL[0].price;
    if (hh && hl) return 'bullish';
    if (lh && ll) return 'bearish';
    return 'ranging';
  }

  const daily  = structureDir(dSwings);
  const h4     = structureDir(h4Swings);

  // Consensus bias
  let bias = 'ranging';
  if (daily === 'bullish' && (h4 === 'bullish' || h4 === 'ranging')) bias = 'bullish';
  if (daily === 'bearish' && (h4 === 'bearish' || h4 === 'ranging')) bias = 'bearish';
  if (daily === 'bullish' && h4 === 'bearish') bias = 'pullback_in_bull'; // wait
  if (daily === 'bearish' && h4 === 'bullish') bias = 'pullback_in_bear'; // wait

  return {
    bias,
    daily,
    h4,
    dailySwings: dSwings,
    h4Swings,
    description: biasDesc(bias)
  };
}

function biasDesc(b) {
  const m = {
    bullish:          'Daily + 4H both bullish — look for BUY setups only',
    bearish:          'Daily + 4H both bearish — look for SELL setups only',
    pullback_in_bull: 'Daily bullish but 4H bearish — wait for 4H pullback to complete',
    pullback_in_bear: 'Daily bearish but 4H bullish — wait for 4H retrace to complete',
    ranging:          'No clear HTF direction — stand aside or trade range extremes only'
  };
  return m[b] || b;
}

// ─── 2. KEY LEVELS ──────────────────────────────────────────────────────────

function keyLevels(dailyCandles, asiaRange) {
  const prev = dailyCandles[dailyCandles.length - 2];
  const today = dailyCandles[dailyCandles.length - 1];

  // Previous week high/low from daily candles
  const weekCandles = dailyCandles.slice(-7);
  const pwh = Math.max(...weekCandles.slice(0,-1).map(c => c.high));
  const pwl = Math.min(...weekCandles.slice(0,-1).map(c => c.low));

  return {
    pdh: prev.high,   // Previous Day High  (key BSL target)
    pdl: prev.low,    // Previous Day Low   (key SSL target)
    pwh,              // Previous Week High
    pwl,              // Previous Week Low
    todayOpen: today.open,
    asiaHigh: asiaRange?.high || null,
    asiaLow:  asiaRange?.low  || null
  };
}

// ─── 3. LIQUIDITY SWEEP DETECTION ──────────────────────────────────────────

function detectLiquiditySweep(candles5m, levels, htfBiasResult) {
  // A sweep = price wicks THROUGH a key level, then CLOSES BACK inside it
  // For a LONG setup: price sweeps below PDL / Asia Low / recent 5m lows → reversal
  // For a SHORT setup: price sweeps above PDH / Asia High / recent 5m highs → reversal

  const last20 = candles5m.slice(-20);
  const current = candles5m[candles5m.length - 1];
  const sweeps = [];

  function checkSweep(level, levelName, dir) {
    if (!level) return;
    for (let i = 5; i < last20.length - 1; i++) {
      const c = last20[i];
      const prevClose = last20[i - 1].close;
      const nextClose = last20[i + 1]?.close;

      if (dir === 'bull') {
        // Sweep low: wick below level, close back above
        if (c.low < level && c.close > level && prevClose > level) {
          sweeps.push({
            dir: 'bull',
            level,
            levelName,
            sweepLow: c.low,
            wickBelow: level - c.low,
            candleTime: c.time,
            candleIndex: candles5m.length - 20 + i,
            barsAgo: last20.length - 1 - i,
            strength: Math.min(100, Math.round(((level - c.low) / level) * 10000))
          });
        }
      } else {
        // Sweep high: wick above level, close back below
        if (c.high > level && c.close < level && prevClose < level) {
          sweeps.push({
            dir: 'bear',
            level,
            levelName,
            sweepHigh: c.high,
            wickAbove: c.high - level,
            candleTime: c.time,
            candleIndex: candles5m.length - 20 + i,
            barsAgo: last20.length - 1 - i,
            strength: Math.min(100, Math.round(((c.high - level) / level) * 10000))
          });
        }
      }
    }
  }

  // Bull sweeps (SSL hunts — looking for LONG after sweep)
  const bullAllowed = ['bullish','pullback_in_bull','ranging'].includes(htfBiasResult.bias);
  const bearAllowed = ['bearish','pullback_in_bear','ranging'].includes(htfBiasResult.bias);

  if (bullAllowed) {
    checkSweep(levels.pdl,      'PDL (Prev Day Low)',    'bull');
    checkSweep(levels.asiaLow,  'Asia Session Low',      'bull');
    checkSweep(levels.pwl,      'Prev Week Low',         'bull');
  }
  if (bearAllowed) {
    checkSweep(levels.pdh,      'PDH (Prev Day High)',   'bear');
    checkSweep(levels.asiaHigh, 'Asia Session High',     'bear');
    checkSweep(levels.pwh,      'Prev Week High',        'bear');
  }

  // Also detect equal highs/lows on recent 5m swings as liquidity pools
  const m5Swings = findSwings(candles5m.slice(-60), 2);

  // Equal lows (SSL) — two swing lows within 0.3% of each other
  const eqLows = [];
  for (let i = 0; i < m5Swings.lows.length - 1; i++) {
    const l1 = m5Swings.lows[i], l2 = m5Swings.lows[i + 1];
    const diff = Math.abs(l1.price - l2.price) / l1.price;
    if (diff < 0.003) eqLows.push({ price: (l1.price + l2.price) / 2, time: l2.time, label: 'Equal Lows (SSL)' });
  }
  // Equal highs (BSL)
  const eqHighs = [];
  for (let i = 0; i < m5Swings.highs.length - 1; i++) {
    const h1 = m5Swings.highs[i], h2 = m5Swings.highs[i + 1];
    const diff = Math.abs(h1.price - h2.price) / h1.price;
    if (diff < 0.003) eqHighs.push({ price: (h1.price + h2.price) / 2, time: h2.time, label: 'Equal Highs (BSL)' });
  }

  if (bullAllowed) {
    eqLows.forEach(el => checkSweep(el.price, el.label, 'bull'));
  }
  if (bearAllowed) {
    eqHighs.forEach(eh => checkSweep(eh.price, eh.label, 'bear'));
  }

  // Return most recent sweep, sorted by recency
  sweeps.sort((a, b) => a.barsAgo - b.barsAgo);
  return { sweeps, mostRecent: sweeps[0] || null, eqLows, eqHighs };
}

// ─── 4. MARKET STRUCTURE SHIFT (MSS) ────────────────────────────────────────

function detectMSS(candles5m, sweepResult) {
  if (!sweepResult.mostRecent) return { confirmed: false, reason: 'No sweep detected' };

  const sweep = sweepResult.mostRecent;
  const postSweep = candles5m.slice(sweep.candleIndex);

  if (postSweep.length < 3) return { confirmed: false, reason: 'Insufficient post-sweep candles' };

  const swings = findSwings(postSweep, 1);

  if (sweep.dir === 'bull') {
    // After sweeping lows, need price to break a recent swing HIGH on 5m (BOS to upside)
    const recentHigh = postSweep.slice(0, Math.min(5, postSweep.length))
                                .reduce((max, c) => c.high > max ? c.high : max, 0);
    const breakCandle = postSweep.find(c => c.close > recentHigh && c.close > c.open);
    if (breakCandle) {
      return {
        confirmed: true,
        dir: 'bull',
        type: 'BOS_UP',
        brokenLevel: recentHigh,
        mssCandle: breakCandle,
        description: `5m BOS — closed above ${recentHigh.toFixed(2)} after SSL sweep`,
        barsAfterSweep: postSweep.indexOf(breakCandle)
      };
    }
    // Also check for a single strong displacement candle (CHoCH)
    const displace = postSweep.find((c, i) => i > 0 &&
      c.close > c.open &&
      (c.close - c.open) > (c.open - c.low) * 1.5 &&
      c.close > postSweep[0].high
    );
    if (displace) {
      return {
        confirmed: true, dir: 'bull', type: 'CHoCH',
        mssCandle: displace,
        description: '5m CHoCH — strong bullish displacement after sweep',
        barsAfterSweep: postSweep.indexOf(displace)
      };
    }
  }

  if (sweep.dir === 'bear') {
    // After sweeping highs, need price to break a recent swing LOW on 5m
    const recentLow = postSweep.slice(0, Math.min(5, postSweep.length))
                               .reduce((min, c) => c.low < min ? c.low : min, Infinity);
    const breakCandle = postSweep.find(c => c.close < recentLow && c.close < c.open);
    if (breakCandle) {
      return {
        confirmed: true,
        dir: 'bear',
        type: 'BOS_DOWN',
        brokenLevel: recentLow,
        mssCandle: breakCandle,
        description: `5m BOS — closed below ${recentLow.toFixed(2)} after BSL sweep`,
        barsAfterSweep: postSweep.indexOf(breakCandle)
      };
    }
    const displace = postSweep.find((c, i) => i > 0 &&
      c.close < c.open &&
      (c.open - c.close) > (c.high - c.open) * 1.5 &&
      c.close < postSweep[0].low
    );
    if (displace) {
      return {
        confirmed: true, dir: 'bear', type: 'CHoCH',
        mssCandle: displace,
        description: '5m CHoCH — strong bearish displacement after sweep',
        barsAfterSweep: postSweep.indexOf(displace)
      };
    }
  }

  return { confirmed: false, reason: 'No 5m structure break after sweep yet — waiting' };
}

// ─── 5. FAIR VALUE GAPS (FVG) ────────────────────────────────────────────────

function findFVGs(candles, afterIndex = 0) {
  const fvgs = [];
  const start = Math.max(1, afterIndex);

  for (let i = start; i < candles.length - 1; i++) {
    const c0 = candles[i - 1];
    const c1 = candles[i];
    const c2 = candles[i + 1];

    // Bullish FVG: c2.low > c0.high (gap between candle 1 low and candle 0 high)
    if (c2.low > c0.high) {
      const size = c2.low - c0.high;
      fvgs.push({
        type:   'bullish',
        top:    c2.low,
        bottom: c0.high,
        mid:    (c2.low + c0.high) / 2,
        size,
        time:   c1.time,
        index:  i,
        filled: false
      });
    }

    // Bearish FVG: c2.high < c0.low
    if (c2.high < c0.low) {
      const size = c0.low - c2.high;
      fvgs.push({
        type:   'bearish',
        top:    c0.low,
        bottom: c2.high,
        mid:    (c0.low + c2.high) / 2,
        size,
        time:   c1.time,
        index:  i,
        filled: false
      });
    }
  }

  // Mark filled FVGs (price traded through)
  const latest = candles[candles.length - 1];
  for (const fvg of fvgs) {
    if (fvg.type === 'bullish' && latest.low < fvg.bottom) fvg.filled = true;
    if (fvg.type === 'bearish' && latest.high > fvg.top)   fvg.filled = true;
  }

  return fvgs.filter(f => !f.filled);
}

function entryFVG(candles5m, mssResult, sweepResult) {
  if (!mssResult.confirmed) return null;

  const sweep = sweepResult.mostRecent;
  const mssIdx = candles5m.findIndex(c => c.time === mssResult.mssCandle?.time);
  if (mssIdx < 0) return null;

  // FVGs formed AFTER the sweep (displacement FVGs)
  const displaceFVGs = findFVGs(candles5m, sweep.candleIndex);

  // Filter to correct direction
  const dir = sweep.dir;
  const relevant = displaceFVGs.filter(f =>
    dir === 'bull' ? f.type === 'bullish' : f.type === 'bearish'
  );

  if (relevant.length === 0) return null;

  // Return the closest FVG to current price
  const current = candles5m[candles5m.length - 1].close;
  relevant.sort((a, b) => Math.abs(a.mid - current) - Math.abs(b.mid - current));
  const best = relevant[0];

  // Check if price is currently inside the FVG (optimal entry)
  const inFVG = current >= best.bottom && current <= best.top;

  return {
    ...best,
    inFVG,
    distanceToFVG: inFVG ? 0 : Math.abs(current - best.mid),
    entryZone: `${best.bottom.toFixed(2)} – ${best.top.toFixed(2)}`,
    optimalEntry: best.mid
  };
}

// ─── 6. ORDER BLOCKS ─────────────────────────────────────────────────────────

function findOrderBlock(candles5m, sweepResult) {
  if (!sweepResult.mostRecent) return null;
  const sweep = sweepResult.mostRecent;
  const idx = sweep.candleIndex;
  const slice = candles5m.slice(Math.max(0, idx - 5), idx + 10);

  if (sweep.dir === 'bull') {
    // Last bearish candle before the bullish displacement = bullish OB
    const bearCandles = slice.filter(c => c.close < c.open).reverse();
    if (bearCandles.length === 0) return null;
    const ob = bearCandles[0];
    return {
      type: 'bullish',
      high: ob.high, low: ob.low, eq: (ob.high + ob.low) / 2,
      time: ob.time,
      desc: 'Bullish OB — last bearish candle before displacement'
    };
  } else {
    // Last bullish candle before bearish displacement = bearish OB
    const bullCandles = slice.filter(c => c.close > c.open).reverse();
    if (bullCandles.length === 0) return null;
    const ob = bullCandles[0];
    return {
      type: 'bearish',
      high: ob.high, low: ob.low, eq: (ob.high + ob.low) / 2,
      time: ob.time,
      desc: 'Bearish OB — last bullish candle before displacement'
    };
  }
}

// ─── 7. TP / SL CALCULATION ──────────────────────────────────────────────────

function calcLevels(dir, entry, sweep, levels, fvg, candles5m) {
  const isLong = dir === 'bull';

  // SL: below sweep low (long) or above sweep high (short), +buffer
  const buf = entry * 0.0008; // 0.08% buffer (approx $2.50 on $3100 gold)
  let sl;
  if (isLong) {
    sl = sweep.sweepLow !== undefined
      ? sweep.sweepLow - buf
      : entry - (entry * 0.004);
  } else {
    sl = sweep.sweepHigh !== undefined
      ? sweep.sweepHigh + buf
      : entry + (entry * 0.004);
  }

  const risk = Math.abs(entry - sl);

  // TP1: 1.5R — partial profits
  // TP2: PDH/PDL or next liquidity pool (HTF target)
  // TP3: previous week H/L (full run target)
  const tp1 = isLong ? entry + risk * 1.5 : entry - risk * 1.5;

  let tp2, tp3;
  if (isLong) {
    tp2 = (levels.pdh && levels.pdh > entry + risk * 2) ? levels.pdh : entry + risk * 3;
    tp3 = (levels.pwh && levels.pwh > entry + risk * 3) ? levels.pwh : entry + risk * 5;
  } else {
    tp2 = (levels.pdl && levels.pdl < entry - risk * 2) ? levels.pdl : entry - risk * 3;
    tp3 = (levels.pwl && levels.pwl < entry - risk * 3) ? levels.pwl : entry - risk * 5;
  }

  const rr1 = (Math.abs(tp1 - entry) / risk).toFixed(1);
  const rr2 = (Math.abs(tp2 - entry) / risk).toFixed(1);

  return {
    entry:      parseFloat(entry.toFixed(2)),
    sl:         parseFloat(sl.toFixed(2)),
    tp1:        parseFloat(tp1.toFixed(2)),
    tp2:        parseFloat(tp2.toFixed(2)),
    tp3:        parseFloat(tp3.toFixed(2)),
    rr1, rr2,
    riskPoints: parseFloat(risk.toFixed(2)),
    slDesc:     isLong ? 'Below sweep low + buffer' : 'Above sweep high + buffer',
    tp1Desc:    '1.5R — partial close here',
    tp2Desc:    isLong ? 'PDH / Buy-side liquidity' : 'PDL / Sell-side liquidity',
    tp3Desc:    isLong ? 'Previous Week High' : 'Previous Week Low'
  };
}

// ─── 8. CONFLUENCE SCORING ───────────────────────────────────────────────────

function scoreConfluence(htf, sweep, mss, fvg, ob, session) {
  let score = 0;
  const reasons = [];

  // HTF bias aligned (max 25)
  if (htf.bias === 'bullish' && sweep?.mostRecent?.dir === 'bull') {
    score += 25; reasons.push('✅ Daily + 4H bias BULLISH — trade direction aligned');
  } else if (htf.bias === 'bearish' && sweep?.mostRecent?.dir === 'bear') {
    score += 25; reasons.push('✅ Daily + 4H bias BEARISH — trade direction aligned');
  } else if (['pullback_in_bull','pullback_in_bear'].includes(htf.bias)) {
    score += 10; reasons.push('⚠️ HTF in pullback — reduced score, wait for 4H confirmation');
  } else {
    reasons.push('❌ HTF bias not clearly aligned with trade direction');
  }

  // Liquidity sweep (max 25)
  if (sweep?.mostRecent) {
    const s = sweep.mostRecent;
    score += 20;
    reasons.push(`✅ Liquidity sweep: ${s.levelName} swept (${s.dir === 'bull' ? 'SSL' : 'BSL'} taken)`);
    if (s.barsAgo <= 3) { score += 5; reasons.push('✅ Sweep recent (≤3 bars ago) — fresh setup'); }
  } else {
    reasons.push('❌ No liquidity sweep detected on key levels');
  }

  // MSS confirmed (max 25)
  if (mss?.confirmed) {
    score += 20;
    reasons.push(`✅ 5m MSS confirmed: ${mss.type} — ${mss.description}`);
    if (mss.type === 'BOS_UP' || mss.type === 'BOS_DOWN') {
      score += 5; reasons.push('✅ Clean BOS (body close) — stronger than CHoCH');
    }
  } else {
    reasons.push(`❌ MSS not yet confirmed — ${mss?.reason || 'waiting'}`);
  }

  // FVG present (max 15)
  if (fvg) {
    score += 10;
    reasons.push(`✅ FVG identified: ${fvg.entryZone} (${fvg.type})`);
    if (fvg.inFVG) {
      score += 5; reasons.push('✅ Price currently INSIDE FVG — optimal entry zone');
    } else {
      reasons.push(`⏳ Price approaching FVG — wait for entry into ${fvg.entryZone}`);
    }
  } else {
    reasons.push('⚠️ No FVG found post-MSS — use OB for entry or wait');
  }

  // Order block (max 5)
  if (ob) {
    score += 5;
    reasons.push(`✅ OB identified at ${ob.eq?.toFixed(2)} — ${ob.desc}`);
  }

  // Kill zone (max 10)
  if (session?.active) {
    score += 10;
    reasons.push(`✅ Inside kill zone: ${session.label}`);
  } else {
    reasons.push(`⚠️ Outside kill zone — ${session?.label}`);
  }

  return {
    score: Math.min(score, 100),
    grade: score >= 80 ? 'A' : score >= 65 ? 'B' : score >= 50 ? 'C' : 'D',
    reasons
  };
}

// ─── 9. MASTER ANALYSIS ──────────────────────────────────────────────────────

function runAnalysis(data, asiaRange, sessionStatus) {
  const { daily, h4, m15, m5, quote } = data;

  // Step 1: HTF bias
  const htf = htfBias(daily, h4);

  // Step 2: Key levels
  const lvls = keyLevels(daily, asiaRange);

  // Step 3: Liquidity sweeps on 15m and 5m
  const sweepResult15m = detectLiquiditySweep(m15, lvls, htf);
  const sweepResult5m  = detectLiquiditySweep(m5,  lvls, htf);

  // Use 5m sweeps if fresh, else fall back to 15m
  const sweepResult = sweepResult5m.mostRecent
    ? sweepResult5m
    : sweepResult15m;

  // Step 4: MSS on 5m
  const mss = detectMSS(m5, sweepResult);

  // Step 5: FVG post-MSS
  const fvg = entryFVG(m5, mss, sweepResult);

  // Step 6: Order block
  const ob = findOrderBlock(m5, sweepResult);

  // Step 7: Confluence score
  const confluence = scoreConfluence(htf, sweepResult, mss, fvg, ob, sessionStatus);

  // Step 8: Signal generation
  let signal = null;
  const dir = sweepResult.mostRecent?.dir;
  const minScore = parseInt(process.env.MIN_CONFLUENCE || '60');

  // Only fire when price has actually pulled back INTO the FVG (or no FVG — use OB)
  // Prevents entering at a price that doesn't exist yet
  const fvgReady = !fvg || fvg.inFVG;

  if (dir && mss.confirmed && confluence.score >= minScore && fvgReady) {
    const entryPrice = fvg?.optimalEntry || ob?.eq || quote.price;
    const levels = calcLevels(dir, entryPrice, sweepResult.mostRecent, lvls, fvg, m5);

    signal = {
      direction:   dir === 'bull' ? 'BUY' : 'SELL',
      symbol:      'XAUUSD',
      entry:       levels.entry,
      sl:          levels.sl,
      tp1:         levels.tp1,
      tp2:         levels.tp2,
      tp3:         levels.tp3,
      rr1:         levels.rr1,
      rr2:         levels.rr2,
      riskPoints:  levels.riskPoints,
      slDesc:      levels.slDesc,
      tp1Desc:     levels.tp1Desc,
      tp2Desc:     levels.tp2Desc,
      tp3Desc:     levels.tp3Desc,
      confluence:  confluence.score,
      grade:       confluence.grade,
      timestamp:   new Date().toISOString(),
      setup: {
        htfBias:     htf.bias,
        htfDaily:    htf.daily,
        htfH4:       htf.h4,
        sweep:       sweepResult.mostRecent,
        mss,
        fvg,
        ob,
        keyLevels:   lvls,
        session:     sessionStatus
      }
    };
  }

  return {
    htf, lvls, sweepResult, mss, fvg, ob, confluence,
    signal, quote,
    canUpdate: !!sweepResult.mostRecent,
    waitReason: !sweepResult.mostRecent
      ? 'Waiting for liquidity sweep'
      : !mss.confirmed
      ? `Sweep found on ${sweepResult.mostRecent.levelName} — waiting for MSS`
      : !fvg
      ? 'MSS confirmed — waiting for FVG to form'
      : !fvg.inFVG
      ? `FVG at ${fvg.entryZone} — waiting for price to pull back INTO the zone`
      : null
  };
}

module.exports = {
  runAnalysis, htfBias, keyLevels, detectLiquiditySweep,
  detectMSS, findFVGs, entryFVG, findOrderBlock, scoreConfluence
};
