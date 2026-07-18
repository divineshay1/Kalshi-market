/**
 * Per-market configuration.
 *
 * IMPORTANT: Do not assume BTC's rule set works for DOGE or SOL.
 * Each asset has different volatility, spread behavior, and volume on Kalshi.
 * Every new asset should be backtested independently before its thresholds
 * are trusted (see backend/core/backtest.js once ported over from
 * kalshi-backtest).
 *
 * gapMin           - min $ gap between spot price and strike to consider entry
 * winProbRange     - [min, max] implied win probability window for entry
 * payoutMin        - minimum payout multiple to bother entering
 * windowScanMode   - "full" scans the entire contract window for entries,
 *                    not just a fixed early window
 * status           - "validated" (backtested + trusted), "candidate" (rules
 *                    guessed/ported, NOT yet backtested), or "disabled"
 */

const MARKETS = {
  BTC: {
    label: "Bitcoin 15m",
    kalshiSeries: "KXBTC15M",
    gapMin: 8,
    winProbRange: [0.55, 0.65],
    payoutMin: 1.2,
    windowScanMode: "full",
    status: "validated", // this is the rule set you've already backtested
  },

  DOGE: {
    label: "Dogecoin 15m",
    kalshiSeries: "KXDOGE15M", // confirmed pattern: matches KXBTC15M / KXETH15M naming
    gapMin: null, // TODO: needs its own backtest - do not guess a number
    winProbRange: [0.55, 0.65], // placeholder, inherited from BTC, unvalidated
    payoutMin: 1.2,
    windowScanMode: "full",
    status: "candidate",
  },

  SOL: {
    label: "Solana 15m",
    kalshiSeries: "KXSOL15M", // confirmed pattern
    gapMin: null, // TODO: needs its own backtest
    winProbRange: [0.55, 0.65], // placeholder, unvalidated
    payoutMin: 1.2,
    windowScanMode: "full",
    status: "candidate",
  },

  ETH: {
    label: "Ethereum 15m",
    kalshiSeries: "KXETH15M", // confirmed via Kalshi API docs / public bots
    gapMin: null, // TODO: needs its own backtest
    winProbRange: [0.55, 0.65], // placeholder, unvalidated
    payoutMin: 1.2,
    windowScanMode: "full",
    status: "candidate",
  },

  HYPE: {
    label: "Hyperliquid 15m",
    kalshiSeries: "KXHYPE15M", // confirmed pattern - Kalshi lists a real 15m HYPE market
    gapMin: null, // TODO: needs its own backtest
    winProbRange: [0.55, 0.65], // placeholder, unvalidated
    payoutMin: 1.2,
    windowScanMode: "full",
    status: "candidate",
  },
};

// Safety: never let the live scanner trade a market whose rules haven't
// been backtested. "candidate" markets show up in the dashboard as
// signal-only / paper, never as live trade triggers, until you flip
// them to "validated" yourself.
function isLiveEligible(symbol) {
  return MARKETS[symbol]?.status === "validated";
}

module.exports = { MARKETS, isLiveEligible };
