'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  XAUUSD ICT SCALP — FINAL SELL-ONLY TEST
//  Every test has pointed here: SELL only is the edge on XAU.
//
//  Strategy:
//  - SELL only — no BUY trades whatsoever
//  - Bearish sweep levels: Asia High + PDH + Previous Week High
//  - London window extended: 07:00–11:00 UTC (extra hour for more setups)
//  - Displacement FVG (body >50% range, gap >$1.50)
//  - Conservative entry: FVG bottom (deepest retracement point)
//  - SL: sweep extreme + 0.1% buffer
//  - TP1: 1R, TP2: 2R
//  - Min risk $5, max risk 2.5% of price
//  - News filter active
//  - Cooldown: 15 min between signals
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const ACCOUNT_START  = 1500;
const RISK_PCT       = 0.02;
const SIM_BARS       = 48;
const COOLDOWN_BARS  = 3;
const MIN_WICK       = 1.5;
const MIN_FVG        = 1.50;
const DISPLACE_RATIO = 0.50;
const MIN_RISK       = 5;
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

// ─── Bearish sweep levels ──────────────────────────────────────────────────
function getBearLevels(slice5m, dateStr) {
  const levels = [];

  // 1. Asia High (00:00–07:00 UTC same day)
  const asiaBars = slice5m.filter(c => {
    if (!c.time.startsWith(dateStr)) return false;
    const h = new Date(c.time).getUTCHours();
    return h >= 0 && h < 7;
  });
  if (asiaBars.length >= 4)
    levels.push({ price: Math.max(...asiaBars.map(c=>c.high)), label: 'Asia High' });

  // 2. Previous Day High
  const today = new Date(dateStr + 'T00:00:00Z');
  const yest  = new Date(today - 86400000);
  const pdBars = slice5m.filter(c => { const t=new Date(c.time); return t>=yest && t<today; });
  if (pdBars.length)
    levels.push({ price: Math.max(...pdBars.map(c=>c.high)), label: 'PDH' });

  // 3. Previous Week High (Mon 00:00 to Sun 23:59 of last week)
  const dayOfWeek = today.getUTCDay(); // 0=Sun, 1=Mon...
  const daysToLastMon = dayOfWeek === 0 ? 6 : dayOfWeek + 6;
  const lastMonStart  = new Date(today - daysToLastMon * 86400000);
  const lastSunEnd    = new Date(lastMonStart - 1);
  const prevMonStart  = new Date(lastMonStart - 7 * 86400000);
  const pwBars = slice5m.filter(c => {
    const t = new Date(c.time);
    return t >= prevMonStart && t <= lastSunEnd;
  });
  if (pwBars.length >= 10)
    levels.push({ price: Math.max(...pwBars.map(c=>c.high)), label: 'Prev Week High' });

  // Deduplicate levels that are within 0.1% of each other
  const deduped = [];
  for (const lvl of levels) {
    if (!deduped.find(d => Math.abs(d.price - lvl.price) / lvl.price < 0.001))
      deduped.push(lvl);
  }
  return deduped;
}

// ─── Find bear sweeps in London+extended window ────────────────────────────
function findBearSweeps(londonBars, levels) {
  const sweeps = [];
  const seen   = new Set();

  for (let i = 0; i < londonBars.length; i++) {
    const c = londonBars[i];
    const h = new Date(c.time).getUTCHours();
    if (h < 7 || h >= 11) continue;  // 07:00–11:00 UTC

    for (const lvl of levels) {
      const k = lvl.label;
      if (seen.has(k)) continue;  // only first sweep per level per day

      if (c.high > lvl.price && c.close < lvl.price && (c.high - lvl.price) >= MIN_WICK) {
        sweeps.push({ level: lvl.price, label: lvl.label,
          sweepHigh: c.high, sweepCandle: c, barIdx: i });
        seen.add(k);
      }
    }
  }
  return sweeps;
}

