/**
 * kalshi-markets - full single-file backend + dashboard.
 *
 * Everything in one file on purpose: updates are a single copy-paste on
 * GitHub's website, never a folder upload again.
 *
 * HONEST LIMITS OF THE FREE STACK (read this before trusting any signal):
 * - Render's free tier has no database and resets on every sleep/restart,
 *   so trade history lives in YOUR BROWSER (localStorage), not the server.
 *   It won't follow you across devices and clears if you clear Safari data.
 * - Candle data comes from Coinbase's public Exchange API (free, real
 *   OHLCV, no key). HYPE isn't listed on Coinbase, so it gets price only,
 *   no candle pattern / volume pressure detection for that one market.
 * - DOGE/SOL/ETH/HYPE trading rules are still "candidate" status - not
 *   backtested against real settled data yet. Only BTC is validated.
 */

const express = require("express");
const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: "10mb" }));

const KALSHI_BASE = "https://external-api.kalshi.com/trade-api/v2";
const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const COINBASE_BASE = "https://api.exchange.coinbase.com";

// ---------- MARKET CONFIG ----------
const MARKETS = {
  BTC: { label: "Bitcoin 15m", kalshiSeries: "KXBTC15M", coingeckoId: "bitcoin", coinbaseProduct: "BTC-USD", tvSymbol: "COINBASE:BTCUSD", gapMin: 8, winProbRange: [0.55, 0.65], payoutMin: 1.2, status: "validated" },
  DOGE: { label: "Dogecoin 15m", kalshiSeries: "KXDOGE15M", coingeckoId: "dogecoin", coinbaseProduct: "DOGE-USD", tvSymbol: "COINBASE:DOGEUSD", gapMin: null, winProbRange: [0.55, 0.65], payoutMin: 1.2, status: "candidate" },
  SOL: { label: "Solana 15m", kalshiSeries: "KXSOL15M", coingeckoId: "solana", coinbaseProduct: "SOL-USD", tvSymbol: "COINBASE:SOLUSD", gapMin: null, winProbRange: [0.55, 0.65], payoutMin: 1.2, status: "candidate" },
  ETH: { label: "Ethereum 15m", kalshiSeries: "KXETH15M", coingeckoId: "ethereum", coinbaseProduct: "ETH-USD", tvSymbol: "COINBASE:ETHUSD", gapMin: null, winProbRange: [0.55, 0.65], payoutMin: 1.2, status: "candidate" },
  HYPE: { label: "Hyperliquid 15m", kalshiSeries: "KXHYPE15M", coingeckoId: "hyperliquid", coinbaseProduct: null, tvSymbol: "BYBIT:HYPEUSDT", gapMin: null, winProbRange: [0.55, 0.65], payoutMin: 1.2, status: "candidate" },
};
function isLiveEligible(symbol) { return MARKETS[symbol]?.status === "validated"; }

const SPORTS = {
  MLB: { label: "MLB Game Winner", category: "Baseball", status: "candidate" },
  ATP: { label: "ATP Match Winner", category: "Tennis", status: "candidate" },
  WTA: { label: "WTA Match Winner", category: "Tennis", status: "candidate" },
};
const SPORTS_SERIES = { MLB: "KXMLBGAME", ATP: "KXATPMATCH", WTA: "KXWTAMATCH" }; // unconfirmed tickers - dashboard shows an honest error if wrong

