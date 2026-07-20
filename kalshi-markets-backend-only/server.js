/**
 * kalshi-markets - complete single-file backend + dashboard.
 * Uses Coinbase's public price feed (Binance blocks requests from
 * US-hosted servers with a 451 error - Coinbase doesn't, and needs no key).
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
const COINBASE_BASE = "https://api.coinbase.com/v2";

// ---------- MARKET CONFIG ----------
// gapMin/winProbRange/payoutMin for BTC came from a full walk-forward
// backtest that held up across out-of-sample folds - status "validated"
// means it's trusted for live trade signals.
//
// DOGE and SOL below use the best params found by the same walk-forward
// process, but they only held up in the earliest fold (out-of-sample trade
// counts got too thin in later folds to confirm consistency) - so status
// stays "candidate", not "validated". The signal still computes and shows
// on the dashboard (marked "unvalidated"), but isLiveEligible() below keeps
// them out of live/tradeable status until more data confirms the edge.
const MARKETS = {
  BTC: { label: "Bitcoin 15m", kalshiSeries: "KXBTC15M", coinbasePair: "BTC-USD", gapMin: 8, winProbRange: [0.55, 0.65], payoutMin: 1.2, status: "validated" },
  DOGE: { label: "Dogecoin 15m", kalshiSeries: "KXDOGE15M", coinbasePair: "DOGE-USD", gapMin: 0.00017, winProbRange: [0.55, 0.65], payoutMin: 1.1, status: "candidate" },
  SOL: { label: "Solana 15m", kalshiSeries: "KXSOL15M", coinbasePair: "SOL-USD", gapMin: 0.083, winProbRange: [0.5, 0.6], payoutMin: 1.1, status: "candidate" },
  ETH: { label: "Ethereum 15m", kalshiSeries: "KXETH15M", coinbasePair: "ETH-USD", gapMin: 1.67, winProbRange: [0.5, 0.6], payoutMin: 1.1, status: "candidate" },
  HYPE: { label: "Hyperliquid 15m", kalshiSeries: "KXHYPE15M", coinbasePair: "HYPE-USD", gapMin: 0.107, winProbRange: [0.5, 0.6], payoutMin: 1.1, status: "candidate" },
};
function isLiveEligible(symbol) { return MARKETS[symbol]?.status === "validated"; }

const SPORTS = {
  MLB: { label: "MLB Game Winner", category: "Baseball", status: "candidate" },
  ATP: { label: "ATP Match Winner", category: "Tennis", status: "candidate" },
  WTA: { label: "WTA Match Winner", category: "Tennis", status: "candidate" },
};

// ---------- SCANNER ----------
// "lean" is the raw directional read (is spot above or below strike right
// now) - always computed, shown even when the strict entry rules below
// say HOLD. It's not a vetted trade call, just "which way is it pointing."
// "signal" (HOLD / BUY_YES / BUY_NO) stays gated by gap/prob/payout
// thresholds - that distinction is intentional, don't collapse them.
function evaluateEntry({ symbol, spotPrice, strike, impliedProb, payout }) {
  const cfg = MARKETS[symbol];
  const lean = (spotPrice != null && strike != null) ? (spotPrice > strike ? "UP" : "DOWN") : null;
  if (!cfg) return { signal: "STAND_ASIDE", reasons: [`Unknown market: ${symbol}`], lean };
  if (cfg.gapMin === null) {
    return { signal: "PAPER_ONLY", reasons: [`${cfg.label} has no validated rule set yet.`], mode: "paper-only", lean };
  }
  const gap = Math.abs(spotPrice - strike);
  const reasons = [];
  let pass = true;
  if (gap < cfg.gapMin) { pass = false; reasons.push(`Gap $${gap.toFixed(2)} below $${cfg.gapMin} min.`); }
  const [loP, hiP] = cfg.winProbRange;
  if (impliedProb < loP || impliedProb > hiP) { pass = false; reasons.push(`Win prob ${(impliedProb*100).toFixed(1)}% outside window.`); }
  if (payout < cfg.payoutMin) { pass = false; reasons.push(`Payout ${payout.toFixed(2)}x below min.`); }
  if (!pass) return { signal: "HOLD", reasons, mode: isLiveEligible(symbol) ? "live" : "paper-only", lean };
  return { signal: spotPrice > strike ? "BUY_YES" : "BUY_NO", reasons: ["All entry conditions met."], mode: isLiveEligible(symbol) ? "live" : "paper-only", lean };
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

// ---------- STRATEGY DISCOVERY ----------
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

// ---------- LIVE POLLER ----------
const liveState = {};

// Rolling spot-price window per symbol, used only to flag "volatile right
// now" - not a signal on its own, just a heads-up for someone already
// holding a position. Threshold is 3x the market's own calibrated
// gapMin (same number the entry rules already use), not an arbitrary
// guess - so a market's volatility bar scales with its own price/tick
// behavior instead of one fixed number for every asset.
const priceHistory = {};
const VOLATILITY_WINDOW = 5; // last 5 poll ticks (~100s at a 20s poll interval)
function trackVolatility(symbol, spotPrice) {
  const hist = (priceHistory[symbol] = priceHistory[symbol] || []);
  hist.push(spotPrice);
  if (hist.length > VOLATILITY_WINDOW) hist.shift();
  if (hist.length < VOLATILITY_WINDOW) return { priceRange: null, highVolatility: false };
  const range = Math.max(...hist) - Math.min(...hist);
  const cfg = MARKETS[symbol];
  const threshold = cfg && cfg.gapMin ? cfg.gapMin * 3 : null;
  return { priceRange: range, highVolatility: threshold != null && range > threshold };
}

// Longer rolling window, just for the dashboard's sparkline chart - separate
// from the volatility window above so tightening/loosening one doesn't
// silently change the other.
const sparklineHistory = {};
const SPARKLINE_WINDOW = 15; // last 15 poll ticks (~5 min at a 20s poll interval)
function trackSparkline(symbol, spotPrice) {
  const hist = (sparklineHistory[symbol] = sparklineHistory[symbol] || []);
  hist.push(spotPrice);
  if (hist.length > SPARKLINE_WINDOW) hist.shift();
  return hist.slice();
}

// Rolling win-chance (impliedProb) window per symbol - tracks whether it's
// still trending down, not just "below 50% right now" (a single low tick
// could just be noise).
const probHistory = {};
const PROB_TREND_WINDOW = 3; // last 3 poll ticks (~60s)
function trackProbTrend(symbol, impliedProb) {
  const hist = (probHistory[symbol] = probHistory[symbol] || []);
  hist.push(impliedProb);
  if (hist.length > PROB_TREND_WINDOW) hist.shift();
  if (hist.length < PROB_TREND_WINDOW) return { probFalling: false };
  let falling = true;
  for (let i = 1; i < hist.length; i++) {
    if (hist[i] >= hist[i - 1]) { falling = false; break; }
  }
  return { probFalling: falling };
}

// ---------- EXIT ADVISOR ----------
// Fixed, auditable hold/exit rules for a position you're already in -
// not a live discretionary call, just deterministic logic:
//   - win chance 80%+ -> the trade is essentially decided, don't
//     second-guess a wobble
//   - win chance under 50% AND still trending down (not just one noisy
//     tick) -> the one real warning sign
//   - gap still wide relative to this asset's own calibrated entry
//     threshold -> a same-tick bounce against it is probably the "fake
//     V-bounce" this rule set exists to ignore
// "Wide" is 2x the asset's own gapMin, the same asset-scaling approach
// used for the volatility threshold - not one fixed dollar number for
// every asset's different price scale.
function evaluateExit({ symbol, spotPrice, strike, impliedProb, probFalling }) {
  const cfg = MARKETS[symbol];
  const gap = Math.abs(spotPrice - strike);
  const wideGapThreshold = cfg && cfg.gapMin ? cfg.gapMin * 2 : null;
  if (impliedProb >= 0.8) {
    return { exitAdvice: "LOCKED_IN", exitReason: `Win chance ${(impliedProb * 100).toFixed(0)}% - locked in, hold to payout.` };
  }
  if (impliedProb < 0.5 && probFalling) {
    return { exitAdvice: "EXIT_WARNING", exitReason: `Win chance ${(impliedProb * 100).toFixed(0)}% and still falling - consider exiting.` };
  }
  if (wideGapThreshold != null && gap >= wideGapThreshold) {
    return { exitAdvice: "HOLD_WIDE_GAP", exitReason: `Gap $${gap.toFixed(2)} still wide - hold through any bounce.` };
  }
  return { exitAdvice: "NEUTRAL", exitReason: null };
}

async function pollMarket(symbol) {
  const cfg = MARKETS[symbol];
  try {
    const priceRes = await fetch(`${COINBASE_BASE}/prices/${cfg.coinbasePair}/spot`);
    if (!priceRes.ok) throw new Error(`Coinbase ${priceRes.status}`);
    const priceData = await priceRes.json();
    const spotPrice = parseFloat(priceData.data?.amount);

    const kalshiRes = await fetch(`${KALSHI_BASE}/markets?series_ticker=${cfg.kalshiSeries}&status=open&limit=1`);
    const kalshiData = await kalshiRes.json();
    const market = kalshiData.markets?.[0];

    if (!market || !spotPrice) {
      liveState[symbol] = { symbol, error: !spotPrice ? "No Coinbase price for this pair" : "No open Kalshi market found", updatedAt: Date.now() };
      return;
    }

    const strike = market.floor_strike ?? market.cap_strike ?? spotPrice;
    const impliedProb = parseFloat(market.last_price_dollars || market.yes_bid_dollars || 0.5);
    const payout = impliedProb > 0 ? 1 / impliedProb : 1;
    const closeTime = market.close_time || null;
    const ticker = market.ticker || null;

    const evalResult = evaluateEntry({ symbol, spotPrice, strike, impliedProb, payout });
    const volResult = trackVolatility(symbol, spotPrice);
    const probTrend = trackProbTrend(symbol, impliedProb);
    const exitResult = evaluateExit({ symbol, spotPrice, strike, impliedProb, probFalling: probTrend.probFalling });
    const sparkline = trackSparkline(symbol, spotPrice);
    liveState[symbol] = { symbol, spotPrice, strike, impliedProb, payout, closeTime, ticker, sparkline, ...evalResult, ...volResult, ...probTrend, ...exitResult, updatedAt: Date.now() };
  } catch (err) {
    liveState[symbol] = { symbol, error: err.message, updatedAt: Date.now() };
  }
}
function pollAllMarkets() { Object.keys(MARKETS).forEach(pollMarket); }
pollAllMarkets();
setInterval(pollAllMarkets, 20000);

// ---------- WHALE SCANNER ----------
// Kalshi's real orderbook response is { orderbook_fp: { yes_dollars: [[price,size],...], no_dollars: [...] } } -
// note this is NOT { orderbook: { yes, no } }, which is what this function
// read before (silently returning nothing every time). Also switched from
// a fixed contract-count threshold to top-N-by-size: a flat "500+
// contracts" cutoff flags dozens of levels even far out-of-the-money on a
// liquid market, and flags nothing on a thin one - doesn't scale.
async function detectWhales(ticker, { topN = 3 } = {}) {
  const res = await fetch(`${KALSHI_BASE}/markets/${ticker}/orderbook`);
  if (!res.ok) throw new Error(`${res.status} fetching orderbook`);
  const data = await res.json();
  const book = data.orderbook_fp || {};
  const topLevels = (levels = []) => levels
    .map((l) => ({ price: parseFloat(l[0]), size: parseFloat(l[1]) }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size))
    .sort((a, b) => b.size - a.size)
    .slice(0, topN);
  return { ticker, yesWhales: topLevels(book.yes_dollars), noWhales: topLevels(book.no_dollars) };
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
// Looks up a specific closed contract's real outcome, so a position the
// dashboard tracked can be auto-settled against what Kalshi actually
// resolved - not a guess, the market's own final result.
app.get("/api/settlement/:ticker", async (req, res) => {
  try {
    const r = await fetch(`${KALSHI_BASE}/markets/${req.params.ticker}`);
    if (!r.ok) return res.status(502).json({ error: `Kalshi ${r.status}` });
    const data = await r.json();
    const market = data.market || data;
    res.json({ ticker: req.params.ticker, status: market.status, result: market.result || null });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});
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
  try { res.json(await detectWhales(req.params.ticker, { topN: Number(req.query.top) || 3 })); }
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
.wrap { padding: 40px 24px; max-width: 1200px; margin: 0 auto; }
.sub { color: #a98a95; font-size: 14px; margin-bottom: 20px; }
.notice { border-left: 2px solid #c98ba0; padding: 14px 20px; background: rgba(201,139,160,0.06); font-size: 13px; color: #e8d9c9; margin-bottom: 32px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
.card { border: 1px solid rgba(201,161,90,0.25); border-radius: 4px; padding: 20px; background: linear-gradient(160deg, rgba(92,26,46,0.35), rgba(13,7,9,0.6)); }
.card.paper { border-color: rgba(201,139,160,0.2); }
.symbol { font-family: 'Cormorant Garamond', serif; font-style: italic; font-size: 1.8rem; }
.label { color: #a98a95; font-size: 11px; text-transform: uppercase; letter-spacing: 0.15em; }
.signal { display: inline-block; margin-top: 10px; padding: 4px 10px; border-radius: 3px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.15em; border: 1px solid rgba(201,161,90,0.4); color: #c9a15a; }
.signal.hold { color: #c98ba0; border-color: rgba(201,139,160,0.35); }
.signal.unvalidated { color: #c98ba0; border-color: rgba(201,139,160,0.4); border-style: dashed; }
.unvalidated-note { display: block; margin-top: 6px; font-size: 9px; text-transform: uppercase; letter-spacing: 0.12em; color: #8a6b74; }
.lean { display: inline-block; margin-top: 8px; margin-left: 6px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; font-weight: 600; }
.lean-up { color: #c9a15a; }
.lean-down { color: #c98ba0; }
.countdown { display: block; margin-top: 6px; font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #a98a95; letter-spacing: 0.05em; }
.reasons { margin: 10px 0 0; padding-left: 16px; font-size: 11px; color: #a98a95; line-height: 1.6; }
.reasons li { margin-bottom: 2px; }
.sparkline { display: block; margin-top: 10px; }
.data-stale { display: block; margin-top: 6px; font-size: 9px; text-transform: uppercase; letter-spacing: 0.1em; color: #d97757; }
.whale-watch { margin-top: 14px; padding-top: 10px; border-top: 1px solid rgba(201,161,90,0.15); }
.whale-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.12em; color: #8a6b74; margin-bottom: 4px; }
.whale-line { font-family: 'JetBrains Mono', monospace; font-size: 11px; }
.whale-yes { color: #c9a15a; }
.whale-no { color: #c98ba0; }
.position { margin-top: 12px; padding: 6px 10px; border-radius: 3px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; font-weight: 600; }
.position-yes { background: rgba(201,161,90,0.15); color: #c9a15a; border: 1px solid rgba(201,161,90,0.4); }
.position-no { background: rgba(201,139,160,0.15); color: #c98ba0; border: 1px solid rgba(201,139,160,0.4); }
.position-settling { opacity: 0.6; border-style: dashed; }
.position-stale { background: rgba(217,119,87,0.15); color: #d97757; border: 1px solid rgba(217,119,87,0.4); }
.position-actions { display: flex; gap: 6px; margin-top: 8px; }
.position-actions button { flex: 1; background: #1a0f13; border: 1px solid rgba(201,161,90,0.3); color: #f5ead9; padding: 6px 8px; border-radius: 3px; font-family: 'Work Sans', sans-serif; font-size: 11px; cursor: pointer; }
.position-actions button:hover { border-color: #c9a15a; }
.exit-advice { margin-top: 8px; padding: 6px 10px; border-radius: 3px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }
.exit-locked-in { background: rgba(201,161,90,0.15); color: #c9a15a; border: 1px solid rgba(201,161,90,0.4); }
.exit-exit-warning { background: rgba(217,119,87,0.15); color: #d97757; border: 1px solid rgba(217,119,87,0.4); }
.exit-hold-wide-gap { background: rgba(138,107,116,0.15); color: #a98a95; border: 1px solid rgba(138,107,116,0.4); }
.stats { display: flex; justify-content: space-between; margin-top: 14px; font-family: 'JetBrains Mono', monospace; font-size: 13px; color: #f5ead9; }
.stat-label { color: #8a6b74; font-size: 9px; text-transform: uppercase; display: block; }
h2 { font-family: 'Cormorant Garamond', serif; font-style: italic; font-size: 2rem; margin: 40px 0 8px; }
.log-desc { color: #a98a95; font-size: 13px; margin-bottom: 20px; }
.log-stats { display: flex; gap: 32px; margin-bottom: 16px; font-family: 'JetBrains Mono', monospace; }
.log-stats div span { display: block; }
.log-stats .stat-label { margin-bottom: 4px; }
.log-form { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; }
.log-form select, .log-form button { background: #1a0f13; border: 1px solid rgba(201,161,90,0.3); color: #f5ead9; padding: 8px 12px; border-radius: 3px; font-family: 'Work Sans', sans-serif; font-size: 13px; }
.log-form button { cursor: pointer; }
.log-form button:hover { border-color: #c9a15a; }
.guardrails-label { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #a98a95; }
.guardrails-label input { width: 80px; background: #1a0f13; border: 1px solid rgba(201,161,90,0.3); color: #f5ead9; padding: 8px 10px; border-radius: 3px; font-family: 'JetBrains Mono', monospace; font-size: 13px; }
.guardrails-status { margin-top: 4px; padding: 12px 16px; border-radius: 4px; font-size: 13px; border: 1px solid rgba(201,161,90,0.25); color: #a98a95; }
.guardrails-ok { border-color: rgba(201,161,90,0.4); color: #c9a15a; }
.guardrails-blocked { border-color: rgba(217,119,87,0.4); color: #d97757; background: rgba(217,119,87,0.06); }
table { width: 100%; border-collapse: collapse; font-family: 'JetBrains Mono', monospace; font-size: 13px; }
th { text-align: left; color: #8a6b74; font-size: 10px; text-transform: uppercase; letter-spacing: 0.15em; padding: 8px 0; border-bottom: 1px solid rgba(201,161,90,0.15); }
td { padding: 8px 0; border-bottom: 1px solid rgba(201,161,90,0.08); }
.win { color: #c9a15a; } .loss { color: #c98ba0; }
footer { margin-top: 32px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.2em; color: #4a3a40; }
</style>
</head>
<body>
<div class="wrap">
  <h1>The market has<br>a pulse. We read it.</h1>
  <div class="sub">Live crypto signals - updates every 20 seconds</div>
  <div class="notice">Trade history below is stored in <strong>this browser only</strong> (no server database on the free plan) - it won't follow you to another device. Educational tooling, not financial advice.</div>
  <div class="grid" id="markets">Loading live data...</div>

  <h2>Your Trade Log</h2>
  <div class="log-desc">Log a trade after you place it, mark it win or loss when it settles - builds your own track record over time, right here in your browser.</div>
  <div class="log-stats">
    <div><span class="stat-label label">Trades Logged</span><span id="statCount">0</span></div>
    <div><span class="stat-label label">Win Rate</span><span id="statWinRate">-</span></div>
    <div><span class="stat-label label">Current Streak</span><span id="statStreak">-</span></div>
  </div>
  <div class="log-form">
    <select id="logSymbol"><option>BTC</option><option>DOGE</option><option>SOL</option><option>ETH</option><option>HYPE</option></select>
    <select id="logSignal"><option>BUY_YES</option><option>BUY_NO</option></select>
    <button onclick="logTrade()">Log Trade</button>
  </div>
  <table>
    <thead><tr><th>Symbol</th><th>Signal</th><th>Result</th><th>Time</th></tr></thead>
    <tbody id="logBody"></tbody>
  </table>

  <h2>Risk Guardrails</h2>
  <div class="log-desc">Set your bankroll and a typical stake once - this checks your real logged trades against simple stop rules (daily loss limit, cooldown after a losing streak), not vibes.</div>
  <div class="log-form">
    <label class="guardrails-label">Bankroll $<input type="number" id="bankrollInput" min="1" step="1" value="1000"></label>
    <label class="guardrails-label">Stake per trade $<input type="number" id="stakeInput" min="1" step="1" value="50"></label>
    <button onclick="saveGuardrailSettings()">Save</button>
  </div>
  <div id="guardrailsStatus" class="guardrails-status">Set your bankroll and stake, then save to see guardrail status.</div>

  <footer>Educational tooling - not financial advice - signals are probabilistic, never certain</footer>
</div>
<script>
// --- Trade log (localStorage, per-browser) ---
// Position tracking lives here too: a "pending" log entry for a symbol IS
// that symbol's open position. It's what lets the dashboard tell you what
// you're currently holding even after closing the tab and coming back -
// nothing server-side, just this browser's localStorage.
function getLog() { return JSON.parse(localStorage.getItem('tradeLog') || '[]'); }
function saveLog(log) { localStorage.setItem('tradeLog', JSON.stringify(log)); }
function currentPosition(symbol) {
  return getLog().find(t => t.symbol === symbol && t.result === 'pending') || null;
}
// Safety net: a pending position with no ticker (entered before auto-settle
// existed) or one whose settlement lookup keeps failing can never resolve
// on its own - flag it well past any single 15-min cycle so it's obvious
// you need to close it yourself, instead of silently looking "still open"
// forever.
const STALE_MS = 30 * 60 * 1000;
function isStale(pos) {
  return !!(pos && pos.time && (Date.now() - new Date(pos.time).getTime()) > STALE_MS);
}
function enterPosition(symbol, signal, ticker, closeTime, payout) {
  if (currentPosition(symbol)) return; // one open position per symbol at a time
  const log = getLog();
  log.unshift({ symbol, signal, result: 'pending', time: new Date().toLocaleString(), ticker: ticker || null, closeTime: closeTime || null, payout: payout || null });
  saveLog(log);
  refresh();
  renderLog();
}
function closePosition(symbol, result) {
  const log = getLog();
  const idx = log.findIndex(t => t.symbol === symbol && t.result === 'pending');
  if (idx === -1) return;
  log[idx].result = result;
  saveLog(log);
  refresh();
  renderLog();
}
// Auto-settles pending positions once their contract's cycle has closed,
// by checking what Kalshi actually resolved - not a guess, the real
// outcome. Runs alongside the normal poll cycle.
async function checkSettlements() {
  const log = getLog();
  let changed = false;
  for (const entry of log) {
    if (entry.result !== 'pending' || !entry.ticker || !entry.closeTime) continue;
    if (new Date(entry.closeTime).getTime() > Date.now()) continue; // cycle still open
    try {
      const res = await fetch('/api/settlement/' + encodeURIComponent(entry.ticker));
      const data = await res.json();
      if (data.result === 'yes' || data.result === 'no') {
        const won = (entry.signal === 'BUY_YES' && data.result === 'yes') || (entry.signal === 'BUY_NO' && data.result === 'no');
        entry.result = won ? 'win' : 'loss';
        changed = true;
      }
    } catch (e) { console.error(e); }
  }
  if (changed) {
    saveLog(log);
    renderLog();
    refresh();
  }
}
function logTrade() {
  const symbol = document.getElementById('logSymbol').value;
  const signal = document.getElementById('logSignal').value;
  enterPosition(symbol, signal);
}

// Small inline chart of the last ~5 minutes of spot price against the
// strike (dashed line) - no charting library, just an SVG polyline built
// from the same rolling window the server already tracks.
function sparklineSvg(history, strike) {
  if (!history || history.length < 2) return '';
  const w = 160, h = 36, pad = 3;
  const all = strike != null ? history.concat([strike]) : history.slice();
  let min = Math.min.apply(null, all);
  let max = Math.max.apply(null, all);
  if (max === min) { max += 1; min -= 1; }
  const xStep = (w - pad * 2) / (history.length - 1);
  const yFor = v => h - pad - ((v - min) / (max - min)) * (h - pad * 2);
  const points = history.map((v, i) => (pad + i * xStep).toFixed(1) + ',' + yFor(v).toFixed(1)).join(' ');
  const strikeLine = strike != null
    ? '<line x1="' + pad + '" y1="' + yFor(strike).toFixed(1) + '" x2="' + (w - pad) + '" y2="' + yFor(strike).toFixed(1) + '" stroke="#c98ba0" stroke-width="1" stroke-dasharray="3,3" />'
    : '';
  return '<svg class="sparkline" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
    strikeLine +
    '<polyline points="' + points + '" fill="none" stroke="#c9a15a" stroke-width="1.5" />' +
  '</svg>';
}

async function fetchWhales(ticker) {
  try {
    const res = await fetch('/api/whales/' + encodeURIComponent(ticker) + '?top=2');
    return await res.json();
  } catch (e) { return null; }
}
function whaleWatchHtml(whales) {
  if (!whales || ((!whales.yesWhales || !whales.yesWhales.length) && (!whales.noWhales || !whales.noWhales.length))) return '';
  const line = (w, side) => '<div class="whale-line whale-' + side + '">' + side.toUpperCase() + ' ' + Math.round(w.size).toLocaleString() + ' @ ' + (w.price * 100).toFixed(1) + '¢</div>';
  const yes = (whales.yesWhales || []).map(w => line(w, 'yes')).join('');
  const no = (whales.noWhales || []).map(w => line(w, 'no')).join('');
  return '<div class="whale-watch"><div class="whale-label">Whale Watch - largest resting orders</div>' + yes + no + '</div>';
}

async function refresh() {
  try {
    const res = await fetch('/api/live-status');
    const data = await res.json();
    const entries = Object.values(data);
    const whaleResults = await Promise.all(entries.map(m => m.ticker ? fetchWhales(m.ticker) : Promise.resolve(null)));
    const el = document.getElementById('markets');
    el.innerHTML = entries.map((m, idx) => {
      if (m.error) return '<div class="card"><div class="symbol">' + m.symbol + '</div><div class="label">Error: ' + m.error + '</div></div>';
      const whaleHtml = whaleWatchHtml(whaleResults[idx]);
      const isPaper = m.mode === 'paper-only';
      const hasSignal = m.signal && m.signal !== 'PAPER_ONLY';
      const signalClass = m.signal === 'HOLD' ? 'hold' : (isPaper && hasSignal ? 'unvalidated' : '');
      const signalText = hasSignal ? m.signal.replace('_',' ') : 'No signal yet';
      const leanHtml = m.lean
        ? '<div class="lean lean-' + (m.lean === 'UP' ? 'up' : 'down') + '">Direction: ' + m.lean + (m.lean === 'UP' ? ' ▲' : ' ▼') + '</div>'
        : '';
      const countdownHtml = m.closeTime
        ? '<div class="countdown" data-close="' + m.closeTime + '">Cycle closes in --:--</div>'
        : '';
      const reasonsHtml = (m.reasons && m.reasons.length)
        ? '<ul class="reasons">' + m.reasons.map(r => '<li>' + r + '</li>').join('') + '</ul>'
        : '';
      const sparklineHtml = sparklineSvg(m.sparkline, m.strike);
      const dataStale = (Date.now() - m.updatedAt) > 60000;
      const staleDataHtml = dataStale
        ? '<div class="data-stale">Data may be stale - last updated ' + Math.round((Date.now() - m.updatedAt) / 1000) + 's ago</div>'
        : '';
      const pos = currentPosition(m.symbol);
      const cycleEnded = !!(pos && pos.closeTime && new Date(pos.closeTime).getTime() <= Date.now());
      const stale = isStale(pos);
      const exitHtml = (pos && !cycleEnded && !stale && m.exitAdvice && m.exitAdvice !== 'NEUTRAL')
        ? '<div class="exit-advice exit-' + m.exitAdvice.toLowerCase().replace(/_/g,'-') + '">' + m.exitReason + '</div>'
        : '';
      const positionLabel = stale
        ? 'Stale - no contract match, close manually below'
        : cycleEnded
          ? 'Settling...'
          : (pos && pos.signal === 'BUY_YES' ? 'HOLDING UP (YES) ▲' : 'HOLDING DOWN (NO) ▼');
      const posHtml = pos
        ? '<div class="position position-' + (pos.signal === 'BUY_YES' ? 'yes' : 'no') + (cycleEnded ? ' position-settling' : '') + (stale ? ' position-stale' : '') + '">' +
            'Your position: ' + positionLabel +
          '</div>' +
          exitHtml +
          '<div class="position-actions">' +
            '<button onclick="closePosition(\\'' + m.symbol + '\\',\\'win\\')">Won</button>' +
            '<button onclick="closePosition(\\'' + m.symbol + '\\',\\'loss\\')">Lost</button>' +
          '</div>'
        : '<div class="position-actions">' +
            '<button onclick="enterPosition(\\'' + m.symbol + '\\',\\'BUY_YES\\',\\'' + (m.ticker||'') + '\\',\\'' + (m.closeTime||'') + '\\',' + (m.payout||1) + ')">Enter YES</button>' +
            '<button onclick="enterPosition(\\'' + m.symbol + '\\',\\'BUY_NO\\',\\'' + (m.ticker||'') + '\\',\\'' + (m.closeTime||'') + '\\',' + (m.payout||1) + ')">Enter NO</button>' +
          '</div>';
      return '<div class="card ' + (isPaper ? 'paper' : '') + '">' +
        '<div class="symbol">' + m.symbol + '</div>' +
        '<div class="signal ' + signalClass + '">' + signalText + '</div>' +
        leanHtml +
        countdownHtml +
        staleDataHtml +
        (isPaper && hasSignal ? '<div class="unvalidated-note">Unvalidated backtest - not live-tradeable</div>' : '') +
        reasonsHtml +
        sparklineHtml +
        posHtml +
        '<div class="stats">' +
          '<div><span class="stat-label">Price</span>$' + Number(m.spotPrice).toFixed(m.spotPrice < 1 ? 4 : 2) + '</div>' +
          '<div><span class="stat-label">Prob</span>' + (m.impliedProb*100).toFixed(0) + '%</div>' +
          '<div><span class="stat-label">Payout</span>' + m.payout.toFixed(2) + 'x</div>' +
        '</div>' +
        whaleHtml +
      '</div>';
    }).join('');
    updateCountdowns();
  } catch (e) { console.error(e); }
}
function updateCountdowns() {
  document.querySelectorAll('.countdown').forEach(el => {
    const closeMs = new Date(el.dataset.close).getTime();
    const remaining = Math.max(0, Math.floor((closeMs - Date.now()) / 1000));
    const mm = Math.floor(remaining / 60);
    const ss = remaining % 60;
    el.textContent = remaining > 0
      ? 'Cycle closes in ' + mm + ':' + String(ss).padStart(2, '0')
      : 'Cycle closed - refreshing...';
  });
}
refresh();
checkSettlements();
setInterval(refresh, 20000);
setInterval(checkSettlements, 20000);
setInterval(updateCountdowns, 1000);
function setResult(index, result) {
  const log = getLog();
  log[index].result = result;
  saveLog(log);
  renderLog();
}
function renderLog() {
  const log = getLog();
  document.getElementById('statCount').textContent = log.length;
  const settled = log.filter(t => t.result !== 'pending');
  const wins = settled.filter(t => t.result === 'win').length;
  document.getElementById('statWinRate').textContent = settled.length ? Math.round(wins/settled.length*100) + '%' : '-';
  let streak = 0, streakType = null;
  for (const t of settled) {
    if (t.result === streakType || streakType === null) { streak++; streakType = t.result; }
    else break;
  }
  document.getElementById('statStreak').textContent = streak ? streak + (streakType === 'win' ? 'W' : 'L') : '-';
  document.getElementById('logBody').innerHTML = log.map((t, i) =>
    '<tr><td>' + t.symbol + '</td><td>' + t.signal.replace('_',' ') + '</td><td>' +
    (t.result === 'pending'
      ? '<button onclick="setResult(' + i + ',\\'win\\')" style="margin-right:4px">Win</button><button onclick="setResult(' + i + ',\\'loss\\')">Loss</button>'
      : '<span class="' + t.result + '">' + t.result.toUpperCase() + '</span>') +
    '</td><td>' + t.time + '</td></tr>'
  ).join('');
}
renderLog();

// --- Risk guardrails (localStorage, per-browser) ---
// Reuses the backend's existing Guardrails class/route - this just feeds
// it real numbers derived from your actual logged trades (settled results
// + the payout recorded at entry) instead of asking you to track it by hand.
function getGuardrailSettings() {
  return JSON.parse(localStorage.getItem('guardrailSettings') || '{"bankroll":1000,"stake":50}');
}
function saveGuardrailSettings() {
  const bankroll = parseFloat(document.getElementById('bankrollInput').value) || 1000;
  const stake = parseFloat(document.getElementById('stakeInput').value) || 50;
  localStorage.setItem('guardrailSettings', JSON.stringify({ bankroll, stake }));
  refreshGuardrails();
}
function computeConsecutiveLosses(log) {
  let count = 0;
  for (const entry of log) {
    if (entry.result === 'pending') continue;
    if (entry.result === 'loss') { count++; continue; }
    break;
  }
  return count;
}
function computeDailyPnl(log, stake) {
  const today = new Date().toDateString();
  let pnl = 0;
  for (const entry of log) {
    if (entry.result !== 'win' && entry.result !== 'loss') continue;
    if (new Date(entry.time).toDateString() !== today) continue;
    pnl += entry.result === 'win' ? stake * ((entry.payout || 1.2) - 1) : -stake;
  }
  return pnl;
}
async function refreshGuardrails() {
  const settings = getGuardrailSettings();
  const bankrollEl = document.getElementById('bankrollInput');
  const stakeEl = document.getElementById('stakeInput');
  if (bankrollEl && document.activeElement !== bankrollEl) bankrollEl.value = settings.bankroll;
  if (stakeEl && document.activeElement !== stakeEl) stakeEl.value = settings.stake;
  const log = getLog();
  const consecutiveLosses = computeConsecutiveLosses(log);
  const dailyPnl = computeDailyPnl(log, settings.stake);
  try {
    const res = await fetch('/api/guardrails/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bankroll: settings.bankroll, dailyPnl, consecutiveLosses, proposedStake: settings.stake })
    });
    const data = await res.json();
    const el = document.getElementById('guardrailsStatus');
    const summary = 'Today\\'s P/L: $' + dailyPnl.toFixed(2) + ' - Consecutive losses: ' + consecutiveLosses;
    if (data.allowed) {
      el.className = 'guardrails-status guardrails-ok';
      el.innerHTML = 'OK to trade at $' + settings.stake + ' stake. ' + summary;
    } else {
      el.className = 'guardrails-status guardrails-blocked';
      el.innerHTML = data.reasons.join(' ') + ' ' + summary;
    }
  } catch (e) { console.error(e); }
}
refreshGuardrails();
setInterval(refreshGuardrails, 20000);
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`kalshi-markets running on :${PORT}`));
