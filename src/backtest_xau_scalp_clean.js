'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  XAUUSD ICT SCALPING — CLEAN SLATE v1
//
//  True ICT scalp sequence (no inherited swing assumptions):
//    1. Asia session (00:00-07:00 UTC) builds a range
//    2. London open (07:00-10:00 UTC) sweeps Asia High OR Low (Judas Swing)
//    3. A displacement candle (strong body > 55% of range) creates an FVG
//    4. Enter at FVG — three entry modes compared:
//         AGGRESSIVE: FVG near edge (more fills, worse price)
//         MIDPOINT:   FVG midpoint  (moderate)
//         CONSERVATIVE: FVG far edge (fewer fills, best price)
//    5. SL: sweep extreme + 0.1% buffer
//    6. TP1: 1R, TP2: 2R (scalp — quick exits)
//    7. News filter: skip 60min window around NFP/FOMC/CPI
//
//  NO BOS required, NO M15 bias filter, NO CHoCH — pure sweep+FVG scalp
//  Tests BOTH directions and compares SELL vs BUY
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const ACCOUNT_START  = 1500;
const RISK_PCT       = 0.02;
const SIM_BARS       = 48;    // 4h max hold — true scalp
const COOLDOWN_BARS  = 6;     // 30min cooldown — scalp frequency
const MIN_WICK       = 1.5;   // $1.50 min sweep extension
const MIN_FVG        = 1.00;  // $1.00 min FVG size
const DISPLACE_RATIO = 0.55;  // body > 55% of candle range = displacement
const TP1_R          = 1.0;
const TP2_R          = 2.0;

const CACHE = path.join(__dirname, '..', '.cache');
function fmtPct(n) { return (n>=0?'+':'') + n.toFixed(1) + '%'; }
function fmtGBP(n) { return (n>=0?'+':'') + '£' + Math.abs(n).toFixed(2); }

// ─── High-impact news dates ─────────────────────────────────────────────────
const NEWS_DATES = new Set([
  '2025-07-04','2025-08-01','2025-09-05','2025-10-03','2025-11-07',
  '2025-12-05','2026-01-09','2026-02-06','2026-03-06','2026-04-03',
  '2026-05-01','2026-06-05',   // NFP
  '2025-07-30','2025-09-17','2025-11-05','2025-12-17',
  '2026-01-28','2026-03-18','2026-05-06','2026-06-17',  // FOMC
  '2025-07-11','2025-08-13','2025-09-11','2025-10-15','2025-11-13',
  '2025-12-11','2026-01-15','2026-02-12','2026-03-12',
  '2026-04-10','2026-05-13','2026-06-11',  // CPI
]);

function isHighImpactWindow(isoTime) {
  const date = isoTime.slice(0,10);
  if (!NEWS_DATES.has(date)) return false;
  const h = new Date(isoTime).getUTCHours();
  return h >= 12 && h <= 15;  // 12:00-15:00 UTC covers most US data
}

// ─── Data loading ─────────────────────────────────────────────────────────
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
  return all
    .filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
    .sort((a,b) => a.time.localeCompare(b.time));
}

// ─── Asia session range ──────────────────────────────────────────────────────
function getAsiaRange(bars, dateStr) {
  const sess = bars.filter(c => {
    if (!c.time.startsWith(dateStr)) return false;
    const h = new Date(c.time).getUTCHours();
    return h >= 0 && h < 7;
  });
  if (sess.length < 4) return null;
  return {
    high: Math.max(...sess.map(c => c.high)),
    low:  Math.min(...sess.map(c => c.low)),
    bars: sess.length
  };
}

// ─── Sweep detection ────────────────────────────────────────────────────────
// Returns ALL sweeps within the London window, not just the most recent
function findSweepsInWindow(bars, asia) {
  const sweeps = [];
  for (let i = 0; i < bars.length; i++) {
    const c   = bars[i];
    const kzH = new Date(c.time).getUTCHours();
    if (kzH < 7 || kzH >= 10) continue;

    // Bear sweep: wick above Asia High, close back inside
    if (c.high > asia.high && c.close < asia.high && (c.high - asia.high) >= MIN_WICK) {
      sweeps.push({ dir:'bear', level:asia.high, label:'Asia High',
        sweepExtreme: c.high, sweepCandle:c, barIdx:i });
    }
    // Bull sweep: wick below Asia Low, close back inside
    if (c.low < asia.low && c.close > asia.low && (asia.low - c.low) >= MIN_WICK) {
      sweeps.push({ dir:'bull', level:asia.low, label:'Asia Low',
        sweepExtreme: c.low, sweepCandle:c, barIdx:i });
    }
  }
  // Return earliest unambiguous sweep per direction
  const bearSweep = sweeps.find(s => s.dir === 'bear');
  const bullSweep = sweeps.find(s => s.dir === 'bull');
  return { bearSweep, bullSweep };
}