// ─── Bearish displacement FVG post-sweep ──────────────────────────────────
function findBearFVG(bars, fromIdx) {
  const fvgs = [];
  for (let i = Math.max(1, fromIdx); i < bars.length - 1; i++) {
    const c0=bars[i-1], c1=bars[i], c2=bars[i+1];
    const range = c1.high - c1.low;
    if (range < 0.5) continue;
    const body = Math.abs(c1.close - c1.open);
    if (body / range < DISPLACE_RATIO) continue;
    if (c1.close >= c1.open) continue;  // must be bearish displacement candle

    // Standard bearish FVG
    if (c2.high < c0.low) {
      const size = c0.low - c2.high;
      if (size >= MIN_FVG)
        fvgs.push({ type:'bearish', top:c0.low, bottom:c2.high,
          midpoint:(c0.low+c2.high)/2, size, bfs:i-fromIdx });
    }
    // Inversion bearish FVG (bullish gap, price closed below — flipped to supply)
    if (c2.low > c0.high) {
      const last = bars[bars.length-1];
      if (last.close < c0.high) {
        const size = c2.low - c0.high;
        if (size >= MIN_FVG)
          fvgs.push({ type:'inv_bear', top:c2.low, bottom:c0.high,
            midpoint:(c2.low+c0.high)/2, size, bfs:i-fromIdx, inv:true });
      }
    }
  }
  if (!fvgs.length) return null;
  // Prefer inversion, then closest to sweep, then largest
  fvgs.sort((a,b) => (a.inv?0:1)-(b.inv?0:1) || a.bfs-b.bfs || b.size-a.size);
  return fvgs[0];
}

