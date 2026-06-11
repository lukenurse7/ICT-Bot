'use strict';

// NAS100 ICT NY Kill Zone — 1-YEAR BACKTEST
// Data: Yahoo Finance QQQ 1h (pre-market, full year) for levels + sweep
//       TwelveData QQQ 1m (qqq_1m_1yr.json, UTC-normalised) for MSS + FVG

const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const ACCOUNT_START = 1500;
const RISK_PCT      = 0.02;
const SIM_BARS      = 600;
const SL_BUF_PCT    = 0.0003;
const MIN_STOP_PCT  = 0.0005;
const MIN_FVG_PTS   = 0.10;
const MIN_RANGE_PCT = 0.001;
const MIN_TP_DIST   = 0.80;
const MIN_RR        = 1.0;

const CACHE = path.join(__dirname, '..', '.cache');

function fmtGBP(n) { return (n >= 0 ? '+' : '-') + '£' + Math.abs(n).toFixed(2); }
function minsUTC(t) { return parseInt(t.slice(11,13)) * 60 + parseInt(t.slice(14,16)); }

// ─── Session levels from 1h bars ─────────────────────────────────────────
// Use 08:00–11:00 UTC as pre-NY reference (London session, best 1h coverage)
function getSessionLevels1h(candles1h, dateStr) {
  const preKZ = candles1h.filter(c => {
    if (!c.time.startsWith(dateStr)) return false;
    const m = minsUTC(c.time);
    return m >= 8 * 60 && m < 12 * 60;
  });
  if (preKZ.length < 2) return null;

  let lastSwingHigh = null, lastSwingLow = null;
  for (let i = 1; i < preKZ.length - 1; i++) {
    const c = preKZ[i];
    if (c.high >= preKZ[i-1].high && c.high >= preKZ[i+1].high) lastSwingHigh = c.high;
    if (c.low  <= preKZ[i-1].low  && c.low  <= preKZ[i+1].low ) lastSwingLow  = c.low;
  }
  if (lastSwingHigh === null) lastSwingHigh = Math.max(...preKZ.map(c => c.high));
  if (lastSwingLow  === null) lastSwingLow  = Math.min(...preKZ.map(c => c.low));

  if (lastSwingHigh <= lastSwingLow) return null;
  if ((lastSwingHigh - lastSwingLow) / lastSwingLow < MIN_RANGE_PCT) return null;
  return { bsl: lastSwingHigh, ssl: lastSwingLow };
}

// ─── Sweep detection on 1h bars in kill zone ─────────────────────────────
function detectSweep1h(candles1h, dateStr, levels) {
  const kzBars = candles1h.filter(c => {
    if (!c.time.startsWith(dateStr)) return false;
    const m = minsUTC(c.time);
    return m >= 12 * 60 && m < 15 * 60;
  });
  for (const c of kzBars) {
    if (c.high > levels.bsl && c.close < levels.bsl)
      return { detected: true, dir: 'bear', sweptLevel: levels.bsl,
               targetLevel: levels.ssl, sweepTime: c.time, label: 'BSL swept → target SSL' };
    if (c.low < levels.ssl && c.close > levels.ssl)
      return { detected: true, dir: 'bull', sweptLevel: levels.ssl,
               targetLevel: levels.bsl, sweepTime: c.time, label: 'SSL swept → target BSL' };
  }
  return { detected: false };
}

// ─── Combined MSS + FVG on 1m ─────────────────────────────────────────────
function detectMSSandFVG1m(bars1m, sweepDir) {
  if (bars1m.length < 4) return { confirmed: false };
  const candidates = [];
  for (let i = 1; i < Math.min(bars1m.length - 1, 90); i++) {
    const prev = bars1m[i-1], mid = bars1m[i], next = bars1m[i+1];
    if (sweepDir === 'bear' && prev.low > next.high && (prev.low - next.high) >= MIN_FVG_PTS) {
      candidates.push({ fvgBar: i, top: prev.low, bottom: next.high,
        size: parseFloat((prev.low - next.high).toFixed(3)),
        dispHigh: mid.high, dispLow: mid.low, slAnchor: mid.high });
    }
    if (sweepDir === 'bull' && next.low > prev.high && (next.low - prev.high) >= MIN_FVG_PTS) {
      candidates.push({ fvgBar: i, top: next.low, bottom: prev.high,
        size: parseFloat((next.low - prev.high).toFixed(3)),
        dispHigh: mid.high, dispLow: mid.low, slAnchor: mid.low });
    }
  }
  if (!candidates.length) return { confirmed: false, reason: 'no_fvg' };
  const fvg = candidates[0];
  return { confirmed: true, type: 'DISP+FVG', mssBar: fvg.fvgBar,
    fvg: { found: true, top: fvg.top, bottom: fvg.bottom, size: fvg.size,
           dispHigh: fvg.dispHigh, dispLow: fvg.dispLow },
    slAnchor: fvg.slAnchor };
}

