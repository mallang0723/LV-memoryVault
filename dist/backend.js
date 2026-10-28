// @bun
// src/router.js
function normalizePath(path) {
  const [pure, query = ""] = String(path || "").split("?");
  const clean = pure.replace(/^\/?api\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
  const q = {};
  for (const [k, v] of new URLSearchParams(query))
    q[k] = v;
  return { path: clean, query: q };
}
function createRouter() {
  const routes = [];
  const compile = (pattern) => pattern.split("/").filter(Boolean);
  function add(method, pattern, handler) {
    routes.push({ method: method.toUpperCase(), parts: compile(pattern), pattern, handler });
    return api;
  }
  function match(method, path) {
    const segs = path.split("/").filter(Boolean);
    let best = null;
    for (const r of routes) {
      if (r.method !== method || r.parts.length !== segs.length)
        continue;
      const params = {};
      let literal = 0, ok = true;
      r.parts.forEach((p, i) => {
        if (p.startsWith(":")) {
          try {
            params[p.slice(1)] = decodeURIComponent(segs[i]);
          } catch {
            ok = false;
          }
        } else if (p === segs[i])
          literal++;
        else
          ok = false;
      });
      if (ok && (!best || literal > best.literal))
        best = { route: r, params, literal };
    }
    return best;
  }
  async function handle({ method = "GET", path = "", body } = {}, userId) {
    if (typeof userId !== "string" || !userId)
      throw Object.assign(new Error("userId required"), { status: 401 });
    const norm = normalizePath(path);
    const m = match(String(method).toUpperCase(), norm.path);
    if (!m)
      throw Object.assign(new Error(`\uAE38\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4 (${method} ${norm.path})`), { status: 404 });
    return m.route.handler({ userId, params: m.params, query: norm.query, body: body ?? {}, path: norm.path });
  }
  function attach(spindle2) {
    return spindle2.onFrontendMessage(async (payload, userId, frontendSessionId) => {
      if (!payload || typeof payload.requestId !== "string" || payload.type !== "api")
        return;
      let reply;
      try {
        reply = { ok: true, data: await handle(payload, userId) };
      } catch (error) {
        reply = { ok: false, error: String(error?.message || error), ...error?.code ? { code: error.code } : {}, ...error?.status ? { status: error.status } : {} };
      }
      try {
        spindle2.sendToFrontend({ ...reply, requestId: payload.requestId }, userId, frontendSessionId ? { frontendSessionId } : undefined);
      } catch {}
    });
  }
  const api = { add, handle, attach, match, list: () => routes.map((r) => `${r.method} ${r.pattern}`) };
  return api;
}

// src/host.js
var PAGE = 200;
var NS = "memory_cabinet";
var iso = (t) => {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0)
    return null;
  return new Date(n < 1000000000000 ? n * 1000 : n).toISOString();
};
var err = (m, status) => Object.assign(new Error(m), { status });
function createHost(api, { summaries } = {}) {
  const need = (u) => {
    if (typeof u !== "string" || !u)
      throw err("userId required", 401);
    return u;
  };
  async function pages(userId, fn) {
    const out = [];
    for (let offset = 0;; offset += PAGE) {
      const res = await fn({ limit: PAGE, offset, userId });
      const data = Array.isArray(res) ? res : res?.data || [];
      out.push(...data);
      if (Array.isArray(res) || data.length < PAGE || res.total != null && out.length >= res.total)
        break;
    }
    return out;
  }
  const shapeChat = (c, extra = null) => {
    const m = c.metadata && typeof c.metadata === "object" ? c.metadata : {};
    const metadata = { ...m, activeLorebookIds: Array.isArray(m.chat_world_book_ids) ? m.chat_world_book_ids : [] };
    if (typeof m.branched_from === "string")
      metadata.branchParentChatId = m.branched_from;
    const entries = extra || summaries?.cached(c.id) || [];
    if (entries.length)
      metadata.summaryEntries = entries;
    const ids = Array.isArray(m.character_ids) && m.character_ids.length ? m.character_ids : c.character_id ? [c.character_id] : [];
    return { id: c.id, name: c.name || "", mode: "roleplay", characterIds: ids, metadata, createdAt: iso(c.created_at), updatedAt: iso(c.updated_at), lastMessageAt: iso(c.updated_at) };
  };
  const chatsList = async (u) => (await pages(need(u), (o) => api.chats.list(o))).map(shapeChat);
  async function chat(u, id) {
    const c = await api.chats.get(id, need(u));
    if (!c)
      throw err("\uCC44\uD305\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", 404);
    return shapeChat(c, summaries ? await summaries.entries(id) : null);
  }
  const queues = new Map;
  const queued = (id, fn) => {
    const run = (queues.get(id) || Promise.resolve()).catch(() => {}).then(fn);
    queues.set(id, run);
    run.catch(() => {}).finally(() => {
      if (queues.get(id) === run)
        queues.delete(id);
    });
    return run;
  };
  const stable = (v) => Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, stable(v[k])])) : v;
  const same = (a, b) => JSON.stringify(stable(a ?? null)) === JSON.stringify(stable(b ?? null));
  function applyPatch(base, patch) {
    const next = { ...base || {} }, touched = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (k === "summaryEntries" || k === "branchParentChatId")
        continue;
      const key = k === "activeLorebookIds" ? "chat_world_book_ids" : k;
      next[key] = k === "activeLorebookIds" ? Array.isArray(v) ? v.map(String) : [] : v;
      touched[key] = next[key];
    }
    return { next, touched };
  }
  function patchMetadata(u, id, patch, { attempts = 3 } = {}) {
    need(u);
    return queued(id, async () => {
      for (let i = 0;i < attempts; i++) {
        const c = await api.chats.get(id, u);
        if (!c)
          throw err("\uCC44\uD305\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", 404);
        const { next, touched } = applyPatch(c.metadata, patch);
        const c2 = await api.chats.update(id, { metadata: next }, u);
        const back = await api.chats.get(id, u);
        if (back && Object.keys(touched).every((k) => same(back.metadata?.[k], touched[k])))
          return shapeChat(back);
      }
      throw err("\uCC44\uD305 \uBA54\uD0C0\uB370\uC774\uD130\uB97C \uC800\uC7A5\uD558\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4(\uD638\uC2A4\uD2B8\uAC00 \uAC19\uC740 \uC2DC\uAC01\uC5D0 \uB36E\uC5B4\uC37C\uC2B5\uB2C8\uB2E4). \uB2E4\uC2DC \uC2DC\uB3C4\uD574 \uC8FC\uC138\uC694.", 409);
    });
  }
  async function messages(u, id, limit) {
    if (!await api.chats.get(id, need(u)))
      throw err("\uCC44\uD305\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", 404);
    const rows = await api.chat.getMessages(id);
    const all = (rows || []).map((m) => ({ id: m.id, role: m.role === "system" ? "system" : m.is_user ? "user" : "assistant", content: m.content || "", name: m.name || "", createdAt: iso(m.created_at || m.send_date), number: (m.index_in_chat ?? 0) + 1, extra: { hidden: m.extra?.hidden === true } })).sort((a, b) => a.number - b.number);
    return limit ? all.slice(-Math.max(1, Math.min(500, limit))) : all;
  }
  const connections = async (u) => (await api.connections.list(need(u)) || []).map((c) => ({ id: c.id, name: c.name, provider: c.provider, model: c.model, isDefault: !!c.is_default }));
  async function character(u, id) {
    const c = await api.characters.get(id, need(u));
    if (!c)
      throw err("\uCE90\uB9AD\uD130\uB97C \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", 404);
    return c;
  }
  async function generate(u, { connectionId, messages: msgs, parameters = {}, signal }) {
    const p = {};
    if (parameters.maxTokens != null)
      p.max_tokens = parameters.maxTokens;
    if (parameters.temperature != null)
      p.temperature = parameters.temperature;
    const r = await api.generate.quiet({ messages: msgs, ...connectionId ? { connection_id: connectionId } : {}, parameters: p, signal, userId: need(u) });
    return { content: typeof r === "string" ? r : r?.content || "" };
  }
  const shapeBook = (b) => {
    const mine = b.metadata?.[NS] || {};
    return { id: b.id, name: b.name, description: b.description || "", tags: mine.tags || [], chatId: mine.chatId || null, scope: mine.scope || null, isGlobal: false, enabled: true, category: "uncategorized", createdAt: iso(b.created_at), updatedAt: iso(b.updated_at) };
  };
  const bookMeta = (f, prev = {}) => ({ ...prev, [NS]: { ...prev[NS] || {}, ...f.tags ? { tags: f.tags } : {}, ...f.chatId !== undefined ? { chatId: f.chatId } : {}, ...f.scope ? { scope: f.scope } : {} } });
  async function lorebooks(u, chatId) {
    const all = (await pages(need(u), (o) => api.world_books.list(o))).map(shapeBook);
    if (!chatId)
      return all;
    const c = await api.chats.get(chatId, u);
    const ids = new Set(c?.metadata?.chat_world_book_ids || []);
    return all.filter((b) => ids.has(b.id) || b.chatId === chatId);
  }
  async function lorebook(u, id) {
    const b = await api.world_books.get(id, need(u));
    if (!b)
      throw err("\uB85C\uC5B4\uBD81\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", 404);
    return shapeBook(b);
  }
  const createBook = async (u, f) => shapeBook(await api.world_books.create({ name: String(f.name || "\uAE30\uC5B5 \uBCF4\uAD00\uD568"), description: String(f.description || ""), metadata: bookMeta(f) }, need(u)));
  async function patchBook(u, id, f) {
    const prev = await api.world_books.get(id, need(u));
    if (!prev)
      throw err("\uB85C\uC5B4\uBD81\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", 404);
    return shapeBook(await api.world_books.update(id, { ...f.name !== undefined ? { name: String(f.name) } : {}, ...f.description !== undefined ? { description: String(f.description) } : {}, metadata: bookMeta(f, prev.metadata || {}) }, u));
  }
  const DIRECT = { name: "comment", content: "content", keys: "key", secondaryKeys: "keysecondary", constant: "constant", selective: "selective", matchWholeWords: "match_whole_words", caseSensitive: "case_sensitive", useRegex: "use_regex", position: "position", depth: "depth", order: "order_value", role: "role", preventRecursion: "prevent_recursion", excludeRecursion: "exclude_recursion", delayUntilRecursion: "delay_until_recursion", scanDepth: "scan_depth" };
  const EXT_KEYS = ["description", "tag", "dynamicState", "locked", "characterFilterMode", "characterFilterIds", "excludeFromVectorization"];
  const knownByWrap = (content, names) => names.map((n) => `{{if::{{char}}==${n}}}${content}{{/if}}`).join("");
  function toEntry(f, nameOf = (id) => id) {
    const out = {}, ext = {};
    for (const [k, col] of Object.entries(DIRECT))
      if (f[k] !== undefined && f[k] !== null)
        out[col] = k === "keys" || k === "secondaryKeys" ? f[k].map(String) : f[k];
    if (f.enabled !== undefined)
      out.disabled = !f.enabled;
    if (f.probability != null) {
      out.probability = Number(f.probability);
      out.use_probability = true;
    }
    for (const k of EXT_KEYS)
      if (f[k] !== undefined)
        ext[k] = f[k];
    if (f.characterFilterMode === "include" && Array.isArray(f.characterFilterIds) && f.characterFilterIds.length && typeof f.content === "string") {
      out.content = knownByWrap(f.content, f.characterFilterIds.map(nameOf));
      ext.rawContent = f.content;
    }
    return { fields: out, ext };
  }
  const shapeEntry = (e, bookId) => {
    const m = e.extensions?.[NS] || {};
    return { id: e.id, lorebookId: bookId, name: e.comment || "", content: m.rawContent ?? e.content ?? "", keys: e.key || [], secondaryKeys: e.keysecondary || [], enabled: !e.disabled, constant: !!e.constant, selective: !!e.selective, order: e.order_value, position: e.position, depth: e.depth, role: e.role, description: m.description || "", tag: m.tag || "", dynamicState: m.dynamicState || {}, locked: !!m.locked, characterFilterMode: m.characterFilterMode || "any", characterFilterIds: m.characterFilterIds || [] };
  };
  const entries = async (u, bookId) => (await pages(need(u), (o) => api.world_books.entries.list(bookId, o))).map((e) => shapeEntry(e, bookId));
  async function nameResolver(u, ids) {
    const m = new Map;
    for (const id of new Set(ids || [])) {
      try {
        m.set(id, (await api.characters.get(id, u))?.name || id);
      } catch {
        m.set(id, id);
      }
    }
    return (id) => m.get(id) || id;
  }
  async function createEntry(u, bookId, f) {
    const { fields, ext } = toEntry(f, await nameResolver(need(u), f.characterFilterIds));
    return shapeEntry(await api.world_books.entries.create(bookId, { ...fields, extensions: { [NS]: ext } }, u), bookId);
  }
  async function patchEntry(u, bookId, entryId, f) {
    const { fields, ext } = toEntry(f, await nameResolver(need(u), f.characterFilterIds));
    const prevAll = (await api.world_books.entries.get(entryId, u))?.extensions || {};
    return shapeEntry(await api.world_books.entries.update(entryId, { ...fields, extensions: { ...prevAll, [NS]: { ...prevAll[NS] || {}, ...ext } } }, u), bookId);
  }
  return { chatsList, chat, patchMetadata, messages, connections, character, generate, lorebooks, lorebook, createBook, patchBook, entries, createEntry, patchEntry };
}

