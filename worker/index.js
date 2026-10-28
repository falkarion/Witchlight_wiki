// The Witchlight wiki's server (a Cloudflare Worker in front of the built sites).
//
// publish.py builds the wiki once per audience into dist/<audience>/: "public" and one per
// player. This Worker runs before every request (run_worker_first) and serves a visitor
// the public build and a logged-in player their own build, so a page with someone else's
// secrets is never served to them. It also keeps the players' inbox:
//   POST /api/login   {passphrase}   checks it against players.json, sets the login cookie
//   POST /api/logout                 clears it
//   GET  /api/me                     {name} of the logged-in player, or {name: null}
//   POST /api/inbox   {kind, page, quote, text, shared, file?}   a note to the DM (D1: messages)
//   PUT  /api/inbox/<id>/file        the note's picture or sound, raw (KV: FILES)
//   GET  /api/notes                  the player's own notes, with the DM's answers
//   POST /api/notes/<id>/share       a private note becomes shared (never back)
//   GET  /api/page-notes?slug=…      the notes to show in a page: own, and others' shared ones
//   GET  /api/reads                  per page: first opened, the paragraphs read (D1: reads)
//   POST /api/read    {slug, blocks} paragraphs that have been on the player's screen
//   POST /api/notify  {to, text}     a Discord message from the DM's PC (inbox.py), signed with SITE_KEY
// A new note sends the DM a Discord message; inbox.py sends players theirs (answers, new pages).
// Messages go out as direct messages from the campaign's private bot (DISCORD_TOKEN secret) to the
// ids in notify.json (written by publish.py). The preview (DISCORD_ONLY_DM) sends everything to the DM.
// The reads let the wiki mark what a player hasn't read yet, paragraph by paragraph, and let
// the DM see who has read what. The DM's PC reads and answers the inbox, and reads the
// reads, with Vault/.tools/inbox.py (wrangler d1/kv).
//
// players.json (written by publish.py) holds, per player, an HMAC of the passphrase keyed
// with SITE_KEY (a secret), their build's folder and their own page. Never the passphrase.
// The preview site (wrangler.toml [env.preview]) also has a test login, "Tester", from its
// own TEST_LOGIN secret; it sees the build named by TEST_DIR. The live site has no test login.
import players from "./players.json"
import notify from "./notify.json"

const COOKIE = "wl"
const LOGIN_DAYS = 400
const MAX_FILE = 15 * 1024 * 1024
const KINDS = ["correction", "answer", "question", "upload", "other"]

const enc = new TextEncoder()
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")

async function hmac(secret, text) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(text)))
}

function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } })

// --- login ----------------------------------------------------------------------------------
function accounts(env) {
  if (!env.TEST_LOGIN) return players
  return { ...players, Tester: { hash: env.TEST_LOGIN, dir: env.TEST_DIR || "public", page: null } }
}

// The cookie is name.expiry.signature; the signature covers the passphrase's fingerprint, so
// changing a player's passphrase logs out every device that used the old one.
async function sign(env, name, exp) {
  return hmac(env.SITE_KEY, `${name}|${exp}|${accounts(env)[name].hash}`)
}

async function viewer(request, env) {
  const raw = (request.headers.get("cookie") || "").split(/;\s*/).find((c) => c.startsWith(COOKIE + "="))
  if (!raw) return null
  const [name64, exp, sig] = raw.slice(COOKIE.length + 1).split(".")
  let name
  try {
    name = decodeURIComponent(atob(name64))
  } catch {
    return null
  }
  if (!accounts(env)[name] || !(Number(exp) > Date.now() / 1000)) return null
  return same(sig, await sign(env, name, exp)) ? name : null
}

async function login(request, env) {
  const { passphrase } = await request.json().catch(() => ({}))
  if (typeof passphrase !== "string" || !passphrase.trim()) return json(400, { error: "Enter your passphrase." })
  const fingerprint = await hmac(env.SITE_KEY, passphrase.trim())
  const all = accounts(env)
  const name = Object.keys(all).find((n) => same(all[n].hash, fingerprint))
  if (!name) return json(403, { error: "That key doesn't fit." })
  const exp = String(Math.floor(Date.now() / 1000) + LOGIN_DAYS * 86400)
  const value = `${btoa(encodeURIComponent(name))}.${exp}.${await sign(env, name, exp)}`
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : ""
  return json(200, { name, page: all[name].page }, {
    "set-cookie": `${COOKIE}=${value}; Path=/; Max-Age=${LOGIN_DAYS * 86400}; HttpOnly; SameSite=Lax${secure}`,
  })
}

const logout = () => json(200, { ok: true }, { "set-cookie": `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax` })

// --- the inbox ------------------------------------------------------------------------------
const clip = (s, n) => (typeof s === "string" ? s.slice(0, n) : "")

