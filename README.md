# DJ30 ICT Signal Bot

Real-time DJ30 signal generator for the NY Kill Zone (14:00–16:00 GMT).
Uses ICT methodology: MSS/BOS, Order Blocks, FVGs, Liquidity Pools.

---

## Setup

### 1. Get a free API key
Sign up at **https://twelvedata.com** — free tier gives 800 API calls/day (plenty).

### 2. Configure
```bash
cp .env.example .env
# Edit .env and paste your TwelveData API key
```

### 3. Install & run
```bash
npm install

# Terminal bot (clean CLI output)
npm start

# Web dashboard (browser UI at http://localhost:3000)
node src/dashboard.js
```

---

## How it works

**Data:** Pulls 15m and 5m DJ30 candles from TwelveData every 5 minutes during the Kill Zone.

**ICT Analysis:**
- `Market Structure` — Detects swing highs/lows, HH/HL for bullish bias, LH/LL for bearish. Identifies BOS/CHoCH.
- `Order Blocks` — Last bearish candle before a bullish 3-candle expansion (bull OB), vice versa for bear OB. Marks mitigated OBs.
- `Fair Value Gaps` — 3-candle imbalance pattern. Tracks filled vs unfilled.
- `Liquidity Pools` — Clusters equal highs (BSL) and equal lows (SSL) from last 50 candles.
- `Confluence Scoring` — Scores 0–100: HTF bias alignment (25pts), OB (20pts), MSS/BOS (20pts), FVG (15pts), Liquidity target (10pts), KZ (10pts). Only signals ≥50pts fire.

**Signal output:**
- Direction (LONG / SHORT)
- Entry (EQ of OB where possible)
- Stop loss (below OB low / above OB high)
- TP1 (1.5R) and TP2 (2.5R)
- R:R ratio
- Confluence tags (OB · FVG · MSS · LIQ · KZ)

**Scheduling:**
- Kill Zone active → scans every 5 minutes
- Outside KZ → scans every 15 minutes (structure monitoring only)
- 10-minute cooldown between signals to avoid duplicates

---

## Files

```
src/
  bot.js        — Terminal runner with chalk output
  dashboard.js  — Express + WebSocket web dashboard
  ict.js        — ICT analysis engine (MSS, OB, FVG, Liquidity)
  data.js       — TwelveData API fetcher
  killzone.js   — KZ time checker
```

---

## Notes

- DJ30 = `DJI` symbol on TwelveData free tier
- Free tier: 800 calls/day. Bot uses ~6 calls/scan (15m + 5m + quote × parallel). At 5min intervals in a 2hr KZ = ~24 scans = 72 calls. Fine.
- This is a signal tool, not an auto-trader. All execution is manual.
- Always use your own risk management — $300/session cap as per your FundingPips rules.
