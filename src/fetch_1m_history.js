'use strict';

// Fetches a full year of DIA 1m bars from TwelveData and caches month-by-month.
// Run: node src/fetch_1m_history.js
// Uses start_date / end_date params so each request covers one calendar month.
// Waits 8s between requests to stay within free-tier rate limits (8 req/min).

require('dotenv').config();
const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const chalk  = require('chalk');

const API_KEY  = process.env.TWELVEDATA_API_KEY;
const BASE_URL = 'https://api.twelvedata.com';
const SYMBOL   = 'DIA';
const CACHE    = path.join(__dirname, '..', '.cache');

// 2-week chunks to stay within TwelveData's 5000-bar limit per request.
// Each month = 2 chunks: day 1-15, day 16-end.
const CHUNKS = [
  ['2025-06-01','2025-06-15'],['2025-06-16','2025-06-30'],
  ['2025-07-01','2025-07-15'],['2025-07-16','2025-07-31'],
  ['2025-08-01','2025-08-15'],['2025-08-16','2025-08-31'],
  ['2025-09-01','2025-09-15'],['2025-09-16','2025-09-30'],
  ['2025-10-01','2025-10-15'],['2025-10-16','2025-10-31'],
  ['2025-11-01','2025-11-15'],['2025-11-16','2025-11-30'],
  ['2025-12-01','2025-12-15'],['2025-12-16','2025-12-31'],
  ['2026-01-01','2026-01-15'],['2026-01-16','2026-01-31'],
  ['2026-02-01','2026-02-15'],['2026-02-16','2026-02-28'],
  ['2026-03-01','2026-03-15'],['2026-03-16','2026-03-31'],
  ['2026-04-01','2026-04-15'],['2026-04-16','2026-04-30'],
  ['2026-05-01','2026-05-15'],['2026-05-16','2026-05-31'],
  ['2026-06-01','2026-06-15'],['2026-06-16','2026-06-25'],
];

function fmt(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchChunk(startStr, endStr) {
  const label     = `dj30_1min_${startStr}_${endStr}`;
  const cacheFile = path.join(CACHE, `${label}.json`);

  if (fs.existsSync(cacheFile)) {
    const existing = JSON.parse(fs.readFileSync(cacheFile));
    console.log(chalk.gray(`  [skip] ${label}: ${existing.length} bars`));
    return existing.length;
  }

  console.log(chalk.gray(`  Fetching ${label}...`));

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await axios.get(`${BASE_URL}/time_series`, {
        params: {
          symbol:     SYMBOL,
          interval:   '1min',
          outputsize: 5000,
          start_date: `${startStr} 13:00:00`,
          end_date:   `${endStr} 20:30:00`,
          apikey:     API_KEY,
          format:     'JSON',
          timezone:   'UTC'
        },
        timeout: 30000
      });

      if (res.data.status === 'error') {
        console.log(chalk.yellow(`    API error: ${res.data.message}`));
        if (res.data.message?.includes('quota') || res.data.message?.includes('limit')) {
          console.log(chalk.yellow('    Rate limited — waiting 60s...'));
          await wait(60000);
          continue;
        }
        return 0;
      }

      const raw = res.data.values;
      if (!raw || !raw.length) {
        console.log(chalk.yellow(`    No data returned (market may not trade this month)`));
        fs.writeFileSync(cacheFile, JSON.stringify([]));
        return 0;
      }

      // Store unscaled (raw DIA prices) — backtest applies PRICE_SCALE
      const candles = raw.reverse().map(c => ({
        time:   c.datetime,
        open:   parseFloat(c.open),
        high:   parseFloat(c.high),
        low:    parseFloat(c.low),
        close:  parseFloat(c.close),
        volume: parseFloat(c.volume || 0)
      }));

      fs.writeFileSync(cacheFile, JSON.stringify(candles));
      console.log(chalk.green(`    ✓ ${candles.length} bars → ${label}.json`));
      return candles.length;

    } catch (e) {
      if (e.response?.status === 429) {
        console.log(chalk.yellow(`    429 rate limit — waiting ${attempt * 30}s...`));
        await wait(attempt * 30000);
        continue;
      }
      console.log(chalk.red(`    Error: ${e.message}`));
      return 0;
    }
  }
  return 0;
}

// Legacy: kept for compatibility but replaced by chunk-based approach
async function fetchMonth(year, month0) {
  const startDate = new Date(Date.UTC(year, month0, 1));
  const endDate   = new Date(Date.UTC(year, month0 + 1, 1));
  return fetchChunk(fmt(startDate), fmt(new Date(endDate.getTime() - 86400000)));
}

async function run() {
  if (!API_KEY || API_KEY === 'your_api_key_here') {
    console.log(chalk.red('No TwelveData API key set in .env'));
    process.exit(1);
  }

  console.log(chalk.bold('\n  ■ Fetching DIA 1m history (Jun 2025 → Jun 2026)'));
  console.log(chalk.gray(`  Symbol: ${SYMBOL} | Chunks: ${CHUNKS.length} | ~8s between requests\n`));

  let total = 0;
  for (const [start, end] of CHUNKS) {
    const bars = await fetchChunk(start, end);
    total += bars;
    if (bars > 0) await wait(8000); // respect rate limits (8 req/min free tier)
  }

  console.log(chalk.bold(`\n  Done. Total 1m bars cached: ${total.toLocaleString()}`));
  console.log(chalk.gray('  Now run: node src/backtest_1m_dj30.js\n'));
}

run().catch(e => { console.error(e); process.exit(1); });
