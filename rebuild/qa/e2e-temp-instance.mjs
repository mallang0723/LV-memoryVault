// Real-host e2e against a TEMPORARY Lumiverse instance (scratch data dir, throwaway owner, mock OpenAI-compatible LLM).
// env: BASE (http://127.0.0.1:7895), USER, PASS, CONN_ID, PW (path to playwright-core index.mjs), OUT (receipt dir), MODE (auto_apply|auto_review)
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
const { BASE, USER, PASS, CONN_ID, PW, OUT, MODE = 'auto_apply' } = process.env;
const { chromium } = await import(pathToFileURL(PW).href);
mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const receipt = { mode: MODE, steps: [] };
const step = (name, ok, extra = {}) => { receipt.steps.push({ name, ok, ...extra }); console.log(ok ? 'OK  ' : 'FAIL', name, JSON.stringify(extra).slice(0, 200)); };

const login = await fetch(`${BASE}/api/auth/sign-in/username`, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ username: USER, password: PASS }) });
const cookie = login.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
const api = async (method, path, body) => { const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { cookie, origin: BASE, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

const chars = await api('GET', '/characters?limit=5'); const char = (chars.data || chars)[0];
const chat = await api('POST', '/chats', { character_id: char.id, name: `spike-${MODE}-${Date.now()}` });
step('chat created', !!chat.id, { chatId: chat.id });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN || '/usr/bin/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
await ctx.addCookies(login.headers.getSetCookie().map(c => { const [nv] = c.split(';'); const i = nv.indexOf('='); return { name: nv.slice(0, i), value: nv.slice(i + 1), url: BASE }; }));
await ctx.addInitScript(({ MODE, chatId, CONN_ID }) => { try { localStorage.setItem('marinara.memoryCabinet.ui.v1', JSON.stringify({ summaryUpdateMode: MODE, selectedChatId: chatId, modelConnectionId: CONN_ID })); localStorage.setItem('marinara-active-chat-id', chatId); } catch {} }, { MODE, chatId: chat.id, CONN_ID });
const page = await ctx.newPage();
const logs = []; page.on('console', m => logs.push(`${m.type()}: ${m.text()}`.slice(0, 300))); page.on('pageerror', e => logs.push('pageerror: ' + String(e).slice(0, 300)));
const fetchedApi = []; page.on('request', r => { if (/\/api\/(?!v1\/|auth|ws)/.test(new URL(r.url()).pathname)) fetchedApi.push(r.url()); });
await page.goto(`${BASE}/chat/${chat.id}`);
const launcher = await page.waitForSelector('#mmc-launcher, .mmc-launcher', { timeout: 40000 }).catch(() => null);
step('original launcher mounted in Lumiverse page', !!launcher);
await sleep(2500);   // original primes itself ~900 ms after load (baseline)

async function turn(i) {
  await api('POST', `/chats/${chat.id}/messages`, { name: '나', is_user: true, content: `사용자 발화 ${i}: 한강에서 만나기로 하자` });
  const g = await api('POST', '/generate', { chat_id: chat.id });
  for (let k = 0; k < 60; k++) { await sleep(500); const s = await api('GET', `/generate/status/${chat.id}`); if (!s?.active && !s?.generating && !s?.status) break; if (s && (s.status === 'idle' || s.active === false)) break; }
  return g;
}
let first; for (let i = 1; i <= 12; i++) { const g = await turn(i); if (i === 1) first = g; await sleep(300); }
step('12 real generations completed (mock LLM)', true, { sample: JSON.stringify(first).slice(0, 120) });
await sleep(8000);   // trigger delay (1.5 s) + original's analysis + lorebook sync

const books = await api('GET', '/world-books'); const bl = (books.data || books);
const mine = bl.filter(b => (b.name || '').includes(chat.name));
step(MODE === 'auto_apply' ? 'lorebook created by the original' : 'auto_review: no lorebook written without approval', MODE === 'auto_apply' ? mine.length > 0 : mine.length === 0, { books: mine.map(b => b.name) });
let entries = [];
if (mine[0]) { const e = await api('GET', `/world-books/${mine[0].id}/entries`); entries = e.data || e; step('entries written', entries.length > 0, { count: entries.length, comments: entries.map(x => x.comment).slice(0, 6) }); }
const chatNow = await api('GET', `/chats/${chat.id}`);
step('memoryCabinetV1 + chat_world_book_ids in chat metadata', MODE === 'auto_apply' ? !!chatNow.metadata?.memoryCabinetV1?.items?.length && (chatNow.metadata.chat_world_book_ids || []).length > 0 : !!chatNow.metadata?.memoryCabinetV1?.pendingReview, { keys: Object.keys(chatNow.metadata || {}) });
step('no /api/ request leaked to the host network', fetchedApi.length === 0, { leaked: fetchedApi.slice(0, 3) });
await page.screenshot({ path: `${OUT}/after-${MODE}.png` });
receipt.console = logs.filter(l => /error|mmc|기억|memory/i.test(l)).slice(0, 15);
await browser.close();
writeFileSync(`${OUT}/e2e-${MODE}.json`, JSON.stringify(receipt, null, 1));
process.exit(receipt.steps.every(s => s.ok) ? 0 : 1);
