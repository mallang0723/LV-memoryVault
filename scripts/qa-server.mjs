// QA server pieces shared by scripts/browser-qa.mjs: static files from the repo + the stand-in channel to the QA backend.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createQaEnv } from '../qa/backend-env.mjs';

const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.css': 'text/css' };
export async function createQaServer(root = process.cwd()) {
    const envs = new Map();   // one backend env per page (header x-qa-session)
    const envFor = async (id, opts) => { if (!envs.has(id)) envs.set(id, await createQaEnv(opts)); return envs.get(id); };
    const requests = [];
    const json = o => ({ status: 200, type: 'application/json', body: JSON.stringify(o) });
    async function handle({ method, pathname, session, body, search = '' }) {
        requests.push(`${method} ${pathname}`);
        if (pathname.endsWith('/__rpc')) { const env = await envFor(session); const { frame, user } = JSON.parse(body || '{}'); return json({ replies: await env.handle(frame, user) }); }
        if (pathname.endsWith('/__poll')) { const env = await envFor(session); return json({ events: env.drain(new URLSearchParams(search).get('tab') || 'default') }); }
        if (pathname.endsWith('/__turns')) { const env = await envFor(session); const q = new URLSearchParams(search); await env.turns(q.get('chat'), Number(q.get('n'))); return json({ ok: true, generate: env.f.calls.generate.length }); }
        if (pathname.endsWith('/__state')) { const env = await envFor(session); return json({ generate: env.f.calls.generate.length, chats: Object.fromEntries([...env.f.chats].map(([id, c]) => [id, c.metadata])), store: Object.fromEntries(env.f.store) }); }
        const file = path.resolve(root + decodeURIComponent(pathname));
        if (!file.startsWith(root + path.sep)) throw new Error('outside');
        return { status: 200, type: types[path.extname(file)] || 'text/plain', body: await readFile(file) };
    }
    return { handle, requests, envs, env: envFor };
}
