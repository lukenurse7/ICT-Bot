'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  XAUUSD ICT — NY JUDAS SWING BACKTEST
//  Identical methodology to DJ30 1yr backtest (61% WR):
//    • Pre-NY range: 5m H/L from 07:00–13:55 UTC (London session)
//    • Sweep: wick beyond London H/L + close back (NY KZ 14:00–16:00 UTC)
//    • Confirmation: MSS + FVG on 5m
//    • Entry: FVG midpoint (limit)  SL: sweep candle extreme + 0.1%
//    • TP: nearest structure (5m equal levels, 1H swings)
//    • 50/50 split TP1/TP2, move SL to BE after TP1
//    • 2% risk per trade, £1,500 start
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const ACCOUNT_START = 1500;
const RISK_PCT      = 0.02;
const SIM_BARS      = 288;

const CACHE = path.join(__dirname, '..', '.cache');

function fmtGBP(n) { return (n>=0?'+':'') + '£' + Math.abs(n).toFixed(2); }
function fmtPct(n) { return (n>=0?'+':'') + n.toFixed(1) + '%'; }

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

// Pre-NY range from 5m candles (07:00–13:55 UTC on given date)
function getPreNYRange(candles5m, dateStr) {
  const session = candles5m.filter(c => {
    if (!c.time.startsWith(dateStr)) return false;
    const h = new Date(c.time).getUTCHours();
    const m = new Date(c.time).getUTCMinutes();
    const mins = h * 60 + m;
    return mins >= 7 * 60 && mins < 14 * 60;
  });
  if (session.length < 5) return null;
  return {
    high: Math.max(...session.map(c => c.high)),
    low:  Math.min(...session.map(c => c.low)),
    candles: session.length
  };
}

// Judas sweep: wick beyond pre-NY H/L + close back inside (14:00–16:00 UTC)
function detectSweep(candles5m, preNYRange) {
  if (!preNYRange) return { detected: false };

  for (let back = 0; back <= 24; back++) {
    const idx = candles5m.length - 1 - back;
    if (idx < 0) break;
    const c = candles5m[idx];
    const h = new Date(c.time).getUTCHours();
    if (h < 14 || h >= 16) continue;

    if (c.high > preNYRange.high && c.close < preNYRange.high)
      return { detected: true, dir: 'bear', level: preNYRange.high, levelName: 'London High (BSL)',
        sweepCandle: c, sweepHigh: c.high, barsAgo: back };
    if (c.low < preNYRange.low && c.close > preNYRange.low)
      return { detected: true, dir: 'bull', level: preNYRange.low,  levelName: 'London Low (SSL)',
        sweepCandle: c, sweepLow: c.low,   barsAgo: back };
  }
  return { detected: false };
}

