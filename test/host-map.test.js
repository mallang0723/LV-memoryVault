// Spike goal 2: Marinara lorebook semantics -> Lumiverse world books.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeHost } from './fake-host.js';
import { createHost } from '../src/host.js';

test('characterFilter include -> {{if::{{char}}==Name}} guard; original content round-trips; plain entries untouched', async () => {
    const h = createFakeHost(); const host = createHost(h.api);
    const book = await host.createBook('u', { name: 'b', description: 'd', tags: ['memory-cabinet-rp'], chatId: 'chat1' });
    const restricted = await host.createEntry('u', book.id, { name: 'r', content: '비밀 내용', constant: true, enabled: true, position: 0, depth: 4, role: 'system', order: 45, characterFilterMode: 'include', characterFilterIds: ['char1'], tag: 'memory-cabinet-restricted', locked: true });
    const raw = [...h.entries.values()].flat().find(e => e.id === restricted.id);
    assert.equal(raw.content, '{{if::{{char}}==하나}}비밀 내용{{/if}}');   // what Lumiverse evaluates at prompt time
    assert.equal(restricted.content, '비밀 내용'); assert.deepEqual(restricted.characterFilterIds, ['char1']);   // what the original reads back
    const plain = await host.createEntry('u', book.id, { name: 'p', content: '공용', constant: true, characterFilterMode: 'any', characterFilterIds: [] });
    assert.equal([...h.entries.values()].flat().find(e => e.id === plain.id).content, '공용');
    const upd = await host.patchEntry('u', book.id, plain.id, { enabled: false });
    assert.equal(upd.enabled, false); assert.equal(upd.content, '공용');
    assert.deepEqual((await host.lorebooks('u', 'chat1')).map(b => b.id), [book.id], 'chatId-scoped book is found by ?chatId=');
});

test('chat metadata: activeLorebookIds <-> chat_world_book_ids, read-merge-write keeps host keys', async () => {
    const h = createFakeHost(); const host = createHost(h.api);
    h.chat.metadata = { wi_state: { a: 1 }, branched_from: 'parent' };
    const c = await host.patchMetadata('u', 'chat1', { activeLorebookIds: ['b1'], memoryCabinetV1: { x: 1 } });
    assert.deepEqual(h.chat.metadata.chat_world_book_ids, ['b1']); assert.deepEqual(h.chat.metadata.wi_state, { a: 1 });
    assert.deepEqual(c.metadata.activeLorebookIds, ['b1']); assert.equal(c.metadata.branchParentChatId, 'parent');
});
