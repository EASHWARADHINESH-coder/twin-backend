# Twin Backend — twinn.live Multistream API

Node.js + Express backend for **twinn.live**: connect social/streaming
platforms, sign in with Google, and go live to many destinations at once
(YouTube, Facebook, Rooter, …) via a free local RTMP relay.

- **Runtime:** Node.js 18+
- **Framework:** Express 5
- **Database:** PostgreSQL (`pg`)
- **Auth:** Google (YouTube) OAuth app login → JWT sessions; per-platform OAuth for streaming
- **Streaming:** collects each platform's RTMP target; a local ffmpeg / node-media-server relay fans one OBS stream out to all of them

> **Note on Rooter:** Rooter has no public OAuth API. You stream to Rooter with a
> manual RTMP URL + stream key from Rooter's creator dashboard (see
> `POST /multistream/rtmp`). A `routes/rooter.js` OAuth stub exists in the same
> shape as the other platforms, but is disabled unless official Rooter partner
> OAuth endpoints are provided via `ROOTER_*` env vars.

---

## Setup

```bash
git clone https://github.com/EASHWARADHINESH-coder/twin-backend.git
cd twin-backend
npm install
cp .env.example .env      # then fill in the values you need
npm run dev               # http://localhost:5000
```

### Database
Create the tables (users, connections, oauth_tokens, live_sessions,
rtmp_destinations) by running `database/setup.sql` against your Postgres
(e.g. in the Neon SQL editor, or `psql "$DATABASE_URL" -f database/setup.sql`).

---

## Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | Server port (default 5000; set by the host in production) |
| `FRONTEND_URL` | Allowed CORS origin / redirect target for the frontend |
| `DATABASE_URL` | Postgres connection string (or use the `DB_*` vars below) |
| `DB_HOST` / `DB_PORT` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` | Postgres parts (used if `DATABASE_URL` is unset) |
| `PUBLIC_URL` | Public URL of THIS backend (for OAuth redirect URIs) |
| `JWT_SECRET` | Signs app-login session tokens — **required in production** |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google app login (falls back to `YOUTUBE_*`) |
| `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET` / `FACEBOOK_PAGE_ID` | Facebook connect + live |
| `INSTAGRAM_CLIENT_ID` / `INSTAGRAM_CLIENT_SECRET` / `INSTAGRAM_ACCESS_TOKEN` | Instagram connect |
| `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` | YouTube connect + live |
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` | TikTok connect |
| `ROOTER_*` | Rooter OAuth (only if you have official partner endpoints) |
| `RELAY_STATUS_TOKEN` | Optional shared secret to authorize relay status heartbeats |

---

## API Endpoints

### App login (Google / YouTube)
| Method | Endpoint | Description |
|---|---|---|
| GET | `/auth/login/google` | Get the Google sign-in URL |
| GET | `/auth/login/google/callback` | Google redirect; upserts user, returns a JWT |
| GET | `/auth/me` | Current user (send `Authorization: Bearer <token>`) |

Flow: call `/auth/login/google` → open the `url` → receive a JWT (popup
`postMessage({type:"LOGIN_SUCCESS",token})` or redirect to
`FRONTEND_URL/login/success#token=…`). Use `user.id` as the `userId` below.

### Platform connect (streaming OAuth)
| Method | Endpoint | Description |
|---|---|---|
| GET | `/auth/:platform` | OAuth URL for `facebook` \| `instagram` \| `youtube` \| `tiktok` |
| GET | `/auth/callback/:platform` | OAuth redirect handler (saves token) |
| GET | `/auth/instagram/verify` | Connect Instagram via a long-lived token |
| GET | `/auth/rooter` · `/auth/rooter/callback` | Rooter OAuth stub (disabled unless `ROOTER_*` set) |

### Connections
| Method | Endpoint | Description |
|---|---|---|
| GET | `/connections?userId=<id>` | List a user's connected platforms |
| POST | `/connections` | Save a connection `{ userId, platform, accessToken? }` |
| DELETE | `/connections/:platform` | Disconnect a platform `{ userId }` |

