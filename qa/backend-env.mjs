// QA backend: the real backend entry (src/backend.js) on the in-memory fake Spindle host (test/fake-host.js), seeded with chats, a
// finished memory (migrated 0.4.x items rendered by the original), and old 0.4.x data for the migration screen. No model, no network.
import { createFakeHost } from '../test/fake-host.js';
import { start } from '../src/backend.js';
import { mapOldToOriginal } from '../src/migrate.js';

const OLD = { version: 1, revision: 3, items: [
    { id: 'p1', layer: 'promises', text: '하루는 서아와 달빛호수에 같이 가기로 약속했다', scope: 'public', status: 'active', evidence: [], knownBy: [] },
    { id: 'p2', layer: 'promises', text: '서아는 다음 주까지 빵집 일을 도와주기로 했다', scope: 'public', status: 'completed', evidence: [], knownBy: [] },
    { id: 'a1', layer: 'anchors', text: '하루의 빵집은 언덕 위 골목 끝에 있다. 간판은 낡은 파란색이다.', scope: 'public', status: 'active', evidence: [], knownBy: [] },
    { id: 'a2', layer: 'anchors', text: '하루는 사실 옛 왕국의 후예다 (하루만 아는 비밀)', scope: 'secret', status: 'active', evidence: [], knownBy: ['char-haru'] },
    { id: 'a3', layer: 'anchors', text: '아직 공개 승인되지 않은 사실 (범위 미확정)', scope: 'unknown', status: 'active', evidence: [], knownBy: [] },
    { id: 's1', layer: 'scenes', text: '장면: 옥상에서의 대화', scope: 'public', status: 'active', evidence: [], knownBy: [] }] };
const REPLY = JSON.stringify([{ action: 'add', type: 'promise', title: '한강에서 만나기', content: '하루와 서아는 한강에서 만나기로 약속했다', priority: 'high' }, { action: 'add', type: 'anchor', title: '한강 약속 장소', content: '약속 장소는 한강이다', category: 'event', activation: 'always', lifespan: 'permanent' }]);

export async function createQaEnv({ withOld = true, ui = {} } = {}) {
    const f = createFakeHost({ modelReply: REPLY, chatId: 'chat-a' });
    f.chat.name = '하루의 빵집';
    f.addChat('chat-b', { name: '두 번째 RP' });
    f.chat.metadata.memoryCabinetV1 = mapOldToOriginal(OLD, { chatId: 'chat-a', now: '2026-10-27T00:00:00.000Z' }).data;
    if (withOld) f.store.set('chats/chat-b/data.json', OLD);
    f.store.set('ui-qa-user.json', { memoryCabinetUiV1: { selectedChatId: 'chat-a', modelConnectionId: 'conn1', ...ui } });
    f.addTurns(6, 'chat-a');
    const stop = start({ ...f.api, log: { info() {}, warn() {} } }, { afterMs: 0, trigger: { every: 3 } });
    const outbox = [], tabs = new Map();
    return {
        f, stop, outbox,
        async handle(frame, user) {
            const before = f.toFront.length;
            f.handlers.frontend(frame, user, 'qa-session');
            const t0 = Date.now();
            while (Date.now() - t0 < 20000) {
                const hit = f.toFront.slice(before).find(m => m.requestId === frame.requestId);
                if (hit) { f.toFront.splice(f.toFront.indexOf(hit), 1); return [hit]; }
                await new Promise(r => setTimeout(r, 2));
            }
            return [];
        },
        /** events pushed by the backend are delivered to EVERY open tab of the user (what Spindle's sendToFrontend does without a session target); rpc replies are never swallowed */
        drain(tab = 'default') {
            const ev = f.toFront.filter(m => m.event); for (const m of ev) f.toFront.splice(f.toFront.indexOf(m), 1);
            tabs.set(tab, tabs.get(tab) || []);
            for (const q of tabs.values()) q.push(...ev);
            return tabs.get(tab).splice(0);
        },
        /** N more user turns in a chat, then the host's GENERATION_ENDED */
        async turns(chatId, n) { f.addTurns(n, chatId); await f.handlers.on.GENERATION_ENDED({ chatId, generationType: 'normal' }, 'qa-user'); },
    };
}
