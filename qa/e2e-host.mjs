// Real-host e2e against a TEMPORARY Lumiverse instance: the host source tree is run read-only (never modified), with a fresh scratch
// DATA_DIR, a throwaway owner, a mock OpenAI-compatible LLM, and this repo's built dist installed as extension `memory_cabinet`.
// env: LUMI_SRC (host tree), PORT (>= 7895, never 7880/7881/10000), LABEL, OUT (receipt dir), SCRATCH (data dir parent), PW (playwright index.mjs),
//      CHROMIUM_BIN, BUN (default ~/.bun/bin/bun). Stops the host and the mock by PID. No secrets are printed or stored.
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, cpSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const { LUMI_SRC, PORT: PORT_S, LABEL = 'host', OUT, SCRATCH, PW, CHROMIUM_BIN = '/usr/bin/chromium', BUN = path.join(os.homedir(), '.bun/bin/bun') } = process.env;
const PORT = Number(PORT_S), MOCK = PORT + 1, BASE = `http://127.0.0.1:${PORT}`, REPO = process.cwd();
if (!LUMI_SRC || !PORT || !OUT || !SCRATCH || !PW) throw new Error('LUMI_SRC, PORT, OUT, SCRATCH, PW required');
if ([7880, 7881, 10000].includes(PORT) || [7880, 7881, 10000].includes(MOCK)) throw new Error('forbidden port');
const { chromium } = await import(pathToFileURL(PW).href);
const DATA = path.join(SCRATCH, `data-${LABEL}`);
rmSync(DATA, { recursive: true, force: true }); mkdirSync(DATA, { recursive: true }); mkdirSync(OUT, { recursive: true });
const USER = 'e2eowner', PASS = randomBytes(9).toString('hex');
const SC = (process.env.SCENARIOS || '').split(',').filter(Boolean);   // e.g. B or B,D,E (blocks D/E/K reuse chat A from B)
const want = x => !SC.length || SC.includes(x);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const receipt = { label: LABEL, port: PORT, hostCommit: null, steps: [], notes: [] };
const step = (name, ok, extra = {}) => { receipt.steps.push({ name, ok, ...extra }); console.log(ok ? 'OK  ' : 'FAIL', name, JSON.stringify(extra).slice(0, 220)); };
const finish = async code => { writeFileSync(path.join(OUT, `e2e-${LABEL}.json`), JSON.stringify(receipt, null, 1)); await stopAll(); process.exit(code); };

// ---------- mock LLM ----------
const REPLY = JSON.stringify([{ action: 'add', type: 'promise', title: '한강에서 만나기', content: '하나와 사용자는 한강에서 만나기로 약속했다', priority: 'high' }, { action: 'add', type: 'anchor', title: '한강 약속 장소', content: '약속 장소는 한강이다', category: 'event', activation: 'always', lifespan: 'permanent' }]);
const llm = { analysis: [], chat: 0 };
const mock = createServer((req, res) => {
    let b = ''; req.on('data', d => (b += d)); req.on('end', () => {
        if (req.method !== 'POST') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'mock-1', object: 'model' }] })); }
        let j = {}; try { j = JSON.parse(b); } catch { /* ignore */ }
        const text = JSON.stringify(j.messages || []);
        const analysis = text.includes('Return JSON only');
        if (analysis) llm.analysis.push(text); else llm.chat++;
        const content = analysis ? REPLY : '하나가 고개를 끄덕였다. "좋아, 한강에서 보자."';
        if (j.stream) { res.setHeader('content-type', 'text/event-stream'); res.write('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] }) + '\n\n'); res.write('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n'); return res.end(); }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
});
await new Promise(r => mock.listen(MOCK, '127.0.0.1', r));

