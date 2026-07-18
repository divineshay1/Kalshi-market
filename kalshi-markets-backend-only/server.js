const express = require("express");
const { evaluateEntry } = require("./core/scanner");
const { MARKETS } = require("./config/markets");
const discoveryRoutes = require("./routes/discovery");
const sportsRoutes = require("./routes/sports");

const app = express();

// CORS: needed so a browser-based frontend (artifact, Vercel site, etc.)
// on a different origin can actually call this API. Locked to GET/POST
// only since that's all this API exposes.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: "10mb" })); // history payloads can be sizable
app.use("/api", discoveryRoutes);
app.use("/api", sportsRoutes);

// GET /api/markets - list configured markets and whether they're live-eligible
app.get("/api/markets", (req, res) => {
  res.json(MARKETS);
});

// POST /api/scan - evaluate a live snapshot against a market's rules
// body: { symbol, spotPrice, strike, impliedProb, payout, secondsRemaining }
app.post("/api/scan", (req, res) => {
  const result = evaluateEntry(req.body);
  res.json(result);
});

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`kalshi-markets backend running on :${PORT}`));
