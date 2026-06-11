'use strict';

// ═══════════════════════════════════════════════════════════════════════════
//  Fetch 1-year historical data for both markets
//  NAS100: Yahoo Finance QQQ 1h (pre-market, full year)
//          TwelveData QQQ 1m (regular hours, monthly chunks)
//  XAUUSD: TwelveData XAU/USD 5m/15m/1h (monthly chunks, 13 months)
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const axios = require('axios');
const chalk = require('chalk');
const fs    = require('fs');
const path  = require('path');

const KEY      = process.env.TWELVEDATA_API_KEY;
const CACHE    = path.join(__dirname, '..', '.cache');
if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE);

const wait = ms => new Promise(r => setTimeout(r, ms));

function fmt(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

// ─── TwelveData chunk fetcher ─────────────────────────────────────────────
async function fetchTD(symbol, interval, startStr, endStr, label) {
  const cacheFile = path.join(CACHE, `${label}.json`);
  if (fs.existsSync(cacheFile)) {
    process.stdout.write(chalk.gray(` (cached)\n`));
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      const delay = [30000, 60000, 90000, 120000][attempt-1] || 120000;
      process.stdout.write(chalk.yellow(` retry in ${delay/1000}s...\n`));
      await wait(delay);
    }
    try {
      const r = await axios.get('https://api.twelvedata.com/time_series', {
        params: { symbol, interval, outputsize: 5000,
                  start_date: `${startStr} 00:00:00`,
                  end_date:   `${endStr} 23:59:59`,
                  apikey: KEY },
        timeout: 30000
      });
      if (r.data.status === 'error') throw new Error(r.data.message);
      const values = (r.data.values || []).map(v => ({
        time:  v.datetime,
        open:  parseFloat(v.open),
        high:  parseFloat(v.high),
        low:   parseFloat(v.low),
        close: parseFloat(v.close),
      })).reverse();
      fs.writeFileSync(cacheFile, JSON.stringify(values));
      process.stdout.write(chalk.green(` ✓ ${values.length} bars\n`));
      return values;
    } catch (e) { lastErr = e; }
  }
  process.stdout.write(chalk.red(` ✗ ${lastErr.message.slice(0,60)}\n`));
  return [];
}

