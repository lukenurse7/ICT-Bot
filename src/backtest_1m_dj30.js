'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  DJ30 ICT — 1m BACKTEST  (uses real 1m DIA data, video checklist exact)
//  Pre-KZ level (prev session H/L + pivots) → 5m sweep → 1m MSS+disp → 1m FVG
//  SL at 1m MSS swing point | TP at opposing pre-KZ liquidity
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
const MIN_SCORE     = 75;
const DAY_END_HOUR  = 21;
const MIN_RISK_PTS  = parseFloat(process.env.MIN_RISK_PTS || '25');
const MAX_RISK_PTS  = parseFloat(process.env.MAX_RISK_PTS || '100'); // reject huge stops
const MAX_PER_DAY   = 1; // one trade per day max (strongest setup wins)

const CACHE       = path.join(__dirname, '..', '.cache');
const PRICE_SCALE = parseFloat(process.env.DJ30_PRICE_SCALE) || 99.7724;

// ─── Load data ────────────────────────────────────────────────────────────────
function load1h(sy, sm, ey, em) {
  const all = [];
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    const s  = `${y}-${String(m).padStart(2,'0')}-01`;
    const nm = m+1>12?1:m+1, ny = m+1>12?y+1:y;
    const e  = `${ny}-${String(nm).padStart(2,'0')}-01`;
    const f  = path.join(CACHE, `dj30_1h_${s}_${e}.json`);
    if (fs.existsSync(f)) all.push(...JSON.parse(fs.readFileSync(f)));
    m++; if (m>12){m=1;y++;}
  }
  const seen=new Set();
  return all.filter(c=>{if(seen.has(c.time))return false;seen.add(c.time);return true;})
    .sort((a,b)=>new Date(a.time)-new Date(b.time))
    .map(c=>({time:c.time,open:c.open*PRICE_SCALE,high:c.high*PRICE_SCALE,
              low:c.low*PRICE_SCALE,close:c.close*PRICE_SCALE}));
}

// HTF bias from 1h swing structure (last 30 bars)
// Returns 'bull', 'bear', or 'neutral'
function htfBias(candles1h, nowIso) {
  const nowTs = new Date(nowIso).getTime();
  const recent = candles1h.filter(c => new Date(c.time).getTime() < nowTs).slice(-30);
  if (recent.length < 6) return 'neutral';

  // Find pivot highs and lows (3-bar pattern)
  const pivotHighs = [], pivotLows = [];
  for (let i = 1; i < recent.length - 1; i++) {
    if (recent[i].high > recent[i-1].high && recent[i].high > recent[i+1].high)
      pivotHighs.push({ price: recent[i].high, idx: i });
    if (recent[i].low < recent[i-1].low && recent[i].low < recent[i+1].low)
      pivotLows.push({ price: recent[i].low, idx: i });
  }

  if (pivotHighs.length < 2 || pivotLows.length < 2) return 'neutral';

  const lastH  = pivotHighs[pivotHighs.length - 1].price;
  const prevH  = pivotHighs[pivotHighs.length - 2].price;
  const lastL  = pivotLows[pivotLows.length - 1].price;
  const prevL  = pivotLows[pivotLows.length - 2].price;

  const hhhl = lastH > prevH && lastL > prevL; // higher highs + higher lows
  const lhll = lastH < prevH && lastL < prevL; // lower highs + lower lows

  if (hhhl) return 'bull';
  if (lhll) return 'bear';
  return 'neutral';
}

function load5m(sy, sm, ey, em) {
  const all = [];
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    const s  = `${y}-${String(m).padStart(2,'0')}-01`;
    const nm = m+1>12?1:m+1, ny = m+1>12?y+1:y;
    const e  = `${ny}-${String(nm).padStart(2,'0')}-01`;
    const f  = path.join(CACHE, `dj30_5min_${s}_${e}.json`);
    if (fs.existsSync(f)) all.push(...JSON.parse(fs.readFileSync(f)));
    m++; if (m>12){m=1;y++;}
  }
  const seen=new Set();
  return all.filter(c=>{if(seen.has(c.time))return false;seen.add(c.time);return true;})
    .sort((a,b)=>new Date(a.time)-new Date(b.time))
    .map(c=>({time:c.time,open:c.open*PRICE_SCALE,high:c.high*PRICE_SCALE,
              low:c.low*PRICE_SCALE,close:c.close*PRICE_SCALE,volume:c.volume||0}));
}

