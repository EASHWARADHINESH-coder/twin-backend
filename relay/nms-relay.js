#!/usr/bin/env node
/**
 * Twinn RTMP relay (node-media-server edition) — TRUE per-destination reconnect.
 *
 * A local RTMP server (node-media-server) accepts ONE OBS stream, and on publish
 * spawns one INDEPENDENT ffmpeg pusher per destination. Each pusher pulls from
 * the local server and is supervised on its own, so if a single platform drops
 * mid-stream (e.g. Rooter), only its pusher restarts and rejoins — the others
 * keep streaming uninterrupted.
 *
 * FREE & open source: node-media-server (MIT) + ffmpeg (https://ffmpeg.org).
 * No paid services. Run on the SAME machine as OBS ($0).
 *
 * Usage:
 *   1. Install deps:            npm install         (adds node-media-server)
 *   2. Install ffmpeg (free):   https://ffmpeg.org/download.html
 *   3. Run the relay server:    npm run relay:nms
 *   4. Start a multistream:     POST /multistream/start   (creates the targets)
 *   5. In OBS -> Settings -> Stream:
 *          Service    = Custom
 *          Server     = rtmp://localhost:1935/live
 *          Stream Key = twinn
 *   6. Click "Start Streaming".  (Ctrl+C stops the relay.)
 *
 * Config via environment variables:
 *   BACKEND_URL  (default http://localhost:5000)  where the API runs
 *   USER_ID      (default 1)                       whose active session to relay
 *   RTMP_PORT    (default 1935)                     local RTMP ingest port
 *   STREAM_PATH  (default /live/twinn)              expected OBS path
 */

const NodeMediaServer = require("node-media-server");
const { spawn }        = require("child_process");
const http             = require("http");

const BACKEND     = process.env.BACKEND_URL || "http://localhost:5000";
const USER_ID     = process.env.USER_ID || "1";
const RTMP_PORT   = Number(process.env.RTMP_PORT || 1935);
const STATUS_PORT = Number(process.env.STATUS_PORT || 8080);
const STREAM_PATH = process.env.STREAM_PATH || "/live/twinn";
const LOCAL_PULL  = `rtmp://127.0.0.1:${RTMP_PORT}${STREAM_PATH}`;
const RELAY_STARTED_AT = Date.now();

// Heartbeat: push status up to the Render backend so it can be watched in the
// cloud. Set to 0 to disable. Optional shared secret via RELAY_STATUS_TOKEN.
const STATUS_PUSH_MS = Number(process.env.STATUS_PUSH_INTERVAL || 5000);

// Per-destination backoff tuning
const BASE_BACKOFF_MS = 1000;   // first reconnect delay
const MAX_BACKOFF_MS  = 15000;  // cap
const STABLE_RUN_MS   = 30000;  // a pusher running this long resets its backoff

// platform -> { proc, attempt, stopping }
const pushers   = new Map();
let   publishing = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTargets() {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(`${BACKEND}/multistream/targets?userId=${USER_ID}`);
      if (!res.ok) throw new Error(`Backend returned ${res.status}`);
      const data = await res.json();
      return data.targets || [];
    } catch (err) {
      console.error(`⚠️  Could not fetch targets (${err.message}); retrying...`);
      await sleep(1000 * (i + 1));
    }
  }
  return [];
}

function destUrl(t) {
  const base = (t.rtmpUrl || "").replace(/\/+$/, "");
  return t.streamKey ? `${base}/${t.streamKey}` : base;
}

// Start (or restart) a single destination's pusher. Each one supervises itself.
function startPusher(t) {
  const platform = t.platform;
  const state = pushers.get(platform) || { attempt: 0, restarts: 0 };
  state.stopping = false;
  state.status   = "live";
  state.startedAt = Date.now();
  pushers.set(platform, state);

  const args = ["-i", LOCAL_PULL, "-c", "copy", "-f", "flv", destUrl(t)];
  const startedAt = state.startedAt;
  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "inherit"] });
  state.proc = proc;

  console.log(`▶️  [${platform}] pushing`);

  proc.on("error", (err) => {
    if (err.code === "ENOENT") {
      console.error("❌ ffmpeg not found. Install (free): https://ffmpeg.org/download.html");
      process.exit(1);
    }
    console.error(`[${platform}] ffmpeg error: ${err.message}`);
  });

  proc.on("close", (code) => {
    state.proc = null;
    state.lastExitCode = code;
    if (state.stopping || !publishing) {
      state.status = "stopped";
      console.log(`⏹️  [${platform}] stopped`);
      return;
    }
    // Per-destination reconnect: only THIS pusher restarts.
    if (Date.now() - startedAt > STABLE_RUN_MS) state.attempt = 0;
    state.attempt++;
    state.restarts++;
    state.status = "reconnecting";
    const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (state.attempt - 1));
    console.log(`↻ [${platform}] dropped (code ${code}); reconnecting in ${backoff / 1000}s...`);
    setTimeout(() => {
      if (publishing && !state.stopping) startPusher(t);
    }, backoff);
  });
}

function stopAllPushers() {
  for (const state of pushers.values()) {
    state.stopping = true;
    if (state.proc) state.proc.kill("SIGINT");
  }
  pushers.clear();
}

async function onPublish() {
  publishing = true;
  const targets = await getTargets();
  if (targets.length === 0) {
    console.error("❌ No active targets. Call POST /multistream/start, then restart OBS.");
    return;
  }
  console.log(`📡 Relaying to ${targets.length} destination(s): ${targets.map((t) => t.platform).join(", ")}`);
  targets.forEach(startPusher);
}

