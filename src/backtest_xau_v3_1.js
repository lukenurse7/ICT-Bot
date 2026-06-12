'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  XAUUSD ICT v3.1 — LONDON SELL-ONLY TUNED
//  Tests the hypothesis that London SELL (Asia High sweep → sell) is the
//  only reliable ICT setup for XAU. All parameters optimised from v3 data.
//
//  Also runs a COMPARISON panel:
//    A) London SELL only
//    B) London BOTH directions
//    C) All KZs SELL only
//    D) All KZs BOTH directions
//  So user can see exactly what SELL-only vs both-directions means.
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const ACCOUNT_START = 1500;
const RISK_PCT      = 0.02;
const SIM_BARS      = 288;
const COOLDOWN_BARS = 24;
const MIN_WICK      = 3;
const MIN_RISK      = 12;   // skip trades with SL < $12 (stops out on noise)
const MAX_RISK      = 30;   // skip trades with SL > $30 (compresses R:R too much)

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

function rollupM15(m5) {
  const out = [];
  for (let i = 0; i < m5.length; i += 3) {
    const s = m5.slice(i, i + 3);
    if (!s.length) continue;
    out.push({ time: s[0].time, open: s[0].open, high: Math.max(...s.map(c=>c.high)),
      low: Math.min(...s.map(c=>c.low)), close: s[s.length-1].close });
  }
  return out;
}

function getKZ(isoTime, includeNY = false) {
  const h = new Date(isoTime).getUTCHours();
  if (h >= 0  && h < 4)  return 'Asia';
  if (h >= 7  && h < 10) return 'London';
  if (includeNY && h >= 12 && h < 15) return 'NY';
  return null;
}

function getSessionRange(candles5m, dateStr, startHour, endHour) {
  const sess = candles5m.filter(c => {
    if (!c.time.startsWith(dateStr)) return false;
    const h = new Date(c.time).getUTCHours();
    return h >= startHour && h < endHour;
  });
  if (sess.length < 3) return null;
  return { high: Math.max(...sess.map(c=>c.high)), low: Math.min(...sess.map(c=>c.low)) };
}

function detectSweep(candles5m, kz, dateStr) {
  const recentBars = candles5m.slice(-30);
  const sweeps = [];
  const levels = [];

  const yesterday = candles5m.filter(c => {
    const today = new Date(dateStr + 'T00:00:00Z');
    const yest  = new Date(today - 86400000);
    const t = new Date(c.time);
    return t >= yest && t < today;
  });

  if (yesterday.length) {
    levels.push({ price: Math.max(...yesterday.map(c=>c.high)), label: 'PDH', dir: 'bear' });
    levels.push({ price: Math.min(...yesterday.map(c=>c.low)),  label: 'PDL', dir: 'bull' });
  }

  if (kz === 'London') {
    const asia = getSessionRange(candles5m, dateStr, 0, 7);
    if (asia) {
      levels.push({ price: asia.high, label: 'Asia High', dir: 'bear' });
      levels.push({ price: asia.low,  label: 'Asia Low',  dir: 'bull' });
    }
  }
  if (kz === 'NY') {
    const london = getSessionRange(candles5m, dateStr, 7, 14);
    if (london) {
      levels.push({ price: london.high, label: 'London High', dir: 'bear' });
      levels.push({ price: london.low,  label: 'London Low',  dir: 'bull' });
    }
  }
  if (kz === 'Asia') {
    if (yesterday.length) {
      levels.push({ price: Math.max(...yesterday.map(c=>c.high)), label: 'Prev Day High', dir: 'bear' });
      levels.push({ price: Math.min(...yesterday.map(c=>c.low)),  label: 'Prev Day Low',  dir: 'bull' });
    }
  }

  for (const lvl of levels) {
    for (let back = 0; back < Math.min(24, recentBars.length - 1); back++) {
      const c = recentBars[recentBars.length - 1 - back];
      const kzH = new Date(c.time).getUTCHours();
      const inKZ = (kz==='Asia' && kzH>=0 && kzH<4)
                || (kz==='London' && kzH>=7 && kzH<10)
                || (kz==='NY' && kzH>=12 && kzH<15);
      if (!inKZ) continue;

      if (lvl.dir === 'bear' && c.high > lvl.price && c.close < lvl.price && (c.high - lvl.price) >= MIN_WICK) {
        sweeps.push({ dir: 'bear', level: lvl.price, levelName: lvl.label,
          sweepHigh: c.high, sweepCandle: c, barsAgo: back,
          sweepBarIdx: recentBars.length - 1 - back });
        break;
      }
      if (lvl.dir === 'bull' && c.low < lvl.price && c.close > lvl.price && (lvl.price - c.low) >= MIN_WICK) {
        sweeps.push({ dir: 'bull', level: lvl.price, levelName: lvl.label,
          sweepLow: c.low, sweepCandle: c, barsAgo: back,
          sweepBarIdx: recentBars.length - 1 - back });
        break;
      }
    }
  }

  if (!sweeps.length) return null;
  sweeps.sort((a, b) => a.barsAgo - b.barsAgo);
  return sweeps[0];
}

