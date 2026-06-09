'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  XAUUSD ICT LIVE BACKTEST — Last 2 Weeks (real TwelveData candles)
//  Fetches actual OHLCV data, rolls the ICT engine bar-by-bar,
//  records every signal that would have fired, simulates outcomes,
//  and prints a full report.
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const axios = require('axios');
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const {
  htfBias, keyLevels, detectLiquiditySweep,
  detectMSS, entryFVG, findOrderBlock, scoreConfluence
} = require('./ict_xau');

const KEY    = process.env.TWELVEDATA_API_KEY;
const BASE   = 'https://api.twelvedata.com';
const SYMBOL = 'XAU/USD';

// ─── Date helpers ────────────────────────────────────────────────────────────

function lastTwoWeeksRange() {
  // Returns Mon 2 weeks ago → Fri of most recent completed week
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun
  // End = last Friday
  const daysToLastFri = day === 0 ? 1 : (day >= 6 ? day - 5 : day + 2);
  const lastFri = new Date(now);
  lastFri.setUTCDate(now.getUTCDate() - daysToLastFri);
  lastFri.setUTCHours(23, 59, 59, 0);
  // Start = Mon 2 weeks before last Friday (14 days back from lastFri's Monday)
  const lastMon = new Date(lastFri);
  lastMon.setUTCDate(lastFri.getUTCDate() - 4); // same week Mon
  const twoWeekMon = new Date(lastMon);
  twoWeekMon.setUTCDate(lastMon.getUTCDate() - 7); // one week earlier
  twoWeekMon.setUTCHours(0, 0, 0, 0);

  return {
    start: twoWeekMon,
    end:   lastFri,
    label: `${fmt(twoWeekMon)} → ${fmt(lastFri)}`
  };
}

function fmt(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function fmtDT(iso) {
  const d = new Date(iso);
  return `${fmt(d)} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} UTC`;
}

// ─── Data fetch with disk cache ──────────────────────────────────────────────

const CACHE_DIR = path.join(__dirname, '..', '.cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

function cacheKey(interval, outputsize) {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(CACHE_DIR, `xau_${interval}_${outputsize}_${today}.json`);
}

// Find the best cached file for an interval (largest outputsize available today)
function findBestCache(interval) {
  const today = new Date().toISOString().slice(0, 10);
  const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith(`xau_${interval}_`) && f.endsWith(`_${today}.json`));
  if (!files.length) return null;
  // Pick the one with the largest outputsize
  files.sort((a, b) => {
    const sizeA = parseInt(a.split('_')[2]) || 0;
    const sizeB = parseInt(b.split('_')[2]) || 0;
    return sizeB - sizeA;
  });
  return path.join(CACHE_DIR, files[0]);
}

async function fetchHistorical(interval, outputsize) {
  const file = cacheKey(interval, outputsize);
  if (fs.existsSync(file)) {
    process.stdout.write(chalk.gray(` (cached)\n`));
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  // Use any cached file for this interval today if API credits exhausted
  const bestCache = findBestCache(interval);
  if (bestCache) {
    process.stdout.write(chalk.yellow(` (using best available cache: ${path.basename(bestCache)})\n`));
    return JSON.parse(fs.readFileSync(bestCache, 'utf8'));
  }
  // Retry up to 4 times with exponential backoff for rate limits
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) {
      const delay = [30000, 60000, 90000][attempt - 1] || 90000;
      process.stdout.write(chalk.yellow(` (rate limited, retrying in ${delay/1000}s...)\n`));
      await new Promise(r => setTimeout(r, delay));
    }
    try {
      const r = await axios.get(`${BASE}/time_series`, {
        params: { symbol: SYMBOL, interval, outputsize, apikey: KEY, format: 'JSON', timezone: 'UTC' },
        timeout: 20000
      });
      if (r.data.status === 'error') throw new Error(`TwelveData: ${r.data.message}`);
      if (!r.data.values?.length) throw new Error('No data returned');
      const candles = r.data.values.reverse().map(c => ({
        time:   c.datetime,
        open:   parseFloat(c.open),
        high:   parseFloat(c.high),
        low:    parseFloat(c.low),
        close:  parseFloat(c.close),
        volume: parseFloat(c.volume || 0)
      }));
      fs.writeFileSync(file, JSON.stringify(candles));
      return candles;
    } catch (e) {
      if (e.response?.status === 429 || e.message.includes('429')) { lastErr = e; continue; }
      throw e;
    }
  }
  throw lastErr || new Error('Max retries exceeded');
}

