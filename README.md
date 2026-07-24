# Twin Backend — Social Connect API

Node.js + Express backend for the Twin Social Connect feature.

## Setup

### Prerequisites
- Node.js 18+ installed

### Installation
```bash
git clone https://github.com/YOUR_USERNAME/twin-backend.git
cd twin-backend
npm install
```

### Run the server
```bash
npm run dev
```
Server runs on `http://localhost:5000`

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Check server is running |
| GET | `/connections?userId=user1` | Get all connected platforms |
| POST | `/connections` | Save a new connection |
| DELETE | `/connections/:platform` | Disconnect a platform |
| GET | `/auth/:platform` | Get OAuth URL for a platform (streaming connect) |
| GET | `/auth/login/google` | Get the Google sign-in URL (app login) |
| GET | `/auth/login/google/callback` | Google redirect; issues a session JWT |
| GET | `/auth/me` | Current signed-in user (send `Authorization: Bearer <token>`) |

## App login (Google / YouTube)

Users sign in with Google (YouTube login = Google login) to get a real account
instead of the hardcoded `userId=1`.

**Flow**
1. Frontend calls `GET /auth/login/google` → gets a `url`, opens it (popup or redirect).
2. User approves; Google redirects to `/auth/login/google/callback`.
3. Backend upserts the user into the `users` table and returns a signed **JWT**:
   - popup → `window.postMessage({ type: "LOGIN_SUCCESS", token })`
   - redirect → `FRONTEND_URL/login/success#token=<jwt>` (token in the URL fragment)
4. Frontend stores the JWT and sends it as `Authorization: Bearer <token>`.
   `GET /auth/me` returns `{ user: { id, email, name } }`; use `user.id` as the
   `userId` for the connections / multistream endpoints.

**Config** (`.env`) — reuses your Google/YouTube OAuth app:
```
GOOGLE_CLIENT_ID=      # falls back to YOUTUBE_CLIENT_ID if blank
GOOGLE_CLIENT_SECRET=  # falls back to YOUTUBE_CLIENT_SECRET
JWT_SECRET=            # REQUIRED in production (signs session tokens)
PUBLIC_URL=            # this backend's public URL, e.g. https://your-app.onrender.com
```

In Google Cloud Console, add this Authorized redirect URI:
`https://your-app.onrender.com/auth/login/google/callback`

## Project Structure

twin-backend/

├── routes/

│   ├── auth.js          → OAuth routes

│   └── connections.js   → Save/read/delete connections

├── data/

│   └── connections.json → Simple JSON database

├── server.js            → Main server entry point

├── .env                 → Secret API keys (not on GitHub)

└── package.json
