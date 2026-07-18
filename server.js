/**
 * server.js
 *
 * Serves the backtest UI and exposes:
 *   GET  /api/markets?series=KXBTC15M&limit=50   -> list recent/settled markets in a series
 *   GET  /api/backtest?series=KXBTC15M&limit=50  -> fetches history for those markets,
 *                                                     runs the rule engine, returns results
 *
 * Kalshi's public REST API (no auth needed for market data) is used to pull:
 *   - market metadata (strike price, open/close time, settlement result)
 *   - historical trade/candlestick data for each market
 *
 * NOTE: Kalshi's API endpoints and exact field names can shift over time.
 * If a fetch fails, check https://trading-api.readme.io/ (Kalshi's API docs)
 * for the current endpoint shape and adjust KALSHI_BASE / paths below.
 */

const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');
const { runBacktest } = require('./ruleEngine');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const KALSHI_BASE = 'https://trading-api.kalshi.com/trade-api/v2';
const PORT = process.env.PORT || 3000;

// ---- Helpers -----------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Kalshi API error ${res.status} on ${url}`);
  }
  return res.json();
}

/**
 * Pulls a batch of settled markets for a series (e.g. KXBTC15M) so we have
 * real strike prices, windows, and settlement outcomes to backtest against.
 */
async function fetchSettledMarkets(series, limit) {
  const url = `${KALSHI_BASE}/markets?series_ticker=${series}&status=settled&limit=${limit}`;
  const data = await fetchJson(url);
  return data.markets || [];
}

/**
 * Pulls candlestick/trade history for a single market so we can replay
 * price action minute-by-minute (or at whatever resolution Kalshi returns).
 */
async function fetchMarketCandles(marketTicker) {
  const url = `${KALSHI_BASE}/markets/${marketTicker}/history`;
  const data = await fetchJson(url);
  // Normalize Kalshi's history payload into { time, price, upProb, downProb, upPayout, downPayout }
  return (data.history || []).map(point => {
    const yesPrice = point.yes_price / 100; // cents -> probability (0-1)
    const noPrice = 1 - yesPrice;
    return {
      time: point.ts ? new Date(point.ts * 1000).toISOString() : point.timestamp,
      price: point.underlying_price ?? point.price, // BTC/USD spot at that tick, if provided
      upProb: yesPrice,
      downProb: noPrice,
      upPayout: yesPrice > 0 ? Number((1 / yesPrice).toFixed(3)) : null,
      downPayout: noPrice > 0 ? Number((1 / noPrice).toFixed(3)) : null,
    };
  });
}

// ---- Routes -------------------------------------------------------------

app.get('/api/markets', async (req, res) => {
  try {
    const series = req.query.series || 'KXBTC15M';
    const limit = Number(req.query.limit) || 50;
    const markets = await fetchSettledMarkets(series, limit);
    res.json({ count: markets.length, markets });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/backtest', async (req, res) => {
  try {
    const series = req.query.series || 'KXBTC15M';
    const limit = Number(req.query.limit) || 50;

    const rawMarkets = await fetchSettledMarkets(series, limit);

    const enriched = [];
    for (const m of rawMarkets) {
      try {
        const candles = await fetchMarketCandles(m.ticker);
        if (!candles.length) continue;

        enriched.push({
          marketId: m.ticker,
          targetPrice: m.strike_price ?? m.floor_strike ?? m.cap_strike,
          windowStart: m.open_time,
          windowEnd: m.close_time,
          candles,
          finalPrice: m.settlement_value ?? candles[candles.length - 1].price,
        });
      } catch (innerErr) {
        // Skip markets whose history can't be fetched rather than failing the whole batch
        console.warn(`Skipping ${m.ticker}: ${innerErr.message}`);
      }
    }

    const results = runBacktest(enriched);
    res.json(results);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Kalshi backtest tool running on port ${PORT}`);
});
