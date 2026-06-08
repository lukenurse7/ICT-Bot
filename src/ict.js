'use strict';

// ─── ICT Analysis Engine ───────────────────────────────────────────────────
// Implements: MSS/BOS/CHoCH, Order Blocks, FVG, Liquidity Pools, EQ levels

function detectMarketStructure(candles) {
  // candles: array of { time, open, high, low, close }
  // Returns swing highs/lows and structure direction
  const swingHighs = [];
  const swingLows = [];

  for (let i = 2; i < candles.length - 2; i++) {
    const c = candles[i];
    // Swing high: higher than 2 candles on each side
    if (
      c.high > candles[i - 1].high &&
      c.high > candles[i - 2].high &&
      c.high > candles[i + 1].high &&
      c.high > candles[i + 2].high
    ) {
      swingHighs.push({ index: i, price: c.high, time: c.time });
    }
    // Swing low: lower than 2 candles on each side
    if (
      c.low < candles[i - 1].low &&
      c.low < candles[i - 2].low &&
      c.low < candles[i + 1].low &&
      c.low < candles[i + 2].low
    ) {
      swingLows.push({ index: i, price: c.low, time: c.time });
    }
  }

  // Determine HTF bias from last 3 swing highs/lows
  const lastHighs = swingHighs.slice(-3);
  const lastLows = swingLows.slice(-3);
  let bias = 'ranging';

  if (lastHighs.length >= 2 && lastLows.length >= 2) {
    const hhPattern = lastHighs[lastHighs.length - 1].price > lastHighs[lastHighs.length - 2].price;
    const hlPattern = lastLows[lastLows.length - 1].price > lastLows[lastLows.length - 2].price;
    const lhPattern = lastHighs[lastHighs.length - 1].price < lastHighs[lastHighs.length - 2].price;
    const llPattern = lastLows[lastLows.length - 1].price < lastLows[lastLows.length - 2].price;

    if (hhPattern && hlPattern) bias = 'bullish';
    else if (lhPattern && llPattern) bias = 'bearish';
  }

  // Detect MSS — price breaking a previous swing high/low
  const lastCandle = candles[candles.length - 1];
  let mss = null;

  if (lastHighs.length >= 2) {
    const prevSwingHigh = lastHighs[lastHighs.length - 2];
    if (lastCandle.close > prevSwingHigh.price) {
      mss = { type: 'bullish_bos', level: prevSwingHigh.price, time: lastCandle.time };
    }
  }
  if (lastLows.length >= 2) {
    const prevSwingLow = lastLows[lastLows.length - 2];
    if (lastCandle.close < prevSwingLow.price) {
      mss = { type: 'bearish_bos', level: prevSwingLow.price, time: lastCandle.time };
    }
  }

  return { bias, swingHighs, swingLows, mss };
}

function findOrderBlocks(candles, bias) {
  // OB = last down candle before a bullish move up (bullish OB)
  //      last up candle before a bearish move down (bearish OB)
  const obs = [];

  for (let i = 1; i < candles.length - 3; i++) {
    const c = candles[i];
    const next1 = candles[i + 1];
    const next2 = candles[i + 2];
    const next3 = candles[i + 3];

    // Bullish OB: bearish candle followed by 3 bullish closes above it
    if (
      c.close < c.open &&
      next1.close > c.high &&
      next2.close > c.high &&
      next3.close > c.high
    ) {
      obs.push({
        type: 'bullish',
        high: c.high,
        low: c.low,
        eq: (c.high + c.low) / 2,
        time: c.time,
        index: i,
        mitigated: false
      });
    }

    // Bearish OB: bullish candle followed by 3 bearish closes below it
    if (
      c.close > c.open &&
      next1.close < c.low &&
      next2.close < c.low &&
      next3.close < c.low
    ) {
      obs.push({
        type: 'bearish',
        high: c.high,
        low: c.low,
        eq: (c.high + c.low) / 2,
        time: c.time,
        index: i,
        mitigated: false
      });
    }
  }

  // Mark mitigated OBs (price has traded back through them)
  const lastClose = candles[candles.length - 1].close;
  for (const ob of obs) {
    if (ob.type === 'bullish' && lastClose < ob.low) ob.mitigated = true;
    if (ob.type === 'bearish' && lastClose > ob.high) ob.mitigated = true;
  }

  // Return most recent unmitigated OBs
  const active = obs.filter(o => !o.mitigated);
  const nearest = {
    bullish: active.filter(o => o.type === 'bullish').slice(-1)[0] || null,
    bearish: active.filter(o => o.type === 'bearish').slice(-1)[0] || null
  };

  return nearest;
}

