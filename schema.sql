CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_lc TEXT NOT NULL UNIQUE,
  salt TEXT NOT NULL,
  hash TEXT NOT NULL,
  iters INTEGER NOT NULL DEFAULT 100000,
  created INTEGER NOT NULL,
  avatar TEXT,
  avatar_v INTEGER NOT NULL DEFAULT 0,
  prefs TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'online',
  last_seen INTEGER NOT NULL DEFAULT 0,
  banned INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  suspended_until INTEGER,
  reason TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  created INTEGER NOT NULL,
  last_used INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS recovery (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (k TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS attempts_k ON attempts(k, ts);

-- ===== slice 2: presence, friends, messages, admin =====
CREATE TABLE IF NOT EXISTS presence (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  idle_since INTEGER, game TEXT, activity TEXT, world_code TEXT, playing_with TEXT, world_name TEXT, game_since INTEGER
);
CREATE TABLE IF NOT EXISTS friendships (
  lo INTEGER NOT NULL, hi INTEGER NOT NULL,            -- lo < hi user ids
  requester INTEGER NOT NULL,
  accepted INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL, accepted_at INTEGER,
  PRIMARY KEY (lo, hi)
);
CREATE INDEX IF NOT EXISTS friendships_hi ON friendships(hi);
CREATE TABLE IF NOT EXISTS blocks (
  blocker INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created INTEGER NOT NULL, PRIMARY KEY (blocker, blocked)
);
CREATE TABLE IF NOT EXISTS parties (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner INTEGER NOT NULL, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS party_members (
  party_id INTEGER NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (party_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat TEXT NOT NULL,                 -- "dm:<lo>:<hi>", "p:<partyId>", later "c:<channelId>"
  author INTEGER NOT NULL,
  body TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  edited INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  reply INTEGER
);
CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat, id);
CREATE INDEX IF NOT EXISTS messages_upd ON messages(chat, updated);
CREATE TABLE IF NOT EXISTS reactions (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL, emoji TEXT NOT NULL, created INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS reads (
  user_id INTEGER NOT NULL, chat TEXT NOT NULL, last_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, chat)
);
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY, owner INTEGER NOT NULL, mime TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_grants (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, perm TEXT NOT NULL, PRIMARY KEY (user_id, perm)
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT
);
CREATE TABLE IF NOT EXISTS games (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, tagline TEXT NOT NULL DEFAULT '', path TEXT, state TEXT NOT NULL DEFAULT 'soon',
  open_to_all INTEGER NOT NULL DEFAULT 1, art TEXT, sort INTEGER NOT NULL DEFAULT 0, tag TEXT, rebuild INTEGER NOT NULL DEFAULT 0, unlocks INTEGER
);
CREATE TABLE IF NOT EXISTS game_access (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, game TEXT NOT NULL, allowed INTEGER NOT NULL, PRIMARY KEY (user_id, game)
);
CREATE TABLE IF NOT EXISTS patch_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, game TEXT NOT NULL, build INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  reinstall INTEGER NOT NULL DEFAULT 0, released INTEGER NOT NULL,   -- reinstall: 0 none, 1 required new game file, 2 optional
  UNIQUE (game, build)
);
INSERT OR IGNORE INTO games (id, name, art, sort, state) VALUES
 ('minecraft','Minecraft','minecraft',0,'soon'),('terraria','Terraria','terraria',1,'soon'),('gardendless','Gardendless','gardendless',2,'soon'),
 ('gettingoverit','Getting Over It','gettingoverit',3,'soon'),('plague','Plague Inc: Evolved','plague',4,'soon'),('amongus','Among Us','amongus',5,'soon'),
 ('btd6','Bloons TD 6','btd6',6,'soon'),('stickfight','Stick Fight','stickfight',7,'soon');
