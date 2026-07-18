# Kalshi BTC 15-Min Backtest Tool

Pulls settled KXBTC15M (or KXBTCD) markets from Kalshi's public API, replays
price history through your rule engine, and shows every point in each
market's window where a valid signal would have fired — plus what would
have happened if you'd taken it.

## Current rule set (`ruleEngine.js`)

- **No fixed entry-time cutoff** — the whole 15-min window is scanned
- **Gap:** price must be $8+ from the target/strike
- **Win probability:** 55%–65% implied by the market
- **Payout:** 1.20x–1.30x (a 20–30% profit target does the gatekeeping
  that the old 2-minute timer used to do)

Edit the `RULES` object at the top of `ruleEngine.js` any time you want to
tune these — everything downstream (server + UI) reads from that object.

## Project structure

```
kalshi-backtest/
├── server.js        # Express server + Kalshi API fetch layer
├── ruleEngine.js     # Your rule logic, isolated so it's easy to tweak
├── package.json
└── public/
    └── index.html    # Dark plum/rose dashboard UI
```

## Run locally

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## Deploy to Render (matches your existing kalshi-btc-tool setup)

1. Push this folder to a new GitHub repo (or a folder in an existing one).
2. In Render: **New → Web Service** → connect the repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. No environment variables needed — Kalshi's market-data endpoints used
   here are public and don't require an API key.

## Notes on the Kalshi API layer

`server.js` hits `https://trading-api.kalshi.com/trade-api/v2`:

- `GET /markets?series_ticker=...&status=settled` — pulls settled markets
  (strike price, open/close time, settlement outcome)
- `GET /markets/{ticker}/history` — pulls candlestick/trade history for
  a single market

Kalshi has adjusted field names and endpoint paths before. If a fetch
starts failing, check `https://trading-api.readme.io/` for the current
shape and adjust the field mapping inside `fetchMarketCandles()` —
that's the only place raw Kalshi fields get translated into the shape
the rule engine expects (`time`, `price`, `upProb`, `downProb`,
`upPayout`, `downPayout`).

## What "backtest" means here

For every settled market pulled, the tool walks through its full price
history and checks each point against the rules above. Every point that
clears all four conditions gets logged as a signal with its outcome
(WIN/LOSS, graded against the market's actual settlement) and simulated
P&L per $1 staked. The summary cards roll all of that up into an overall
win rate and total P&L across the batch you ran.