function findFairValueGaps(candles) {
  // FVG = 3-candle pattern where candle[i+2].low > candle[i].high (bullish)
  //       or candle[i+2].high < candle[i].low (bearish)
  const fvgs = [];

  for (let i = 0; i < candles.length - 2; i++) {
    const c0 = candles[i];
    const c2 = candles[i + 2];

    // Bullish FVG
    if (c2.low > c0.high) {
      fvgs.push({
        type: 'bullish',
        top: c2.low,
        bottom: c0.high,
        mid: (c2.low + c0.high) / 2,
        time: candles[i + 1].time,
        filled: false
      });
    }

    // Bearish FVG
    if (c2.high < c0.low) {
      fvgs.push({
        type: 'bearish',
        top: c0.low,
        bottom: c2.high,
        mid: (c0.low + c2.high) / 2,
        time: candles[i + 1].time,
        filled: false
      });
    }
  }

  // Mark filled FVGs
  const lastCandle = candles[candles.length - 1];
  for (const fvg of fvgs) {
    if (fvg.type === 'bullish' && lastCandle.low <= fvg.bottom) fvg.filled = true;
    if (fvg.type === 'bearish' && lastCandle.high >= fvg.top) fvg.filled = true;
  }

  const active = fvgs.filter(f => !f.filled);
  return {
    bullish: active.filter(f => f.type === 'bullish').slice(-1)[0] || null,
    bearish: active.filter(f => f.type === 'bearish').slice(-1)[0] || null,
    all: active.slice(-5)
  };
}

function findLiquidityPools(candles) {
  // SSL: equal lows / recent swing lows (resting sell-side liquidity)
  // BSL: equal highs / recent swing highs (resting buy-side liquidity)
  const recent = candles.slice(-50);
  const highs = recent.map(c => c.high).sort((a, b) => b - a);
  const lows = recent.map(c => c.low).sort((a, b) => a - b);

  // Cluster nearby highs/lows (within 20 pts) as equal levels
  function cluster(arr, threshold = 20) {
    const pools = [];
    let i = 0;
    while (i < arr.length) {
      let group = [arr[i]];
      let j = i + 1;
      while (j < arr.length && Math.abs(arr[j] - arr[i]) < threshold) {
        group.push(arr[j]);
        j++;
      }
      if (group.length >= 2) {
        pools.push(group.reduce((a, b) => a + b, 0) / group.length);
      }
      i = j;
    }
    return pools;
  }

  const bsl = cluster(highs).slice(0, 3); // buy-side liquidity above
  const ssl = cluster(lows).slice(0, 3);  // sell-side liquidity below

  const currentPrice = candles[candles.length - 1].close;

  return {
    bsl: bsl.filter(p => p > currentPrice),
    ssl: ssl.filter(p => p < currentPrice),
    nearestBSL: bsl.find(p => p > currentPrice) || null,
    nearestSSL: ssl.find(p => p < currentPrice) || null
  };
}