// ─── FVG with displacement (post-sweep only) ────────────────────────────────
function findDisplacementFVG(bars, sweepDir, sweepBarIdx) {
  const fvgs = [];
  // Start from the sweep candle itself — displacement could be the sweep candle
  for (let i = Math.max(1, sweepBarIdx); i < bars.length - 1; i++) {
    const c0 = bars[i-1], c1 = bars[i], c2 = i+1 < bars.length ? bars[i+1] : null;
    if (!c2) continue;

    const range = c1.high - c1.low;
    if (range < 0.5) continue;
    const body = Math.abs(c1.close - c1.open);

    if (sweepDir === 'bear') {
      // Bearish FVG: c2.high < c0.low
      if (c2.high < c0.low && body/range >= DISPLACE_RATIO && c1.close < c1.open) {
        const size = c0.low - c2.high;
        if (size >= MIN_FVG) {
          fvgs.push({ type:'bearish', top:c0.low, bottom:c2.high, size,
            midpoint:(c0.low+c2.high)/2, candleIdx:i, barsFromSweep:i-sweepBarIdx,
            dispBody:+body.toFixed(2), dispRange:+range.toFixed(2) });
        }
      }
      // Inversion FVG (bullish gap that price has closed below — now bearish supply)
      if (c2.low > c0.high && body/range >= DISPLACE_RATIO && c1.close < c1.open) {
        const last = bars[bars.length-1];
        if (last.close < c0.high) {
          const size = c2.low - c0.high;
          if (size >= MIN_FVG) {
            fvgs.push({ type:'inversion_bear', top:c2.low, bottom:c0.high, size,
              midpoint:(c2.low+c0.high)/2, candleIdx:i, barsFromSweep:i-sweepBarIdx,
              dispBody:+body.toFixed(2), dispRange:+range.toFixed(2) });
          }
        }
      }
    }

    if (sweepDir === 'bull') {
      // Bullish FVG: c2.low > c0.high
      if (c2.low > c0.high && body/range >= DISPLACE_RATIO && c1.close > c1.open) {
        const size = c2.low - c0.high;
        if (size >= MIN_FVG) {
          fvgs.push({ type:'bullish', top:c2.low, bottom:c0.high, size,
            midpoint:(c2.low+c0.high)/2, candleIdx:i, barsFromSweep:i-sweepBarIdx,
            dispBody:+body.toFixed(2), dispRange:+range.toFixed(2) });
        }
      }
      // Inversion FVG (bearish gap, price closed above)
      if (c2.high < c0.low && body/range >= DISPLACE_RATIO && c1.close > c1.open) {
        const last = bars[bars.length-1];
        if (last.close > c0.low) {
          const size = c0.low - c2.high;
          if (size >= MIN_FVG) {
            fvgs.push({ type:'inversion_bull', top:c0.low, bottom:c2.high, size,
              midpoint:(c0.low+c2.high)/2, candleIdx:i, barsFromSweep:i-sweepBarIdx,
              dispBody:+body.toFixed(2), dispRange:+range.toFixed(2) });
          }
        }
      }
    }
  }

  if (!fvgs.length) return null;
  // Prefer inversion FVGs, then most recent, then largest
  fvgs.sort((a,b) => {
    const pa = a.type.includes('inversion') ? 0 : 1;
    const pb = b.type.includes('inversion') ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return a.barsFromSweep - b.barsFromSweep;
  });
  return fvgs[0];
}

// ─── Simulate outcome ────────────────────────────────────────────────────────
function simulate(dir, entry, sl, tp1, tp2, future) {
  const r = Math.abs(entry - sl);
  const tp1R = +(Math.abs(tp1 - entry) / r).toFixed(2);
  const tp2R = +(Math.abs(tp2 - entry) / r).toFixed(2);
  let tp1Hit = false, sl_ = sl;
  for (const c of future) {
    const slHit = dir==='bull' ? c.low<=sl_  : c.high>=sl_;
    const t1    = dir==='bull' ? c.high>=tp1 : c.low<=tp1;
    const t2    = dir==='bull' ? c.high>=tp2 : c.low<=tp2;
    if (!tp1Hit) {
      if (slHit) return { result:'LOSS',       pnlR:-1,              tp1R, tp2R };
      if (t2)    return { result:'WIN_TP2',    pnlR:+(0.5*tp1R+0.5*tp2R).toFixed(2), tp1R, tp2R };
      if (t1)    { tp1Hit=true; sl_=entry; }
    } else {
      if (slHit) return { result:'WIN_TP1_BE', pnlR:+(0.5*tp1R).toFixed(2),           tp1R, tp2R };
      if (t2)    return { result:'WIN_TP2',    pnlR:+(0.5*tp1R+0.5*tp2R).toFixed(2), tp1R, tp2R };
    }
  }
  if (tp1Hit) return { result:'WIN_TP1_OPEN', pnlR:+(0.5*tp1R).toFixed(2), tp1R, tp2R };
  return { result:'OPEN', pnlR:null, tp1R, tp2R };
}

