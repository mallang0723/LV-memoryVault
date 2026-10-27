// Thin-adapter contracts: persisted turn trigger, claim, metadata write safety, confirm guard, router vs. the original's endpoints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHTML } from 'linkedom';
import { createFakeHost } from './fake-host.js';
import { createTrigger, clampEvery } from '../src/trigger.js';
import { createHost } from '../src/host.js';
import { normalizePath } from '../src/router.js';
import { installConfirmGuard } from '../src/confirm-guard.js';
import { start } from '../src/backend.js';

const rows = (turns, from = 0) => { const out = []; for (let i = 0; i < turns; i++) { const n = from + i * 2; out.push({ number: n + 1, role: 'user', name: '나', content: `u${n}` }, { number: n + 2, role: 'assistant', name: '하나', content: `a${n}` }); } return out; };
const memStore = () => { const m = new Map(); return { m, load: async id => (m.has(id) ? structuredClone(m.get(id)) : null), save: async (id, s) => { m.set(id, structuredClone(s)); } }; };

test('trigger: an older chat starts counting from now; one entry per N user turns, raw text of exactly those turns', async () => {
    const t = createTrigger({ every: 10, store: memStore() });
    assert.equal(await t.onGenerationEnded('c1', rows(30)), null, 'first sight of a chat that already has >= N turns = baseline (nothing summarised retroactively)');
    assert.equal(await t.onGenerationEnded('c1', rows(39)), null, '9 new turns: not yet');
    const e = await t.onGenerationEnded('c1', rows(40));
    assert.ok(e); assert.match(e.title, /최근 10턴/); assert.match(e.content, /\[사용자\] u60/); assert.doesNotMatch(e.content, /u58\b/, 'older turns are not repeated');
    assert.equal(await t.onGenerationEnded('c1', rows(40)), null, 'same turn count again: no duplicate');
});
test('trigger: a young chat counts from its very first message (first sight late is fine)', async () => {
    const t = createTrigger({ every: 10, store: memStore() });
    assert.equal(await t.onGenerationEnded('n', rows(3)), null);
    const e = await t.onGenerationEnded('n', rows(10));
    assert.ok(e, 'fires at the 10th user turn, not the 13th'); assert.match(e.content, /\[사용자\] u0\b/, 'starts at the first message');
});
test('trigger: counter and entries survive a restart (persisted per chat)', async () => {
    const store = memStore();
    const a = createTrigger({ every: 5, store });
    await a.onGenerationEnded('c1', rows(2));
    await a.onGenerationEnded('c1', rows(4));          // 4 turns counted
    const b = createTrigger({ every: 5, store });        // "restart": new object, same storage
    assert.equal(await b.onGenerationEnded('c1', rows(4)), null);
    const e = await b.onGenerationEnded('c1', rows(5));            // the 5th turn: fires
    assert.ok(e, 'turns counted before the restart still count');
    const c = createTrigger({ every: 5, store });
    assert.equal((await c.entries('c1')).length, 1, 'entries are reloaded for the original to see');
});
test('trigger: N is read per call (user-configurable), rollback/hidden/empty handled, only the newest entries are kept', async () => {
    let n = 10; const t = createTrigger({ every: () => n, store: memStore() });
    await t.onGenerationEnded('c', rows(1));
    n = 3; assert.ok(await t.onGenerationEnded('c', rows(4)), 'lowered N applies immediately (4 turns since the start of a young chat)');
    assert.equal(await t.onGenerationEnded('c', rows(2)), null, 'messages deleted: no negative counts'); // lastUsers reset to 2
    assert.ok(await t.onGenerationEnded('c', rows(5)), 'and counting continues from the new length');
    const e = await t.onGenerationEnded('c', rows(8).map(r => (r.number > 12 ? { ...r, extra: { hidden: true } } : r))); assert.ok(e); assert.doesNotMatch(e.content, /u12/, 'hidden messages are not summarised');
    for (let k = 7; k < 40; k += 3) await t.onGenerationEnded('c', rows(k));
    assert.ok((await t.entries('c')).length <= 5);
    assert.equal(clampEvery(1), 3); assert.equal(clampEvery(500), 100); assert.equal(clampEvery('x'), 10);
});