function load1m() {
  const all = [];
  // Load all dj30_1min_*.json cache files (monthly and 2-week chunks)
  const files = fs.readdirSync(CACHE)
    .filter(f => f.startsWith('dj30_1min_') && f.endsWith('.json'))
    .map(f => path.join(CACHE, f));
  for (const f of files) {
    try { all.push(...JSON.parse(fs.readFileSync(f))); } catch(e) {}
  }
  const seen=new Set();
  return all.filter(c=>{if(seen.has(c.time))return false;seen.add(c.time);return true;})
    .sort((a,b)=>new Date(a.time)-new Date(b.time))
    .map(c=>({time:c.time,open:c.open*PRICE_SCALE,high:c.high*PRICE_SCALE,
              low:c.low*PRICE_SCALE,close:c.close*PRICE_SCALE,volume:c.volume||0}));
}

// ─── ICT Engine ───────────────────────────────────────────────────────────────

// Previous session high/low as BSL/SSL (ICT: mark prev session liquidity before KZ)
// Finds the most recent overnight gap, takes prev session candles, returns H+L as levels.
function buildPreKZLevels(candles5m) {
  const GAP_MS = 30 * 60 * 1000;

  // Find the most recent session boundary (gap > 30 min)
  let curSessionStart = 0;
  for (let i = candles5m.length - 1; i > 0; i--) {
    const gap = new Date(candles5m[i].time).getTime() - new Date(candles5m[i-1].time).getTime();
    if (gap > GAP_MS) { curSessionStart = i; break; }
  }
  if (curSessionStart === 0) return { levels: [] };

  // Find the previous session boundary
  let prevSessionStart = 0;
  for (let i = curSessionStart - 1; i > 0; i--) {
    const gap = new Date(candles5m[i].time).getTime() - new Date(candles5m[i-1].time).getTime();
    if (gap > GAP_MS) { prevSessionStart = i; break; }
  }

  // Previous session = prevSessionStart → curSessionStart-1
  const prevSess = candles5m.slice(prevSessionStart, curSessionStart);
  if (prevSess.length < 3) return { levels: [] };

  const high = Math.max(...prevSess.map(c => c.high));
  const low  = Math.min(...prevSess.map(c => c.low));

  // Date label from the previous session
  const dateLabel = prevSess[0].time.slice(0, 10);

  return {
    levels: [
      { price: high, type: 'BSL', name: `PrevH ${dateLabel}` },
      { price: low,  type: 'SSL', name: `PrevL ${dateLabel}` }
    ]
  };
}

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
        results.push({ dir:'bear', level:lvl.price, levelName:lvl.name,
                       barsAgo:back, sweepCandleTime:c.time });
      if (lvl.type === 'SSL' && c.low < lvl.price && c.close > lvl.price)
        results.push({ dir:'bull', level:lvl.price, levelName:lvl.name,
                       barsAgo:back, sweepCandleTime:c.time });
    }
  }
  if (!results.length) return { detected: false };
  results.sort((a,b) => a.barsAgo - b.barsAgo);
  return { detected: true, ...results[0] };
}

