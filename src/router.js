// Path router for the frontend <-> backend channel. The two original screens talk to a REST API
// ("GET chats/:id/messages?limit=8"); here the same strings are routed to handlers in the backend worker.
//
// Frame (frontend -> backend):  { requestId, type: 'api', method, path, body }
// Reply (backend -> frontend):  { requestId, ok: true, data } | { requestId, ok: false, error, code?, status? }
// The host passes the user id as the 2nd argument of onFrontendMessage (types/spindle-api.d.ts:1540); the router puts it
// into every handler call. A frame without a user id is refused (operator-scoped install, AGENTS 2).

export function normalizePath(path) {
    const [pure, query = ''] = String(path || '').split('?');
    const clean = pure.replace(/^\/?api\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
    const q = {};
    for (const [k, v] of new URLSearchParams(query)) q[k] = v;
    return { path: clean, query: q };
}

export function createRouter() {
    const routes = [];
    const compile = pattern => pattern.split('/').filter(Boolean);
    function add(method, pattern, handler) {
        routes.push({ method: method.toUpperCase(), parts: compile(pattern), pattern, handler });
        return api;
    }
    function match(method, path) {
        const segs = path.split('/').filter(Boolean);
        let best = null;
        for (const r of routes) {
            if (r.method !== method || r.parts.length !== segs.length) continue;
            const params = {};
            let literal = 0, ok = true;
            r.parts.forEach((p, i) => {
                if (p.startsWith(':')) { try { params[p.slice(1)] = decodeURIComponent(segs[i]); } catch { ok = false; } } else if (p === segs[i]) literal++; else ok = false;
            });
            if (ok && (!best || literal > best.literal)) best = { route: r, params, literal };
        }
        return best;
    }
    async function handle({ method = 'GET', path = '', body } = {}, userId) {
        if (typeof userId !== 'string' || !userId) throw Object.assign(new Error('userId required'), { status: 401 });
        const norm = normalizePath(path);
        const m = match(String(method).toUpperCase(), norm.path);
        if (!m) throw Object.assign(new Error(`길을 찾지 못했습니다 (${method} ${norm.path})`), { status: 404 });
        return m.route.handler({ userId, params: m.params, query: norm.query, body: body ?? {}, path: norm.path });
    }
    /** Wires the router to Spindle's frontend channel. Returns a disposer. */
    function attach(spindle) {
        return spindle.onFrontendMessage(async (payload, userId, frontendSessionId) => {
            if (!payload || typeof payload.requestId !== 'string' || payload.type !== 'api') return;
            let reply;
            try {
                reply = { ok: true, data: await handle(payload, userId) };
            } catch (error) {
                reply = { ok: false, error: String(error?.message || error), ...(error?.code ? { code: error.code } : {}), ...(error?.status ? { status: error.status } : {}) };
            }
            try { spindle.sendToFrontend({ ...reply, requestId: payload.requestId }, userId, frontendSessionId ? { frontendSessionId } : undefined); } catch { /* frontend gone */ }
        });
    }
    const api = { add, handle, attach, match, list: () => routes.map(r => `${r.method} ${r.pattern}`) };
    return api;
}
