'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  XAUUSD ICT — LIMIT ORDER BACKTEST  (2% compounding risk, £1,500 start)
//
//  Loads data from the same 1-year cache as backtest_xau_1yr.js so both
//  backtests use identical underlying price data.
// ═══════════════════════════════════════════════════════════════════════════

const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const {
  htfBias, keyLevels, detectLiquiditySweep,
  detectMSS, entryFVG, findOrderBlock, scoreConfluence,
  liquidityTargets
} = require('./ict_xau');

const ACCOUNT_START = 1500;
const RISK_PCT      = 0.02;
const TP1_R         = 1.5;
const TP2_R         = 2.5;
const TP3_R         = 5.0;
const SIM_BARS      = 288;
const MIN_SCORE     = 80;
const COOLDOWN      = 36;
const FILL_WINDOW   = 12;

const CACHE_DIR = path.join(__dirname, '..', '.cache');

function fmt(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function fmtDT(iso) {
  const d = new Date(iso);
  return `${fmt(d)} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} UTC`;
}
function fmtGBP(n) { return '£' + n.toFixed(2); }
function fmtPct(n) { return (n >= 0 ? '+' : '') + n.toFixed(1) + '%'; }

function threeMonthRange() {
  const start = new Date('2026-03-17T00:00:00Z');
  const end   = new Date('2026-06-10T23:59:59Z');
  return { start, end, label: `${fmt(start)} → ${fmt(end)}` };
}

// Load from the same 1-year monthly chunk files as backtest_xau_1yr.js
function loadChunks(prefix) {
  const all = [];
  for (let y = 2025, m = 6; !(y === 2026 && m === 7);) {
    const s  = `${y}-${String(m).padStart(2,'0')}-01`;
    const nm = m + 1 > 12 ? 1 : m + 1, ny = m + 1 > 12 ? y + 1 : y;
    const e  = `${ny}-${String(nm).padStart(2,'0')}-01`;
    const f  = path.join(CACHE_DIR, `${prefix}_${s}_${e}.json`);
    if (fs.existsSync(f)) all.push(...JSON.parse(fs.readFileSync(f)));
    m++; if (m > 12) { m = 1; y++; }
  }
  const seen = new Set();
  return all
    .filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
    .sort((a, b) => a.time.localeCompare(b.time));
}

function rollup(src, factor) {
  const out = [];
  for (let i = 0; i < src.length; i += factor) {
    const s = src.slice(i, i + factor);
    if (!s.length) continue;
    out.push({ time: s[0].time, open: s[0].open, high: Math.max(...s.map(c => c.high)),
      low: Math.min(...s.map(c => c.low)), close: s[s.length-1].close,
      volume: s.reduce((a, c) => a + c.volume, 0) });
  }
  return out;
}

function sessionLabel(iso) {
  const h = new Date(iso).getUTCHours();
  if (h >= 7  && h < 9)  return '🟡 London KZ';
  if (h >= 12 && h < 15) return '🟢 NY KZ';
  if (h >= 2  && h < 5)  return '🔵 Asia KZ';
  if (h >= 10 && h < 11) return '⚡ Silver Bullet AM';
  return 'Off-hours';
}
function isKillZone(iso) {
  const h = new Date(iso).getUTCHours();
  return (h >= 7 && h < 9) || (h >= 12 && h < 15);
}
function asiaRange(h1Candles, dateIso) {
  const start = new Date(dateIso); start.setUTCHours(0,0,0,0);
  const end   = new Date(dateIso); end.setUTCHours(6,0,0,0);
  const asia  = h1Candles.filter(c => { const t = new Date(c.time); return t >= start && t < end; });
  if (!asia.length) return null;
  return { high: Math.max(...asia.map(c => c.high)), low: Math.min(...asia.map(c => c.low)) };
}
function htfAlignedFn(htf, dir) {
  return (dir === 'bull' && (htf.bias === 'bullish' || htf.bias === 'pullback_in_bear'))
      || (dir === 'bear' && (htf.bias === 'bearish' || htf.bias === 'pullback_in_bull'));
}

function simulateOutcome(dir, entry, sl, tp1, tp2, tp3, futureCandles) {
  let tp1Hit = false, currentSL = sl;
  for (const c of futureCandles) {
    const slHit   = dir === 'bull' ? c.low  <= currentSL : c.high >= currentSL;
    const tp1Hit_ = dir === 'bull' ? c.high >= tp1       : c.low  <= tp1;
    const tp2Hit  = dir === 'bull' ? c.high >= tp2       : c.low  <= tp2;
    const tp3Hit  = dir === 'bull' ? c.high >= tp3       : c.low  <= tp3;
    if (!tp1Hit) {
      if (slHit)   return { result: 'LOSS',       pnlR: -1 };
      if (tp3Hit)  return { result: 'WIN_TP3',    pnlR: 0.5*TP1_R + 0.25*TP2_R + 0.25*TP3_R };
      if (tp2Hit)  return { result: 'WIN_TP2',    pnlR: 0.5*TP1_R + 0.5*TP2_R };
      if (tp1Hit_) { tp1Hit = true; currentSL = entry; }
    } else {
      if (slHit)   return { result: 'WIN_TP1_BE', pnlR: 0.5*TP1_R };
      if (tp3Hit)  return { result: 'WIN_TP3',    pnlR: 0.5*TP1_R + 0.25*TP2_R + 0.25*TP3_R };
      if (tp2Hit)  return { result: 'WIN_TP2',    pnlR: 0.5*TP1_R + 0.5*TP2_R };
    }
  }
  if (tp1Hit) return { result: 'WIN_TP1_OPEN', pnlR: 0.5*TP1_R };
  return { result: 'OPEN', pnlR: null };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
function run() {
  console.log('\n' + chalk.bold.yellow('  ◆ XAUUSD ICT — 3 MONTH BACKTEST  [LIMIT ORDER + 2% COMPOUNDING  [KZ ONLY — London+NY]]'));
  console.log(chalk.gray(`  Entry: limit @ FVG midpoint  |  Fill window: ${FILL_WINDOW} bars (${FILL_WINDOW*5}min)  |  2% risk  |  £1,500 start\n`));

  const range = threeMonthRange();
  console.log(chalk.gray(`  Period: ${range.label}\n`));
  console.log(chalk.gray('  Loading data from 1-year cache...\n'));

  const all5m    = loadChunks('xau1yr_5min');
  const all15m   = loadChunks('xau1yr_15min');
  const allH1    = loadChunks('xau1yr_1h');
  const allH4    = rollup(allH1, 4);
  const allDaily = rollup(allH1, 24);

  console.log(chalk.green('  ✓ Data ready'));
  console.log(chalk.gray(`  5m total: ${all5m.length}  1h total: ${allH1.length}`));

  const period5m = all5m.filter(c => {
    const t = new Date(c.time); return t >= range.start && t <= range.end;
  });
  console.log(chalk.gray(`  5m bars in range: ${period5m.length}\n`));
  if (!period5m.length) { console.log(chalk.red('  No data.')); return; }

  const signals    = [];
  let lastBar      = -999;
  let balance      = ACCOUNT_START;
  let peakBalance  = ACCOUNT_START;
  let maxDrawdown  = 0;

  for (let i = 50; i < period5m.length - 1; i++) {
    const bar  = period5m[i];
    const time = new Date(bar.time);

    if (i - lastBar < COOLDOWN) continue;
    if (!isKillZone(bar.time)) continue;

    const slice5m  = all5m.filter(c  => new Date(c.time) <= time);
    const slice15m = all15m.filter(c => new Date(c.time) <= time);
    const sliceH1  = allH1.filter(c  => new Date(c.time) <= time);

    if (slice5m.length < 40 || allH4.length < 6 || allDaily.length < 5) continue;

    const asia    = asiaRange(sliceH1, bar.time);
    const session = { active: true, label: sessionLabel(bar.time) };

    let htf, lvls, sweepResult, mss, fvg, ob, conf;
    try {
      htf         = htfBias(allDaily, allH4);
      lvls        = keyLevels(allDaily, asia);
      const s5    = detectLiquiditySweep(slice5m,  lvls, htf);
      const s15   = detectLiquiditySweep(slice15m, lvls, htf);
      sweepResult = s5.mostRecent ? s5 : s15;
      mss         = detectMSS(slice5m, sweepResult);
      fvg         = entryFVG(slice5m, mss, sweepResult);
      ob          = findOrderBlock(slice5m, sweepResult);
      conf        = scoreConfluence(htf, sweepResult, mss, fvg, ob, session);
    } catch (e) { continue; }

    const dir = sweepResult.mostRecent?.dir;
    if (!dir || !mss.confirmed || conf.score < MIN_SCORE || !fvg?.inFVG) continue;
    if (!htfAlignedFn(htf, dir)) continue;

    const isLong     = dir === 'bull';
    const limitEntry = fvg.optimalEntry;                       // FVG midpoint — your limit price
    const buf        = limitEntry * 0.0008;
    const sl         = isLong
      ? Math.min((sweepResult.mostRecent.sweepLow  || limitEntry) - buf, limitEntry - buf * 2)
      : Math.max((sweepResult.mostRecent.sweepHigh || limitEntry) + buf, limitEntry + buf * 2);
    const risk = Math.abs(limitEntry - sl);
    if (risk > 15 || risk <= 0) continue;

    const tp1 = isLong ? limitEntry + risk * TP1_R : limitEntry - risk * TP1_R;
    const liq = liquidityTargets(dir, limitEntry, risk, lvls, slice5m, sliceH1);
    const tp2 = liq.tp2;
    const tp3 = liq.tp3;

    // ── Check if limit fills within FILL_WINDOW bars ──────────────────────────
    const fillBars = period5m.slice(i + 1, i + 1 + FILL_WINDOW);
    let fillIdx = -1;
    for (let f = 0; f < fillBars.length; f++) {
      const c = fillBars[f];
      if (isLong  && c.low  <= limitEntry) { fillIdx = f; break; }
      if (!isLong && c.high >= limitEntry) { fillIdx = f; break; }
    }

    if (fillIdx === -1) {
      // Price ran without filling — missed trade, no P&L
      signals.push({
        time: bar.time, dir: isLong ? 'BUY' : 'SELL',
        limitEntry: parseFloat(limitEntry.toFixed(2)),
        session: sessionLabel(bar.time),
        htfBias: htf.bias, score: conf.score, grade: conf.grade,
        sweep: sweepResult.mostRecent?.levelName || '—',
        result: 'MISSED', pnlR: 0, pnlGBP: 0,
        balanceAfter: parseFloat(balance.toFixed(2))
      });
      lastBar = i;
      continue;
    }

    // ── Filled — simulate from bar after fill ─────────────────────────────────
    const future  = period5m.slice(i + 1 + fillIdx + 1, i + 1 + fillIdx + 1 + SIM_BARS);
    const outcome = simulateOutcome(dir, limitEntry, sl, tp1, tp2, tp3, future);

    // 2% of CURRENT balance = risk amount — this is the compounding
    const riskGBP = balance * RISK_PCT;
    const pnlGBP  = outcome.pnlR != null ? outcome.pnlR * riskGBP : null;

    if (pnlGBP !== null) {
      balance += pnlGBP;
      if (balance > peakBalance) peakBalance = balance;
      const dd = ((peakBalance - balance) / peakBalance) * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    signals.push({
      time: bar.time, dir: isLong ? 'BUY' : 'SELL',
      limitEntry: parseFloat(limitEntry.toFixed(2)),
      sl: parseFloat(sl.toFixed(2)),
      tp1: parseFloat(tp1.toFixed(2)),
      tp2: parseFloat(tp2.toFixed(2)),
      tp3: parseFloat(tp3.toFixed(2)),
      risk: parseFloat(risk.toFixed(2)),
      session: sessionLabel(bar.time),
      htfBias: htf.bias,
      score: conf.score, grade: conf.grade,
      sweep: sweepResult.mostRecent?.levelName || '—',
      mssType: mss.type,
      fillBarsAfter: fillIdx + 1,
      riskGBP: parseFloat(riskGBP.toFixed(2)),
      pnlGBP:  pnlGBP != null ? parseFloat(pnlGBP.toFixed(2)) : null,
      balanceAfter: pnlGBP != null ? parseFloat(balance.toFixed(2)) : null,
      ...outcome
    });

    lastBar = i;
  }

  // ─── Print signals ────────────────────────────────────────────────────────────
  const sep = '═'.repeat(76);
  console.log('\n' + sep);
  console.log(chalk.bold.yellow('  SIGNAL LOG — XAUUSD LIMIT ORDER KZ ONLY — 3 MONTHS'));
  console.log(chalk.gray(`  ${range.label}  |  2% compounding risk  |  £1,500 start`));
  console.log(sep);

  signals.forEach((s, idx) => {
    const isLong = s.dir === 'BUY';
    const clr    = isLong ? chalk.green : chalk.red;

    if (s.result === 'MISSED') {
      console.log(
        chalk.gray(`  #${String(idx+1).padStart(2)}  ${fmtDT(s.time)}  `) +
        clr(`${isLong?'▲':'▼'} ${s.dir}`) +
        chalk.gray(`  Limit $${s.limitEntry}  ${s.score}%`) +
        chalk.gray('  ⚡ MISSED — ran without filling')
      );
      return;
    }

    const oc = s.result?.startsWith('WIN') ? chalk.green : s.result === 'LOSS' ? chalk.red : chalk.yellow;
    const pnlStr = s.pnlR != null
      ? (s.pnlR > 0
        ? chalk.green(`+${s.pnlR.toFixed(2)}R  +${fmtGBP(s.pnlGBP)}`)
        : chalk.red(`${s.pnlR.toFixed(2)}R  ${fmtGBP(s.pnlGBP)}`))
      : chalk.yellow('open');

    console.log(
      chalk.gray(`  #${String(idx+1).padStart(2)}  ${fmtDT(s.time)}  ${s.session}  `) +
      clr(`${isLong?'▲':'▼'} ${s.dir}`) +
      chalk.gray(`  ${s.score}%  filled ${s.fillBarsAfter}bar  risk ${fmtGBP(s.riskGBP)}`)
    );
    console.log(
      chalk.gray('       Limit ') + chalk.white(`$${s.limitEntry}`) +
      chalk.gray('  SL ') + chalk.red(`$${s.sl}`) +
      chalk.gray('  TP1 ') + chalk.green(`$${s.tp1}`) +
      chalk.gray('  TP2 ') + chalk.green(`$${s.tp2}`) +
      '  ' + oc(s.result) + '  ' + pnlStr +
      (s.balanceAfter ? chalk.gray('  → ') + chalk.white(fmtGBP(s.balanceAfter)) : '')
    );
  });

  // ─── Summary ─────────────────────────────────────────────────────────────────
  const filled  = signals.filter(s => s.result !== 'MISSED');
  const missed  = signals.filter(s => s.result === 'MISSED');
  const closed  = filled.filter(s => s.pnlR != null);
  const wins    = closed.filter(s => s.pnlR > 0);
  const losses  = closed.filter(s => s.pnlR < 0);
  const totalR  = closed.reduce((s, x) => s + x.pnlR, 0);
  const totalGBP= closed.reduce((s, x) => s + (x.pnlGBP || 0), 0);
  const wr      = closed.length ? ((wins.length / closed.length) * 100).toFixed(0) : 0;
  const pf      = losses.length
    ? (wins.reduce((s,x)=>s+x.pnlR,0) / Math.abs(losses.reduce((s,x)=>s+x.pnlR,0))).toFixed(2)
    : '∞';
  const fillRate = signals.length ? ((filled.length / signals.length)*100).toFixed(0) : 0;
  const avgFill  = filled.length ? (filled.reduce((s,x)=>s+(x.fillBarsAfter||0),0)/filled.length).toFixed(1) : '—';

  // Month breakdown
  const byMonth = {};
  signals.forEach(s => {
    const d  = new Date(s.time);
    const mk = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
    byMonth[mk] = byMonth[mk] || [];
    byMonth[mk].push(s);
  });

  console.log('\n\n' + sep);
  console.log(chalk.bold.yellow('  3-MONTH SUMMARY — XAUUSD LIMIT ORDER + 2% COMPOUNDING'));
  console.log(sep);
  console.log(chalk.gray('  Total signals:      ') + chalk.white(signals.length));
  console.log(chalk.gray('  Limits filled:      ') + chalk.green(`${filled.length}`) + chalk.gray(` (${fillRate}% fill rate)`));
  console.log(chalk.gray('  Limits missed:      ') + chalk.yellow(`${missed.length}`) + chalk.gray(' (price ran without us)'));
  console.log(chalk.gray('  Avg fill time:      ') + chalk.white(`${avgFill} bars (${(parseFloat(avgFill)*5).toFixed(0)}min)`));
  console.log(chalk.gray('  Wins:               ') + chalk.green(wins.length));
  console.log(chalk.gray('  Losses:             ') + chalk.red(losses.length));
  console.log(chalk.gray('  Win rate:           ') + (parseFloat(wr)>=50?chalk.green:chalk.yellow)(`${wr}%`));
  console.log(chalk.gray('  Net R (filled):     ') + (totalR>=0?chalk.green(`+${totalR.toFixed(2)}R`):chalk.red(`${totalR.toFixed(2)}R`)));
  console.log(chalk.gray('  Profit factor:      ') + chalk.cyan(pf));

  console.log('\n' + chalk.bold.yellow('  ── ACCOUNT  (£1,500 start · 2% risk · compounds every trade) ──'));
  console.log(chalk.gray('  Start:              ') + chalk.white('£1,500.00'));
  console.log(chalk.gray('  End:                ') + (balance>=ACCOUNT_START?chalk.green:chalk.red)(fmtGBP(balance)));
  console.log(chalk.gray('  Net profit:         ') + (totalGBP>=0?chalk.green(`+${fmtGBP(totalGBP)}`):chalk.red(fmtGBP(totalGBP))));
  console.log(chalk.gray('  Return:             ') + (balance>=ACCOUNT_START?chalk.green:chalk.red)(fmtPct((balance-ACCOUNT_START)/ACCOUNT_START*100)));
  console.log(chalk.gray('  Peak balance:       ') + chalk.white(fmtGBP(peakBalance)));
  console.log(chalk.gray('  Max drawdown:       ') + chalk.yellow(`${maxDrawdown.toFixed(1)}%`));

  console.log(chalk.gray('\n  Month by month:'));
  Object.entries(byMonth).sort().forEach(([mo, sigs]) => {
    const mFilled  = sigs.filter(s => s.result !== 'MISSED');
    const mMissed  = sigs.filter(s => s.result === 'MISSED');
    const mW       = mFilled.filter(s => s.pnlR > 0).length;
    const mL       = mFilled.filter(s => s.pnlR < 0).length;
    const mGBP     = mFilled.reduce((s,x)=>s+(x.pnlGBP||0),0);
    const mWR      = (mW+mL)>0 ? Math.round(mW/(mW+mL)*100) : 0;
    const mR       = mFilled.reduce((s,x)=>s+(x.pnlR||0),0);
    console.log(
      chalk.gray(`    ${mo}  `) +
      chalk.white(`${sigs.length} signals`) +
      chalk.gray(`  filled ${mFilled.length}  missed ${mMissed.length}  `) +
      chalk.green(`${mW}W`) + chalk.gray('/') + chalk.red(`${mL}L`) +
      chalk.gray(`  ${mWR}% WR  `) +
      (mR>=0?chalk.green(`+${mR.toFixed(1)}R`):chalk.red(`${mR.toFixed(1)}R`)) +
      chalk.gray('  ') +
      (mGBP>=0?chalk.green(`+${fmtGBP(mGBP)}`):chalk.red(fmtGBP(mGBP)))
    );
  });

  console.log(chalk.gray('\n  Session breakdown:'));
  const bySess = {};
  signals.forEach(s => { bySess[s.session] = (bySess[s.session]||[]).concat(s); });
  Object.entries(bySess).sort((a,b)=>b[1].length-a[1].length).forEach(([sess,sigs])=>{
    const sF  = sigs.filter(s=>s.result!=='MISSED');
    const sW  = sF.filter(s=>s.pnlR>0).length;
    const sL  = sF.filter(s=>s.pnlR<0).length;
    const sWR = (sW+sL)>0?Math.round(sW/(sW+sL)*100):0;
    const sGBP= sF.reduce((s,x)=>s+(x.pnlGBP||0),0);
    console.log(
      chalk.gray(`    ${(sess).padEnd(22)} ${sigs.length} signals  filled ${sF.length}  `) +
      chalk.green(`${sW}W`) + chalk.gray('/') + chalk.red(`${sL}L`) +
      chalk.gray(`  ${sWR}% WR  `) +
      (sGBP>=0?chalk.green(`+${fmtGBP(sGBP)}`):chalk.red(fmtGBP(sGBP)))
    );
  });

  console.log(chalk.gray('\n  Result breakdown (filled trades only):'));
  const byResult = {};
  filled.forEach(s => { byResult[s.result] = (byResult[s.result]||0)+1; });
  Object.entries(byResult).sort((a,b)=>b[1]-a[1]).forEach(([r,n])=>{
    const c = r?.startsWith('WIN') ? chalk.green : r==='LOSS' ? chalk.red : chalk.yellow;
    const avgR = filled.filter(s=>s.result===r).reduce((s,x)=>s+(x.pnlR||0),0)/n;
    console.log(chalk.gray(`    ${c((r||'?').padEnd(16))}  ${n} trades  avg ${avgR>=0?'+':''}${avgR.toFixed(2)}R`));
  });

  console.log('\n' + sep + '\n');

  const reportPath = path.join(__dirname, '..', 'backtest_report_limit_xau_kz.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    period: range.label, generatedAt: new Date().toISOString(),
    settings: { symbol: 'XAUUSD', entryMethod: 'limit_fvg_midpoint',
      fillWindowBars: FILL_WINDOW, fillWindowMins: FILL_WINDOW*5,
      startBalance: ACCOUNT_START, riskPct: RISK_PCT*100, compounding: true },
    account: {
      start: ACCOUNT_START, end: parseFloat(balance.toFixed(2)),
      netGBP: parseFloat(totalGBP.toFixed(2)),
      returnPct: parseFloat(((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)),
      peakBalance: parseFloat(peakBalance.toFixed(2)),
      maxDrawdown: parseFloat(maxDrawdown.toFixed(1))
    },
    stats: { total: signals.length, filled: filled.length, missed: missed.length,
      fillRatePct: fillRate, wins: wins.length, losses: losses.length,
      winRate: wr+'%', netR: totalR.toFixed(2), profitFactor: pf,
      avgFillBars: avgFill, avgFillMins: (parseFloat(avgFill)*5).toFixed(0) },
    byMonth: Object.fromEntries(Object.entries(byMonth).map(([mo,sigs])=>[mo,{
      signals: sigs.length,
      filled: sigs.filter(s=>s.result!=='MISSED').length,
      missed: sigs.filter(s=>s.result==='MISSED').length,
      wins: sigs.filter(s=>s.pnlR>0).length,
      losses: sigs.filter(s=>s.pnlR<0).length,
      netR: sigs.reduce((s,x)=>s+(x.pnlR||0),0).toFixed(2),
      netGBP: sigs.reduce((s,x)=>s+(x.pnlGBP||0),0).toFixed(2)
    }])),
    signals
  }, null, 2));
  console.log(chalk.gray('  Report saved → backtest_report_limit_xau.json\n'));
}

run();