// ---------- host process (stopped by PID) ----------
const hostLog = []; let host = null, browser = null;
async function stopAll() {
    try { await browser?.close(); } catch { /* ignore */ }
    if (host?.pid) { try { process.kill(host.pid, 'SIGTERM'); } catch { /* gone */ } await sleep(1500); try { process.kill(host.pid, 0); process.kill(host.pid, 'SIGKILL'); } catch { /* gone */ } }
    mock.close();
    writeFileSync(path.join(OUT, `host-${LABEL}.log`), hostLog.join('').slice(-20000));
}
process.on('SIGINT', () => finish(130));
const ext = path.join(DATA, 'extensions/memory_cabinet/repo');
mkdirSync(path.join(ext, 'dist'), { recursive: true });
for (const f of ['spindle.json', 'dist/backend.js', 'dist/frontend.js']) cpSync(path.join(REPO, f), path.join(ext, f));
host = spawn(BUN, ['run', 'src/index.ts'], { cwd: LUMI_SRC, env: { ...process.env, PATH: `${path.dirname(BUN)}:${process.env.PATH}`, PORT: String(PORT), DATA_DIR: DATA, OWNER_USERNAME: USER, OWNER_PASSWORD: PASS, AUTH_SECRET: randomBytes(16).toString('hex'), ENCRYPTION_KEY: randomBytes(32).toString('hex'), FRONTEND_DIR: path.join(LUMI_SRC, 'frontend/dist') }, stdio: ['ignore', 'pipe', 'pipe'] });
host.stdout.on('data', d => hostLog.push(d.toString())); host.stderr.on('data', d => hostLog.push(d.toString()));
receipt.hostPid = host.pid;
for (let i = 0; i < 120; i++) { try { const r = await fetch(BASE + '/'); if (r.status < 500) break; } catch { /* starting */ } await sleep(500); if (i === 119) { step('host started', false); await finish(1); } }
try { receipt.hostCommit = (await new Promise(r => { const p = spawn('git', ['-C', LUMI_SRC, 'rev-parse', '--short', 'HEAD']); let o = ''; p.stdout.on('data', d => (o += d)); p.on('close', () => r(o.trim() || null)); })); } catch { /* optional */ }
step('host started (temporary instance)', true, { port: PORT, hostCommit: receipt.hostCommit });