test('backend: settings route clamps N; claim lets exactly one tab through; generation notice via status', async () => {
    const h = createFakeHost(); const stop = start(h.api, { afterMs: 0 });
    const rpc = (id, method, path, body, user = 'user1') => new Promise(res => { const off = h.ctx.onBackendMessage(m => { if (m.requestId === id) { off(); res(m); } }); h.handlers.frontend({ requestId: id, type: 'api', method, path, body }, user); });
    try {
        assert.equal((await rpc('a', 'POST', '_adapter/settings', { every: 1 })).data.every, 3);
        assert.equal((await rpc('b', 'GET', '_adapter/status')).data.every, 3);
        assert.equal((await rpc('c', 'POST', '_adapter/settings', { every: 25 })).data.every, 25);
        assert.deepEqual((await rpc('d', 'POST', '_trigger/claim', { id: 't1' })).data, { ok: true });
        assert.deepEqual((await rpc('e', 'POST', '_trigger/claim', { id: 't1' })).data, { ok: false }, 'second tab loses');
        assert.deepEqual((await rpc('f', 'POST', '_trigger/claim', { id: 't2' })).data, { ok: true });
        h.api.permissions.has = p => p !== 'generation';
        assert.equal((await rpc('g', 'GET', '_adapter/status')).data.permissions.generation, false);
        const nouser = await new Promise(res => { const off = h.ctx.onBackendMessage(m => { if (m.requestId === 'x') { off(); res(m); } }); h.handlers.frontend({ requestId: 'x', type: 'api', method: 'GET', path: 'chats' }, ''); });
        assert.equal(nouser.ok, false, 'a frame without a user id is refused');
    } finally { stop(); }
});
test('backend: a turn trigger is stored under trigger/<chat>.json and announced with an id', async () => {
    const h = createFakeHost(); h.addTurns(2);
    const stop = start(h.api, { afterMs: 0, trigger: { every: 3 } });
    try {
        await h.handlers.on.GENERATION_ENDED({ chatId: 'chat1', generationType: 'normal' }, 'user1'); await new Promise(r => setTimeout(r, 30));
        h.addTurns(3);
        await h.handlers.on.GENERATION_ENDED({ chatId: 'chat1', generationType: 'normal' }, 'user1'); await new Promise(r => setTimeout(r, 60));
        const ev = h.toFront.find(m => m.event === 'mv-trigger'); assert.ok(ev && ev.id && ev.chatId === 'chat1');
        assert.equal(h.store.get('trigger/chat1.json').entries.length, 1);
        await h.handlers.on.GENERATION_ENDED({ chatId: 'chat1', generationType: 'swipe' }, 'user1');   // swipes/regens do not count
    } finally { stop(); }
});

test('metadata writes: concurrent patches both survive (queued), and a clobbered write is detected and redone', async () => {
    const h = createFakeHost(); const host = createHost(h.api);
    h.chat.metadata = { keep: 1 };
    await Promise.all([host.patchMetadata('u', 'chat1', { a: 1 }), host.patchMetadata('u', 'chat1', { b: 2 }), host.patchMetadata('u', 'chat1', { activeLorebookIds: ['x'] })]);
    assert.deepEqual(h.chat.metadata, { keep: 1, a: 1, b: 2, chat_world_book_ids: ['x'] });
    // a host background write that wipes our key right after our update (first attempt only)
    const real = h.api.chats.update; let clobbered = 0;
    h.api.chats.update = async (id, input, u) => { const r = await real(id, input, u); if (!clobbered++) h.chat.metadata = { keep: 1 }; return r; };
    const out = await host.patchMetadata('u', 'chat1', { memoryCabinetV1: { x: 1 } });
    assert.equal(clobbered, 2, 'verified, noticed the missing key, wrote again'); assert.deepEqual(h.chat.metadata.memoryCabinetV1, { x: 1 }); assert.ok(out.metadata.memoryCabinetV1);
    h.api.chats.update = async (id, input, u) => { const r = await real(id, input, u); h.chat.metadata = {}; return r; };
    await assert.rejects(host.patchMetadata('u', 'chat1', { z: 1 }, { attempts: 2 }), /저장하지 못했습니다/);
    // derived keys are never persisted
    h.api.chats.update = real; await host.patchMetadata('u', 'chat1', { summaryEntries: [1], branchParentChatId: 'p', q: 1 });
    assert.ok(!('summaryEntries' in h.chat.metadata) && !('branchParentChatId' in h.chat.metadata));
});

