#!/usr/bin/env node
/**
 * Twinn RTMP relay — fan ONE OBS stream out to every active destination
 * (YouTube, Facebook, Rooter, ...) at the same time, with auto-restart.
 *
 * FREE & open source: this uses ffmpeg (https://ffmpeg.org) only — no paid
 * services, no accounts. Run it on the SAME machine as OBS ($0), or on any
 * host that can accept RTMP on port 1935.
 *
 * Resilience:
 *   - Supervisor loop restarts ffmpeg automatically (exponential backoff) if it
 *     exits — e.g. OBS disconnects, a network blip, or you start the relay
 *     before OBS / before POST /multistream/start.
 *   - The tee muxer uses onfail=ignore, so if ONE destination fails or drops,
 *     the others keep streaming instead of the whole fan-out crashing.
 *
 * Usage:
 *   1. Install ffmpeg (free):  https://ffmpeg.org/download.html
 *   2. Start a multistream:    POST /multistream/start   (creates the targets)
 *   3. Run the relay:          npm run relay
 *   4. In OBS -> Settings -> Stream:
 *          Service    = Custom
 *          Server     = rtmp://localhost:1935/live
 *          Stream Key = twinn
 *   5. Click "Start Streaming" in OBS.  (Ctrl+C stops the relay.)
 *
 * Config via environment variables:
 *   BACKEND_URL  (default http://localhost:5000)  where the API runs
 *   USER_ID      (default 1)                       whose active session to relay
 *   RELAY_INPUT  (default rtmp://0.0.0.0:1935/live/twinn)  where OBS connects
 */

const { spawn } = require("child_process");

const BACKEND = process.env.BACKEND_URL || "http://localhost:5000";
const USER_ID = process.env.USER_ID || "1";
const INPUT   = process.env.RELAY_INPUT || "rtmp://0.0.0.0:1935/live/twinn";

// Backoff tuning
const BASE_BACKOFF_MS = 1000;   // first retry delay
const MAX_BACKOFF_MS  = 15000;  // cap
const STABLE_RUN_MS   = 30000;  // a run longer than this resets the backoff

let shuttingDown = false;
let current      = null; // the live ffmpeg child process

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTargets() {
  const res = await fetch(`${BACKEND}/multistream/targets?userId=${USER_ID}`);
  if (!res.ok) throw new Error(`Backend returned ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.targets || [];
}

// Build the ffmpeg args: listen for OBS, copy codecs (no re-encode = no CPU
// cost), and tee the same stream to every destination. onfail=ignore keeps the
// other outputs alive when one destination fails.
function buildArgs(targets) {
  const outputs = targets.map((t) => {
    const base = (t.rtmpUrl || "").replace(/\/+$/, "");
    const full = t.streamKey ? `${base}/${t.streamKey}` : base;
    return `[f=flv:onfail=ignore]${full}`;
  });
  return [
    "-listen", "1",
    "-i", INPUT,
    "-c", "copy",
    "-map", "0",
    "-f", "tee",
    outputs.join("|"),
  ];
}

// Run a single ffmpeg session. Resolves with { ranMs, fatal } when it ends.
function runOnce(targets) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const ff = spawn("ffmpeg", buildArgs(targets), { stdio: "inherit" });
    current = ff;

    ff.on("error", (err) => {
      current = null;
      if (err.code === "ENOENT") {
        console.error(
          "\n❌ ffmpeg not found. Install it (free): https://ffmpeg.org/download.html"
        );
        resolve({ ranMs: 0, fatal: true }); // no point retrying without ffmpeg
      } else {
        console.error("❌ ffmpeg error:", err.message);
        resolve({ ranMs: Date.now() - startedAt, fatal: false });
      }
    });

    ff.on("close", (code) => {
      current = null;
      console.log(`\nffmpeg exited (code ${code}).`);
      resolve({ ranMs: Date.now() - startedAt, fatal: false });
    });
  });
}

async function supervise() {
  let attempt = 0;

  while (!shuttingDown) {
    let targets = [];
    try {
      targets = await getTargets();
    } catch (err) {
      console.error(`⚠️  Could not reach backend: ${err.message}`);
    }

    if (!shuttingDown && targets.length === 0) {
      // Nothing to stream yet — wait and retry (e.g. before POST /start).
      attempt++;
      const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
      console.log(`⏳ No active targets yet. Retrying in ${backoff / 1000}s...`);
      await sleep(backoff);
      continue;
    }

    if (shuttingDown) break;

    console.log(`\n📡 Relaying to ${targets.length} destination(s):`);
    targets.forEach((t) => console.log(`   - ${t.platform}`));
    console.log("👉 In OBS set  Server = rtmp://localhost:1935/live   Key = twinn");
    console.log("   Then click Start Streaming.  (Ctrl+C to stop the relay.)\n");

    const { ranMs, fatal } = await runOnce(targets);
    if (fatal) process.exit(1);
    if (shuttingDown) break;

    // A healthy long run means the failure was transient — reset backoff.
    if (ranMs > STABLE_RUN_MS) attempt = 0;
    attempt++;
    const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
    console.log(`↻ Restarting relay in ${backoff / 1000}s (attempt ${attempt})...`);
    await sleep(backoff);
  }
}

// Graceful shutdown on Ctrl+C
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n🛑 Stopping relay...");
  if (current) current.kill("SIGINT");
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

supervise().catch((err) => {
  console.error("Relay error:", err.message);
  process.exit(1);
});
