const express = require("express");
const router  = express.Router();
require("dotenv").config();

const REDIRECT_BASE = "http://localhost:5000";

// OAuth URLs for each platform
const getOAuthURL = (platform) => {
  switch (platform) {
    case "instagram":
      return `https://api.instagram.com/oauth/authorize?client_id=${process.env.INSTAGRAM_CLIENT_ID}&redirect_uri=${REDIRECT_BASE}/auth/callback/instagram&scope=user_profile,user_media&response_type=code`;

    case "facebook":
      return `https://www.facebook.com/v18.0/dialog/oauth?client_id=${process.env.FACEBOOK_APP_ID}&redirect_uri=${REDIRECT_BASE}/auth/callback/facebook&scope=pages_manage_posts&response_type=code`;

    case "youtube":
      return `https://accounts.google.com/o/oauth2/auth?client_id=${process.env.YOUTUBE_CLIENT_ID}&redirect_uri=${REDIRECT_BASE}/auth/callback/youtube&scope=https://www.googleapis.com/auth/youtube&response_type=code`;

    case "tiktok":
      return `https://www.tiktok.com/auth/authorize/?client_key=${process.env.TIKTOK_CLIENT_KEY}&redirect_uri=${REDIRECT_BASE}/auth/callback/tiktok&scope=user.info.basic&response_type=code`;

    default:
      return null;
  }
};

// GET /auth/:platform — frontend calls this to start OAuth
router.get("/:platform", (req, res) => {
  const { platform } = req.params;
  const url          = getOAuthURL(platform);

  if (!url) {
    return res.status(400).json({ error: "Unknown platform" });
  }

  res.json({ url });
});

// GET /auth/callback/:platform — platform redirects here after login
router.get("/callback/:platform", async (req, res) => {
  const { platform } = req.params;
  const { code }     = req.query;

  if (!code) {
    return res.send("<script>window.close();</script><p>Error: No code received</p>");
  }

  // TODO: Exchange code for real access token
  // For now we just close the popup and tell frontend it worked
  console.log(`✅ ${platform} OAuth code received: ${code}`);

  res.send(`
    <html>
      <body>
        <p>✅ ${platform} connected! Closing...</p>
        <script>
          window.opener.postMessage(
            { type: "OAUTH_SUCCESS", platform: "${platform}" },
            "http://localhost:5173"
          );
          window.close();
        </script>
      </body>
    </html>
  `);
});

module.exports = router;