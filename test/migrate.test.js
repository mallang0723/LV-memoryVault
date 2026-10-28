// Spike goal 3: 0.4.x data -> original memoryCabinetV1; the PINNED ORIGINAL must load it and show the items.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { createFakeHost } from './fake-host.js';
import { mapOldToOriginal, buildBackup } from '../src/migrate.js';
import { downloadJson } from '../src/download.js';

const OLD = { version: 1, revision: 7, undo: [{ items: [], candidates: [] }], candidates: [{ id: 'c1', layer: 'anchors', text: '후보', scope: 'unknown' }], items: [
    { id: 'a', layer: 'promises', text: '한강에서 만나기로 약속했다', scope: 'public', status: 'active', evidence: [{ id: 'm1', index: 3, fingerprint: 'f' }], knownBy: [] },
    { id: 'b', layer: 'anchors', text: '하나는 왕녀다 (비밀)', scope: 'secret', status: 'active', evidence: [], knownBy: ['char1'] },
    { id: 'c', layer: 'anchors', text: '아직 공개 승인 안 된 사실', scope: 'unknown', status: 'active', evidence: [], knownBy: [] },
    { id: 'd', layer: 'scenes', text: '장면: 옥상에서의 대화', scope: 'public', status: 'active', evidence: [], knownBy: [] },
    { id: 'e', layer: 'promises', text: '끝난 약속', scope: 'public', status: 'completed', evidence: [], knownBy: [] }] };

test('mapping rules', () => {
    const { data, report } = mapOldToOriginal(OLD, { chatId: 'chat1', now: '2026-10-27T00:00:00.000Z' });
    const by = id => data.items.find(i => i.id === `mig-${id}`);
    assert.equal(data.ownerChatId, 'chat1');
    assert.equal(by('a').type, 'promise'); assert.equal(by('a').status, 'active'); assert.deepEqual(by('a').sourceIds, ['m1']);
    assert.deepEqual(by('b').knownBy, ['char1']); assert.equal(by('b').active, true);          // restricted kept restricted
    assert.equal(by('c').active, false);                                                        // unknown scope: kept, not injected
    assert.equal(by('d'), undefined, 'scenes are not cleanly mappable: they stay in the backup only'); assert.equal(by('e').status, 'done');
    assert.equal(data.items.length, 4); assert.deepEqual(report.skippedByLayer, { scenes: 1 });
    assert.equal(report.candidatesDropped, 1); assert.equal(report.undoDropped, 1);
});

test('backup document keeps raw files; download works without secure-context APIs', () => {
    const b = buildBackup({ chats: { chat1: { data: OLD } }, now: 'x' });
    assert.equal(b.format, 'memory-cabinet-lv-backup'); assert.deepEqual(b.chats.chat1.data, OLD);
    const { document } = parseHTML('<html><body></body></html>');
    const clicked = []; const realCreate = document.createElement.bind(document);
    document.createElement = t => { const el = realCreate(t); if (t === 'a') el.click = () => clicked.push(el.download); return el; };
    const URLish = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
    assert.equal(downloadJson(b, 'bk.json', { document, URL: URLish, Blob: class { constructor(p) { this.p = p; } } }).method, 'blob'); assert.deepEqual(clicked, ['bk.json']);
    // no Blob/URL (very old webview) -> textarea fallback, still no navigator.clipboard
    document.execCommand = () => true;
    const r = downloadJson(b, 'bk.json', { document, URL: {}, Blob: class { constructor() { throw new Error('nope'); } } });
    assert.equal(r.method, 'textarea'); assert.ok(document.querySelector('textarea'));
});

const sleep = ms => new Promise(r => setTimeout(r, ms));
test('the pinned original loads the migrated memoryCabinetV1 and lists the items', async () => {
    const host = createFakeHost();
    host.store.set('chats/chat1/data.json', OLD);
    const { document } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    const ls = new Map();
    const window = { document, setTimeout, clearTimeout, setInterval, clearInterval, location: { origin: 'http://localhost' }, addEventListener() {}, removeEventListener() {}, localStorage: { getItem: k => ls.get(k) ?? null, setItem: (k, v) => ls.set(k, String(v)), removeItem: k => ls.delete(k) }, fetch: async () => { throw new Error('net'); } };
    Object.assign(globalThis, { window, document, localStorage: window.localStorage });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, get: () => window.fetch, set: v => { window.fetch = v; } });
    const { start } = await import('../src/backend.js?m' + Math.random()); const { setup } = await import('../src/frontend.js?m' + Math.random());
    const stopB = start(host.api, { afterMs: 0 });
    // run the one-time import through the real route
    const rpc = (id, method, path, body) => new Promise(res => { const off = host.ctx.onBackendMessage(m => { if (m.requestId === id) { off(); res(m); } }); host.handlers.frontend({ requestId: id, type: 'api', method, path, body }, 'user1'); });
    assert.equal((await rpc('r0', 'POST', '_migrate/apply', { confirmBackup: true })).ok, false, 'no import before a backup was downloaded');
    assert.equal((await rpc('r00', 'GET', '_migrate/backup')).data.chats.chat1.data.items.length, 5);
    assert.equal((await rpc('r01', 'POST', '_migrate/apply', {})).ok, false, 'no import without the explicit "I saved it" confirmation');
    const reply = await rpc('r1', 'POST', '_migrate/apply', { confirmBackup: true });
    assert.ok(reply.ok, JSON.stringify(reply)); assert.equal(reply.data.chat1.items, 4);
    assert.equal(host.chat.metadata.memoryCabinetV1.items.length, 4);
    const stopF = setup(host.ctx, { win: window, doc: document });
    try {
        await sleep(1500);
        document.getElementById('mmc-launcher-v1').click();
        await sleep(2500);
        const text = document.getElementById('mmc-root-v1').textContent;
        assert.match(text, /한강에서 만나기로 약속했다/, 'migrated promise is rendered by the original UI');
        assert.equal(host.chat.metadata.memoryCabinetV1.items.length, 4, 'opening the vault did not wipe or duplicate migrated data');
    } finally { stopF(); stopB(); }
});

