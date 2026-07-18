/**
 * Live sports data fetcher.
 *
 * Thin wrapper around Kalshi's /live_data/milestone/{milestone_id} endpoint.
 * Run this from your Render backend (not reachable from this sandbox).
 *
 * A "milestone" is Kalshi's unit of live game state - exactly what it
 * contains depends on the sport. This wrapper doesn't assume a shape;
 * it just fetches and returns raw data so you can inspect what a real
 * MLB or tennis milestone_id actually returns before building signal
 * logic on top of it. Don't guess the schema - log a real response first.
 */

const BASE = "https://external-api.kalshi.com/trade-api/v2";

async function fetchMilestone(milestoneId, { includePlayerStats = false } = {}) {
  const url = new URL(`${BASE}/live_data/milestone/${milestoneId}`);
  if (includePlayerStats) url.searchParams.set("include_player_stats", "true");

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} fetching milestone ${milestoneId}`);
  }
  return res.json();
}

async function fetchGameStats(milestoneId) {
  const url = `${BASE}/live_data/milestone/${milestoneId}/game_stats`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} fetching game_stats for ${milestoneId}`);
  }
  return res.json();
}

// Helper for finding a milestone_id in the first place: list live/open
// markets in a sports series, since milestone IDs are tied to specific
// live events, not something you can guess.
async function findLiveMarkets(seriesTicker) {
  const url = new URL(`${BASE}/markets`);
  url.searchParams.set("series_ticker", seriesTicker);
  url.searchParams.set("status", "open");
  url.searchParams.set("limit", "50");

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} listing markets for ${seriesTicker}`);
  }
  return res.json();
}

module.exports = { fetchMilestone, fetchGameStats, findLiveMarkets };
