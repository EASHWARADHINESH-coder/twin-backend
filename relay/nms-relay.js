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

const BACKEND     = process.env.BACKEND_URL || "http://localhost:5000";
const USER_ID     = process.env.USER_ID || "1";
const RTMP_PORT   = Number(process.env.RTMP_PORT || 1935);
const STREAM_PATH = process.env.STREAM_PATH || "/live/twinn";
const LOCAL_PULL  = `rtmp://127.0.0.1:${RTMP_PORT}${STREAM_PATH}`;

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
  const state = pushers.get(platform) || { attempt: 0 };
  state.stopping = false;
  pushers.set(platform, state);

  const args = ["-i", LOCAL_PULL, "-c", "copy", "-f", "flv", destUrl(t)];
  const startedAt = Date.now();
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
    if (state.stopping || !publishing) {
      console.log(`⏹️  [${platform}] stopped`);
      return;
    }
    // Per-destination reconnect: only THIS pusher restarts.
    if (Date.now() - startedAt > STABLE_RUN_MS) state.attempt = 0;
    state.attempt++;
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

nms.run();
console.log(`✅ Relay server listening on rtmp://0.0.0.0:${RTMP_PORT}`);
console.log(`👉 In OBS set  Server = rtmp://localhost:${RTMP_PORT}/live   Key = twinn`);
console.log("   (Ctrl+C to stop the relay.)\n");

function shutdown() {
  console.log("\n🛑 Shutting down...");
  publishing = false;
  stopAllPushers();
  try { nms.stop(); } catch (_) { /* ignore */ }
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