function detectMSS(candles5m, sweepDir) {
  const window = candles5m.slice(-20);
  if (window.length < 5) return { confirmed: false };

  if (sweepDir === 'bear') {
    let swingLow = Infinity;
    for (let i = 1; i < window.length - 1; i++) {
      if (window[i].low < window[i-1].low && window[i].low < window[i+1].low)
        swingLow = Math.min(swingLow, window[i].low);
    }
    const last = window[window.length - 1], prev = window[window.length - 2];
    if (swingLow < Infinity && last.close < swingLow)
      return { confirmed: true, type: 'BOS_DOWN', level: swingLow };
    if (last.close < prev.low)
      return { confirmed: true, type: 'CHoCH', level: prev.low };
  }

  if (sweepDir === 'bull') {
    let swingHigh = -Infinity;
    for (let i = 1; i < window.length - 1; i++) {
      if (window[i].high > window[i-1].high && window[i].high > window[i+1].high)
        swingHigh = Math.max(swingHigh, window[i].high);
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
    confirmed = prev.high >= best.bottom && prev.close <= best.top && (prev.high - best.bottom) >= best.size * 0.5;
  } else {
    confirmed = prev.low <= best.top && prev.close >= best.bottom && (best.top - prev.low) >= best.size * 0.5;
  }
  return { found: true, top: best.top, bottom: best.bottom, size: best.size, inFVG: confirmed,
    midpoint: (best.top + best.bottom) / 2 };
}

function liquidityTPs(dir, entry, risk, candles5m, h1Candles) {
  const isLong = dir === 'bull';
  const MIN_R = 1.0, MAX_R = 10.0;
  const candidates = [];
  function rOf(p) { return Math.abs(p - entry) / risk; }
  function validSide(p) { return isLong ? p > entry : p < entry; }
  function inRange(p) { return rOf(p) >= MIN_R && rOf(p) <= MAX_R; }

  const c5 = candles5m.slice(-80);
  for (let i = 2; i < c5.length - 1; i++) {
    const c = c5[i], prev = c5.slice(Math.max(0, i-8), i);
    if (isLong) {
      const eq = prev.find(p => Math.abs(p.high - c.high) / c.high < 0.001);
      if (eq) { const price = Math.max(c.high, eq.high); if (validSide(price) && inRange(price)) candidates.push({ price, r: rOf(price), desc: '5m equal highs' }); }
    } else {
      const eq = prev.find(p => Math.abs(p.low - c.low) / c.low < 0.001);
      if (eq) { const price = Math.min(c.low, eq.low); if (validSide(price) && inRange(price)) candidates.push({ price, r: rOf(price), desc: '5m equal lows' }); }
    }
  }
  const c1h = h1Candles.slice(-48);
  for (let i = 2; i < c1h.length - 2; i++) {
    const c = c1h[i];
    if (isLong && c.high > c1h[i-1].high && c.high > c1h[i-2].high && c.high > c1h[i+1].high) {
      if (validSide(c.high) && inRange(c.high)) candidates.push({ price: c.high, r: rOf(c.high), desc: '1H swing high' });
    }
    if (!isLong && c.low < c1h[i-1].low && c.low < c1h[i-2].low && c.low < c1h[i+1].low) {
      if (validSide(c.low) && inRange(c.low)) candidates.push({ price: c.low, r: rOf(c.low), desc: '1H swing low' });
    }
  }
  candidates.sort((a, b) => a.r - b.r);
  const deduped = [];
  for (const c of candidates) {
    const tol = entry * 0.0005;
    if (!deduped.find(d => Math.abs(d.price - c.price) <= tol)) deduped.push(c);
  }
  const tp1Obj = deduped[0] || null;
  const tp1    = tp1Obj ? tp1Obj.price : (isLong ? entry + risk * 2 : entry - risk * 2);
  const tp1R   = parseFloat(rOf(tp1).toFixed(2));
  const tp1Desc = tp1Obj ? tp1Obj.desc : 'Fixed 2R';
  const tp2Candidates = deduped.filter(c => c.r >= tp1R + 0.8);
  const tp2Obj = tp2Candidates[0] || null;
  const tp2    = tp2Obj ? tp2Obj.price : (isLong ? entry + risk * (tp1R + 2) : entry - risk * (tp1R + 2));
  const tp2R   = parseFloat(rOf(tp2).toFixed(2));
  const tp2Desc = tp2Obj ? tp2Obj.desc : 'Fixed extension';
  return { tp1, tp1R, tp1Desc, tp2, tp2R, tp2Desc };
}

function simulateOutcome(dir, entry, sl, tp1, tp2, tp1R, tp2R, futureCandles) {
  let tp1Hit = false, currentSL = sl;
  for (const c of futureCandles) {
    const slHit  = dir==='bull' ? c.low <= currentSL : c.high >= currentSL;
    const tp1Hit_= dir==='bull' ? c.high >= tp1      : c.low  <= tp1;
    const tp2Hit = dir==='bull' ? c.high >= tp2      : c.low  <= tp2;
    if (!tp1Hit) {
      if (slHit)   return { result: 'LOSS',       pnlR: -1 };
      if (tp2Hit)  return { result: 'WIN_TP2',    pnlR: +(0.5*tp1R + 0.5*tp2R).toFixed(2) };
      if (tp1Hit_) { tp1Hit = true; currentSL = entry; }
    } else {
      if (slHit)   return { result: 'WIN_TP1_BE', pnlR: +(0.5*tp1R).toFixed(2) };
      if (tp2Hit)  return { result: 'WIN_TP2',    pnlR: +(0.5*tp1R + 0.5*tp2R).toFixed(2) };
    }
  }
  if (tp1Hit) return { result: 'WIN_TP1_OPEN', pnlR: +(0.5*tp1R).toFixed(2) };
  return { result: 'OPEN', pnlR: null };
}

function run() {
  console.log('\n' + chalk.bold.yellow('  ◆ XAUUSD ICT — NY JUDAS SWING BACKTEST  [LIMIT ORDER + 2% COMPOUNDING]'));
  console.log(chalk.gray('  Period: 2025-06-11 → 2026-06-10  |  NY KZ 14:00–16:00 UTC'));
  console.log(chalk.gray('  Method: London range (07:00–13:55) sweep → MSS → FVG limit entry\n'));

  const all5m = loadChunks('xau1yr_5min');
  const allH1 = loadChunks('xau1yr_1h');

  const START = new Date('2025-06-11T00:00:00Z');
  const END   = new Date('2026-06-10T23:59:59Z');
  const period5m = all5m.filter(c => { const t=new Date(c.time); return t>=START && t<=END; });

  console.log(chalk.gray(`  5m bars: ${period5m.length}  |  H1 bars: ${allH1.length}`));
  console.log(chalk.gray(`  Range: ${period5m[0]?.time?.slice(0,10)} → ${period5m[period5m.length-1]?.time?.slice(0,10)}\n`));

  const signals = [];
  const firedDays = new Set();
  let balance = ACCOUNT_START, peakBalance = ACCOUNT_START, maxDrawdown = 0;

  for (let i = 50; i < period5m.length - 1; i++) {
    const bar  = period5m[i];
    const h    = new Date(bar.time).getUTCHours();

    // Only scan NY KZ
    if (h < 14 || h >= 16) continue;

    const dateStr = bar.time.slice(0, 10);
    if (firedDays.has(dateStr)) continue;

    const slice5m = period5m.slice(0, i + 1);
    const sliceH1 = allH1.filter(c => new Date(c.time) <= new Date(bar.time));

    const preNY  = getPreNYRange(slice5m, dateStr);
    if (!preNY) continue;

    const sweep  = detectSweep(slice5m, preNY);
    if (!sweep.detected) continue;

    const mss    = detectMSS(slice5m, sweep.dir);
    if (!mss.confirmed) continue;

    const fvg    = detectFVG(slice5m, sweep.dir);
    if (!fvg.found) continue;

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
    if (risk > limitEntry * 0.015 || risk <= 0) continue;

    const liq  = liquidityTPs(sweep.dir, limitEntry, risk, slice5m, sliceH1);
    const { tp1, tp1R, tp1Desc, tp2, tp2R, tp2Desc } = liq;

    const fillBars = period5m.slice(i+1, i+13);
    let fillIdx = -1;
    for (let f = 0; f < fillBars.length; f++) {
      const c = fillBars[f];
      if (isLong && c.low <= limitEntry)  { fillIdx = f; break; }
      if (!isLong && c.high >= limitEntry){ fillIdx = f; break; }
    }

    firedDays.add(dateStr);

    if (fillIdx === -1) {
      signals.push({ time: bar.time, dir: isLong?'BUY':'SELL',
        limitEntry: parseFloat(limitEntry.toFixed(2)),
        result: 'MISSED', pnlR: 0, pnlGBP: 0, balanceAfter: parseFloat(balance.toFixed(2)),
        sweep: sweep.levelName, mssType: mss.type });
      continue;
    }

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

    signals.push({ time: bar.time, dir: isLong?'BUY':'SELL',
      limitEntry: parseFloat(limitEntry.toFixed(2)),
      sl: parseFloat(sl.toFixed(2)), tp1: parseFloat(tp1.toFixed(2)), tp2: parseFloat(tp2.toFixed(2)),
      tp1R, tp1Desc, tp2R, tp2Desc,
      risk: parseFloat(risk.toFixed(2)),
      sweep: sweep.levelName, mssType: mss.type, fvgInFVG: fvg.inFVG,
      fillBarsAfter: fillIdx + 1,
      riskGBP: parseFloat(riskGBP.toFixed(2)),
      pnlGBP: pnlGBP != null ? parseFloat(pnlGBP.toFixed(2)) : null,
      balanceAfter: pnlGBP != null ? parseFloat(balance.toFixed(2)) : null,
      ...outcome });
  }

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

  const byMonth = {};
  signals.forEach(s => {
    const d = new Date(s.time);
    const k = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
    byMonth[k] = (byMonth[k]||[]).concat(s);
  });

  const byDir = {};
  signals.forEach(s => { byDir[s.dir] = (byDir[s.dir]||[]).concat(s); });

  console.log('\n' + sep);
  console.log(chalk.bold.yellow('  1-YEAR SUMMARY — XAUUSD NY JUDAS SWING'));
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

  console.log(chalk.gray('\n  Month by month:'));
  Object.entries(byMonth).sort().forEach(([mo, sigs]) => {
    const mF=sigs.filter(s=>s.result!=='MISSED');
    const mW=mF.filter(s=>s.pnlR>0).length, mL=mF.filter(s=>s.pnlR<0).length;
    const mR=mF.reduce((s,x)=>s+(x.pnlR||0),0), mGBP=mF.reduce((s,x)=>s+(x.pnlGBP||0),0);
    const mWR=(mW+mL)>0?Math.round(mW/(mW+mL)*100):0;
    console.log(chalk.gray(`    ${mo}  `)+`${sigs.length} signals  filled ${mF.length}  `+
      chalk.green(`${mW}W`)+'/'+chalk.red(`${mL}L`)+chalk.gray(`  ${mWR}% WR  `)+
      (mR>=0?chalk.green(`+${mR.toFixed(1)}R`):chalk.red(`${mR.toFixed(1)}R`))+chalk.gray('  ')+
      (mGBP>=0?chalk.green(fmtGBP(mGBP)):chalk.red(fmtGBP(mGBP))));
  });

  console.log(chalk.gray('\n  Direction breakdown:'));
  Object.entries(byDir).forEach(([dir, sigs]) => {
    const dF=sigs.filter(s=>s.result!=='MISSED');
    const dW=dF.filter(s=>s.pnlR>0).length, dL=dF.filter(s=>s.pnlR<0).length;
    const dWR=(dW+dL)>0?Math.round(dW/(dW+dL)*100):0;
    const dGBP=dF.reduce((s,x)=>s+(x.pnlGBP||0),0);
    console.log(chalk.gray(`    ${dir.padEnd(5)} ${sigs.length} signals  filled ${dF.length}  `)+
      chalk.green(`${dW}W`)+'/'+chalk.red(`${dL}L`)+chalk.gray(`  ${dWR}% WR  `)+
      (dGBP>=0?chalk.green(fmtGBP(dGBP)):chalk.red(fmtGBP(dGBP))));
  });

  console.log('\n' + sep + '\n');

  fs.writeFileSync(path.join(__dirname, '..', 'backtest_report_xau_ny.json'),
    JSON.stringify({ period:'2025-06-11 → 2026-06-10',
      method:'XAU NY Judas Swing — London range sweep → MSS → FVG limit',
      generatedAt: new Date().toISOString(),
      account:{ start:ACCOUNT_START, end:parseFloat(balance.toFixed(2)),
        returnPct:parseFloat(((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)),
        peakBalance:parseFloat(peakBalance.toFixed(2)), maxDrawdown:parseFloat(maxDrawdown.toFixed(1)) },
      stats:{ total:signals.length, filled:filled.length, missed:missed.length,
        wins:wins.length, losses:losses.length, winRate:wr+'%',
        netR:parseFloat(totalR.toFixed(2)), profitFactor:pf }, signals }, null, 2));
  console.log(chalk.gray('  Report → backtest_report_xau_ny.json\n'));
}

run();