// ─── Simulate ─────────────────────────────────────────────────────────────
function simulate(dir, entry, sl, tp, futureBars) {
  let filled = false;
  for (const c of futureBars) {
    if (!filled) {
      if (dir === 'bull' && c.low  <= entry) filled = true;
      if (dir === 'bear' && c.high >= entry) filled = true;
      if (!filled) continue;
    }
    if (dir === 'bull') {
      if (c.low  <= sl) return { result: 'LOSS', pnlR: -1 };
      if (c.high >= tp) return { result: 'WIN',  pnlR: parseFloat(((tp-entry)/(entry-sl)).toFixed(2)) };
    } else {
      if (c.high >= sl) return { result: 'LOSS', pnlR: -1 };
      if (c.low  <= tp) return { result: 'WIN',  pnlR: parseFloat(((entry-tp)/(sl-entry)).toFixed(2)) };
    }
  }
  return { result: filled ? 'OPEN' : 'NO_FILL', pnlR: null };
}

// ─── Main ─────────────────────────────────────────────────────────────────
function run() {
  console.log('\n' + chalk.bold.cyan('  ◆ NAS100 NY Kill Zone — 1-YEAR BACKTEST'));
  console.log(chalk.gray('  London 1h levels → 1h sweep 12:00–15:00 UTC → 1m MSS+FVG\n'));

  // Load data
  const c1h = JSON.parse(fs.readFileSync(path.join(CACHE, 'yahoo_qqq_1h_1yr.json'), 'utf8'));
  const c1m = JSON.parse(fs.readFileSync(path.join(CACHE, 'qqq_1m_1yr.json'), 'utf8'));
  console.log(chalk.gray(`  QQQ 1h: ${c1h.length} bars  ${c1h[0].time.slice(0,10)} → ${c1h[c1h.length-1].time.slice(0,10)}`));
  console.log(chalk.gray(`  QQQ 1m: ${c1m.length} bars  ${c1m[0].time.slice(0,10)} → ${c1m[c1m.length-1].time.slice(0,10)}`));

  // Trading days = dates that have a 13:00+ UTC bar in 1h data
  const tradingDays = [...new Set(
    c1h.filter(c => minsUTC(c.time) >= 13 * 60).map(c => c.time.slice(0, 10))
  )].sort().filter(d => d >= '2025-06-12' && d <= '2026-06-10');

  console.log(chalk.gray(`\n  ${tradingDays.length} trading days: ${tradingDays[0]} → ${tradingDays[tradingDays.length-1]}\n`));

  const signals = [];
  let balance = ACCOUNT_START, peakBalance = ACCOUNT_START, maxDrawdown = 0;
  const stats = { noLevels: 0, noSweep: 0, noMSS: 0, noFVG: 0, riskFail: 0 };

  for (const dateStr of tradingDays) {
    const levels = getSessionLevels1h(c1h, dateStr);
    if (!levels) { stats.noLevels++; continue; }

    const sweep = detectSweep1h(c1h, dateStr, levels);
    if (!sweep.detected) { stats.noSweep++; continue; }

    const sweepMins = minsUTC(sweep.sweepTime);
    const post1m = c1m.filter(c => {
      if (!c.time.startsWith(dateStr)) return false;
      const m = minsUTC(c.time);
      return m > sweepMins && m < 15 * 60;
    });

    if (post1m.length < 4) { stats.noMSS++; continue; }

    const result = detectMSSandFVG1m(post1m, sweep.dir);
    if (!result.confirmed) {
      if (result.reason === 'no_fvg') stats.noFVG++; else stats.noMSS++;
      continue;
    }
    const fvg = result.fvg;

    const isLong = sweep.dir === 'bull';
    const entry = parseFloat((isLong
      ? fvg.bottom + (fvg.top - fvg.bottom) * 0.25
      : fvg.top    - (fvg.top - fvg.bottom) * 0.25).toFixed(2));
    const sl = parseFloat((isLong
      ? result.slAnchor * (1 - SL_BUF_PCT)
      : result.slAnchor * (1 + SL_BUF_PCT)).toFixed(2));
    const tp   = parseFloat(sweep.targetLevel.toFixed(2));
    const risk = Math.abs(entry - sl);
    const tpDist = Math.abs(tp - entry);
    const rrPotCheck = tpDist / risk;

    const fail =
      risk < entry * MIN_STOP_PCT ? 'stop_too_small' :
      risk > entry * 0.04         ? 'stop_too_large' :
      isLong  && sl >= entry       ? 'bull_sl_above_entry' :
      isLong  && tp <= entry       ? 'bull_tp_below_entry' :
      !isLong && sl <= entry       ? 'bear_sl_below_entry' :
      !isLong && tp >= entry       ? 'bear_tp_above_entry' :
      tpDist < MIN_TP_DIST         ? 'tp_too_close' :
      rrPotCheck < MIN_RR          ? 'rr_too_low' : null;
    if (fail) { stats.riskFail++; continue; }

    const rrPot = parseFloat(rrPotCheck.toFixed(2));
    const simStart = c1m.indexOf(post1m[result.mssBar]) + 1;
    const future   = c1m.slice(simStart, simStart + SIM_BARS);
    const outcome  = simulate(sweep.dir, entry, sl, tp, future);

    const riskGBP = balance * RISK_PCT;
    const pnlGBP  = outcome.pnlR != null ? outcome.pnlR * riskGBP : null;
    if (pnlGBP !== null) {
      balance += pnlGBP;
      if (balance > peakBalance) peakBalance = balance;
      const dd = (peakBalance - balance) / peakBalance * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    signals.push({
      date: dateStr, dir: isLong ? 'BUY' : 'SELL',
      bsl: parseFloat(levels.bsl.toFixed(2)), ssl: parseFloat(levels.ssl.toFixed(2)),
      sweep: sweep.label, sweptLevel: parseFloat(sweep.sweptLevel.toFixed(2)),
      targetLevel: parseFloat(sweep.targetLevel.toFixed(2)),
      fvgSize: fvg.size, entry, sl, tp,
      risk: parseFloat(risk.toFixed(2)), rrPot,
      riskGBP: parseFloat(riskGBP.toFixed(2)),
      pnlGBP: pnlGBP != null ? parseFloat(pnlGBP.toFixed(2)) : null,
      balanceAfter: pnlGBP != null ? parseFloat(balance.toFixed(2)) : null,
      ...outcome
    });
  }

  // ─── Print ─────────────────────────────────────────────────────────────
  const sep = '═'.repeat(72);
  console.log(sep);
  console.log(chalk.bold.cyan('  SIGNAL REPORT — NAS100 NY Kill Zone (1-Year · 1h levels · 1m FVG)'));
  console.log(sep);

  signals.forEach((s, idx) => {
    const isLong = s.dir === 'BUY';
    const clr = isLong ? chalk.green : chalk.red;
    const oc  = s.result === 'WIN' ? chalk.green : s.result === 'LOSS' ? chalk.red : chalk.yellow;
    const pnlStr = s.pnlR != null
      ? (s.pnlR > 0 ? chalk.green(`+${s.pnlR.toFixed(2)}R  ${fmtGBP(s.pnlGBP)}`) : chalk.red(`-1.0R  ${fmtGBP(s.pnlGBP)}`))
      : chalk.yellow(s.result);
    console.log(`\n  #${idx+1} ${chalk.gray(s.date)}  ${clr(`${isLong?'▲':'▼'} ${s.dir}`)}  ${chalk.gray(s.sweep)}`);
    console.log(`  BSL:$${s.bsl}  SSL:$${s.ssl}  Entry $${s.entry}  SL $${s.sl}  TP $${s.tp}  Pot.${chalk.cyan(s.rrPot+'R')}  ${chalk.gray('£'+s.riskGBP)}`);
    console.log(`  FVG: $${s.fvgSize}  → ${oc(s.result)}  ${pnlStr}${s.balanceAfter ? chalk.gray('  bal: £') + s.balanceAfter : ''}`);
  });

  // ─── Summary ───────────────────────────────────────────────────────────
  const closed  = signals.filter(s => s.pnlR != null);
  const wins    = closed.filter(s => s.pnlR > 0);
  const losses  = closed.filter(s => s.pnlR < 0);
  const totalR  = closed.reduce((s, x) => s + x.pnlR, 0);
  const totalGBP= closed.reduce((s, x) => s + (x.pnlGBP || 0), 0);
  const wr      = closed.length ? (wins.length / closed.length * 100).toFixed(0) : 0;
  const avgWinR = wins.length ? (wins.reduce((s,x)=>s+x.pnlR,0)/wins.length).toFixed(2) : '0';
  const pf      = losses.length
    ? (wins.reduce((s,x)=>s+x.pnlR,0) / Math.abs(losses.reduce((s,x)=>s+x.pnlR,0))).toFixed(2)
    : wins.length ? '∞' : '0.00';

  const byMonth = {};
  signals.forEach(s => { const k = s.date.slice(0,7); byMonth[k] = (byMonth[k]||[]).concat(s); });

  console.log('\n\n' + sep);
  console.log(chalk.bold.cyan('  SUMMARY — NAS100 (1-Year)'));
  console.log(sep);
  console.log(chalk.gray(`  Filter funnel:`));
  console.log(chalk.gray(`    Trading days:     ${tradingDays.length}`));
  console.log(chalk.gray(`    No 1h levels:     ${stats.noLevels}`));
  console.log(chalk.gray(`    No 1h sweep:      ${stats.noSweep}`));
  console.log(chalk.gray(`    No 1m MSS:        ${stats.noMSS}`));
  console.log(chalk.gray(`    No 1m FVG:        ${stats.noFVG}`));
  console.log(chalk.gray(`    Risk check fail:  ${stats.riskFail}`));
  console.log(chalk.gray(`    Signals fired:    ${signals.length}`));
  console.log('');
  console.log(chalk.gray('  Signals:       ') + signals.length);
  console.log(chalk.gray('  Wins:          ') + chalk.green(wins.length));
  console.log(chalk.gray('  Losses:        ') + chalk.red(losses.length));
  console.log(chalk.gray('  No fill/open:  ') + chalk.yellow(signals.length - closed.length));
  console.log(chalk.gray('  Win rate:      ') + (parseFloat(wr)>=33?chalk.green:chalk.red)(`${wr}%`));
  console.log(chalk.gray('  Avg win R:     ') + chalk.cyan(avgWinR + 'R'));
  console.log(chalk.gray('  Net R:         ') + (totalR>=0?chalk.green(`+${totalR.toFixed(2)}R`):chalk.red(`${totalR.toFixed(2)}R`)));
  console.log(chalk.gray('  Profit factor: ') + chalk.cyan(pf));
  console.log('\n' + chalk.bold.cyan('  ── ACCOUNT (£1,500 · 2% compounding) ──'));
  console.log(chalk.gray('  Start:         £1,500.00'));
  console.log(chalk.gray('  End:           ') + (balance>=ACCOUNT_START?chalk.green:chalk.red)('£'+balance.toFixed(2)));
  console.log(chalk.gray('  Net P&L:       ') + (totalGBP>=0?chalk.green:chalk.red)(fmtGBP(totalGBP)));
  console.log(chalk.gray('  Return:        ') + (balance>=ACCOUNT_START?chalk.green:chalk.red)(`${((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)}%`));
  console.log(chalk.gray('  Peak balance:  £') + peakBalance.toFixed(2));
  console.log(chalk.gray('  Max drawdown:  ') + chalk.yellow(`${maxDrawdown.toFixed(1)}%`));
  console.log(chalk.gray('\n  Month by month:'));
  Object.entries(byMonth).sort().forEach(([mo, sigs]) => {
    const mW=sigs.filter(s=>s.pnlR>0).length, mL=sigs.filter(s=>s.pnlR<0).length;
    const mR=sigs.reduce((s,x)=>s+(x.pnlR||0),0), mGBP=sigs.reduce((s,x)=>s+(x.pnlGBP||0),0);
    const mWR=(mW+mL)>0?Math.round(mW/(mW+mL)*100):0;
    console.log(chalk.gray(`    ${mo}  `)+`${sigs.length} signals  `+chalk.green(`${mW}W`)+'/'+chalk.red(`${mL}L`)+
      chalk.gray(`  ${mWR}% WR  `)+(mR>=0?chalk.green(`+${mR.toFixed(2)}R`):chalk.red(`${mR.toFixed(2)}R`))+
      chalk.gray('  ')+(mGBP>=0?chalk.green(fmtGBP(mGBP)):chalk.red(fmtGBP(mGBP))));
  });

  fs.writeFileSync(path.join(__dirname, '..', 'backtest_report_nas100_1yr.json'),
    JSON.stringify({ period: `${tradingDays[0]} → ${tradingDays[tradingDays.length-1]}`,
      generatedAt: new Date().toISOString(), account: { start: ACCOUNT_START, end: parseFloat(balance.toFixed(2)),
        returnPct: parseFloat(((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)),
        peakBalance: parseFloat(peakBalance.toFixed(2)), maxDrawdown: parseFloat(maxDrawdown.toFixed(1)) },
      stats: { total: signals.length, wins: wins.length, losses: losses.length,
        winRate: wr+'%', avgWinR, netR: totalR.toFixed(2), profitFactor: pf }, signals }, null, 2));

  console.log(chalk.gray('\n  Report → backtest_report_nas100_1yr.json'));
  console.log('\n' + sep + '\n');
}

run();
