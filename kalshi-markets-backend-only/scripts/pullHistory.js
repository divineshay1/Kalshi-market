/**
 * Historical data puller.
 *
 * Run this LOCALLY or on Render - Kalshi's API is not reachable from
 * inside this sandbox. No API key needed for public market data.
 *
 * Usage:
 *   node pullHistory.js DOGE
 *   node pullHistory.js SOL
 *   node pullHistory.js ETH
 *   node pullHistory.js HYPE
 *
 * Output: writes backend/data/{symbol}-history.json in the exact shape
 * strategyDiscovery.js's walkForwardValidate() expects:
 *   { timestamp, spotPriceAtEntry, strike, impliedProbAtEntry, payoutAtEntry, outcome }
 *
 * How "entry" is defined here: ENTRY_MINUTE minutes into each 15-minute
 * window (default 3 - mirrors scanning early but not at the very open,
 * matching the "full window scan" philosophy: adjust freely, this is a
 * parameter you should experiment with, not gospel).
 */

const BASE = "https://external-api.kalshi.com/trade-api/v2";
const ENTRY_MINUTE = 3; // minutes into the 15m window to sample as "entry"

const SERIES_MAP = {
  BTC: "KXBTC15M",
  DOGE: "KXDOGE15M",
  SOL: "KXSOL15M",
  ETH: "KXETH15M",
  HYPE: "KXHYPE15M",
};

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} for ${url}`);
  }
  return res.json();
}

// Pulls settled markets for a series. Paginates via cursor.
async function fetchSettledMarkets(seriesTicker, maxPages = 20) {
  let markets = [];
  let cursor = null;

  for (let page = 0; page < maxPages; page++) {
    const url = new URL(`${BASE}/markets`);
    url.searchParams.set("series_ticker", seriesTicker);
    url.searchParams.set("status", "settled");
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);

    const data = await fetchJson(url.toString());
    markets = markets.concat(data.markets || []);
    cursor = data.cursor;
    if (!cursor || !data.markets || data.markets.length === 0) break;

    // gentle on rate limits
    await new Promise((r) => setTimeout(r, 250));
  }

  return markets;
}

// Pulls 1-minute candlesticks for a single market and returns the
// candle closest to ENTRY_MINUTE minutes after open.
async function fetchEntryCandle(seriesTicker, marketTicker, openTs, closeTs) {
  const url = new URL(`${BASE}/series/${seriesTicker}/markets/${marketTicker}/candlesticks`);
  url.searchParams.set("start_ts", String(openTs));
  url.searchParams.set("end_ts", String(closeTs));
  url.searchParams.set("period_interval", "1");

  const data = await fetchJson(url.toString());
  const candles = data.candlesticks || [];
  if (candles.length === 0) return null;

  const targetTs = openTs + ENTRY_MINUTE * 60;
  // closest candle to target entry time
  return candles.reduce((closest, c) =>
    Math.abs(c.end_period_ts - targetTs) < Math.abs(closest.end_period_ts - targetTs) ? c : closest
  );
}

function toDollars(v) {
  return v == null ? null : parseFloat(v);
}

async function buildHistory(symbol) {
  const seriesTicker = SERIES_MAP[symbol];
  if (!seriesTicker) throw new Error(`Unknown symbol: ${symbol}`);

  console.log(`Fetching settled markets for ${seriesTicker}...`);
  const markets = await fetchSettledMarkets(seriesTicker);
  console.log(`Found ${markets.length} settled markets.`);

  const rows = [];

  for (const [i, m] of markets.entries()) {
    try {
      const openTs = Math.floor(new Date(m.open_time).getTime() / 1000);
      const closeTs = Math.floor(new Date(m.close_time).getTime() / 1000);

      const candle = await fetchEntryCandle(seriesTicker, m.ticker, openTs, closeTs);
      if (!candle || !candle.price) continue;

      // price.mean_dollars is the contract's own YES price at that candle -
      // treat it as the implied probability (Kalshi prices are already 0-1 scaled in dollars)
      const impliedProb = toDollars(candle.price.mean_dollars ?? candle.price.close_dollars);
      if (impliedProb == null) continue;

      const strike = m.floor_strike ?? m.cap_strike ?? null;
      if (strike == null) continue;

      // payout: buying at impliedProb, contract settles at $1 if correct
      const payoutAtEntry = impliedProb > 0 ? 1 / impliedProb : null;
      if (!payoutAtEntry) continue;

      rows.push({
        timestamp: m.open_time,
        spotPriceAtEntry: null, // fill in from your BTC puller's spot-feed step - see note below
        strike,
        impliedProbAtEntry: impliedProb,
        payoutAtEntry,
        outcome: m.result === "yes" ? "YES" : "NO",
      });

      if (i % 50 === 0) console.log(`  processed ${i}/${markets.length}`);
    } catch (err) {
      console.warn(`  skipped ${m.ticker}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 150)); // stay well under rate limits
  }

  return rows;
}

async function main() {
  const symbol = process.argv[2];
  if (!symbol || !SERIES_MAP[symbol]) {
    console.error(`Usage: node pullHistory.js <${Object.keys(SERIES_MAP).join("|")}>`);
    process.exit(1);
  }

  const rows = await buildHistory(symbol);

  const fs = require("fs");
  const path = require("path");
  const outDir = path.join(__dirname, "..", "data");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${symbol}-history.json`);
  fs.writeFileSync(outPath, JSON.stringify(rows, null, 2));

  console.log(`\nWrote ${rows.length} rows to ${outPath}`);
  console.log(
    `\nIMPORTANT: spotPriceAtEntry is null in every row - this script only pulls Kalshi's own` +
      ` contract data, not the underlying spot price. You need your existing BTC puller's spot-feed` +
      ` step (Binance/Coinbase candles at the same timestamps) to fill that field before this data` +
      ` is usable in strategyDiscovery.js, since gap = |spotPrice - strike| depends on it.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
