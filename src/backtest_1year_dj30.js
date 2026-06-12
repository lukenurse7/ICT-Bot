'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  DJ30 ICT — 1 YEAR BACKTEST  (Jun 2025 → Jun 2026)
//  £2,000 start | 2% risk per trade | fully compounded
//  Same ICT engine as the 3-month backtest (79% WR)
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const ACCOUNT_START = 2000;
const RISK_PCT      = 0.02;   // 2%
const TP1_R         = 1.5;
const SIM_BARS      = 288;    // 24h of 5m bars
const MIN_SCORE     = 80;
const COOLDOWN      = 36;     // 3h in 5m bars

const CACHE = path.join(__dirname, '..', '.cache');
const SYMBOL = 'DIA';

function fmt(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}
function fmtDT(iso) {
  const d = new Date(iso);
  return `${fmt(d)} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} UTC`;
}
function fmtGBP(n) { return (n >= 0 ? '+' : '') + '£' + Math.abs(n).toFixed(2); }

// ─── Load cached chunks ───────────────────────────────────────────────────────
function loadCached(interval, startYear, startMonth, endYear, endMonth) {
  const all = [];
  let y = startYear, m = startMonth;
  while (y < endYear || (y === endYear && m <= endMonth)) {
    const s  = `${y}-${String(m).padStart(2,'0')}-01`;
    const nm = m + 1 > 12 ? 1 : m + 1;
    const ny = m + 1 > 12 ? y + 1 : y;
    const e  = `${ny}-${String(nm).padStart(2,'0')}-01`;
    const f  = path.join(CACHE, `dj30_${interval}_${s}_${e}.json`);
    if (fs.existsSync(f)) {
      all.push(...JSON.parse(fs.readFileSync(f)));
    }
    m++; if (m > 12) { m = 1; y++; }
  }
  const seen = new Set();
  return all
    .filter(c => { if (seen.has(c.time)) return false; seen.add(c.time); return true; })
    .sort((a, b) => new Date(a.time) - new Date(b.time));
}

function rollup(src, factor) {
  const out = [];
  for (let i = 0; i < src.length; i += factor) {
    const s = src.slice(i, i + factor);
    if (!s.length) continue;
    out.push({ time: s[0].time, open: s[0].open,
      high: Math.max(...s.map(c => c.high)),
      low:  Math.min(...s.map(c => c.low)),
      close: s[s.length-1].close,
      volume: s.reduce((a, c) => a + (c.volume||0), 0) });
  }
  return out;
}

// ─── ICT engine (identical to 3-month backtest) ───────────────────────────────

function detectSweep(candles15m, candles5m) {
  const LOOKBACK = 50;
  const recent15 = candles15m.slice(-LOOKBACK);
  const last5    = candles5m[candles5m.length - 1];
  const levels   = [];

  for (let i = 2; i < recent15.length - 1; i++) {
    const c = recent15[i];
    const prev = recent15.slice(Math.max(0, i-10), i);
    const eqH = prev.find(p => Math.abs(p.high - c.high) / c.high < 0.0005);
    if (eqH) levels.push({ price: Math.max(c.high, eqH.high), type: 'BSL', name: 'Equal Highs (BSL)' });
    const eqL = prev.find(p => Math.abs(p.low - c.low) / c.low < 0.0005);
    if (eqL) levels.push({ price: Math.min(c.low, eqL.low), type: 'SSL', name: 'Equal Lows (SSL)' });
  }

  const yesterday = candles15m.slice(-100).filter(c => {
    const h = new Date(c.time).getUTCHours(); return h >= 21 || h < 2;
  });
  if (yesterday.length) {
    levels.push({ price: Math.max(...yesterday.map(c => c.high)), type: 'BSL', name: 'Prev Day High' });
    levels.push({ price: Math.min(...yesterday.map(c => c.low)),  type: 'SSL', name: 'Prev Day Low' });
  }

  const results = [];
  for (const lvl of levels) {
    if (lvl.type === 'BSL' && last5.high > lvl.price && last5.close < lvl.price)
      results.push({ dir: 'bear', level: lvl.price, levelName: lvl.name, barsAgo: 0 });
    if (lvl.type === 'SSL' && last5.low < lvl.price && last5.close > lvl.price)
      results.push({ dir: 'bull', level: lvl.price, levelName: lvl.name, barsAgo: 0 });
  }

  for (let back = 1; back <= 12; back++) {
    const idx = candles5m.length - 1 - back;
    if (idx < 0) break;
    const c = candles5m[idx];
    for (const lvl of levels) {
      if (lvl.type === 'BSL' && c.high > lvl.price && c.close < lvl.price)
        results.push({ dir: 'bear', level: lvl.price, levelName: lvl.name, barsAgo: back });
      if (lvl.type === 'SSL' && c.low < lvl.price && c.close > lvl.price)
        results.push({ dir: 'bull', level: lvl.price, levelName: lvl.name, barsAgo: back });
    }
  }

  if (!results.length) return { detected: false };
  results.sort((a, b) => a.barsAgo - b.barsAgo);
  return { detected: true, ...results[0] };
}

