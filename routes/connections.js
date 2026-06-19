const express = require("express");
const fs      = require("fs");
const path    = require("path");

const router   = express.Router();
const DB_PATH  = path.join(__dirname, "../data/connections.json");

// Helper to read the JSON file
function readDB() {
  const raw = fs.readFileSync(DB_PATH, "utf-8");
  return JSON.parse(raw);
}

// Helper to write to the JSON file
function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// GET /connections — get all connected platforms for a user
router.get("/", (req, res) => {
  try {
    const db          = readDB();
    const { userId }  = req.query;
    const userConns   = db.connections.filter(c => c.userId === userId);
    res.json({ connections: userConns });
  } catch (err) {
    res.status(500).json({ error: "Failed to read connections" });
  }
});

// POST /connections — save a new connection
router.post("/", (req, res) => {
  try {
    const { userId, platform, accessToken } = req.body;

    if (!userId || !platform) {
      return res.status(400).json({ error: "userId and platform are required" });
    }

    const db = readDB();

    // Check if already connected — update if yes
    const existing = db.connections.findIndex(
      c => c.userId === userId && c.platform === platform
    );

    if (existing >= 0) {
      db.connections[existing] = {
        ...db.connections[existing],
        accessToken,
        connectedAt: new Date().toISOString(),
      };
    } else {
      // Add new connection
      db.connections.push({
        userId,
        platform,
        accessToken,
        connectedAt: new Date().toISOString(),
      });
    }

    writeDB(db);
    res.json({ success: true, message: `${platform} connected successfully!` });

  } catch (err) {
    res.status(500).json({ error: "Failed to save connection" });
  }
});

// DELETE /connections/:platform — disconnect a platform
router.delete("/:platform", (req, res) => {
  try {
    const { platform }  = req.params;
    const { userId }    = req.body;
    const db            = readDB();

    db.connections = db.connections.filter(
      c => !(c.userId === userId && c.platform === platform)
    );

    writeDB(db);
    res.json({ success: true, message: `${platform} disconnected!` });

  } catch (err) {
    res.status(500).json({ error: "Failed to disconnect platform" });
  }
});

module.exports = router;