// 1m MSS with displacement (exact video checklist — not approximated)
function detectMSS1m(candles1m, sweepDir, sweepCandleTime) {
  const DISP_BODY_RATIO = 0.55;
  const sweepTs = new Date(sweepCandleTime).getTime();
  const post = candles1m.filter(c => new Date(c.time).getTime() > sweepTs).slice(0, 90);
  if (post.length < 3) return { confirmed: false };

  if (sweepDir === 'bear') {
    for (let i = 1; i < post.length - 1; i++) {
      if (post[i].low >= post[i-1].low || post[i].low >= post[i+1].low) continue;
      const swingLevel = post[i].low;
      for (let j = i + 1; j < post.length; j++) {
        const c = post[j];
        if (c.close >= swingLevel) continue;
        const body  = c.open - c.close;
        const range = c.high - c.low;
        if (range > 0 && body / range >= DISP_BODY_RATIO)
          return { confirmed:true, type:'MSS_BEAR', swingLevel,
                   swingTime:post[i].time, dispCandleIdx:j, dispCandle:c, mssTime:c.time };
      }
    }
  }

  if (sweepDir === 'bull') {
    for (let i = 1; i < post.length - 1; i++) {
      if (post[i].high <= post[i-1].high || post[i].high <= post[i+1].high) continue;
      const swingLevel = post[i].high;
      for (let j = i + 1; j < post.length; j++) {
        const c = post[j];
        if (c.close <= swingLevel) continue;
        const body  = c.close - c.open;
        const range = c.high - c.low;
        if (range > 0 && body / range >= DISP_BODY_RATIO)
          return { confirmed:true, type:'MSS_BULL', swingLevel,
                   swingTime:post[i].time, dispCandleIdx:j, dispCandle:c, mssTime:c.time };
      }
    }
  }

  return { confirmed: false };
}

// 1m FVG in displacement window
function detectFVG1m(candles1m, sweepDir, sweepCandleTime, mss) {
  if (!mss.confirmed) return { found: false };
  const sweepTs = new Date(sweepCandleTime).getTime();
  const post    = candles1m.filter(c => new Date(c.time).getTime() > sweepTs).slice(0, 90);

  const di    = mss.dispCandleIdx;
  const start = Math.max(0, di - 4);
  const end   = Math.min(post.length - 1, di + 4);

  const candidates = [];
  for (let i = start; i <= end - 2; i++) {
    const c0 = post[i], c2 = post[i + 2];
    if (!c0 || !c2) continue;
    if (sweepDir === 'bear' && c2.high < c0.low) {
      const size = c0.low - c2.high;
      if (size > 0) candidates.push({ top:c0.low, bottom:c2.high, size, zoneFormedAt:c2.time });
    }
    if (sweepDir === 'bull' && c2.low > c0.high) {
      const size = c2.low - c0.high;
      if (size > 0) candidates.push({ top:c2.low, bottom:c0.high, size, zoneFormedAt:c2.time });
    }
  }
  if (!candidates.length) return { found: false };
  const best = candidates.sort((a,b) => b.size - a.size)[0];
  const entryPrice = sweepDir === 'bull' ? best.top : best.bottom;
  return { found:true, top:best.top, bottom:best.bottom, size:best.size,
           entryPrice, zoneFormedAt:best.zoneFormedAt };
}

// Wait for limit fill on 1m
function findLimitFill1m(candles1m, fvg, sweepDir, fromTime, dayEnd) {
  const fromTs = new Date(fromTime).getTime();
  const endTs  = new Date(dayEnd).getTime();
  for (const c of candles1m) {
    const t = new Date(c.time).getTime();
    if (t <= fromTs) continue;
    if (t > endTs)   break;
    if (sweepDir === 'bull' && c.low  <= fvg.entryPrice) return { price: fvg.entryPrice, time: c.time };
    if (sweepDir === 'bear' && c.high >= fvg.entryPrice) return { price: fvg.entryPrice, time: c.time };
  }
  return null;
}

function opposingLiquidityTPs(dir, entry, risk, candles5m, nowIso) {
  const isLong = dir === 'bull';
  const { levels } = buildPreKZLevels(candles5m);
  const opp = levels
    .filter(l => isLong ? l.type==='BSL' && l.price>entry+risk*1.0 : l.type==='SSL' && l.price<entry-risk*1.0)
    .sort((a,b) => isLong ? a.price-b.price : b.price-a.price);
  const fb = r => isLong ? entry+risk*r : entry-risk*r;
  const tp1 = opp.find(l => isLong ? l.price>=fb(TP1_R) : l.price<=fb(TP1_R)) || { price:fb(TP1_R), name:`${TP1_R}R` };
  const tp2 = opp.find(l => isLong ? l.price>=fb(TP2_R) : l.price<=fb(TP2_R)) || { price:fb(TP2_R), name:`${TP2_R}R` };
  const tp3 = opp.find(l => isLong ? l.price>=fb(TP3_R) : l.price<=fb(TP3_R)) || { price:fb(TP3_R), name:`${TP3_R}R` };
  return { tp1:tp1.price, tp1Desc:tp1.name, tp2:tp2.price, tp2Desc:tp2.name, tp3:tp3.price, tp3Desc:tp3.name };
}

