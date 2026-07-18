/**
 * Spot price filler.
 *
 * Run this AFTER pullHistory.js. Fills in the spotPriceAtEntry field that
 * pullHistory.js leaves null, by pulling matching 1-minute candles from
 * Binance's public klines endpoint (no auth needed) and aligning them to
 * each row's timestamp.
 *
 * Also runs outside this sandbox - Binance's API isn't reachable from here
 * either. Run locally or on Render, same as pullHistory.js.
 *
 * Usage:
 *   node fillSpotPrices.js DOGE
 *
 * CAVEAT (be honest with yourself about this before trusting the backtest):
 * Kalshi settles against its own reference index, which is typically an
 * average over a short window (e.g. last 60 seconds) sourced from multiple
 * exchanges - not a single raw Binance print. Using Binance spot as a proxy
 * for "spotPriceAtEntry" is a reasonable approximation for gap-based entry
 * logic (you're looking for a meaningful price/strike gap, not matching
 * Kalshi's settlement calc to the cent), but it is an approximation.
 * Check each series' settlement_sources via GET /series/{series_ticker}
 * if you want to tighten this further.
 */

const BINANCE_BASE = "https://api.binance.com/api/v3/klines";

const BINANCE_SYMBOL_MAP = {
  BTC: "BTCUSDT",
  DOGE: "DOGEUSDT",
  SOL: "SOLUSDT",
  ETH: "ETHUSDT",
  HYPE: "HYPEUSDT", // confirm this pair exists on Binance - if not, fall back to Bybit/Coinbase
};

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

// Binance klines are capped at 1000 per request, so page through the range.
async function fetchKlines(symbol, startMs, endMs) {
  let out = [];
  let cursor = startMs;

  while (cursor < endMs) {
    const url = new URL(BINANCE_BASE);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", "1m");
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("endTime", String(endMs));
    url.searchParams.set("limit", "1000");

    const batch = await fetchJson(url.toString());
    if (!batch.length) break;
    out = out.concat(batch);

    const lastOpenTime = batch[batch.length - 1][0];
    cursor = lastOpenTime + 60_000;
    await new Promise((r) => setTimeout(r, 200));
  }

  return out; // each row: [openTime, open, high, low, close, volume, closeTime, ...]
}

function closestClose(klines, targetMs) {
  if (klines.length === 0) return null;
  let best = klines[0];
  let bestDiff = Math.abs(best[0] - targetMs);
  for (const k of klines) {
    const diff = Math.abs(k[0] - targetMs);
    if (diff < bestDiff) {
      best = k;
      bestDiff = diff;
    }
  }
  // guard against matching a candle that's wildly far from the target
  // (e.g. gaps in Binance data) - 5 minutes is a generous tolerance
  if (bestDiff > 5 * 60_000) return null;
  return parseFloat(best[4]); // close price
}

async function main() {
  const symbol = process.argv[2];
  if (!symbol || !BINANCE_SYMBOL_MAP[symbol]) {
    console.error(`Usage: node fillSpotPrices.js <${Object.keys(BINANCE_SYMBOL_MAP).join("|")}>`);
    process.exit(1);
  }

  const fs = require("fs");
  const path = require("path");
  const inPath = path.join(__dirname, "..", "data", `${symbol}-history.json`);
  if (!fs.existsSync(inPath)) {
    console.error(`Missing ${inPath} - run pullHistory.js ${symbol} first.`);
    process.exit(1);
  }

  const rows = JSON.parse(fs.readFileSync(inPath, "utf8"));
  if (rows.length === 0) {
    console.error("No rows to process.");
    process.exit(1);
  }

  const timestamps = rows.map((r) => new Date(r.timestamp).getTime());
  const startMs = Math.min(...timestamps) - 5 * 60_000;
  const endMs = Math.max(...timestamps) + 5 * 60_000;

  console.log(`Fetching Binance klines for ${BINANCE_SYMBOL_MAP[symbol]}...`);
  const klines = await fetchKlines(BINANCE_SYMBOL_MAP[symbol], startMs, endMs);
  console.log(`Fetched ${klines.length} 1m candles.`);

  let filled = 0;
  let skipped = 0;

  for (const row of rows) {
    const targetMs = new Date(row.timestamp).getTime() + 3 * 60_000; // matches ENTRY_MINUTE=3 in pullHistory.js
    const price = closestClose(klines, targetMs);
    if (price == null) {
      skipped += 1;
      continue;
    }
    row.spotPriceAtEntry = price;
    filled += 1;
  }

  const usable = rows.filter((r) => r.spotPriceAtEntry != null);
  fs.writeFileSync(inPath, JSON.stringify(usable, null, 2));

  console.log(`\nFilled ${filled} rows, skipped ${skipped} (no matching candle within tolerance).`);
  console.log(`Wrote ${usable.length} usable rows back to ${inPath}.`);
  console.log(`\nThis file is now ready for backend/core/strategyDiscovery.js's walkForwardValidate().`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
