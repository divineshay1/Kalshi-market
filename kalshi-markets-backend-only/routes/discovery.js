const express = require("express");
const fs = require("fs");
const path = require("path");
const { walkForwardValidate } = require("../core/strategyDiscovery");

const router = express.Router();

/**
 * POST /api/discover-strategy
 * body: { symbol: "DOGE", history: [ {timestamp, spotPriceAtEntry, strike,
 *         impliedProbAtEntry, payoutAtEntry, outcome}, ... ] }
 *
 * Returns walk-forward validated params, or a status explaining why the
 * data isn't sufficient / the edge didn't hold up. This never auto-flips
 * a market's status in config/markets.js - that's a manual, deliberate step
 * you take after reviewing the results.
 */
router.post("/discover-strategy", (req, res) => {
  const { symbol, history } = req.body;

  if (!symbol || !Array.isArray(history)) {
    return res.status(400).json({ error: "symbol and history[] are required" });
  }

  const result = walkForwardValidate(history);
  res.json({ symbol, ...result });
});

/**
 * GET /api/discover-strategy/:symbol
 * Reads backend/data/{symbol}-history.json (produced by pullHistory.js +
 * fillSpotPrices.js) and runs the same walk-forward validation, without
 * needing to post the file manually.
 */
router.get("/discover-strategy/:symbol", (req, res) => {
  const { symbol } = req.params;
  const dataPath = path.join(__dirname, "..", "data", `${symbol}-history.json`);

  if (!fs.existsSync(dataPath)) {
    return res.status(404).json({
      error: `No data file for ${symbol}. Run: node scripts/pullHistory.js ${symbol} && node scripts/fillSpotPrices.js ${symbol}`,
    });
  }

  const history = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  const result = walkForwardValidate(history);
  res.json({ symbol, rowCount: history.length, ...result });
});

module.exports = router;