// src/trigger.js
var EVERY_DEFAULT = 10;
var EVERY_MIN = 3;
var EVERY_MAX = 100;
var KEEP = 5;
var MAX_CHARS = 120000;
var rangeHash = (slice) => {
  let h = 2166136261;
  for (const r of slice)
    for (const ch of `${r.id ?? ""}|${r.number}|`) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619) >>> 0;
    }
  return h.toString(36);
};
var clampEvery = (v) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.min(EVERY_MAX, Math.max(EVERY_MIN, n)) : EVERY_DEFAULT;
};
function createTrigger({ every = EVERY_DEFAULT, store = null, now = () => new Date().toISOString() } = {}) {
  const cache = new Map;
  const chains = new Map;
  const getEvery = async () => clampEvery(typeof every === "function" ? await every() : every);
  const valid = (s) => s && Number.isFinite(s.lastUsers) && Number.isFinite(s.from) && Array.isArray(s.entries);
  async function stateOf(chatId) {
    if (cache.has(chatId))
      return cache.get(chatId);
    let s = null;
    try {
      s = store ? await store.load(chatId) : null;
    } catch {}
    if (!valid(s))
      s = null;
    if (s)
      cache.set(chatId, s);
    return s;
  }
  const persist = async (chatId, s) => {
    cache.set(chatId, s);
    try {
      await store?.save(chatId, s);
    } catch {}
  };
  async function step(chatId, rows) {
    const users = rows.filter((r) => r.role === "user").length, last = rows.at(-1)?.number ?? 0;
    let s = await stateOf(chatId);
    if (!s) {
      const first = rows[0]?.number ?? 1, every = await getEvery();
      s = users < every ? { lastUsers: 0, from: first, entries: [] } : { lastUsers: users, from: last + 1, entries: [] };
      await persist(chatId, s);
      if (users < every)
        return null;
    }
    if (users < s.lastUsers) {
      s = { ...s, lastUsers: users, from: Math.min(s.from, last + 1) };
      await persist(chatId, s);
      return null;
    }
    if (users - s.lastUsers < await getEvery())
      return null;
    const slice = rows.filter((r) => r.number >= s.from && r.role !== "system" && !r.extra?.hidden && String(r.content || "").trim());
    const next = { lastUsers: users, from: last + 1, entries: s.entries };
    if (!slice.length) {
      await persist(chatId, next);
      return null;
    }
    let content = slice.map((r) => `${r.role === "user" ? "[\uC0AC\uC6A9\uC790]" : `[${r.name || "\uCE90\uB9AD\uD130"}]`} ${r.content}`).join(`

`);
    if (content.length > MAX_CHARS)
      content = content.slice(content.length - MAX_CHARS);
    const turns = slice.filter((r) => r.role === "user").length;
    const entry = { id: `mv-${chatId.slice(0, 8)}-${slice[0].number}-${slice.at(-1).number}-${rangeHash(slice)}`, title: `\uCD5C\uADFC ${turns}\uD134 \uB300\uD654 (#${slice[0].number}\u2013#${slice.at(-1).number})`, content, enabled: true, origin: "memory-cabinet-adapter", createdAt: now(), updatedAt: now() };
    next.entries = [...s.entries.filter((e) => e.id !== entry.id), entry].slice(-KEEP);
    await persist(chatId, next);
    return entry;
  }
  return {
    cached: (chatId) => cache.get(chatId)?.entries || [],
    async entries(chatId) {
      return (await stateOf(chatId))?.entries || [];
    },
    onGenerationEnded(chatId, rows) {
      const run = (chains.get(chatId) || Promise.resolve()).catch(() => {}).then(() => step(chatId, rows));
      chains.set(chatId, run);
      run.catch(() => {}).finally(() => {
        if (chains.get(chatId) === run)
          chains.delete(chatId);
      });
      return run;
    }
  };
}

