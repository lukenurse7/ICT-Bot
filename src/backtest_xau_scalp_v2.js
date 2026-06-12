'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  XAUUSD ICT SCALP v2 — WEEKLY BIAS FILTER + HIGHER FREQUENCY
//
//  Fixes from clean-slate analysis:
//  1. Weekly bias filter: H1 20-SMA slope — only trade direction aligned
//     with the weekly trend. Prevents selling into a raging bull market.
//  2. Higher frequency levers:
//     a) Add PDH/PDL as sweep levels alongside Asia H/L
//     b) Allow multiple signals per day (remove one-per-day cap)
//     c) Reduce cooldown to 3 bars (15 min)
//     d) Displacement ratio relaxed to 0.50
//     e) Min risk $5 filter (removes the $0.50-risk junk trades)
//  3. Conservative entry only (FVG far-edge — proven best in v1)
//  4. Compare: WITH weekly bias filter vs WITHOUT (so we see the difference)
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const ACCOUNT_START  = 1500;
const RISK_PCT       = 0.02;
const SIM_BARS       = 48;
const COOLDOWN_BARS  = 3;     // 15 min — scalp frequency
const MIN_WICK       = 1.5;
const MIN_FVG        = 1.50;
const DISPLACE_RATIO = 0.50;  // relaxed from 0.55
const MIN_RISK       = 5;     // $5 min risk — removes micro-gap noise
const TP1_R          = 1.0;
const TP2_R          = 2.0;

const CACHE = path.join(__dirname, '..', '.cache');
function fmtPct(n) { return (n>=0?'+':'') + n.toFixed(1) + '%'; }
function fmtGBP(n) { return (n>=0?'+':'') + '£' + Math.abs(n).toFixed(2); }

const NEWS_DATES = new Set([
  '2025-07-04','2025-08-01','2025-09-05','2025-10-03','2025-11-07',
  '2025-12-05','2026-01-09','2026-02-06','2026-03-06','2026-04-03',
  '2026-05-01','2026-06-05','2025-07-30','2025-09-17','2025-11-05',
  '2025-12-17','2026-01-28','2026-03-18','2026-05-06','2026-06-17',
  '2025-07-11','2025-08-13','2025-09-11','2025-10-15','2025-11-13',
  '2025-12-11','2026-01-15','2026-02-12','2026-03-12','2026-04-10',
  '2026-05-13','2026-06-11',
]);
function isNews(t) {
  if (!NEWS_DATES.has(t.slice(0,10))) return false;
  const h = new Date(t).getUTCHours();
  return h >= 12 && h <= 15;
}

function loadChunks(prefix) {
  const all = [];
  for (let y=2025, m=6; !(y===2026&&m===7);) {
    const s  = `${y}-${String(m).padStart(2,'0')}-01`;
    const nm = m+1>12?1:m+1, ny = m+1>12?y+1:y;
    const e  = `${ny}-${String(nm).padStart(2,'0')}-01`;
    const f  = path.join(CACHE, `${prefix}_${s}_${e}.json`);
    if (fs.existsSync(f)) all.push(...JSON.parse(fs.readFileSync(f)));
    m++; if (m>12){m=1;y++;}
  }
  const seen = new Set();
  return all.filter(c=>{if(seen.has(c.time))return false;seen.add(c.time);return true;})
    .sort((a,b)=>a.time.localeCompare(b.time));
}

// ─── Weekly bias from H1 20-SMA slope ────────────────────────────────────
// Returns 'bull', 'bear', or 'neutral'
function getWeeklyBias(h1Bars) {
  const w = h1Bars.slice(-40);
  if (w.length < 25) return 'neutral';

  // 20-SMA of closes
  function sma(bars, n) {
    const slice = bars.slice(-n);
    return slice.reduce((s,c) => s + c.close, 0) / slice.length;
  }

  const sma20now  = sma(w, 20);
  const sma20prev = sma(w.slice(0,-5), 20); // 5 H1 bars ago (5h back)
  const slope     = (sma20now - sma20prev) / sma20prev;

  // Also check: is current price above/below 20 SMA?
  const lastClose = w[w.length-1].close;
  const aboveSMA  = lastClose > sma20now;

  if (slope >  0.001 && aboveSMA) return 'bull';   // SMA rising + price above
  if (slope < -0.001 && !aboveSMA) return 'bear';  // SMA falling + price below
  return 'neutral';
}