// ---------- SCANNER (gap / probability / payout rules) ----------
function evaluateEntry({ symbol, spotPrice, strike, impliedProb, payout }) {
  const cfg = MARKETS[symbol];
  if (!cfg) return { signal: "STAND_ASIDE", reasons: [`Unknown market: ${symbol}`] };
  if (cfg.gapMin === null) {
    return { signal: "PAPER_ONLY", reasons: [`${cfg.label} has no validated rule set yet - needs a real backtest first.`], mode: "paper-only" };
  }
  const gap = Math.abs(spotPrice - strike);
  const reasons = [];
  let pass = true;
  if (gap < cfg.gapMin) { pass = false; reasons.push(`Gap $${gap.toFixed(2)} below $${cfg.gapMin} minimum.`); }
  const [loP, hiP] = cfg.winProbRange;
  if (impliedProb < loP || impliedProb > hiP) { pass = false; reasons.push(`Win prob ${(impliedProb * 100).toFixed(1)}% outside ${(loP*100).toFixed(0)}-${(hiP*100).toFixed(0)}% window.`); }
  if (payout < cfg.payoutMin) { pass = false; reasons.push(`Payout ${payout.toFixed(2)}x below ${cfg.payoutMin}x minimum.`); }
  if (!pass) return { signal: "HOLD", reasons, mode: isLiveEligible(symbol) ? "live" : "paper-only" };
  return { signal: spotPrice > strike ? "BUY_YES" : "BUY_NO", reasons: ["All entry conditions met."], mode: isLiveEligible(symbol) ? "live" : "paper-only" };
}

// ---------- CANDLE PATTERNS + VOLUME PRESSURE (real data, Coinbase) ----------
async function fetchCandles(productId, granularitySeconds = 900, limit = 30) {
  const url = `${COINBASE_BASE}/products/${productId}/candles?granularity=${granularitySeconds}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Coinbase candles ${res.status}`);
  const raw = await res.json(); // [time, low, high, open, close, volume], newest first
  const candles = raw
    .slice(0, limit)
    .map(([time, low, high, open, close, volume]) => ({ time, low, high, open, close, volume }))
    .reverse(); // chronological order
  return candles;
}

function detectBullishEngulfing(candles) {
  if (candles.length < 2) return { pattern: "insufficient_data" };
  const prev = candles[candles.length - 2];
  const curr = candles[candles.length - 1];
  const prevBearish = prev.close < prev.open;
  const currBullish = curr.close > curr.open;
  const engulfs = curr.open <= prev.close && curr.close >= prev.open;
  if (prevBearish && currBullish && engulfs) {
    return { pattern: "bullish_engulfing", note: "Prior red candle fully engulfed by a green candle - classic reversal signal, stronger with volume confirmation." };
  }
  const prevBullish = prev.close > prev.open;
  const currBearish = curr.close < curr.open;
  const engulfsBear = curr.open >= prev.close && curr.close <= prev.open;
  if (prevBullish && currBearish && engulfsBear) {
    return { pattern: "bearish_engulfing", note: "Prior green candle fully engulfed by a red candle - bearish reversal signal." };
  }
  return { pattern: "none" };
}

function detectVolumePressure(candles, lookback = 10) {
  if (candles.length < lookback + 1) return { pressure: "insufficient_data" };
  const recent = candles.slice(-lookback - 1, -1);
  const avgVolume = recent.reduce((s, c) => s + c.volume, 0) / recent.length;
  const latest = candles[candles.length - 1];
  const ratio = avgVolume > 0 ? latest.volume / avgVolume : 1;
  const direction = latest.close > latest.open ? "buying" : "selling";
  if (ratio >= 1.5) return { pressure: `heavy_${direction}`, ratio: Number(ratio.toFixed(2)) };
  if (ratio <= 0.5) return { pressure: "quiet", ratio: Number(ratio.toFixed(2)) };
  return { pressure: "normal", ratio: Number(ratio.toFixed(2)) };
}

// Combines the gap/prob/payout scanner with candle confirmation into a
// final tradable-or-sit-out call, and flags the specific 10-20% payout
// "sweet spot" band requested.
function classifyTradability(scanResult, pattern, pressure, payout) {
  const inSweetSpot = payout >= 1.10 && payout <= 1.20;
  if (scanResult.mode === "paper-only") {
    return { status: "SIT_OUT", reasons: ["Market rules unvalidated - paper trade only."], inSweetSpot };
  }
  if (scanResult.signal === "HOLD") {
    return { status: "SIT_OUT", reasons: scanResult.reasons, inSweetSpot };
  }
  const wantsBullish = scanResult.signal === "BUY_YES";
  const patternContradicts = wantsBullish ? pattern.pattern === "bearish_engulfing" : pattern.pattern === "bullish_engulfing";
  const pressureContradicts = wantsBullish ? pressure.pressure === "heavy_selling" : pressure.pressure === "heavy_buying";
  if (patternContradicts || pressureContradicts) {
    return {
      status: "SIT_OUT",
      reasons: [
        patternContradicts ? `Candle pattern (${pattern.pattern.replace("_"," ")}) contradicts the ${scanResult.signal} signal.` : null,
        pressureContradicts ? `Volume shows ${pressure.pressure.replace("_"," ")}, against the ${scanResult.signal} direction.` : null,
      ].filter(Boolean),
      inSweetSpot,
    };
  }
  return { status: "TRADABLE", reasons: ["Scanner rules, candle pattern, and volume all align."], inSweetSpot };
}