function detectMSS(candles5m, sweepDir) {
  const window = candles5m.slice(-20);
  if (window.length < 5) return { confirmed: false };

  if (sweepDir === 'bear') {
    let swingLow = Infinity;
    for (let i = 0; i < window.length - 3; i++) {
      const c = window[i];
      if (c.low < (window[i-1]?.low ?? Infinity) && c.low < (window[i+1]?.low ?? Infinity))
        swingLow = Math.min(swingLow, c.low);
    }
    const last = window[window.length - 1], prev = window[window.length - 2];
    if (swingLow < Infinity && last.close < swingLow)
      return { confirmed: true, type: 'BOS_DOWN', level: swingLow };
    if (last.close < prev.low)
      return { confirmed: true, type: 'CHoCH', level: prev.low };
  }

  if (sweepDir === 'bull') {
    let swingHigh = -Infinity;
    for (let i = 0; i < window.length - 3; i++) {
      const c = window[i];
      if (c.high > (window[i-1]?.high ?? -Infinity) && c.high > (window[i+1]?.high ?? -Infinity))
        swingHigh = Math.max(swingHigh, c.high);
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
    const wickedIn   = prev.high >= best.bottom;
    const closedBack = prev.close <= best.top;
    confirmed = wickedIn && closedBack && (prev.high - best.bottom) >= best.size * 0.5;
  } else {
    const wickedIn   = prev.low <= best.top;
    const closedBack = prev.close >= best.bottom;
    confirmed = wickedIn && closedBack && (best.top - prev.low) >= best.size * 0.5;
  }

  return { found: true, top: best.top, bottom: best.bottom, size: best.size, inFVG: confirmed };
}

function liquidityTPs(dir, entry, risk, candles5m, h1Candles) {
  const isLong = dir === 'bull';
  const minTP  = isLong ? entry + risk * 1.5 : entry - risk * 1.5;
  const maxR   = 4.0;
  const candidates = [];

  const c5 = candles5m.slice(-60);
  for (let i = 2; i < c5.length - 1; i++) {
    const c = c5[i], prev = c5.slice(Math.max(0, i-8), i);
    if (isLong) {
      const eq = prev.find(p => Math.abs(p.high - c.high) / c.high < 0.001);
      if (eq) candidates.push({ price: Math.max(c.high, eq.high), desc: '5m equal highs' });
    } else {
      const eq = prev.find(p => Math.abs(p.low - c.low) / c.low < 0.001);
      if (eq) candidates.push({ price: Math.min(c.low, eq.low), desc: '5m equal lows' });
    }
  }

  const c1h = h1Candles.slice(-24);
  for (let i = 2; i < c1h.length - 2; i++) {
    const c = c1h[i];
    if (isLong && c.high > c1h[i-1].high && c.high > c1h[i-2].high && c.high > c1h[i+1].high)
      candidates.push({ price: c.high, desc: '1H swing high' });
    if (!isLong && c.low < c1h[i-1].low && c.low < c1h[i-2].low && c.low < c1h[i+1].low)
      candidates.push({ price: c.low, desc: '1H swing low' });
  }

  const valid = candidates
    .filter(t => isLong ? t.price > minTP && t.price < entry + risk * maxR
                        : t.price < minTP && t.price > entry - risk * maxR)
    .sort((a, b) => isLong ? a.price - b.price : b.price - a.price);

  const tp2obj = valid[0] || { price: isLong ? entry + risk*2.5 : entry - risk*2.5, desc: 'Fixed 2.5R' };
  const tp3obj = valid[1] || { price: isLong ? entry + risk*3.5 : entry - risk*3.5, desc: 'Fixed 3.5R' };
  return { tp2: tp2obj.price, tp2Desc: tp2obj.desc, tp3: tp3obj.price, tp3Desc: tp3obj.desc };
}

function scoreConf(sweep, mss, fvg) {
  let score = 25;
  if (sweep.detected) score += 25;
  if (mss.confirmed)  score += 25;
  if (fvg.found)      score += 15;
  if (fvg.inFVG)      score += 10;
  const grade = score >= 90 ? 'A+' : score >= 80 ? 'A' : score >= 70 ? 'B' : 'C';
  return { score: Math.min(score, 100), grade };
}

function simulateOutcome(dir, entry, sl, tp1, tp2, tp3, futureCandles) {
  let tp1Hit = false, currentSL = sl;
  for (const c of futureCandles) {
    const slHit  = dir === 'bull' ? c.low <= currentSL : c.high >= currentSL;
    const tp1Hit_ = dir === 'bull' ? c.high >= tp1 : c.low <= tp1;
    const tp2Hit  = dir === 'bull' ? c.high >= tp2 : c.low <= tp2;
    const tp3Hit  = dir === 'bull' ? c.high >= tp3 : c.low <= tp3;

    if (!tp1Hit) {
      if (slHit)   return { result: 'LOSS',    pnlR: -1 };
      if (tp3Hit)  return { result: 'WIN_TP3', pnlR: +(0.5*TP1_R + 0.25*2.5 + 0.25*3.5).toFixed(2) };
      if (tp2Hit)  return { result: 'WIN_TP2', pnlR: +(0.5*TP1_R + 0.5*2.5).toFixed(2) };
      if (tp1Hit_) { tp1Hit = true; currentSL = entry; }
    } else {
      if (slHit)   return { result: 'WIN_BE',  pnlR: +(0.5*TP1_R).toFixed(2) };
      if (tp3Hit)  return { result: 'WIN_TP3', pnlR: +(0.5*TP1_R + 0.25*2.5 + 0.25*3.5).toFixed(2) };
      if (tp2Hit)  return { result: 'WIN_TP2', pnlR: +(0.5*TP1_R + 0.5*2.5).toFixed(2) };
    }
  }
  if (tp1Hit) return { result: 'WIN_BE', pnlR: +(0.5*TP1_R).toFixed(2) };
  return { result: 'OPEN', pnlR: null };
}

function isKillZone(iso) {
  const h = new Date(iso).getUTCHours();
  return (h >= 7 && h < 9) || (h >= 12 && h < 15);
}

function sessionLabel(iso) {
  const h = new Date(iso).getUTCHours();
  if (h >= 7  && h < 9)  return '🟡 London KZ';
  if (h >= 12 && h < 15) return '🟢 NY KZ';
  return 'Off-hours';
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
function run() {
  console.clear();
  console.log('\n' + chalk.bold.white('  ■ DJ30 ICT — 1 YEAR BACKTEST'));
  console.log(chalk.gray('  Period: Jun 2025 → Jun 2026'));
  console.log(chalk.gray('  £2,000 start | 2% risk per trade | fully compounded'));
  console.log(chalk.gray('  Kill Zone only (07-09 + 12-15 UTC) | 80% min score\n'));

  // Load cached 5m and 1h data (available May 2025 → Jun 2026)
  const all5m = loadCached('5min', 2025, 5, 2026, 6);
  const allH1  = loadCached('1h',  2025, 5, 2026, 6);

  if (!all5m.length) {
    console.log(chalk.red('  ✗ No 5m data found. Run the fetch script first.'));
    process.exit(1);
  }

  // Roll up 15m from 5m (no 15m cache before Feb 2026)
  const all15m = rollup(all5m, 3);
  // Roll up 4h and daily from 1h
  const allH4    = rollup(allH1, 4);
  const allDaily = rollup(allH1, 24);

  const START  = new Date('2025-06-01T00:00:00Z');
  const END    = new Date('2026-06-05T23:59:59Z');
  const period5m = all5m.filter(c => { const t = new Date(c.time); return t >= START && t <= END; });

  console.log(chalk.gray(`  5m bars loaded:  ${all5m.length.toLocaleString()}`));
  console.log(chalk.gray(`  1h bars loaded:  ${allH1.length.toLocaleString()}`));
  console.log(chalk.gray(`  5m in period:    ${period5m.length.toLocaleString()}\n`));

  if (!period5m.length) { console.log(chalk.red('  No data in period.')); return; }

  // ─── Backtest loop ────────────────────────────────────────────────────────
  const signals   = [];
  let lastBar     = -999;
  let balance     = ACCOUNT_START;
  let peak        = ACCOUNT_START;
  let maxDD       = 0;

  for (let i = 60; i < period5m.length - 1; i++) {
    const bar = period5m[i];

    if (i - lastBar < COOLDOWN) continue;
    if (!isKillZone(bar.time)) continue;

    const time    = new Date(bar.time);
    const slice5m  = all5m.filter(c  => new Date(c.time) <= time);
    const slice15m = all15m.filter(c => new Date(c.time) <= time);
    const sliceH1  = allH1.filter(c  => new Date(c.time) <= time);

    if (slice5m.length < 40 || sliceH1.length < 6) continue;

    let sweep, mss, fvg, conf;
    try {
      sweep = detectSweep(slice15m, slice5m);
      mss   = sweep.detected ? detectMSS(slice5m, sweep.dir) : { confirmed: false };
      fvg   = (sweep.detected && mss.confirmed) ? detectFVG(slice5m, sweep.dir) : { found: false };
      conf  = sweep.dir ? scoreConf(sweep, mss, fvg) : { score: 0, grade: 'D' };
    } catch (e) { continue; }

    const dir = sweep.dir;
    if (!dir || !mss.confirmed || !fvg.inFVG || conf.score < MIN_SCORE) continue;

    const isLong = dir === 'bull';
    const entry  = isLong ? fvg.bottom + fvg.size * 0.5 : fvg.top - fvg.size * 0.5;
    const sl     = isLong
      ? sweep.level - sweep.level * 0.001
      : sweep.level + sweep.level * 0.001;
    const risk   = Math.abs(entry - sl);
    if (risk <= 0 || risk > entry * 0.015) continue;

    const tp1 = isLong ? entry + risk * TP1_R : entry - risk * TP1_R;
    const { tp2, tp2Desc, tp3, tp3Desc } = liquidityTPs(dir, entry, risk, slice5m, sliceH1);

    const future  = period5m.slice(i + 1, i + SIM_BARS);
    const outcome = simulateOutcome(dir, entry, sl, tp1, tp2, tp3, future);

    const riskGBP = balance * RISK_PCT;
    const pnlGBP  = outcome.pnlR != null ? outcome.pnlR * riskGBP : null;

    if (pnlGBP !== null) {
      balance += pnlGBP;
      if (balance > peak) peak = balance;
      const dd = (peak - balance) / peak * 100;
      if (dd > maxDD) maxDD = dd;
    }

    signals.push({
      time: bar.time, dir: isLong ? 'BUY' : 'SELL',
      entry: +entry.toFixed(2), sl: +sl.toFixed(2),
      tp1: +tp1.toFixed(2), tp2: +tp2.toFixed(2), tp3: +tp3.toFixed(2),
      score: conf.score, grade: conf.grade,
      session: sessionLabel(bar.time),
      sweep: sweep.levelName, mssType: mss.type,
      tp2Desc, tp3Desc,
      riskGBP: +riskGBP.toFixed(2),
      pnlGBP: pnlGBP !== null ? +pnlGBP.toFixed(2) : null,
      balanceAfter: pnlGBP !== null ? +balance.toFixed(2) : null,
      ...outcome
    });

    lastBar = i;
  }

  // ─── Results ─────────────────────────────────────────────────────────────
  const sep    = '═'.repeat(72);
  const closed = signals.filter(s => s.pnlR !== null);
  const wins   = closed.filter(s => s.pnlR > 0);
  const losses = closed.filter(s => s.pnlR < 0);
  const totalR = +closed.reduce((s, x) => s + x.pnlR, 0).toFixed(2);
  const totalP = +closed.reduce((s, x) => s + (x.pnlGBP||0), 0).toFixed(2);
  const wr     = closed.length ? Math.round(wins.length / closed.length * 100) : 0;
  const pf     = losses.length
    ? +(wins.reduce((s,x)=>s+x.pnlR,0) / Math.abs(losses.reduce((s,x)=>s+x.pnlR,0))).toFixed(2)
    : wins.length ? '∞' : 0;

  // Group by month
  const byMonth = {};
  closed.forEach(s => {
    const mo = s.time.slice(0,7);
    byMonth[mo] = byMonth[mo] || [];
    byMonth[mo].push(s);
  });

  // Quarterly
  const quarters = [
    { label: "Q3'25 Jun-Aug", start:'2025-06', end:'2025-09' },
    { label: "Q4'25 Sep-Nov", start:'2025-09', end:'2025-12' },
    { label: "Q1'26 Dec-Feb", start:'2025-12', end:'2026-03' },
    { label: "Q2'26 Mar-May", start:'2026-03', end:'2026-06' },
    { label: "Jun'26",        start:'2026-06', end:'2026-07' },
  ];

  console.log(sep);
  console.log(chalk.bold.white('  ■ FULL YEAR RESULTS — DJ30'));
  console.log(sep);
  console.log(chalk.gray('  Trades:      ') + chalk.bold.white(closed.length));
  console.log(chalk.gray('  Wins:        ') + chalk.green(wins.length));
  console.log(chalk.gray('  Losses:      ') + chalk.red(losses.length));
  console.log(chalk.gray('  Win rate:    ') + (wr>=70?chalk.bold.green:wr>=50?chalk.yellow:chalk.red)(wr+'%'));
  console.log(chalk.gray('  Net R:       ') + (totalR>=0?chalk.green(`+${totalR}R`):chalk.red(`${totalR}R`)));
  console.log(chalk.gray('  Prof. factor:') + chalk.cyan(' '+pf));

  console.log('\n' + chalk.bold.white('  ── ACCOUNT (£2,000 start · 2% risk · compounded) ──'));
  console.log(chalk.gray('  Start:       ') + chalk.white('£2,000.00'));
  console.log(chalk.gray('  End:         ') + (balance>=ACCOUNT_START?chalk.bold.green:chalk.red)('£'+balance.toFixed(2)));
  console.log(chalk.gray('  Net P&L:     ') + (totalP>=0?chalk.green('+£'+totalP.toFixed(2)):chalk.red('£'+totalP.toFixed(2))));
  console.log(chalk.gray('  Return:      ') + (balance>=ACCOUNT_START?chalk.bold.green:chalk.red)(((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1)+'%'));
  console.log(chalk.gray('  Peak bal:    ') + chalk.white('£'+peak.toFixed(2)));
  console.log(chalk.gray('  Max drawdown:') + chalk.yellow(' '+maxDD.toFixed(1)+'%'));

  // Quarterly breakdown
  console.log(chalk.gray('\n  Quarterly breakdown:'));
  let cumR = 0, cumBal = ACCOUNT_START;
  for (const q of quarters) {
    const qs = closed.filter(s => s.time.slice(0,7) >= q.start && s.time.slice(0,7) < q.end);
    if (!qs.length) continue;
    const qw  = qs.filter(s=>s.pnlR>0).length;
    const ql  = qs.filter(s=>s.pnlR<0).length;
    const qR  = +qs.reduce((s,x)=>s+x.pnlR,0).toFixed(2);
    const qGBP= +qs.reduce((s,x)=>s+(x.pnlGBP||0),0).toFixed(2);
    cumR = +(cumR + qR).toFixed(2);
    cumBal += qGBP;
    const qwr = (qw+ql) ? Math.round(qw/(qw+ql)*100) : 0;
    const rColor = qR>=0?chalk.green:chalk.red;
    console.log(
      chalk.gray(`    ${q.label.padEnd(16)} `) +
      chalk.cyan(`${qs.length}tr  `) +
      chalk.green(`${qw}W`) + '/' + chalk.red(`${ql}L`) +
      chalk.gray(`  ${String(qwr+'%').padEnd(5)}  `) +
      rColor(`${qR>=0?'+':''}${qR}R`) +
      chalk.gray('  ') + (qGBP>=0?chalk.green(`+£${qGBP.toFixed(0)}`):chalk.red(`-£${Math.abs(qGBP).toFixed(0)}`)) +
      chalk.gray(` → bal: `) + chalk.white(`£${cumBal.toFixed(0)}`)
    );
  }

  // Month by month
  console.log(chalk.gray('\n  Month by month:'));
  let runBal = ACCOUNT_START;
  Object.entries(byMonth).sort().forEach(([mo, sigs]) => {
    const mW   = sigs.filter(s=>s.pnlR>0).length;
    const mL   = sigs.filter(s=>s.pnlR<0).length;
    const mR   = +sigs.reduce((s,x)=>s+x.pnlR,0).toFixed(2);
    const mGBP = +sigs.reduce((s,x)=>s+(x.pnlGBP||0),0).toFixed(2);
    runBal += mGBP;
    const mWR  = (mW+mL) ? Math.round(mW/(mW+mL)*100) : 0;
    const rCol = mR>=0?chalk.green:chalk.red;
    console.log(
      chalk.gray(`    ${mo}  `) +
      chalk.white(`${sigs.length}tr  `) +
      chalk.green(`${mW}W`) + '/' + chalk.red(`${mL}L`) +
      chalk.gray(`  ${String(mWR+'%').padEnd(5)}  `) +
      rCol(`${mR>=0?'+':''}${mR}R`) +
      chalk.gray('  ') + (mGBP>=0?chalk.green(`+£${mGBP.toFixed(0)}`):chalk.red(`-£${Math.abs(mGBP).toFixed(0)}`)) +
      chalk.gray(` → £${runBal.toFixed(0)}`)
    );
  });

  // Session breakdown
  console.log(chalk.gray('\n  By session:'));
  ['🟡 London KZ', '🟢 NY KZ'].forEach(sess => {
    const ss = closed.filter(s=>s.session===sess);
    if (!ss.length) return;
    const sw=ss.filter(s=>s.pnlR>0).length, sl_=ss.filter(s=>s.pnlR<0).length;
    const sr=+ss.reduce((s,x)=>s+x.pnlR,0).toFixed(2);
    const swr=(sw+sl_)?Math.round(sw/(sw+sl_)*100):0;
    console.log(chalk.gray(`    ${sess.padEnd(16)} ${ss.length}tr  `)+
      chalk.green(`${sw}W`) + '/' + chalk.red(`${sl_}L`) +
      chalk.gray(`  ${swr}%WR  `) +
      (sr>=0?chalk.green(`+${sr}R`):chalk.red(`${sr}R`)));
  });

  // Result breakdown
  console.log(chalk.gray('\n  Result types:'));
  const byResult = {};
  closed.forEach(s => { byResult[s.result] = (byResult[s.result]||0) + 1; });
  Object.entries(byResult).sort((a,b)=>b[1]-a[1]).forEach(([r,n]) => {
    const c = r?.startsWith('WIN') ? chalk.green : chalk.red;
    console.log(chalk.gray(`    ${c((r||'?').padEnd(12))}  ${n} trades  (${Math.round(n/closed.length*100)}%)`));
  });

  // Growth table
  console.log(chalk.gray('\n  ── Balance growth snapshots ──'));
  const snapshots = [0, 0.25, 0.5, 0.75, 1.0].map(pct => {
    const idx = Math.floor(closed.length * pct);
    const s = closed[Math.min(idx, closed.length-1)];
    return s;
  });
  let prevBal = ACCOUNT_START;
  closed.forEach((s, i) => {
    if ([0, Math.floor(closed.length*0.25), Math.floor(closed.length*0.5),
         Math.floor(closed.length*0.75), closed.length-1].includes(i)) {
      const ret = ((s.balanceAfter - ACCOUNT_START) / ACCOUNT_START * 100).toFixed(1);
      console.log(chalk.gray(`    Trade #${String(i+1).padStart(3)}  ${s.time.slice(0,10)}  `) +
        chalk.white(`£${s.balanceAfter?.toFixed(2)}`) +
        chalk.gray(`  (${ret>=0?'+':''}${ret}%)`));
    }
  });

  console.log('\n' + sep + '\n');

  fs.writeFileSync(
    path.join(__dirname, '..', 'backtest_report_1year_dj30.json'),
    JSON.stringify({
      period: 'Jun 2025 → Jun 2026', generatedAt: new Date().toISOString(),
      settings: { symbol:'DJ30/DIA', start:ACCOUNT_START, riskPct:RISK_PCT*100, minScore:MIN_SCORE },
      account: {
        start: ACCOUNT_START, end: +balance.toFixed(2),
        netGBP: +totalP.toFixed(2),
        returnPct: +((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1),
        maxDD: +maxDD.toFixed(1), peak: +peak.toFixed(2)
      },
      stats: { trades:closed.length, wins:wins.length, losses:losses.length, wr:wr+'%', netR:totalR, pf },
      byMonth: Object.fromEntries(Object.entries(byMonth).map(([mo,sigs])=>[mo,{
        trades:sigs.length,
        wins:sigs.filter(s=>s.pnlR>0).length,
        losses:sigs.filter(s=>s.pnlR<0).length,
        netR:+sigs.reduce((s,x)=>s+x.pnlR,0).toFixed(2),
        netGBP:+sigs.reduce((s,x)=>s+(x.pnlGBP||0),0).toFixed(2)
      }])),
      signals
    }, null, 2)
  );
  console.log(chalk.gray('  Report → backtest_report_1year_dj30.json\n'));
}

run();