// ─── Simulate ────────────────────────────────────────────────────────────────
function simulate(entry, sl, tp1, tp2, future) {
  const risk = Math.abs(entry - sl);
  const tp1R = +(Math.abs(tp1-entry)/risk).toFixed(2);
  const tp2R = +(Math.abs(tp2-entry)/risk).toFixed(2);
  let hit=false, sl_=sl;
  for (const c of future) {
    const slH = c.high >= sl_;
    const t1  = c.low  <= tp1;
    const t2  = c.low  <= tp2;
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

// ─── MAIN ────────────────────────────────────────────────────────────────────
function run() {
  console.log('\n' + chalk.bold.yellow('  ◆ XAUUSD ICT — FINAL SELL-ONLY SCALP'));
  console.log(chalk.gray('  Period: 2025-06-11 → 2026-06-10'));
  console.log(chalk.gray('  SELL ONLY — no BUY trades'));
  console.log(chalk.gray('  Sweep levels: Asia High + PDH + Prev Week High'));
  console.log(chalk.gray('  London window: 07:00–11:00 UTC'));
  console.log(chalk.gray('  Entry: FVG bottom (conservative) | SL: sweep high + 0.1%'));
  console.log(chalk.gray('  TP1: 1R | TP2: 2R | Min risk: $5 | News filter ON\n'));

  const all5m    = loadChunks('xau1yr_5min');
  const START    = new Date('2025-06-11T00:00:00Z');
  const END      = new Date('2026-06-10T23:59:59Z');
  const period5m = all5m.filter(c=>{const t=new Date(c.time);return t>=START&&t<=END;});
  console.log(chalk.gray(`  5m bars: ${period5m.length}\n`));

  const signals  = [];
  let balance    = ACCOUNT_START, peak = ACCOUNT_START, maxDD = 0;
  let lastBar    = -999;
  // Track which sweep+day combos have already generated a signal (filled or missed)
  const firedKeys = new Set();

  const funnel = { londonBars:0, daysWithSweep:0, sweepsFound:0,
    fvgFound:0, newsBlocked:0, riskFiltered:0, filled:0, missed:0 };

  for (let i = 50; i < period5m.length - SIM_BARS - 5; i++) {
    const bar = period5m[i];
    const h   = new Date(bar.time).getUTCHours();
    if (h < 7 || h >= 11) continue;
    funnel.londonBars++;

    if (i - lastBar < COOLDOWN_BARS) continue;
    if (isNews(bar.time)) { funnel.newsBlocked++; continue; }

    const dateStr  = bar.time.slice(0,10);
    const slice5m  = period5m.slice(Math.max(0, i-400), i+1);

    const levels   = getBearLevels(slice5m, dateStr);
    if (!levels.length) continue;

    const londonBars = slice5m.filter(c => {
      if (!c.time.startsWith(dateStr)) return false;
      const ch = new Date(c.time).getUTCHours();
      return ch >= 7 && ch < 11;
    });
    if (londonBars.length < 3) continue;

    const sweeps = findBearSweeps(londonBars, levels);
    if (!sweeps.length) continue;

    for (const sweep of sweeps) {
      funnel.sweepsFound++;
      const postBars = londonBars.slice(sweep.barIdx);
      if (postBars.length < 3) continue;

      const fvg = findBearFVG(postBars, 0);
      if (!fvg) continue;
      funnel.fvgFound++;

      // Conservative SELL entry: FVG bottom (deepest pullback — best price)
      const entry = fvg.bottom;
      const sl    = sweep.sweepHigh * 1.001;
      const risk  = sl - entry;

      if (risk < MIN_RISK || risk > entry * 0.025) { funnel.riskFiltered++; continue; }

      const tp1 = entry - risk * TP1_R;
      const tp2 = entry - risk * TP2_R;

      // One signal per sweep level per day — deduplicate
      const sigKey = `${dateStr}_${sweep.label}`;
      if (firedKeys.has(sigKey)) continue;
      firedKeys.add(sigKey);

      // Fill check
      const fillW = period5m.slice(i+1, i+25);
      let fillIdx = -1;
      for (let f=0; f<fillW.length; f++) {
        if (fillW[f].high >= entry) { fillIdx=f; break; }
      }

      if (fillIdx === -1) {
        funnel.missed++;
        signals.push({ time:bar.time, dir:'SELL', sweep:sweep.label,
          entry:+entry.toFixed(2), result:'MISSED', pnlR:0, pnlGBP:0,
          balanceAfter:+balance.toFixed(2), fvgType:fvg.type, risk:+risk.toFixed(2) });
        continue;
      }

      funnel.filled++;
      lastBar = i;

      const future  = period5m.slice(i+fillIdx+2, i+fillIdx+2+SIM_BARS);
      const outcome = simulate(entry, sl, tp1, tp2, future);
      const riskGBP = balance * RISK_PCT;
      const pnlGBP  = outcome.pnlR != null ? outcome.pnlR * riskGBP : null;

      if (pnlGBP !== null) {
        balance += pnlGBP;
        if (balance > peak) peak = balance;
        const dd = (peak-balance)/peak*100;
        if (dd > maxDD) maxDD = dd;
      }

      signals.push({ time:bar.time, dir:'SELL', sweep:sweep.label,
        entry:+entry.toFixed(2), sl:+sl.toFixed(2), tp1:+tp1.toFixed(2), tp2:+tp2.toFixed(2),
        risk:+risk.toFixed(2), fvgType:fvg.type, fvgSize:+fvg.size.toFixed(2),
        fillBarsAfter:fillIdx+1,
        riskGBP:+riskGBP.toFixed(2),
        pnlGBP: pnlGBP!=null ? +pnlGBP.toFixed(2) : null,
        balanceAfter:+balance.toFixed(2),
        ...outcome });
    }
  }

  // ─── Results ────────────────────────────────────────────────────────────
  const sep    = '═'.repeat(72);
  const filled = signals.filter(s => s.result !== 'MISSED');
  const missed = signals.filter(s => s.result === 'MISSED');
  const closed = filled.filter(s => s.pnlR != null);
  const wins   = closed.filter(s => s.pnlR > 0);
  const losses = closed.filter(s => s.pnlR < 0);
  const totalR = +closed.reduce((s,x)=>s+x.pnlR,0).toFixed(2);
  const wr     = closed.length ? Math.round(wins.length/closed.length*100) : 0;
  const pf     = losses.length
    ? +(wins.reduce((s,x)=>s+x.pnlR,0)/Math.abs(losses.reduce((s,x)=>s+x.pnlR,0))).toFixed(2)
    : wins.length ? '∞' : 0;

  console.log(sep);
  console.log(chalk.bold.yellow('  ══ DETECTION FUNNEL ══'));
  console.log(sep);
  console.log(chalk.gray('  London bars (07-11 UTC): ') + funnel.londonBars.toLocaleString());
  console.log(chalk.cyan('  → Sweeps detected:       ') + funnel.sweepsFound +
    chalk.gray(` across all 3 levels`));
  console.log(chalk.cyan('  → Had FVG after sweep:   ') + funnel.fvgFound +
    chalk.gray(` (${funnel.sweepsFound?(funnel.fvgFound/funnel.sweepsFound*100).toFixed(0):0}%)`));
  console.log(chalk.cyan('  → Risk filtered out:     ') + funnel.riskFiltered);
  console.log(chalk.cyan('  → News blocked:          ') + funnel.newsBlocked);
  console.log(chalk.green('  → Limit fills:           ') + funnel.filled +
    chalk.gray(` (${(funnel.fvgFound-funnel.riskFiltered)?(funnel.filled/(funnel.fvgFound-funnel.riskFiltered)*100).toFixed(0):0}% fill rate)`));
  console.log(chalk.yellow('  → Limits missed:         ') + funnel.missed);

  console.log('\n' + sep);
  console.log(chalk.bold.yellow('  ══ FULL YEAR RESULTS — SELL ONLY ══'));
  console.log(sep);
  console.log(chalk.gray('  Total signals:  ') + signals.length +
    chalk.gray('  Filled: ') + chalk.green(filled.length) +
    chalk.gray('  Missed: ') + missed.length);
  console.log(chalk.gray('  Wins:           ') + chalk.green(wins.length) +
    chalk.gray('  Losses: ') + chalk.red(losses.length) +
    chalk.gray('  Win rate: ') + (wr>=50?chalk.green:chalk.yellow)(wr+'%'));
  console.log(chalk.gray('  Net R:          ') + (totalR>=0?chalk.green(`+${totalR}R`):chalk.red(`${totalR}R`)) +
    chalk.gray('  Profit factor: ') + chalk.cyan(pf));
  console.log(chalk.gray('  Start: £1,500   End: ') +
    (balance>=ACCOUNT_START?chalk.green:chalk.red)('£'+balance.toFixed(2)) +
    chalk.gray('  Return: ') + (balance>=ACCOUNT_START?chalk.green:chalk.red)(fmtPct((balance-ACCOUNT_START)/ACCOUNT_START*100)) +
    chalk.gray('  MaxDD: ') + chalk.yellow(maxDD.toFixed(1)+'%'));

  // Sweep level breakdown
  const bySweep = {};
  closed.forEach(s => { bySweep[s.sweep]=(bySweep[s.sweep]||[]).concat(s); });
  console.log(chalk.gray('\n  By sweep level:'));
  Object.entries(bySweep).sort().forEach(([k,ss]) => {
    const w=ss.filter(s=>s.pnlR>0).length, l=ss.filter(s=>s.pnlR<0).length;
    const r=+ss.reduce((s,x)=>s+x.pnlR,0).toFixed(2);
    const wr2=(w+l)?Math.round(w/(w+l)*100):0;
    console.log(chalk.gray(`    ${k.padEnd(16)} ${ss.length}tr  `)+
      chalk.green(`${w}W`)+'/'+chalk.red(`${l}L`)+
      chalk.gray(`  ${wr2}%WR  `)+(r>=0?chalk.green(`+${r}R`):chalk.red(`${r}R`)));
  });

  // FVG type breakdown
  const byFVG = {};
  closed.forEach(s => { byFVG[s.fvgType]=(byFVG[s.fvgType]||[]).concat(s); });
  console.log(chalk.gray('\n  By FVG type:'));
  Object.entries(byFVG).sort().forEach(([k,ss]) => {
    const w=ss.filter(s=>s.pnlR>0).length, l=ss.filter(s=>s.pnlR<0).length;
    const r=+ss.reduce((s,x)=>s+x.pnlR,0).toFixed(2);
    const wr2=(w+l)?Math.round(w/(w+l)*100):0;
    console.log(chalk.gray(`    ${k.padEnd(16)} ${ss.length}tr  `)+
      chalk.green(`${w}W`)+'/'+chalk.red(`${l}L`)+
      chalk.gray(`  ${wr2}%WR  `)+(r>=0?chalk.green(`+${r}R`):chalk.red(`${r}R`)));
  });

  // Quarter breakdown
  const quarters = [
    { label:"Q3'25 Jun-Aug", s:'2025-06', e:'2025-08' },
    { label:"Q4'25 Sep-Nov", s:'2025-09', e:'2025-11' },
    { label:"Q1'26 Dec-Feb", s:'2025-12', e:'2026-02' },
    { label:"Q2'26 Mar-May", s:'2026-03', e:'2026-05' },
    { label:"Jun'26",        s:'2026-06', e:'2026-06' },
  ];
  console.log(chalk.gray('\n  Quarterly results:'));
  let cumR = 0;
  quarters.forEach(q => {
    const qs = closed.filter(t=>t.time.slice(0,7)>=q.s && t.time.slice(0,7)<=q.e);
    const qw=qs.filter(s=>s.pnlR>0).length, ql=qs.filter(s=>s.pnlR<0).length;
    const qr=+qs.reduce((s,x)=>s+x.pnlR,0).toFixed(1);
    const qwr=(qw+ql)?Math.round(qw/(qw+ql)*100):0;
    cumR=+(cumR+qr).toFixed(1);
    const qGBP=+qs.reduce((s,x)=>s+(x.pnlGBP||0),0).toFixed(0);
    const tradeLine = qs.length === 0
      ? chalk.gray('  0 trades')
      : `  ${qs.length}tr  ` + chalk.green(`${qw}W`) + '/' + chalk.red(`${ql}L`) +
        chalk.gray(`  ${qwr}%  `) + (qr>=0?chalk.green(`+${qr}R`):chalk.red(`${qr}R`)) +
        chalk.gray('  cumul:') + (cumR>=0?chalk.green(`+${cumR}R`):chalk.red(`${cumR}R`)) +
        chalk.gray(`  £${qGBP>=0?'+':''}${qGBP}`);
    console.log(chalk.gray(`    ${q.label.padEnd(16)}`) + tradeLine);
  });

  // Monthly
  const byMonth = {};
  closed.forEach(s => { const k=s.time.slice(0,7); byMonth[k]=(byMonth[k]||[]).concat(s); });
  console.log(chalk.gray('\n  Month by month:'));
  Object.entries(byMonth).sort().forEach(([mo,ms]) => {
    const mW=ms.filter(s=>s.pnlR>0).length, mL=ms.filter(s=>s.pnlR<0).length;
    const mR=+ms.reduce((s,x)=>s+x.pnlR,0).toFixed(1);
    const mWR=(mW+mL)?Math.round(mW/(mW+mL)*100):0;
    const mGBP=+ms.reduce((s,x)=>s+(x.pnlGBP||0),0).toFixed(2);
    console.log(chalk.gray(`    ${mo}  ${ms.length.toString().padStart(2)}tr  `) +
      chalk.green(`${mW}W`) + '/' + chalk.red(`${mL}L`) +
      chalk.gray(`  ${mWR}%  `) +
      (mR>=0?chalk.green(`+${mR}R`):chalk.red(`${mR}R`)) +
      chalk.gray('  ') + (mGBP>=0?chalk.green(fmtGBP(mGBP)):chalk.red(fmtGBP(mGBP))));
  });

  // Full trade log
  console.log(chalk.gray('\n  Trade log:'));
  filled.forEach(s => {
    const c = s.pnlR > 0 ? chalk.green : s.pnlR < 0 ? chalk.red : chalk.gray;
    console.log(c(`    ${s.time.slice(0,16)}  entry:${s.entry}  sl:${s.sl}  risk:$${s.risk}  ${s.sweep.padEnd(16)} ${s.fvgType.padEnd(10)}  ${s.result.padEnd(10)}  ${s.pnlR!=null?(s.pnlR>=0?'+':'')+s.pnlR+'R':'OPEN'}`));
  });

  console.log('\n' + sep + '\n');

  fs.writeFileSync(path.join(__dirname,'..','backtest_report_xau_sell_final.json'),
    JSON.stringify({ period:'2025-06-11 → 2026-06-10',
      method:'ICT sell-only — Asia High + PDH + PWH sweeps, London 07-11 UTC',
      generatedAt:new Date().toISOString(), funnel,
      stats:{ total:signals.length, filled:filled.length, missed:missed.length,
        wins:wins.length, losses:losses.length, winRate:wr+'%', netR:totalR, pf },
      account:{ start:ACCOUNT_START, end:+balance.toFixed(2),
        returnPct:+((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1),
        maxDD:+maxDD.toFixed(1) },
      signals }, null, 2));
  console.log(chalk.gray('  Report → backtest_report_xau_sell_final.json\n'));
}

run();