test('branch + group chats: branch parent mapping, group member ids, no crash on odd metadata', async () => {
    const h = createFakeHost(); const host = createHost(h.api);
    h.chat.metadata = { branched_from: 'parent-1', branch_at_message: 'm9', group: true, character_ids: ['char1', 'char2'], group_card_mode: 'merge' };
    const c = await host.chat('u', 'chat1');
    assert.equal(c.metadata.branchParentChatId, 'parent-1'); assert.deepEqual(c.characterIds, ['char1', 'char2']);
    h.chat.metadata = null; assert.deepEqual((await host.chat('u', 'chat1')).characterIds, ['char1']);
});

test('confirm guard: pass-through for host code and real answers; double-press fallback only when the dialog was suppressed', () => {
    const { document } = parseHTML('<html><body><div id="mmc-root-v1"><button id="b">x</button></div><button id="host">h</button></body></html>');
    const timers = []; let clock = 0, nativeAnswer = false, nativeCost = 0, throws = false; const toasts = [];
    const win = { document, performance: { now: () => clock }, setTimeout: fn => timers.push(fn), confirm: msg => { if (throws) throw new Error('blocked'); clock += nativeCost; return nativeAnswer; } };
    const g = installConfirmGuard(win, document, { notify: m => toasts.push(m), now: () => clock });
    const press = (id, msg) => { const b = document.getElementById(id); let r; const on = e => { if (e.target === b) r = win.confirm(msg); }; document.addEventListener('click', on); /* linkedom has no capture phase: the guard's capture listener is registered first, so it runs first here too */ b.dispatchEvent(new document.defaultView.Event('click', { bubbles: true })); while (timers.length) timers.shift()(); document.removeEventListener('click', on); return r; };
    nativeCost = 4000; nativeAnswer = false;
    assert.equal(press('b', '삭제할까요?'), false); assert.equal(toasts.length, 0, 'a human pressed Cancel: untouched');
    nativeAnswer = true; assert.equal(press('b', '삭제할까요?'), true);
    nativeCost = 0; nativeAnswer = false;   // suppressed: false at once
    assert.equal(press('host', '호스트 확인'), false); assert.equal(toasts.length, 0, 'host code is never altered');
    assert.equal(press('b', '삭제할까요?'), false); assert.equal(toasts.length, 1, 'first press: hint, cancelled');
    clock += 1000; assert.equal(press('b', '삭제할까요?'), true, 'same press again: goes through');
    assert.equal(press('b', '삭제할까요?'), false, 'and re-arms');
    clock += 1000; assert.equal(press('b', '다른 질문'), false, 'a different question does not inherit the first press');
    throws = true; clock += 1000; assert.equal(press('b', '다른 질문'), true, 'confirm() that throws is handled the same way');
    g.dispose(); assert.equal(typeof win.confirm, 'function'); assert.equal(g.stats.accepted, 2);
});

test('contract: every endpoint the pinned original calls is routed', () => {
    const src = readFileSync(new URL('../vendor/original/extension.js', import.meta.url), 'utf8');
    const paths = new Set([...src.matchAll(/\bapi\(\s*(?:`([^`]*)`|"([^"]*)"|'([^']*)')/g)].map(m => (m[1] ?? m[2] ?? m[3]).replace(/\$\{[^}]*\}/g, 'X')));
    assert.ok(paths.size >= 10, `found ${paths.size} paths`);
    const stop = start(createFakeHost().api, { afterMs: 0 });
    try {
        const missing = [...paths].filter(p => { const { path } = normalizePath(p); return !['GET', 'POST', 'PATCH'].some(m => stop.router.match(m, path)); });
        assert.deepEqual(missing, []);
        assert.ok(!/api\([^)]*\)[^;]*method:\s*"(DELETE|PUT)"/.test(src));
    } finally { stop(); }
});

test('shim: only the original\'s /api/ paths are ours; Lumiverse\'s own /api/v1 (and auth/ws) pass through', async () => {
    const { isOriginalApi } = await import('../src/shim.js');
    for (const u of ['/api/chats/abc', '/api/lorebooks?chatId=x', '/api/generate/raw', '/api/connections', 'http://qa.test/api/chats', '/api/_storage']) assert.equal(isOriginalApi(u), true, u);
    for (const u of ['/api/v1/chats', '/api/v1', '/api/v2/x', '/api/auth/sign-in', '/api/ws', '/qa/harness.html', 'https://example.com/other/api/chats']) assert.equal(isOriginalApi(u), false, u);
});
