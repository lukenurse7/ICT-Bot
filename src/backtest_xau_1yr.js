'use strict';

// XAUUSD ICT — 1-YEAR BACKTEST
// Data loaded from pre-cached monthly chunks in .cache/xau1yr_*
// No API calls. Same strategy logic as backtest_limit_xau_kz.js

require('dotenv').config();
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
const SIM_BARS      = 288;
const MIN_SCORE     = 80;
const COOLDOWN      = 36;
const FILL_WINDOW   = 12;

const CACHE = path.join(__dirname, '..', '.cache');

function fmt(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; }
function fmtDT(iso) { const d=new Date(iso); return `${fmt(d)} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} UTC`; }
function fmtGBP(n) { return (n>=0?'+':'') + '£' + Math.abs(n).toFixed(2); }
function fmtPct(n) { return (n>=0?'+':'') + n.toFixed(1) + '%'; }

function rollup(src, factor) {
  const out = [];
  for (let i = 0; i < src.length; i += factor) {
    const s = src.slice(i, i + factor);
    if (!s.length) continue;
    out.push({ time: s[0].time, open: s[0].open, high: Math.max(...s.map(c=>c.high)),
      low: Math.min(...s.map(c=>c.low)), close: s[s.length-1].close });
  }
  return out;
}

function sessionLabel(iso) {
  const h = new Date(iso).getUTCHours();
  if (h >= 7  && h < 9)  return '🟡 London KZ';
  return 'Off-hours';
}
function isKillZone(iso) {
  const h = new Date(iso).getUTCHours();
  return (h >= 7 && h < 9);
}
function asiaRange(h1Candles, dateIso) {
  const start = new Date(dateIso); start.setUTCHours(0,0,0,0);
  const end   = new Date(dateIso); end.setUTCHours(6,0,0,0);
  const asia  = h1Candles.filter(c => { const t=new Date(c.time); return t>=start && t<end; });
  if (!asia.length) return null;
  return { high: Math.max(...asia.map(c=>c.high)), low: Math.min(...asia.map(c=>c.low)) };
}
function htfAlignedFn(htf, dir) {
  // In XAU bull market context: only take BUY setups (SSL sweeps reversing up)
  // Selling into pullbacks on a macro bull trend has shown poor results
  return dir === 'bull';
}
function simulateOutcome(dir, entry, sl, tp1, tp2, tp1R, tp2R, futureCandles) {
  let tp1Hit=false, currentSL=sl;
  for (const c of futureCandles) {
    const slHit  = dir==='bull' ? c.low<=currentSL : c.high>=currentSL;
    const tp1Hit_= dir==='bull' ? c.high>=tp1 : c.low<=tp1;
    const tp2Hit = dir==='bull' ? c.high>=tp2 : c.low<=tp2;
    if (!tp1Hit) {
      if (slHit)  return { result:'LOSS',      pnlR:-1 };
      if (tp2Hit) return { result:'WIN_TP2',   pnlR:+(0.5*tp1R+0.5*tp2R).toFixed(2) };
      if (tp1Hit_){ tp1Hit=true; currentSL=entry; }
    } else {
      if (slHit)  return { result:'WIN_TP1_BE',pnlR:+(0.5*tp1R).toFixed(2) };
      if (tp2Hit) return { result:'WIN_TP2',   pnlR:+(0.5*tp1R+0.5*tp2R).toFixed(2) };
    }
  }
  if (tp1Hit) return { result:'WIN_TP1_OPEN', pnlR:+(0.5*tp1R).toFixed(2) };
  return { result:'OPEN', pnlR:null };
}

// ─── Load and merge cached monthly chunks ─────────────────────────────────
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

