// Host adapter: Marinara-shaped requests (what the pinned original sends to /api/...) -> Lumiverse Spindle API.
// Spike scope: chats, messages, connections, generate, characters, world books (+ metadata translation).
const PAGE = 200;
const NS = 'memory_cabinet';
const iso = t => { const n = Number(t); if (!Number.isFinite(n) || n <= 0) return null; return new Date(n < 1e12 ? n * 1000 : n).toISOString(); };
const err = (m, status) => Object.assign(new Error(m), { status });

export function createHost(api, { summaries } = {}) {
    const need = u => { if (typeof u !== 'string' || !u) throw err('userId required', 401); return u; };
    async function pages(userId, fn) {
        const out = [];
        for (let offset = 0; ; offset += PAGE) {
            const res = await fn({ limit: PAGE, offset, userId });
            const data = Array.isArray(res) ? res : res?.data || [];
            out.push(...data);
            if (Array.isArray(res) || data.length < PAGE || (res.total != null && out.length >= res.total)) break;
        }
        return out;
    }

    // ---- chats: Lumiverse chat -> Marinara chat (metadata.activeLorebookIds <-> chat_world_book_ids, branch keys, summaryEntries) ----
    const shapeChat = (c, extra = null) => {
        const m = c.metadata && typeof c.metadata === 'object' ? c.metadata : {};
        const metadata = { ...m, activeLorebookIds: Array.isArray(m.chat_world_book_ids) ? m.chat_world_book_ids : [] };
        if (typeof m.branched_from === 'string') metadata.branchParentChatId = m.branched_from;
        const entries = extra || summaries?.cached(c.id) || [];
        if (entries.length) metadata.summaryEntries = entries;
        const ids = Array.isArray(m.character_ids) && m.character_ids.length ? m.character_ids : c.character_id ? [c.character_id] : [];
        return { id: c.id, name: c.name || '', mode: 'roleplay', characterIds: ids, metadata, createdAt: iso(c.created_at), updatedAt: iso(c.updated_at), lastMessageAt: iso(c.updated_at) };
    };
    const chatsList = async u => (await pages(need(u), o => api.chats.list(o))).map(shapeChat);
    async function chat(u, id) { const c = await api.chats.get(id, need(u)); if (!c) throw err('채팅을 찾지 못했습니다.', 404); return shapeChat(c, summaries ? await summaries.entries(id) : null); }
    // Spindle has no atomic metadata merge: chats.update REPLACES metadata. So (1) our own writes to one chat are queued, (2) the chat is
    // re-read right before each write (no work between read and write), (3) the write is verified and redone if the host clobbered it.
    // What stays open: a host background write landing between our read and our write can still be lost (milliseconds wide).
    const queues = new Map();
    const queued = (id, fn) => { const run = (queues.get(id) || Promise.resolve()).catch(() => {}).then(fn); queues.set(id, run); run.catch(() => {}).finally(() => { if (queues.get(id) === run) queues.delete(id); }); return run; };
    const stable = v => (Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v);
    const same = (a, b) => JSON.stringify(stable(a ?? null)) === JSON.stringify(stable(b ?? null));
    function applyPatch(base, patch) {
        const next = { ...(base || {}) }, touched = {};
        for (const [k, v] of Object.entries(patch || {})) {
            if (k === 'summaryEntries' || k === 'branchParentChatId') continue;   // derived, never persisted
            const key = k === 'activeLorebookIds' ? 'chat_world_book_ids' : k;
            next[key] = k === 'activeLorebookIds' ? (Array.isArray(v) ? v.map(String) : []) : v;
            touched[key] = next[key];
        }
        return { next, touched };
    }
    /** PATCH chats/:id/metadata. */
    function patchMetadata(u, id, patch, { attempts = 3 } = {}) {
        need(u);
        return queued(id, async () => {
            for (let i = 0; i < attempts; i++) {
                const c = await api.chats.get(id, u);   // read immediately before the write
                if (!c) throw err('채팅을 찾지 못했습니다.', 404);
                const { next, touched } = applyPatch(c.metadata, patch);
                const c2 = await api.chats.update(id, { metadata: next }, u);
                void c2;
                const back = await api.chats.get(id, u);   // what is stored now, not what update() echoed
                if (back && Object.keys(touched).every(k => same(back.metadata?.[k], touched[k]))) return shapeChat(back);
            }
            throw err('채팅 메타데이터를 저장하지 못했습니다(호스트가 같은 시각에 덮어썼습니다). 다시 시도해 주세요.', 409);
        });
    }
    async function messages(u, id, limit) {
        if (!(await api.chats.get(id, need(u)))) throw err('채팅을 찾지 못했습니다.', 404);   // api.chat.getMessages has no user scope: check ownership first
        const rows = await api.chat.getMessages(id);
        const all = (rows || []).map(m => ({ id: m.id, role: m.role === 'system' ? 'system' : m.is_user ? 'user' : 'assistant', content: m.content || '', name: m.name || '', createdAt: iso(m.created_at || m.send_date), number: (m.index_in_chat ?? 0) + 1, extra: { hidden: m.extra?.hidden === true } })).sort((a, b) => a.number - b.number);
        return limit ? all.slice(-Math.max(1, Math.min(500, limit))) : all;
    }
    const connections = async u => (await api.connections.list(need(u)) || []).map(c => ({ id: c.id, name: c.name, provider: c.provider, model: c.model, isDefault: !!c.is_default }));
    async function character(u, id) { const c = await api.characters.get(id, need(u)); if (!c) throw err('캐릭터를 찾지 못했습니다.', 404); return c; }
    async function generate(u, { connectionId, messages: msgs, parameters = {}, signal }) {
        const p = {};
        if (parameters.maxTokens != null) p.max_tokens = parameters.maxTokens;
        if (parameters.temperature != null) p.temperature = parameters.temperature;
        const r = await api.generate.quiet({ messages: msgs, ...(connectionId ? { connection_id: connectionId } : {}), parameters: p, signal, userId: need(u) });
        return { content: typeof r === 'string' ? r : r?.content || '' };
    }

    // ---- world books ----
    // Marinara book fields without a Lumiverse column (tags, chatId, scope, isGlobal, scanDepth...) ride in book.metadata[NS].
    const shapeBook = b => { const mine = b.metadata?.[NS] || {}; return { id: b.id, name: b.name, description: b.description || '', tags: mine.tags || [], chatId: mine.chatId || null, scope: mine.scope || null, isGlobal: false, enabled: true, category: 'uncategorized', createdAt: iso(b.created_at), updatedAt: iso(b.updated_at) }; };
    const bookMeta = (f, prev = {}) => ({ ...prev, [NS]: { ...(prev[NS] || {}), ...(f.tags ? { tags: f.tags } : {}), ...(f.chatId !== undefined ? { chatId: f.chatId } : {}), ...(f.scope ? { scope: f.scope } : {}) } });
    /** `GET lorebooks?chatId=` = books attached to that chat (Marinara returns what is active for it); plain GET = all. */
    async function lorebooks(u, chatId) {
        const all = (await pages(need(u), o => api.world_books.list(o))).map(shapeBook);
        if (!chatId) return all;
        const c = await api.chats.get(chatId, u);
        const ids = new Set(c?.metadata?.chat_world_book_ids || []);
        return all.filter(b => ids.has(b.id) || b.chatId === chatId);
    }
    async function lorebook(u, id) { const b = await api.world_books.get(id, need(u)); if (!b) throw err('로어북을 찾지 못했습니다.', 404); return shapeBook(b); }
    const createBook = async (u, f) => shapeBook(await api.world_books.create({ name: String(f.name || '기억 보관함'), description: String(f.description || ''), metadata: bookMeta(f) }, need(u)));
    async function patchBook(u, id, f) {
        const prev = await api.world_books.get(id, need(u));
        if (!prev) throw err('로어북을 찾지 못했습니다.', 404);
        return shapeBook(await api.world_books.update(id, { ...(f.name !== undefined ? { name: String(f.name) } : {}), ...(f.description !== undefined ? { description: String(f.description) } : {}), metadata: bookMeta(f, prev.metadata || {}) }, u));
    }
    const DIRECT = { name: 'comment', content: 'content', keys: 'key', secondaryKeys: 'keysecondary', constant: 'constant', selective: 'selective', matchWholeWords: 'match_whole_words', caseSensitive: 'case_sensitive', useRegex: 'use_regex', position: 'position', depth: 'depth', order: 'order_value', role: 'role', preventRecursion: 'prevent_recursion', excludeRecursion: 'exclude_recursion', delayUntilRecursion: 'delay_until_recursion', scanDepth: 'scan_depth' };
    const EXT_KEYS = ['description', 'tag', 'dynamicState', 'locked', 'characterFilterMode', 'characterFilterIds', 'excludeFromVectorization'];
    const knownByWrap = (content, names) => names.map(n => `{{if::{{char}}==${n}}}${content}{{/if}}`).join('');
    /** Marinara entry payload -> Lumiverse create/update fields. knownBy (characterFilter include) becomes {{if}} name guards (lossy, see report). */
    function toEntry(f, nameOf = id => id) {
        const out = {}, ext = {};
        for (const [k, col] of Object.entries(DIRECT)) if (f[k] !== undefined && f[k] !== null) out[col] = k === 'keys' || k === 'secondaryKeys' ? f[k].map(String) : f[k];
        if (f.enabled !== undefined) out.disabled = !f.enabled;
        if (f.probability != null) { out.probability = Number(f.probability); out.use_probability = true; }
        for (const k of EXT_KEYS) if (f[k] !== undefined) ext[k] = f[k];
        if (f.characterFilterMode === 'include' && Array.isArray(f.characterFilterIds) && f.characterFilterIds.length && typeof f.content === 'string') {
            out.content = knownByWrap(f.content, f.characterFilterIds.map(nameOf));
            ext.rawContent = f.content;
        }
        return { fields: out, ext };
    }
    const shapeEntry = (e, bookId) => { const m = e.extensions?.[NS] || {}; return { id: e.id, lorebookId: bookId, name: e.comment || '', content: m.rawContent ?? e.content ?? '', keys: e.key || [], secondaryKeys: e.keysecondary || [], enabled: !e.disabled, constant: !!e.constant, selective: !!e.selective, order: e.order_value, position: e.position, depth: e.depth, role: e.role, description: m.description || '', tag: m.tag || '', dynamicState: m.dynamicState || {}, locked: !!m.locked, characterFilterMode: m.characterFilterMode || 'any', characterFilterIds: m.characterFilterIds || [] }; };
    const entries = async (u, bookId) => (await pages(need(u), o => api.world_books.entries.list(bookId, o))).map(e => shapeEntry(e, bookId));
    async function nameResolver(u, ids) {
        const m = new Map();
        for (const id of new Set(ids || [])) { try { m.set(id, (await api.characters.get(id, u))?.name || id); } catch { m.set(id, id); } }
        return id => m.get(id) || id;
    }
    async function createEntry(u, bookId, f) {
        const { fields, ext } = toEntry(f, await nameResolver(need(u), f.characterFilterIds));
        return shapeEntry(await api.world_books.entries.create(bookId, { ...fields, extensions: { [NS]: ext } }, u), bookId);
    }
    async function patchEntry(u, bookId, entryId, f) {
        const { fields, ext } = toEntry(f, await nameResolver(need(u), f.characterFilterIds));
        const prevAll = (await api.world_books.entries.get(entryId, u))?.extensions || {};   // keep other extensions' keys
        return shapeEntry(await api.world_books.entries.update(entryId, { ...fields, extensions: { ...prevAll, [NS]: { ...(prevAll[NS] || {}), ...ext } } }, u), bookId);
    }
    return { chatsList, chat, patchMetadata, messages, connections, character, generate, lorebooks, lorebook, createBook, patchBook, entries, createEntry, patchEntry };
}
