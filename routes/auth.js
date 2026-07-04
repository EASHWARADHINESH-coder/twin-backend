const express = require("express");
const router  = express.Router();
const pool    = require("../db");
const fetch   = require("node-fetch");
require("dotenv").config();

const REDIRECT_BASE = process.env.RAILWAY_URL || "http://localhost:5000";

const getOAuthURL = (platform) => {
  switch (platform) {
    case "facebook":
      return `https://www.facebook.com/v18.0/dialog/oauth?client_id=${process.env.FACEBOOK_APP_ID}&redirect_uri=${REDIRECT_BASE}/auth/callback/facebook&scope=public_profile,pages_manage_posts,pages_read_engagement,pages_show_list&response_type=code&auth_type=rerequest`;
    case "instagram":
      return `https://www.instagram.com/oauth/authorize?client_id=${process.env.INSTAGRAM_CLIENT_ID}&redirect_uri=${REDIRECT_BASE}/auth/callback/instagram&scope=instagram_business_basic&response_type=code`;
    case "youtube":
      return `https://accounts.google.com/o/oauth2/auth?client_id=${process.env.YOUTUBE_CLIENT_ID}&redirect_uri=${REDIRECT_BASE}/auth/callback/youtube&scope=https://www.googleapis.com/auth/youtube&response_type=code`;
    case "tiktok":
      return `https://www.tiktok.com/auth/authorize/?client_key=${process.env.TIKTOK_CLIENT_KEY}&redirect_uri=${REDIRECT_BASE}/auth/callback/tiktok&scope=user.info.basic&response_type=code`;
    default:
      return null;
  }
};

// GET /auth/instagram/verify
router.get("/instagram/verify", async (req, res) => {
  try {
    const token    = process.env.INSTAGRAM_ACCESS_TOKEN;
    const response = await fetch(
      `https://graph.instagram.com/me?fields=id,name,username&access_token=${token}`
    );
    const data = await response.json();

    if (data.error) {
      return res.status(400).json({ error: data.error.message });
    }

    await pool.query(
      `INSERT INTO connections (user_id, platform)
       VALUES ($1, $2)
       ON CONFLICT (user_id, platform) DO UPDATE
       SET connected_at = CURRENT_TIMESTAMP`,
      [1, "instagram"]
    );

    await pool.query(
      `INSERT INTO oauth_tokens (user_id, platform, access_token)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, platform) DO UPDATE
       SET access_token = $3`,
      [1, "instagram", token]
    );

    console.log("✅ Instagram connected:", data.username);
    res.json({
      success:  true,
      username: data.username,
      message:  "Instagram connected successfully!"
    });

  } catch (err) {
    console.error("Instagram verify error:", err.message);
    res.status(500).json({ error: "Failed to connect Instagram" });
  }
});

// GET /auth/:platform — frontend calls this to get OAuth URL
router.get("/:platform", (req, res) => {
  const { platform } = req.params;
  const url          = getOAuthURL(platform);
  if (!url) return res.status(400).json({ error: "Unknown platform" });
  res.json({ url });
});

// GET /auth/callback/:platform — platform redirects here after login
router.get("/callback/:platform", async (req, res) => {
  const { platform } = req.params;
  const { code }     = req.query;

  if (!code) {
    return res.send(`
      <html><body>
        <script>
          if (window.opener) {
            window.opener.postMessage(
              { type: "OAUTH_ERROR", platform: "${platform}" }, "*"
            );
          }
          window.close();
        </script>
      </body></html>
    `);
  }

  try {
    let accessToken = code; // fallback — will be replaced below

    // ── Exchange code for real access token ──────────────

    if (platform === "facebook") {
      console.log("🔄 Exchanging Facebook code for real token...");

      const tokenRes  = await fetch(
        `https://graph.facebook.com/v18.0/oauth/access_token?` +
        `client_id=${process.env.FACEBOOK_APP_ID}` +
        `&client_secret=${process.env.FACEBOOK_APP_SECRET}` +
        `&redirect_uri=${REDIRECT_BASE}/auth/callback/facebook` +
        `&code=${code}`
      );
      const tokenData = await tokenRes.json();

      if (tokenData.error) {
        throw new Error(`Facebook token error: ${tokenData.error.message}`);
      }

      accessToken = tokenData.access_token;
      console.log("✅ Facebook real access token received!");
    }

    if (platform === "instagram") {
      console.log("🔄 Exchanging Instagram code for real token...");

      const tokenRes  = await fetch(
        `https://api.instagram.com/oauth/access_token`,
        {
          method:  "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            client_id:     process.env.INSTAGRAM_CLIENT_ID,
            client_secret: process.env.INSTAGRAM_CLIENT_SECRET,
            grant_type:    "authorization_code",
            redirect_uri:  `${REDIRECT_BASE}/auth/callback/instagram`,
            code,
          }),
        }
      );
      const tokenData = await tokenRes.json();

      if (tokenData.error_type) {
        throw new Error(`Instagram token error: ${tokenData.error_message}`);
      }

      accessToken = tokenData.access_token;
      console.log("✅ Instagram real access token received!");
    }

    // ── Save to PostgreSQL ──────────────────────────────

    await pool.query(
      `INSERT INTO connections (user_id, platform)
       VALUES ($1, $2)
       ON CONFLICT (user_id, platform) DO UPDATE
       SET connected_at = CURRENT_TIMESTAMP`,
      [1, platform]
    );

    await pool.query(
      `INSERT INTO oauth_tokens (user_id, platform, access_token)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, platform) DO UPDATE
       SET access_token = $3`,
      [1, platform, accessToken]
    );

    console.log(`✅ ${platform} real token saved to database!`);

    const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

    res.send(`
      <html><body>
        <p>✅ ${platform} connected! Closing...</p>
        <script>
          function sendAndClose() {
            if (window.opener) {
              window.opener.postMessage(
                { type: "OAUTH_SUCCESS", platform: "${platform}" }, "*"
              );
              setTimeout(() => window.close(), 1000);
            } else {
              window.location.href = "${FRONTEND_URL}/success/${platform}";
            }
          }
          sendAndClose();
        </script>
      </body></html>
    `);

  } catch (err) {
    console.error(`❌ Failed to save ${platform}:`, err.message);
    res.send(`
      <html><body>
        <script>
          if (window.opener) {
            window.opener.postMessage(
              { type: "OAUTH_ERROR", platform: "${platform}" }, "*"
            );
          }
          window.close();
        </script>
        <p>Error: ${err.message}</p>
      </body></html>
    `);
  }
});

module.exports = router;