### Multistream
| Method | Endpoint | Description |
|---|---|---|
| GET | `/multistream/platforms?userId=<id>` | Connected platforms + whether a token exists |
| POST | `/multistream/start` | Start a session `{ userId, title, platforms:[] }`; returns each platform's RTMP target |
| POST | `/multistream/stop` | End all active sessions `{ userId }` |
| GET | `/multistream/history?userId=<id>` | Recent live sessions |
| POST | `/multistream/rtmp` | Save a manual RTMP destination (Rooter) `{ userId, platform, rtmpUrl, streamKey }` |
| GET | `/multistream/rtmp?userId=<id>` | List saved RTMP destinations (no keys) |
| GET | `/multistream/targets?userId=<id>` | Active session RTMP targets (used by the relay) |
| POST | `/multistream/status` | Relay status heartbeat (no stream keys) |
| GET | `/multistream/status?userId=<id>` | Latest relay status `{ online, ageSec, relay }` |
| GET | `/multistream/monitor?userId=<id>` | Cloud dashboard that polls the status |

---

## Streaming to Rooter (and everywhere) at once

1. **Connect API platforms** (optional): YouTube / Facebook via `/auth/:platform`
   — twinn auto-creates the broadcast and fetches their stream key.
2. **Add Rooter** (manual RTMP): get an RTMP URL + stream key from Rooter's
   *Go Live from PC* creator dashboard, then:
   ```bash
   curl -X POST http://localhost:5000/multistream/rtmp \
     -H "Content-Type: application/json" \
     -d '{ "userId":1, "platform":"rooter", "rtmpUrl":"rtmp://<from-rooter>", "streamKey":"<from-rooter>" }'
   ```
3. **Start the session:**
   ```bash
   curl -X POST http://localhost:5000/multistream/start \
     -H "Content-Type: application/json" \
     -d '{ "userId":1, "title":"My Live", "platforms":["youtube","rooter"] }'
   ```
4. **Run the relay** and point OBS at it — see [`relay/README.md`](relay/README.md).
   One OBS stream is fanned out to every destination.

---

## Local RTMP relay (free)

The backend only *collects* RTMP targets; a local relay duplicates your single
OBS stream to all of them using **ffmpeg** (free). Two editions:

| Command | Fan-out | On one platform dropping |
|---|---|---|
| `npm run relay` | one ffmpeg (`tee` muxer) | others survive; dropped one waits for OBS restart |
| `npm run relay:nms` | one ffmpeg **per destination** (node-media-server) | **only that one reconnects**, others untouched |

Both expose `/health`, `/status`, and push a heartbeat to
`/multistream/status` so you can watch from the cloud at
`/multistream/monitor?userId=<id>`. Full details in
[`relay/README.md`](relay/README.md).

> The relay runs on your streaming PC ($0). It **cannot** run on a free Render
> web service (no RTMP port 1935, and it sleeps).

---

## Deploy (free)

- **Backend:** Render free tier — a [`render.yaml`](render.yaml) blueprint is
  included (Singapore region, Node 20, auto-deploy). Set `DATABASE_URL`,
  `FRONTEND_URL`, `JWT_SECRET`, `PUBLIC_URL`, and any OAuth keys.
- **Database:** Neon free Postgres (permanent free tier). Run
  `database/setup.sql` once.
- **Relay:** runs locally on your PC (see above).

Register OAuth redirect URIs against your public URL, e.g.
`https://your-app.onrender.com/auth/login/google/callback`.

---

## Project structure

```
twin-backend/
├── database/
│   └── setup.sql          → tables: users, connections, oauth_tokens,
│                            live_sessions, rtmp_destinations
├── routes/
│   ├── login.js           → Google app login + JWT + /auth/me
│   ├── auth.js            → platform connect OAuth (fb/ig/yt/tiktok)
│   ├── rooter.js          → Rooter OAuth stub (env-driven)
│   ├── connections.js     → save/read/delete connections
│   └── multistream.js     → start/stop, RTMP targets, status/monitor
├── relay/
│   ├── relay.js           → ffmpeg tee fan-out relay
│   ├── nms-relay.js       → node-media-server per-destination relay
│   └── README.md          → relay setup + status endpoints
├── db.js                  → PostgreSQL pool
├── server.js              → app entry point
├── render.yaml            → Render deployment blueprint
└── package.json
```
