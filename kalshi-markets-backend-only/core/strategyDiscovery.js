/**
 * Strategy discovery module.
 *
 * Purpose: derive gapMin / winProbRange / payoutMin per asset FROM DATA,
 * instead of guessing or copy-pasting BTC's numbers onto DOGE/SOL/ETH/HYPE.
 *
 * Method: grid search + walk-forward validation.
 *   1. Split historical settled markets into N sequential folds (time order
 *      matters - never shuffle, or you leak future info into training).
 *   2. For each fold: fit best params on the training slice, then test
 *      those exact params on the next (unseen) slice.
 *   3. A param set only counts as "validated" if it holds up across
 *      multiple out-of-sample folds, not just the one it was fit on.
 *
 * Input shape expected for `history` (one row per settled 15m contract):
 *   {
 *     timestamp: ISO string,
 *     spotPriceAtEntry: number,   // asset price at the moment you'd enter
 *     strike: number,
 *     impliedProbAtEntry: number, // 0-1
 *     payoutAtEntry: number,      // e.g. 1.15 = 15% return if correct
 *     outcome: "YES" | "NO",      // what actually settled
 *   }
 */

function simulateParams(history, params) {
  const { gapMin, probRange, payoutMin } = params;
  const [loP, hiP] = probRange;

  let trades = 0;
  let wins = 0;
  let totalReturn = 0; // in units of stake (1.0 = full stake)
  const returns = [];

  for (const row of history) {
    const gap = Math.abs(row.spotPriceAtEntry - row.strike);
    if (gap < gapMin) continue;
    if (row.impliedProbAtEntry < loP || row.impliedProbAtEntry > hiP) continue;
    if (row.payoutAtEntry < payoutMin) continue;

    const predictedSide = row.spotPriceAtEntry > row.strike ? "YES" : "NO";
    const won = predictedSide === row.outcome;

    trades += 1;
    if (won) wins += 1;

    const r = won ? row.payoutAtEntry - 1 : -1; // net return on stake
    totalReturn += r;
    returns.push(r);
  }

  if (trades === 0) {
    return { trades: 0, winRate: null, avgReturn: null, sharpeLike: null, totalReturn: 0 };
  }

  const winRate = wins / trades;
  const avgReturn = totalReturn / trades;
  const variance =
    returns.reduce((sum, r) => sum + (r - avgReturn) ** 2, 0) / Math.max(1, trades - 1);
  const stdDev = Math.sqrt(variance);
  const sharpeLike = stdDev > 0 ? avgReturn / stdDev : null; // return per unit of risk, not annualized

  return { trades, winRate, avgReturn, sharpeLike, totalReturn };
}

function buildGrid() {
  const gapMins = [2, 4, 6, 8, 10, 14, 20];
  const probRanges = [
    [0.5, 0.6],
    [0.55, 0.65],
    [0.6, 0.7],
    [0.55, 0.7],
  ];
  const payoutMins = [1.1, 1.15, 1.2, 1.3];

  const grid = [];
  for (const gapMin of gapMins) {
    for (const probRange of probRanges) {
      for (const payoutMin of payoutMins) {
        grid.push({ gapMin, probRange, payoutMin });
      }
    }
  }
  return grid;
}

// Splits history into `folds` sequential chunks by time, then walks forward:
// fold[0] trains -> tested on fold[1], fold[0+1] trains -> tested on fold[2], etc.
function walkForwardValidate(history, { folds = 4, minTradesPerFold = 20 } = {}) {
  const sorted = [...history].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const chunkSize = Math.floor(sorted.length / folds);
  if (chunkSize < minTradesPerFold) {
    return {
      status: "insufficient_data",
      message: `Only ${sorted.length} rows available. Need at least ${
        minTradesPerFold * folds
      } to run a ${folds}-fold walk-forward test.`,
    };
  }

  const chunks = [];
  for (let i = 0; i < folds; i++) {
    chunks.push(sorted.slice(i * chunkSize, (i + 1) * chunkSize));
  }

  const grid = buildGrid();
  const foldResults = [];

  for (let i = 0; i < chunks.length - 1; i++) {
    const trainSet = chunks.slice(0, i + 1).flat();
    const testSet = chunks[i + 1];

    // pick best params on train by avgReturn, requiring a minimum sample size
    // so we don't crown a 3-trade lucky streak the winner
    let best = null;
    for (const params of grid) {
      const res = simulateParams(trainSet, params);
      if (res.trades < minTradesPerFold) continue;
      if (!best || res.avgReturn > best.result.avgReturn) {
        best = { params, result: res };
      }
    }

    if (!best) {
      foldResults.push({ fold: i, status: "no_viable_params_on_train" });
      continue;
    }

    const testResult = simulateParams(testSet, best.params);
    foldResults.push({
      fold: i,
      trainedOn: `${trainSet.length} rows`,
      params: best.params,
      trainResult: best.result,
      testResult,
      heldUp: testResult.trades >= minTradesPerFold && testResult.avgReturn > 0,
    });
  }

  const viableFolds = foldResults.filter((f) => f.heldUp);
  const consistent =
    viableFolds.length >= Math.ceil((folds - 1) / 2); // majority of out-of-sample folds must be profitable

  return {
    status: consistent ? "candidate_for_validation" : "not_yet_reliable",
    foldResults,
    recommendation: consistent
      ? "Params were profitable out-of-sample in a majority of folds. Still paper-trade for a stretch before flipping status to 'validated'."
      : "Params did not hold up consistently out-of-sample. Do not mark this market validated yet - likely needs more data or the edge isn't real.",
  };
}

module.exports = { simulateParams, buildGrid, walkForwardValidate };
