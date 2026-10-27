// 0.4.x (data.json {version:1,revision,items,candidates,undo}) -> original memoryCabinetV1. Pure functions, no host access.
// Mapping rules (spike): promises -> promise, everything else -> anchor (category by layer). Anything the 0.4 scope model marks as
// not-publicly-known and that has no explicit knownBy list is kept but NOT injected (promise status 'hold' / anchor active:false).
const CATEGORY = { anchors: 'setting', elements: 'setting', scenes: 'event', flows: 'state', wiki: 'setting' };
const LAYER_TAG = { anchors: '', elements: '[요소] ', scenes: '[장면] ', flows: '[흐름] ', wiki: '[위키] ' };
const firstLine = (t, n = 60) => { const s = String(t).trim().split(/\n/)[0]; return s.length > n ? s.slice(0, n - 1) + '…' : s; };

export function mapItem(x, now) {
    const kb = Array.isArray(x.knownBy) ? x.knownBy.map(String).filter(Boolean) : [];
    const blocked = !!(x.audience || x.condition || x.branchHold || x.hold || x.review || x.resumeRequired || x.importedScope);
    const publicOk = x.scope === 'public' && !kb.length;
    const restrictedOk = kb.length > 0 && ['secret', 'character'].includes(x.scope);
    const inject = !blocked && (publicOk || restrictedOk);
    const base = { id: `mig-${x.id}`.slice(0, 120), title: LAYER_TAG[x.layer] ? LAYER_TAG[x.layer] + firstLine(x.text, 50) : firstLine(x.text), content: String(x.text), sourceType: 'migrated-0.4', sourceIds: (x.evidence || []).map(e => String(e.id)), createdAt: now, updatedAt: now, ...(kb.length ? { knownBy: kb } : {}) };
    if (x.layer === 'promises') return { ...base, type: 'promise', status: x.status === 'completed' ? 'done' : x.status === 'cancelled' ? 'cancelled' : inject ? 'active' : 'hold', priority: 'normal', scheduleText: '' };
    return { ...base, type: 'anchor', category: CATEGORY[x.layer] || 'setting', priority: 'normal', active: inject && x.status !== 'cancelled', archived: x.status === 'cancelled' || x.status === 'completed', activation: 'always', keywords: [], lifespan: 'permanent' };
}

export function mapOldToOriginal(old, { chatId, now = new Date().toISOString() }) {
    const items = (old?.items || []).map(x => mapItem(x, now));
    const held = items.filter(i => (i.type === 'promise' ? i.status === 'hold' : !i.active && !i.archived)).length;
    return {
        data: { version: 1, ownerChatId: chatId, enabled: true, items },
        report: { items: items.length, held, candidatesDropped: (old?.candidates || []).length, undoDropped: (old?.undo || []).length,
            lostFields: ['revision', 'undo', 'candidates (re-run analysis)', 'evidence.index/fingerprint', 'audience', 'condition', 'importedScope', 'branchHold', 'review', 'resumeRequired', 'layer (elements/scenes/flows/wiki become anchors with a title tag)'] },
    };
}

/** Backup document: raw 0.4 files untouched, so any later (better) migrator can run from the file alone. */
export function buildBackup({ chats, settings = null, version = '0.4.x', now = new Date().toISOString() }) {
    return { format: 'memory-cabinet-lv-backup', formatVersion: 1, createdAt: now, extensionVersion: version, settings, chats };   // chats: { [chatId]: { name, data, auto, health } }
}