function scoreConfluence(analysis, currentPrice, direction) {
  let score = 0;
  const tags = [];

  const { structure, orderBlocks, fvgs, liquidity } = analysis;

  // 1. HTF bias alignment
  if (direction === 'long' && structure.bias === 'bullish') { score += 25; tags.push('HTF_BULL'); }
  if (direction === 'short' && structure.bias === 'bearish') { score += 25; tags.push('HTF_BEAR'); }

  // 2. Order Block
  if (direction === 'long' && orderBlocks.bullish) {
    const ob = orderBlocks.bullish;
    if (currentPrice >= ob.low && currentPrice <= ob.high) {
      score += 20; tags.push('OB');
    } else if (currentPrice > ob.low && currentPrice < ob.high * 1.002) {
      score += 10; tags.push('OB_NEAR');
    }
  }
  if (direction === 'short' && orderBlocks.bearish) {
    const ob = orderBlocks.bearish;
    if (currentPrice >= ob.low && currentPrice <= ob.high) {
      score += 20; tags.push('OB');
    }
  }

  // 3. FVG
  if (direction === 'long' && fvgs.bullish) {
    const fvg = fvgs.bullish;
    if (currentPrice >= fvg.bottom && currentPrice <= fvg.top) {
      score += 15; tags.push('FVG');
    }
  }
  if (direction === 'short' && fvgs.bearish) {
    const fvg = fvgs.bearish;
    if (currentPrice >= fvg.bottom && currentPrice <= fvg.top) {
      score += 15; tags.push('FVG');
    }
  }

  // 4. MSS
  if (structure.mss) {
    if (direction === 'long' && structure.mss.type === 'bullish_bos') { score += 20; tags.push('MSS'); }
    if (direction === 'short' && structure.mss.type === 'bearish_bos') { score += 20; tags.push('MSS'); }
  }

  // 5. Liquidity target in direction
  if (direction === 'long' && liquidity.nearestBSL) { score += 10; tags.push('LIQ_TARGET'); }
  if (direction === 'short' && liquidity.nearestSSL) { score += 10; tags.push('LIQ_TARGET'); }

  // 6. KZ tag (always present — this engine only fires in kill zone)
  score += 10; tags.push('KZ');

  return { score: Math.min(score, 100), tags };
}

function generateSignal(analysis, candles, direction) {
  const currentPrice = candles[candles.length - 1].close;
  const { score, tags } = scoreConfluence(analysis, currentPrice, direction);

  if (score < 45) return null; // minimum confluence threshold

  const { orderBlocks, fvgs, structure } = analysis;
  const isLong = direction === 'long';

  // Entry: current price or OB entry
  let entry = currentPrice;
  const ob = isLong ? orderBlocks.bullish : orderBlocks.bearish;
  if (ob) {
    entry = isLong ? ob.eq : ob.eq; // target EQ of OB
  }

  // SL: below OB low (long) or above OB high (short)
  let slBuffer = currentPrice * 0.0015; // 0.15% default
  let sl = isLong
    ? (ob ? ob.low - slBuffer : currentPrice - slBuffer * 3)
    : (ob ? ob.high + slBuffer : currentPrice + slBuffer * 3);

  const risk = Math.abs(entry - sl);
  const tp1 = isLong ? entry + risk * 1.5 : entry - risk * 1.5;
  const tp2 = isLong ? entry + risk * 2.5 : entry - risk * 2.5;
  const rr1 = (Math.abs(tp1 - entry) / risk).toFixed(1);

  // Estimate stop size in points
  const stopPoints = Math.round(Math.abs(entry - sl));

  return {
    direction,
    entry: Math.round(entry),
    sl: Math.round(sl),
    tp1: Math.round(tp1),
    tp2: Math.round(tp2),
    rr: rr1,
    stopPoints,
    confluence: score,
    tags,
    timestamp: new Date().toISOString(),
    price: Math.round(currentPrice)
  };
}

function runICTAnalysis(candles15m, candles5m) {
  // Run on 15m for HTF context, 5m for entry precision
  const structure = detectMarketStructure(candles15m);
  const orderBlocks = findOrderBlocks(candles15m, structure.bias);
  const fvgs = findFairValueGaps(candles15m);
  const fvgs5m = findFairValueGaps(candles5m);
  const liquidity = findLiquidityPools(candles15m);
  const ob5m = findOrderBlocks(candles5m, structure.bias);

  const analysis = { structure, orderBlocks: ob5m, fvgs: fvgs5m, liquidity };

  const signals = [];
  const longSig = generateSignal(analysis, candles5m, 'long');
  const shortSig = generateSignal(analysis, candles5m, 'short');

  if (longSig && longSig.confluence >= 50) signals.push(longSig);
  if (shortSig && shortSig.confluence >= 50) signals.push(shortSig);

  // Only return top signal if both fire (avoid conflicting)
  const topSignals = signals.sort((a, b) => b.confluence - a.confluence).slice(0, 1);

  return {
    bias: structure.bias,
    mss: structure.mss,
    orderBlocks: ob5m,
    fvgs: fvgs5m,
    liquidity,
    signals: topSignals
  };
}

module.exports = { runICTAnalysis, detectMarketStructure, findOrderBlocks, findFairValueGaps, findLiquidityPools };
