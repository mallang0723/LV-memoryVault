// The whole auto-run adapter: count user turns, every N turns synthesize ONE summaryEntry that the original's own
// passive observer (fetch of /api/chats/:id -> metadata.summaryEntries) will see as "a new summary" and analyse.
// No receipts / pause / backoff: if the original's analysis fails, the next trigger just adds another entry.
export const EVERY_DEFAULT = 10;
const MAX_ENTRIES = 40;

export function createTrigger({ every = EVERY_DEFAULT, now = () => new Date().toISOString() } = {}) {
    const entriesByChat = new Map();   // chatId -> summaryEntries[] (in memory; the original keeps its own "known" signatures)
    const state = new Map();           // chatId -> { bucket, from }  (number of the first message not yet summarised)
    return {
        entries: chatId => entriesByChat.get(chatId) || [],
        /** rows: [{number, role, name, content}] oldest first. Returns the new entry or null (baseline / not yet N turns). */
        onGenerationEnded(chatId, rows) {
            const users = rows.filter(r => r.role === 'user').length;
            const bucket = Math.floor(users / every);
            const st = state.get(chatId);
            if (!st) { state.set(chatId, { bucket, from: (rows.at(-1)?.number ?? 0) + 1 }); return null; }   // first sight: baseline only
            if (bucket <= st.bucket) { st.bucket = Math.min(st.bucket, bucket); return null; }
            const slice = rows.filter(r => r.number >= st.from && r.role !== 'system');
            st.bucket = bucket; st.from = (rows.at(-1)?.number ?? 0) + 1;
            if (!slice.length) return null;
            const content = slice.map(r => `${r.role === 'user' ? '[사용자]' : `[${r.name || '캐릭터'}]`} ${r.content}`).join('\n\n');
            const entry = { id: `mv-${chatId.slice(0, 8)}-${slice[0].number}-${slice.at(-1).number}`, title: `최근 ${users - (bucket - 1) * every}턴 대화 (#${slice[0].number}–#${slice.at(-1).number})`, content, enabled: true, origin: 'memory-cabinet-adapter', createdAt: now(), updatedAt: now() };
            const list = entriesByChat.get(chatId) || [];
            list.push(entry);
            entriesByChat.set(chatId, list.slice(-MAX_ENTRIES));
            return entry;
        },
    };
}
