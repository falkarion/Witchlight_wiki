// The Witchlight wiki's own sidebar tree, player login and inbox.
//
// publish.py builds the wiki once per audience (the public, each player); the server
// (worker/index.js) serves a logged-in player their own build. Each build has its own
// static/for-player.json: {viewer, pages} with the tree of that build's pages. This script:
//  - renders the tree (mirrors the vault: an overview note and its folder are one entry
//    that opens the overview and folds out);
//  - adds the "Player key" field (log in once per device) or, when logged in, the player's
//    name and "Log out";
//  - gives a logged-in player the "Note to the DM" panel, "Answer" buttons under every
//    "Questions …" section, and their earlier notes with the DM's answers;
//  - marks pages the player hasn't read yet (a dot in the tree, a line on the page): pages
//    they never opened, and pages that changed since they last opened them (the registry's
//    `changed` times against the player's views, /api/seen).
(() => {
  const FOLD_KEY = "for-player:open"
  const SEEN_KEY = "for-player:seen-answers"
  const MAX_FILE = 15 * 1024 * 1024
  const KINDS = [
    ["correction", "A correction"],
    ["answer", "An answer"],
    ["question", "A question"],
    ["upload", "A picture or sound"],
    ["other", "Something else"],
  ]
  const STATUS = { new: "sent", seen: "read by the DM", answered: "answered", done: "done" }
  const state = (window.__witchlight = window.__witchlight || { registry: null })
  const draft = (state.draft = state.draft || { kind: "correction", quote: "", text: "", open: false, tab: "write" })
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

  async function registry() {
    if (state.registry) return state.registry
    try {
      const r = await fetch("/static/for-player.json", { cache: "no-cache" })
      state.registry = await r.json()
    } catch {
      state.registry = { viewer: null, pages: [] }
    }
    // who is logged in comes from the server, not the build: the preview's test login
    // reads the public build, which has no viewer of its own
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

  // --- what the player hasn't read yet ---------------------------------------------------
  function isNew(slug) {
    const reg = state.registry
    const seen = state.seen
    if (!reg || !reg.viewer || !seen || !reg.changed || !reg.changed[slug]) return false
    if (!seen[slug]) return true // never opened
    return new Date(reg.changed[slug]) > new Date(seen[slug])
  }

  function containsNew(n) {
    if (n.slug && isNew(n.slug)) return true
    for (const c of n.children.values()) if (containsNew(c)) return true
    return false
  }

  async function loadSeen() {
    try {
      state.seen = (await api("/api/seen")).seen
    } catch {
      state.seen = state.seen || {}
    }
  }

  // decided once per visit to a page: the script runs again for the same page (load, then nav)
  function markPage(slug) {
    document.querySelectorAll(".wl-updated").forEach((el) => el.remove())
    if (state.marked?.slug !== slug) {
      state.marked = { slug, mark: isNew(slug) ? (state.seen[slug] ? "updated" : "new") : null }
    }
    if (!state.marked.mark) return
    const note = document.createElement("div")
    note.className = "wl-updated"
    note.textContent = state.marked.mark === "updated" ? "✦ Updated since you last looked." : "✦ You haven't read this page yet."
    document.querySelector("article")?.prepend(note)
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
        const dot = (c.slug && isNew(c.slug)) || (c.children.size && containsNew(c))
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
    nav.innerHTML = `${mobile() ? "<summary>Contents</summary>" : '<div class="wl-title">Contents</div>'}
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

  // --- the inbox ------------------------------------------------------------------------
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

  function notesHtml(notes) {
    if (!notes) return `<div class="wl-inbox-hint">Loading…</div>`
    if (!notes.length) return `<div class="wl-inbox-hint">No notes yet.</div>`
    return `<ol class="wl-notes">${notes
      .map(
        (n) => `<li><div class="wl-note-meta">${esc(n.created.slice(0, 10))} · ${esc(n.page_title || "")} · <em>${esc(STATUS[n.status] || n.status)}</em></div>
        ${n.quote ? `<blockquote class="wl-inbox-quote">${esc(n.quote)}</blockquote>` : ""}
        <div class="wl-note-text">${esc(n.text || "")}${n.file_name ? ` <span class="wl-note-file">📎 ${esc(n.file_name)}</span>` : ""}</div>
        ${n.reply ? `<div class="wl-note-reply"><span>The DM:</span> ${esc(n.reply)}</div>` : ""}</li>`,
      )
      .join("")}</ol>`
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
      btn.addEventListener("click", () => openInbox(fresh ? undefined : undefined, lastSelection || draft.quote))
      document.body.appendChild(btn)
      return
    }
    const box = document.createElement("div")
    box.className = "wl-inbox"
    const tabs = `<div class="wl-inbox-tabs"><button type="button" data-tab="write" class="${draft.tab === "write" ? "on" : ""}">Write</button>
      <button type="button" data-tab="notes" class="${draft.tab === "notes" ? "on" : ""}">Your notes${fresh ? ` <span class="wl-inbox-badge">${fresh}</span>` : ""}</button></div>`
    const head = `<div class="wl-inbox-head"><span>Note to the DM</span><button type="button" class="wl-inbox-close" aria-label="Close">✕</button></div>${tabs}`
    if (draft.tab === "notes") {
      box.innerHTML = head + notesHtml(state.notes)
      if (state.notes) {
        const seen = new Set(read(localStorage, SEEN_KEY, []))
        state.notes.filter((n) => n.reply).forEach((n) => seen.add(n.id))
        write(localStorage, SEEN_KEY, [...seen])
      }
    } else {
      box.innerHTML = `${head}
      <label>What is it? <select class="wl-inbox-kind">${KINDS.map(([k, l]) => `<option value="${k}"${k === draft.kind ? " selected" : ""}>${l}</option>`).join("")}</select></label>
      ${draft.quote ? `<blockquote class="wl-inbox-quote">${esc(draft.quote)}<button type="button" class="wl-inbox-unquote" aria-label="Remove the quote">✕</button></blockquote>` : `<div class="wl-inbox-hint">Tip: select text on the page first to quote it.</div>`}
      <textarea rows="5" placeholder="Your message">${esc(draft.text)}</textarea>
      <label class="wl-inbox-file">Add a picture or sound (15 MB at most) <input type="file" accept="image/*,audio/*,.pdf"></label>
      <div class="wl-inbox-row"><span class="wl-inbox-status">${esc(draft.status || "Only the DM sees this.")}</span><button type="button" class="wl-inbox-send">Send</button></div>`
    }
    draft.status = ""
    box.querySelector(".wl-inbox-close").addEventListener("click", () => {
      draft.open = false
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
          page: { slug: document.body.dataset.slug || "", title: (h1 && h1.textContent.trim()) || document.title },
          quote: draft.quote,
          text,
          file: file ? { name: file.name, type: file.type, size: file.size } : null,
        })
        if (file) await api(`/api/inbox/${id}/file`, file, "PUT")
        Object.assign(draft, { quote: "", text: "", kind: "correction", status: "Sent ✓ The DM will see it." })
        lastSelection = ""
        state.notes = null
        renderInbox(reg)
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
          btn.textContent = "Answer"
          btn.addEventListener("click", () => openInbox("answer", li.textContent.replace(/\s*Answer$/, "").trim().slice(0, 600)))
          li.appendChild(btn)
        }
      }
    }
  }

  // one run at a time: on a fresh load the page fires both "DOMContentLoaded" and "nav", and two
  // overlapping runs would mark the page seen before the other decides whether it's new
  function run() {
    state.queue = (state.queue || Promise.resolve()).then(runOnce, runOnce)
    return state.queue
  }

  async function runOnce() {
    const reg = await registry()
    const slug = document.body.dataset.slug || "index"
    if (reg.viewer && !state.seen) await loadSeen()
    renderSidebar(reg)
    markPage(slug)
    if (reg.viewer) {
      // this page is now seen; its mark stays until the player moves on
      api("/api/seen", { slug }).catch(() => {})
      if (state.seen) state.seen[slug] = new Date().toISOString()
    }
    answerButtons(reg)
    renderInbox(reg)
    if (reg.viewer && !state.notes) {
      await loadNotes() // for the badge: new answers from the DM
      renderInbox(reg)
    }
  }

  document.addEventListener("nav", () => {
    lastSelection = ""
    run()
  })
  if (document.readyState !== "loading") run()
  else document.addEventListener("DOMContentLoaded", run)
  let wasMobile = mobile()
  window.addEventListener("resize", () => {
    if (mobile() !== wasMobile) {
      wasMobile = mobile()
      run()
    }
  })
})()
