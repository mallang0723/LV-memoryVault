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
    assert.match(by('d').title, /^\[장면\]/); assert.equal(by('e').status, 'done');
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
    const reply = await new Promise(res => { const orig = host.api.sendToFrontend; host.ctx.onBackendMessage(m => m.requestId === 'r1' && res(m)); host.handlers.frontend({ requestId: 'r1', type: 'api', method: 'POST', path: '_migrate/apply' }, 'user1'); });
    assert.ok(reply.ok, JSON.stringify(reply)); assert.equal(reply.data.chat1.items, 5);
    assert.equal(host.chat.metadata.memoryCabinetV1.items.length, 5);
    const stopF = setup(host.ctx, { win: window, doc: document });
    try {
        await sleep(1500);
        document.getElementById('mmc-launcher-v1').click();
        await sleep(2500);
        const text = document.getElementById('mmc-root-v1').textContent;
        assert.match(text, /한강에서 만나기로 약속했다/, 'migrated promise is rendered by the original UI');
        assert.equal(host.chat.metadata.memoryCabinetV1.items.length, 5, 'opening the vault did not wipe or duplicate migrated data');
    } finally { stopF(); stopB(); }
});
