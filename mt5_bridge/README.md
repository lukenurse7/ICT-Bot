# MT5 Auto-Execution Bridge

Two options — pick whichever suits you:

---

## Option A — Python Bridge (Recommended)

Runs alongside MT5 on your Windows machine.

### Setup

1. **Install Python deps**
   ```
   pip install MetaTrader5 requests
   ```

2. **Edit `mt5_bridge.py`** — fill in your demo account details:
   ```python
   MT5_LOGIN    = 12345678          # your demo account number
   MT5_PASSWORD = "your_password"
   MT5_SERVER   = "ICMarkets-Demo"  # your broker's MT5 server name
   BOT_URL      = "http://localhost:4000"  # or your cloud server IP
   ```

3. **Open MetaTrader 5** and log into your demo account

4. **Run the bridge**
   ```
   python mt5_bridge.py
   ```

The bridge polls `/signal/latest` every 30s. When a signal fires it:
- Calculates lot size (1% account risk by default)
- Places a market order with SL + TP1
- Confirms execution back to the bot server

---

## Option B — Pure MQL5 Expert Advisor

No Python needed — runs entirely inside MT5.

### Setup

1. **Copy `ICTBot_EA.mq5`** to:
   ```
   C:\Users\<you>\AppData\Roaming\MetaQuotes\Terminal\<id>\MQL5\Experts\
   ```

2. **Compile** in MetaEditor (F7)

3. **Allow WebRequest** in MT5:
   - Tools → Options → Expert Advisors
   - ✅ Allow WebRequest for listed URL
   - Add: `http://localhost:4000`

4. **Attach to XAUUSD M5 chart** — enable "Allow automated trading"

5. Set inputs:
   - `SignalURL` = `http://localhost:4000/signal/latest`
   - `RiskPct`   = `1.0` (1% per trade)
   - `PollSeconds` = `30`

---

## Symbol names

If your broker uses a different symbol name for gold, edit `SYMBOL_MAP` in `mt5_bridge.py`:
```python
SYMBOL_MAP = {
    "XAUUSD": "XAUUSD",   # some brokers use "GOLD" or "XAUUSDm"
    "DJ30":   "US30",      # some use "DJIA" or "DJ30"
}
```
Or change `SignalURL` symbol in the EA inputs.

---

## Risk warning

This executes **real trades** (even on demo). Test thoroughly before switching to a live account.
