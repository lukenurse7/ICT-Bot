'use strict';

const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.TWELVEDATA_API_KEY;
const BASE_URL = 'https://api.twelvedata.com';

// DIA = Dow Jones ETF (free tier proxy for DJ30 on TwelveData)
const SYMBOL = 'DIA';

async function fetchCandles(interval, outputSize = 100) {
  if (!API_KEY || API_KEY === 'your_api_key_here') {
    throw new Error('No TwelveData API key set. Copy .env.example to .env and add your key from twelvedata.com');
  }

  try {
    const res = await axios.get(`${BASE_URL}/time_series`, {
      params: {
        symbol: SYMBOL,
        interval,
        outputsize: outputSize,
        apikey: API_KEY,
        format: 'JSON',
        timezone: 'UTC'
      },
      timeout: 10000
    });

    if (res.data.status === 'error') {
      throw new Error(`TwelveData error: ${res.data.message}`);
    }

    const raw = res.data.values;
    if (!raw || raw.length === 0) {
      throw new Error('No candle data returned');
    }

    // Normalise to { time, open, high, low, close }
    const candles = raw.reverse().map(c => ({
      time: c.datetime,
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      volume: parseFloat(c.volume || 0)
    }));

    return candles;
  } catch (err) {
    if (err.response) {
      throw new Error(`HTTP ${err.response.status}: ${JSON.stringify(err.response.data)}`);
    }
    throw err;
  }
}

async function fetchQuote() {
  if (!API_KEY || API_KEY === 'your_api_key_here') {
    throw new Error('No API key set');
  }

  const res = await axios.get(`${BASE_URL}/quote`, {
    params: { symbol: SYMBOL, apikey: API_KEY },
    timeout: 8000
  });

  if (res.data.status === 'error') throw new Error(res.data.message);

  return {
    price: parseFloat(res.data.close),
    change: parseFloat(res.data.change),
    changePct: parseFloat(res.data.percent_change),
    open: parseFloat(res.data.open),
    high: parseFloat(res.data.high),
    low: parseFloat(res.data.low),
    timestamp: res.data.datetime
  };
}

async function fetchAllData() {
  // Fetch 15m and 5m candles in parallel
  const [candles15m, candles5m, quote] = await Promise.all([
    fetchCandles('15min', 96),  // ~24h of 15m candles
    fetchCandles('5min', 120),  // ~10h of 5m candles
    fetchQuote()
  ]);

  return { candles15m, candles5m, quote };
}

module.exports = { fetchCandles, fetchQuote, fetchAllData, SYMBOL };