// --- Discord: a direct message from the bot ("dm" or a player's name)
async function discord(env, to, text) {
  if (!env.DISCORD_TOKEN) return
  let id = to === "dm" ? notify.dm : notify.players?.[to]
  if (env.DISCORD_ONLY_DM && to !== "dm") [id, text] = [notify.dm, `*(preview, for ${to})* ${text}`]
  if (!id) return
  const api = (path, body) => fetch(`https://discord.com/api/v10${path}`, {
    method: "POST",
    headers: { authorization: `Bot ${env.DISCORD_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const channel = await (await api("/users/@me/channels", { recipient_id: id })).json().catch(() => null)
  if (channel?.id) await api(`/channels/${channel.id}/messages`, { content: text.slice(0, 1900), allowed_mentions: { parse: [] } })
}

// inbox.py's messages: the body is signed with SITE_KEY, so only the DM's PC can send them
async function notifyFromDM(request, env, ctx) {
  const body = await request.text()
  if (!same(request.headers.get("x-signature") || "", await hmac(env.SITE_KEY, body))) return json(403, { error: "Not signed." })
  const m = JSON.parse(body)
  if (m.to !== "dm" && !notify.players?.[m.to]) return json(404, { error: "No such player." })
  ctx.waitUntil(discord(env, m.to, clip(m.text, 1900)))
  return json(200, { ok: true })
}

async function sendNote(request, env, ctx, name) {
  const m = await request.json().catch(() => null)
  if (!m) return json(400, { error: "Not a message." })
  const text = clip(m.text, 20000).trim()
  const file = m.file && typeof m.file === "object" ? m.file : null
  if (!text && !file) return json(400, { error: "Write something or add a file first." })
  if (file && !(Number(file.size) > 0 && Number(file.size) <= MAX_FILE)) return json(413, { error: "That file is too big (15 MB at most)." })
  const created = new Date().toISOString()
  const id = `${created.replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`
  await env.DB.prepare(
    `INSERT INTO messages (id, player, created, kind, page_slug, page_title, quote, text, file_name, file_type, file_size, status, shared)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, name, created, KINDS.includes(m.kind) ? m.kind : "other", clip(m.page?.slug, 200), clip(m.page?.title, 200),
      clip(m.quote, 2000), text, file ? clip(file.name, 200) : null, file ? clip(file.type, 100) : null,
      file ? Number(file.size) : null, file ? "uploading" : "new", m.shared === true ? 1 : 0)
    .run()
  const what = KINDS.includes(m.kind) ? m.kind : "note"
  const on = clip(m.page?.title, 200)
  ctx.waitUntil(discord(env, "dm", `📬 **${name}** sent a ${what}${on ? ` on “${on}”` : ""}${file ? " (with a file)" : ""}` +
    `${m.shared === true ? ", shared with the others" : ""}:\n> ${clip(text, 300).replace(/\n+/g, "\n> ")}\nSay “check the inbox” to fetch it.`))
  return json(200, { id })
}

async function sendFile(request, env, name, id) {
  const row = await env.DB.prepare("SELECT file_size, status FROM messages WHERE id = ? AND player = ?").bind(id, name).first()
  if (!row || row.status !== "uploading") return json(404, { error: "No note waiting for this file." })
  const size = Number(request.headers.get("content-length") || 0)
  if (!size || size > MAX_FILE) return json(413, { error: "That file is too big (15 MB at most)." })
  await env.FILES.put(`file:${id}`, request.body, { metadata: { player: name } })
  await env.DB.prepare("UPDATE messages SET file_key = ?, status = 'new' WHERE id = ?").bind(`file:${id}`, id).run()
  return json(200, { ok: true })
}

async function shareNote(env, name, id) {
  const { meta } = await env.DB.prepare("UPDATE messages SET shared = 1 WHERE id = ? AND player = ?").bind(id, name).run()
  return meta.changes ? json(200, { ok: true }) : json(404, { error: "Not one of your notes." })
}

async function myNotes(env, name) {
  const { results } = await env.DB.prepare(
    `SELECT id, created, kind, page_slug, page_title, quote, text, file_name, status, reply, replied, shared
     FROM messages WHERE player = ? AND status != 'uploading' ORDER BY created DESC LIMIT 500`,
  )
    .bind(name)
    .all()
  return json(200, { notes: results })
}

// --- notes in the page ---------------------------------------------------------------------
// Quotes are compared without any whitespace and in lower case, on the page's article text: a
// selection and the built page then agree however tags and line breaks fall between words.
const squash = (s) => String(s || "").toLowerCase().replace(/\s+/g, "")
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }

function articleText(html) {
  const m = html.match(/<article[^>]*>([\s\S]*?)<\/article>/)
  return (m ? m[1] : "")
    .replace(/<(script|style|svg|button)[\s\S]*?<\/\1>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, e) =>
      e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()] ?? all,
    )
}

// The page as this player's own build has it, squashed; null when their build hasn't got it.
async function pageFor(request, env, dir, slug) {
  const res = await env.ASSETS.fetch(new Request(new URL(`/${dir}/${slug === "index" ? "" : slug}`, request.url)))
  return res.status === 200 ? squash(articleText(await res.text())) : null
}

