const express = require("express");
const router  = express.Router();
const pool    = require("../db");
const fetch   = require("node-fetch");

// GET /multistream/platforms
router.get("/platforms", async (req, res) => {
  try {
    const { userId } = req.query;
    const result = await pool.query(
      `SELECT c.platform, c.connected_at,
              CASE WHEN ot.access_token IS NOT NULL
              THEN true ELSE false END as has_token
       FROM connections c
       LEFT JOIN oauth_tokens ot
       ON c.user_id = ot.user_id AND c.platform = ot.platform
       WHERE c.user_id = $1`,
      [userId]
    );
    res.json({ platforms: result.rows });
  } catch (err) {
    console.error("Get platforms error:", err.message);
    res.status(500).json({ error: "Failed to get platforms" });
  }
});

// POST /multistream/start
router.post("/start", async (req, res) => {
  try {
    const { userId, title, platforms } = req.body;

    if (!userId || !platforms || platforms.length === 0) {
      return res.status(400).json({ error: "userId and platforms are required" });
    }

    const results = [];
    const errors  = [];

    for (const platform of platforms) {
      try {
        const tokenResult = await pool.query(
          "SELECT access_token FROM oauth_tokens WHERE user_id = $1 AND platform = $2",
          [userId, platform]
        );

        if (tokenResult.rows.length === 0) {
          errors.push({ platform, error: "Not connected" });
          continue;
        }

        const accessToken = tokenResult.rows[0].access_token;
        let streamData;

        if (platform === "facebook") {
          streamData = await getFacebookRTMP(accessToken, title);
        } else if (platform === "youtube") {
          streamData = await getYoutubeRTMP(accessToken, title);
        } else if (platform === "instagram") {
          streamData = await getInstagramRTMP(accessToken, title);
        } else {
          streamData = {
            streamId:  `${platform}_${Date.now()}`,
            rtmpUrl:   `rtmp://live.${platform}.com/live`,
            streamKey: "Get from app settings",
          };
        }

        await pool.query(
          `INSERT INTO live_sessions
           (user_id, platform, stream_id, rtmp_url, stream_key, title, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'active')`,
          [userId, platform, streamData.streamId,
           streamData.rtmpUrl, streamData.streamKey,
           title || "Twinn Multistream"]
        );

        results.push({
          platform,
          streamId:  streamData.streamId,
          rtmpUrl:   streamData.rtmpUrl,
          streamKey: streamData.streamKey,
          success:   true,
        });

        console.log(`✅ ${platform} stream ready!`);

      } catch (err) {
        console.error(`❌ ${platform} error:`, err.message);
        errors.push({ platform, error: err.message });
      }
    }

    res.json({
      success: results.length > 0,
      streams: results,
      errors,
      message: `${results.length} platform(s) ready for streaming!`,
    });

  } catch (err) {
    console.error("Multistream start error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /multistream/stop
router.post("/stop", async (req, res) => {
  try {
    const { userId } = req.body;
    await pool.query(
      `UPDATE live_sessions
       SET status = 'ended', ended_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND status = 'active'`,
      [userId]
    );
    res.json({ success: true, message: "All streams ended!" });
  } catch (err) {
    console.error("Stop multistream error:", err.message);
    res.status(500).json({ error: "Failed to stop streams" });
  }
});

// GET /multistream/history
router.get("/history", async (req, res) => {
  try {
    const { userId } = req.query;
    const result = await pool.query(
      `SELECT * FROM live_sessions
       WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 20`,
      [userId]
    );
    res.json({ history: result.rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to get history" });
  }
});

// ── Platform RTMP functions ──────────────────────────

async function getFacebookRTMP(accessToken, title) {
  console.log("🔍 Getting Facebook Page token...");

  const pageId = process.env.FACEBOOK_PAGE_ID;

  if (!pageId) {
    throw new Error("FACEBOOK_PAGE_ID not set in environment variables");
  }

  // Get Page-specific access token
  const pageTokenRes  = await fetch(
    `https://graph.facebook.com/v18.0/${pageId}?fields=access_token&access_token=${accessToken}`
  );
  const pageTokenData = await pageTokenRes.json();
  console.log("🔑 Page token response:", JSON.stringify(pageTokenData));

  if (pageTokenData.error) {
    throw new Error(`Failed to get page token: ${pageTokenData.error.message}`);
  }

  const pageAccessToken = pageTokenData.access_token || accessToken;
  console.log(`📺 Got Page token for page: ${pageId}`);

  // Create live video using Page token
  console.log(`🎥 Creating live video on page ${pageId}...`);
  const liveRes  = await fetch(
    `https://graph.facebook.com/v18.0/${pageId}/live_videos`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title:        title || "Twinn AI Multistream",
        description:  "Live powered by Twinn AI",
        access_token: pageAccessToken,
        status:       "LIVE_NOW",
      }),
    }
  );

  const liveData = await liveRes.json();
  console.log("🎥 Facebook Live response:", JSON.stringify(liveData));

  if (liveData.error) {
    throw new Error(`Facebook Live: ${liveData.error.message}`);
  }

  if (!liveData.stream_url) {
    throw new Error("Facebook did not return a stream URL");
  }

  const fullUrl   = liveData.stream_url;
  const lastSlash = fullUrl.lastIndexOf("/");
  const rtmpUrl   = fullUrl.substring(0, lastSlash);
  const streamKey = fullUrl.substring(lastSlash + 1);

  console.log(`✅ Facebook RTMP ready!`);
  return { streamId: liveData.id, rtmpUrl, streamKey };
}

async function getInstagramRTMP(accessToken, title) {
  const res  = await fetch(
    `https://graph.facebook.com/v18.0/me/live_videos`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title:        title || "Twinn AI Live",
        access_token: accessToken,
        status:       "LIVE_NOW",
      }),
    }
  );
  const data = await res.json();
  console.log("📸 Instagram Live response:", JSON.stringify(data));

  if (data.error) {
    throw new Error(`Instagram Live: ${data.error.message}`);
  }

  const fullUrl   = data.stream_url || "";
  const lastSlash = fullUrl.lastIndexOf("/");
  const rtmpUrl   = fullUrl.substring(0, lastSlash);
  const streamKey = fullUrl.substring(lastSlash + 1);

  return { streamId: data.id, rtmpUrl, streamKey };
}