// ---------- STRATEGY DISCOVERY (walk-forward validation on real historical data) ----------
function simulateParams(history, params) {
  const { gapMin, probRange, payoutMin } = params;
  const [loP, hiP] = probRange;
  let trades = 0, wins = 0, totalReturn = 0;
  for (const row of history) {
    const gap = Math.abs(row.spotPriceAtEntry - row.strike);
    if (gap < gapMin) continue;
    if (row.impliedProbAtEntry < loP || row.impliedProbAtEntry > hiP) continue;
    if (row.payoutAtEntry < payoutMin) continue;
    const predictedSide = row.spotPriceAtEntry > row.strike ? "YES" : "NO";
    const won = predictedSide === row.outcome;
    trades += 1; if (won) wins += 1;
    totalReturn += won ? row.payoutAtEntry - 1 : -1;
  }
  if (trades === 0) return { trades: 0, winRate: null, avgReturn: null, totalReturn: 0 };
  return { trades, winRate: wins / trades, avgReturn: totalReturn / trades, totalReturn };
}
function buildGrid() {
  const gapMins = [2, 4, 6, 8, 10, 14, 20];
  const probRanges = [[0.5,0.6],[0.55,0.65],[0.6,0.7],[0.55,0.7]];
  const payoutMins = [1.1, 1.15, 1.2, 1.3];
  const grid = [];
  for (const gapMin of gapMins) for (const probRange of probRanges) for (const payoutMin of payoutMins) grid.push({ gapMin, probRange, payoutMin });
  return grid;
}
function walkForwardValidate(history, { folds = 4, minTradesPerFold = 20 } = {}) {
  const sorted = [...history].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const chunkSize = Math.floor(sorted.length / folds);
  if (chunkSize < minTradesPerFold) return { status: "insufficient_data", message: `Only ${sorted.length} rows.` };
  const chunks = [];
  for (let i = 0; i < folds; i++) chunks.push(sorted.slice(i * chunkSize, (i + 1) * chunkSize));
  const grid = buildGrid();
  const foldResults = [];
  for (let i = 0; i < chunks.length - 1; i++) {
    const trainSet = chunks.slice(0, i + 1).flat();
    const testSet = chunks[i + 1];
    let best = null;
    for (const params of grid) {
      const res = simulateParams(trainSet, params);
      if (res.trades < minTradesPerFold) continue;
      if (!best || res.avgReturn > best.result.avgReturn) best = { params, result: res };
    }
    if (!best) { foldResults.push({ fold: i, status: "no_viable_params" }); continue; }
    const testResult = simulateParams(testSet, best.params);
    foldResults.push({ fold: i, params: best.params, testResult, heldUp: testResult.trades >= minTradesPerFold && testResult.avgReturn > 0 });
  }
  const viable = foldResults.filter((f) => f.heldUp);
  return { status: viable.length >= Math.ceil((folds - 1) / 2) ? "candidate_for_validation" : "not_yet_reliable", foldResults };
}

