'use strict';

const axios = require('axios');
require('dotenv').config();

const API_KEY = process.env.TWELVEDATA_API_KEY;
const BASE_URL = 'https://api.twelvedata.com';

// DIA = Dow Jones ETF (proxy for DJ30 — TwelveData has no real DJIA index even on paid plans)
// DIA doesn't track DJ30 at an exact 1/100 ratio (dividend drag, NAV decay) —
// PRICE_SCALE is calibrated against the real DJ30 price and can be overridden via env var.
const SYMBOL = 'DIA';
const PRICE_SCALE = parseFloat(process.env.DJ30_PRICE_SCALE) || 99.7724;

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
    time:   c.datetime,
    open:   parseFloat(c.open)   * PRICE_SCALE,
    high:   parseFloat(c.high)   * PRICE_SCALE,
    low:    parseFloat(c.low)    * PRICE_SCALE,
    close:  parseFloat(c.close)  * PRICE_SCALE,
    volume: parseFloat(c.volume || 0)
  }));
}

async function fetchQuote() {
  if (!API_KEY || API_KEY === 'your_api_key_here') throw new Error('No API key set');
  const res = await axios.get(`${BASE_URL}/quote`, {
    params: { symbol: SYMBOL, apikey: API_KEY }, timeout: 8000
  });
  if (res.data.status === 'error') throw new Error(res.data.message);
  return {
    price:     parseFloat(res.data.close)           * PRICE_SCALE,
    change:    parseFloat(res.data.change)           * PRICE_SCALE,
    changePct: parseFloat(res.data.percent_change),
    open:      parseFloat(res.data.open)             * PRICE_SCALE,
    high:      parseFloat(res.data.high)             * PRICE_SCALE,
    low:       parseFloat(res.data.low)              * PRICE_SCALE,
    timestamp: res.data.datetime
  };
}

async function fetchAllData() {
  const [daily, h4, h1, candles15m, candles5m, candles1m, quote] = await Promise.all([
    fetchCandles('1day',  30),   // HTF bias — daily structure
    fetchCandles('4h',    48),   // HTF bias — 4H structure
    fetchCandles('1h',    48),   // 1H swing lows/highs for TP targets
    fetchCandles('15min', 96),   // liquidity sweep detection
    fetchCandles('5min',  120),  // MSS + FVG zone detection
    fetchCandles('1min',  250),  // 1m candles for MSS + FVG + limit fill detection (~4 hours coverage)
    fetchQuote()
  ]);
  return { daily, h4, h1, candles15m, candles5m, candles1m, quote };
}

module.exports = { fetchCandles, fetchQuote, fetchAllData, SYMBOL };