async function getYoutubeRTMP(accessToken, title) {
  const streamRes  = await fetch(
    "https://www.googleapis.com/youtube/v3/liveStreams?part=snippet,cdn,status",
    {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        snippet: { title: title || "Twinn AI Live" },
        cdn: {
          frameRate:     "variable",
          ingestionType: "rtmp",
          resolution:    "variable",
        },
      }),
    }
  );

  const streamData = await streamRes.json();
  console.log("▶️ YouTube stream response:", JSON.stringify(streamData));

  if (streamData.error) {
    throw new Error(`YouTube: ${streamData.error.message}`);
  }

  const broadcastRes  = await fetch(
    "https://www.googleapis.com/youtube/v3/liveBroadcasts?part=snippet,status,contentDetails",
    {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        snippet: {
          title: title || "Twinn AI Live",
          scheduledStartTime: new Date().toISOString(),
        },
        status:         { privacyStatus: "public" },
        contentDetails: { enableAutoStart: true },
      }),
    }
  );

  const broadcastData = await broadcastRes.json();
  console.log("▶️ YouTube broadcast response:", JSON.stringify(broadcastData));

  if (broadcastData.error) {
    throw new Error(`YouTube broadcast: ${broadcastData.error.message}`);
  }

  return {
    streamId:  broadcastData.id,
    rtmpUrl:   streamData.cdn.ingestionInfo.ingestionAddress,
    streamKey: streamData.cdn.ingestionInfo.streamName,
  };
}

module.exports = router;