// src/migrate.js
var IMPORT_LAYERS = ["promises", "anchors"];
var CATEGORY = { anchors: "setting", elements: "setting", scenes: "event", flows: "state", wiki: "setting" };
var LAYER_TAG = { anchors: "", elements: "[\uC694\uC18C] ", scenes: "[\uC7A5\uBA74] ", flows: "[\uD750\uB984] ", wiki: "[\uC704\uD0A4] " };
var firstLine = (t, n = 60) => {
  const s = String(t).trim().split(/\n/)[0];
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
};
function mapItem(x, now) {
  const kb = Array.isArray(x.knownBy) ? x.knownBy.map(String).filter(Boolean) : [];
  const blocked = !!(x.audience || x.condition || x.branchHold || x.hold || x.review || x.resumeRequired || x.importedScope);
  const publicOk = x.scope === "public" && !kb.length;
  const restrictedOk = kb.length > 0 && ["secret", "character"].includes(x.scope);
  const inject = !blocked && (publicOk || restrictedOk);
  const base = { id: `mig-${x.id}`.slice(0, 120), title: LAYER_TAG[x.layer] ? LAYER_TAG[x.layer] + firstLine(x.text, 50) : firstLine(x.text), content: String(x.text), sourceType: "migrated-0.4", sourceIds: (x.evidence || []).map((e) => String(e.id)), createdAt: now, updatedAt: now, ...kb.length ? { knownBy: kb } : {} };
  if (x.layer === "promises")
    return { ...base, type: "promise", status: x.status === "completed" ? "done" : x.status === "cancelled" ? "cancelled" : inject ? "active" : "hold", priority: "normal", scheduleText: "" };
  return { ...base, type: "anchor", category: CATEGORY[x.layer] || "setting", priority: "normal", active: inject && x.status !== "cancelled", archived: x.status === "cancelled" || x.status === "completed", activation: "always", keywords: [], lifespan: "permanent" };
}
function mapOldToOriginal(old, { chatId, now = new Date().toISOString() }) {
  const all = old?.items || [];
  const items = all.filter((x) => IMPORT_LAYERS.includes(x.layer)).map((x) => mapItem(x, now));
  const skippedByLayer = {};
  for (const x of all)
    if (!IMPORT_LAYERS.includes(x.layer))
      skippedByLayer[x.layer || "?"] = (skippedByLayer[x.layer || "?"] || 0) + 1;
  const held = items.filter((i) => i.type === "promise" ? i.status === "hold" : !i.active && !i.archived).length;
  return {
    data: { version: 1, ownerChatId: chatId, enabled: true, items },
    report: {
      items: items.length,
      held,
      skippedByLayer,
      candidatesDropped: (old?.candidates || []).length,
      undoDropped: (old?.undo || []).length,
      lostFields: ["revision", "undo", "candidates (re-run analysis)", "evidence.index/fingerprint", "audience", "condition", "importedScope", "branchHold", "review", "resumeRequired", "elements/scenes/flows/wiki items (backup only)"]
    }
  };
}
function buildBackup({ chats, settings = null, version = "0.4.x", now = new Date().toISOString() }) {
  return { format: "memory-cabinet-lv-backup", formatVersion: 1, createdAt: now, extensionVersion: version, settings, chats };
}
// spindle.json
var spindle_default = {
  version: "1.0.0-rc.1",
  name: "\uAE30\uC5B5 \uBCF4\uAD00\uD568",
  identifier: "memory_cabinet",
  author: "mallang0723 (personal port); original by its author (Marinara memory_vault v2.1.1, shared with permission)",
  github: "https://github.com/mallang0723/LV-memoryVault",
  homepage: "https://github.com/mallang0723/LV-memoryVault",
  description: "\uB8E8\uBBF8\uBC84\uC2A4\uC6A9 \xB7 \uBE44\uACF5\uC2DD (Unofficial, for Lumiverse) \xB7 \uC6D0\uBCF8 \uBB34\uC218\uC815 + \uC5B4\uB311\uD130",
  permissions: ["chats", "chat_mutation", "generation", "world_books", "characters"],
  entry_backend: "dist/backend.js",
  entry_frontend: "dist/frontend.js"
};

