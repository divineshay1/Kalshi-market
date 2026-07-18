/**
 * Guardrails module.
 *
 * This is the "teach you not to overbet" layer. It doesn't place trades -
 * it evaluates whether a trade the user (or bot) wants to make is sane
 * given recent history, and returns a verdict + reasoning so the user
 * learns the "why", not just a red light.
 */

const DEFAULTS = {
  maxSingleBetPctOfBankroll: 0.05, // never risk more than 5% on one contract
  maxDailyLossPct: 0.15, // stop trading for the day past this drawdown
  maxConsecutiveLosses: 3, // force a cooldown after N losses in a row
  cooldownMinutes: 30,
};

class Guardrails {
  constructor(bankroll, opts = {}) {
    this.bankroll = bankroll;
    this.config = { ...DEFAULTS, ...opts };
    this.dailyPnl = 0;
    this.consecutiveLosses = 0;
    this.lastLossTime = null;
    this.tradeLog = [];
  }

  recordResult(pnl) {
    this.dailyPnl += pnl;
    this.tradeLog.push({ pnl, time: new Date().toISOString() });
    if (pnl < 0) {
      this.consecutiveLosses += 1;
      this.lastLossTime = Date.now();
    } else {
      this.consecutiveLosses = 0;
    }
  }

  // Call before allowing any new entry. Returns { allowed, reasons[] }
  checkEntry(proposedStake) {
    const reasons = [];
    let allowed = true;

    const maxStake = this.bankroll * this.config.maxSingleBetPctOfBankroll;
    if (proposedStake > maxStake) {
      allowed = false;
      reasons.push(
        `Stake $${proposedStake.toFixed(2)} exceeds your ${(
          this.config.maxSingleBetPctOfBankroll * 100
        ).toFixed(0)}% bankroll cap ($${maxStake.toFixed(2)}). Sizing down protects you from one bad read wiping out several good ones.`
      );
    }

    const lossPct = -this.dailyPnl / this.bankroll;
    if (lossPct >= this.config.maxDailyLossPct) {
      allowed = false;
      reasons.push(
        `Daily loss is at ${(lossPct * 100).toFixed(1)}%, past your ${(
          this.config.maxDailyLossPct * 100
        ).toFixed(0)}% stop. This is where "revenge trading" usually happens - step away.`
      );
    }

    if (this.consecutiveLosses >= this.config.maxConsecutiveLosses) {
      const cooldownEnds =
        this.lastLossTime + this.config.cooldownMinutes * 60 * 1000;
      if (Date.now() < cooldownEnds) {
        allowed = false;
        reasons.push(
          `${this.consecutiveLosses} losses in a row. Cooling down until ${new Date(
            cooldownEnds
          ).toLocaleTimeString()}. A losing streak often means the market regime shifted, not that you're "due" for a win.`
        );
      }
    }

    return { allowed, reasons };
  }

  // Simple Kelly-fraction-based suggestion, capped by the hard bankroll rule.
  // This is informational, not a live order - the user decides.
  suggestStake(winProb, payoutMultiple, kellyFraction = 0.25) {
    const b = payoutMultiple - 1;
    const kelly = (winProb * b - (1 - winProb)) / b;
    const safeKelly = Math.max(0, kelly) * kellyFraction; // fractional Kelly, less aggressive
    const maxStake = this.bankroll * this.config.maxSingleBetPctOfBankroll;
    return Math.min(this.bankroll * safeKelly, maxStake);
  }
}

module.exports = { Guardrails, DEFAULTS };