// BOS only — no CHoCH. M15 confirmation: relaxed bias check (not strict swing break)
function detectMSS(candles5m, candles15m, sweepDir) {
  const w5  = candles5m.slice(-20);
  const w15 = candles15m ? candles15m.slice(-20) : [];
  if (w5.length < 5) return { confirmed: false };

  let m5BOS = false, m5Level = 0, m5Type = null;
  if (sweepDir === 'bear') {
    let swingLow = Infinity;
    for (let i = 1; i < w5.length - 1; i++) {
      if (w5[i].low < w5[i-1].low && w5[i].low < w5[i+1].low) swingLow = Math.min(swingLow, w5[i].low);
    }
    if (swingLow < Infinity && w5[w5.length-1].close < swingLow) {
      m5BOS = true; m5Level = swingLow; m5Type = 'BOS_DOWN';
    }
  } else {
    let swingHigh = -Infinity;
    for (let i = 1; i < w5.length - 1; i++) {
      if (w5[i].high > w5[i-1].high && w5[i].high > w5[i+1].high) swingHigh = Math.max(swingHigh, w5[i].high);
    }
    if (swingHigh > -Infinity && w5[w5.length-1].close > swingHigh) {
      m5BOS = true; m5Level = swingHigh; m5Type = 'BOS_UP';
    }
  }
  if (!m5BOS) return { confirmed: false };

  // Relaxed M15 check: just verify M15 bias aligns (not requiring fresh swing break)
  if (w15.length >= 10) {
    const m15Prices = w15.map(c => c.close);
    const m15Mid    = (Math.max(...m15Prices) + Math.min(...m15Prices)) / 2;
    const m15Last   = w15[w15.length - 1].close;
    const bearOk    = sweepDir === 'bear' && m15Last < m15Mid;
    const bullOk    = sweepDir === 'bull' && m15Last > m15Mid;
    if (!bearOk && !bullOk) return { confirmed: false, reason: 'M15 bias mismatch' };
  }

  return { confirmed: true, type: m5Type, level: m5Level, grade: 'major',
           mssBar: w5[w5.length - 1] };
}

