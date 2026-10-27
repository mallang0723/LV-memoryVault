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
  const shapeChat = (c) => {
    const m = c.metadata && typeof c.metadata === "object" ? c.metadata : {};
    const metadata = { ...m, activeLorebookIds: Array.isArray(m.chat_world_book_ids) ? m.chat_world_book_ids : [] };
    if (typeof m.branched_from === "string")
      metadata.branchParentChatId = m.branched_from;
    const entries = summaries?.entries(c.id) || [];
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
    return shapeChat(c);
  }
  async function patchMetadata(u, id, patch) {
    const c = await api.chats.get(id, need(u));
    if (!c)
      throw err("\uCC44\uD305\uC744 \uCC3E\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4.", 404);
    const next = { ...c.metadata || {} };
    for (const [k, v] of Object.entries(patch || {})) {
      if (k === "activeLorebookIds")
        next.chat_world_book_ids = Array.isArray(v) ? v.map(String) : [];
      else if (k === "summaryEntries" || k === "branchParentChatId")
        continue;
      else
        next[k] = v;
    }
    const c2 = await api.chats.update(id, { metadata: next }, u);
    return shapeChat(c2);
  }
  async function messages(u, id, limit) {
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
var MAX_ENTRIES = 40;
function createTrigger({ every = EVERY_DEFAULT, now = () => new Date().toISOString() } = {}) {
  const entriesByChat = new Map;
  const state = new Map;
  return {
    entries: (chatId) => entriesByChat.get(chatId) || [],
    onGenerationEnded(chatId, rows) {
      const users = rows.filter((r) => r.role === "user").length;
      const bucket = Math.floor(users / every);
      const st = state.get(chatId);
      if (!st) {
        state.set(chatId, { bucket, from: (rows.at(-1)?.number ?? 0) + 1 });
        return null;
      }
      if (bucket <= st.bucket) {
        st.bucket = Math.min(st.bucket, bucket);
        return null;
      }
      const slice = rows.filter((r) => r.number >= st.from && r.role !== "system");
      st.bucket = bucket;
      st.from = (rows.at(-1)?.number ?? 0) + 1;
      if (!slice.length)
        return null;
      const content = slice.map((r) => `${r.role === "user" ? "[\uC0AC\uC6A9\uC790]" : `[${r.name || "\uCE90\uB9AD\uD130"}]`} ${r.content}`).join(`

`);
      const entry = { id: `mv-${chatId.slice(0, 8)}-${slice[0].number}-${slice.at(-1).number}`, title: `\uCD5C\uADFC ${users - (bucket - 1) * every}\uD134 \uB300\uD654 (#${slice[0].number}\u2013#${slice.at(-1).number})`, content, enabled: true, origin: "memory-cabinet-adapter", createdAt: now(), updatedAt: now() };
      const list = entriesByChat.get(chatId) || [];
      list.push(entry);
      entriesByChat.set(chatId, list.slice(-MAX_ENTRIES));
      return entry;
    }
  };
}

// src/migrate.js
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
  const items = (old?.items || []).map((x) => mapItem(x, now));
  const held = items.filter((i) => i.type === "promise" ? i.status === "hold" : !i.active && !i.archived).length;
  return {
    data: { version: 1, ownerChatId: chatId, enabled: true, items },
    report: {
      items: items.length,
      held,
      candidatesDropped: (old?.candidates || []).length,
      undoDropped: (old?.undo || []).length,
      lostFields: ["revision", "undo", "candidates (re-run analysis)", "evidence.index/fingerprint", "audience", "condition", "importedScope", "branchHold", "review", "resumeRequired", "layer (elements/scenes/flows/wiki become anchors with a title tag)"]
    }
  };
}
function buildBackup({ chats, settings = null, version = "0.4.x", now = new Date().toISOString() }) {
  return { format: "memory-cabinet-lv-backup", formatVersion: 1, createdAt: now, extensionVersion: version, settings, chats };
}