// ---------- GUARDRAILS ----------
class Guardrails {
  constructor(bankroll, opts = {}) {
    this.bankroll = bankroll;
    this.config = { maxSingleBetPctOfBankroll: 0.05, maxDailyLossPct: 0.15, maxConsecutiveLosses: 3, cooldownMinutes: 30, ...opts };
    this.dailyPnl = 0; this.consecutiveLosses = 0; this.lastLossTime = null;
  }
  checkEntry(proposedStake) {
    const reasons = []; let allowed = true;
    const maxStake = this.bankroll * this.config.maxSingleBetPctOfBankroll;
    if (proposedStake > maxStake) { allowed = false; reasons.push(`Stake exceeds ${(this.config.maxSingleBetPctOfBankroll*100).toFixed(0)}% bankroll cap.`); }
    const lossPct = -this.dailyPnl / this.bankroll;
    if (lossPct >= this.config.maxDailyLossPct) { allowed = false; reasons.push(`Daily loss at stop threshold - step away.`); }
    if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
      const cooldownEnds = this.lastLossTime + this.config.cooldownMinutes * 60000;
      if (Date.now() < cooldownEnds) { allowed = false; reasons.push(`Cooling down after ${this.consecutiveLosses} losses in a row.`); }
    }
    return { allowed, reasons };
  }
}

// ---------- LIVE POLLER ----------
const liveState = {};

async function fetchAllSpotPrices() {
  const ids = Object.values(MARKETS).map((m) => m.coingeckoId).join(",");
  const res = await fetch(`${COINGECKO_BASE}/simple/price?ids=${ids}&vs_currencies=usd`);
  if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
  return res.json();
}

async function pollMarket(symbol, prices) {
  const cfg = MARKETS[symbol];
  try {
    const spotPrice = prices?.[cfg.coingeckoId]?.usd;
    if (!spotPrice) {
      liveState[symbol] = { symbol, error: "No spot price from CoinGecko", updatedAt: Date.now() };
      return;
    }

    const kalshiRes = await fetch(`${KALSHI_BASE}/markets?series_ticker=${cfg.kalshiSeries}&status=open&limit=1`);
    const kalshiData = kalshiRes.ok ? await kalshiRes.json() : null;
    const market = kalshiData?.markets?.[0];

    let strike = spotPrice, impliedProb = 0.5, payout = 1;
    let kalshiNote = null;
    if (market) {
      strike = market.floor_strike ?? market.cap_strike ?? spotPrice;
      impliedProb = parseFloat(market.last_price_dollars || market.yes_bid_dollars || 0.5);
      payout = impliedProb > 0 ? 1 / impliedProb : 1;
    } else {
      kalshiNote = `No open Kalshi market found for ${cfg.kalshiSeries} right now.`;
    }

    const scanResult = evaluateEntry({ symbol, spotPrice, strike, impliedProb, payout });

    let pattern = { pattern: "unavailable" };
    let pressure = { pressure: "unavailable" };
    if (cfg.coinbaseProduct) {
      try {
        const candles = await fetchCandles(cfg.coinbaseProduct);
        pattern = detectBullishEngulfing(candles);
        pressure = detectVolumePressure(candles);
      } catch (err) {
        pattern = { pattern: "error", note: err.message };
        pressure = { pressure: "error", note: err.message };
      }
    }

    const tradability = classifyTradability(scanResult, pattern, pressure, payout);

    liveState[symbol] = {
      symbol, spotPrice, strike, impliedProb, payout,
      ...scanResult, pattern, pressure, tradability, kalshiNote,
      updatedAt: Date.now(),
    };
  } catch (err) {
    liveState[symbol] = { symbol, error: err.message, updatedAt: Date.now() };
  }
}

async function pollAllMarkets() {
  try {
    const prices = await fetchAllSpotPrices();
    for (const symbol of Object.keys(MARKETS)) await pollMarket(symbol, prices);
  } catch (err) {
    Object.keys(MARKETS).forEach((symbol) => {
      liveState[symbol] = { symbol, error: `CoinGecko fetch failed: ${err.message}`, updatedAt: Date.now() };
    });
  }
}
pollAllMarkets();
setInterval(pollAllMarkets, 30000); // 30s - stays within Coinbase + CoinGecko free rate limits