function scoreConf(sweep, mss, fvg) {
  let score = 25; const tags = ['KZ'];
  if (sweep.detected) { score += 25; tags.push('SWEEP'); }
  if (mss.confirmed)  { score += 25; tags.push('MSS_1M'); }
  if (fvg.found)      { score += 25; tags.push('FVG_1M'); }
  return { score: Math.min(score,100), grade: score>=100?'A+':score>=75?'A':'B', tags };
}

function simulateOutcome(dir, entry, sl, tp1, tp2, tp3, risk, future1m) {
  const isLong = dir === 'bull';
  let tp1Hit = false, currentSL = sl, lastClose = entry, lastTime = null;
  for (const c of future1m) {
    lastClose = c.close; lastTime = c.time;
    const slHit  = isLong ? c.low  <= currentSL : c.high >= currentSL;
    const t1Hit  = isLong ? c.high >= tp1       : c.low  <= tp1;
    const t2Hit  = isLong ? c.high >= tp2       : c.low  <= tp2;
    const t3Hit  = isLong ? c.high >= tp3       : c.low  <= tp3;
    if (!tp1Hit) {
      if (slHit)  return { result:'LOSS',    pnlR:-1,                              closeTime:c.time };
      if (t3Hit)  return { result:'WIN_TP3', pnlR:+(0.5*TP1_R+0.25*TP2_R+0.25*TP3_R).toFixed(2), closeTime:c.time };
      if (t2Hit)  return { result:'WIN_TP2', pnlR:+(0.5*TP1_R+0.5*TP2_R).toFixed(2),              closeTime:c.time };
      if (t1Hit)  { tp1Hit = true; currentSL = entry; }
    } else {
      if (slHit)  return { result:'WIN_BE',  pnlR:+(0.5*TP1_R).toFixed(2),        closeTime:c.time };
      if (t3Hit)  return { result:'WIN_TP3', pnlR:+(0.5*TP1_R+0.25*TP2_R+0.25*TP3_R).toFixed(2), closeTime:c.time };
      if (t2Hit)  return { result:'WIN_TP2', pnlR:+(0.5*TP1_R+0.5*TP2_R).toFixed(2),              closeTime:c.time };
    }
  }
  const rAtClose = ((lastClose-entry)/risk) * (isLong?1:-1);
  if (tp1Hit) return { result:'EOD_PARTIAL', pnlR:+(0.5*TP1_R+0.5*Math.max(rAtClose,TP1_R)).toFixed(2), closeTime:lastTime };
  const clamped = Math.max(rAtClose,-1);
  return { result:clamped>=0?'EOD_WIN':'EOD_LOSS', pnlR:+clamped.toFixed(2), closeTime:lastTime };
}