function run() {
  console.log('\n' + chalk.bold.yellow('  ◆ XAUUSD ICT — 1-YEAR BACKTEST  [LIMIT ORDER + 2% COMPOUNDING]'));
  console.log(chalk.gray('  Period: 2025-06-11 → 2026-06-10  |  London Kill Zone ONLY (07:00–09:00 UTC)\n'));

  const all5m  = loadChunks('xau1yr_5min');
  const all15m = loadChunks('xau1yr_15min');
  const allH1  = loadChunks('xau1yr_1h');
  const allH4  = rollup(allH1, 4);
  const allDay = rollup(allH1, 24);

  const START = new Date('2025-06-11T00:00:00Z');
  const END   = new Date('2026-06-10T23:59:59Z');
  const period5m = all5m.filter(c => { const t=new Date(c.time); return t>=START && t<=END; });

  console.log(chalk.gray(`  5m bars: ${period5m.length}  |  1h bars: ${allH1.length}  |  4h bars: ${allH4.length}`));
  console.log(chalk.gray(`  Range: ${period5m[0]?.time?.slice(0,10)} → ${period5m[period5m.length-1]?.time?.slice(0,10)}\n`));

  const signals = [];
  let lastBar=-999, balance=ACCOUNT_START, peakBalance=ACCOUNT_START, maxDrawdown=0;

  for (let i=50; i<period5m.length-1; i++) {
    const bar  = period5m[i];
    const time = new Date(bar.time);
    if (i - lastBar < COOLDOWN) continue;
    if (!isKillZone(bar.time)) continue;

    const slice5m  = all5m.filter(c  => new Date(c.time) <= time);
    const slice15m = all15m.filter(c => new Date(c.time) <= time);
    const sliceH1  = allH1.filter(c  => new Date(c.time) <= time);
    if (slice5m.length < 40 || allH4.length < 6 || allDay.length < 5) continue;

    const asia    = asiaRange(sliceH1, bar.time);
    const session = { active: true, label: sessionLabel(bar.time) };
    let htf, lvls, sweepResult, mss, fvg, ob, conf;
    try {
      htf         = htfBias(allDay, allH4);
      lvls        = keyLevels(allDay, asia);
      const s5    = detectLiquiditySweep(slice5m,  lvls, htf);
      const s15   = detectLiquiditySweep(slice15m, lvls, htf);
      sweepResult = s5.mostRecent ? s5 : s15;
      mss         = detectMSS(slice5m, sweepResult);
      fvg         = entryFVG(slice5m, mss, sweepResult);
      ob          = findOrderBlock(slice5m, sweepResult);
      conf        = scoreConfluence(htf, sweepResult, mss, fvg, ob, session);
    } catch(e) { continue; }

    const dir = sweepResult.mostRecent?.dir;
    if (!dir || !mss.confirmed || conf.score < MIN_SCORE || !fvg?.inFVG) continue;
    if (!htfAlignedFn(htf, dir)) continue;

    const isLong     = dir === 'bull';
    const limitEntry = fvg.optimalEntry;

    const SL_BUF = 3;
    let sl;
    if (isLong) {
      const sweepExtreme = sweepResult.mostRecent.sweepLow ?? (limitEntry - SL_BUF * 3);
      sl = parseFloat((sweepExtreme - SL_BUF).toFixed(2));
      if (sl >= limitEntry) sl = parseFloat((limitEntry - SL_BUF * 3).toFixed(2));
    } else {
      const sweepExtreme = sweepResult.mostRecent.sweepHigh ?? (limitEntry + SL_BUF * 3);
      sl = parseFloat((sweepExtreme + SL_BUF).toFixed(2));
      if (sl <= limitEntry) sl = parseFloat((limitEntry + SL_BUF * 3).toFixed(2));
    }
    const risk = parseFloat(Math.abs(limitEntry - sl).toFixed(2));
    if (risk > 15 || risk <= 0) continue;

    const liq  = liquidityTargets(dir, limitEntry, risk, lvls, slice5m, sliceH1);
    const tp1  = liq.tp1, tp2 = liq.tp2, tp1R = liq.tp1R, tp2R = liq.tp2R;

    const fillBars = period5m.slice(i+1, i+1+FILL_WINDOW);
    let fillIdx = -1;
    for (let f=0; f<fillBars.length; f++) {
      const c = fillBars[f];
      if (isLong && c.low<=limitEntry)  { fillIdx=f; break; }
      if (!isLong && c.high>=limitEntry){ fillIdx=f; break; }
    }

    if (fillIdx === -1) {
      signals.push({ time: bar.time, dir: isLong?'BUY':'SELL',
        limitEntry: parseFloat(limitEntry.toFixed(2)),
        session: sessionLabel(bar.time), htfBias: htf.bias,
        score: conf.score, grade: conf.grade,
        sweep: sweepResult.mostRecent?.levelName||'—',
        result:'MISSED', pnlR:0, pnlGBP:0, balanceAfter:parseFloat(balance.toFixed(2)) });
      lastBar = i; continue;
    }

    const future  = period5m.slice(i+1+fillIdx+1, i+1+fillIdx+1+SIM_BARS);
    const outcome = simulateOutcome(dir, limitEntry, sl, tp1, tp2, tp1R, tp2R, future);
    const riskGBP = balance * RISK_PCT;
    const pnlGBP  = outcome.pnlR != null ? outcome.pnlR * riskGBP : null;
    if (pnlGBP !== null) {
      balance += pnlGBP;
      if (balance > peakBalance) peakBalance = balance;
      const dd = (peakBalance-balance)/peakBalance*100;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
    signals.push({ time: bar.time, dir: isLong?'BUY':'SELL',
      limitEntry: parseFloat(limitEntry.toFixed(2)),
      sl, tp1, tp2, tp1R, tp2R,
      risk: parseFloat(risk.toFixed(2)),
      session: sessionLabel(bar.time), htfBias: htf.bias,
      score: conf.score, grade: conf.grade,
      sweep: sweepResult.mostRecent?.levelName||'—', mssType: mss.type,
      fillBarsAfter: fillIdx+1,
      riskGBP: parseFloat(riskGBP.toFixed(2)),
      pnlGBP:  pnlGBP!=null ? parseFloat(pnlGBP.toFixed(2)) : null,
      balanceAfter: pnlGBP!=null ? parseFloat(balance.toFixed(2)) : null,
      ...outcome });
    lastBar = i;
  }

  // ─── Summary ───────────────────────────────────────────────────────────
  const sep     = '═'.repeat(76);
  const filled  = signals.filter(s => s.result !== 'MISSED');
  const missed  = signals.filter(s => s.result === 'MISSED');
  const closed  = filled.filter(s => s.pnlR != null);
  const wins    = closed.filter(s => s.pnlR > 0);
  const losses  = closed.filter(s => s.pnlR < 0);
  const totalR  = closed.reduce((s,x)=>s+x.pnlR, 0);
  const totalGBP= closed.reduce((s,x)=>s+(x.pnlGBP||0), 0);
  const wr      = closed.length ? ((wins.length/closed.length)*100).toFixed(0) : 0;
  const pf      = losses.length
    ? (wins.reduce((s,x)=>s+x.pnlR,0)/Math.abs(losses.reduce((s,x)=>s+x.pnlR,0))).toFixed(2)
    : wins.length ? '∞' : '0.00';

  const byMonth = {};
  signals.forEach(s => {
    const d=new Date(s.time);
    const k=`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
    byMonth[k]=(byMonth[k]||[]).concat(s);
  });

  console.log('\n' + sep);
  console.log(chalk.bold.yellow('  1-YEAR SUMMARY — XAUUSD LIMIT ORDER + 2% COMPOUNDING'));
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

  console.log(chalk.gray('\n  Session breakdown:'));
  const bySess = {};
  signals.forEach(s => { bySess[s.session]=(bySess[s.session]||[]).concat(s); });
  Object.entries(bySess).sort((a,b)=>b[1].length-a[1].length).forEach(([sess,sigs])=>{
    const sF=sigs.filter(s=>s.result!=='MISSED');
    const sW=sF.filter(s=>s.pnlR>0).length, sL=sF.filter(s=>s.pnlR<0).length;
    const sWR=(sW+sL)>0?Math.round(sW/(sW+sL)*100):0;
    const sGBP=sF.reduce((s,x)=>s+(x.pnlGBP||0),0);
    console.log(chalk.gray(`    ${sess.padEnd(20)} ${sigs.length} signals  filled ${sF.length}  `)+
      chalk.green(`${sW}W`)+'/'+chalk.red(`${sL}L`)+chalk.gray(`  ${sWR}% WR  `)+
      (sGBP>=0?chalk.green(fmtGBP(sGBP)):chalk.red(fmtGBP(sGBP))));
  });

  console.log('\n' + sep + '\n');

  fs.writeFileSync(path.join(__dirname, '..', 'backtest_report_xau_1yr.json'),
    JSON.stringify({ period:'2025-06-11 → 2026-06-10', generatedAt:new Date().toISOString(),
      account:{ start:ACCOUNT_START, end:parseFloat(balance.toFixed(2)),
        returnPct:parseFloat(((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)),
        peakBalance:parseFloat(peakBalance.toFixed(2)), maxDrawdown:parseFloat(maxDrawdown.toFixed(1)) },
      stats:{ total:signals.length, filled:filled.length, missed:missed.length,
        wins:wins.length, losses:losses.length, winRate:wr+'%',
        netR:totalR.toFixed(2), profitFactor:pf }, signals }, null, 2));
  console.log(chalk.gray('  Report → backtest_report_xau_1yr.json\n'));
}

run();
