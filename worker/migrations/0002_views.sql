-- When each player last opened each page (worker/index.js writes; the wiki marks pages changed since, inbox.py shows who has read what).
CREATE TABLE views (
  player TEXT NOT NULL,
  slug TEXT NOT NULL,
  seen TEXT NOT NULL,
  PRIMARY KEY (player, slug)
);