// ── Health / status HTTP server ──────────────────────
function buildStatus() {
  const destinations = [];
  for (const [platform, s] of pushers) {
    destinations.push({
      platform,
      status:       s.status || "unknown",       // live | reconnecting | stopped
      uptimeSec:    s.status === "live" && s.startedAt
                      ? Math.round((Date.now() - s.startedAt) / 1000)
                      : 0,
      restarts:     s.restarts || 0,
      lastExitCode: s.lastExitCode ?? null,
    });
  }
  return {
    status:          "ok",
    publishing,                                    // is OBS currently connected?
    relayUptimeSec:  Math.round((Date.now() - RELAY_STARTED_AT) / 1000),
    destinationCount: destinations.length,
    destinations,
  };
}

const DASHBOARD_HTML = `<!doctype html><html><head><meta charset="utf-8">
<title>Twinn Relay Status</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{font-family:system-ui,sans-serif;margin:2rem;background:#0f1216;color:#e6e6e6}
 h1{font-size:1.3rem} .pub{padding:.2rem .6rem;border-radius:1rem;font-size:.85rem}
 .on{background:#1b5e20} .off{background:#5e1b1b}
 table{border-collapse:collapse;margin-top:1rem;width:100%;max-width:640px}
 th,td{text-align:left;padding:.5rem .75rem;border-bottom:1px solid #2a2f36}
 .live{color:#66bb6a} .reconnecting{color:#ffa726} .stopped{color:#9e9e9e}
 .muted{color:#8892a0;font-size:.85rem}
</style></head><body>
<h1>📡 Twinn Relay <span id="pub" class="pub off">…</span></h1>
<div class="muted">relay uptime: <span id="up">–</span>s · auto-refresh 2s</div>
<table><thead><tr><th>Destination</th><th>Status</th><th>Uptime</th><th>Restarts</th><th>Last exit</th></tr></thead>
<tbody id="rows"><tr><td colspan="5" class="muted">loading…</td></tr></tbody></table>
<script>
 async function tick(){
  try{
   const s=await (await fetch('/status')).json();
   const p=document.getElementById('pub');
   p.textContent=s.publishing?'OBS live':'waiting for OBS';
   p.className='pub '+(s.publishing?'on':'off');
   document.getElementById('up').textContent=s.relayUptimeSec;
   const rows=s.destinations.map(d=>
     '<tr><td>'+d.platform+'</td><td class="'+d.status+'">'+d.status+'</td><td>'+d.uptimeSec+'s</td><td>'+d.restarts+'</td><td>'+(d.lastExitCode===null?'–':d.lastExitCode)+'</td></tr>').join('');
   document.getElementById('rows').innerHTML=rows||'<tr><td colspan="5" class="muted">no destinations yet — start OBS + POST /multistream/start</td></tr>';
  }catch(e){document.getElementById('pub').textContent='relay unreachable';}
 }
 tick();setInterval(tick,2000);
</script></body></html>`;

const statusServer = http.createServer((req, res) => {
  const path = (req.url || "/").split("?")[0];
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", publishing, destinations: pushers.size }));
  } else if (path === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(buildStatus(), null, 2));
  } else if (path === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(DASHBOARD_HTML);
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }
});

const nms = new NodeMediaServer({
  rtmp: {
    port:         RTMP_PORT,
    chunk_size:   60000,
    gop_cache:    true,   // send a keyframe immediately so pushers start clean
    ping:         30,
    ping_timeout: 60,
  },
});

nms.on("postPublish", (id, streamPath) => {
  if (streamPath !== STREAM_PATH) {
    console.log(`Ignoring unexpected stream path: ${streamPath} (expected ${STREAM_PATH})`);
    return;
  }
  console.log(`\n🎥 OBS connected on ${streamPath}`);
  onPublish();
});

nms.on("donePublish", (id, streamPath) => {
  if (streamPath !== STREAM_PATH) return;
  console.log(`\n🔌 OBS disconnected; stopping all pushers.`);
  publishing = false;
  stopAllPushers();
});

// Push a status heartbeat to the Render backend (no stream keys are included).
async function pushStatus() {
  try {
    const headers = { "Content-Type": "application/json" };
    if (process.env.RELAY_STATUS_TOKEN) headers["x-relay-token"] = process.env.RELAY_STATUS_TOKEN;
    await fetch(`${BACKEND}/multistream/status`, {
      method:  "POST",
      headers,
      body:    JSON.stringify({ userId: USER_ID, ...buildStatus() }),
    });
  } catch (_) { /* backend unreachable — ignore, retry next beat */ }
}

let heartbeat = null;

nms.run();
statusServer.listen(STATUS_PORT);
if (STATUS_PUSH_MS > 0) heartbeat = setInterval(pushStatus, STATUS_PUSH_MS);
console.log(`✅ Relay server listening on rtmp://0.0.0.0:${RTMP_PORT}`);
console.log(`📊 Local status: http://localhost:${STATUS_PORT}/   (JSON: /status, /health)`);
if (STATUS_PUSH_MS > 0) console.log(`☁️  Cloud monitor: ${BACKEND}/multistream/monitor?userId=${USER_ID}`);
console.log(`👉 In OBS set  Server = rtmp://localhost:${RTMP_PORT}/live   Key = twinn`);
console.log("   (Ctrl+C to stop the relay.)\n");

function shutdown() {
  console.log("\n🛑 Shutting down...");
  publishing = false;
  stopAllPushers();
  if (heartbeat) clearInterval(heartbeat);
  try { statusServer.close(); } catch (_) { /* ignore */ }
  try { nms.stop(); } catch (_) { /* ignore */ }
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