// The player's own notes on a page, and the other players' shared notes on it that this player
// may see: only when their own version of the page has the page and the quoted text, so a shared
// note never carries a passage someone else can't read.
async function pageNotes(request, env, name, slug) {
  if (!slug || slug.length > 200) return json(400, { error: "Which page?" })
  const { results } = await env.DB.prepare(
    `SELECT id, player, created, kind, quote, text, file_name, status, reply, replied, shared
     FROM messages WHERE page_slug = ? AND status != 'uploading' AND (player = ? OR shared = 1) ORDER BY created`,
  )
    .bind(slug, name)
    .all()
  let mine = null
  const notes = []
  for (const n of results) {
    if (n.player !== name) {
      if (mine === null) mine = (await pageFor(request, env, accounts(env)[name].dir, slug)) ?? ""
      if (!mine || (n.quote && !mine.includes(squash(n.quote)))) continue
      n.file_name = null
    }
    notes.push({ ...n, mine: n.player === name })
  }
  return json(200, { notes })
}

// --- reading --------------------------------------------------------------------------------
// The wiki script reports the paragraphs (fingerprints) that have been on screen; a page is read
// when all of its paragraphs are. Opening a page without reading anything records `first`.
async function myReads(env, name) {
  const { results } = await env.DB.prepare("SELECT slug, first, blocks FROM reads WHERE player = ?").bind(name).all()
  return json(200, { reads: Object.fromEntries(results.map((r) => [r.slug, { first: r.first, blocks: JSON.parse(r.blocks) }])) })
}

async function markRead(request, env, name) {
  const { slug, blocks } = await request.json().catch(() => ({}))
  if (typeof slug !== "string" || !slug || slug.length > 200) return json(400, { error: "Which page?" })
  const ids = (Array.isArray(blocks) ? blocks : []).filter((b) => typeof b === "string" && /^[0-9a-f]{8}$/.test(b)).slice(0, 2000)
  const row = await env.DB.prepare("SELECT first, blocks FROM reads WHERE player = ? AND slug = ?").bind(name, slug).first()
  const merged = [...new Set([...(row ? JSON.parse(row.blocks) : []), ...ids])].slice(-5000)
  await env.DB.prepare(
    `INSERT INTO reads (player, slug, first, blocks) VALUES (?, ?, ?, ?)
     ON CONFLICT (player, slug) DO UPDATE SET blocks = excluded.blocks`,
  )
    .bind(name, slug, row ? row.first : new Date().toISOString(), JSON.stringify(merged))
    .run()
  return json(200, { ok: true })
}

// --- the builds -----------------------------------------------------------------------------
async function page(request, env, dir) {
  const url = new URL(request.url)
  const inner = new URL(`/${dir}${url.pathname}${url.search}`, url)
  let res = await env.ASSETS.fetch(new Request(inner, request))
  if (res.status >= 300 && res.status < 400) {
    // the asset server redirects within the build (e.g. /x/index.html -> /x/): keep the visitor's address
    const to = new URL(res.headers.get("location"), inner)
    if (to.pathname.startsWith(`/${dir}/`) || to.pathname === `/${dir}`) {
      return new Response(null, { status: res.status, headers: { location: to.pathname.slice(dir.length + 1) || "/" } })
    }
    return res
  }
  if (res.status === 404) {
    const missing = await env.ASSETS.fetch(new Request(new URL(`/${dir}/404.html`, url)))
    res = new Response(missing.body, { status: 404, headers: missing.headers })
  }
  const out = new Response(res.body, res)
  out.headers.set("cache-control", "private, no-cache")
  out.headers.set("vary", "cookie")
  return out
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const path = url.pathname
    if (path.startsWith("/api/")) {
      if (path === "/api/login" && request.method === "POST") return login(request, env)
      if (path === "/api/logout" && request.method === "POST") return logout()
      if (path === "/api/notify" && request.method === "POST") return notifyFromDM(request, env, ctx)
      const name = await viewer(request, env)
      if (path === "/api/me") return json(200, { name, page: name ? accounts(env)[name].page : null })
      if (!name) return json(401, { error: "Log in with your passphrase first." })
      if (path === "/api/inbox" && request.method === "POST") return sendNote(request, env, ctx, name)
      const file = path.match(/^\/api\/inbox\/([\w-]+)\/file$/)
      if (file && request.method === "PUT") return sendFile(request, env, name, file[1])
      if (path === "/api/notes" && request.method === "GET") return myNotes(env, name)
      const share = path.match(/^\/api\/notes\/([\w-]+)\/share$/)
      if (share && request.method === "POST") return shareNote(env, name, share[1])
      if (path === "/api/page-notes" && request.method === "GET") return pageNotes(request, env, name, url.searchParams.get("slug"))
      if (path === "/api/reads" && request.method === "GET") return myReads(env, name)
      if (path === "/api/read" && request.method === "POST") return markRead(request, env, name)
      return json(404, { error: "Not here." })
    }
    if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "Only reading is possible here." })
    const name = await viewer(request, env)
    return page(request, env, name ? accounts(env)[name].dir : "public")
  },
}