// Filter candles to a date range (inclusive)
function inRange(candles, start, end) {
  return candles.filter(c => {
    const t = new Date(c.time);
    return t >= start && t <= end;
  });
}

// ─── Session helpers ─────────────────────────────────────────────────────────

function sessionLabel(iso) {
  const h = new Date(iso).getUTCHours();
  if (h >= 0  && h < 6)  return 'Asia';
  if (h >= 7  && h < 9)  return '🟡 London KZ';
  if (h >= 12 && h < 15) return '🟢 NY KZ';
  if (h >= 15 && h < 16) return 'London Close';
  return 'Off-hours';
}

function isKillZone(iso) {
  const h = new Date(iso).getUTCHours();
  return (h >= 7 && h < 9) || (h >= 12 && h < 15);
}

function asiaRange(h1Candles, date) {
  // Asia = 00:00–06:00 UTC on `date`
  const start = new Date(date); start.setUTCHours(0,0,0,0);
  const end   = new Date(date); end.setUTCHours(6,0,0,0);
  const asia  = h1Candles.filter(c => { const t = new Date(c.time); return t >= start && t < end; });
  if (!asia.length) return null;
  return {
    high: Math.max(...asia.map(c => c.high)),
    low:  Math.min(...asia.map(c => c.low))
  };
}

// ─── Rollup (build HTF candles from 5m) ─────────────────────────────────────

function rollup(src, factor) {
  const out = [];
  for (let i = 0; i < src.length; i += factor) {
    const s = src.slice(i, i + factor);
    if (!s.length) continue;
    out.push({
      time:   s[0].time,
      open:   s[0].open,
      high:   Math.max(...s.map(c => c.high)),
      low:    Math.min(...s.map(c => c.low)),
      close:  s[s.length-1].close,
      volume: s.reduce((a, c) => a + c.volume, 0)
    });
  }
  return out;
}

// ─── Outcome simulator ───────────────────────────────────────────────────────

