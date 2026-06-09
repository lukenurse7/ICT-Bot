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

  // Equal lows (SSL) — two swing lows within 0.15% of each other (tightened from 0.3%)
  const eqLows = [];
  for (let i = 0; i < m5Swings.lows.length - 1; i++) {
    const l1 = m5Swings.lows[i], l2 = m5Swings.lows[i + 1];
    const diff = Math.abs(l1.price - l2.price) / l1.price;
    if (diff < 0.0015) eqLows.push({ price: (l1.price + l2.price) / 2, time: l2.time, label: 'Equal Lows (SSL)' });
  }
  // Equal highs (BSL) — tightened to 0.15%
  const eqHighs = [];
  for (let i = 0; i < m5Swings.highs.length - 1; i++) {
    const h1 = m5Swings.highs[i], h2 = m5Swings.highs[i + 1];
    const diff = Math.abs(h1.price - h2.price) / h1.price;
    if (diff < 0.0015) eqHighs.push({ price: (h1.price + h2.price) / 2, time: h2.time, label: 'Equal Highs (BSL)' });
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
  const prevCandle = candles5m[candles5m.length - 2];
  relevant.sort((a, b) => Math.abs(a.mid - current) - Math.abs(b.mid - current));
  const best = relevant[0];

  // ── Confirmation candle check ─────────────────────────────────────────────
  // ICT entry rule: price must WICK into/through FVG on previous candle,
  // then CLOSE back inside it. Entering on first touch = catching falling knife.
  //
  // For bearish FVG (SELL setup):
  //   prev candle wicked UP into FVG (prev.high >= fvg.bottom)
  //   prev candle closed INSIDE or BELOW fvg (prev.close <= fvg.top)
  //   current price is at or near FVG (ready to enter on this candle open)
  //
  // For bullish FVG (BUY setup):
  //   prev candle wicked DOWN into FVG (prev.low <= fvg.top)
  //   prev candle closed INSIDE or ABOVE fvg (prev.close >= fvg.bottom)

  const dir = sweep.dir;
  let confirmedEntry = false;
  let wickValid      = false;

  if (dir === 'bear') {
    // Wick up into FVG zone
    const wickedIn = prevCandle.high >= best.bottom;
    // Closed back inside or below (rejection confirmed)
    const closedBack = prevCandle.close <= best.top;
    // Minimum wick depth: wick into FVG must be at least 50% of FVG size
    const wickDepth = prevCandle.high - best.bottom;
    wickValid = wickDepth >= best.size * 0.5;
    confirmedEntry = wickedIn && closedBack && wickValid;
  } else {
    const wickedIn   = prevCandle.low <= best.top;
    const closedBack = prevCandle.close >= best.bottom;
    const wickDepth  = best.top - prevCandle.low;
    wickValid = wickDepth >= best.size * 0.5;
    confirmedEntry = wickedIn && closedBack && wickValid;
  }

  // inFVG is now gated by confirmation candle — not just price touching zone
  const inFVG = confirmedEntry;

  return {
    ...best,
    inFVG,
    confirmedEntry,
    wickValid,
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

// ─── 7. LIQUIDITY TARGET SCANNER ─────────────────────────────────────────────

// Scan candles for equal highs or equal lows (2+ touches within tolerance)
function findEqualLevels(candles, dir, lookback = 30, tol = 2.5) {
  const slice = candles.slice(-lookback);
  const levels = [];
  const prices = dir === 'bear'
    ? slice.map(c => c.low)   // equal lows below = sell-side liquidity (SSL)
    : slice.map(c => c.high); // equal highs above = buy-side liquidity (BSL)

  for (let i = 0; i < prices.length; i++) {
    const p = prices[i];
    const touches = prices.filter(x => Math.abs(x - p) <= tol).length;
    if (touches >= 2) levels.push({ price: p, touches, source: `5m equal ${dir === 'bear' ? 'lows' : 'highs'}` });
  }
  // Deduplicate — group levels within tolerance
  const deduped = [];
  for (const l of levels) {
    if (!deduped.find(d => Math.abs(d.price - l.price) <= tol)) deduped.push(l);
  }
  return deduped;
}

// Scan H1 candles for swing highs/lows from last N candles
function findH1SwingLevels(h1Candles, dir, lookback = 10) {
  const slice = h1Candles.slice(-lookback);
  if (dir === 'bear') {
    // Swing lows below = sell-side liquidity targets
    return slice.map(c => ({ price: c.low,  source: '1H swing low' }))
                .sort((a, b) => b.price - a.price); // highest first (closest to entry for SELL)
  } else {
    return slice.map(c => ({ price: c.high, source: '1H swing high' }))
                .sort((a, b) => a.price - b.price); // lowest first (closest to entry for BUY)
  }
}

// Multi-timeframe liquidity target hierarchy
// Returns { tp2, tp2Desc, tp3, tp3Desc }
function liquidityTargets(dir, entry, risk, levels, candles5m, h1Candles) {
  const isLong = dir === 'bull';
  const minR   = 1.5; // must be beyond TP1
  const maxR   = 4.0; // cap — don't reach for daily moves on a 5m entry

  function inRange(price) {
    const r = Math.abs(price - entry) / risk;
    return r > minR && r <= maxR;
  }

  // Candidate pool — ordered from closest to furthest
  const candidates = [];

  // 1. 5m equal lows/highs (intraday liquidity pools, swept fast)
  const eq5m = findEqualLevels(candles5m, isLong ? 'bull' : 'bear', 40, 2.5);
  for (const l of eq5m) {
    if (isLong ? l.price > entry : l.price < entry) candidates.push(l);
  }

  // 2. 1H swing lows/highs (session-level targets)
  const h1Swings = findH1SwingLevels(h1Candles, isLong ? 'bull' : 'bear', 12);
  for (const l of h1Swings) {
    if (isLong ? l.price > entry : l.price < entry) candidates.push(l);
  }

  // 3. Asia session high/low
  if (levels.asiaHigh && isLong && levels.asiaHigh > entry) candidates.push({ price: levels.asiaHigh, source: 'Asia High (BSL)' });
  if (levels.asiaLow  && !isLong && levels.asiaLow  < entry) candidates.push({ price: levels.asiaLow,  source: 'Asia Low (SSL)' });

  // 4. PDH/PDL — only if within maxR
  if (isLong && levels.pdh && levels.pdh > entry) candidates.push({ price: levels.pdh, source: 'PDH (BSL)' });
  if (!isLong && levels.pdl && levels.pdl < entry) candidates.push({ price: levels.pdl, source: 'PDL (SSL)' });

  // Sort by distance from entry (nearest first)
  candidates.sort((a, b) => Math.abs(a.price - entry) - Math.abs(b.price - entry));

  // Pick TP2 = first candidate within range
  const tp2Candidate = candidates.find(c => inRange(c.price));
  const tp2     = tp2Candidate ? tp2Candidate.price : (isLong ? entry + risk * 2.5 : entry - risk * 2.5);
  const tp2Desc = tp2Candidate ? tp2Candidate.source : 'Fixed 2.5R (no liquidity in range)';

  // Pick TP3 = next candidate beyond TP2
  const tp3Candidates = candidates.filter(c => {
    const r = Math.abs(c.price - entry) / risk;
    return r > Math.abs(tp2 - entry) / risk + 0.5 && r <= 6;
  });
  const tp3Candidate = tp3Candidates[0];
  const tp3     = tp3Candidate ? tp3Candidate.price
    : (isLong ? (levels.pwh && levels.pwh > tp2 ? levels.pwh : entry + risk * 5)
              : (levels.pwl && levels.pwl < tp2 ? levels.pwl : entry - risk * 5));
  const tp3Desc = tp3Candidate ? tp3Candidate.source : (isLong ? 'PWH extension' : 'PWL extension');

  return { tp2: parseFloat(tp2.toFixed(2)), tp2Desc, tp3: parseFloat(tp3.toFixed(2)), tp3Desc };
}

// ─── 7b. TP / SL CALCULATION ─────────────────────────────────────────────────

// Max risk in points — signals with wider stops are skipped
const MAX_RISK_PTS = 15;

function calcLevels(dir, entry, sweep, levels, fvg, ob, candles5m, h1Candles) {
  const isLong = dir === 'bull';
  const buf = entry * 0.0008;

  let sl;
  if (isLong) {
    const rawSL = sweep.sweepLow !== undefined ? sweep.sweepLow - buf : entry - entry * 0.004;
    sl = Math.min(rawSL, entry - buf * 2);
  } else {
    const sweepSL = sweep.sweepHigh !== undefined ? sweep.sweepHigh + buf : entry + entry * 0.004;
    const obSL    = ob?.high ? ob.high + buf : 0;
    const fvgSL   = fvg?.top ? fvg.top + buf : 0;
    const rawSL   = Math.max(sweepSL, obSL, fvgSL);
    sl = Math.max(rawSL, entry + buf * 2);
  }

  const risk = Math.abs(entry - sl);
  const tp1  = isLong ? entry + risk * 1.5 : entry - risk * 1.5;

  // TP2/TP3 from liquidity hierarchy
  const { tp2, tp2Desc, tp3, tp3Desc } = liquidityTargets(dir, entry, risk, levels, candles5m, h1Candles);

  const rr1 = (Math.abs(tp1 - entry) / risk).toFixed(1);
  const rr2 = (Math.abs(tp2 - entry) / risk).toFixed(1);

  return {
    entry:      parseFloat(entry.toFixed(2)),
    sl:         parseFloat(sl.toFixed(2)),
    tp1:        parseFloat(tp1.toFixed(2)),
    tp2, tp3, rr1, rr2,
    riskPoints: parseFloat(risk.toFixed(2)),
    slDesc:     isLong ? 'Below sweep low + buffer' : 'Above sweep high + buffer',
    tp1Desc:    '1.5R — 50% close, SL to breakeven',
    tp2Desc,
    tp3Desc
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
      score += 5; reasons.push('✅ Confirmation candle — wick into FVG + close back inside, entry confirmed');
    } else if (fvg.wickValid === false) {
      reasons.push(`⏳ FVG touched but wick too shallow — waiting for proper rejection wick`);
    } else {
      reasons.push(`⏳ FVG at ${fvg.entryZone} — waiting for confirmation candle (wick in + close back)`);
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
  const { daily, h4, h1, m15, m5, quote } = data;

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

  // Require FVG for entry (33% win rate without vs 63% with)
  // AND price must be inside the FVG zone (no premature entries)
  const fvgReady = fvg && fvg.inFVG;

  // HTF bias hard gate for XAUUSD — only trade in direction Daily+4H structure points
  const htfAligned = (dir === 'bull' && (htf.bias === 'bullish' || htf.bias === 'pullback_in_bear'))
                  || (dir === 'bear' && (htf.bias === 'bearish' || htf.bias === 'pullback_in_bull'));

  // Kill zone hard gate — only fire during London (07:00-09:00) or NY (12:00-15:00) UTC
  const inKillZone = sessionStatus?.active === true;

  if (dir && mss.confirmed && confluence.score >= minScore && fvgReady && htfAligned && inKillZone) {
    const entryPrice = fvg.optimalEntry;
    const levels = calcLevels(dir, entryPrice, sweepResult.mostRecent, lvls, fvg, ob, m5, h1);

    // Skip if SL is still wrong side or risk is too wide
    const slValid = dir === 'bull' ? levels.sl < levels.entry : levels.sl > levels.entry;
    if (!slValid || levels.riskPoints > MAX_RISK_PTS) {
      return {
        htf, lvls, sweepResult, mss, fvg, ob, confluence,
        signal: null, quote,
        waitReason: !slValid
          ? 'Setup invalid — SL calculation error, skipping'
          : `Risk too wide (${levels.riskPoints.toFixed(1)}pts > ${MAX_RISK_PTS}pts max) — waiting for tighter setup`
      };
    }

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

  const htfBlockReason = (dir && mss.confirmed && fvgReady && !htfAligned)
    ? `HTF bias is ${htf.bias.toUpperCase().replace(/_/g,' ')} — ${dir === 'bull' ? 'BUY' : 'SELL'} blocked until Daily+4H align`
    : null;
  const kzBlockReason = (dir && mss.confirmed && fvgReady && htfAligned && !inKillZone)
    ? `Setup ready but outside kill zone (${sessionStatus?.label || 'off-hours'}) — waiting for London/NY window`
    : null;

  return {
    htf, lvls, sweepResult, mss, fvg, ob, confluence,
    signal, quote,
    canUpdate: !!sweepResult.mostRecent,
    waitReason: htfBlockReason || kzBlockReason
      || (!sweepResult.mostRecent
        ? 'Waiting for liquidity sweep on key levels'
        : !mss.confirmed
        ? `Sweep on ${sweepResult.mostRecent.levelName} — waiting for 5m MSS/BOS`
        : !fvg
        ? 'MSS confirmed — waiting for FVG to form from displacement'
        : !fvg.inFVG
        ? `FVG at ${fvg.entryZone} — waiting for pullback INTO the zone`
        : null)
  };
}

module.exports = {
  runAnalysis, htfBias, keyLevels, detectLiquiditySweep,
  detectMSS, findFVGs, entryFVG, findOrderBlock, scoreConfluence,
  liquidityTargets
};