// src/backend.js
function start(api, options = {}) {
  const trigger = createTrigger(options.trigger);
  const host = createHost(api, { summaries: trigger });
  const router = createRouter();
  const ui = (userId) => `ui-${userId}.json`;
  router.add("GET", "connections", ({ userId }) => host.connections(userId));
  router.add("GET", "chats", ({ userId }) => host.chatsList(userId));
  router.add("GET", "chats/:id", ({ userId, params }) => host.chat(userId, params.id));
  router.add("GET", "chats/:id/messages", ({ userId, params, query }) => host.messages(userId, params.id, Number(query.limit) || 0));
  router.add("PATCH", "chats/:id/metadata", ({ userId, params, body }) => host.patchMetadata(userId, params.id, body));
  router.add("GET", "chats/:id/advanced-memory", () => {
    throw Object.assign(new Error("\uACE0\uAE09 \uBA54\uBAA8\uB9AC\uB294 \uC774 \uD638\uC2A4\uD2B8\uC5D0 \uC5C6\uC2B5\uB2C8\uB2E4."), { status: 404 });
  });
  router.add("GET", "characters/:id", ({ userId, params }) => host.character(userId, params.id));
  router.add("GET", "agents", () => []);
  router.add("GET", "lorebooks", ({ userId, query }) => host.lorebooks(userId, query.chatId));
  router.add("POST", "lorebooks", ({ userId, body }) => host.createBook(userId, body));
  router.add("GET", "lorebooks/:id", ({ userId, params }) => host.lorebook(userId, params.id));
  router.add("PATCH", "lorebooks/:id", ({ userId, params, body }) => host.patchBook(userId, params.id, body));
  router.add("GET", "lorebooks/:id/entries", ({ userId, params }) => host.entries(userId, params.id));
  router.add("POST", "lorebooks/:id/entries", ({ userId, params, body }) => host.createEntry(userId, params.id, body));
  router.add("PATCH", "lorebooks/:id/entries/:entryId", ({ userId, params, body }) => host.patchEntry(userId, params.id, params.entryId, body));
  router.add("POST", "generate/raw", async ({ userId, body }) => host.generate(userId, body));
  router.add("GET", "_storage", ({ userId }) => api.userStorage.getJson(ui(userId), { fallback: {}, userId }));
  router.add("POST", "_storage", async ({ userId, body }) => {
    const cur = await api.userStorage.getJson(ui(userId), { fallback: {}, userId });
    const next = { ...cur, ...body?.patch || {} };
    await api.userStorage.setJson(ui(userId), next, { userId });
    return next;
  });
  const old = async (userId) => {
    const files = await api.userStorage.list("chats/", userId).catch(() => []);
    const chats = {};
    for (const f of files) {
      const m = /^chats\/([^/]+)\/(data|auto|health)\.json$/.exec(f);
      if (m)
        (chats[m[1]] ||= {})[m[2]] = await api.userStorage.getJson(f, { fallback: null, userId });
    }
    return chats;
  };
  router.add("GET", "_migrate/backup", async ({ userId }) => buildBackup({ chats: await old(userId), settings: await api.userStorage.getJson("settings.json", { fallback: null, userId }).catch(() => null) }));
  router.add("POST", "_migrate/apply", async ({ userId }) => {
    const out = {};
    for (const [chatId, files] of Object.entries(await old(userId))) {
      if (!files.data?.items?.length)
        continue;
      const c = await api.chats.get(chatId, userId).catch(() => null);
      if (!c) {
        out[chatId] = { skipped: "chat gone" };
        continue;
      }
      if (c.metadata?.memoryCabinetV1?.items?.length) {
        out[chatId] = { skipped: "already has original data" };
        continue;
      }
      const { data, report } = mapOldToOriginal(files.data, { chatId });
      await host.patchMetadata(userId, chatId, { memoryCabinetV1: data });
      out[chatId] = report;
    }
    return out;
  });
  const disposers = [router.attach(api)];
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
          const rows = await host.messages(userId, payload.chatId, 0);
          if (trigger.onGenerationEnded(payload.chatId, rows))
            api.sendToFrontend({ event: "mv-trigger", chatId: payload.chatId }, userId);
        } catch (e) {
          api.log?.warn?.(`[memory-cabinet] trigger: ${e?.message || e}`);
        }
      }, options.afterMs ?? 1500);
      timers.add(t);
    }));
  } catch (e) {
    api.log?.warn?.(`[memory-cabinet] GENERATION_ENDED: ${e?.message || e}`);
  }
  return () => {
    for (const t of timers)
      clearTimeout(t);
    for (const d of disposers) {
      try {
        d?.();
      } catch {}
    }
  };
}
if (typeof spindle !== "undefined")
  start(spindle);
