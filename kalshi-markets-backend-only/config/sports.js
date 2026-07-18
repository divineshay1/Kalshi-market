/**
 * Sports market configuration.
 *
 * Separate from config/markets.js (crypto) on purpose: sports signals
 * are win-probability-based (moneyline-style), not gap-from-strike based,
 * so the evaluation logic is genuinely different, not just a reskin.
 *
 * status follows the same convention as crypto markets: "candidate" means
 * untested, never a live signal until backtested and manually flipped.
 */

const SPORTS = {
  MLB: {
    label: "MLB Game Winner",
    category: "Baseball",
    hasPlayerStatsMilestones: false, // unconfirmed - test against a live milestone_id
    status: "candidate",
  },
  ATP: {
    label: "ATP Match Winner",
    category: "Tennis",
    hasPlayerStatsMilestones: false, // unconfirmed
    status: "candidate",
  },
  WTA: {
    label: "WTA Match Winner",
    category: "Tennis",
    hasPlayerStatsMilestones: false, // unconfirmed
    status: "candidate",
  },
};

module.exports = { SPORTS };
