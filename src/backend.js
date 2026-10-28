// Backend entry: router (frontend RPC) + host adapter + the turn trigger + the 0.4.x migration routes.
import { createRouter } from './router.js';
import { createHost } from './host.js';
import { createTrigger, clampEvery, EVERY_DEFAULT, EVERY_MIN, EVERY_MAX } from './trigger.js';
import { mapOldToOriginal, buildBackup, IMPORT_LAYERS } from './migrate.js';
import manifest from '../spindle.json' with { type: 'json' };

const PERMS = ['chats', 'chat_mutation', 'generation', 'world_books', 'characters'];
const safeId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
// An existing memoryCabinetV1 is overwritten only when it is absent or still the untouched default (no items, no field beyond the basics).
// Anything else (items, lorebookId, elementMemory, ...) belongs to the original and is never replaced or merged: the chat is skipped.
const BASIC = new Set(['version', 'ownerChatId', 'enabled', 'items']);
const pristine = v => v == null || (typeof v === 'object' && !Array.isArray(v) && !(Array.isArray(v.items) && v.items.length) && Object.keys(v).every(k => BASIC.has(k)));
const fail = (message, status) => Object.assign(new Error(message), { status });

export function start(api, options = {}) {
    const ui = userId => `ui-${userId}.json`;
    const read = (userId, path, fallback) => api.userStorage.getJson(path, { fallback, userId });
    const write = (userId, path, value) => api.userStorage.setJson(path, value, { userId });
    const log = (level, m) => { try { api.log?.[level]?.(`[memory-cabinet] ${m}`); } catch { /* ignore */ } };
    const has = p => { try { return api.permissions?.has ? !!api.permissions.has(p) : true; } catch { return false; } };

    // ---- adapter settings (NOT settings.json: that file belongs to 0.4.x and is read by the backup) ----
    const everyOf = async userId => clampEvery((await read(userId, 'adapter-settings.json', {}))?.every ?? options.trigger?.every ?? EVERY_DEFAULT);
    // ---- the turn trigger. Persisted per user + chat: trigger/<chatId>.json ----
    const triggers = new Map();   // userId -> trigger (the persisted file path is per user already)
    const triggerFor = userId => {
        if (!triggers.has(userId)) triggers.set(userId, createTrigger({
            every: () => everyOf(userId), now: options.trigger?.now,
            store: { load: chatId => (safeId(chatId) ? read(userId, `trigger/${chatId}.json`, null) : null), save: (chatId, s) => (safeId(chatId) ? write(userId, `trigger/${chatId}.json`, s) : undefined) },
        }));
        return triggers.get(userId);
    };
    const hosts = new Map();
    const hostFor = userId => {
        if (!hosts.has(userId)) {
            const t = triggerFor(userId);
            hosts.set(userId, createHost(api, { summaries: { cached: id => t.cached(id), entries: id => t.entries(id) } }));
        }
        return hosts.get(userId);
    };

    const router = createRouter();
    const h = fn => ctx => fn(hostFor(ctx.userId), ctx);
    router.add('GET', 'connections', h((host, { userId }) => host.connections(userId)));
    router.add('GET', 'chats', h((host, { userId }) => host.chatsList(userId)));
    router.add('GET', 'chats/:id', h((host, { userId, params }) => host.chat(userId, params.id)));
    router.add('GET', 'chats/:id/messages', h((host, { userId, params, query }) => host.messages(userId, params.id, Number(query.limit) || 0)));
    router.add('PATCH', 'chats/:id/metadata', h((host, { userId, params, body }) => host.patchMetadata(userId, params.id, body)));
    router.add('GET', 'chats/:id/advanced-memory', () => { throw fail('고급 메모리는 이 호스트에 없습니다.', 404); });
    router.add('GET', 'characters/:id', h((host, { userId, params }) => host.character(userId, params.id)));
    router.add('GET', 'agents', () => []);
    router.add('GET', 'lorebooks', h((host, { userId, query }) => host.lorebooks(userId, query.chatId)));
    router.add('POST', 'lorebooks', h((host, { userId, body }) => host.createBook(userId, body)));
    router.add('GET', 'lorebooks/:id', h((host, { userId, params }) => host.lorebook(userId, params.id)));
    router.add('PATCH', 'lorebooks/:id', h((host, { userId, params, body }) => host.patchBook(userId, params.id, body)));
    router.add('GET', 'lorebooks/:id/entries', h((host, { userId, params }) => host.entries(userId, params.id)));
    router.add('POST', 'lorebooks/:id/entries', h((host, { userId, params, body }) => host.createEntry(userId, params.id, body)));
    router.add('PATCH', 'lorebooks/:id/entries/:entryId', h((host, { userId, params, body }) => host.patchEntry(userId, params.id, params.entryId, body)));
    router.add('POST', 'generate/raw', h(async (host, { userId, body }) => host.generate(userId, body)));
    router.add('GET', '_storage', ({ userId }) => read(userId, ui(userId), {}));                                         // marinara.storage.get
    router.add('POST', '_storage', async ({ userId, body }) => {                                                          // marinara.storage.patch
        const next = { ...(await read(userId, ui(userId), {})), ...(body?.patch || {}) };
        await write(userId, ui(userId), next);
        return next;
    });

    // ---- adapter panel: status + settings ----
    router.add('GET', '_adapter/status', async ({ userId }) => ({
        version: manifest.version, every: await everyOf(userId), everyMin: EVERY_MIN, everyMax: EVERY_MAX, everyDefault: EVERY_DEFAULT,
        permissions: Object.fromEntries(PERMS.map(p => [p, has(p)])), migrate: await migrateStatus(userId),
    }));
    router.add('POST', '_adapter/settings', async ({ userId, body }) => {
        const cur = await read(userId, 'adapter-settings.json', {});
        const next = { ...cur, every: clampEvery(body?.every ?? cur.every) };
        await write(userId, 'adapter-settings.json', next);
        return next;
    });
    // one tab wins the right to let the original observe a trigger (so two open tabs do not analyse the same turns twice)
    const claimed = new Map();   // userId + triggerId -> time (per user: another user's identical id must not block this one)
    router.add('POST', '_trigger/claim', ({ userId, body }) => {
        const raw = String(body?.id || '');
        if (!raw) return { ok: false };
        const id = `${userId}\u0000${raw}`;
        const now = Date.now();
        for (const [k, t] of claimed) if (now - t > 600_000) claimed.delete(k);
        if (claimed.has(id)) return { ok: false };
        claimed.set(id, now);
        return { ok: true };
    });

    // ---- 0.4.x data: status, backup (raw files), one-time import into the original's memoryCabinetV1 ----
    const MIG = 'migrate-state.json';
    const canList = () => typeof api.userStorage?.list === 'function';
    async function oldFiles(userId) {
        if (!canList()) throw fail('이 루미버스 버전은 저장소 목록 조회를 지원하지 않아 옛 데이터를 찾을 수 없습니다.', 501);
        const chats = {};
        const want = new Set();
        const note = f => { const m = /^\/*(?:chats\/)?([A-Za-z0-9_-]+)\/(data|auto|health)\.json$/.exec(String(f)); if (m) want.add(`${m[1]}/${m[2]}`); };
        for (const f of await api.userStorage.list('chats/', userId) || []) note(f);
        // some hosts list one level only (chat folders): look inside each folder too
        if (!want.size) for (const d of await api.userStorage.list('chats/', userId) || []) { const id = /^\/*(?:chats\/)?([A-Za-z0-9_-]+)\/?$/.exec(String(d))?.[1]; if (id) for (const f of await api.userStorage.list(`chats/${id}/`, userId) || []) note(`${id}/${String(f).split('/').pop()}`); }
        for (const k of want) { const [id, kind] = k.split('/'); (chats[id] ||= {})[kind] = await read(userId, `chats/${id}/${kind}.json`, null); }
        return chats;
    }
    async function migrateStatus(userId) {
        const state = await read(userId, MIG, {});
        let chats = 0, items = 0, importable = 0, error = null;
        if (!canList()) error = 'unsupported';
        else try {
            for (const files of Object.values(await oldFiles(userId))) {
                const list = files.data?.items || [];
                if (!list.length) continue;
                chats++; items += list.length; importable += list.filter(x => IMPORT_LAYERS.includes(x.layer)).length;
            }
        } catch (e) { error = String(e?.message || e); }
        return { oldChats: chats, oldItems: items, importable, error, backedUpAt: state.backedUpAt || null, importedAt: state.importedAt || null, dismissed: !!state.dismissed, result: state.result || null };
    }
    router.add('GET', '_migrate/status', ({ userId }) => migrateStatus(userId));
    router.add('GET', '_migrate/backup', async ({ userId }) => {
        const chats = await oldFiles(userId);
        for (const id of Object.keys(chats)) { try { const c = await api.chats.get(id, userId); if (c?.name) chats[id].name = c.name; } catch { /* chat gone: still backed up */ } }
        const settings = await read(userId, 'settings.json', null).catch(() => null);
        const st = await read(userId, MIG, {});
        await write(userId, MIG, { ...st, backedUpAt: new Date().toISOString() });
        return buildBackup({ chats, settings, version: '0.4.x' });
    });
    router.add('POST', '_migrate/dismiss', async ({ userId }) => { await write(userId, MIG, { ...(await read(userId, MIG, {})), dismissed: true }); return { ok: true }; });
    router.add('POST', '_migrate/apply', async ({ userId, body }) => {
        if (body?.confirmBackup !== true) throw fail('먼저 백업 파일을 저장했는지 확인해 주세요.', 400);
        const st = await read(userId, MIG, {});
        if (!st.backedUpAt) throw fail('백업을 한 번도 내려받지 않았습니다. 백업을 먼저 내려받으세요.', 400);
        const host = hostFor(userId), out = {};
        for (const [chatId, files] of Object.entries(await oldFiles(userId))) {
            if (!files.data?.items?.length) continue;
            const c = await api.chats.get(chatId, userId).catch(() => null);
            if (!c) { out[chatId] = { skipped: 'chat gone' }; continue; }
            const name = typeof c.name === 'string' ? c.name : '';
            if (!pristine(c.metadata?.memoryCabinetV1)) { out[chatId] = { name, skipped: 'already has original data' }; continue; }
            const { data, report } = mapOldToOriginal(files.data, { chatId });
            if (!data.items.length) { out[chatId] = { name, skipped: 'nothing importable', ...report }; continue; }
            // R4: re-read right before the write; the original may have saved its own data since the first read
            const again = await api.chats.get(chatId, userId).catch(() => null);
            if (!again) { out[chatId] = { name, skipped: 'chat gone' }; continue; }
            if (!pristine(again.metadata?.memoryCabinetV1)) { out[chatId] = { name, skipped: 'already has original data' }; continue; }
            try { await host.patchMetadata(userId, chatId, { memoryCabinetV1: data }); }
            catch (e) { out[chatId] = { name, failed: String(e?.message || e) }; continue; }
            out[chatId] = { name, ...report };
        }
        const rs = Object.values(out);
        const skippedList = Object.values(out).filter(r => r.skipped).map(r => ({ name: r.name || '', reason: r.skipped }));
        const result = { chats: rs.filter(r => !r.skipped && !r.failed).length, imported: rs.reduce((n, r) => n + (r.items || 0), 0), skipped: skippedList.length, failed: rs.filter(r => r.failed).length, skippedList };
        // a failure leaves the one-time import open so it can be retried (already-imported chats then count as skipped)
        await write(userId, MIG, { ...st, ...(result.failed ? {} : { importedAt: new Date().toISOString() }), result });
        return out;
    });

    const disposers = [router.attach(api)];
    if (!has('generation')) log('warn', 'generation 권한이 없어 자동 분석 트리거를 켤 수 없습니다 (수동 사용은 가능).');

    // every Nth user turn: synthesize an entry, then tell the frontends to let the original observe /api/chats/:id
    const timers = new Set();
    try {
        disposers.push(api.on('GENERATION_ENDED', (payload, userId) => {
            if (!payload || typeof payload.chatId !== 'string' || !userId || payload.error) return;
            if (payload.generationType && payload.generationType !== 'normal') return;
            const t = setTimeout(async () => {
                timers.delete(t);
                try {
                    const rows = await hostFor(userId).messages(userId, payload.chatId, 0);
                    const entry = await triggerFor(userId).onGenerationEnded(payload.chatId, rows);
                    if (entry) api.sendToFrontend({ event: 'mv-trigger', chatId: payload.chatId, id: entry.id }, userId);
                } catch (e) { log('warn', `trigger: ${e?.message || e}`); }   // no retry state: the next trigger covers it
            }, options.afterMs ?? 1500);
            timers.add(t);
        }));
    } catch (e) { log('warn', `GENERATION_ENDED: ${e?.message || e}`); }
    const stop = () => { for (const t of timers) clearTimeout(t); for (const d of disposers) { try { d?.(); } catch { /* ignore */ } } };
    stop.router = router;   // for the contract test
    return stop;
}
if (typeof spindle !== 'undefined') start(spindle);
