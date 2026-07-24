const express = require("express");
const fetch   = require("node-fetch");
require("dotenv").config();

const router = express.Router();

/**
 * Rooter OAuth — same shape as the reference Twitch integration
 * (GET / -> redirect to provider, GET /callback -> exchange code for token).
 *
 * IMPORTANT: Rooter does NOT publish a public OAuth API. Unlike Twitch
 * (id.twitch.tv/oauth2/...), there are no official Rooter authorize/token URLs,
 * so they are read from env vars instead of being hardcoded. Fill these in only
 * if you have official Rooter partner OAuth credentials + endpoints:
 *
 *   ROOTER_CLIENT_ID, ROOTER_CLIENT_SECRET, ROOTER_REDIRECT_URI,
 *   ROOTER_AUTHORIZE_URL, ROOTER_TOKEN_URL, ROOTER_USERINFO_URL (optional),
 *   ROOTER_SCOPE (optional)
 *
 * Until then, stream to Rooter via POST /multistream/rtmp (RTMP URL + key from
 * Rooter's creator dashboard) — that's the only path Rooter actually supports.
 */

function oauthConfigured() {
  return Boolean(
    process.env.ROOTER_CLIENT_ID &&
    process.env.ROOTER_AUTHORIZE_URL &&
    process.env.ROOTER_TOKEN_URL &&
    process.env.ROOTER_REDIRECT_URI
  );
}

const NOT_CONFIGURED_MSG =
  "Rooter has no public OAuth API. Set ROOTER_* env vars only if you have " +
  "official Rooter partner OAuth endpoints. To stream to Rooter now, use " +
  "POST /multistream/rtmp with your Rooter RTMP URL + stream key.";

// GET /auth/rooter — redirect the user to Rooter's OAuth consent screen
router.get("/", (req, res) => {
  if (!oauthConfigured()) {
    return res.status(501).json({ success: false, message: NOT_CONFIGURED_MSG });
  }

  const url =
    `${process.env.ROOTER_AUTHORIZE_URL}` +
    `?client_id=${process.env.ROOTER_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.ROOTER_REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(process.env.ROOTER_SCOPE || "profile")}`;

  res.redirect(url);
});

// GET /auth/rooter/callback — exchange the code for a token and fetch profile
router.get("/callback", async (req, res) => {
  try {
    if (!oauthConfigured()) {
      return res.status(501).json({ success: false, message: NOT_CONFIGURED_MSG });
    }

    const code = req.query.code;
    if (!code) {
      return res.status(400).json({
        success: false,
        message: "Authorization code not received.",
      });
    }

    // Exchange the authorization code for an access token
    const tokenRes = await fetch(process.env.ROOTER_TOKEN_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id:     process.env.ROOTER_CLIENT_ID,
        client_secret: process.env.ROOTER_CLIENT_SECRET,
        code,
        grant_type:    "authorization_code",
        redirect_uri:  process.env.ROOTER_REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();

    if (!tokenRes.ok || tokenData.error) {
      throw new Error(
        tokenData.error_description || tokenData.error ||
        `Token exchange failed (${tokenRes.status})`
      );
    }

    const accessToken = tokenData.access_token;

    // Optionally fetch the Rooter user profile
    let user = null;
    if (process.env.ROOTER_USERINFO_URL) {
      const userRes = await fetch(process.env.ROOTER_USERINFO_URL, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      user = await userRes.json();
    }

    res.json({ success: true, accessToken, user });
  } catch (err) {
    console.error("Rooter OAuth error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
