/**
 * kalshi-markets - complete single-file backend + dashboard.
 * Uses Binance for spot prices (CoinGecko's free tier rate-limits too
 * aggressively for a 20s polling loop - Binance's public endpoints don't).
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
const BINANCE_BASE = "https://api.binance.com/api/v3";

// ---------- MARKET CONFIG ----------
const MARKETS = {
  BTC: { label: "Bitcoin 15m", kalshiSeries: "KXBTC15M", binanceSymbol: "BTCUSDT", gapMin: 8, winProbRange: [0.55, 0.65], payoutMin: 1.2, status: "validated" },
  DOGE: { label: "Dogecoin 15m", kalshiSeries: "KXDOGE15M", binanceSymbol: "DOGEUSDT", gapMin: null, winProbRange: [0.55, 0.65], payoutMin: 1.2, status: "candidate" },
  SOL: { label: "Solana 15m", kalshiSeries: "KXSOL15M", binanceSymbol: "SOLUSDT", gapMin: null, winProbRange: [0.55, 0.65], payoutMin: 1.2, status: "candidate" },
  ETH: { label: "Ethereum 15m", kalshiSeries: "KXETH15M", binanceSymbol: "ETHUSDT", gapMin: null, winProbRange: [0.55, 0.65], payoutMin: 1.2, status: "candidate" },
  HYPE: { label: "Hyperliquid 15m", kalshiSeries: "KXHYPE15M", binanceSymbol: "HYPEUSDT", gapMin: null, winProbRange: [0.55, 0.65], payoutMin: 1.2, status: "candidate" },
};
function isLiveEligible(symbol) { return MARKETS[symbol]?.status === "validated"; }

const SPORTS = {
  MLB: { label: "MLB Game Winner", category: "Baseball", status: "candidate" },
  ATP: { label: "ATP Match Winner", category: "Tennis", status: "candidate" },
  WTA: { label: "WTA Match Winner", category: "Tennis", status: "candidate" },
};

// ---------- SCANNER ----------
function evaluateEntry({ symbol, spotPrice, strike, impliedProb, payout }) {
  const cfg = MARKETS[symbol];
  if (!cfg) return { signal: "STAND_ASIDE", reasons: [`Unknown market: ${symbol}`] };
  if (cfg.gapMin === null) {
    return { signal: "PAPER_ONLY", reasons: [`${cfg.label} has no validated rule set yet.`], mode: "paper-only" };
  }
  const gap = Math.abs(spotPrice - strike);
  const reasons = [];
  let pass = true;
  if (gap < cfg.gapMin) { pass = false; reasons.push(`Gap $${gap.toFixed(2)} below $${cfg.gapMin} min.`); }
  const [loP, hiP] = cfg.winProbRange;
  if (impliedProb < loP || impliedProb > hiP) { pass = false; reasons.push(`Win prob ${(impliedProb*100).toFixed(1)}% outside window.`); }
  if (payout < cfg.payoutMin) { pass = false; reasons.push(`Payout ${payout.toFixed(2)}x below min.`); }
  if (!pass) return { signal: "HOLD", reasons, mode: isLiveEligible(symbol) ? "live" : "paper-only" };
  return { signal: spotPrice > strike ? "BUY_YES" : "BUY_NO", reasons: ["All entry conditions met."], mode: isLiveEligible(symbol) ? "live" : "paper-only" };
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
async function pollMarket(symbol) {
  const cfg = MARKETS[symbol];
  try {
    const priceRes = await fetch(`${BINANCE_BASE}/ticker/price?symbol=${cfg.binanceSymbol}`);
    if (!priceRes.ok) throw new Error(`Binance ${priceRes.status}`);
    const priceData = await priceRes.json();
    const spotPrice = parseFloat(priceData.price);

    const kalshiRes = await fetch(`${KALSHI_BASE}/markets?series_ticker=${cfg.kalshiSeries}&status=open&limit=1`);
    const kalshiData = await kalshiRes.json();
    const market = kalshiData.markets?.[0];

    if (!market || !spotPrice) {
      liveState[symbol] = { symbol, error: "No open market or price found", updatedAt: Date.now() };
      return;
    }

    const strike = market.floor_strike ?? market.cap_strike ?? spotPrice;
    const impliedProb = parseFloat(market.last_price_dollars || market.yes_bid_dollars || 0.5);
    const payout = impliedProb > 0 ? 1 / impliedProb : 1;

    const evalResult = evaluateEntry({ symbol, spotPrice, strike, impliedProb, payout });
    liveState[symbol] = { symbol, spotPrice, strike, impliedProb, payout, ...evalResult, updatedAt: Date.now() };
  } catch (err) {
    liveState[symbol] = { symbol, error: err.message, updatedAt: Date.now() };
  }
}
function pollAllMarkets() { Object.keys(MARKETS).forEach(pollMarket); }
pollAllMarkets();
setInterval(pollAllMarkets, 20000);

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

  <footer>Educational tooling - not financial advice - signals are probabilistic, never certain</footer>
</div>
<script>
async function refresh() {
  try {
    const res = await fetch('/api/live-status');
    const data = await res.json();
    const el = document.getElementById('markets');
    el.innerHTML = Object.values(data).map(m => {
      if (m.error) return '<div class="card"><div class="symbol">' + m.symbol + '</div><div class="label">Error: ' + m.error + '</div></div>';
      const isPaper = m.mode === 'paper-only';
      return '<div class="card ' + (isPaper ? 'paper' : '') + '">' +
        '<div class="symbol">' + m.symbol + '</div>' +
        '<div class="signal ' + (m.signal === 'HOLD' ? 'hold' : '') + '">' + (isPaper ? 'Paper only' : m.signal.replace('_',' ')) + '</div>' +
        '<div class="stats">' +
          '<div><span class="stat-label">Price</span>$' + Number(m.spotPrice).toFixed(m.spotPrice < 1 ? 4 : 2) + '</div>' +
          '<div><span class="stat-label">Prob</span>' + (m.impliedProb*100).toFixed(0) + '%</div>' +
          '<div><span class="stat-label">Payout</span>' + m.payout.toFixed(2) + 'x</div>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch (e) { console.error(e); }
}
refresh();
setInterval(refresh, 20000);

// --- Trade log (localStorage, per-browser) ---
function getLog() { return JSON.parse(localStorage.getItem('tradeLog') || '[]'); }
function saveLog(log) { localStorage.setItem('tradeLog', JSON.stringify(log)); }
function logTrade() {
  const symbol = document.getElementById('logSymbol').value;
  const signal = document.getElementById('logSignal').value;
  const log = getLog();
  log.unshift({ symbol, signal, result: 'pending', time: new Date().toLocaleString() });
  saveLog(log);
  renderLog();
}
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
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`kalshi-markets running on :${PORT}`));
