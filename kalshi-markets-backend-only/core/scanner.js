/**
 * Shared scanning engine.
 *
 * This is the reusable core: given a market's config and a live price
 * snapshot, it evaluates entry conditions across the FULL contract window
 * (not a fixed 2-minute slice), and returns one of:
 *   BUY / SELL / HOLD / STAND_ASIDE
 * with the reasoning attached, so the dashboard can show *why*, not just
 * a flashing signal.
 *
 * NOTE: This does not place trades. It returns a recommendation object.
 * Execution is a separate, explicit step (see routes/trade.js, not yet built).
 */

const { MARKETS, isLiveEligible } = require("../config/markets");

function evaluateEntry({ symbol, spotPrice, strike, impliedProb, payout, secondsRemaining }) {
  const cfg = MARKETS[symbol];
  if (!cfg) {
    return { signal: "STAND_ASIDE", reason: `Unknown market: ${symbol}` };
  }

  if (cfg.gapMin === null) {
    return {
      signal: "STAND_ASIDE",
      reason: `${cfg.label} has no validated rule set yet - needs its own backtest before this becomes a live signal.`,
      mode: "paper-only",
    };
  }

  const gap = Math.abs(spotPrice - strike);
  const reasons = [];
  let pass = true;

  if (gap < cfg.gapMin) {
    pass = false;
    reasons.push(`Gap $${gap.toFixed(2)} is below the $${cfg.gapMin} minimum for ${symbol}.`);
  }

  const [loP, hiP] = cfg.winProbRange;
  if (impliedProb < loP || impliedProb > hiP) {
    pass = false;
    reasons.push(
      `Implied win probability ${(impliedProb * 100).toFixed(1)}% is outside the ${(loP * 100).toFixed(
        0
      )}-${(hiP * 100).toFixed(0)}% window.`
    );
  }

  if (payout < cfg.payoutMin) {
    pass = false;
    reasons.push(`Payout ${payout.toFixed(2)}x is below the ${cfg.payoutMin}x minimum.`);
  }

  if (!pass) {
    return { signal: "HOLD", reasons, mode: isLiveEligible(symbol) ? "live" : "paper-only" };
  }

  return {
    signal: spotPrice > strike ? "BUY_YES" : "BUY_NO",
    reasons: [`All entry conditions met for ${symbol}: gap $${gap.toFixed(2)}, win prob ${(impliedProb * 100).toFixed(1)}%, payout ${payout.toFixed(2)}x.`],
    mode: isLiveEligible(symbol) ? "live" : "paper-only",
    secondsRemaining,
  };
}

module.exports = { evaluateEntry };
