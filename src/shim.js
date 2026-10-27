// Frontend shim: `window.marinara` + a window.fetch that answers the original's `/api/...` calls through the Spindle channel,
// plus the one trigger handler. Everything else (UI, storage format, lorebook sync) is the pinned original's own code.
// the original's calls are /api/<chats|lorebooks|...>; Lumiverse's own API lives under /api/v1/ (plus /api/auth, /api/ws...) and must never be answered by us
const RE_API = /^(?:https?:\/\/[^/]+)?\/api\/(?!v\d+(?:\/|$)|auth(?:\/|$)|ws(?:\/|$)|spindle(?:\/|$))/;
export const isOriginalApi = u => RE_API.test(String(u));

const uid = () => { try { const c = globalThis.crypto; if (c?.randomUUID) return c.randomUUID(); } catch { /* insecure origin */ } return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`; };
function response(status, data) {
    const text = data === undefined ? '' : JSON.stringify(data);
    return { ok: status >= 200 && status < 300, status, statusText: String(status), headers: { get: () => 'application/json' }, json: async () => JSON.parse(text || 'null'), text: async () => text, clone: () => response(status, data) };
}

export function installShim(ctx, { win = globalThis.window, activeChatId = () => '', timeoutMs = 60_000, slowMs = 330_000 } = {}) {
    const pending = new Map();
    let onTrigger = null;
    const off = ctx.onBackendMessage(msg => {
        if (msg?.event === 'mv-trigger') { onTrigger?.(msg); return; }
        const p = msg && pending.get(msg.requestId);
        if (p) { pending.delete(msg.requestId); clearTimeout(p.timer); p.resolve(msg); }
    });
    const request = (method, path, body, signal) => new Promise((resolve, reject) => {
        const requestId = uid();
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('서버 응답이 없어요.')); }, /generate\/raw/.test(path) ? slowMs : timeoutMs);
        pending.set(requestId, { resolve, timer });
        signal?.addEventListener?.('abort', () => { if (pending.delete(requestId)) { clearTimeout(timer); reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })); } }, { once: true });
        try { ctx.sendToBackend({ requestId, type: 'api', method, path, body }); } catch (e) { pending.delete(requestId); clearTimeout(timer); reject(e); }
    });
    /** A trigger reaches every open tab of the user; only the tab showing that chat may ask, and only the first asker wins (backend-atomic claim). */
    onTrigger = msg => {
        if (typeof msg.chatId !== 'string' || (activeChatId() && activeChatId() !== msg.chatId)) return;
        request('POST', '_trigger/claim', { id: msg.id || `${msg.chatId}:${Date.now()}` }).then(r => {
            if (r?.ok && r.data?.ok) return win.fetch(`/api/chats/${encodeURIComponent(msg.chatId)}`);
        }).catch(() => { /* the next trigger covers it */ });
    };
    const shimFetch = async (input, init = {}) => {
        const url = typeof input === 'string' ? input : String(input?.url || input);
        const method = String(init?.method || 'GET').toUpperCase();
        let body; if (typeof init?.body === 'string' && init.body) { try { body = JSON.parse(init.body); } catch { /* none */ } }
        try {
            const r = await request(method, url, body, init?.signal);
            return r.ok ? response(200, r.data ?? null) : response(r.status >= 400 ? r.status : 400, { error: r.error });
        } catch (e) { if (e?.name === 'AbortError') throw e; return response(503, { error: e?.message || '연결 실패' }); }
    };
    // only the original's /api/ requests are ours; the host's own fetches pass through untouched
    const hostFetch = win.fetch?.bind(win);
    const baseFetch = (input, init) => (RE_API.test(typeof input === 'string' ? input : String(input?.url || '')) ? shimFetch(input, init) : hostFetch(input, init));
    win.fetch = baseFetch;   // installed BEFORE the original runs: the original wraps window.fetch on top of this (its passive observer)
    /** One `marinara` per run of the original. The original only auto-processes ITS selected chat, so storage.get pins the selection to Lumiverse's active chat. */
    function createMarinara() {
        const cleanups = [];
        const withActive = ui => { const id = activeChatId(); return id ? { ...ui, memoryCabinetUiV1: { ...(ui?.memoryCabinetUiV1 || {}), selectedChatId: id } } : ui; };
        const marinara = {
            apiFetch: (path, init) => shimFetch(`/api/${String(path).replace(/^\/?(api\/)?/, '')}`, init),
            storage: { get: () => shimFetch('/api/_storage').then(r => r.json()).then(withActive), patch: patch => shimFetch('/api/_storage', { method: 'POST', body: JSON.stringify({ patch }) }).then(r => r.json()) },
            log: { warn: (...a) => console.warn(...a), info: (...a) => console.info(...a) },
            onCleanup: fn => { cleanups.push(fn); },
        };
        return { marinara, runCleanups() { for (const f of cleanups.splice(0)) { try { f(); } catch { /* ignore */ } } } };
    }
    return { createMarinara, request, dispose() { try { off?.(); } catch { /* ignore */ } if (win.fetch === baseFetch && hostFetch) win.fetch = hostFetch; } };
}
