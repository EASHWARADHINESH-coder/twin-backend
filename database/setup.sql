CREATE TABLE IF NOT EXISTS users (
  id         SERIAL PRIMARY KEY,
  email      VARCHAR(255) UNIQUE NOT NULL,
  name       VARCHAR(255),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS connections (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  platform     VARCHAR(50) NOT NULL,
  connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, platform)
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
  platform      VARCHAR(50) NOT NULL,
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    TIMESTAMP,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, platform)
);

-- Live streaming sessions (written by /multistream/start and /stop)
CREATE TABLE IF NOT EXISTS live_sessions (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  platform   VARCHAR(50) NOT NULL,
  stream_id  VARCHAR(255),
  rtmp_url   TEXT,
  stream_key TEXT,
  title      VARCHAR(255),
  status     VARCHAR(20) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ended_at   TIMESTAMP
);

-- Manual RTMP destinations for platforms without an OAuth API (e.g. Rooter)
CREATE TABLE IF NOT EXISTS rtmp_destinations (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  platform   VARCHAR(50) NOT NULL,
  rtmp_url   TEXT NOT NULL,
  stream_key TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, platform)
);

INSERT INTO users (email, name)
VALUES ('test@twinn.com', 'Test User')
ON CONFLICT (email) DO NOTHING;