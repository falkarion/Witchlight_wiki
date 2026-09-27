// Player-only passages and the sidebar unlock field.
//
// publish.py encrypts every `> [!for] Name` passage with that player's passphrase
// (PBKDF2-SHA256 + AES-256-GCM) before the site is built, so the page only holds
// <div class="for-player" data-b="..."> blocks. This script derives each unlocked
// player's key, reveals the passages it can decrypt, and adds an unlock field to
// the left sidebar. Passphrases are shared with the encrypted-pages plugin's cache,
// so unlocking here also opens the player's own page.
(() => {
  const PW_KEY = "encrypted-pages-passwords" // the plugin's password cache
  const KEY_CACHE = "for-player:keys" // derived keys, per session
  const base = () => document.body.dataset.basepath || ""
  let registry = null
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
  const hex = (u) => [...u].map((b) => b.toString(16).padStart(2, "0")).join("")
  const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)))
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

  async function loadRegistry() {
    if (registry) return registry
    try {
      const r = await fetch(`${base()}/static/for-player.json`, { cache: "no-cache" })
      registry = await r.json()
    } catch {
      registry = { players: [] }
    }
    return registry
  }

  async function keyBytes(password, reg) {
    const cache = read(KEY_CACHE, {})
    const id = reg.salt + ":" + password
    if (cache[id]) return unhex(cache[id])
    const material = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"])
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: b64(reg.salt), iterations: reg.iterations, hash: "SHA-256" },
      material, 256))
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

  // [{name, slug, bits}] for every cached passphrase that belongs to a player
  async function unlockedPlayers() {
    const reg = await loadRegistry()
    const out = []
    for (const pw of read(PW_KEY, [])) {
      const bits = await keyBytes(pw, reg)
      for (const entry of reg.players) {
        try {
          const info = JSON.parse(await decrypt(bits, entry))
          if (!out.some((p) => p.name === info.name)) out.push({ ...info, bits })
        } catch {}
      }
    }
    return out
  }

  async function reveal(players) {
    for (const el of document.querySelectorAll(".for-player[data-b]:not([data-done])")) {
      for (const p of players) {
        try {
          const html = await decrypt(p.bits, el.dataset.b)
          el.innerHTML = `<div class="for-player-title">For ${p.name}</div>${html}`
          el.dataset.done = "1"
          el.classList.add("revealed")
          break
        } catch {}
      }
    }
  }

  function widget(players) {
    // Desktop: bottom of the left sidebar. Phone: the sidebar becomes the header row,
    // so the field goes below the page content instead.
    const mobile = window.matchMedia("(max-width: 800px)").matches
    const sidebar = mobile ? document.querySelector(".center") : document.querySelector(".left.sidebar")
    if (!sidebar) return
    document.querySelectorAll(".for-player-unlock").forEach((el) => el.remove())
    const box = document.createElement("div")
    box.className = "for-player-unlock"
    if (players.length) {
      const links = players
        .map((p) => `<a class="internal" href="${base()}/${p.slug}">${p.name}</a>`)
        .join(", ")
      box.innerHTML = `<div class="fp-label">Unlocked</div><div class="fp-who">${links}</div>
        <button type="button" class="fp-lock">Lock</button>`
      box.querySelector(".fp-lock").addEventListener("click", () => {
        sessionStorage.removeItem(PW_KEY)
        sessionStorage.removeItem(KEY_CACHE)
        sessionStorage.removeItem("encrypted-pages:decryptedShadowEntries")
        location.reload()
      })
    } else {
      box.innerHTML = `<form class="fp-form"><label class="fp-label" for="fp-input">Player key</label>
        <div class="fp-row"><input id="fp-input" type="password" autocomplete="current-password" placeholder="Your passphrase">
        <button type="submit">Unlock</button></div><div class="fp-error" hidden>That key doesn't fit.</div></form>`
      box.querySelector("form").addEventListener("submit", async (e) => {
        e.preventDefault()
        const input = box.querySelector("input")
        const pw = input.value.trim()
        if (!pw) return
        box.querySelector("button").disabled = true
        const reg = await loadRegistry()
        const bits = await keyBytes(pw, reg)
        let ok = false
        for (const entry of reg.players) {
          try {
            await decrypt(bits, entry)
            ok = true
          } catch {}
        }
        if (ok) {
          const list = read(PW_KEY, [])
          if (!list.includes(pw)) list.push(pw)
          write(PW_KEY, list)
          location.reload()
        } else {
          box.querySelector(".fp-error").hidden = false
          box.querySelector("button").disabled = false
          input.select()
        }
      })
    }
    sidebar.appendChild(box)
  }

  async function run() {
    const players = await unlockedPlayers()
    widget(players)
    await reveal(players)
  }

  document.addEventListener("nav", run)
  document.addEventListener("render", run)
  if (document.readyState !== "loading") run()
  else document.addEventListener("DOMContentLoaded", run)
})()