// ─── Run one entry-mode scenario ─────────────────────────────────────────────
function runMode(period5m, label, entryFn) {
  const signals = [];
  let balance = ACCOUNT_START, peak = ACCOUNT_START, maxDD = 0;
  let lastSignalBar = -999;

  // Track processed days to avoid re-detecting the same sweep
  const processedDays = new Set();

  for (let i = 50; i < period5m.length - SIM_BARS - 5; i++) {
    const bar  = period5m[i];
    const h    = new Date(bar.time).getUTCHours();
    if (h < 7 || h >= 10) continue;
    if (i - lastSignalBar < COOLDOWN_BARS) continue;
    if (isHighImpactWindow(bar.time)) continue;

    const dateStr = bar.time.slice(0, 10);
    // Build windows
    const slice5m = period5m.slice(Math.max(0, i - 250), i + 1);

    // Get Asia range for this day
    const asia = getAsiaRange(slice5m, dateStr);
    if (!asia) continue;

    // Get London bars so far today
    const londonBars = slice5m.filter(c => {
      if (!c.time.startsWith(dateStr)) return false;
      const ch = new Date(c.time).getUTCHours();
      return ch >= 7 && ch < 10;
    });
    if (londonBars.length < 2) continue;

    // Find sweeps
    const { bearSweep, bullSweep } = findSweepsInWindow(londonBars, asia);

    for (const sweep of [bearSweep, bullSweep].filter(Boolean)) {
      // Deduplicate: one signal per sweep per day per direction
      const sweepKey = `${dateStr}_${sweep.dir}`;
      if (processedDays.has(sweepKey)) continue;

      // London bars AFTER the sweep candle
      const postSweepBars = londonBars.slice(sweep.barIdx);
      if (postSweepBars.length < 3) continue;

      // Find displacement FVG
      const fvg = findDisplacementFVG(postSweepBars, sweep.dir, 0);
      if (!fvg) continue;

      // Compute entry price based on mode
      const entry = entryFn(fvg, sweep.dir);
      const isLong = sweep.dir === 'bull';

      // SL: sweep extreme + 0.1% buffer
      const sl = isLong
        ? sweep.sweepExtreme * (1 - 0.001)
        : sweep.sweepExtreme * (1 + 0.001);

      const risk = Math.abs(entry - sl);
      if (risk <= 0 || risk > entry * 0.025) continue;  // skip if risk > 2.5%

      const tp1 = isLong ? entry + risk * TP1_R : entry - risk * TP1_R;
      const tp2 = isLong ? entry + risk * TP2_R : entry - risk * TP2_R;

      // Check fill: scan forward from current bar
      const fillWindow = period5m.slice(i + 1, i + 25);
      let fillIdx = -1;
      for (let f = 0; f < fillWindow.length; f++) {
        const c = fillWindow[f];
        if (isLong  && c.low  <= entry) { fillIdx = f; break; }
        if (!isLong && c.high >= entry) { fillIdx = f; break; }
      }

      if (fillIdx === -1) {
        signals.push({ time:bar.time, dir:isLong?'BUY':'SELL', sweep:sweep.label,
          entry:+entry.toFixed(2), result:'MISSED', pnlR:0, pnlGBP:0,
          balanceAfter:+balance.toFixed(2), fvgType:fvg.type, fvgSize:+fvg.size.toFixed(2),
          risk:+risk.toFixed(2) });
        continue;
      }

      processedDays.add(sweepKey);
      lastSignalBar = i;

      const future  = period5m.slice(i + fillIdx + 2, i + fillIdx + 2 + SIM_BARS);
      const outcome = simulate(sweep.dir, entry, sl, tp1, tp2, future);
      const riskGBP = balance * RISK_PCT;
      const pnlGBP  = outcome.pnlR != null ? outcome.pnlR * riskGBP : null;

      if (pnlGBP !== null) {
        balance += pnlGBP;
        if (balance > peak) peak = balance;
        const dd = (peak - balance) / peak * 100;
        if (dd > maxDD) maxDD = dd;
      }

      signals.push({ time:bar.time, dir:isLong?'BUY':'SELL', sweep:sweep.label,
        entry:+entry.toFixed(2), sl:+sl.toFixed(2), tp1:+tp1.toFixed(2), tp2:+tp2.toFixed(2),
        risk:+risk.toFixed(2), fvgType:fvg.type, fvgSize:+fvg.size.toFixed(2),
        fvgTop:+fvg.top.toFixed(2), fvgBottom:+fvg.bottom.toFixed(2),
        barsFromSweep:fvg.barsFromSweep, fillBarsAfter:fillIdx+1,
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
  const filled = signals.filter(s => s.result !== 'MISSED');
  const missed = signals.filter(s => s.result === 'MISSED');
  const closed = filled.filter(s => s.pnlR != null);
  const wins   = closed.filter(s => s.pnlR > 0);
  const losses = closed.filter(s => s.pnlR < 0);
  const totalR = +closed.reduce((s,x)=>s+x.pnlR,0).toFixed(2);
  const totalGBP = +closed.reduce((s,x)=>s+(x.pnlGBP||0),0).toFixed(2);
  const wr = closed.length ? Math.round(wins.length/closed.length*100) : 0;
  const pf = losses.length
    ? +(wins.reduce((s,x)=>s+x.pnlR,0)/Math.abs(losses.reduce((s,x)=>s+x.pnlR,0))).toFixed(2)
    : wins.length ? '∞' : 0;

  console.log('\n' + color('  ◆ ' + label));
  console.log(chalk.gray('  ' + '─'.repeat(68)));
  console.log(chalk.gray('  Signals:  ') + signals.length +
    chalk.gray('  Filled: ') + chalk.green(filled.length) +
    chalk.gray(` (${signals.length?Math.round(filled.length/signals.length*100):0}%)`) +
    chalk.gray('  Missed: ') + missed.length);
  console.log(chalk.gray('  Wins: ') + chalk.green(wins.length) +
    chalk.gray('  Losses: ') + chalk.red(losses.length) +
    chalk.gray('  WR: ') + (wr>=50?chalk.green:chalk.yellow)(wr+'%') +
    chalk.gray('  Net R: ') + (totalR>=0?chalk.green(`+${totalR}R`):chalk.red(`${totalR}R`)) +
    chalk.gray('  PF: ') + chalk.cyan(pf));
  console.log(chalk.gray('  End: ') + (balance>=ACCOUNT_START?chalk.green:chalk.red)('£'+balance.toFixed(2)) +
    chalk.gray('  Return: ') + (balance>=ACCOUNT_START?chalk.green:chalk.red)(fmtPct((balance-ACCOUNT_START)/ACCOUNT_START*100)) +
    chalk.gray('  MaxDD: ') + chalk.yellow(maxDD.toFixed(1)+'%'));

  // SELL vs BUY
  for (const d of ['SELL','BUY']) {
    const ds = closed.filter(s=>s.dir===d);
    if (!ds.length) continue;
    const dw=ds.filter(s=>s.pnlR>0).length, dl=ds.filter(s=>s.pnlR<0).length;
    const dr=+ds.reduce((s,x)=>s+x.pnlR,0).toFixed(2);
    const dwr=(dw+dl)?Math.round(dw/(dw+dl)*100):0;
    console.log(chalk.gray(`  ${d.padEnd(5)}`) + `${ds.length} trades  ` +
      chalk.green(`${dw}W`) + '/' + chalk.red(`${dl}L`) +
      chalk.gray(`  ${dwr}% WR  `) +
      (dr>=0?chalk.green(`+${dr}R`):chalk.red(`${dr}R`)));
  }

  // Month breakdown
  const byMonth = {};
  closed.forEach(s => {
    const k = s.time.slice(0,7);
    byMonth[k] = (byMonth[k]||[]).concat(s);
  });
  if (Object.keys(byMonth).length) {
    console.log(chalk.gray('  Monthly:'));
    Object.entries(byMonth).sort().forEach(([mo, ms]) => {
      const mW=ms.filter(s=>s.pnlR>0).length, mL=ms.filter(s=>s.pnlR<0).length;
      const mR=+ms.reduce((s,x)=>s+x.pnlR,0).toFixed(1);
      const mWR=(mW+mL)?Math.round(mW/(mW+mL)*100):0;
      const mGBP=+ms.reduce((s,x)=>s+(x.pnlGBP||0),0).toFixed(2);
      console.log(chalk.gray(`    ${mo}  ${ms.length}tr  `)+chalk.green(`${mW}W`)+'/'+chalk.red(`${mL}L`)+
        chalk.gray(`  ${mWR}%  `)+(mR>=0?chalk.green(`+${mR}R`):chalk.red(`${mR}R`))+
        chalk.gray('  ')+(mGBP>=0?chalk.green(fmtGBP(mGBP)):chalk.red(fmtGBP(mGBP))));
    });
  }

  return { label, signals:signals.length, filled:filled.length, missed:missed.length,
    wins:wins.length, losses:losses.length, wr:wr+'%', netR:totalR, pf,
    returnPct:+((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1),
    maxDD:+maxDD.toFixed(1), endBalance:+balance.toFixed(2) };
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
function run() {
  console.log('\n' + chalk.bold.yellow('  ◆ XAUUSD ICT SCALP — CLEAN SLATE'));
  console.log(chalk.gray('  Period: 2025-06-11 → 2026-06-10  |  No swing assumptions'));
  console.log(chalk.gray('  Pure: Asia range → London sweep → displacement FVG → enter'));
  console.log(chalk.gray('  SL: sweep extreme | TP1: 1R | TP2: 2R | Max hold: 4h'));
  console.log(chalk.gray('  Entry modes: Aggressive (FVG near-edge), Midpoint, Conservative (far-edge)\n'));

  const all5m    = loadChunks('xau1yr_5min');
  const START    = new Date('2025-06-11T00:00:00Z');
  const END      = new Date('2026-06-10T23:59:59Z');
  const period5m = all5m.filter(c => { const t=new Date(c.time); return t>=START&&t<=END; });
  console.log(chalk.gray(`  5m bars loaded: ${period5m.length}\n`));

  // Three entry modes
  const modes = [
    {
      label: 'AGGRESSIVE — FVG near-edge (SELL: FVG top, BUY: FVG bottom)',
      fn: (fvg, dir) => dir === 'bear' ? fvg.top : fvg.bottom
    },
    {
      label: 'MIDPOINT   — FVG midpoint',
      fn: (fvg, _dir) => fvg.midpoint
    },
    {
      label: 'CONSERVATIVE — FVG far-edge (SELL: FVG bottom, BUY: FVG top)',
      fn: (fvg, dir) => dir === 'bear' ? fvg.bottom : fvg.top
    },
  ];

  const summaries = [];
  const colors = [chalk.bold.cyan, chalk.bold.white, chalk.bold.yellow];

  for (let i = 0; i < modes.length; i++) {
    const res = runMode(period5m, modes[i].label, modes[i].fn);
    summaries.push(printResults(res, colors[i]));
  }

  // Comparison table
  const sep = '═'.repeat(72);
  console.log('\n' + sep);
  console.log(chalk.bold.white('  ══ ENTRY MODE COMPARISON ══'));
  console.log(sep);
  console.log(chalk.gray('  Mode              Filled  WR      Net R    Return   MaxDD'));
  console.log(chalk.gray('  ' + '─'.repeat(70)));
  summaries.forEach((s, i) => {
    const netRStr = (s.netR>=0?'+':'')+s.netR+'R';
    const retStr  = (s.returnPct>=0?'+':'')+s.returnPct+'%';
    console.log(colors[i](
      `  ${s.label.slice(0,18).padEnd(18)}  ${String(s.filled).padStart(5)}  ${s.wr.padStart(6)}  ` +
      `${netRStr.padStart(8)}  ${retStr.padStart(7)}  ${s.maxDD}%`
    ));
  });
  console.log(sep);

  // Best
  const best = summaries.reduce((a,b) => b.netR > a.netR ? b : a);
  console.log(chalk.bold.white('\n  BEST: ') + chalk.yellow(best.label));
  console.log(chalk.gray('  WR: ') + chalk.bold(best.wr) +
    chalk.gray('  Net R: ') + chalk.bold((best.netR>=0?'+':'')+best.netR+'R') +
    chalk.gray('  Return: ') + chalk.bold((best.returnPct>=0?'+':'')+best.returnPct+'%') + '\n');

  fs.writeFileSync(path.join(__dirname,'..','backtest_report_xau_scalp_clean.json'),
    JSON.stringify({ period:'2025-06-11 → 2026-06-10',
      method:'ICT scalp clean slate — Asia sweep + displacement FVG',
      generatedAt:new Date().toISOString(), summaries }, null, 2));
  console.log(chalk.gray('  Report → backtest_report_xau_scalp_clean.json\n'));
}

run();
