#!/usr/bin/env node
/**
 * Twinn RTMP relay — fan ONE OBS stream out to every active destination
 * (YouTube, Facebook, Rooter, ...) at the same time.
 *
 * FREE & open source: this uses ffmpeg (https://ffmpeg.org) only — no paid
 * services, no accounts. Run it on the SAME machine as OBS ($0), or on any
 * host that can accept RTMP on port 1935.
 *
 * Usage:
 *   1. Install ffmpeg (free):  https://ffmpeg.org/download.html
 *   2. Start a multistream:    POST /multistream/start   (creates the targets)
 *   3. Run the relay:          npm run relay
 *   4. In OBS -> Settings -> Stream:
 *          Service    = Custom
 *          Server     = rtmp://localhost:1935/live
 *          Stream Key = twinn
 *   5. Click "Start Streaming" in OBS.
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

async function getTargets() {
  const res = await fetch(`${BACKEND}/multistream/targets?userId=${USER_ID}`);
  if (!res.ok) throw new Error(`Backend returned ${res.status} ${res.statusText}`);
  const data = await res.json();
  return data.targets || [];
}

// Build the ffmpeg arg list: listen for OBS, copy codecs (no re-encode = no
// CPU cost), and push the same stream to every destination.
function buildArgs(targets) {
  const args = ["-listen", "1", "-i", INPUT, "-c", "copy"];
  for (const t of targets) {
    const base = (t.rtmpUrl || "").replace(/\/+$/, "");
    const full = t.streamKey ? `${base}/${t.streamKey}` : base;
    args.push("-f", "flv", full);
  }
  return args;
}

async function main() {
  const targets = await getTargets();

  if (targets.length === 0) {
    console.error("❌ No active targets. Call POST /multistream/start first.");
    process.exit(1);
  }

  console.log(`📡 Relaying to ${targets.length} destination(s):`);
  targets.forEach((t) => console.log(`   - ${t.platform}`));
  console.log("\n👉 In OBS set  Server = rtmp://localhost:1935/live   Key = twinn");
  console.log("   Then click Start Streaming.\n");

  const ff = spawn("ffmpeg", buildArgs(targets), { stdio: "inherit" });

  ff.on("error", (err) => {
    if (err.code === "ENOENT") {
      console.error(
        "\n❌ ffmpeg not found. Install it (free): https://ffmpeg.org/download.html"
      );
    } else {
      console.error("❌ ffmpeg error:", err.message);
    }
    process.exit(1);
  });

  ff.on("close", (code) => {
    console.log(`\nffmpeg exited (code ${code}). Re-run the relay for another session.`);
    process.exit(code || 0);
  });
}

main().catch((err) => {
  console.error("Relay error:", err.message);
  process.exit(1);
});
