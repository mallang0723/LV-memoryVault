// Fake Spindle host + in-process channel between a backend `api` and a frontend `ctx`.
export function createFakeHost({ modelReply = '[]' } = {}) {
    const chat = { id: 'chat1', character_id: 'char1', name: '테스트 RP', metadata: {}, created_at: 1700000000, updated_at: 1700000000 };
    const messages = [];
    const books = new Map(), entries = new Map(), store = new Map();
    let seq = 0;
    const handlers = { on: {}, frontend: null };
    const toFront = [];
    let frontListener = null;
    const calls = { generate: [], chatsUpdate: [] };
    const page = (list, o = {}) => ({ data: list.slice(o.offset || 0, (o.offset || 0) + (o.limit || 200)), total: list.length });
    const api = {
        permissions: { has: () => true },
        log: { info() {}, warn() {} },
        on(ev, fn) { handlers.on[ev] = fn; return () => delete handlers.on[ev]; },
        onFrontendMessage(fn) { handlers.frontend = fn; return () => { handlers.frontend = null; }; },
        sendToFrontend(msg) { toFront.push(msg); queueMicrotask(() => frontListener?.(msg)); },
        chats: {
            list: async o => page([chat], o),
            get: async id => (id === chat.id ? structuredClone(chat) : null),
            update: async (id, input) => { calls.chatsUpdate.push(structuredClone(input)); if (input.metadata) chat.metadata = structuredClone(input.metadata); if (input.name) chat.name = input.name; return structuredClone(chat); },
        },
        chat: { getMessages: async () => structuredClone(messages) },
        characters: { get: async id => ({ id, name: id === 'char1' ? '하나' : id }) },
        connections: { list: async () => [{ id: 'conn1', name: 'Mock', provider: 'openai', model: 'mock-1', is_default: true }] },
        generate: { quiet: async req => { calls.generate.push(req); return { content: typeof modelReply === 'function' ? modelReply(req) : modelReply }; } },
        userStorage: {
            getJson: async (p, o) => (store.has(p) ? structuredClone(store.get(p)) : o?.fallback),
            setJson: async (p, v) => { store.set(p, structuredClone(v)); },
            list: async prefix => [...store.keys()].filter(k => k.startsWith(prefix || '')),
        },
        world_books: {
            list: async o => page([...books.values()], o),
            get: async id => (books.has(id) ? structuredClone(books.get(id)) : null),
            create: async input => { const b = { id: `book${++seq}`, name: '', description: '', metadata: {}, created_at: 1, updated_at: 1, ...input }; books.set(b.id, b); entries.set(b.id, []); return structuredClone(b); },
            update: async (id, input) => { const b = Object.assign(books.get(id), input); return structuredClone(b); },
            entries: {
                list: async (bid, o) => page(entries.get(bid) || [], o),
                get: async eid => { for (const l of entries.values()) { const e = l.find(x => x.id === eid); if (e) return structuredClone(e); } return null; },
                create: async (bid, input) => { const e = { id: `ent${++seq}`, world_book_id: bid, key: [], keysecondary: [], content: '', comment: '', disabled: false, constant: false, extensions: {}, ...input }; entries.get(bid).push(e); return structuredClone(e); },
                update: async (eid, input) => { for (const l of entries.values()) { const e = l.find(x => x.id === eid); if (e) { Object.assign(e, input); return structuredClone(e); } } throw new Error('no entry'); },
            },
        },
    };
    const ctx = {
        onBackendMessage(fn) { frontListener = fn; return () => { frontListener = null; }; },
        sendToBackend(payload) { handlers.frontend?.(payload, 'user1'); },
        getActiveChat: () => ({ chatId: 'chat1' }),
        events: { on: () => () => {} },
    };
    // backend replies go through sendToFrontend(msg, userId, opts): same queue
    const addTurns = n => { for (let i = 0; i < n; i++) { const base = messages.length; messages.push({ id: `m${base}`, index_in_chat: base, is_user: true, role: 'user', name: '나', content: `사용자 발화 ${base}` , send_date: 1700000000 + base }); messages.push({ id: `m${base + 1}`, index_in_chat: base + 1, is_user: false, role: 'assistant', name: '하나', content: `하나의 답 ${base + 1}: 한강에서 만나기로 약속했다`, send_date: 1700000000 + base + 1 }); } };
    return { api, ctx, chat, messages, books, entries, store, calls, handlers, toFront, addTurns };
}