function isKZ(iso) {
  const t = new Date(iso), m = t.getUTCHours()*60+t.getUTCMinutes();
  return m >= 13*60+30 && m < 16*60;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
function run() {
  console.clear();
  console.log('\n' + chalk.bold.white('  ■ DJ30 ICT — REAL 1m BACKTEST (Video Checklist Exact)'));
  console.log(chalk.gray('  Period: May 28 – Jun 15 2026 (1m data available)'));
  console.log(chalk.gray('  Strategy: Prev session H/L sweep → 1m MSS+displacement → 1m FVG limit → opp. liquidity TP'));
  console.log(chalk.gray(`  £${ACCOUNT_START.toLocaleString()} start | 2% risk | compounded | force-close 21:00 UTC\n`));

  const all1h  = load1h(2025, 5, 2026, 6);
  const all5m  = load5m(2025, 5, 2026, 6);
  const all1m  = load1m();

  if (!all1m.length) { console.log(chalk.red('  ✗ No 1m data. Run: node src/fetch_1m_history.js')); process.exit(1); }

  // Period is bounded by 1m data availability
  const START = new Date(all1m[0].time);
  const END   = new Date(all1m[all1m.length-1].time);

  console.log(chalk.gray(`  1h bars: ${all1h.length.toLocaleString()}   5m bars: ${all5m.length.toLocaleString()}   1m bars: ${all1m.length.toLocaleString()}`));
  console.log(chalk.gray(`  1m period: ${START.toISOString().slice(0,10)} → ${END.toISOString().slice(0,10)}\n`));

  // Scan 5m bars to detect setup, then use 1m for entry/exit
  const period5m = all5m.filter(c => {
    const t = new Date(c.time);
    return t >= START && t <= END;
  });

  const signals = [];
  let balance = ACCOUNT_START, peak = ACCOUNT_START, maxDD = 0;
  const processedSetups = new Set();
  const tradedDays = new Set(); // max 1 per day

  for (let i = 30; i < period5m.length - 1; i++) {
    const bar = period5m[i];
    if (!isKZ(bar.time)) continue;

    const time    = new Date(bar.time);
    const slice5m = all5m.filter(c => new Date(c.time) <= time);
    const nowIso  = bar.time;

    // HTF bias filter — only take trades aligned with 1h trend
    const bias = htfBias(all1h, bar.time);

    let sweep, mss, fvg, conf;
    try {
      sweep = detectSweep(slice5m);
      if (!sweep.detected) continue;

      // Skip counter-trend setups
      if (bias === 'bull' && sweep.dir === 'bear') continue;
      if (bias === 'bear' && sweep.dir === 'bull') continue;

      const slice1m = all1m.filter(c => new Date(c.time).getTime() <= time.getTime());
      mss  = detectMSS1m(slice1m, sweep.dir, sweep.sweepCandleTime);
      if (!mss.confirmed) continue;

      fvg  = detectFVG1m(slice1m, sweep.dir, sweep.sweepCandleTime, mss);
      if (!fvg.found) continue;

      conf = scoreConf(sweep, mss, fvg);
      if (conf.score < MIN_SCORE) continue;

      // Deduplicate — same FVG zone already processed
      const zoneKey = `${fvg.zoneFormedAt}_${fvg.entryPrice.toFixed(0)}`;
      if (processedSetups.has(zoneKey)) continue;
      processedSetups.add(zoneKey);

    } catch(e) { continue; }

    const isLong = sweep.dir === 'bull';
    const dayEnd = new Date(Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate(), DAY_END_HOUR));

    // Wait for limit fill on 1m
    const fill = findLimitFill1m(all1m, fvg, sweep.dir, fvg.zoneFormedAt, dayEnd);
    if (!fill) continue;

    const entry     = fill.price;
    const slBuffer  = mss.swingLevel * 0.0003;
    const sl        = isLong ? mss.swingLevel - slBuffer : mss.swingLevel + slBuffer;

    if (isLong && sl >= entry)   continue;
    if (!isLong && sl <= entry)  continue;

    const dayKey = bar.time.slice(0, 10);
    if (tradedDays.has(dayKey)) continue; // one trade per day max

    const risk = Math.abs(entry - sl);
    if (risk < MIN_RISK_PTS || risk > MAX_RISK_PTS) continue;

    const { tp1, tp1Desc, tp2, tp2Desc, tp3, tp3Desc } =
      opposingLiquidityTPs(sweep.dir, entry, risk, slice5m, nowIso);

    const future1m = all1m.filter(c => {
      const t = new Date(c.time).getTime();
      return t > new Date(fill.time).getTime() && t <= dayEnd.getTime();
    });

    const outcome = simulateOutcome(sweep.dir, entry, sl, tp1, tp2, tp3, risk, future1m);
    const riskGBP = balance * RISK_PCT;
    const pnlGBP  = outcome.pnlR != null ? outcome.pnlR * riskGBP : null;

    if (pnlGBP !== null) {
      balance += pnlGBP;
      if (balance > peak) peak = balance;
      const dd = (peak - balance) / peak * 100;
      if (dd > maxDD) maxDD = dd;
    }

    tradedDays.add(dayKey);
    signals.push({
      time: bar.time, fillTime: fill.time, dir: isLong ? 'BUY' : 'SELL',
      entry: +entry.toFixed(2), sl: +sl.toFixed(2),
      tp1: +tp1.toFixed(2), tp2: +tp2.toFixed(2), tp3: +tp3.toFixed(2),
      tp1Desc, tp2Desc, tp3Desc,
      riskPts: +risk.toFixed(2), score: conf.score, grade: conf.grade, tags: conf.tags,
      sweep: sweep.levelName, mssType: mss.type, mssSwing: +mss.swingLevel.toFixed(2),
      fvgTop: +fvg.top.toFixed(2), fvgBottom: +fvg.bottom.toFixed(2),
      riskGBP: +riskGBP.toFixed(2),
      pnlGBP:  pnlGBP !== null ? +pnlGBP.toFixed(2) : null,
      balanceAfter: pnlGBP !== null ? +balance.toFixed(2) : null,
      ...outcome
    });
  }

  // ─── Results ──────────────────────────────────────────────────────────────
  const sep    = '═'.repeat(72);
  const closed = signals.filter(s => s.pnlR !== null);
  const wins   = closed.filter(s => s.pnlR > 0);
  const losses = closed.filter(s => s.pnlR < 0);
  const totalR = +closed.reduce((s,x) => s+x.pnlR, 0).toFixed(2);
  const totalP = +closed.reduce((s,x) => s+(x.pnlGBP||0), 0).toFixed(2);
  const wr     = closed.length ? Math.round(wins.length/closed.length*100) : 0;
  const pf     = losses.length
    ? +(wins.reduce((s,x)=>s+x.pnlR,0) / Math.abs(losses.reduce((s,x)=>s+x.pnlR,0))).toFixed(2)
    : wins.length ? '∞' : 0;

  console.log(sep);
  console.log(chalk.bold('  ■ 1m BACKTEST RESULTS — VIDEO CHECKLIST (Real 1m Data)'));
  console.log(sep);
  console.log(`  Period:      ${START.toISOString().slice(0,10)} → ${END.toISOString().slice(0,10)}`);
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
  console.log(`  Return:      ${((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)}%`);
  console.log(`  Max drawdown: ${maxDD.toFixed(1)}%`);
  console.log();

  const types = {};
  closed.forEach(s => { types[s.result] = (types[s.result]||0)+1; });
  if (Object.keys(types).length) {
    console.log('  Result types:');
    Object.entries(types).sort((a,b)=>b[1]-a[1]).forEach(([r,n]) =>
      console.log(`    ${r.padEnd(16)}${n} trades  (${Math.round(n/closed.length*100)}%)`));
    console.log();
  }

  console.log('  ── Trade log ──────────────────────────────────────────────────');
  signals.forEach(s => {
    const col = s.pnlR > 0 ? chalk.green : s.pnlR < 0 ? chalk.red : chalk.yellow;
    console.log(col(`  ${s.time.slice(0,10)} ${s.dir.padEnd(4)} entry:${s.entry} risk:${s.riskPts}pts  ${(s.result||'?').padEnd(12)} ${s.pnlR!=null?(s.pnlR>0?'+':'')+s.pnlR+'R':'—'}`));
  });

  console.log('\n' + sep + '\n');

  fs.writeFileSync(
    path.join(__dirname, '..', 'backtest_report_1m_dj30.json'),
    JSON.stringify({
      period: `${START.toISOString().slice(0,10)} → ${END.toISOString().slice(0,10)}`,
      strategy: 'Prev session H/L sweep → 1m MSS+displacement → 1m FVG limit → opposing liquidity TP',
      generatedAt: new Date().toISOString(),
      settings: { symbol:'DJ30/DIA', start:ACCOUNT_START, riskPct:RISK_PCT*100,
                  minScore:MIN_SCORE, killZone:'13:30-16:00 UTC', forceCloseHour:DAY_END_HOUR },
      account: { start:ACCOUNT_START, end:+balance.toFixed(2),
                 returnPct:+((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1),
                 maxDD:+maxDD.toFixed(1) },
      stats: { trades:closed.length, wins:wins.length, losses:losses.length, wr:wr+'%', netR:totalR, pf },
      signals
    }, null, 2)
  );
  console.log(chalk.gray('  Report → backtest_report_1m_dj30.json\n'));
}

run();
