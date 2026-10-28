-- The players' inbox: one row per note to the DM (worker/index.js writes, Vault/.tools/inbox.py reads and answers).
-- status: uploading (file still coming), new, seen (fetched to the vault), answered, done (closed or folded in)
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  player TEXT NOT NULL,
  created TEXT NOT NULL,
  kind TEXT NOT NULL,
  page_slug TEXT,
  page_title TEXT,
  quote TEXT,
  text TEXT,
  file_name TEXT,
  file_type TEXT,
  file_size INTEGER,
  file_key TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  reply TEXT,
  replied TEXT
);
CREATE INDEX messages_player ON messages (player, created);
CREATE INDEX messages_status ON messages (status);