// ─── Yahoo Finance 1h full-year fetcher ──────────────────────────────────
async function fetchYahoo1h(symbol, label) {
  const cacheFile = path.join(CACHE, `${label}.json`);
  if (fs.existsSync(cacheFile)) {
    const d = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    process.stdout.write(chalk.gray(` (cached — ${d.length} bars)\n`));
    return d;
  }
  try {
    const r = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}`, {
      params: { interval: '1h', range: '1y', includePrePost: true },
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 30000
    });
    const res = r.data?.chart?.result?.[0];
    if (!res) throw new Error('no data');
    const ts = res.timestamp;
    const q  = res.indicators.quote[0];
    const bars = ts.map((t, i) => ({
      time:  new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' '),
      open:  q.open[i],  high: q.high[i],
      low:   q.low[i],   close: q.close[i],
    })).filter(b => b.open != null);
    fs.writeFileSync(cacheFile, JSON.stringify(bars));
    process.stdout.write(chalk.green(` ✓ ${bars.length} bars (${bars[0].time} → ${bars[bars.length-1].time})\n`));
    return bars;
  } catch (e) {
    process.stdout.write(chalk.red(` ✗ ${e.message}\n`));
    return [];
  }
}

// ─── TwelveData QQQ 1m monthly chunks (EDT→UTC +4h) ─────────────────────
async function fetchQQQ1mChunk(startStr, endStr) {
  const label = `qqq_1m_${startStr}_${endStr}`;
  const cacheFile = path.join(CACHE, `${label}.json`);
  if (fs.existsSync(cacheFile)) {
    process.stdout.write(chalk.gray(` (cached)\n`));
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      const delay = [30000, 60000, 90000, 120000][attempt-1] || 120000;
      process.stdout.write(chalk.yellow(` retry in ${delay/1000}s...\n`));
      await wait(delay);
    }
    try {
      const r = await axios.get('https://api.twelvedata.com/time_series', {
        params: { symbol: 'QQQ', interval: '1min', outputsize: 5000,
                  start_date: `${startStr} 00:00:00`,
                  end_date:   `${endStr} 23:59:59`,
                  apikey: KEY },
        timeout: 30000
      });
      if (r.data.status === 'error') throw new Error(r.data.message);
      const values = (r.data.values || []).map(v => {
        // TwelveData returns EDT (UTC-4) — parse as UTC then add 4h
        // datetime format: "YYYY-MM-DD HH:MM:SS" (always has seconds)
        const [datePart, timePart] = v.datetime.split(' ');
        const dt = new Date(`${datePart}T${timePart}Z`);
        dt.setUTCHours(dt.getUTCHours() + 4);
        return {
          time:  dt.toISOString().slice(0, 16).replace('T', ' '),
          open:  parseFloat(v.open),  high: parseFloat(v.high),
          low:   parseFloat(v.low),   close: parseFloat(v.close),
        };
      }).reverse();
      fs.writeFileSync(cacheFile, JSON.stringify(values));
      process.stdout.write(chalk.green(` ✓ ${values.length} bars\n`));
      return values;
    } catch (e) { lastErr = e; }
  }
  process.stdout.write(chalk.red(` ✗ ${lastErr.message.slice(0,60)}\n`));
  return [];
}

async function run() {
  console.log('\n' + '═'.repeat(60));
  console.log(chalk.bold.cyan('  Fetching 1-year data — NAS100 + XAUUSD'));
  console.log('═'.repeat(60) + '\n');

  // Date range: June 2025 → June 2026
  const START_YEAR = '2025-06-01';
  const END_YEAR   = '2026-06-10';

  // Monthly chunk boundaries June 2025 → July 2026 (13 chunks)
  const chunks = [];
  for (let y = 2025, m = 6; !(y === 2026 && m === 7); ) {
    const start = new Date(Date.UTC(y, m - 1, 1));
    const next  = new Date(Date.UTC(y, m, 1));
    chunks.push({ start: fmt(start), end: fmt(next) });
    m++; if (m > 12) { m = 1; y++; }
  }

  // ── QQQ 1h (Yahoo, full year, pre-market) ──────────────────────────────
  console.log(chalk.bold('  QQQ 1h (Yahoo, pre-market, full year)'));
  process.stdout.write('  fetching...');
  const qqq1h = await fetchYahoo1h('QQQ', 'yahoo_qqq_1h_1yr');

  // ── QQQ 1m (TwelveData, monthly chunks) ───────────────────────────────
  console.log(chalk.bold('\n  QQQ 1m (TwelveData, monthly chunks — EDT→UTC)'));
  const qqq1mAll = [];
  for (const { start, end } of chunks) {
    process.stdout.write(chalk.gray(`  1m ${start}...`));
    const chunk = await fetchQQQ1mChunk(start, end);
    qqq1mAll.push(...chunk);
    await wait(10000);
  }
  // Deduplicate + sort
  const seen1m = new Set();
  const qqq1m = qqq1mAll
    .filter(c => { if (seen1m.has(c.time)) return false; seen1m.add(c.time); return true; })
    .sort((a, b) => a.time.localeCompare(b.time));

  // Save merged 1m cache
  const merged1mFile = path.join(CACHE, 'qqq_1m_1yr.json');
  fs.writeFileSync(merged1mFile, JSON.stringify(qqq1m));
  console.log(chalk.green(`\n  ✓ QQQ 1m total: ${qqq1m.length} bars saved → .cache/qqq_1m_1yr.json`));
  if (qqq1m.length) console.log(chalk.gray(`    ${qqq1m[0].time} → ${qqq1m[qqq1m.length-1].time}`));

  // ── XAUUSD 5m (TwelveData, monthly chunks) ────────────────────────────
  console.log(chalk.bold('\n  XAU/USD 5m (TwelveData, monthly chunks)'));
  const xau5mAll = [];
  for (const { start, end } of chunks) {
    process.stdout.write(chalk.gray(`  5m ${start}...`));
    const chunk = await fetchTD('XAU/USD', '5min', start, end, `xau1yr_5min_${start}_${end}`);
    xau5mAll.push(...chunk);
    await wait(10000);
  }
  const seen5m = new Set();
  const xau5m = xau5mAll
    .filter(c => { if (seen5m.has(c.time)) return false; seen5m.add(c.time); return true; })
    .sort((a, b) => a.time.localeCompare(b.time));
  const xau5mFile = path.join(CACHE, 'xau_5m_1yr.json');
  fs.writeFileSync(xau5mFile, JSON.stringify(xau5m));
  console.log(chalk.green(`\n  ✓ XAU 5m total: ${xau5m.length} bars saved → .cache/xau_5m_1yr.json`));
  if (xau5m.length) console.log(chalk.gray(`    ${xau5m[0].time} → ${xau5m[xau5m.length-1].time}`));

  // ── XAUUSD 15m ────────────────────────────────────────────────────────
  console.log(chalk.bold('\n  XAU/USD 15m (TwelveData, monthly chunks)'));
  const xau15mAll = [];
  for (const { start, end } of chunks) {
    process.stdout.write(chalk.gray(`  15m ${start}...`));
    const chunk = await fetchTD('XAU/USD', '15min', start, end, `xau1yr_15min_${start}_${end}`);
    xau15mAll.push(...chunk);
    await wait(10000);
  }
  const seen15m = new Set();
  const xau15m = xau15mAll
    .filter(c => { if (seen15m.has(c.time)) return false; seen15m.add(c.time); return true; })
    .sort((a, b) => a.time.localeCompare(b.time));
  fs.writeFileSync(path.join(CACHE, 'xau_15m_1yr.json'), JSON.stringify(xau15m));
  console.log(chalk.green(`\n  ✓ XAU 15m total: ${xau15m.length} bars saved`));

  // ── XAUUSD 1h ─────────────────────────────────────────────────────────
  console.log(chalk.bold('\n  XAU/USD 1h (TwelveData, monthly chunks)'));
  const xau1hAll = [];
  for (const { start, end } of chunks) {
    process.stdout.write(chalk.gray(`  1h ${start}...`));
    const chunk = await fetchTD('XAU/USD', '1h', start, end, `xau1yr_1h_${start}_${end}`);
    xau1hAll.push(...chunk);
    await wait(10000);
  }
  const seen1h = new Set();
  const xau1h = xau1hAll
    .filter(c => { if (seen1h.has(c.time)) return false; seen1h.add(c.time); return true; })
    .sort((a, b) => a.time.localeCompare(b.time));
  fs.writeFileSync(path.join(CACHE, 'xau_1h_1yr.json'), JSON.stringify(xau1h));
  console.log(chalk.green(`\n  ✓ XAU 1h total: ${xau1h.length} bars saved`));

  console.log('\n' + '═'.repeat(60));
  console.log(chalk.bold.green('  All data fetched and cached.'));
  console.log(chalk.gray('  Run backtest_nas100_1yr.js and backtest_xau_1yr.js next.'));
  console.log('═'.repeat(60) + '\n');
}

run().catch(e => { console.error(chalk.red(`\n  ✗ ${e.message}\n`)); process.exit(1); });
