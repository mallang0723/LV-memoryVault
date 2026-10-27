// Spike goal 1: the pinned original (unmodified) runs its own analysis -> approve -> lorebook write when the adapter's thin trigger fires.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createFakeHost } from './fake-host.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(25); } throw new Error('timeout: ' + fn); }

async function boot(host) {
    const { document } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    const ls = new Map();
    const window = { document, setTimeout, clearTimeout, setInterval, clearInterval, location: { origin: 'http://localhost' }, addEventListener() {}, removeEventListener() {},
        localStorage: { getItem: k => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) },
        fetch: async () => { throw new Error('network is not available in the test'); } };   // the host's own fetch: /api/ calls must never reach it
    Object.assign(globalThis, { window, document, localStorage: window.localStorage });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, get: () => window.fetch, set: v => { window.fetch = v; } });
    const { start } = await import('../src/backend.js?' + Math.random());
    const { setup } = await import('../src/frontend.js?' + Math.random());
    const stopBackend = start(host.api, { afterMs: 0, trigger: { every: 10 } });
    const stopFront = setup(host.ctx, { win: window, doc: document });
    return { window, document, stop() { stopFront(); stopBackend(); } };
}
const REPLY = JSON.stringify([{ action: 'add', type: 'promise', title: '한강에서 만나기', content: '하나와 사용자는 한강에서 만나기로 약속했다', priority: 'high' }, { action: 'add', type: 'anchor', title: '한강 약속 장소', content: '약속 장소는 한강이다', category: 'event', activation: 'always', lifespan: 'permanent' }]);

for (const mode of ['auto_apply', 'auto_review']) {
    test(`trigger -> original analyses (${mode})`, async () => {
        const host = createFakeHost({ modelReply: REPLY });
        host.addTurns(2);   // 4 messages before the first sight (baseline)
        host.store.set('ui-user1.json', { memoryCabinetUiV1: { summaryUpdateMode: mode, selectedChatId: 'chat1', modelConnectionId: 'conn1' } });
        const env = await boot(host);
        try {
            await sleep(1500);   // original primes itself 900 ms after load (baseline of known summaries)
            await host.handlers.on.GENERATION_ENDED({ chatId: 'chat1', generationType: 'normal' }, 'user1');   // backend baseline
            await sleep(100);
            assert.equal(host.calls.generate.length, 0, 'no model call before N turns');
            host.addTurns(10);
            await host.handlers.on.GENERATION_ENDED({ chatId: 'chat1', generationType: 'normal' }, 'user1');
            await until(() => host.toFront.some(m => m.event === 'mv-trigger'));
            await until(() => host.calls.generate.length > 0);
            const req = host.calls.generate[0];
            assert.equal(req.connection_id, 'conn1');
            assert.match(JSON.stringify(req.messages), /한강에서 만나기로 약속했다/, 'the original sent our synthesized summary as its analysis source');
            if (mode === 'auto_apply') {
                await until(() => [...host.books.values()].length > 0 && [...host.entries.values()].flat().length >= 2);
                const [book] = [...host.books.values()];
                assert.match(book.description, /MEMORY_CABINET/);
                const ents = [...host.entries.values()].flat();
                assert.ok(ents.some(e => /한강/.test(e.content)), 'approved candidate written as lorebook entry');
                assert.ok(host.chat.metadata.chat_world_book_ids.includes(book.id), 'book attached to chat (activeLorebookIds -> chat_world_book_ids)');
                assert.ok(host.chat.metadata.memoryCabinetV1.items.length >= 2, 'original storage format memoryCabinetV1 in chat metadata');
            } else {
                await until(() => host.chat.metadata.memoryCabinetV1?.pendingReview);
                assert.equal([...host.books.values()].length, 0, 'auto_review never writes the lorebook by itself');
            }
        } finally { env.stop(); }
    });
}
