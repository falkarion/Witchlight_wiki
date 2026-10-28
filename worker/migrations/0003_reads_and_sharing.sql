-- Reading is tracked per paragraph: a paragraph counts as read once it has been on the player's
-- screen (for-player.js). One row per player and page: when they first opened it, and the
-- fingerprints of the paragraphs they have read (a JSON list). Replaces views (page level).
CREATE TABLE reads (
  player TEXT NOT NULL,
  slug TEXT NOT NULL,
  first TEXT NOT NULL,
  blocks TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (player, slug)
);
DROP TABLE views;
-- A note is private (only the DM) unless the player shares it with the other players; shared
-- notes show to every player whose own version of the page contains the quoted text.
ALTER TABLE messages ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
CREATE INDEX messages_page ON messages (page_slug);
