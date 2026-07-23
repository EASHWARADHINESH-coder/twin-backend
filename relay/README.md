# Twinn RTMP Relay (free)

Fan **one** OBS stream out to **many** platforms at once — YouTube, Facebook,
Rooter, and any custom RTMP destination — with zero paid services.

## Why a relay?

The backend only *collects* each platform's RTMP URL + stream key. OBS can push
to **one** destination at a time, so to go live everywhere simultaneously you
need something that duplicates the stream. This relay does that with **ffmpeg**
(`-c copy`, so no re-encoding and no CPU cost).

## Cost: $0

- **ffmpeg** is free and open source — no account, no license fee.
- Run it on the **same PC as OBS** — the machine is already on when you stream,
  so there's no extra hosting cost.
- The only "cost" is **upload bandwidth**: streaming to N platforms uses
  roughly N × your OBS bitrate on your internet connection (not money).

> ⚠️ This relay **cannot** run on Render's free tier — free web services don't
> expose the RTMP port (1935) and sleep when idle. Keep it local, or put it on
> an always-free cloud VM (e.g. Oracle Cloud Always Free) if you want it 24/7.

## Setup

1. **Install ffmpeg** (free): https://ffmpeg.org/download.html
   Verify it works:
   ```bash
   ffmpeg -version
   ```

2. **Start a multistream** so the targets exist in the database:
   ```bash
   curl -X POST http://localhost:5000/multistream/start \
     -H "Content-Type: application/json" \
     -d '{ "userId": 1, "title": "My Live", "platforms": ["youtube", "rooter"] }'
   ```

3. **Run the relay:**
   ```bash
   npm run relay
   ```
   Point it at a deployed backend instead of localhost:
   ```bash
   BACKEND_URL=https://your-app.onrender.com USER_ID=1 npm run relay
   ```

4. **Configure OBS** → Settings → Stream:
   - **Service:** Custom
   - **Server:** `rtmp://localhost:1935/live`
   - **Stream Key:** `twinn`

5. Click **Start Streaming** in OBS. You're now live on every destination.

## How it works

```
                       ┌─> YouTube  (rtmp + key)
OBS ──> relay (ffmpeg) ┼─> Facebook (rtmp + key)
   rtmp://localhost    └─> Rooter   (rtmp + key)
```

The relay calls `GET /multistream/targets?userId=<id>` to fetch the active
session's destinations, then runs a single ffmpeg process (using the `tee`
muxer) that listens for OBS and copies the stream to each one.

## Auto-restart & reconnect

The relay is supervised so a hiccup doesn't end your stream:

- **Whole-relay auto-restart** — if ffmpeg exits (OBS disconnects, a network
  blip, or you started the relay before OBS / before `POST /multistream/start`),
  the supervisor waits and restarts it automatically with exponential backoff
  (1s → 2s → 4s … capped at 15s). A run that stays healthy for 30s+ resets the
  backoff. On each restart it **re-fetches the targets**, so newly added or
  recovered destinations rejoin.
- **One bad destination won't kill the rest** — the `tee` muxer uses
  `onfail=ignore`, so if a single platform rejects or drops (e.g. Rooter's
  bitrate limit), the others keep streaming.
- **Ctrl+C** stops the relay cleanly.

> Note: with `onfail=ignore`, a destination that drops *mid-session* stays
> dropped until the next ffmpeg restart (i.e. when OBS reconnects). For a fully
> independent per-destination reconnect you'd run a dedicated RTMP server
> (e.g. node-media-server) — ask if you want that upgrade.

## Environment variables

| Variable      | Default                              | Purpose                          |
|---------------|--------------------------------------|----------------------------------|
| `BACKEND_URL` | `http://localhost:5000`              | Where the twin-backend API runs  |
| `USER_ID`     | `1`                                  | Whose active session to relay    |
| `RELAY_INPUT` | `rtmp://0.0.0.0:1935/live/twinn`     | Where OBS connects               |
