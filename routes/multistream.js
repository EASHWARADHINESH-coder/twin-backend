const express = require("express");
const router  = express.Router();
const pool    = require("../db");
const fetch   = require("node-fetch");

// Latest relay status per user, pushed by the local relay's heartbeat.
// Kept in memory on purpose: this is transient live data, so we avoid writing
// to the database every few seconds. Lost on restart; repopulated on next beat.
const relayStatus = new Map(); // userId(string) -> { ...status, receivedAt }
const RELAY_STALE_MS = 15000;  // no heartbeat for this long => relay is offline

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

    // Platforms with an OAuth API that can create a broadcast programmatically.
    // Everything else (e.g. Rooter) is a manual RTMP destination.
    const API_PLATFORMS = ["facebook", "youtube", "instagram"];

    for (const platform of platforms) {
      try {
        let streamData;

        if (API_PLATFORMS.includes(platform)) {
          const tokenResult = await pool.query(
            "SELECT access_token FROM oauth_tokens WHERE user_id = $1 AND platform = $2",
            [userId, platform]
          );

          if (tokenResult.rows.length === 0) {
            errors.push({ platform, error: "Not connected" });
            continue;
          }

          const accessToken = tokenResult.rows[0].access_token;

          if (platform === "facebook") {
            streamData = await getFacebookRTMP(accessToken, title);
          } else if (platform === "youtube") {
            streamData = await getYoutubeRTMP(accessToken, title);
          } else {
            streamData = await getInstagramRTMP(accessToken, title);
          }
        } else {
          // Custom RTMP destination (Rooter, etc.) — use the URL + key the
          // user saved via POST /multistream/rtmp.
          const rtmpResult = await pool.query(
            "SELECT rtmp_url, stream_key FROM rtmp_destinations WHERE user_id = $1 AND platform = $2",
            [userId, platform]
          );

          if (rtmpResult.rows.length === 0) {
            errors.push({
              platform,
              error: "No RTMP settings saved. Add them via /multistream/rtmp first.",
            });
            continue;
          }

          streamData = {
            streamId:  `${platform}_${Date.now()}`,
            rtmpUrl:   rtmpResult.rows[0].rtmp_url,
            streamKey: rtmpResult.rows[0].stream_key,
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

// POST /multistream/rtmp — save a manual RTMP destination (e.g. Rooter).
// Body: { userId, platform, rtmpUrl, streamKey }
router.post("/rtmp", async (req, res) => {
  try {
    const { userId, platform, rtmpUrl, streamKey } = req.body;

    if (!userId || !platform || !rtmpUrl || !streamKey) {
      return res.status(400).json({
        error: "userId, platform, rtmpUrl and streamKey are required",
      });
    }

    // Save (or update) the RTMP credentials
    await pool.query(
      `INSERT INTO rtmp_destinations (user_id, platform, rtmp_url, stream_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, platform) DO UPDATE
       SET rtmp_url = $3, stream_key = $4, updated_at = CURRENT_TIMESTAMP`,
      [userId, platform, rtmpUrl, streamKey]
    );

    // Mark the platform as connected so the UI shows it
    await pool.query(
      `INSERT INTO connections (user_id, platform)
       VALUES ($1, $2)
       ON CONFLICT (user_id, platform) DO UPDATE
       SET connected_at = CURRENT_TIMESTAMP`,
      [userId, platform]
    );

    console.log(`✅ ${platform} RTMP settings saved!`);
    res.json({ success: true, message: `${platform} RTMP settings saved!` });
  } catch (err) {
    console.error("Save RTMP error:", err.message);
    res.status(500).json({ error: "Failed to save RTMP settings" });
  }
});

// GET /multistream/targets?userId=1 — active session RTMP targets for the
// local relay to fan out to (includes stream keys — call from your own relay).
router.get("/targets", async (req, res) => {
  try {
    const { userId } = req.query;
    const result = await pool.query(
      `SELECT platform, rtmp_url AS "rtmpUrl", stream_key AS "streamKey"
       FROM live_sessions
       WHERE user_id = $1 AND status = 'active'`,
      [userId]
    );
    res.json({ targets: result.rows });
  } catch (err) {
    console.error("Get targets error:", err.message);
    res.status(500).json({ error: "Failed to get targets" });
  }
});

// POST /multistream/status — the local relay pushes a status heartbeat here.
// Body: { userId, publishing/running, destinations, ... } (never stream keys).
// Optional shared secret: set RELAY_STATUS_TOKEN and send it as x-relay-token.
router.post("/status", (req, res) => {
  const token = process.env.RELAY_STATUS_TOKEN;
  if (token && req.headers["x-relay-token"] !== token) {
    return res.status(401).json({ error: "Invalid relay token" });
  }

  const { userId, ...status } = req.body || {};
  if (!userId) {
    return res.status(400).json({ error: "userId is required" });
  }

  relayStatus.set(String(userId), { ...status, receivedAt: Date.now() });
  res.json({ success: true });
});

// GET /multistream/status?userId=1 — frontend/cloud reads the latest relay
// status. `online` is false when the last heartbeat is stale (or never sent).
router.get("/status", (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return res.status(400).json({ error: "userId is required" });
  }

  const s = relayStatus.get(String(userId));
  if (!s) {
    return res.json({ online: false, relay: null });
  }

  const ageMs = Date.now() - s.receivedAt;
  res.json({
    online: ageMs < RELAY_STALE_MS,
    ageSec: Math.round(ageMs / 1000),
    relay:  s,
  });
});

// GET /multistream/monitor?userId=1 — a cloud dashboard (served by Render) that
// polls /multistream/status, so you can watch the relay from anywhere.
router.get("/monitor", (req, res) => {
  const userId = String(req.query.userId || "1");
  res.type("html").send(`<!doctype html><html><head><meta charset="utf-8">
<title>Twinn Relay Monitor</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{font-family:system-ui,sans-serif;margin:2rem;background:#0f1216;color:#e6e6e6}
 h1{font-size:1.3rem} .pill{padding:.2rem .6rem;border-radius:1rem;font-size:.85rem}
 .on{background:#1b5e20} .off{background:#5e1b1b}
 table{border-collapse:collapse;margin-top:1rem;width:100%;max-width:640px}
 th,td{text-align:left;padding:.5rem .75rem;border-bottom:1px solid #2a2f36}
 .live{color:#66bb6a} .reconnecting{color:#ffa726} .stopped{color:#9e9e9e}
 .muted{color:#8892a0;font-size:.85rem}
</style></head><body>
<h1>📡 Twinn Relay Monitor <span id="pill" class="pill off">…</span></h1>
<div class="muted">user ${userId} · relay heartbeat: <span id="beat">–</span> · auto-refresh 3s</div>
<table><thead><tr><th>Destination</th><th>Status</th><th>Uptime</th><th>Restarts</th><th>Last exit</th></tr></thead>
<tbody id="rows"><tr><td colspan="5" class="muted">loading…</td></tr></tbody></table>
<script>
 async function tick(){
  try{
   const r=await (await fetch('/multistream/status?userId=${userId}')).json();
   const pill=document.getElementById('pill');
   const rel=r.relay||{};
   const pub=r.online&&(rel.publishing||rel.running);
   pill.textContent=!r.online?'relay offline':(pub?'streaming':'relay up, idle');
   pill.className='pill '+(pub?'on':'off');
   document.getElementById('beat').textContent=r.online?(r.ageSec+'s ago'):'stale';
   const dests=rel.destinations||[];
   const rows=dests.map(function(d){return '<tr><td>'+d.platform+'</td><td class="'+d.status+'">'+d.status+'</td><td>'+(d.uptimeSec||0)+'s</td><td>'+(d.restarts||0)+'</td><td>'+(d.lastExitCode==null?'–':d.lastExitCode)+'</td></tr>';}).join('');
   document.getElementById('rows').innerHTML=rows||'<tr><td colspan="5" class="muted">'+(r.online?'no destinations yet':'waiting for relay heartbeat')+'</td></tr>';
  }catch(e){document.getElementById('pill').textContent='error';}
 }
 tick();setInterval(tick,3000);
</script></body></html>`);
});

// GET /multistream/rtmp?userId=1 — list saved RTMP destinations
// (stream key is intentionally omitted from the response)
router.get("/rtmp", async (req, res) => {
  try {
    const { userId } = req.query;
    const result = await pool.query(
      `SELECT platform, rtmp_url, updated_at
       FROM rtmp_destinations
       WHERE user_id = $1`,
      [userId]
    );
    res.json({ destinations: result.rows });
  } catch (err) {
    console.error("Get RTMP error:", err.message);
    res.status(500).json({ error: "Failed to get RTMP settings" });
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