// src/backend.js
var PERMS = ["chats", "chat_mutation", "generation", "world_books", "characters"];
var safeId = (id) => typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
var BASIC = new Set(["version", "ownerChatId", "enabled", "items"]);
var pristine = (v) => v == null || typeof v === "object" && !Array.isArray(v) && !(Array.isArray(v.items) && v.items.length) && Object.keys(v).every((k) => BASIC.has(k));
var fail = (message, status) => Object.assign(new Error(message), { status });
function start(api, options = {}) {
  const ui = (userId) => `ui-${userId}.json`;
  const read = (userId, path, fallback) => api.userStorage.getJson(path, { fallback, userId });
  const write = (userId, path, value) => api.userStorage.setJson(path, value, { userId });
  const log = (level, m) => {
    try {
      api.log?.[level]?.(`[memory-cabinet] ${m}`);
    } catch {}
  };
  const has = (p) => {
    try {
      return api.permissions?.has ? !!api.permissions.has(p) : true;
    } catch {
      return false;
    }
  };
  const everyOf = async (userId) => clampEvery((await read(userId, "adapter-settings.json", {}))?.every ?? options.trigger?.every ?? EVERY_DEFAULT);
  const triggers = new Map;
  const triggerFor = (userId) => {
    if (!triggers.has(userId))
      triggers.set(userId, createTrigger({
        every: () => everyOf(userId),
        now: options.trigger?.now,
        store: { load: (chatId) => safeId(chatId) ? read(userId, `trigger/${chatId}.json`, null) : null, save: (chatId, s) => safeId(chatId) ? write(userId, `trigger/${chatId}.json`, s) : undefined }
      }));
    return triggers.get(userId);
  };
  const hosts = new Map;
  const hostFor = (userId) => {
    if (!hosts.has(userId)) {
      const t = triggerFor(userId);
      hosts.set(userId, createHost(api, { summaries: { cached: (id) => t.cached(id), entries: (id) => t.entries(id) } }));
    }
    return hosts.get(userId);
  };
  const router = createRouter();
  const h = (fn) => (ctx) => fn(hostFor(ctx.userId), ctx);
  router.add("GET", "connections", h((host, { userId }) => host.connections(userId)));
  router.add("GET", "chats", h((host, { userId }) => host.chatsList(userId)));
  router.add("GET", "chats/:id", h((host, { userId, params }) => host.chat(userId, params.id)));
  router.add("GET", "chats/:id/messages", h((host, { userId, params, query }) => host.messages(userId, params.id, Number(query.limit) || 0)));
  router.add("PATCH", "chats/:id/metadata", h((host, { userId, params, body }) => host.patchMetadata(userId, params.id, body)));
  router.add("GET", "chats/:id/advanced-memory", () => {
    throw fail("\uACE0\uAE09 \uBA54\uBAA8\uB9AC\uB294 \uC774 \uD638\uC2A4\uD2B8\uC5D0 \uC5C6\uC2B5\uB2C8\uB2E4.", 404);
  });
  router.add("GET", "characters/:id", h((host, { userId, params }) => host.character(userId, params.id)));
  router.add("GET", "agents", () => []);
  router.add("GET", "lorebooks", h((host, { userId, query }) => host.lorebooks(userId, query.chatId)));
  router.add("POST", "lorebooks", h((host, { userId, body }) => host.createBook(userId, body)));
  router.add("GET", "lorebooks/:id", h((host, { userId, params }) => host.lorebook(userId, params.id)));
  router.add("PATCH", "lorebooks/:id", h((host, { userId, params, body }) => host.patchBook(userId, params.id, body)));
  router.add("GET", "lorebooks/:id/entries", h((host, { userId, params }) => host.entries(userId, params.id)));
  router.add("POST", "lorebooks/:id/entries", h((host, { userId, params, body }) => host.createEntry(userId, params.id, body)));
  router.add("PATCH", "lorebooks/:id/entries/:entryId", h((host, { userId, params, body }) => host.patchEntry(userId, params.id, params.entryId, body)));
  router.add("POST", "generate/raw", h(async (host, { userId, body }) => host.generate(userId, body)));
  router.add("GET", "_storage", ({ userId }) => read(userId, ui(userId), {}));
  router.add("POST", "_storage", async ({ userId, body }) => {
    const next = { ...await read(userId, ui(userId), {}), ...body?.patch || {} };
    await write(userId, ui(userId), next);
    return next;
  });
  router.add("GET", "_adapter/status", async ({ userId }) => ({
    version: spindle_default.version,
    every: await everyOf(userId),
    everyMin: EVERY_MIN,
    everyMax: EVERY_MAX,
    everyDefault: EVERY_DEFAULT,
    permissions: Object.fromEntries(PERMS.map((p) => [p, has(p)])),
    migrate: await migrateStatus(userId)
  }));
  router.add("POST", "_adapter/settings", async ({ userId, body }) => {
    const cur = await read(userId, "adapter-settings.json", {});
    const next = { ...cur, every: clampEvery(body?.every ?? cur.every) };
    await write(userId, "adapter-settings.json", next);
    return next;
  });
  const claimed = new Map;
  router.add("POST", "_trigger/claim", ({ userId, body }) => {
    const raw = String(body?.id || "");
    if (!raw)
      return { ok: false };
    const id = `${userId}\x00${raw}`;
    const now = Date.now();
    for (const [k, t] of claimed)
      if (now - t > 600000)
        claimed.delete(k);
    if (claimed.has(id))
      return { ok: false };
    claimed.set(id, now);
    return { ok: true };
  });
  const MIG = "migrate-state.json";
  const canList = () => typeof api.userStorage?.list === "function";
  async function oldFiles(userId) {
    if (!canList())
      throw fail("\uC774 \uB8E8\uBBF8\uBC84\uC2A4 \uBC84\uC804\uC740 \uC800\uC7A5\uC18C \uBAA9\uB85D \uC870\uD68C\uB97C \uC9C0\uC6D0\uD558\uC9C0 \uC54A\uC544 \uC61B \uB370\uC774\uD130\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.", 501);
    const chats = {};
    const want = new Set;
    const note = (f) => {
      const m = /^\/*(?:chats\/)?([A-Za-z0-9_-]+)\/(data|auto|health)\.json$/.exec(String(f));
      if (m)
        want.add(`${m[1]}/${m[2]}`);
    };
    for (const f of await api.userStorage.list("chats/", userId) || [])
      note(f);
    if (!want.size)
      for (const d of await api.userStorage.list("chats/", userId) || []) {
        const id = /^\/*(?:chats\/)?([A-Za-z0-9_-]+)\/?$/.exec(String(d))?.[1];
        if (id)
          for (const f of await api.userStorage.list(`chats/${id}/`, userId) || [])
            note(`${id}/${String(f).split("/").pop()}`);
      }
    for (const k of want) {
      const [id, kind] = k.split("/");
      (chats[id] ||= {})[kind] = await read(userId, `chats/${id}/${kind}.json`, null);
    }
    return chats;
  }
  async function migrateStatus(userId) {
    const state = await read(userId, MIG, {});
    let chats = 0, items = 0, importable = 0, error = null;
    if (!canList())
      error = "unsupported";
    else
      try {
        for (const files of Object.values(await oldFiles(userId))) {
          const list = files.data?.items || [];
          if (!list.length)
            continue;
          chats++;
          items += list.length;
          importable += list.filter((x) => IMPORT_LAYERS.includes(x.layer)).length;
        }
      } catch (e) {
        error = String(e?.message || e);
      }
    return { oldChats: chats, oldItems: items, importable, error, backedUpAt: state.backedUpAt || null, importedAt: state.importedAt || null, dismissed: !!state.dismissed, result: state.result || null };
  }
  router.add("GET", "_migrate/status", ({ userId }) => migrateStatus(userId));
  router.add("GET", "_migrate/backup", async ({ userId }) => {
    const chats = await oldFiles(userId);
    for (const id of Object.keys(chats)) {
      try {
        const c = await api.chats.get(id, userId);
        if (c?.name)
          chats[id].name = c.name;
      } catch {}
    }
    const settings = await read(userId, "settings.json", null).catch(() => null);
    const st = await read(userId, MIG, {});
    await write(userId, MIG, { ...st, backedUpAt: new Date().toISOString() });
    return buildBackup({ chats, settings, version: "0.4.x" });
  });
  router.add("POST", "_migrate/dismiss", async ({ userId }) => {
    await write(userId, MIG, { ...await read(userId, MIG, {}), dismissed: true });
    return { ok: true };
  });
  router.add("POST", "_migrate/apply", async ({ userId, body }) => {
    if (body?.confirmBackup !== true)
      throw fail("\uBA3C\uC800 \uBC31\uC5C5 \uD30C\uC77C\uC744 \uC800\uC7A5\uD588\uB294\uC9C0 \uD655\uC778\uD574 \uC8FC\uC138\uC694.", 400);
    const st = await read(userId, MIG, {});
    if (!st.backedUpAt)
      throw fail("\uBC31\uC5C5\uC744 \uD55C \uBC88\uB3C4 \uB0B4\uB824\uBC1B\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4. \uBC31\uC5C5\uC744 \uBA3C\uC800 \uB0B4\uB824\uBC1B\uC73C\uC138\uC694.", 400);
    const host = hostFor(userId), out = {};
    for (const [chatId, files] of Object.entries(await oldFiles(userId))) {
      if (!files.data?.items?.length)
        continue;
      const c = await api.chats.get(chatId, userId).catch(() => null);
      if (!c) {
        out[chatId] = { skipped: "chat gone" };
        continue;
      }
      const name = typeof c.name === "string" ? c.name : "";
      if (!pristine(c.metadata?.memoryCabinetV1)) {
        out[chatId] = { name, skipped: "already has original data" };
        continue;
      }
      const { data, report } = mapOldToOriginal(files.data, { chatId });
      if (!data.items.length) {
        out[chatId] = { name, skipped: "nothing importable", ...report };
        continue;
      }
      const again = await api.chats.get(chatId, userId).catch(() => null);
      if (!again) {
        out[chatId] = { name, skipped: "chat gone" };
        continue;
      }
      if (!pristine(again.metadata?.memoryCabinetV1)) {
        out[chatId] = { name, skipped: "already has original data" };
        continue;
      }
      try {
        await host.patchMetadata(userId, chatId, { memoryCabinetV1: data });
      } catch (e) {
        out[chatId] = { name, failed: String(e?.message || e) };
        continue;
      }
      out[chatId] = { name, ...report };
    }
    const rs = Object.values(out);
    const skippedList = Object.values(out).filter((r) => r.skipped).map((r) => ({ name: r.name || "", reason: r.skipped }));
    const result = { chats: rs.filter((r) => !r.skipped && !r.failed).length, imported: rs.reduce((n, r) => n + (r.items || 0), 0), skipped: skippedList.length, failed: rs.filter((r) => r.failed).length, skippedList };
    await write(userId, MIG, { ...st, ...result.failed ? {} : { importedAt: new Date().toISOString() }, result });
    return out;
  });
  const disposers = [router.attach(api)];
  if (!has("generation"))
    log("warn", "generation \uAD8C\uD55C\uC774 \uC5C6\uC5B4 \uC790\uB3D9 \uBD84\uC11D \uD2B8\uB9AC\uAC70\uB97C \uCF24 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4 (\uC218\uB3D9 \uC0AC\uC6A9\uC740 \uAC00\uB2A5).");
  const timers = new Set;
  try {
    disposers.push(api.on("GENERATION_ENDED", (payload, userId) => {
      if (!payload || typeof payload.chatId !== "string" || !userId || payload.error)
        return;
      if (payload.generationType && payload.generationType !== "normal")
        return;
      const t = setTimeout(async () => {
        timers.delete(t);
        try {
          const rows = await hostFor(userId).messages(userId, payload.chatId, 0);
          const entry = await triggerFor(userId).onGenerationEnded(payload.chatId, rows);
          if (entry)
            api.sendToFrontend({ event: "mv-trigger", chatId: payload.chatId, id: entry.id }, userId);
        } catch (e) {
          log("warn", `trigger: ${e?.message || e}`);
        }
      }, options.afterMs ?? 1500);
      timers.add(t);
    }));
  } catch (e) {
    log("warn", `GENERATION_ENDED: ${e?.message || e}`);
  }
  const stop = () => {
    for (const t of timers)
      clearTimeout(t);
    for (const d of disposers) {
      try {
        d?.();
      } catch {}
    }
  };
  stop.router = router;
  return stop;
}
if (typeof spindle !== "undefined")
  start(spindle);