// ---------- api helpers ----------
let loginRes = null;
for (let i = 0; i < 20 && !loginRes?.ok; i++) { loginRes = await fetch(`${BASE}/api/auth/sign-in/username`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ username: USER, password: PASS }) }).catch(() => null); if (!loginRes?.ok) await sleep(1000); }
if (!loginRes?.ok) { step('login', false); await finish(1); }
const setCookies = loginRes.headers.getSetCookie(); const cookie = setCookies.map(c => c.split(';')[0]).join('; ');
const api = async (method, p, body) => { const r = await fetch(`${BASE}/api/v1${p}`, { method, headers: { cookie, origin: BASE, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return r.ok ? j : { __error: r.status, body: j }; };

// ---------- install the extension (import-local), grant exactly the manifest permissions, enable ----------
const manifest = JSON.parse(readFileSync(path.join(REPO, 'spindle.json'), 'utf8'));
const imp = await api('POST', '/spindle/import-local');
const list = await api('GET', '/spindle'); const exts = Array.isArray(list) ? list : list.extensions || list.data || [];
const mine = exts.find(e => e.identifier === manifest.identifier);
step('extension imported (same identifier as the installed 0.4.x)', !!mine, { identifier: manifest.identifier, version: mine?.version, skipped: imp?.skipped?.length });
if (!mine) await finish(1);
for (const p of manifest.permissions) await api('POST', `/spindle/${mine.id}/permissions`, { grant: [p] });
const en = await api('POST', `/spindle/${mine.id}/enable`, { approved_permissions: manifest.permissions });
const perms = await api('GET', `/spindle/${mine.id}/permissions`);
step('enabled with exactly the manifest permissions', !en.__error && JSON.stringify([...(perms.granted || [])].sort()) === JSON.stringify([...manifest.permissions].sort()), { granted: perms.granted, err: en.__error });
await sleep(2500);

// ---------- fixtures: characters, connection, chats ----------
const mkChar = async name => (await api('POST', '/characters', { name, description: `${name} 테스트 캐릭터`, first_mes: '' }));
const charA = await mkChar('하나'), charB = await mkChar('두리');
const conn = await api('POST', '/connections', { name: 'mock', provider: 'custom', api_url: `http://127.0.0.1:${MOCK}/v1`, model: 'mock-1', is_default: true });
step('fixtures (2 characters, mock connection)', !!charA.id && !!charB.id && !!conn.id, { conn: !!conn.id });
const mkChat = async (name, extra = {}) => api('POST', '/chats', { character_id: charA.id, name, ...extra });
let genWarned = false;
async function turn(chatId, i, text = '한강에서 만나기로 하자', extra = {}) {
    await api('POST', `/chats/${chatId}/messages`, { name: '나', is_user: true, content: `사용자 발화 ${i}: ${text}` });
    const g = await api('POST', '/generate', { chat_id: chatId, ...extra });
    if (g?.__error && !genWarned) { genWarned = true; receipt.notes.push({ generateError: g }); console.log('generate error', JSON.stringify(g).slice(0, 200)); }
    for (let k = 0; k < 40; k++) { await sleep(400); const s = await api('GET', `/generate/status/${chatId}`); if (s && (s.status === 'idle' || s.active === false || (!s.active && !s.generating && !s.status))) break; }
    await sleep(250);
}
const turns = async (chatId, n, from = 1, extraFor = () => ({})) => { for (let i = from; i < from + n; i++) await turn(chatId, i, undefined, extraFor(i)); };
const chatOf = id => api('GET', `/chats/${id}`);
const booksOf = async chat => { const b = await api('GET', '/world-books'); return (b.data || b).filter(x => (x.name || '').includes(chat.name)); };

// ---------- browser ----------
browser = await chromium.launch({ executablePath: CHROMIUM_BIN, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
await context.addCookies(setCookies.map(c => { const [nv] = c.split(';'); const i = nv.indexOf('='); return { name: nv.slice(0, i), value: nv.slice(i + 1), url: BASE }; }));
const page = await context.newPage(); const logs = [], leaked = [];
page.on('console', m => logs.push(`${m.type()}: ${m.text()}`.slice(0, 240))); page.on('pageerror', e => logs.push('pageerror: ' + String(e).slice(0, 240)));
page.on('request', r => { const p = new URL(r.url()).pathname; if (/^\/api\/(?!v\d+\/|auth|ws|spindle)/.test(p) && !r.url().startsWith('data:')) leaked.push(r.method() + ' ' + p); });
const shot = name => page.screenshot({ path: path.join(OUT, `${LABEL}-${name}.png`) }).catch(() => {});
const ui = patch => page.evaluate(async p => { const cur = await (await fetch('/api/_storage')).json(); await fetch('/api/_storage', { method: 'POST', body: JSON.stringify({ patch: { memoryCabinetUiV1: { ...(cur.memoryCabinetUiV1 || {}), ...p } } }) }); }, patch);
const openChat = async (id, how = 'goto') => {
    if (how === 'goto') { await page.goto(`${BASE}/chat/${id}`); await page.waitForSelector('#mmc-launcher-v1', { timeout: 45000 }); await sleep(2500); return 'goto'; }
    await page.evaluate(cid => { history.pushState({}, '', '/chat/' + cid); window.dispatchEvent(new PopStateEvent('popstate')); }, id); await sleep(3500); return 'popstate';
};
const closeOverlay = async () => { await page.evaluate(() => document.getElementById('mvx-close')?.click()); await sleep(300); };
const vault = async fn => { await page.evaluate(() => document.getElementById('mmc-launcher-v1').click()); await sleep(2500); const r = await fn?.(); await page.evaluate(() => document.querySelector('#mmc-root-v1 [data-action="close"]')?.click()); await sleep(300); return r; };

let chatA, aNow, aBooks;
if (want('G')) {
// ===== G. 0.4.x data on the real host: userStorage.list semantics + prompt + backup + import =====
const chatM = await mkChat('이전 대상 RP');
const userDir = readdirSync(path.join(DATA, 'users'))[0];
const oldDir = path.join(DATA, 'users', userDir, 'extensions', manifest.identifier, 'chats', chatM.id);
mkdirSync(oldDir, { recursive: true });
writeFileSync(path.join(oldDir, 'data.json'), JSON.stringify({ version: 1, revision: 4, items: [{ id: 'a', layer: 'promises', text: '한강에서 만나기로 약속했다', scope: 'public', status: 'active', evidence: [], knownBy: [] }, { id: 'b', layer: 'anchors', text: '하나는 왕녀다', scope: 'secret', status: 'active', evidence: [], knownBy: [charA.id] }, { id: 'c', layer: 'scenes', text: '옥상 장면', scope: 'public', status: 'active', evidence: [], knownBy: [] }], candidates: [], undo: [] }));
writeFileSync(path.join(oldDir, 'auto.json'), JSON.stringify({ enabled: true }));
await openChat(chatM.id);
const prompted = await page.waitForSelector('#mvx-migrate', { timeout: 15000 }).then(() => true).catch(() => false);
step('0.4.x data found through the real userStorage.list; migration prompt opened by itself', prompted, { text: prompted ? (await page.textContent('#mvx-migrate')).slice(0, 80) : null });
await shot('migrate-prompt');
if (prompted) {
    const dl = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
    await page.click('#mvx-backup'); const d = await dl;
    let body = null; if (d) { body = JSON.parse(readFileSync(await d.path(), 'utf8')); }
    step('backup file downloaded with all 0.4.x items', !!body && body.chats?.[chatM.id]?.data?.items?.length === 3 && !!body.chats[chatM.id].auto, { name: d?.suggestedFilename(), chats: body && Object.keys(body.chats) });
    await page.click('#mvx-saved'); await sleep(200); await page.click('#mvx-import'); await sleep(3000);
    const m = await chatOf(chatM.id);
    const items = m.metadata?.memoryCabinetV1?.items || [];
    step('one-button import: promises/anchors only, secret stays restricted', items.length === 2 && items.every(i => ['promise', 'anchor'].includes(i.type)) && items.some(i => i.knownBy?.includes(charA.id)), { types: items.map(i => i.type), other: Object.keys(m.metadata || {}).filter(k => k.startsWith('chat_world')) });
    await shot('migrate-imported');
    await closeOverlay();
    await vault(async () => { const txt = await page.evaluate(() => document.getElementById('mmc-root-v1').textContent); step('the pinned original shows the imported items', /한강에서 만나기로 약속했다/.test(txt)); await shot('migrated-vault'); });
}

}
if (want('B') || want('D') || want('E') || want('K')) {   // D/E/K reuse chat A
// ===== B. auto_apply: N turns -> original analyses once -> lorebook; dry-run prompt carries the anchor =====
chatA = await mkChat('자동 적용 RP');
await openChat(chatA.id); await closeOverlay();
await ui({ summaryUpdateMode: 'auto_apply', selectedChatId: chatA.id, modelConnectionId: conn.id });
await page.reload(); await page.waitForSelector('#mmc-launcher-v1', { timeout: 45000 }); await sleep(2500); await closeOverlay();
const before = llm.analysis.length;
await turns(chatA.id, 12); await sleep(9000);
aNow = await chatOf(chatA.id); aBooks = await booksOf(aNow);
step('auto_apply: exactly one analysis call after 12 turns (N=10)', llm.analysis.length - before === 1, { calls: llm.analysis.length - before });
step('auto_apply: lorebook created, attached to the chat, memoryCabinetV1 stored', aBooks.length === 1 && (aNow.metadata.chat_world_book_ids || []).includes(aBooks[0]?.id) && (aNow.metadata.memoryCabinetV1?.items?.length || 0) >= 2, { books: aBooks.map(b => b.name), items: aNow.metadata.memoryCabinetV1?.items?.length });
if (aBooks[0]) { const e = await api('GET', `/world-books/${aBooks[0].id}/entries`); const ents = e.data || e; step('lorebook entries written (promises + anchors)', ents.length >= 2, { count: ents.length }); }
const dry = await api('POST', '/generate/dry-run', { chat_id: chatA.id });
step('the next generation prompt contains the approved anchor (host reads the lorebook)', JSON.stringify(dry).includes('약속 장소는 한강이다'), { err: dry.__error });
await shot('auto-apply');

}
if (want('C')) {
// ===== C. auto_review: nothing written without approval; approve through the original UI =====
const chatC = await mkChat('승인 대기 RP');
await openChat(chatC.id); await closeOverlay();
await ui({ summaryUpdateMode: 'auto_review', selectedChatId: chatC.id });
await page.reload(); await page.waitForSelector('#mmc-launcher-v1', { timeout: 45000 }); await sleep(2500); await closeOverlay();
const bC = llm.analysis.length;
await turns(chatC.id, 12); await sleep(9000);
const cNow = await chatOf(chatC.id);
step('auto_review: analysis ran, candidates pending, no lorebook yet', llm.analysis.length - bC === 1 && !!cNow.metadata.memoryCabinetV1?.pendingReview && (await booksOf(cNow)).length === 0, { calls: llm.analysis.length - bC });
await vault(async () => { await page.evaluate(() => document.querySelector('[data-action="open-review-draft"]')?.click()); await sleep(1500); await shot('review'); await page.evaluate(() => document.querySelector('[data-action="apply-review"]')?.click()); await sleep(6000); });
const cAfter = await chatOf(chatC.id);
step('approval through the original UI creates and attaches the lorebook', (await booksOf(cAfter)).length === 1 && (cAfter.metadata.chat_world_book_ids || []).length >= 1);

}
if (want('D')) {
// ===== D. two chats: switching in the app, each chat gets only its own turns =====
const chatD = await mkChat('두 번째 RP');
await ui({ summaryUpdateMode: 'auto_apply' });
await openChat(chatA.id); await closeOverlay();
const how = await openChat(chatD.id, 'popstate');
const act = await page.evaluate(() => localStorage.getItem('marinara-active-chat-id'));
step('in-app chat switch is followed (active chat id synced to the original)', act === chatD.id, { how, act });
const bD = llm.analysis.length;
await turns(chatD.id, 12, 100); await sleep(9000);
const dNow = await chatOf(chatD.id), dBooks = await booksOf(dNow), aAgain = await chatOf(chatA.id);
const lastAnalysis = llm.analysis.at(-1) || '';
step('chat D analysed on its own turns only (one call, own lorebook, A untouched)', llm.analysis.length - bD === 1 && dBooks.length === 1 && /사용자 발화 10[0-9]/.test(lastAnalysis) && !/자동 적용 RP/.test(lastAnalysis) && aAgain.metadata.memoryCabinetV1.items.length === aNow.metadata.memoryCabinetV1.items.length, { calls: llm.analysis.length - bD });

}
if (want('E')) {
// ===== E. branch of a chat that has memory =====
const msgsA = await api('GET', `/chats/${chatA.id}/messages`); const ml = msgsA.data || msgsA.messages || msgsA;
const cut = ml[Math.max(0, ml.length - 6)];
const branch = await api('POST', `/chats/${chatA.id}/branch`, { message_id: cut?.id, name: '분기 RP' });
step('branch created from a chat with memory', !!branch.id, { err: branch.__error });
if (branch.id) {
    const parentBook = aNow.metadata.chat_world_book_ids || [];
    await openChat(branch.id); await closeOverlay(); await sleep(4000);
    await vault(async () => { await sleep(1500); await shot('branch-vault'); });
    const bNow = await chatOf(branch.id), parentNow = await chatOf(chatA.id);
    const ownerOk = bNow.metadata.memoryCabinetV1?.ownerChatId === branch.id;
    const detached = !(bNow.metadata.chat_world_book_ids || []).some(id => parentBook.includes(id));
    step('branch: original split it off (owner = branch) and detached the parent\'s managed lorebook', ownerOk && detached, { owner: bNow.metadata.memoryCabinetV1?.ownerChatId === branch.id ? 'branch' : bNow.metadata.memoryCabinetV1?.ownerChatId, attached: bNow.metadata.chat_world_book_ids });
    step('branch: the parent kept its own memory untouched', parentNow.metadata.memoryCabinetV1?.ownerChatId === chatA.id && (parentNow.metadata.chat_world_book_ids || []).includes(parentBook[0]));
}

}
if (want('F')) {
// ===== F. group chats (swap + merge): does not crash, analysis works, restricted knownBy entry behaviour recorded =====
for (const mode of ['swap', 'merge']) {
    const g = await api('POST', '/chats', { character_id: charA.id, name: `그룹 ${mode}`, metadata: { group: true, character_ids: [charA.id, charB.id], group_card_mode: mode } });
    if (!g.id) { step(`group chat (${mode}) created`, false, { err: g.__error }); continue; }
    await openChat(g.id); await closeOverlay();
    const bG = llm.analysis.length;
    await turns(g.id, 12, 200, i => ({ target_character_id: i % 2 ? charB.id : charA.id })); await sleep(9000);
    const gNow = await chatOf(g.id), gb = await booksOf(gNow);
    step(`group (${mode}): original runs, analysis once, lorebook attached, no page errors`, llm.analysis.length - bG === 1 && gb.length === 1 && !logs.some(l => /pageerror/.test(l)), { calls: llm.analysis.length - bG });
    if (gb[0]) {
        const made = await page.evaluate(async ([bid, cid]) => { const r = await fetch(`/api/lorebooks/${bid}/entries`, { method: 'POST', body: JSON.stringify({ name: 'knownBy 시험', content: '【비밀·하나만】왕녀 이야기', constant: true, enabled: true, position: 0, depth: 4, role: 'system', order: 40, characterFilterMode: 'include', characterFilterIds: [cid], tag: 'memory-cabinet-restricted' }) }); return r.json(); }, [gb[0].id, charA.id]);
        const seen = {};
        for (const [who, cid] of [['하나(허용)', charA.id], ['두리(비허용)', charB.id]]) { const d = await api('POST', '/generate/dry-run', { chat_id: g.id, target_character_id: cid }); seen[who] = JSON.stringify(d).includes('왕녀 이야기'); }
        receipt.notes.push({ groupMode: mode, restrictedEntryCreated: !!made?.id, visibleTo: seen, expectation: mode === 'swap' ? '허용 인물 차례에만 보여야 함' : '합치기 모드는 {{char}}가 달라 누출/누락 가능(문서화된 한계)' });
        step(`group (${mode}): restricted entry behaviour recorded (not asserted for merge)`, mode === 'swap' ? (seen['하나(허용)'] === true && seen['두리(비허용)'] === false) : true, { seen });
    }
}

}
if (want('K')) {
// ===== single-character knownBy guard on the real macro evaluator =====
{
    const sc = (await booksOf(aNow))[0];
    if (sc) {
        const made = await page.evaluate(async ([bid, cid]) => (await fetch(`/api/lorebooks/${bid}/entries`, { method: 'POST', body: JSON.stringify({ name: '단일 knownBy', content: '【하나 전용】비밀문구', constant: true, enabled: true, position: 0, depth: 4, role: 'system', order: 41, characterFilterMode: 'include', characterFilterIds: [cid] }) })).json(), [sc.id, charA.id]);
        const d1 = JSON.stringify(await api('POST', '/generate/dry-run', { chat_id: chatA.id }));
        const made2 = await page.evaluate(async ([bid, cid]) => (await fetch(`/api/lorebooks/${bid}/entries`, { method: 'POST', body: JSON.stringify({ name: '타인 전용', content: '【두리 전용】다른문구', constant: true, enabled: true, position: 0, depth: 4, role: 'system', order: 42, characterFilterMode: 'include', characterFilterIds: [cid] }) })).json(), [sc.id, charB.id]);
        const d2 = JSON.stringify(await api('POST', '/generate/dry-run', { chat_id: chatA.id }));
        step('single chat: entry restricted to the chat character is injected, entry restricted to another character is not', !!made?.id && !!made2?.id && d1.includes('비밀문구') && !d2.includes('다른문구'), { own: d1.includes('비밀문구'), other: d2.includes('다른문구') });
    }
}

}
step('no /api/ request of the original leaked to the host network', leaked.length === 0, { leaked: leaked.slice(0, 3) });
const errs = logs.filter(l => /pageerror|error/i.test(l) && !/favicon|Failed to load resource|WebSocket|net::ERR|429|404/.test(l));
step('no page errors from the extension', !errs.some(l => /memory|mmc|mvx|기억/i.test(l)), { sample: errs.slice(0, 3) });
receipt.console = logs.filter(l => /mmc|memory|기억|mvx/i.test(l)).slice(0, 15);
await finish(receipt.steps.every(s => s.ok) ? 0 : 1);
