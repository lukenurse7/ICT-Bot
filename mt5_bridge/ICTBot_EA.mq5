//+------------------------------------------------------------------+
//|  ICT Bot Signal EA                                               |
//|  Polls the Node.js signal server and auto-executes trades        |
//|  Attach to XAUUSD M5 chart on your demo account                 |
//+------------------------------------------------------------------+
#property copyright "ICT Bot"
#property version   "1.0"
#property strict

#include <Trade\Trade.mqh>

// ─── Inputs ──────────────────────────────────────────────────────────────────
input string   SignalURL    = "http://localhost:4000/signal/latest";
input string   ConfirmURL   = "http://localhost:4000/signal/executed";
input double   RiskPct      = 1.0;     // % of balance to risk per trade
input int      PollSeconds  = 30;      // how often to check for signals
input int      MagicNumber  = 202600;
input int      Slippage     = 20;

// ─── Globals ──────────────────────────────────────────────────────────────────
CTrade         Trade;
datetime       lastPoll     = 0;
string         lastSignalId = "";

//+------------------------------------------------------------------+
int OnInit()
{
   Trade.SetExpertMagicNumber(MagicNumber);
   Trade.SetDeviationInPoints(Slippage);
   Print("ICT Bot EA started. Polling: ", SignalURL);

   // MT5 requires WebRequest URL to be whitelisted:
   // Tools → Options → Expert Advisors → Allow WebRequest → add http://localhost:4000
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
void OnTick()
{
   if (TimeCurrent() - lastPoll < PollSeconds) return;
   lastPoll = TimeCurrent();

   PollSignal();
}

//+------------------------------------------------------------------+
void PollSignal()
{
   string headers = "Content-Type: application/json\r\n";
   char   post[], result[];
   string resultHeaders;

   int res = WebRequest("GET", SignalURL, headers, 5000, post, result, resultHeaders);
   if (res == -1)
   {
      Print("WebRequest failed. Error: ", GetLastError(),
            " — Add http://localhost:4000 to allowed URLs in Tools→Options→Expert Advisors");
      return;
   }

   string json = CharArrayToString(result);

   // Simple JSON field extraction (no external JSON lib needed)
   bool hasSignal = StringFind(json, "\"hasSignal\":true") >= 0;
   if (!hasSignal) return;

   // Extract fields
   string signalId  = ExtractField(json, "\"id\"");
   string direction = ExtractField(json, "\"direction\"");
   string symbol    = ExtractField(json, "\"symbol\"");
   double entry     = StringToDouble(ExtractField(json, "\"entry\""));
   double sl        = StringToDouble(ExtractField(json, "\"sl\""));
   double tp1       = StringToDouble(ExtractField(json, "\"tp1\""));
   double tp2       = StringToDouble(ExtractField(json, "\"tp2\""));
   string grade     = ExtractField(json, "\"grade\"");

   if (signalId == lastSignalId || signalId == "") return;  // already processed

   Print("Signal received: ", direction, " ", symbol,
         " @ ", entry, "  SL=", sl, "  TP1=", tp1, "  Grade=", grade);

   // Check no open position already on this symbol with our magic
   if (HasOpenPosition(symbol))
   {
      Print("Position already open on ", symbol, " — skipping");
      return;
   }

   double lots = CalcLots(symbol, entry, sl);
   bool   ok   = false;
   ulong  ticket = 0;
   double fillPrice = 0;

   if (direction == "BUY")
   {
      ok = Trade.Buy(lots, symbol, 0, sl, tp1,
                     StringFormat("ICT|%s|score=%s", grade, ExtractField(json, "\"confluence\"")));
   }
   else if (direction == "SELL")
   {
      ok = Trade.Sell(lots, symbol, 0, sl, tp1,
                      StringFormat("ICT|%s|score=%s", grade, ExtractField(json, "\"confluence\"")));
   }

   if (ok)
   {
      ticket    = Trade.ResultOrder();
      fillPrice = Trade.ResultPrice();
      Print("✓ Trade executed — Ticket: ", ticket, "  Price: ", fillPrice, "  Lots: ", lots);
      lastSignalId = signalId;
      ConfirmExecution(signalId, ticket, fillPrice);
   }
   else
   {
      Print("Order failed — retcode: ", Trade.ResultRetcode(),
            "  comment: ", Trade.ResultRetcodeDescription());
   }
}

//+------------------------------------------------------------------+
double CalcLots(string symbol, double entry, double sl)
{
   double balance    = AccountInfoDouble(ACCOUNT_BALANCE);
   double riskAmount = balance * (RiskPct / 100.0);
   double stopDist   = MathAbs(entry - sl);

   if (stopDist == 0) return 0.01;

   double tickSize  = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
   double tickValue = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE);
   double stopTicks = stopDist / tickSize;
   double lossPerLot = stopTicks * tickValue;

   if (lossPerLot == 0) return 0.01;

   double lots     = riskAmount / lossPerLot;
   double minLot   = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
   double maxLot   = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
   double stepLot  = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);

   lots = MathFloor(lots / stepLot) * stepLot;
   lots = MathMax(minLot, MathMin(maxLot, lots));

   Print("Lot calc: balance=", balance, "  risk=", riskAmount,
         "  stopPts=", stopDist, "  loss/lot=", lossPerLot, "  lots=", lots);
   return lots;
}

//+------------------------------------------------------------------+
bool HasOpenPosition(string symbol)
{
   for (int i = PositionsTotal() - 1; i >= 0; i--)
   {
      if (PositionGetSymbol(i) == symbol &&
          PositionGetInteger(POSITION_MAGIC) == MagicNumber)
         return true;
   }
   return false;
}

//+------------------------------------------------------------------+
void ConfirmExecution(string signalId, ulong ticket, double price)
{
   string body = StringFormat(
      "{\"id\":\"%s\",\"ticket\":%d,\"price\":%.2f}",
      signalId, ticket, price
   );

   char   postData[], result[];
   StringToCharArray(body, postData, 0, StringLen(body));
   string headers = "Content-Type: application/json\r\n";
   string resultHeaders;

   WebRequest("POST", ConfirmURL, headers, 5000, postData, result, resultHeaders);
}

//+------------------------------------------------------------------+
// Simple JSON string field extractor — finds "key":"value" pattern
string ExtractField(string json, string key)
{
   int pos = StringFind(json, key);
   if (pos < 0) return "";
   pos += StringLen(key) + 1;  // skip key + colon

   // Quoted string value
   if (StringGetCharacter(json, pos) == '"')
   {
      pos++;
      int end = StringFind(json, "\"", pos);
      if (end < 0) return "";
      return StringSubstr(json, pos, end - pos);
   }
   // Numeric value
   int end = pos;
   while (end < StringLen(json))
   {
      ushort c = StringGetCharacter(json, end);
      if (c == ',' || c == '}' || c == ' ') break;
      end++;
   }
   return StringSubstr(json, pos, end - pos);
}