function detectFVG(candles5m, candles15m, sweepDir, sweepBarIdx) {
  const results = [];

  function scanTF(candles, tf, startIdx) {
    const w = candles.slice(Math.max(0, startIdx), candles.length);
    for (let i = 1; i < w.length - 1; i++) {
      const c0 = w[i-1], c1 = w[i], c2 = w[i+1];

      if (sweepDir === 'bear' && c2.high < c0.low) {
        const size = c0.low - c2.high;
        if (size < 1.0) continue;
        results.push({ type: 'bearish', tf, top: c0.low, bottom: c2.high, size,
          midpoint: (c0.low + c2.high) / 2, recency: w.length - 1 - i, priority: 1 });
      }
      if (sweepDir === 'bull' && c2.low > c0.high) {
        const size = c2.low - c0.high;
        if (size < 1.0) continue;
        results.push({ type: 'bullish', tf, top: c2.low, bottom: c0.high, size,
          midpoint: (c2.low + c0.high) / 2, recency: w.length - 1 - i, priority: 1 });
      }

      if (sweepDir === 'bear' && c2.low > c0.high) {
        const last = candles[candles.length - 1];
        if (last.close < c0.high) {
          const size = c2.low - c0.high;
          if (size < 1.0) continue;
          results.push({ type: 'inversion_bear', tf, top: c2.low, bottom: c0.high, size,
            midpoint: (c2.low + c0.high) / 2, recency: w.length - 1 - i, priority: 0 });
        }
      }
      if (sweepDir === 'bull' && c2.high < c0.low) {
        const last = candles[candles.length - 1];
        if (last.close > c0.low) {
          const size = c0.low - c2.high;
          if (size < 1.0) continue;
          results.push({ type: 'inversion_bull', tf, top: c0.low, bottom: c2.high, size,
            midpoint: (c0.low + c2.high) / 2, recency: w.length - 1 - i, priority: 0 });
        }
      }
    }
  }

  scanTF(candles5m, 'M5', sweepBarIdx);
  if (candles15m && candles15m.length >= 5)
    scanTF(candles15m, 'M15', Math.max(0, candles15m.length - 15));

  if (!results.length) return null;
  results.sort((a, b) => a.priority !== b.priority ? a.priority - b.priority
    : a.recency !== b.recency ? a.recency - b.recency : b.size - a.size);
  return results[0];
}

function liquidityTPs(dir, entry, risk, candles5m, h1) {
  const isLong = dir === 'bull';
  const candidates = [];
  function rOf(p) { return Math.abs(p - entry) / risk; }
  function ok(p)  { return (isLong ? p > entry : p < entry) && rOf(p) >= 1.0 && rOf(p) <= 10.0; }

  const c5 = candles5m.slice(-80);
  for (let i = 2; i < c5.length - 1; i++) {
    const c = c5[i], prev = c5.slice(Math.max(0, i-8), i);
    if (isLong) {
      const eq = prev.find(p => Math.abs(p.high - c.high) / c.high < 0.001);
      if (eq) { const p = Math.max(c.high, eq.high); if (ok(p)) candidates.push({ price: p, r: rOf(p), desc: '5m EQH' }); }
    } else {
      const eq = prev.find(p => Math.abs(p.low - c.low) / c.low < 0.001);
      if (eq) { const p = Math.min(c.low, eq.low); if (ok(p)) candidates.push({ price: p, r: rOf(p), desc: '5m EQL' }); }
    }
  }
  const c1h = h1.slice(-48);
  for (let i = 2; i < c1h.length - 2; i++) {
    const c = c1h[i];
    if (isLong  && c.high > c1h[i-1].high && c.high > c1h[i-2].high && c.high > c1h[i+1].high && ok(c.high))
      candidates.push({ price: c.high, r: rOf(c.high), desc: '1H swing H' });
    if (!isLong && c.low  < c1h[i-1].low  && c.low  < c1h[i-2].low  && c.low  < c1h[i+1].low  && ok(c.low))
      candidates.push({ price: c.low,  r: rOf(c.low),  desc: '1H swing L' });
  }
  candidates.sort((a, b) => a.r - b.r);
  const deduped = [];
  for (const c of candidates) {
    if (!deduped.find(d => Math.abs(d.price - c.price) / entry <= 0.0005)) deduped.push(c);
  }
  const t1o = deduped[0];
  const tp1  = t1o ? t1o.price : (isLong ? entry + risk*2   : entry - risk*2);
  const tp1R = parseFloat(rOf(tp1).toFixed(2));
  const tp1D = t1o ? t1o.desc : 'Fixed 2R';
  const t2o  = deduped.find(c => c.r >= tp1R + 0.8);
  const tp2  = t2o ? t2o.price : (isLong ? entry + risk*(tp1R+2) : entry - risk*(tp1R+2));
  const tp2R = parseFloat(rOf(tp2).toFixed(2));
  const tp2D = t2o ? t2o.desc : 'Fixed extension';
  return { tp1, tp1R, tp1Desc: tp1D, tp2, tp2R, tp2Desc: tp2D };
}

