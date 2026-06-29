const express = require("express");
const router  = express.Router();
const pool    = require("../db");
const fetch   = require("node-fetch");
require("dotenv").config();

const REDIRECT_BASE = process.env.RAILWAY_URL || "http://localhost:5000";

const getOAuthURL = (platform) => {
  switch (platform) {
    case "facebook":
      return `https://www.facebook.com/v18.0/dialog/oauth?client_id=${process.env.FACEBOOK_APP_ID}&redirect_uri=${REDIRECT_BASE}/auth/callback/facebook&scope=public_profile&response_type=code`;
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

// GET /auth/instagram/verify — verify Instagram token and save to DB
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
      success: true,
      username: data.username,
      message: "Instagram connected successfully!"
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
      <script>
        window.opener.postMessage(
          { type: "OAUTH_ERROR", platform: "${platform}" },
          "http://localhost:5173"
        );
        window.close();
      </script>
      <p>Error: No code received</p>
    `);
  }

  try {
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
      [1, platform, code]
    );

    console.log(`✅ ${platform} connected and saved to database!`);

    res.send(`
      <html>
        <body>
          <p>✅ ${platform} connected! Closing...</p>
          <script>
            if (window.opener) {
              window.opener.postMessage(
                { type: "OAUTH_SUCCESS", platform: "${platform}" },
                "*"
              );
            }
            setTimeout(() => window.close(), 500);
          </script>
        </body>
      </html>
    `);

  } catch (err) {
    console.error(`❌ Failed to save ${platform} connection:`, err.message);
    res.send(`
      <script>
        window.opener.postMessage(
          { type: "OAUTH_ERROR", platform: "${platform}" },
          "http://localhost:5173"
        );
        window.close();
      </script>
      <p>Error saving connection</p>
    `);
  }
});

module.exports = router;