function simulateOutcome(dir, entry, sl, tp1, tp2, futureCandles) {
  for (const c of futureCandles) {
    if (dir === 'bull') {
      if (c.low  <= sl)  return { result: 'LOSS',    pnlR: -1,   exitPrice: sl,  exitTime: c.time };
      if (c.high >= tp2) return { result: 'WIN_TP2', pnlR: parseFloat(((tp2-entry)/Math.abs(entry-sl)).toFixed(1)), exitPrice: tp2, exitTime: c.time };
      if (c.high >= tp1) return { result: 'WIN_TP1', pnlR: 1.5,  exitPrice: tp1, exitTime: c.time };
    } else {
      if (c.high >= sl)  return { result: 'LOSS',    pnlR: -1,   exitPrice: sl,  exitTime: c.time };
      if (c.low  <= tp2) return { result: 'WIN_TP2', pnlR: parseFloat(((entry-tp2)/Math.abs(entry-sl)).toFixed(1)), exitPrice: tp2, exitTime: c.time };
      if (c.low  <= tp1) return { result: 'WIN_TP1', pnlR: 1.5,  exitPrice: tp1, exitTime: c.time };
    }
  }
  return { result: 'OPEN', pnlR: null, exitPrice: null, exitTime: null };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  console.clear();
  console.log('\n' + chalk.bold.yellow('  ◆ XAUUSD ICT — LAST 2 WEEKS BACKTEST'));
  console.log(chalk.gray('  Fetching real historical data from TwelveData...\n'));

  const range = lastTwoWeeksRange();
  console.log(chalk.gray(`  Period: ${range.label}\n`));

  // Fetch enough history so HTF (daily/4H) has context before 2-week period starts
  // 5m: 10 days × 24h × 12 bars = 2880 bars + 500 warmup → use 3500
  // 15m: ~1000 bars
  // 1H:  ~300 bars
  // 4H:  ~120 bars
  // Daily: 40 bars
  const wait = ms => new Promise(r => setTimeout(r, ms));

  async function tryFetch(label, interval, size) {
    process.stdout.write(chalk.gray(`  Fetching ${label}...`));
    try {
      const d = await fetchHistorical(interval, size);
      if (!d.length) throw new Error('empty');
      return d;
    } catch (e) {
      process.stdout.write(chalk.yellow(` (skipped: ${e.message.slice(0,60)})\n`));
      return null;
    }
  }

  const all5m    = await tryFetch('5m candles (3500)', '5min', 3500);
  if (!all5m) { console.log(chalk.red('  Fatal: 5m data unavailable.')); return; }
  await wait(25000);
  const all15m   = await tryFetch('15m candles (1000)', '15min', 1000) || rollup(all5m, 3);
  await wait(5000);
  const allH1    = await tryFetch('1H candles (300)', '1h', 300)        || rollup(all5m, 12);
  await wait(5000);
  const allH4Raw = await tryFetch('4H candles (120)', '4h', 120);
  await wait(5000);
  const allH4    = allH4Raw || rollup(allH1, 4);
  const allDailyRaw = await tryFetch('Daily candles (40)', '1day', 40);
  const allDaily = allDailyRaw || rollup(allH1, 24);
  console.log(chalk.green('  ✓ Data assembled\n'));

  // Candles inside last week only (for iteration)
  const MIN_SCORE = 70;
  const week5m = inRange(all5m, range.start, range.end);
  console.log(chalk.gray(`  Period: ${range.label}  (2 weeks)  Min score: ${MIN_SCORE}%`));
  console.log(chalk.gray(`  5m candles in range: ${week5m.length}`));
  if (week5m.length === 0) {
    console.log(chalk.red('  No 5m candles found for last 2 weeks — market may have been closed or dates off.'));
    return;
  }

  const signals = [];      // raised: only Grade B+ setups
  const COOLDOWN_BARS = 36;  // 3-hour cooldown (36 × 5m) — one trade per session window
  let lastSignalBar = -999;

  const weekStart = range.start;

  // Roll through each 5m bar in last week
  for (let i = 30; i < week5m.length - 1; i++) {
    const currentBar = week5m[i];

    // Cooldown
    if (i - lastSignalBar < COOLDOWN_BARS) continue;

    // Build HTF slices: everything up to current bar
    const currentTime = new Date(currentBar.time);
    const slice5m  = all5m.filter(c => new Date(c.time) <= currentTime);
    const slice15m = all15m.filter(c => new Date(c.time) <= currentTime);
    const sliceH1  = allH1.filter(c => new Date(c.time) <= currentTime);

    if (slice5m.length < 40 || allH4.length < 6 || allDaily.length < 5) continue;

    const asia   = asiaRange(sliceH1, currentBar.time);
    const session = {
      active: isKillZone(currentBar.time),
      label:  sessionLabel(currentBar.time)
    };

    let htf, lvls, sweepResult, mss, fvg, ob, conf;
    try {
      htf  = htfBias(allDaily, allH4);
      lvls = keyLevels(allDaily, asia);
      const sweep5m  = detectLiquiditySweep(slice5m,  lvls, htf);
      const sweep15m = detectLiquiditySweep(slice15m, lvls, htf);
      sweepResult = sweep5m.mostRecent ? sweep5m : sweep15m;
      mss  = detectMSS(slice5m, sweepResult);
      fvg  = entryFVG(slice5m, mss, sweepResult);
      ob   = findOrderBlock(slice5m, sweepResult);
      conf = scoreConfluence(htf, sweepResult, mss, fvg, ob, session);
    } catch (e) {
      continue;
    }

    if (!mss.confirmed || !sweepResult.mostRecent || conf.score < MIN_SCORE) continue;

    const dir        = sweepResult.mostRecent.dir;
    const entryPrice = fvg?.optimalEntry || ob?.eq || currentBar.close;
    const buf        = entryPrice * 0.0008;
    const sl = dir === 'bull'
      ? (sweepResult.mostRecent.sweepLow  || entryPrice) - buf
      : (sweepResult.mostRecent.sweepHigh || entryPrice) + buf;
    const risk = Math.abs(entryPrice - sl);
    const tp1  = dir === 'bull' ? entryPrice + risk * 1.5 : entryPrice - risk * 1.5;
    // TP2: use PDH/PDL only if it's at least 2R away (meaningful target)
    const tp2  = dir === 'bull'
      ? (lvls.pdh && lvls.pdh > entryPrice + risk * 2 ? lvls.pdh : entryPrice + risk * 3)
      : (lvls.pdl && lvls.pdl < entryPrice - risk * 2 ? lvls.pdl : entryPrice - risk * 3);
    const tp3  = dir === 'bull'
      ? (lvls.pwh && lvls.pwh > entryPrice + risk * 3 ? lvls.pwh : entryPrice + risk * 5)
      : (lvls.pwl && lvls.pwl < entryPrice - risk * 3 ? lvls.pwl : entryPrice - risk * 5);

    // Simulate outcome over next 60 bars (5 hours)
    const future = week5m.slice(i + 1, i + 61);
    const outcome = simulateOutcome(dir, entryPrice, sl, tp1, tp2, future);

    signals.push({
      bar:       i,
      time:      currentBar.time,
      dir:       dir === 'bull' ? 'BUY' : 'SELL',
      entry:     parseFloat(entryPrice.toFixed(2)),
      sl:        parseFloat(sl.toFixed(2)),
      tp1:       parseFloat(tp1.toFixed(2)),
      tp2:       parseFloat(tp2.toFixed(2)),
      tp3:       parseFloat(tp3.toFixed(2)),
      risk:      parseFloat(risk.toFixed(2)),
      rr2:       parseFloat(((Math.abs(tp2 - entryPrice)) / risk).toFixed(1)),
      score:     conf.score,
      grade:     conf.grade,
      session:   session.label,
      htfBias:   htf.bias,
      sweep:     sweepResult.mostRecent.levelName,
      mssType:   mss.type,
      hasFVG:    !!fvg,
      hasOB:     !!ob,
      reasons:   conf.reasons,
      ...outcome
    });

    lastSignalBar = i;
  }

  // ─── Print report ───────────────────────────────────────────────────────────

  console.log('\n' + '═'.repeat(72));
  console.log(chalk.bold.yellow('  SIGNAL REPORT — XAUUSD — LAST 2 WEEKS'));
  console.log(chalk.gray(`  ${range.label}  |  Min confluence: ${MIN_SCORE}%`));
  console.log('═'.repeat(72));

  if (signals.length === 0) {
    console.log(chalk.yellow('\n  No signals fired last week matching the criteria.\n'));
    return;
  }

  signals.forEach((s, idx) => {
    const isLong = s.dir === 'BUY';
    const color  = isLong ? chalk.green : chalk.red;
    const arrow  = isLong ? '▲' : '▼';
    const outcomeColor = s.result?.startsWith('WIN') ? chalk.green : s.result === 'LOSS' ? chalk.red : chalk.yellow;

    console.log('\n' + chalk.bold(`  Signal #${idx + 1}`) + chalk.gray(` — ${fmtDT(s.time)}`));
    console.log('  ' + '─'.repeat(68));
    console.log(
      color(`  ${arrow} ${s.dir}`) +
      chalk.gray('  Score: ') + chalk.cyan(`${s.score}%`) +
      chalk.gray('  Grade: ') + chalk.cyan(s.grade) +
      chalk.gray('  Session: ') + chalk.white(s.session)
    );
    console.log(chalk.gray(`  HTF Bias: `) + chalk.white(s.htfBias.toUpperCase().replace(/_/g,' ')));
    console.log(chalk.gray(`  Sweep:    `) + chalk.white(s.sweep));
    console.log(chalk.gray(`  MSS:      `) + chalk.white(s.mssType) + (s.hasFVG ? chalk.green('  +FVG') : '') + (s.hasOB ? chalk.cyan('  +OB') : ''));

    console.log(chalk.gray('\n  ┌─ TRADE LEVELS ──────────────────────────────────────┐'));
    console.log(chalk.gray('  │  ENTRY      ') + chalk.bold.white(`$${s.entry}`));
    console.log(chalk.gray('  │  STOP LOSS  ') + chalk.red(`$${s.sl}`) + chalk.gray(`  (risk: ${s.risk} pts)`));
    console.log(chalk.gray('  │  TP1        ') + chalk.green(`$${s.tp1}`) + chalk.gray('  (1:1.5 R — partial close)'));
    console.log(chalk.gray('  │  TP2        ') + chalk.green(`$${s.tp2}`) + chalk.gray(`  (1:${s.rr2} R — full target)`));
    console.log(chalk.gray('  │  TP3        ') + chalk.green(`$${s.tp3}`) + chalk.gray('  (5R extension)'));

    if (s.result) {
      const pnlStr = s.pnlR != null
        ? (s.pnlR > 0 ? chalk.green(`+${s.pnlR}R`) : chalk.red(`${s.pnlR}R`))
        : chalk.yellow('(open)');
      console.log(chalk.gray('  │'));
      console.log(chalk.gray('  │  OUTCOME    ') + outcomeColor(s.result) + '  ' + pnlStr);
      if (s.exitTime) {
        console.log(chalk.gray('  │  Exit time  ') + chalk.gray(fmtDT(s.exitTime)) + chalk.gray(`  @ $${s.exitPrice}`));
      }
    }
    console.log(chalk.gray('  └────────────────────────────────────────────────────────┘'));

    console.log(chalk.gray('\n  Confluence breakdown:'));
    s.reasons.forEach(r => console.log('    ' + r));
  });

  // ─── Summary stats ──────────────────────────────────────────────────────────

  const closed = signals.filter(s => s.result !== 'OPEN');
  const wins   = closed.filter(s => s.pnlR > 0);
  const losses = closed.filter(s => s.pnlR < 0);
  const totalR = closed.reduce((sum, s) => sum + (s.pnlR || 0), 0);
  const wr     = closed.length ? ((wins.length / closed.length) * 100).toFixed(0) : 0;
  const pf     = losses.length
    ? (wins.reduce((s, x) => s + x.pnlR, 0) / Math.abs(losses.reduce((s, x) => s + x.pnlR, 0))).toFixed(2)
    : '∞';

  const byDay = {};
  signals.forEach(s => {
    const d = fmt(new Date(s.time));
    byDay[d] = byDay[d] || [];
    byDay[d].push(s);
  });

  console.log('\n\n' + '═'.repeat(72));
  console.log(chalk.bold.yellow('  2-WEEK SUMMARY'));
  console.log('═'.repeat(72));
  console.log(chalk.gray('  Total signals:    ') + chalk.white(signals.length));
  console.log(chalk.gray('  Closed trades:    ') + chalk.white(closed.length));
  console.log(chalk.gray('  Open (no exit):   ') + chalk.yellow(signals.length - closed.length));
  console.log(chalk.gray('  Wins:             ') + chalk.green(wins.length));
  console.log(chalk.gray('  Losses:           ') + chalk.red(losses.length));
  console.log(chalk.gray('  Win rate:         ') + (parseFloat(wr) >= 50 ? chalk.green : chalk.yellow)(`${wr}%`));
  console.log(chalk.gray('  Net P&L:          ') + (totalR >= 0 ? chalk.green(`+${totalR.toFixed(2)}R`) : chalk.red(`${totalR.toFixed(2)}R`)));
  console.log(chalk.gray('  Profit factor:    ') + chalk.cyan(pf));

  console.log(chalk.gray('\n  Signals by day:'));
  Object.entries(byDay).forEach(([day, sigs]) => {
    const dayWins = sigs.filter(s => s.pnlR > 0).length;
    const dayLoss = sigs.filter(s => s.pnlR < 0).length;
    const dayR    = sigs.reduce((sum, s) => sum + (s.pnlR || 0), 0);
    console.log(
      chalk.gray(`    ${day}  `) +
      chalk.white(`${sigs.length} signals`) +
      chalk.gray('  ') +
      chalk.green(`${dayWins}W`) + chalk.gray('/') + chalk.red(`${dayLoss}L`) +
      chalk.gray('  ') +
      (dayR >= 0 ? chalk.green(`+${dayR.toFixed(1)}R`) : chalk.red(`${dayR.toFixed(1)}R`))
    );
  });

  console.log(chalk.gray('\n  Breakdown by session:'));
  const bySess = {};
  signals.forEach(s => { bySess[s.session] = (bySess[s.session] || 0) + 1; });
  Object.entries(bySess).sort((a,b) => b[1]-a[1]).forEach(([sess, count]) => {
    console.log(chalk.gray(`    ${sess.padEnd(20)} ${count} signal${count>1?'s':''}`));
  });

  console.log(chalk.gray('\n  Direction split:'));
  const buys  = signals.filter(s => s.dir === 'BUY').length;
  const sells = signals.filter(s => s.dir === 'SELL').length;
  console.log(chalk.gray('    BUY:  ') + chalk.green(buys));
  console.log(chalk.gray('    SELL: ') + chalk.red(sells));

  // ─── Save JSON report ────────────────────────────────────────────────────────

  const reportPath = path.join(__dirname, '..', 'backtest_report_2weeks.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    period: range.label,
    generatedAt: new Date().toISOString(),
    signals: signals.map(s => ({ ...s, reasons: undefined })),
    stats: { total: signals.length, wins: wins.length, losses: losses.length, winRate: wr+'%', netR: totalR.toFixed(2), profitFactor: pf }
  }, null, 2));
  console.log(chalk.gray(`\n  JSON report saved → backtest_report_2weeks.json`));
  console.log('\n' + '═'.repeat(72) + '\n');
}

run().catch(err => {
  console.log(chalk.red(`\n  ✗ Fatal: ${err.message}\n`));
  process.exit(1);
});