function simulateOutcome(dir, entry, sl, tp1, tp2, tp1R, tp2R, future) {
  let tp1Hit = false, sl_ = sl;
  for (const c of future) {
    const slHit  = dir==='bull' ? c.low<=sl_  : c.high>=sl_;
    const t1Hit_ = dir==='bull' ? c.high>=tp1 : c.low<=tp1;
    const t2Hit  = dir==='bull' ? c.high>=tp2 : c.low<=tp2;
    if (!tp1Hit) {
      if (slHit)  return { result:'LOSS',       pnlR:-1 };
      if (t2Hit)  return { result:'WIN_TP2',    pnlR:+(0.5*tp1R+0.5*tp2R).toFixed(2) };
      if (t1Hit_) { tp1Hit=true; sl_=entry; }
    } else {
      if (slHit)  return { result:'WIN_TP1_BE', pnlR:+(0.5*tp1R).toFixed(2) };
      if (t2Hit)  return { result:'WIN_TP2',    pnlR:+(0.5*tp1R+0.5*tp2R).toFixed(2) };
    }
  }
  if (tp1Hit) return { result:'WIN_TP1_OPEN', pnlR:+(0.5*tp1R).toFixed(2) };
  return { result:'OPEN', pnlR:null };
}

// ─── Simulate one scenario ──────────────────────────────────────────────────
function runScenario(period5m, all15m_raw, allH1, opts) {
  const { name, kzFilter, dirFilter, riskMin, riskMax } = opts;
  const signals = [];
  let balance = ACCOUNT_START, peak = ACCOUNT_START, maxDD = 0;
  let lastBar = -999;
  let m15Ptr = 0, h1Ptr = 0;

  for (let i = 100; i < period5m.length - 1; i++) {
    const bar = period5m[i];
    const kz  = getKZ(bar.time, kzFilter.includes('NY'));
    if (!kz || !kzFilter.includes(kz)) continue;
    if (i - lastBar < COOLDOWN_BARS) continue;

    const dateStr = bar.time.slice(0, 10);
    const slice5m = period5m.slice(Math.max(0, i - 200), i + 1);
    while (m15Ptr < all15m_raw.length - 1 && all15m_raw[m15Ptr+1].time <= bar.time) m15Ptr++;
    while (h1Ptr  < allH1.length - 1      && allH1[h1Ptr+1].time      <= bar.time) h1Ptr++;
    const slice15m    = all15m_raw.slice(Math.max(0, m15Ptr - 80), m15Ptr + 1);
    const sliceH1     = allH1.slice(Math.max(0, h1Ptr - 100), h1Ptr + 1);
    const slice5mWide = period5m.slice(Math.max(0, i - 600), i + 1);

    const sweep = detectSweep(slice5mWide, kz, dateStr);
    if (!sweep) continue;
    if (dirFilter === 'SELL' && sweep.dir !== 'bear') continue;
    if (dirFilter === 'BUY'  && sweep.dir !== 'bull') continue;

    const sweepIdx = slice5m.length - 1 - sweep.barsAgo;
    const fvg = detectFVG(slice5m, slice15m.length >= 10 ? slice15m : null, sweep.dir, sweepIdx);
    if (!fvg) continue;

    const mss = detectMSS(slice5m, slice15m.length >= 10 ? slice15m : null, sweep.dir);
    if (!mss.confirmed) continue;

    // Market order at BOS close
    const mssBar = mss.mssBar || slice5m[slice5m.length - 1];
    const entry  = mssBar.close;
    const isLong = sweep.dir === 'bull';
    const SL_BUF = entry * 0.001;

    let sl;
    if (isLong) {
      const extreme = sweep.sweepLow ?? (entry - SL_BUF * 3);
      sl = extreme - SL_BUF;
      if (sl >= entry) sl = entry - SL_BUF * 3;
    } else {
      const extreme = sweep.sweepHigh ?? (entry + SL_BUF * 3);
      sl = extreme + SL_BUF;
      if (sl <= entry) sl = entry + SL_BUF * 3;
    }
    const risk = Math.abs(entry - sl);
    if (risk < riskMin || risk > riskMax) continue;

    lastBar = i;
    const liq = liquidityTPs(sweep.dir, entry, risk, slice5m, sliceH1);
    const { tp1, tp1R, tp1Desc, tp2, tp2R, tp2Desc } = liq;
    const future  = period5m.slice(i+1, i+1+SIM_BARS);
    const outcome = simulateOutcome(sweep.dir, entry, sl, tp1, tp2, tp1R, tp2R, future);
    const riskGBP = balance * RISK_PCT;
    const pnlGBP  = outcome.pnlR != null ? outcome.pnlR * riskGBP : null;

    if (pnlGBP !== null) {
      balance += pnlGBP;
      if (balance > peak) peak = balance;
      const dd = (peak - balance) / peak * 100;
      if (dd > maxDD) maxDD = dd;
    }

    signals.push({ time: bar.time, dir: isLong?'BUY':'SELL', kz,
      entry: +entry.toFixed(2), sl: +sl.toFixed(2), tp1: +tp1.toFixed(2), tp2: +tp2.toFixed(2),
      tp1R, tp1Desc, tp2R, tp2Desc, risk: +risk.toFixed(2),
      sweep: sweep.levelName, mssType: mss.type, fvgType: fvg.type, fvgTF: fvg.tf,
      riskGBP: +riskGBP.toFixed(2),
      pnlGBP: pnlGBP != null ? +pnlGBP.toFixed(2) : null,
      balanceAfter: +balance.toFixed(2),
      ...outcome });
  }

  return { name, signals, balance, peak, maxDD };
}

