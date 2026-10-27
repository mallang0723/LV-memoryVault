// The whole auto-run adapter: every N user turns synthesize ONE summaryEntry (the raw text of those turns) that the original's own
// passive observer (fetch of /api/chats/:id -> metadata.summaryEntries) sees as "a new summary" and analyses.
// No receipts / pause / backoff: if the original's analysis fails, the next trigger sends the accumulated entries again.
// State per chat is persisted (userStorage via `store`) so a restart does not lose the turn count or the entries.
export const EVERY_DEFAULT = 10, EVERY_MIN = 3, EVERY_MAX = 100;
const KEEP = 5, MAX_CHARS = 120_000;
export const clampEvery = v => { const n = Math.trunc(Number(v)); return Number.isFinite(n) ? Math.min(EVERY_MAX, Math.max(EVERY_MIN, n)) : EVERY_DEFAULT; };

/** store: { load(chatId) -> Promise<state|null>, save(chatId, state) -> Promise }. every: number | () => number | Promise. */
export function createTrigger({ every = EVERY_DEFAULT, store = null, now = () => new Date().toISOString() } = {}) {
    const cache = new Map();   // chatId -> { lastUsers, from, entries[] }
    const chains = new Map();  // chatId -> promise tail (turns of one chat are processed one at a time)
    const getEvery = async () => clampEvery(typeof every === 'function' ? await every() : every);
    const valid = s => s && Number.isFinite(s.lastUsers) && Number.isFinite(s.from) && Array.isArray(s.entries);
    async function stateOf(chatId) {
        if (cache.has(chatId)) return cache.get(chatId);
        let s = null; try { s = store ? await store.load(chatId) : null; } catch { /* unreadable: baseline again */ }
        if (!valid(s)) s = null;
        if (s) cache.set(chatId, s);
        return s;
    }
    const persist = async (chatId, s) => { cache.set(chatId, s); try { await store?.save(chatId, s); } catch { /* next turn saves again */ } };
    async function step(chatId, rows) {
        const users = rows.filter(r => r.role === 'user').length, last = rows.at(-1)?.number ?? 0;
        let s = await stateOf(chatId);
        if (!s) { await persist(chatId, { lastUsers: users, from: last + 1, entries: [] }); return null; }   // first sight: baseline only
        if (users < s.lastUsers) { s = { ...s, lastUsers: users, from: Math.min(s.from, last + 1) }; await persist(chatId, s); return null; }   // messages deleted / rolled back
        if (users - s.lastUsers < await getEvery()) return null;
        const slice = rows.filter(r => r.number >= s.from && r.role !== 'system' && !r.extra?.hidden && String(r.content || '').trim());
        const next = { lastUsers: users, from: last + 1, entries: s.entries };
        if (!slice.length) { await persist(chatId, next); return null; }
        let content = slice.map(r => `${r.role === 'user' ? '[사용자]' : `[${r.name || '캐릭터'}]`} ${r.content}`).join('\n\n');
        if (content.length > MAX_CHARS) content = content.slice(content.length - MAX_CHARS);   // keep the newest text
        const turns = slice.filter(r => r.role === 'user').length;
        const entry = { id: `mv-${chatId.slice(0, 8)}-${slice[0].number}-${slice.at(-1).number}`, title: `최근 ${turns}턴 대화 (#${slice[0].number}–#${slice.at(-1).number})`, content, enabled: true, origin: 'memory-cabinet-adapter', createdAt: now(), updatedAt: now() };
        next.entries = [...s.entries.filter(e => e.id !== entry.id), entry].slice(-KEEP);
        await persist(chatId, next);
        return entry;
    }
    return {
        /** entries synthesized so far, from memory only (cheap; used for chat lists) */
        cached: chatId => cache.get(chatId)?.entries || [],
        /** entries for one chat, loading the persisted state if needed */
        async entries(chatId) { return (await stateOf(chatId))?.entries || []; },
        /** rows: [{number, role, name, content, extra}] oldest first. Resolves to the new entry, or null (baseline / not yet N turns). */
        onGenerationEnded(chatId, rows) {
            const run = (chains.get(chatId) || Promise.resolve()).catch(() => {}).then(() => step(chatId, rows));
            chains.set(chatId, run);
            run.catch(() => {}).finally(() => { if (chains.get(chatId) === run) chains.delete(chatId); });
            return run;
        },
    };
}
