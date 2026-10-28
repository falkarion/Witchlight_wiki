// The Witchlight wiki's own sidebar tree, player login, reading marks and notes.
//
// publish.py builds the wiki once per audience (the public, each player); the server
// (worker/index.js) serves a logged-in player their own build. Each build has its own
// static/for-player.json: {viewer, pages, blocks}: the tree of that build's pages, and per page
// its paragraphs (fingerprints) with when each first appeared. This script:
//  - renders the tree (mirrors the vault: an overview note and its folder are one entry
//    that opens the overview and folds out);
//  - adds the "Player key" field (log in once per device) or, when logged in, the player's
//    name and "Log out";
//  - marks what the player hasn't read yet. A paragraph counts as read only once it has been
//    on their screen for a moment; a page is read when all its paragraphs are. Unread pages get
//    a dot in the tree; a page gets a label by its title ("Not read yet", "2 changes", "Not
//    fully read yet"), and paragraphs that are new since the player first read the page glow;
//  - shows notes in the page, at the text they quote: the player's own (private or shared) and
//    the other players' shared notes the server lets this player see, each with its status and
//    the DM's answer; notes without a quote, or whose text has since changed, sit at the top;
//  - gives a logged-in player the "Note to the DM" panel, "Answer" buttons under every
//    "Questions …" section, and an overview of their notes that stays short.
// Paragraphs are found exactly as publish.py's PageBlocks does (keep the two in step): BLOCK
// elements in the page's <article>, each with its own text, whitespace collapsed, fingerprinted
// with FNV-1a; everything this script adds to a page carries data-wl-ui and is left out.
(() => {
  const FOLD_KEY = "for-player:open"
  const SEEN_KEY = "for-player:seen-answers"
  const MAX_FILE = 15 * 1024 * 1024
  const READ_AFTER_MS = 1000
  const KINDS = [
    ["correction", "A correction"],
    ["answer", "An answer"],
    ["question", "A question"],
    ["upload", "A picture or sound"],
    ["other", "Something else"],
  ]
  const STATUS = { new: "sent", seen: "read by the DM", answered: "answered", folded: "folded in", done: "closed" }
  const OPEN = new Set(["new", "seen", "answered"])
  const BLOCK = new Set(["p", "li", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "tr", "dt", "dd", "figcaption", "blockquote"])
  const SKIP = new Set(["script", "style", "svg", "button"])
  const NEVER = "2000-01-01T00:00:00+00:00"
  const state = (window.__witchlight = window.__witchlight || { registry: null })
  const draft = (state.draft = state.draft || { kind: "correction", quote: "", text: "", shared: false, open: false, tab: "write" })
  let lastSelection = ""
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
  const read = (store, k, d) => {
    try {
      return JSON.parse(store.getItem(k)) ?? d
    } catch {
      return d
    }
  }
  const write = (store, k, v) => {
    try {
      store.setItem(k, JSON.stringify(v))
    } catch {}
  }
  const mobile = () => window.matchMedia("(max-width: 800px)").matches
  const currentSlug = () => document.body.dataset.slug || "index"
  const day = (iso) => (iso || "").slice(0, 10)

  async function registry() {
    if (state.registry) return state.registry
    try {
      const r = await fetch("/static/for-player.json", { cache: "no-cache" })
      state.registry = await r.json()
    } catch {
      state.registry = { viewer: null, pages: [], blocks: {} }
    }
    // who is logged in comes from the server, not the build: the preview's test login
    // reads its own test build, which has no viewer of its own
    try {
      state.registry.viewer = (await api("/api/me")).name
    } catch {}
    return state.registry
  }

  async function api(path, body, method = body === undefined ? "GET" : "POST") {
    const r = await fetch(path, {
      method,
      headers: body instanceof Blob ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : body instanceof Blob ? body : JSON.stringify(body),
    })
    const answer = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(answer.error || "The wiki didn't answer.")
    return answer
  }

  // --- paragraphs (as publish.py's PageBlocks) ------------------------------------------
  function blockId(text) {
    let h = 0x811c9dc5
    for (const b of new TextEncoder().encode(text)) h = Math.imul(h ^ b, 0x01000193) >>> 0
    return h.toString(16).padStart(8, "0")
  }

  // [{el, id}] for the article's paragraphs, in page order
  function pageBlocks(article) {
    const texts = new Map()
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      let block = null
      let skip = false
      for (let el = node.parentElement; el && el !== article; el = el.parentElement) {
        const tag = el.tagName.toLowerCase()
        if (SKIP.has(tag) || el.hasAttribute("data-wl-ui")) {
          skip = true
          break
        }
        if (!block && BLOCK.has(tag)) block = el
      }
      if (!skip && block) texts.set(block, (texts.get(block) || "") + node.data)
    }
    const out = []
    for (const [el, t] of texts) {
      const text = t.replace(/\s+/g, " ").trim()
      if (text.length >= 3) out.push({ el, id: blockId(text) })
    }
    return out
  }
  state.pageBlocks = pageBlocks // for testing: the same fingerprints as the registry

  // --- what the player hasn't read yet ---------------------------------------------------
  async function loadReads() {
    try {
      const reads = (await api("/api/reads")).reads
      state.reads = Object.fromEntries(Object.entries(reads).map(([s, r]) => [s, { first: r.first, set: new Set(r.blocks) }]))
    } catch {
      state.reads = state.reads || {}
    }
  }

  function pageUnread(slug) {
    const reg = state.registry
    if (!reg || !reg.viewer || !state.reads) return false
    const r = state.reads[slug]
    if (!r) return true // never opened
    return Object.keys((reg.blocks || {})[slug] || {}).some((id) => !r.set.has(id))
  }

  function containsUnread(n) {
    if (n.slug && pageUnread(n.slug)) return true
    for (const c of n.children.values()) if (containsUnread(c)) return true
    return false
  }

  // One visit to a page: decides the label and the glow once, then counts paragraphs as read
  // while they are on screen, and reports them in small batches.
  function startVisit(reg, slug) {
    const article = document.querySelector("article")
    if (state.visit?.slug === slug && state.visit.article === article) return state.visit
    endVisit()
    if (!article) return null
    const since = (reg.blocks || {})[slug] || {}
    const r = state.reads[slug]
    const blocks = pageBlocks(article)
    const unread = blocks.filter((b) => !r || !r.set.has(b.id))
    const changes = r ? unread.filter((b) => new Date(since[b.id] || NEVER) > new Date(r.first)) : []
    const visit = (state.visit = { slug, article, pending: new Set(), changes, unread: new Set(unread.map((b) => b.id)) })
    visit.fresh = !r
    visit.steps = changes.map((b) => b.el) // in page order; stepping keeps working after they're read
    visit.step = -1
    visit.label = labelFor(visit)
    for (const b of changes) b.el.classList.add("wl-changed")
    api("/api/read", { slug, blocks: [] }).catch(() => {}) // records the first opening
    if (!state.reads[slug]) state.reads[slug] = { first: new Date().toISOString(), set: new Set() }
    // A paragraph is read once it has been on screen for READ_AFTER_MS while the page is visible:
    // twice a second, where is each unread paragraph? (most of it on screen, or filling half the
    // window when it's taller; hidden ones, such as in a folded callout, don't count)
    visit.watch = unread.map((b) => ({ ...b, since: 0 }))
    visit.ticker = setInterval(() => {
      if (document.visibilityState !== "visible") return visit.watch.forEach((b) => (b.since = 0))
      const now = Date.now()
      const h = window.innerHeight
      for (const b of visit.watch) {
        const r = b.el.getBoundingClientRect()
        const shown = Math.max(0, Math.min(r.bottom, h) - Math.max(r.top, 0))
        const onScreen = r.height > 0 && (shown >= r.height * 0.6 || shown >= h * 0.5) && (!b.el.checkVisibility || b.el.checkVisibility())
        if (!onScreen) b.since = 0
        else if (!b.since) b.since = now
        else if (now - b.since >= READ_AFTER_MS) b.read = true
      }
      for (const b of visit.watch.filter((x) => x.read)) {
        visit.pending.add(b.id)
        visit.unread.delete(b.id)
        state.reads[slug].set.add(b.id)
      }
      const justRead = visit.watch.some((x) => x.read)
      visit.watch = visit.watch.filter((x) => !x.read)
      if (!visit.unread.size && justReadAll(visit)) updateUnreadCount()
      if (justRead) {
        // the label follows the reading: changes count down, and it goes once everything is read
        visit.fresh = false
        visit.changes = visit.changes.filter((b) => visit.unread.has(b.id))
        const label = labelFor(visit)
        if (label !== visit.label) {
          visit.label = label
          showLabel(visit)
        }
      }
    }, 500)
    visit.flusher = setInterval(() => flush(visit), 2000)
    return visit
  }

  // once per visit, when the page's last paragraph is read: its dot goes and the count drops
  function justReadAll(visit) {
    if (visit.allRead) return false
    visit.allRead = true
    document.querySelectorAll(".wl-link.active + .wl-new").forEach((d) => d.remove())
    return true
  }

  function updateUnreadCount() {
    const n = unreadPages().length
    if (!n) return document.querySelectorAll(".wl-unread-bar, .wl-unread-sum").forEach((el) => el.remove())
    document.querySelectorAll(".wl-unread-n").forEach((el) => (el.textContent = n))
    document.querySelectorAll(".wl-unread-sum").forEach((el) => (el.textContent = `· ${n} unread`))
  }

  function labelFor(visit) {
    const n = visit.changes.length
    if (!visit.unread.size) return ""
    if (visit.fresh) return "Not read yet"
    return n ? `${n} change${n > 1 ? "s" : ""}` : "Not fully read yet"
  }

  function flush(visit, leaving) {
    if (!visit || !visit.pending.size) return
    const blocks = [...visit.pending]
    visit.pending.clear()
    fetch("/api/read", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: visit.slug, blocks }),
      keepalive: !!leaving,
    }).catch(() => blocks.forEach((b) => visit.pending.add(b)))
  }

  function endVisit() {
    const v = state.visit
    if (!v) return
    clearInterval(v.ticker)
    clearInterval(v.flusher)
    flush(v, true)
    state.visit = null
  }
  window.addEventListener("pagehide", endVisit)
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush(state.visit, true))

  // Show one paragraph: unfold its passage if it's folded, bring it to the middle, glow it briefly
  function goTo(el) {
    el.closest(".callout.is-collapsed")?.querySelector(".callout-title")?.click()
    el.scrollIntoView({ behavior: "smooth", block: "center" })
    el.classList.remove("wl-target")
    void el.offsetWidth // restart the glow
    el.classList.add("wl-target")
  }

  // Links into a page: …#changes opens it at the reader's first change (the announce on Discord
  // links there), …#p-<fingerprint> at that paragraph.
  function jumpToHash(visit) {
    const hash = location.hash
    let el = null
    if (hash === "#changes" && visit?.steps.length) {
      visit.step = 0
      el = visit.steps[0]
    } else if (/^#p-[0-9a-f]{8}$/.test(hash)) {
      const article = document.querySelector("article")
      el = article && pageBlocks(article).find((b) => b.id === hash.slice(3))?.el
    }
    if (el) setTimeout(() => goTo(el), 300)
  }

  function showLabel(visit) {
    document.querySelectorAll(".wl-label, .wl-mark-read, .wl-steps").forEach((el) => el.remove())
    document.body.classList.remove("wl-reading")
    stickHead()
    if (!visit || !visit.label) return
    // The label leads somewhere: with changes, to them (‹ › step through them in page order, round
    // again); when only some paragraphs aren't read yet, to those (from where the reader is now).
    const onChanges = visit.changes.length > 0
    const unreadEls = () => visit.watch.map((b) => b.el).filter((el) => el.isConnected)
    const nextUnread = (d) => {
      const els = unreadEls()
      if (!els.length) return null
      const mid = window.innerHeight / 2
      const tops = els.map((el) => {
        const box = (el.closest(".callout.is-collapsed") || el).getBoundingClientRect()
        return box.top + box.height / 2 - mid
      })
      const i = d > 0 ? tops.findIndex((t) => t > 20) : tops.findLastIndex((t) => t < -20)
      return els[i >= 0 ? i : d > 0 ? 0 : els.length - 1]
    }
    const stepChange = (d) => {
      const n = visit.steps.length
      visit.step = visit.step < 0 ? (d > 0 ? 0 : n - 1) : (visit.step + d + n) % n
      goTo(visit.steps[visit.step])
    }
    const go = (d) => {
      if (onChanges) return stepChange(d)
      const el = nextUnread(d)
      if (el) goTo(el)
    }
    const canStep = onChanges ? visit.steps.length > 0 : !visit.fresh && unreadEls().length > 0
    const label = document.createElement(canStep ? "button" : "span")
    label.className = "wl-label"
    label.setAttribute("data-wl-ui", "")
    label.textContent = "✦ " + visit.label
    if (canStep) {
      label.type = "button"
      label.title = onChanges ? "Go to the next change" : "Go to the next part you haven't read yet"
      label.addEventListener("click", () => go(1))
    }
    const extra = []
    if (onChanges ? visit.steps.length > 1 : canStep) {
      const what = onChanges ? "change" : "unread part"
      const steps = document.createElement("span")
      steps.className = "wl-steps"
      steps.setAttribute("data-wl-ui", "")
      steps.innerHTML = `<button type="button" title="Previous ${what}" aria-label="Previous ${what}">‹</button><button type="button" title="Next ${what}" aria-label="Next ${what}">›</button>`
      const [prev, next] = steps.querySelectorAll("button")
      prev.addEventListener("click", () => go(-1))
      next.addEventListener("click", () => go(1))
      extra.push(steps)
    }
    const mark = document.createElement("button")
    mark.type = "button"
    mark.className = "wl-mark-read"
    mark.setAttribute("data-wl-ui", "")
    mark.textContent = "✓ Mark as read"
    mark.title = "Count this whole page as read (its dot and highlights go)"
    mark.addEventListener("click", async () => {
      mark.disabled = true
      await markPagesRead([visit.slug])
    })
    const title = document.querySelector("h1.article-title")
    if (title) title.after(label, ...extra, mark)
    else visit.article.prepend(label, ...extra, mark)

    document.body.classList.add("wl-reading")
    stickHead()
  }

  // While a page has a reading label, its header (title, label, arrows) stays at the top of the
  // screen, so stepping never scrolls the controls away; once stuck, the breadcrumbs and the date
  // fold away to keep it small.
  function stickHead() {
    const head = document.querySelector(".page-header")
    if (head) head.classList.toggle("wl-stuck", document.body.classList.contains("wl-reading") && head.getBoundingClientRect().top <= 1 && window.scrollY > 0)
  }
  window.addEventListener("scroll", stickHead, { passive: true })

  // A player can count pages as read without scrolling through them: this page (by its label),
  // or every page at once (in "Your notes"). Every paragraph the page has counts, folded ones too.
  async function markPagesRead(slugs) {
    const reg = state.registry
    for (const slug of slugs) {
      const ids = Object.keys((reg.blocks || {})[slug] || {})
      await api("/api/read", { slug, blocks: ids }).catch(() => {})
      if (!state.reads[slug]) state.reads[slug] = { first: new Date().toISOString(), set: new Set() }
      ids.forEach((id) => state.reads[slug].set.add(id))
      const v = state.visit
      if (v?.slug === slug) {
        v.unread.clear()
        v.watch = []
        v.changes = []
        v.label = ""
        v.article.querySelectorAll(".wl-changed").forEach((el) => el.classList.remove("wl-changed"))
        showLabel(v)
      }
    }
    renderSidebar(reg) // the dots
  }

  // --- the tree -------------------------------------------------------------------------
  function buildTree(entries) {
    const root = { name: "", key: "", children: new Map() }
    const node = (path) => {
      let n = root
      for (const seg of path) {
        if (!n.children.has(seg)) n.children.set(seg, { name: seg, key: n.key + "/" + seg, children: new Map() })
        n = n.children.get(seg)
      }
      return n
    }
    for (const e of entries) {
      const n = node([...e.path, e.title]) // an overview and its folder share one node
      n.slug = e.slug
      n.sort = e.sort
    }
    return root
  }

  function sortKey(n) {
    return [n.children.size ? 0 : 1, typeof n.sort === "number" ? n.sort : 1e6, String(n.sort ?? n.name).toLowerCase()]
  }

  function cmp(a, b) {
    const x = sortKey(a)
    const y = sortKey(b)
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
    return 0
  }

  function containsSlug(n, slug) {
    if (n.slug === slug) return true
    for (const c of n.children.values()) if (containsSlug(c, slug)) return true
    return false
  }

  function renderNodes(n, current, open) {
    const kids = [...n.children.values()].sort(cmp)
    return `<ul>${kids
      .map((c) => {
        const active = c.slug && c.slug === current ? " active" : ""
        const dot = (c.slug && pageUnread(c.slug)) || (c.children.size && containsUnread(c))
          ? '<span class="wl-new" title="Not read yet">●</span>'
          : ""
        const label = (c.slug
          ? `<a class="wl-link${active}" href="/${c.slug === "index" ? "" : c.slug}">${esc(c.name)}</a>`
          : `<span class="wl-folder">${esc(c.name)}</span>`) + dot
        if (!c.children.size) return `<li class="wl-leaf">${label}</li>`
        const isOpen = open.has(c.key) || containsSlug(c, current)
        return `<li class="wl-branch${isOpen ? " open" : ""}" data-key="${esc(c.key)}">
          <div class="wl-row"><button type="button" class="wl-fold" aria-label="Fold" aria-expanded="${isOpen}">
          <svg viewBox="0 0 24 24" width="12" height="12"><polyline points="9 6 15 12 9 18" fill="none" stroke="currentColor" stroke-width="2.5"/></svg></button>${label}</div>
          ${renderNodes(c, current, open)}</li>`
      })
      .join("")}</ul>`
  }

  function loginHtml(viewer) {
    if (viewer) {
      return `<div class="fp-label">Logged in</div><div class="fp-who">${esc(viewer)}</div>
        <button type="button" class="fp-lock">Log out</button>`
    }
    return `<form class="fp-form"><label class="fp-label" for="fp-input">Player key</label>
      <div class="fp-row"><input id="fp-input" type="password" autocomplete="current-password" placeholder="Your passphrase">
      <button type="submit">Unlock</button></div><div class="fp-error" hidden></div></form>`
  }

  function wireLogin(box) {
    box.querySelector(".fp-lock")?.addEventListener("click", async () => {
      endVisit()
      await api("/api/logout", {}).catch(() => {})
      location.href = "/"
    })
    box.querySelector("form")?.addEventListener("submit", async (e) => {
      e.preventDefault()
      const input = box.querySelector("input")
      const passphrase = input.value.trim()
      if (!passphrase) return
      const button = box.querySelector("button")
      button.disabled = true
      try {
        await api("/api/login", { passphrase })
        location.reload() // the server now serves this player's own build
      } catch (err) {
        const msg = box.querySelector(".fp-error")
        msg.textContent = err.message
        msg.hidden = false
        button.disabled = false
        input.select()
      }
    })
  }

  function renderSidebar(reg) {
    document.querySelectorAll(".wl-nav, .wl-404-login").forEach((el) => el.remove())
    const tree = buildTree(reg.pages || [])
    const current = document.body.dataset.slug
    const open = new Set(read(sessionStorage, FOLD_KEY, []))
    const nav = document.createElement(mobile() ? "details" : "nav")
    nav.className = "wl-nav"
    const unread = reg.viewer ? unreadPages().length : 0
    nav.innerHTML = `${mobile() ? `<summary>Contents${unread ? ` <span class="wl-unread-sum">· ${unread} unread</span>` : ""}</summary>` : '<div class="wl-title">Contents</div>'}
      ${unread ? `<div class="wl-unread-bar"><span>✦ <span class="wl-unread-n">${unread}</span> ${unread > 1 ? "pages" : "page"} not fully read</span>
        <button type="button">Mark all as read</button></div>` : ""}
      <div class="wl-tree">${renderNodes(tree, current, open)}</div><div class="for-player-unlock">${loginHtml(reg.viewer)}</div>`
    nav.querySelectorAll(".wl-branch").forEach((li) => {
      const toggle = () => {
        const isOpen = li.classList.toggle("open")
        li.querySelector(".wl-fold").setAttribute("aria-expanded", isOpen)
        const keys = new Set(read(sessionStorage, FOLD_KEY, []))
        isOpen ? keys.add(li.dataset.key) : keys.delete(li.dataset.key)
        write(sessionStorage, FOLD_KEY, [...keys])
      }
      li.querySelector(".wl-fold").addEventListener("click", toggle)
      li.querySelector(".wl-row .wl-folder")?.addEventListener("click", toggle)
    })
    nav.querySelector(".wl-unread-bar button")?.addEventListener("click", async (e) => {
      const pages = unreadPages()
      if (!confirm(`Mark all ${pages.length} pages as read? Their dots and highlights go; only later changes show again.`)) return
      e.target.disabled = true
      e.target.textContent = "Marking…"
      await markPagesRead(pages)
    })
    wireLogin(nav.querySelector(".for-player-unlock"))
    const sidebar = document.querySelector(".left.sidebar")
    if (!sidebar) {
      // the "not found" page has no sidebar: a logged-out player who followed a link to one of
      // their own pages can log in right here, and the reload then shows the page
      if (!reg.viewer) {
        const box = nav.querySelector(".for-player-unlock")
        box.classList.add("wl-404-login")
        box.insertAdjacentHTML("afterbegin", "<p>Is this one of your own pages? Log in with your player key.</p>")
        document.querySelector("article")?.appendChild(box)
      }
    } else if (mobile()) {
      document.querySelector(".center")?.prepend(nav)
    } else {
      sidebar.appendChild(nav)
    }
  }

  // --- notes in the page ----------------------------------------------------------------
  // A note's quote is found in the article's text ignoring whitespace and case (as the server
  // checks it), and marked where it stands; a 💬 after it opens the notes about it.
  function textNodes(article) {
    const out = []
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement.closest("[data-wl-ui], script, style, svg, button") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    })
    for (let n = walker.nextNode(); n; n = walker.nextNode()) out.push(n)
    return out
  }

  function findQuote(article, quote) {
    const want = quote.toLowerCase().replace(/\s+/g, "")
    if (!want) return null
    let flat = ""
    const where = []
    for (const node of textNodes(article)) {
      for (let i = 0; i < node.data.length; i++) {
        if (/\s/.test(node.data[i])) continue
        flat += node.data[i].toLowerCase()
        where.push([node, i])
      }
    }
    const at = flat.indexOf(want)
    if (at < 0) return null
    return { start: where[at], end: where[at + want.length - 1] }
  }

  function markQuote(found, ids) {
    const [startNode, startOff] = found.start
    const [endNode, endOff] = found.end
    const nodes = textNodes(state.visit?.article || document.querySelector("article"))
    const from = nodes.indexOf(startNode)
    const to = nodes.indexOf(endNode)
    let last = null
    for (let i = from; i <= to; i++) {
      const node = nodes[i]
      const a = i === from ? startOff : 0
      const b = i === to ? endOff + 1 : node.data.length
      if (a >= b || !node.data.slice(a, b).trim()) continue
      const range = document.createRange()
      range.setStart(node, a)
      range.setEnd(node, b)
      const mark = document.createElement("mark")
      mark.className = "wl-quote"
      mark.dataset.notes = ids.join(" ")
      range.surroundContents(mark)
      last = mark
    }
    return last
  }

  // where a note's cards go: after the paragraph the quote ends in (inside a list item, after a table)
  function cardSpot(mark) {
    let el = mark.parentElement
    while (el && !BLOCK.has(el.tagName.toLowerCase()) && el.tagName !== "ARTICLE") el = el.parentElement
    if (!el || el.tagName === "ARTICLE") return { after: mark }
    if (el.tagName === "TR") return { after: el.closest(".table-container") || el.closest("table") }
    if (el.tagName === "LI") return { inside: el }
    return { after: el }
  }

  function noteCard(n, withQuote) {
    const who = n.mine ? "You" : esc(n.player)
    const status = `<span class="wl-chip wl-chip-${esc(n.status)}">${esc(STATUS[n.status] || n.status)}</span>`
    const shared = n.shared ? '<span class="wl-chip">shared</span>' : n.mine ? '<span class="wl-chip">only the DM</span>' : ""
    return `<div class="wl-note-card" id="wl-note-${esc(n.id)}" data-id="${esc(n.id)}">
      <div class="wl-note-meta">${who} · ${esc(day(n.created))} ${status} ${shared}</div>
      ${withQuote && n.quote ? `<blockquote class="wl-inbox-quote">${esc(n.quote)}</blockquote>` : ""}
      <div class="wl-note-text">${esc(n.text || "")}${n.file_name ? ` <span class="wl-note-file">📎 ${esc(n.file_name)}</span>` : ""}</div>
      ${n.reply ? `<div class="wl-note-reply"><span>The DM:</span> ${esc(n.reply)}</div>` : ""}
      ${n.mine && !n.shared ? '<button type="button" class="wl-share">Share with the other players</button>' : ""}
    </div>`
  }

  function wireCards(root) {
    root.querySelectorAll(".wl-share").forEach((b) =>
      b.addEventListener("click", async () => {
        const id = b.closest(".wl-note-card").dataset.id
        const ok = confirm("Share this note with the other players? They'll see it, and the DM's answer, wherever they can see the same text. This can't be undone.")
        if (!ok) return
        b.disabled = true
        try {
          await api(`/api/notes/${id}/share`, {})
          state.notes = null
          await showPageNotes(currentSlug(), true)
        } catch (err) {
          b.disabled = false
          alert(err.message)
        }
      }),
    )
  }

  async function showPageNotes(slug, reload) {
    const article = document.querySelector("article")
    if (!article) return
    if (reload || state.pageNotes?.slug !== slug) {
      try {
        state.pageNotes = { slug, notes: (await api(`/api/page-notes?slug=${encodeURIComponent(slug)}`)).notes }
      } catch {
        state.pageNotes = { slug, notes: [] }
      }
    }
    document.querySelectorAll(".wl-note-pin, .wl-note-cards, .wl-page-notes").forEach((el) => el.remove())
    article.querySelectorAll("mark.wl-quote").forEach((m) => m.replaceWith(...m.childNodes))
    article.normalize()
    const loose = []
    const byQuote = new Map()
    for (const n of state.pageNotes.notes) {
      if (!n.quote) loose.push({ n, changed: false })
      else (byQuote.get(n.quote) || byQuote.set(n.quote, []).get(n.quote)).push(n)
    }
    for (const [quote, notes] of byQuote) {
      const found = findQuote(article, quote)
      const mark = found && markQuote(found, notes.map((n) => n.id))
      if (!mark) {
        notes.forEach((n) => loose.push({ n, changed: true }))
        continue
      }
      const pin = document.createElement("button")
      pin.type = "button"
      pin.className = "wl-note-pin"
      pin.setAttribute("data-wl-ui", "")
      pin.title = notes.length > 1 ? `${notes.length} notes about this` : "A note about this"
      pin.textContent = notes.length > 1 ? `💬${notes.length}` : "💬"
      const cards = document.createElement("div")
      cards.className = "wl-note-cards"
      cards.setAttribute("data-wl-ui", "")
      cards.hidden = true
      cards.innerHTML = notes.map((n) => noteCard(n, false)).join("")
      mark.after(pin)
      const spot = cardSpot(mark)
      if (spot.inside) spot.inside.appendChild(cards)
      else spot.after.after(cards)
      pin.addEventListener("click", () => (cards.hidden = !cards.hidden))
      wireCards(cards)
    }
    if (loose.length) {
      const box = document.createElement("details")
      box.className = "wl-page-notes"
      box.setAttribute("data-wl-ui", "")
      box.innerHTML = `<summary>💬 ${loose.length} note${loose.length > 1 ? "s" : ""} on this page</summary>` +
        loose.map(({ n, changed }) => (changed ? '<div class="wl-note-gone">About text that has since changed:</div>' : "") + noteCard(n, true)).join("")
      const above = document.querySelector(".wl-label") || document.querySelector("h1.article-title")
      if (above) above.after(box)
      else article.prepend(box)
      wireCards(box)
    }
    // a link to a note (from the overview) opens it
    const target = location.hash.startsWith("#wl-note-") && document.getElementById(location.hash.slice(1))
    if (target) {
      target.closest(".wl-note-cards")?.removeAttribute("hidden")
      const details = target.closest("details")
      if (details) details.open = true
      target.scrollIntoView({ block: "center" })
      target.classList.add("wl-note-target")
    }
  }

  // --- the panel: writing, and the overview of one's own notes ----------------------------
  document.addEventListener("selectionchange", () => {
    const sel = window.getSelection()
    const text = sel ? sel.toString().trim() : ""
    if (text && sel.anchorNode && sel.anchorNode.parentElement?.closest("article")) lastSelection = text.slice(0, 600)
  })

  function openInbox(kind, quote) {
    draft.open = true
    draft.tab = "write"
    if (kind) draft.kind = kind
    if (quote !== undefined) draft.quote = quote
    renderInbox(state.registry)
    document.querySelector(".wl-inbox textarea")?.focus()
  }

  const unseenAnswers = (notes) => {
    const seen = new Set(read(localStorage, SEEN_KEY, []))
    return notes.filter((n) => n.reply && !seen.has(n.id))
  }

  // The overview stays short: new answers and this page's notes always; open notes elsewhere
  // (the newest few, more on request); finished ones (folded in, closed) folded away.
  function overviewHtml(notes) {
    if (!notes) return `<div class="wl-inbox-hint">Loading…</div>`
    if (!notes.length) return `<div class="wl-inbox-hint">No notes yet. Select text on a page and write to the DM about it.</div>`
    const slug = currentSlug()
    // answers new when the overview opened stay under "New answers" until the panel closes
    const fresh = state.freshNow || new Set(unseenAnswers(notes).map((n) => n.id))
    const item = (n) => `<li><a class="wl-note-link" href="/${n.page_slug === "index" ? "" : esc(n.page_slug)}#wl-note-${esc(n.id)}">${esc(n.page_title || "A page")}</a>
      <span class="wl-chip wl-chip-${esc(n.status)}">${esc(STATUS[n.status] || n.status)}</span>${n.shared ? ' <span class="wl-chip">shared</span>' : ""}
      <div class="wl-note-text wl-clamp">${esc(n.text || n.file_name || "")}</div>
      ${n.reply ? `<div class="wl-note-reply wl-clamp"><span>The DM:</span> ${esc(n.reply)}</div>` : ""}</li>`
    const list = (items, limit) => {
      const shown = items.slice(0, limit).map(item).join("")
      const more = items.length > limit ? `<li><button type="button" class="wl-more" data-limit="${limit}">Show ${items.length - limit} more</button></li>` : ""
      return `<ol class="wl-notes">${shown}${more}</ol>`
    }
    const answered = notes.filter((n) => fresh.has(n.id))
    const here = notes.filter((n) => n.page_slug === slug && !fresh.has(n.id))
    const open = notes.filter((n) => OPEN.has(n.status) && n.page_slug !== slug && !fresh.has(n.id))
    const finished = notes.filter((n) => !OPEN.has(n.status) && n.page_slug !== slug && !fresh.has(n.id))
    let html = ""
    if (answered.length) html += `<h4>New answers</h4>${list(answered, 50)}`
    if (here.length) html += `<h4>On this page</h4>${list(here, 50)}`
    if (open.length) html += `<h4>Open</h4>${list(open, draft.openLimit || 5)}`
    if (finished.length) html += `<details class="wl-finished"><summary>Finished (${finished.length})</summary>${list(finished, draft.doneLimit || 10)}</details>`
    return html || `<div class="wl-inbox-hint">No open notes.</div>`
  }

  function unreadPages() {
    const reg = state.registry
    return Object.keys((reg && reg.blocks) || {}).filter((slug) => pageUnread(slug))
  }

  async function loadNotes() {
    try {
      state.notes = (await api("/api/notes")).notes
    } catch {
      state.notes = state.notes || []
    }
    return state.notes
  }

  function renderInbox(reg) {
    document.querySelectorAll(".wl-inbox, .wl-inbox-open").forEach((el) => el.remove())
    if (!reg || !reg.viewer) return
    const fresh = state.notes ? unseenAnswers(state.notes).length : 0
    if (!draft.open) {
      const btn = document.createElement("button")
      btn.type = "button"
      btn.className = "wl-inbox-open"
      btn.innerHTML = `✎ Note to the DM${fresh ? ` <span class="wl-inbox-badge" title="New answers from the DM">${fresh}</span>` : ""}`
      btn.title = "Send the DM a correction, an answer, a question or a picture. Select text on the page first to quote it."
      btn.addEventListener("mousedown", (e) => e.preventDefault()) // keep the selection
      btn.addEventListener("click", () => openInbox(undefined, lastSelection || draft.quote))
      document.body.appendChild(btn)
      return
    }
    const box = document.createElement("div")
    box.className = "wl-inbox"
    const tabs = `<div class="wl-inbox-tabs"><button type="button" data-tab="write" class="${draft.tab === "write" ? "on" : ""}">Write</button>
      <button type="button" data-tab="notes" class="${draft.tab === "notes" ? "on" : ""}">Your notes${fresh ? ` <span class="wl-inbox-badge">${fresh}</span>` : ""}</button></div>`
    const head = `<div class="wl-inbox-head"><span>Note to the DM</span><button type="button" class="wl-inbox-close" aria-label="Close">✕</button></div>${tabs}`
    if (draft.tab === "notes") {
      if (state.notes && !state.freshNow) state.freshNow = new Set(unseenAnswers(state.notes).map((n) => n.id))
      box.innerHTML = head + overviewHtml(state.notes)
      if (state.notes) {
        const seen = new Set(read(localStorage, SEEN_KEY, []))
        state.notes.filter((n) => n.reply).forEach((n) => seen.add(n.id))
        write(localStorage, SEEN_KEY, [...seen])
      }
      box.querySelectorAll(".wl-more").forEach((b) =>
        b.addEventListener("click", () => {
          const inFinished = !!b.closest(".wl-finished")
          draft[inFinished ? "doneLimit" : "openLimit"] = Number(b.dataset.limit) + (inFinished ? 20 : 10)
          renderInbox(reg)
          if (inFinished) document.querySelector(".wl-finished")?.setAttribute("open", "")
        }),
      )
    } else {
      box.innerHTML = `${head}
      <label>What is it? <select class="wl-inbox-kind">${KINDS.map(([k, l]) => `<option value="${k}"${k === draft.kind ? " selected" : ""}>${l}</option>`).join("")}</select></label>
      ${draft.quote ? `<blockquote class="wl-inbox-quote">${esc(draft.quote)}<button type="button" class="wl-inbox-unquote" aria-label="Remove the quote">✕</button></blockquote>` : `<div class="wl-inbox-hint">Tip: select text on the page first to quote it.</div>`}
      <textarea rows="5" placeholder="Your message">${esc(draft.text)}</textarea>
      <label class="wl-inbox-file">Add a picture or sound (15 MB at most) <input type="file" accept="image/*,audio/*,.pdf"></label>
      <fieldset class="wl-inbox-who"><legend>Who can see it?</legend>
        <label><input type="radio" name="wl-who" value="dm"${draft.shared ? "" : " checked"}> Only the DM</label>
        <label><input type="radio" name="wl-who" value="all"${draft.shared ? " checked" : ""}> The DM and the other players, where they can see this text</label></fieldset>
      <div class="wl-inbox-row"><span class="wl-inbox-status">${esc(draft.status || "")}</span><button type="button" class="wl-inbox-send">Send</button></div>`
    }
    draft.status = ""
    box.querySelector(".wl-inbox-close").addEventListener("click", () => {
      draft.open = false
      state.freshNow = null
      renderInbox(reg)
    })
    box.querySelectorAll(".wl-inbox-tabs button").forEach((b) =>
      b.addEventListener("click", async () => {
        draft.tab = b.dataset.tab
        renderInbox(reg)
        if (draft.tab === "notes") {
          await loadNotes()
          if (draft.open && draft.tab === "notes") renderInbox(reg)
        }
      }),
    )
    box.querySelector(".wl-inbox-unquote")?.addEventListener("click", () => {
      draft.quote = ""
      lastSelection = ""
      renderInbox(reg)
    })
    box.querySelector(".wl-inbox-kind")?.addEventListener("change", (e) => (draft.kind = e.target.value))
    box.querySelector("textarea")?.addEventListener("input", (e) => (draft.text = e.target.value))
    box.querySelectorAll("input[name=wl-who]").forEach((r) => r.addEventListener("change", () => (draft.shared = r.value === "all" && r.checked)))
    box.querySelector(".wl-inbox-send")?.addEventListener("click", async (e) => {
      const button = e.target
      const status = box.querySelector(".wl-inbox-status")
      const file = box.querySelector("input[type=file]").files[0]
      const text = draft.text.trim()
      if (!text && !file) return (status.textContent = "Write something or add a file first.")
      if (file && file.size > MAX_FILE) return (status.textContent = "That file is too big (15 MB at most).")
      const h1 = document.querySelector("h1.article-title")
      button.disabled = true
      status.textContent = file ? "Sending (the file may take a moment)…" : "Sending…"
      try {
        const { id } = await api("/api/inbox", {
          kind: draft.kind,
          page: { slug: currentSlug(), title: (h1 && h1.textContent.trim()) || document.title },
          quote: draft.quote,
          text,
          shared: draft.shared,
          file: file ? { name: file.name, type: file.type, size: file.size } : null,
        })
        if (file) await api(`/api/inbox/${id}/file`, file, "PUT")
        Object.assign(draft, { quote: "", text: "", kind: "correction", shared: false, status: "Sent ✓ It's in the page now; the DM will see it." })
        lastSelection = ""
        state.notes = null
        renderInbox(reg)
        await showPageNotes(currentSlug(), true)
      } catch (err) {
        status.textContent = `Not sent: ${err.message || "no connection"} Your text is kept; try again.`
        button.disabled = false
      }
    })
    document.body.appendChild(box)
  }

  // An "Answer" button under every point of a section whose heading starts with "Questions"
  function answerButtons(reg) {
    if (!reg.viewer) return
    for (const h of document.querySelectorAll("article h2, article h3")) {
      if (!/^questions\b/i.test(h.textContent.trim()) || h.dataset.answers) continue
      h.dataset.answers = "1"
      for (let el = h.nextElementSibling; el && !/^H[1-3]$/.test(el.tagName); el = el.nextElementSibling) {
        for (const li of el.matches("ul, ol") ? el.querySelectorAll(":scope > li") : []) {
          const btn = document.createElement("button")
          btn.type = "button"
          btn.className = "wl-answer"
          btn.setAttribute("data-wl-ui", "")
          btn.textContent = "Answer"
          btn.addEventListener("click", () => {
            const own = textNodes(li).filter((n) => !n.parentElement.closest("ul ul, ol ol, ul ol, ol ul")).map((n) => n.data).join("")
            openInbox("answer", own.replace(/\s+/g, " ").trim().slice(0, 600))
          })
          li.appendChild(btn)
        }
      }
    }
  }

  // one run at a time: on a fresh load the page fires both "DOMContentLoaded" and "nav", and two
  // overlapping runs would decide the same page twice
  function run() {
    state.queue = (state.queue || Promise.resolve()).then(runOnce, runOnce)
    return state.queue
  }

  async function runOnce() {
    const reg = await registry()
    const slug = currentSlug()
    if (reg.viewer && !state.reads) await loadReads()
    let visit = null
    if (reg.viewer) visit = startVisit(reg, slug) // before anything is added to the page
    renderSidebar(reg)
    showLabel(visit)
    jumpToHash(visit)
    answerButtons(reg)
    renderInbox(reg)
    if (reg.viewer) {
      await showPageNotes(slug)
      if (!state.notes) {
        await loadNotes() // for the badge: new answers from the DM
        renderInbox(reg)
      }
    }
  }

  // The living sky (styles: custom.scss › Living sky): small clouds, seeds and stars, each drifting on
  // its own path and pace. They live outside <body>, which the wiki swaps on every page change.
  function sky() {
    if (document.querySelector(".wl-sky")) return
    const rnd = (a, b) => a + Math.random() * (b - a)
    const layer = (n, cls, count, make) => {
      const box = document.createElement("div")
      box.className = `wl-sky wl-sky-${n}`
      box.setAttribute("aria-hidden", "true")
      for (let k = 0; k < count; k++) {
        const it = make(k / count)
        const el = document.createElement("i")
        el.className = cls
        el.innerHTML = "<b></b>"
        el.style.cssText = `width:${it.w}px;height:${it.h}px;--x0:${it.x0};--y0:${it.y0};--x1:${it.x1};--y1:${it.y1};` +
          `--d:${it.d}s;--s:${it.s}s;--delay:-${(it.d * rnd(0, 1)).toFixed(1)}s`
        box.append(el)
      }
      document.documentElement.append(box)
    }
    // clouds cross from right to left at their own height and speed; the far ones smaller and slower
    const cloud = (min, max, dMin, dMax) => (f) => {
      const w = Math.round(180 * rnd(min, max))
      const y = `${(f * 60 + rnd(0, 10)).toFixed(1)}vh`
      return { w, h: w / 2, x0: "100vw", y0: y, x1: `-${w}px`, y1: y, d: rnd(dMin, dMax).toFixed(0), s: rnd(9, 16).toFixed(1) }
    }
    // seeds rise from below the page and drift up and to the right, each at its own angle
    const mote = (min, max, dMin, dMax, sMin, sMax) => (f) => {
      const k = rnd(min, max), x = f * 90 - 15 + rnd(0, 10)
      return { w: Math.round(24 * k), h: Math.round(32 * k), x0: `${x.toFixed(1)}vw`, y0: "105vh",
        x1: `${(x + rnd(25, 60)).toFixed(1)}vw`, y1: "-12vh", d: rnd(dMin, dMax).toFixed(0), s: rnd(sMin, sMax).toFixed(1) }
    }
    layer(1, "wl-cloud-far", 5, cloud(0.5, 0.85, 450, 700))
    layer(2, "wl-mote", 7, mote(0.5, 0.9, 220, 380, 7, 12))
    layer(3, "wl-cloud", 5, cloud(1.1, 1.8, 300, 460))
    layer(4, "wl-mote", 6, mote(1.1, 2.4, 140, 260, 5, 9))
  }

  document.addEventListener("nav", () => {
    lastSelection = ""
    run()
  })
  if (document.readyState !== "loading") (sky(), run())
  else document.addEventListener("DOMContentLoaded", () => (sky(), run()))
  let wasMobile = mobile()
  window.addEventListener("resize", () => {
    if (mobile() !== wasMobile) {
      wasMobile = mobile()
      run()
    }
  })
})()