// ─── Print scenario results ──────────────────────────────────────────────────
function printScenario(res, color) {
  const { name, signals, balance, maxDD } = res;
  const closed = signals.filter(s => s.pnlR != null);
  const wins   = closed.filter(s => s.pnlR > 0);
  const losses = closed.filter(s => s.pnlR < 0);
  const totalR = +closed.reduce((s,x)=>s+x.pnlR,0).toFixed(2);
  const totalGBP = +closed.reduce((s,x)=>s+(x.pnlGBP||0),0).toFixed(2);
  const wr     = closed.length ? Math.round(wins.length/closed.length*100) : 0;
  const pf     = losses.length
    ? +(wins.reduce((s,x)=>s+x.pnlR,0)/Math.abs(losses.reduce((s,x)=>s+x.pnlR,0))).toFixed(2)
    : wins.length ? '∞' : 0;

  const sep = '─'.repeat(72);
  console.log('\n' + color('  ◆ ' + name));
  console.log(chalk.gray('  ' + sep));
  console.log(chalk.gray('  Trades:        ') + signals.length +
    chalk.gray('   Wins: ') + chalk.green(wins.length) +
    chalk.gray('   Losses: ') + chalk.red(losses.length) +
    chalk.gray('   WR: ') + (wr>=50?chalk.green:chalk.yellow)(wr+'%'));
  console.log(chalk.gray('  Net R:         ') + (totalR>=0?chalk.green(`+${totalR}R`):chalk.red(`${totalR}R`)) +
    chalk.gray('   PF: ') + chalk.cyan(pf));
  console.log(chalk.gray('  Account end:   ') + (balance>=ACCOUNT_START?chalk.green:chalk.red)('£'+balance.toFixed(2)) +
    chalk.gray('   Return: ') + (balance>=ACCOUNT_START?chalk.green:chalk.red)(fmtPct((balance-ACCOUNT_START)/ACCOUNT_START*100)) +
    chalk.gray('   MaxDD: ') + chalk.yellow(maxDD.toFixed(1)+'%'));

  // Per KZ
  const kzs = [...new Set(signals.map(s=>s.kz))].sort();
  if (kzs.length > 1) {
    console.log(chalk.gray('  By KZ:'));
    for (const kz of kzs) {
      const ks = signals.filter(s=>s.kz===kz && s.pnlR!=null);
      if (!ks.length) continue;
      const kw=ks.filter(s=>s.pnlR>0).length, kl=ks.filter(s=>s.pnlR<0).length;
      const kr=+ks.reduce((s,x)=>s+x.pnlR,0).toFixed(1);
      const kwr=(kw+kl)?Math.round(kw/(kw+kl)*100):0;
      console.log(chalk.gray(`    ${kz.padEnd(7)} ${ks.length} trades  ${kw}W/${kl}L  ${kwr}% WR  `) +
        (kr>=0?chalk.green(`+${kr}R`):chalk.red(`${kr}R`)));
    }
  }

  // Per direction (if both)
  const dirs = [...new Set(signals.map(s=>s.dir))];
  if (dirs.length > 1) {
    console.log(chalk.gray('  By direction:'));
    for (const d of ['BUY','SELL']) {
      const ds = signals.filter(s=>s.dir===d && s.pnlR!=null);
      if (!ds.length) continue;
      const dw=ds.filter(s=>s.pnlR>0).length, dl=ds.filter(s=>s.pnlR<0).length;
      const dr=+ds.reduce((s,x)=>s+x.pnlR,0).toFixed(1);
      const dwr=(dw+dl)?Math.round(dw/(dw+dl)*100):0;
      console.log(chalk.gray(`    ${d.padEnd(5)} ${ds.length} trades  ${dw}W/${dl}L  ${dwr}% WR  `) +
        (dr>=0?chalk.green(`+${dr}R`):chalk.red(`${dr}R`)));
    }
  }

  // Month by month
  const byMonth = {};
  signals.forEach(s => {
    if (s.pnlR == null) return;
    const d=new Date(s.time), k=`${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
    byMonth[k]=(byMonth[k]||[]).concat(s);
  });
  const months = Object.entries(byMonth).sort();
  if (months.length) {
    console.log(chalk.gray('  Month by month:'));
    months.forEach(([mo, ms]) => {
      const mW=ms.filter(s=>s.pnlR>0).length, mL=ms.filter(s=>s.pnlR<0).length;
      const mR=+ms.reduce((s,x)=>s+x.pnlR,0).toFixed(1);
      const mWR=(mW+mL)?Math.round(mW/(mW+mL)*100):0;
      const mGBP=+ms.reduce((s,x)=>s+(x.pnlGBP||0),0).toFixed(2);
      console.log(chalk.gray(`    ${mo}  ${ms.length} trades  `)+chalk.green(`${mW}W`)+'/'+chalk.red(`${mL}L`)+
        chalk.gray(`  ${mWR}% WR  `)+(mR>=0?chalk.green(`+${mR}R`):chalk.red(`${mR}R`))+
        chalk.gray('  ')+(mGBP>=0?chalk.green(fmtGBP(mGBP)):chalk.red(fmtGBP(mGBP))));
    });
  }

  return { name, trades: signals.length, wins: wins.length, losses: losses.length,
    wr: wr+'%', netR: totalR, pf, returnPct: +((balance-ACCOUNT_START)/ACCOUNT_START*100).toFixed(1),
    maxDD: +maxDD.toFixed(1), endBalance: +balance.toFixed(2) };
}

// ─── MAIN ───────────────────────────────────────────────────────────────────
function run() {
  console.log('\n' + chalk.bold.yellow('  ◆ XAUUSD ICT v3.1 — SELL-ONLY vs BOTH DIRECTIONS COMPARISON'));
  console.log(chalk.gray('  Period: 2025-06-11 → 2026-06-10'));
  console.log(chalk.gray('  Entry: market order at BOS close | SL: sweep extreme'));
  console.log(chalk.gray('  Risk filter: $'+MIN_RISK+'–$'+MAX_RISK+' per trade | BOS only (no CHoCH)'));
  console.log(chalk.gray('  Relaxed M15: bias alignment check (not strict swing break)\n'));

  const all5m = loadChunks('xau1yr_5min');
  const all15m_raw = rollupM15(all5m);
  const allH1 = loadChunks('xau1yr_1h');
  const START = new Date('2025-06-11T00:00:00Z');
  const END   = new Date('2026-06-10T23:59:59Z');
  const period5m = all5m.filter(c => { const t=new Date(c.time); return t>=START && t<=END; });
  console.log(chalk.gray(`  5m bars: ${period5m.length}\n`));

  // Four scenarios
  const scenarios = [
    { name: 'A — London SELL only  (Asia High sweep → sell)', kzFilter:['London'], dirFilter:'SELL', riskMin:MIN_RISK, riskMax:MAX_RISK },
    { name: 'B — London BOTH directions',                      kzFilter:['London'], dirFilter:'BOTH', riskMin:MIN_RISK, riskMax:MAX_RISK },
    { name: 'C — All KZs SELL only  (Asia+London+NY)',         kzFilter:['Asia','London','NY'], dirFilter:'SELL', riskMin:MIN_RISK, riskMax:MAX_RISK },
    { name: 'D — All KZs BOTH directions',                     kzFilter:['Asia','London','NY'], dirFilter:'BOTH', riskMin:MIN_RISK, riskMax:MAX_RISK },
  ];

  const colors = [chalk.bold.cyan, chalk.bold.white, chalk.bold.yellow, chalk.bold.magenta];
  const summaries = [];

  for (let idx = 0; idx < scenarios.length; idx++) {
    const res = runScenario(period5m, all15m_raw, allH1, scenarios[idx]);
    summaries.push(printScenario(res, colors[idx]));
  }

  // Final comparison table
  const sep = '═'.repeat(76);
  console.log('\n' + sep);
  console.log(chalk.bold.white('  ══ FINAL COMPARISON TABLE ══'));
  console.log(sep);
  console.log(chalk.gray('  Scenario                            Trades  WR     Net R    Return   MaxDD'));
  console.log(chalk.gray('  ' + '─'.repeat(74)));
  const cls = [chalk.cyan, chalk.white, chalk.yellow, chalk.magenta];
  summaries.forEach((s, i) => {
    const netRStr = (s.netR>=0?'+':'')+s.netR+'R';
    const retStr  = (s.returnPct>=0?'+':'')+s.returnPct+'%';
    console.log(cls[i](
      `  ${s.name.slice(4).padEnd(36)} ${String(s.trades).padStart(5)}  ${s.wr.padStart(5)}  ` +
      `${netRStr.padStart(8)}  ${retStr.padStart(7)}  ${s.maxDD}%`
    ));
  });
  console.log(sep + '\n');

  // Verdict
  const best = summaries.reduce((a,b) => b.netR > a.netR ? b : a);
  console.log(chalk.bold.white('  VERDICT:'));
  console.log(chalk.gray('  Best scenario by net R: ') + chalk.bold.yellow(best.name));
  console.log(chalk.gray('  London SELL-only WR:    ') + chalk.bold(summaries[0].wr));
  console.log(chalk.gray('  London BOTH dirs WR:    ') + chalk.bold(summaries[1].wr));
  console.log(chalk.gray('  All KZs SELL-only WR:   ') + chalk.bold(summaries[2].wr));
  console.log(chalk.gray('  All KZs BOTH dirs WR:   ') + chalk.bold(summaries[3].wr) + '\n');

  fs.writeFileSync(path.join(__dirname,'..','backtest_report_xau_v3_1.json'),
    JSON.stringify({ period:'2025-06-11 → 2026-06-10', method:'ICT v3.1 sell-only vs both comparison',
      generatedAt: new Date().toISOString(), summaries }, null, 2));
  console.log(chalk.gray('  Report → backtest_report_xau_v3_1.json\n'));
}

run();