// ---------- WHALE SCANNER ----------
async function detectWhales(ticker, { minContracts = 500 } = {}) {
  const res = await fetch(`${KALSHI_BASE}/markets/${ticker}/orderbook`);
  if (!res.ok) throw new Error(`${res.status} fetching orderbook`);
  const data = await res.json();
  const flagLevels = (levels = []) => levels.filter((l) => (l.quantity ?? l[1] ?? 0) >= minContracts);
  return { ticker, yesWhales: flagLevels(data.orderbook?.yes), noWhales: flagLevels(data.orderbook?.no) };
}

// ---------- SPORTS LIVE DATA ----------
async function fetchMilestone(milestoneId, includePlayerStats = false) {
  const url = new URL(`${KALSHI_BASE}/live_data/milestone/${milestoneId}`);
  if (includePlayerStats) url.searchParams.set("include_player_stats", "true");
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`${res.status} fetching milestone`);
  return res.json();
}
async function findLiveMarkets(seriesTicker) {
  const url = new URL(`${KALSHI_BASE}/markets`);
  url.searchParams.set("series_ticker", seriesTicker);
  url.searchParams.set("status", "open");
  url.searchParams.set("limit", "50");
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`${res.status} listing markets`);
  return res.json();
}

// ---------- API ROUTES ----------
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/api/markets", (req, res) => res.json(MARKETS));
app.get("/api/sports", (req, res) => res.json(SPORTS));
app.get("/api/live-status", (req, res) => res.json(liveState));
app.post("/api/scan", (req, res) => res.json(evaluateEntry(req.body)));
app.post("/api/discover-strategy", (req, res) => {
  const { symbol, history } = req.body;
  if (!symbol || !Array.isArray(history)) return res.status(400).json({ error: "symbol and history[] required" });
  res.json({ symbol, ...walkForwardValidate(history) });
});
app.post("/api/guardrails/check", (req, res) => {
  const { bankroll, dailyPnl, consecutiveLosses, proposedStake } = req.body;
  const g = new Guardrails(bankroll);
  g.dailyPnl = dailyPnl || 0; g.consecutiveLosses = consecutiveLosses || 0;
  res.json(g.checkEntry(proposedStake));
});
app.get("/api/whales/:ticker", async (req, res) => {
  try { res.json(await detectWhales(req.params.ticker, { minContracts: Number(req.query.min) || 500 })); }
  catch (err) { res.status(502).json({ error: err.message }); }
});
app.get("/api/sports/live-markets/:seriesTicker", async (req, res) => {
  try { res.json(await findLiveMarkets(req.params.seriesTicker)); }
  catch (err) { res.status(502).json({ error: err.message }); }
});
app.get("/api/sports/milestone/:milestoneId", async (req, res) => {
  try { res.json(await fetchMilestone(req.params.milestoneId, req.query.playerStats === "true")); }
  catch (err) { res.status(502).json({ error: err.message }); }
});

