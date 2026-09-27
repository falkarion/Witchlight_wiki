// The Witchlight wiki's own sidebar tree, player key and sealed content.
//
// publish.py builds static/for-player.json: the public part of the tree in the clear,
// plus one sealed entry per player (their name, their own page and their part of the
// tree), each encrypted with that player's passphrase (PBKDF2-SHA256 + AES-256-GCM).
// Pages only hold <div class="for-player" data-b="..."> blocks for sealed content.
// This script:
//  - renders the tree (mirrors the vault: an overview note and its folder are one entry
//    that opens the overview and folds out), merging in every unlocked player's pages;
//  - reveals the blocks the unlocked players can decrypt, styled by where they appear;
//  - gives sealed pages their real title once unlocked;
//  - adds the "Player key" field. Passphrases share the cache key of the old
//    encrypted-pages plugin, so older sessions keep working.
(() => {
  const PW_KEY = "encrypted-pages-passwords"
  const KEY_CACHE = "for-player:keys"
  const FOLD_KEY = "for-player:open"
  const state = (window.__witchlight = window.__witchlight || { registry: null, viewers: null, pwSig: "" })
  const base = () => document.body.dataset.basepath || ""
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
  const hex = (u) => [...u].map((b) => b.toString(16).padStart(2, "0")).join("")
  const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)))
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c])
  const read = (k, d) => {
    try {
      return JSON.parse(sessionStorage.getItem(k)) ?? d
    } catch {
      return d
    }
  }
  const write = (k, v) => {
    try {
      sessionStorage.setItem(k, JSON.stringify(v))
    } catch {}
  }
  const mobile = () => window.matchMedia("(max-width: 800px)").matches

  // --- crypto ---------------------------------------------------------------------------
  async function registry() {
    if (state.registry) return state.registry
    try {
      const r = await fetch(`${base()}/static/for-player.json`, { cache: "no-cache" })
      state.registry = await r.json()
    } catch {
      state.registry = { public: [], viewers: [] }
    }
    return state.registry
  }

  async function keyBytes(password, reg) {
    const cache = read(KEY_CACHE, {})
    const id = reg.salt + ":" + password
    if (cache[id]) return unhex(cache[id])
    const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"])
    const bits = new Uint8Array(
      await crypto.subtle.deriveBits({ name: "PBKDF2", salt: b64(reg.salt), iterations: reg.iterations, hash: "SHA-256" }, material, 256),
    )
    cache[id] = hex(bits)
    write(KEY_CACHE, cache)
    return bits
  }

  async function decrypt(bits, blob) {
    const data = b64(blob)
    const key = await crypto.subtle.importKey("raw", bits, "AES-GCM", false, ["decrypt"])
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: data.slice(0, 12) }, key, data.slice(12))
    return new TextDecoder().decode(plain)
  }

  // [{name, slug, pages, bits}] for every cached passphrase that belongs to a player
  async function viewers() {
    const passwords = read(PW_KEY, [])
    const sig = passwords.join("\n")
    if (state.viewers && state.pwSig === sig) return state.viewers
    const reg = await registry()
    const out = []
    for (const pw of passwords) {
      const bits = await keyBytes(pw, reg)
      for (const entry of reg.viewers || []) {
        try {
          const info = JSON.parse(await decrypt(bits, entry))
          if (!out.some((v) => v.name === info.name)) out.push({ ...info, bits })
        } catch {}
      }
    }
    state.viewers = out
    state.pwSig = sig
    return out
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
        const label = c.slug
          ? `<a class="wl-link${active}" href="${base()}/${c.slug === "index" ? "" : c.slug}">${esc(c.name)}</a>`
          : `<span class="wl-folder">${esc(c.name)}</span>`
        if (!c.children.size) return `<li class="wl-leaf">${label}</li>`
        const isOpen = open.has(c.key) || containsSlug(c, current)
        return `<li class="wl-branch${isOpen ? " open" : ""}" data-key="${esc(c.key)}">
          <div class="wl-row"><button type="button" class="wl-fold" aria-label="Fold" aria-expanded="${isOpen}">
          <svg viewBox="0 0 24 24" width="12" height="12"><polyline points="9 6 15 12 9 18" fill="none" stroke="currentColor" stroke-width="2.5"/></svg></button>${label}</div>
          ${renderNodes(c, current, open)}</li>`
      })
      .join("")}</ul>`
  }

  function unlockHtml(vs) {
    if (vs.length) {
      return `<div class="fp-label">Unlocked</div><div class="fp-who">${vs.map((v) => esc(v.name)).join(", ")}</div>
        <button type="button" class="fp-lock">Lock</button>`
    }
    return `<form class="fp-form"><label class="fp-label" for="fp-input">Player key</label>
      <div class="fp-row"><input id="fp-input" type="password" autocomplete="current-password" placeholder="Your passphrase">
      <button type="submit">Unlock</button></div><div class="fp-error" hidden>That key doesn't fit.</div></form>`
  }

  function wireUnlock(box) {
    box.querySelector(".fp-lock")?.addEventListener("click", () => {
      sessionStorage.removeItem(PW_KEY)
      sessionStorage.removeItem(KEY_CACHE)
      sessionStorage.removeItem("encrypted-pages:decryptedShadowEntries")
      state.viewers = null
      location.reload()
    })
    box.querySelector("form")?.addEventListener("submit", async (e) => {
      e.preventDefault()
      const input = box.querySelector("input")
      const pw = input.value.trim()
      if (!pw) return
      box.querySelector("button").disabled = true
      const reg = await registry()
      const bits = await keyBytes(pw, reg)
      let ok = false
      for (const entry of reg.viewers || []) {
        try {
          await decrypt(bits, entry)
          ok = true
        } catch {}
      }
      if (ok) {
        const list = read(PW_KEY, [])
        if (!list.includes(pw)) list.push(pw)
        write(PW_KEY, list)
        run()
      } else {
        box.querySelector(".fp-error").hidden = false
        box.querySelector("button").disabled = false
        input.select()
      }
    })
  }

  function renderSidebar(reg, vs) {
    document.querySelectorAll(".wl-nav").forEach((el) => el.remove())
    const entries = [...(reg.public || [])]
    for (const v of vs) for (const p of v.pages) if (!entries.some((e) => e.slug === p.slug)) entries.push(p)
    const tree = buildTree(entries)
    const current = document.body.dataset.slug
    const open = new Set(read(FOLD_KEY, []))
    const nav = document.createElement(mobile() ? "details" : "nav")
    nav.className = "wl-nav"
    nav.innerHTML = `${mobile() ? "<summary>Contents</summary>" : '<div class="wl-title">Contents</div>'}
      <div class="wl-tree">${renderNodes(tree, current, open)}</div><div class="for-player-unlock">${unlockHtml(vs)}</div>`
    nav.querySelectorAll(".wl-branch").forEach((li) => {
      const toggle = () => {
        const isOpen = li.classList.toggle("open")
        li.querySelector(".wl-fold").setAttribute("aria-expanded", isOpen)
        const keys = new Set(read(FOLD_KEY, []))
        isOpen ? keys.add(li.dataset.key) : keys.delete(li.dataset.key)
        write(FOLD_KEY, [...keys])
      }
      li.querySelector(".wl-fold").addEventListener("click", toggle)
      li.querySelector(".wl-row .wl-folder")?.addEventListener("click", toggle)
    })
    wireUnlock(nav.querySelector(".for-player-unlock"))
    if (mobile()) {
      document.querySelector(".center")?.prepend(nav)
    } else {
      document.querySelector(".left.sidebar")?.appendChild(nav)
    }
  }

  // --- sealed content -------------------------------------------------------------------
  async function reveal(vs) {
    const onSealedPage = !!document.querySelector(".sealed-page")
    let shown = 0
    for (const el of document.querySelectorAll(".for-player[data-b]")) {
      if (el.dataset.done) {
        shown++
        continue
      }
      for (const v of vs) {
        try {
          const html = await decrypt(v.bits, el.dataset.b)
          const style = onSealedPage ? "page" : el.dataset.s || "add"
          el.classList.add("revealed", `fp-${style}`)
          el.innerHTML =
            style === "note"
              ? `<div class="for-player-title">For ${esc(v.name)}</div>${html}`
              : style === "add"
                ? `<div class="fp-tag">for ${esc(v.name)}</div>${html}`
                : html
          el.dataset.done = "1"
          shown++
          break
        } catch {}
      }
    }
    if (!onSealedPage) return
    const slug = document.body.dataset.slug
    const page = vs.flatMap((v) => v.pages).find((p) => p.slug === slug)
    const marker = document.querySelector(".sealed-page")
    if (page) {
      const h1 = document.querySelector("h1.article-title")
      if (h1) h1.textContent = page.title
      document.title = page.title
      document.querySelectorAll(".breadcrumb-element:last-child, nav.breadcrumb-container > :last-child").forEach((el) => {
        if (el.textContent.includes("sealed")) el.textContent = page.title
      })
    }
    marker.textContent = shown
      ? ""
      : vs.length
        ? "This page is sealed. Your key doesn't open it."
        : "This page is sealed. Enter your player key to open it."
    marker.classList.toggle("empty", !shown)
  }

  async function run() {
    const reg = await registry()
    const vs = await viewers()
    renderSidebar(reg, vs)
    await reveal(vs)
  }

  document.addEventListener("nav", run)
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
