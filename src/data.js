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

  const res = await axios.get(`${BASE_URL}/time_series`, {
    params: {
      symbol: SYMBOL, interval, outputsize: outputSize,
      apikey: API_KEY, format: 'JSON', timezone: 'UTC'
    },
    timeout: 12000
  });

  if (res.data.status === 'error') throw new Error(`TwelveData error: ${res.data.message}`);
  const raw = res.data.values;
  if (!raw || raw.length === 0) throw new Error('No candle data returned');

  return raw.reverse().map(c => ({
    time: c.datetime, open: parseFloat(c.open), high: parseFloat(c.high),
    low: parseFloat(c.low), close: parseFloat(c.close), volume: parseFloat(c.volume || 0)
  }));
}

async function fetchQuote() {
  if (!API_KEY || API_KEY === 'your_api_key_here') throw new Error('No API key set');
  const res = await axios.get(`${BASE_URL}/quote`, {
    params: { symbol: SYMBOL, apikey: API_KEY }, timeout: 8000
  });
  if (res.data.status === 'error') throw new Error(res.data.message);
  return {
    price: parseFloat(res.data.close), change: parseFloat(res.data.change),
    changePct: parseFloat(res.data.percent_change), open: parseFloat(res.data.open),
    high: parseFloat(res.data.high), low: parseFloat(res.data.low), timestamp: res.data.datetime
  };
}

async function fetchAllData() {
  const [daily, h4, h1, candles15m, candles5m, quote] = await Promise.all([
    fetchCandles('1day',  30),   // HTF bias — daily structure
    fetchCandles('4h',    48),   // HTF bias — 4H structure
    fetchCandles('1h',    48),   // 1H swing lows/highs for TP targets
    fetchCandles('15min', 96),   // liquidity sweep detection
    fetchCandles('5min',  120),  // MSS + FVG entry
    fetchQuote()
  ]);
  return { daily, h4, h1, candles15m, candles5m, quote };
}

module.exports = { fetchCandles, fetchQuote, fetchAllData, SYMBOL };
