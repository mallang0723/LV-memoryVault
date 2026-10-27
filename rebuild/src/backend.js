// Backend entry: router (frontend RPC) + host adapter + the trigger counter.
import { createRouter } from './router.js';
import { createHost } from './host.js';
import { createTrigger } from './trigger.js';
import { mapOldToOriginal, buildBackup } from './migrate.js';

export function start(api, options = {}) {
    const trigger = createTrigger(options.trigger);
    const host = createHost(api, { summaries: trigger });
    const router = createRouter();
    const ui = userId => `ui-${userId}.json`;
    router.add('GET', 'connections', ({ userId }) => host.connections(userId));
    router.add('GET', 'chats', ({ userId }) => host.chatsList(userId));
    router.add('GET', 'chats/:id', ({ userId, params }) => host.chat(userId, params.id));
    router.add('GET', 'chats/:id/messages', ({ userId, params, query }) => host.messages(userId, params.id, Number(query.limit) || 0));
    router.add('PATCH', 'chats/:id/metadata', ({ userId, params, body }) => host.patchMetadata(userId, params.id, body));
    router.add('GET', 'chats/:id/advanced-memory', () => { throw Object.assign(new Error('고급 메모리는 이 호스트에 없습니다.'), { status: 404 }); });
    router.add('GET', 'characters/:id', ({ userId, params }) => host.character(userId, params.id));
    router.add('GET', 'agents', () => []);
    router.add('GET', 'lorebooks', ({ userId, query }) => host.lorebooks(userId, query.chatId));
    router.add('POST', 'lorebooks', ({ userId, body }) => host.createBook(userId, body));
    router.add('GET', 'lorebooks/:id', ({ userId, params }) => host.lorebook(userId, params.id));
    router.add('PATCH', 'lorebooks/:id', ({ userId, params, body }) => host.patchBook(userId, params.id, body));
    router.add('GET', 'lorebooks/:id/entries', ({ userId, params }) => host.entries(userId, params.id));
    router.add('POST', 'lorebooks/:id/entries', ({ userId, params, body }) => host.createEntry(userId, params.id, body));
    router.add('PATCH', 'lorebooks/:id/entries/:entryId', ({ userId, params, body }) => host.patchEntry(userId, params.id, params.entryId, body));
    router.add('POST', 'generate/raw', async ({ userId, body }) => host.generate(userId, body));
    router.add('GET', '_storage', ({ userId }) => api.userStorage.getJson(ui(userId), { fallback: {}, userId }));          // marinara.storage.get
    router.add('POST', '_storage', async ({ userId, body }) => {                                                               // marinara.storage.patch
        const cur = await api.userStorage.getJson(ui(userId), { fallback: {}, userId });
        const next = { ...cur, ...(body?.patch || {}) };
        await api.userStorage.setJson(ui(userId), next, { userId });
        return next;
    });
    // ---- 0.4.x data: backup (raw files) and one-time import into the original's memoryCabinetV1 (only chats that have no original data yet) ----
    const old = async userId => {
        const files = await api.userStorage.list('chats/', userId).catch(() => []);
        const chats = {};
        for (const f of files) { const m = /^chats\/([^/]+)\/(data|auto|health)\.json$/.exec(f); if (m) (chats[m[1]] ||= {})[m[2]] = await api.userStorage.getJson(f, { fallback: null, userId }); }
        return chats;
    };
    router.add('GET', '_migrate/backup', async ({ userId }) => buildBackup({ chats: await old(userId), settings: await api.userStorage.getJson('settings.json', { fallback: null, userId }).catch(() => null) }));
    router.add('POST', '_migrate/apply', async ({ userId }) => {
        const out = {};
        for (const [chatId, files] of Object.entries(await old(userId))) {
            if (!files.data?.items?.length) continue;
            const c = await api.chats.get(chatId, userId).catch(() => null);
            if (!c) { out[chatId] = { skipped: 'chat gone' }; continue; }
            if (c.metadata?.memoryCabinetV1?.items?.length) { out[chatId] = { skipped: 'already has original data' }; continue; }
            const { data, report } = mapOldToOriginal(files.data, { chatId });
            await host.patchMetadata(userId, chatId, { memoryCabinetV1: data });
            out[chatId] = report;
        }
        return out;
    });
    const disposers = [router.attach(api)];

    // every Nth user turn: synthesize an entry, then tell the frontend to let the original observe /api/chats/:id
    const timers = new Set();
    try {
        disposers.push(api.on('GENERATION_ENDED', (payload, userId) => {
            if (!payload || typeof payload.chatId !== 'string' || !userId || payload.error) return;
            if (payload.generationType && payload.generationType !== 'normal') return;
            const t = setTimeout(async () => {
                timers.delete(t);
                try {
                    const rows = await host.messages(userId, payload.chatId, 0);
                    if (trigger.onGenerationEnded(payload.chatId, rows)) api.sendToFrontend({ event: 'mv-trigger', chatId: payload.chatId }, userId);
                } catch (e) { api.log?.warn?.(`[memory-cabinet] trigger: ${e?.message || e}`); }   // no retry state: the next trigger covers it
            }, options.afterMs ?? 1500);
            timers.add(t);
        }));
    } catch (e) { api.log?.warn?.(`[memory-cabinet] GENERATION_ENDED: ${e?.message || e}`); }
    return () => { for (const t of timers) clearTimeout(t); for (const d of disposers) { try { d?.(); } catch { /* ignore */ } } };
}
if (typeof spindle !== 'undefined') start(spindle);