// ─── Asia range ────────────────────────────────────────────────────────────
function getAsiaRange(bars, dateStr) {
  const s = bars.filter(c => {
    if (!c.time.startsWith(dateStr)) return false;
    const h = new Date(c.time).getUTCHours();
    return h >= 0 && h < 7;
  });
  if (s.length < 4) return null;
  return { high: Math.max(...s.map(c=>c.high)), low: Math.min(...s.map(c=>c.low)) };
}

function getPDRange(bars, dateStr) {
  const today = new Date(dateStr + 'T00:00:00Z');
  const yest  = new Date(today - 86400000);
  const s = bars.filter(c => { const t=new Date(c.time); return t>=yest && t<today; });
  if (!s.length) return null;
  return { high: Math.max(...s.map(c=>c.high)), low: Math.min(...s.map(c=>c.low)) };
}

// ─── Find all sweep candidates in London window ────────────────────────────
function findAllSweeps(londonBars, levels) {
  const sweeps = [];
  for (let i = 0; i < londonBars.length; i++) {
    const c = londonBars[i];
    const h = new Date(c.time).getUTCHours();
    if (h < 7 || h >= 10) continue;

    for (const lvl of levels) {
      if (lvl.dir === 'bear' && c.high > lvl.price && c.close < lvl.price
          && (c.high - lvl.price) >= MIN_WICK) {
        sweeps.push({ dir:'bear', level:lvl.price, label:lvl.label,
          sweepExtreme:c.high, sweepCandle:c, barIdx:i });
      }
      if (lvl.dir === 'bull' && c.low < lvl.price && c.close > lvl.price
          && (lvl.price - c.low) >= MIN_WICK) {
        sweeps.push({ dir:'bull', level:lvl.price, label:lvl.label,
          sweepExtreme:c.low, sweepCandle:c, barIdx:i });
      }
    }
  }
  // Deduplicate: keep earliest sweep per direction per level label
  const seen = new Set();
  return sweeps.filter(s => {
    const k = `${s.dir}_${s.label}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
}

// ─── FVG with displacement ─────────────────────────────────────────────────
function findFVG(bars, sweepDir, fromIdx) {
  const fvgs = [];
  for (let i = Math.max(1, fromIdx); i < bars.length - 1; i++) {
    const c0=bars[i-1], c1=bars[i], c2=bars[i+1];
    const range = c1.high - c1.low;
    if (range < 0.5) continue;
    const body = Math.abs(c1.close - c1.open);
    if (body / range < DISPLACE_RATIO) continue;

    if (sweepDir === 'bear' && c2.high < c0.low && c1.close < c1.open) {
      const size = c0.low - c2.high;
      if (size >= MIN_FVG)
        fvgs.push({ type:'bearish', top:c0.low, bottom:c2.high,
          midpoint:(c0.low+c2.high)/2, size, bfs:i-fromIdx });
    }
    if (sweepDir === 'bull' && c2.low > c0.high && c1.close > c1.open) {
      const size = c2.low - c0.high;
      if (size >= MIN_FVG)
        fvgs.push({ type:'bullish', top:c2.low, bottom:c0.high,
          midpoint:(c2.low+c0.high)/2, size, bfs:i-fromIdx });
    }
    // Inversion FVGs
    if (sweepDir === 'bear' && c2.low > c0.high && c1.close < c1.open) {
      const last = bars[bars.length-1];
      if (last.close < c0.high) {
        const size = c2.low - c0.high;
        if (size >= MIN_FVG)
          fvgs.push({ type:'inv_bear', top:c2.low, bottom:c0.high,
            midpoint:(c2.low+c0.high)/2, size, bfs:i-fromIdx, inv:true });
      }
    }
    if (sweepDir === 'bull' && c2.high < c0.low && c1.close > c1.open) {
      const last = bars[bars.length-1];
      if (last.close > c0.low) {
        const size = c0.low - c2.high;
        if (size >= MIN_FVG)
          fvgs.push({ type:'inv_bull', top:c0.low, bottom:c2.high,
            midpoint:(c0.low+c2.high)/2, size, bfs:i-fromIdx, inv:true });
      }
    }
  }
  if (!fvgs.length) return null;
  fvgs.sort((a,b) => (a.inv?0:1)-(b.inv?0:1) || a.bfs-b.bfs);
  return fvgs[0];
}

// ─── Simulate ────────────────────────────────────────────────────────────────
function simulate(dir, entry, sl, tp1, tp2, future) {
  const r = Math.abs(entry - sl);
  const tp1R = +(Math.abs(tp1-entry)/r).toFixed(2);
  const tp2R = +(Math.abs(tp2-entry)/r).toFixed(2);
  let hit=false, sl_=sl;
  for (const c of future) {
    const slH = dir==='bull' ? c.low<=sl_  : c.high>=sl_;
    const t1  = dir==='bull' ? c.high>=tp1 : c.low<=tp1;
    const t2  = dir==='bull' ? c.high>=tp2 : c.low<=tp2;
    if (!hit) {
      if (slH) return { pnlR:-1, result:'LOSS', tp1R, tp2R };
      if (t2)  return { pnlR:+(0.5*tp1R+0.5*tp2R).toFixed(2), result:'WIN_TP2', tp1R, tp2R };
      if (t1)  { hit=true; sl_=entry; }
    } else {
      if (slH) return { pnlR:+(0.5*tp1R).toFixed(2), result:'WIN_BE', tp1R, tp2R };
      if (t2)  return { pnlR:+(0.5*tp1R+0.5*tp2R).toFixed(2), result:'WIN_TP2', tp1R, tp2R };
    }
  }
  if (hit) return { pnlR:+(0.5*tp1R).toFixed(2), result:'WIN_OPEN', tp1R, tp2R };
  return { pnlR:null, result:'OPEN', tp1R, tp2R };
}

// ─── Run one scenario ────────────────────────────────────────────────────────
function runScenario(period5m, allH1, label, useBiasFilter) {
  const signals = [];
  let balance = ACCOUNT_START, peak = ACCOUNT_START, maxDD = 0;
  let lastBar  = -999;
  let h1Ptr    = 0;

  for (let i = 50; i < period5m.length - SIM_BARS - 5; i++) {
    const bar = period5m[i];
    const h   = new Date(bar.time).getUTCHours();
    if (h < 7 || h >= 10) continue;
    if (i - lastBar < COOLDOWN_BARS) continue;
    if (isNews(bar.time)) continue;

    // Advance H1 pointer
    while (h1Ptr < allH1.length-1 && allH1[h1Ptr+1].time <= bar.time) h1Ptr++;
    const sliceH1 = allH1.slice(Math.max(0, h1Ptr-60), h1Ptr+1);

    // Weekly bias
    const bias = getWeeklyBias(sliceH1);

    const dateStr  = bar.time.slice(0,10);
    const slice5m  = period5m.slice(Math.max(0, i-300), i+1);
    const asia     = getAsiaRange(slice5m, dateStr);
    if (!asia) continue;
    const pd       = getPDRange(slice5m, dateStr);

    // Build all sweep levels: Asia H/L + PDH/PDL
    const levels = [
      { price: asia.high, label: 'Asia High', dir: 'bear' },
      { price: asia.low,  label: 'Asia Low',  dir: 'bull' },
    ];
    if (pd) {
      if (Math.abs(pd.high - asia.high) / asia.high > 0.001)
        levels.push({ price: pd.high, label: 'PDH', dir: 'bear' });
      if (Math.abs(pd.low - asia.low) / asia.low > 0.001)
        levels.push({ price: pd.low, label: 'PDL', dir: 'bull' });
    }

    const londonBars = slice5m.filter(c => {
      if (!c.time.startsWith(dateStr)) return false;
      const ch = new Date(c.time).getUTCHours();
      return ch >= 7 && ch < 10;
    });
    if (londonBars.length < 3) continue;

    const sweeps = findAllSweeps(londonBars, levels);

    for (const sweep of sweeps) {
      // Weekly bias filter
      if (useBiasFilter) {
        if (bias === 'bull' && sweep.dir === 'bear') continue;  // don't sell in bull trend
        if (bias === 'bear' && sweep.dir === 'bull') continue;  // don't buy in bear trend
        // neutral = allow both
      }

      const postBars = londonBars.slice(sweep.barIdx);
      if (postBars.length < 3) continue;

      const fvg = findFVG(postBars, sweep.dir, 0);
      if (!fvg) continue;

      const isLong = sweep.dir === 'bull';
      // Conservative entry: SELL→FVG bottom, BUY→FVG top
      const entry  = isLong ? fvg.top : fvg.bottom;
      const sl     = isLong ? sweep.sweepExtreme*(1-0.001) : sweep.sweepExtreme*(1+0.001);
      const risk   = Math.abs(entry - sl);

      if (risk < MIN_RISK || risk > entry * 0.025) continue;

      const tp1 = isLong ? entry + risk*TP1_R : entry - risk*TP1_R;
      const tp2 = isLong ? entry + risk*TP2_R : entry - risk*TP2_R;

      // Fill check
      const fillW  = period5m.slice(i+1, i+25);
      let fillIdx  = -1;
      for (let f=0; f<fillW.length; f++) {
        const c = fillW[f];
        if (isLong  && c.low  <= entry) { fillIdx=f; break; }
        if (!isLong && c.high >= entry) { fillIdx=f; break; }
      }

      if (fillIdx === -1) {
        signals.push({ time:bar.time, dir:isLong?'BUY':'SELL', sweep:sweep.label,
          entry:+entry.toFixed(2), result:'MISSED', pnlR:0, pnlGBP:0,
          balanceAfter:+balance.toFixed(2), fvgType:fvg.type,
          risk:+risk.toFixed(2), bias });
        continue;
      }

      lastBar = i;
      const future  = period5m.slice(i+fillIdx+2, i+fillIdx+2+SIM_BARS);
      const outcome = simulate(sweep.dir, entry, sl, tp1, tp2, future);
      const riskGBP = balance * RISK_PCT;
      const pnlGBP  = outcome.pnlR != null ? outcome.pnlR * riskGBP : null;

      if (pnlGBP !== null) {
        balance += pnlGBP;
        if (balance > peak) peak = balance;
        const dd = (peak - balance)/peak*100;
        if (dd > maxDD) maxDD = dd;
      }

      signals.push({ time:bar.time, dir:isLong?'BUY':'SELL', sweep:sweep.label,
        entry:+entry.toFixed(2), sl:+sl.toFixed(2), tp1:+tp1.toFixed(2), tp2:+tp2.toFixed(2),
        risk:+risk.toFixed(2), fvgType:fvg.type, bias,
        fillBarsAfter:fillIdx+1,
        riskGBP:+riskGBP.toFixed(2),
        pnlGBP: pnlGBP!=null ? +pnlGBP.toFixed(2) : null,
        balanceAfter:+balance.toFixed(2),
        ...outcome });
    }
  }
  return { label, signals, balance, maxDD };
}

// ─── Print results ────────────────────────────────────────────────────────────
function printResults(res, color) {
  const { label, signals, balance, maxDD } = res;
  const filled  = signals.filter(s => s.result !== 'MISSED');
  const missed  = signals.filter(s => s.result === 'MISSED');
  const closed  = filled.filter(s => s.pnlR != null);
  const wins    = closed.filter(s => s.pnlR > 0);
  const losses  = closed.filter(s => s.pnlR < 0);
  const totalR  = +closed.reduce((s,x)=>s+x.pnlR,0).toFixed(2);
  const totalGBP= +closed.reduce((s,x)=>s+(x.pnlGBP||0),0).toFixed(2);
  const wr      = closed.length ? Math.round(wins.length/closed.length*100) : 0;
  const pf      = losses.length
    ? +(wins.reduce((s,x)=>s+x.pnlR,0)/Math.abs(losses.reduce((s,x)=>s+x.pnlR,0))).toFixed(2)
    : wins.length ? '∞' : 0;

  const sep = '─'.repeat(70);
  console.log('\n' + color('  ◆ ' + label));
  console.log(chalk.gray('  ' + sep));
  console.log(chalk.gray('  Signals:') + ` ${signals.length}` +
    chalk.gray('  Filled:') + chalk.green(` ${filled.length}`) +
    chalk.gray(` (${signals.length?Math.round(filled.length/signals.length*100):0}%)`) +
    chalk.gray('  Missed:') + ` ${missed.length}`);
  console.log(chalk.gray('  W/L:') + chalk.green(` ${wins.length}W`) + '/' + chalk.red(`${losses.length}L`) +
    chalk.gray('  WR:') + (wr>=50?chalk.green:chalk.yellow)(` ${wr}%`) +
    chalk.gray('  Net R:') + (totalR>=0?chalk.green(` +${totalR}R`):chalk.red(` ${totalR}R`)) +
    chalk.gray('  PF:') + chalk.cyan(` ${pf}`));
  console.log(chalk.gray('  End:') + (balance>=ACCOUNT_START?chalk.green:chalk.red)(` £${balance.toFixed(2)}`) +
    chalk.gray('  Return:') + (balance>=ACCOUNT_START?chalk.green:chalk.red)(` ${fmtPct((balance-ACCOUNT_START)/ACCOUNT_START*100)}`) +
    chalk.gray('  MaxDD:') + chalk.yellow(` ${maxDD.toFixed(1)}%`));

  // Direction split
  for (const d of ['SELL','BUY']) {
    const ds = closed.filter(s=>s.dir===d);
    if (!ds.length) continue;
    const dw=ds.filter(s=>s.pnlR>0).length, dl=ds.filter(s=>s.pnlR<0).length;
    const dr=+ds.reduce((s,x)=>s+x.pnlR,0).toFixed(2);
    const dwr=(dw+dl)?Math.round(dw/(dw+dl)*100):0;
    const sweepBreak = {};
    ds.forEach(s => { sweepBreak[s.sweep]=(sweepBreak[s.sweep]||[]).concat(s); });
    const sweepStr = Object.entries(sweepBreak).map(([k,v])=>{
      const sw=v.filter(s=>s.pnlR>0).length,sl=v.filter(s=>s.pnlR<0).length;
      return `${k}:${sw}W/${sl}L`;
    }).join(' · ');
    console.log(chalk.gray(`  ${d.padEnd(5)}`) + `${ds.length}tr  ` +
      chalk.green(`${dw}W`) + '/' + chalk.red(`${dl}L`) +
      chalk.gray(` ${dwr}%WR `) +
      (dr>=0?chalk.green(`+${dr}R`):chalk.red(`${dr}R`)) +
      chalk.gray(`  [${sweepStr}]`));
  }

  // Quarter breakdown
  const quarters = [
    { label:'Q3\'25 Jun-Aug', start:'2025-06', end:'2025-08' },
    { label:'Q4\'25 Sep-Nov', start:'2025-09', end:'2025-11' },
    { label:'Q1\'26 Dec-Feb', start:'2025-12', end:'2026-02' },
    { label:'Q2\'26 Mar-May', start:'2026-03', end:'2026-05' },
    { label:'Jun\'26',        start:'2026-06', end:'2026-06' },
  ];
  console.log(chalk.gray('  Quarterly:'));
  let cumR = 0;
  quarters.forEach(q => {
    const qs = closed.filter(t => t.time.slice(0,7)>=q.start && t.time.slice(0,7)<=q.end);
    if (!qs.length) { console.log(chalk.gray(`    ${q.label.padEnd(16)} 0 trades`)); return; }
    const qw=qs.filter(s=>s.pnlR>0).length, ql=qs.filter(s=>s.pnlR<0).length;
    const qr=+qs.reduce((s,x)=>s+x.pnlR,0).toFixed(1);
    const qwr=(qw+ql)?Math.round(qw/(qw+ql)*100):0;
    cumR=+(cumR+qr).toFixed(1);
    const qGBP=+qs.reduce((s,x)=>s+(x.pnlGBP||0),0).toFixed(0);
    console.log(chalk.gray(`    ${q.label.padEnd(16)} ${qs.length}tr  `)+
      chalk.green(`${qw}W`)+'/'+chalk.red(`${ql}L`)+
      chalk.gray(`  ${qwr}%  `)+(qr>=0?chalk.green(`+${qr}R`):chalk.red(`${qr}R`))+
      chalk.gray(`  cumul:`)+(cumR>=0?chalk.green(`+${cumR}R`):chalk.red(`${cumR}R`))+
      chalk.gray(`  £${qGBP>=0?'+':'-'}${Math.abs(qGBP)}`));
  });

  // Monthly
  const byMonth = {};
  closed.forEach(s => { const k=s.time.slice(0,7); byMonth[k]=(byMonth[k]||[]).concat(s); });
  console.log(chalk.gray('  Monthly (filled trades per month):'));
  Object.entries(byMonth).sort().forEach(([mo,ms]) => {
    const mW=ms.filter(s=>s.pnlR>0).length, mL=ms.filter(s=>s.pnlR<0).length;
    const mR=+ms.reduce((s,x)=>s+x.pnlR,0).toFixed(1);
    const mWR=(mW+mL)?Math.round(mW/(mW+mL)*100):0;
    const mGBP=+ms.reduce((s,x)=>s+(x.pnlGBP||0),0).toFixed(2);
    console.log(chalk.gray(`    ${mo}  ${ms.length.toString().padStart(2)}tr  `)+
      chalk.green(`${mW}W`)+'/'+chalk.red(`${mL}L`)+
      chalk.gray(`  ${mWR}%  `)+(mR>=0?chalk.green(`+${mR}R`):chalk.red(`${mR}R`))+
      chalk.gray('  ')+(mGBP>=0?chalk.green(fmtGBP(mGBP)):chalk.red(fmtGBP(mGBP))));
  });

  return { label, signals:signals.length, filled:filled.length, missed:missed.length,
    wins:wins.length, losses:losses.length, wr:wr+'%', netR:totalR, pf,
    returnPct:+((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1),
    maxDD:+maxDD.toFixed(1), endBalance:+balance.toFixed(2) };
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
function run() {
  console.log('\n' + chalk.bold.yellow('  ◆ XAUUSD ICT SCALP v2 — WEEKLY BIAS FILTER + HIGHER FREQUENCY'));
  console.log(chalk.gray('  Period: 2025-06-11 → 2026-06-10'));
  console.log(chalk.gray('  Entry: Conservative FVG far-edge | SL: sweep extreme'));
  console.log(chalk.gray('  Sweeps: Asia H/L + PDH/PDL | Cooldown: 15min | Min risk: $'+MIN_RISK));
  console.log(chalk.gray('  Weekly bias: H1 20-SMA slope + price position'));
  console.log(chalk.gray('  Comparing: No bias filter vs With bias filter\n'));

  const all5m = loadChunks('xau1yr_5min');
  const allH1 = loadChunks('xau1yr_1h');
  const START = new Date('2025-06-11T00:00:00Z');
  const END   = new Date('2026-06-10T23:59:59Z');
  const period5m = all5m.filter(c=>{const t=new Date(c.time);return t>=START&&t<=END;});
  console.log(chalk.gray(`  5m bars: ${period5m.length}  |  H1 bars: ${allH1.length}\n`));

  const resNoBias = runScenario(period5m, allH1, 'NO BIAS FILTER — Asia H/L + PDH/PDL sweeps, both directions', false);
  const resBias   = runScenario(period5m, allH1, 'WITH WEEKLY BIAS — trades only in H1 trend direction', true);

  const s1 = printResults(resNoBias, chalk.bold.white);
  const s2 = printResults(resBias,   chalk.bold.cyan);

  // Side-by-side comparison table
  const sep = '═'.repeat(72);
  console.log('\n' + sep);
  console.log(chalk.bold.white('  ══ COMPARISON: NO BIAS vs WITH WEEKLY BIAS ══'));
  console.log(sep);
  console.log(chalk.gray('  Metric              No Bias Filter          With Weekly Bias'));
  console.log(chalk.gray('  ' + '─'.repeat(70)));
  const row = (lbl, a, b) => console.log(chalk.gray(`  ${lbl.padEnd(20)}`)+chalk.white(String(a).padEnd(24))+chalk.cyan(String(b)));
  row('Trades filled',  s1.filled, s2.filled);
  row('Trades/quarter', Math.round(s1.filled/4.3*10)/10 + ' avg', Math.round(s2.filled/4.3*10)/10 + ' avg');
  row('Win Rate',       s1.wr, s2.wr);
  row('Net R',          (s1.netR>=0?'+':'')+s1.netR+'R', (s2.netR>=0?'+':'')+s2.netR+'R');
  row('Return',         s1.returnPct+'%', s2.returnPct+'%');
  row('Max Drawdown',   s1.maxDD+'%', s2.maxDD+'%');
  row('End Balance',    '£'+s1.endBalance, '£'+s2.endBalance);
  console.log(sep + '\n');

  fs.writeFileSync(path.join(__dirname,'..','backtest_report_xau_scalp_v2.json'),
    JSON.stringify({ period:'2025-06-11 → 2026-06-10',
      method:'ICT scalp v2 — weekly bias + frequency boost',
      generatedAt:new Date().toISOString(),
      noBias:s1, withBias:s2 }, null, 2));
  console.log(chalk.gray('  Report → backtest_report_xau_scalp_v2.json\n'));
}

run();