// ---------- DASHBOARD ----------
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Kalshi Markets</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,500;1,600&family=Work+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap');
* { box-sizing: border-box; }
body { margin: 0; background: #0d0709; color: #f5ead9; font-family: 'Work Sans', sans-serif; }
h1 { font-family: 'Cormorant Garamond', serif; font-style: italic; font-size: 3rem; margin: 0 0 8px; }
.wrap { padding: 40px 24px; max-width: 1300px; margin: 0 auto; }
.sub { color: #a98a95; font-size: 14px; margin-bottom: 24px; }
.warn { border-left: 2px solid #c98ba0; background: rgba(201,139,160,0.08); padding: 12px 16px; font-size: 13px; color: #e8d9c9; margin-bottom: 32px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
.card { border: 1px solid rgba(201,161,90,0.25); border-radius: 4px; padding: 20px; background: linear-gradient(160deg, rgba(92,26,46,0.35), rgba(13,7,9,0.6)); }
.card.paper { border-color: rgba(201,139,160,0.2); }
.card.tradable { border-color: rgba(201,161,90,0.6); box-shadow: 0 0 16px rgba(201,161,90,0.08); }
.top-row { display: flex; justify-content: space-between; align-items: flex-start; }
.symbol { font-family: 'Cormorant Garamond', serif; font-style: italic; font-size: 1.8rem; }
.label { color: #a98a95; font-size: 11px; text-transform: uppercase; letter-spacing: 0.15em; }
.badge { display: inline-block; margin: 4px 6px 0 0; padding: 3px 9px; border-radius: 3px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em; border: 1px solid rgba(201,161,90,0.4); color: #c9a15a; }
.badge.hold { color: #c98ba0; border-color: rgba(201,139,160,0.35); }
.badge.tradable { color: #6fbf73; border-color: rgba(111,191,115,0.4); }
.badge.sitout { color: #c98ba0; border-color: rgba(201,139,160,0.35); }
.badge.sweet { color: #f5ead9; background: rgba(201,161,90,0.25); border-color: #c9a15a; }
.stats { display: flex; justify-content: space-between; margin-top: 14px; font-family: 'JetBrains Mono', monospace; font-size: 13px; color: #f5ead9; }
.stat-label { color: #8a6b74; font-size: 9px; text-transform: uppercase; display: block; }
.reasons { margin-top: 12px; font-size: 12px; color: #a98a95; line-height: 1.5; }
.chart-toggle { margin-top: 14px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: #c9a15a; cursor: pointer; border: none; background: none; padding: 0; }
.chart-container { display: none; margin-top: 10px; height: 300px; }
.chart-container.open { display: block; }
.position-box { margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(201,161,90,0.15); font-size: 12px; }
.position-box button { font-family: 'Work Sans', sans-serif; font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; padding: 6px 12px; border-radius: 3px; border: 1px solid rgba(201,161,90,0.4); background: transparent; color: #c9a15a; cursor: pointer; margin-top: 6px; }
.section-title { font-family: 'Cormorant Garamond', serif; font-style: italic; font-size: 1.8rem; margin: 40px 0 16px; }
.sport-card { border: 1px solid rgba(201,139,160,0.2); border-radius: 4px; padding: 16px; background: rgba(92,26,46,0.15); font-size: 13px; }
.sport-title { font-weight: 600; margin-bottom: 4px; }
.history-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 10px; }
.history-table th, .history-table td { text-align: left; padding: 6px 10px; border-bottom: 1px solid rgba(201,161,90,0.15); }
.history-table th { color: #8a6b74; text-transform: uppercase; font-size: 10px; letter-spacing: 0.1em; }
.stat-strip { display: flex; gap: 24px; margin-top: 10px; font-family: 'JetBrains Mono', monospace; font-size: 14px; }
.coach { margin-top: 32px; border-left: 2px solid #c9a15a; padding: 16px 20px; background: rgba(201,161,90,0.06); font-size: 14px; color: #e8d9c9; }
footer { margin-top: 32px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.2em; color: #4a3a40; }
</style>
</head>
<body>
<div class="wrap">
  <h1>The market has<br>a pulse. We read it.</h1>
  <div class="sub">Live crypto signals, candle patterns, and volume pressure - updates every 30 seconds</div>
  <div class="warn">Trade history below is stored in <b>this browser only</b> (no server database on the free plan) - it won't follow you to another device and clears if you clear Safari's site data. Educational tooling, not financial advice.</div>

  <div class="grid" id="markets">Loading live data...</div>

  <div class="section-title">Your Trade Log</div>
  <div class="sub">Log a trade after you place it, mark it win or loss when it settles - builds your own track record over time, right here in your browser.</div>
  <div id="stats" class="stat-strip"></div>
  <table class="history-table" id="history"><thead><tr><th>Symbol</th><th>Signal</th><th>Result</th><th>Time</th><th></th></tr></thead><tbody></tbody></table>

  <div class="coach" id="coach"></div>

  <div class="section-title">Sports</div>
  <div class="sub">Currently open markets - MLB, ATP, WTA. Live game data is looked up per-game once a match is active.</div>
  <div class="grid" id="sports">Checking for open sports markets...</div>

  <footer>Educational tooling - not financial advice - signals are probabilistic, never certain</footer>
</div>

<script src="https://s3.tradingview.com/tv.js"></script>
<script>
const TV_SYMBOLS = ${JSON.stringify(Object.fromEntries(Object.entries(MARKETS).map(([k,v]) => [k, v.tvSymbol])))};
const chartsRendered = {};

function toggleChart(symbol) {
  const container = document.getElementById('chart-' + symbol);
  container.classList.toggle('open');
  if (container.classList.contains('open') && !chartsRendered[symbol]) {
    new TradingView.widget({
      autosize: true,
      symbol: TV_SYMBOLS[symbol],
      interval: '15',
      timezone: 'Etc/UTC',
      theme: 'dark',
      style: '1',
      locale: 'en',
      toolbar_bg: '#0d0709',
      container_id: 'chart-' + symbol,
    });
    chartsRendered[symbol] = true;
  }
}

function loadHistory() {
  try { return JSON.parse(localStorage.getItem('tradeLog') || '[]'); } catch (e) { return []; }
}
function saveHistory(h) { localStorage.setItem('tradeLog', JSON.stringify(h)); }

function logTrade(symbol, signal) {
  const h = loadHistory();
  h.push({ symbol, signal, result: 'open', time: Date.now() });
  saveHistory(h);
  renderHistory();
}
function markResult(index, result) {
  const h = loadHistory();
  if (h[index]) h[index].result = result;
  saveHistory(h);
  renderHistory();
}

function renderHistory() {
  const h = loadHistory();
  const tbody = document.querySelector('#history tbody');
  tbody.innerHTML = h.slice().reverse().map((t, i) => {
    const realIndex = h.length - 1 - i;
    const resultCell = t.result === 'open'
      ? '<button onclick="markResult(' + realIndex + ',\\'win\\')" style="margin-right:6px;">Win</button><button onclick="markResult(' + realIndex + ',\\'loss\\')">Loss</button>'
      : t.result.toUpperCase();
    return '<tr><td>' + t.symbol + '</td><td>' + t.signal + '</td><td>' + resultCell + '</td><td>' + new Date(t.time).toLocaleString() + '</td><td></td></tr>';
  }).join('');

  const settled = h.filter(t => t.result !== 'open');
  const wins = settled.filter(t => t.result === 'win').length;
  const winRate = settled.length ? Math.round((wins / settled.length) * 100) : null;
  let streak = 0, streakType = null;
  for (let i = settled.length - 1; i >= 0; i--) {
    if (streakType === null) { streakType = settled[i].result; streak = 1; }
    else if (settled[i].result === streakType) streak++;
    else break;
  }
  document.getElementById('stats').innerHTML =
    '<div><span class="stat-label">Trades logged</span>' + h.length + '</div>' +
    '<div><span class="stat-label">Win rate</span>' + (winRate === null ? '—' : winRate + '%') + '</div>' +
    '<div><span class="stat-label">Current streak</span>' + (streakType ? streak + ' ' + streakType + (streak>1?'s':'') : '—') + '</div>';

  renderCoach(settled, streak, streakType);
}

function renderCoach(settled, streak, streakType) {
  const el = document.getElementById('coach');
  if (settled.length === 0) {
    el.innerHTML = 'Log your first trade above once you place one - tracking every trade, win or lose, is how you find out if your edge is real instead of guessing.';
    return;
  }
  if (streakType === 'loss' && streak >= 3) {
    el.innerHTML = streak + ' losses in a row. This is exactly when the urge to "make it back" is strongest - and exactly when it is most likely to compound the damage. Consider sitting out until the next validated setup.';
  } else if (streakType === 'win' && streak >= 3) {
    el.innerHTML = streak + ' wins in a row - solid, but a streak is not proof of skill on a small sample. Keep sizing exactly the same as before; do not let a hot streak talk you into a bigger bet.';
  } else {
    el.innerHTML = 'Keep logging every trade. Once you have 20+ settled trades on a market, use the strategy discovery endpoint to check if the edge actually holds up out-of-sample.';
  }
}

async function refresh() {
  try {
    const res = await fetch('/api/live-status');
    const data = await res.json();
    const el = document.getElementById('markets');
    el.innerHTML = Object.values(data).map(m => {
      if (m.error) return '<div class="card"><div class="symbol">' + m.symbol + '</div><div class="label">Error: ' + m.error + '</div></div>';
      const isPaper = m.mode === 'paper-only';
      const trad = m.tradability || {};
      const cardClass = trad.status === 'TRADABLE' ? 'tradable' : (isPaper ? 'paper' : '');
      const patternNote = m.pattern && m.pattern.note ? m.pattern.note : '';
      const pressureLabel = m.pressure && m.pressure.pressure ? m.pressure.pressure.replace('_',' ') : 'n/a';
      return '<div class="card ' + cardClass + '">' +
        '<div class="top-row"><div class="symbol">' + m.symbol + '</div></div>' +
        '<div>' +
          '<span class="badge ' + (m.signal === 'HOLD' ? 'hold' : '') + '">' + (isPaper ? 'Paper only' : (m.signal||'').replace('_',' ')) + '</span>' +
          (trad.status ? '<span class="badge ' + (trad.status === 'TRADABLE' ? 'tradable' : 'sitout') + '">' + trad.status.replace('_',' ') + '</span>' : '') +
          (trad.inSweetSpot ? '<span class="badge sweet">10-20% payout</span>' : '') +
        '</div>' +
        '<div class="stats">' +
          '<div><span class="stat-label">Price</span>$' + Number(m.spotPrice).toFixed(m.spotPrice < 1 ? 4 : 2) + '</div>' +
          '<div><span class="stat-label">Prob</span>' + (m.impliedProb*100).toFixed(0) + '%</div>' +
          '<div><span class="stat-label">Payout</span>' + m.payout.toFixed(2) + 'x</div>' +
        '</div>' +
        '<div class="stats"><div><span class="stat-label">Candle pattern</span>' + (m.pattern ? m.pattern.pattern.replace('_',' ') : 'n/a') + '</div>' +
        '<div><span class="stat-label">Volume</span>' + pressureLabel + '</div></div>' +
        (patternNote ? '<div class="reasons">' + patternNote + '</div>' : '') +
        '<div class="reasons">' + ((m.reasons||[]).join(' ')) + '</div>' +
        '<button class="chart-toggle" onclick="toggleChart(\\'' + m.symbol + '\\')">Show chart ▾</button>' +
        '<div class="chart-container" id="chart-' + m.symbol + '"></div>' +
        '<div class="position-box">' +
          '<button onclick="logTrade(\\'' + m.symbol + '\\',\\'' + (m.signal||'HOLD') + '\\')">Log this trade</button>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch (e) { console.error(e); }
}

async function refreshSports() {
  const seriesMap = ${JSON.stringify(SPORTS_SERIES)};
  const el = document.getElementById('sports');
  try {
    const results = await Promise.all(Object.entries(seriesMap).map(async ([key, series]) => {
      try {
        const res = await fetch('/api/sports/live-markets/' + series);
        const data = await res.json();
        const count = data.markets ? data.markets.length : 0;
        const sample = data.markets && data.markets[0] ? (data.markets[0].title || data.markets[0].ticker) : null;
        return { key, count, sample, error: data.error };
      } catch (e) { return { key, count: 0, error: e.message }; }
    }));
    el.innerHTML = results.map(r => {
      if (r.error) return '<div class="sport-card"><div class="sport-title">' + r.key + '</div>Series ticker not confirmed yet - ' + r.error + '</div>';
      if (r.count === 0) return '<div class="sport-card"><div class="sport-title">' + r.key + '</div>No open markets right now</div>';
      return '<div class="sport-card"><div class="sport-title">' + r.key + ' - ' + r.count + ' open</div>' + (r.sample || '') + '</div>';
    }).join('');
  } catch (e) { el.innerHTML = '<div class="sport-card">Could not load sports data.</div>'; }
}

refresh();
refreshSports();
renderHistory();
setInterval(refresh, 30000);
setInterval(refreshSports, 45000);
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`kalshi-markets running on :${PORT}`));
