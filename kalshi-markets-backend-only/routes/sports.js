const express = require("express");
const { fetchMilestone, fetchGameStats, findLiveMarkets } = require("../core/sportsLiveData");
const { SPORTS } = require("../config/sports");

const router = express.Router();

router.get("/sports", (req, res) => res.json(SPORTS));

// GET /api/sports/live-markets/:seriesTicker - e.g. /api/sports/live-markets/KXMLBGAME
router.get("/sports/live-markets/:seriesTicker", async (req, res) => {
  try {
    const data = await findLiveMarkets(req.params.seriesTicker);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/sports/milestone/:milestoneId
router.get("/sports/milestone/:milestoneId", async (req, res) => {
  try {
    const includePlayerStats = req.query.playerStats === "true";
    const data = await fetchMilestone(req.params.milestoneId, { includePlayerStats });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// GET /api/sports/milestone/:milestoneId/stats
router.get("/sports/milestone/:milestoneId/stats", async (req, res) => {
  try {
    const data = await fetchGameStats(req.params.milestoneId);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

module.exports = router;
