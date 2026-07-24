const express = require("express");
const router  = express.Router();
const pool    = require("../db");
const fetch   = require("node-fetch");
const jwt     = require("jsonwebtoken");
require("dotenv").config();

// Public base URL of THIS backend (used to build the OAuth redirect URI).
const BASE         = process.env.PUBLIC_URL || process.env.RAILWAY_URL || "http://localhost:5000";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

// YouTube login = Google login. Reuse the YouTube (Google) OAuth app if a
// dedicated GOOGLE_* pair isn't set — it's the same Google Cloud project.
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || process.env.YOUTUBE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || process.env.YOUTUBE_CLIENT_SECRET;
const JWT_SECRET           = process.env.JWT_SECRET || "dev-insecure-secret-change-me";
const REDIRECT_URI         = `${BASE}/auth/login/google/callback`;

if (JWT_SECRET === "dev-insecure-secret-change-me") {
  console.warn("⚠️  JWT_SECRET is not set — using an insecure dev secret. Set JWT_SECRET in production.");
}

// Verify a JWT from the Authorization: Bearer <token> header.
function authRequired(req, res, next) {
  const header = req.headers.authorization || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Missing token" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = { id: payload.sub, email: payload.email, name: payload.name };
    next();
  } catch (_) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// GET /auth/login/google — frontend calls this to get the Google sign-in URL.
router.get("/login/google", (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(500).json({ error: "GOOGLE_CLIENT_ID (or YOUTUBE_CLIENT_ID) not configured" });
  }
  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: "code",
    scope:         "openid email profile",   // identity only — not YouTube data
    access_type:   "online",
    prompt:        "select_account",
  });
  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` });
});

// GET /auth/login/google/callback — Google redirects here after consent.
router.get("/login/google/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("Missing authorization code");

  try {
    // 1. Exchange the code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri:  REDIRECT_URI,
        grant_type:    "authorization_code",
        code,
      }),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.error) {
      throw new Error(tokenData.error_description || tokenData.error);
    }

    // 2. Fetch the Google profile (email + name)
    const profileRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileRes.json();
    if (!profile.email) {
      throw new Error("Could not read Google profile email");
    }

    // 3. Create or update the user
    const result = await pool.query(
      `INSERT INTO users (email, name)
       VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, email, name`,
      [profile.email, profile.name || null]
    );
    const user = result.rows[0];

    // 4. Issue our own session token
    const token = jwt.sign(
      { sub: user.id, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    console.log(`✅ Login: ${user.email} (user ${user.id})`);

    // 5. Hand the token to the frontend. Popup -> postMessage; otherwise
    //    redirect with the token in the URL *fragment* (never sent to servers).
    const target = /^https?:\/\//.test(FRONTEND_URL) ? FRONTEND_URL : "*";
    res.send(`<!doctype html><html><body>
      <p>✅ Signed in as ${user.email}. You can close this window.</p>
      <script>
        var token = ${JSON.stringify(token)};
        if (window.opener) {
          window.opener.postMessage({ type: "LOGIN_SUCCESS", token: token }, ${JSON.stringify(target)});
          setTimeout(function(){ window.close(); }, 800);
        } else {
          location.href = ${JSON.stringify(FRONTEND_URL)} + "/login/success#token=" + encodeURIComponent(token);
        }
      </script>
    </body></html>`);
  } catch (err) {
    console.error("Google login error:", err.message);
    res.status(500).send("Login failed: " + err.message);
  }
});

// GET /auth/me — return the signed-in user (send Authorization: Bearer <token>).
router.get("/me", authRequired, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
module.exports.authRequired = authRequired;