test('apply never clobbers an existing memoryCabinetV1 (Honey condition 1)', async () => {
    const { start } = await import('../src/backend.js?m' + Math.random());
    const run = async existing => {
        const host = createFakeHost();
        host.store.set('chats/chat1/data.json', OLD);
        if (existing !== undefined) host.chat.metadata.memoryCabinetV1 = existing;
        const stop = start(host.api, { afterMs: 0 });
        const rpc = (id, method, path, body) => new Promise(res => { const off = host.ctx.onBackendMessage(m => { if (m.requestId === id) { off(); res(m); } }); host.handlers.frontend({ requestId: id, type: 'api', method, path, body }, 'user1'); });
        await rpc('b', 'GET', '_migrate/backup');
        const reply = await rpc('a', 'POST', '_migrate/apply', { confirmBackup: true });
        stop();
        return { host, reply };
    };
    // Honey's counterexample: no items, but a managed lorebook and element memory
    const mine = { version: 1, ownerChatId: 'chat1', enabled: true, items: [], lorebookId: 'bookX', elementMemory: { entities: [{ id: 'e1', name: '하나' }] } };
    let r = await run(structuredClone(mine));
    assert.ok(r.reply.ok, JSON.stringify(r.reply));
    assert.deepEqual(r.host.chat.metadata.memoryCabinetV1, mine, 'existing object is untouched');
    assert.equal(r.reply.data.chat1.skipped, 'already has original data');
    // existing items: also untouched
    const withItems = { version: 1, ownerChatId: 'chat1', enabled: true, items: [{ id: 'x', type: 'anchor', title: 't', content: 'c' }] };
    r = await run(structuredClone(withItems));
    assert.deepEqual(r.host.chat.metadata.memoryCabinetV1, withItems);
    // absent or pristine default: import happens
    r = await run(undefined); assert.equal(r.host.chat.metadata.memoryCabinetV1.items.length, 4);
    r = await run({ version: 1, ownerChatId: 'chat1', enabled: true, items: [] }); assert.equal(r.host.chat.metadata.memoryCabinetV1.items.length, 4);
});

test('apply reports per-chat name/skipped/failed and counts; a write failure leaves the import retryable', async () => {
    const { start } = await import('../src/backend.js?m' + Math.random());
    const host = createFakeHost();
    host.store.set('chats/chat1/data.json', OLD);
    host.chat.name = '첫 채팅';
    const realUpdate = host.api.chats.update;
    host.api.chats.update = async () => { throw new Error('disk full'); };
    const stop = start(host.api, { afterMs: 0 });
    const rpc = (id, method, path, body) => new Promise(res => { const off = host.ctx.onBackendMessage(m => { if (m.requestId === id) { off(); res(m); } }); host.handlers.frontend({ requestId: id, type: 'api', method, path, body }, 'user1'); });
    await rpc('b', 'GET', '_migrate/backup');
    let reply = await rpc('a1', 'POST', '_migrate/apply', { confirmBackup: true });
    assert.ok(reply.ok, JSON.stringify(reply));
    assert.equal(reply.data.chat1.name, '첫 채팅'); assert.match(reply.data.chat1.failed, /disk full/);
    let st = (await rpc('s1', 'GET', '_migrate/status')).data;
    assert.equal(st.importedAt, null, 'failure keeps the import open'); assert.equal(st.result.failed, 1); assert.equal(st.result.chats, 0);
    host.api.chats.update = realUpdate;
    reply = await rpc('a2', 'POST', '_migrate/apply', { confirmBackup: true });
    assert.equal(reply.data.chat1.items, 4);
    st = (await rpc('s2', 'GET', '_migrate/status')).data;
    assert.ok(st.importedAt); assert.deepEqual([st.result.chats, st.result.imported, st.result.skipped, st.result.failed], [1, 4, 0, 0]);
    reply = await rpc('a3', 'POST', '_migrate/apply', { confirmBackup: true });
    assert.deepEqual([reply.data.chat1.skipped, reply.data.chat1.name], ['already has original data', '첫 채팅']);
    st = (await rpc('s3', 'GET', '_migrate/status')).data;
    assert.deepEqual(st.result.skippedList, [{ name: '첫 채팅', reason: 'already has original data' }]);
    stop();
});
