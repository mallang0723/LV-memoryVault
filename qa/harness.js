// Browser QA stub of the Lumiverse frontend: the built dist/frontend.js runs against stand-ins for the input-bar Extras menu and the
// events; its backend channel goes to the QA script's node process (qa/backend-env.mjs: the real backend entry on the fake Spindle
// host) through /__rpc and /__poll. No model, no external network.
import { setup } from '../dist/frontend.js';

const USER = 'qa-user';
let toFrontend = null;
const handlers = new Map();
let activeChat = 'chat-a';
const state = { 'chat.active': { chatId: 'chat-a', characterId: 'char-haru' } };
const actions = [];
const extrasMenu = document.getElementById('extras-menu');

async function post(url, body) { const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return r.json(); }
const TAB = 't' + Math.random().toString(36).slice(2, 10);   // no crypto.randomUUID: this page also runs on an insecure origin
let polling = true;
(async function poll() {
    while (polling) {
        try { const { events } = await (await fetch('./__poll?tab=' + TAB)).json(); for (const m of events || []) toFrontend?.(m); } catch { /* page closing */ }
        await new Promise(r => setTimeout(r, 200));
    }
})();
const ctx = {
    ui: {
        registerInputBarAction(o) {
            const hs = new Set();
            const b = document.createElement('button'); b.textContent = o.label; b.dataset.action = o.id;
            b.addEventListener('click', () => { extrasMenu.classList.remove('on'); for (const h of hs) h(); });
            extrasMenu.append(b);
            const a = { options: o, onClick(fn) { hs.add(fn); return () => hs.delete(fn); }, destroy() { b.remove(); } };
            actions.push(a);
            return a;
        },
    },
    events: { on(event, fn) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); return () => handlers.get(event).delete(fn); } },
    getActiveChat: () => ({ chatId: activeChat, characterId: 'char-haru' }),
    state: { get: k => state[k], subscribe() { return () => {}; } },
    onBackendMessage(fn) { toFrontend = fn; return () => { toFrontend = null; }; },
    sendToBackend(m) { post('./__rpc', { frame: JSON.parse(JSON.stringify(m)), user: USER }).then(({ replies }) => { for (const r of replies || []) toFrontend?.(r); }).catch(() => {}); },
};
document.getElementById('extras-btn').addEventListener('click', () => extrasMenu.classList.toggle('on'));
const hostThemes = await (await fetch('./host-themes.json')).json();
function setTheme(name) {
    const set = hostThemes[name]; if (!set) throw Error('unknown theme ' + name);
    const root = document.documentElement;
    for (const p of [...root.style]) if (p.startsWith('--lumiverse-')) root.style.removeProperty(p);
    for (const [k, v] of Object.entries(set)) root.style.setProperty(k, v);
    document.body.style.background = set['--lumiverse-bg-deep'] || '';
}
setTheme('default-dark');
let dispose = null;
const mount = () => { dispose = setup(ctx); };
mount();
window.qa = {
    ctx, setTheme, actions, themes: Object.keys(hostThemes).filter(k => !k.startsWith('_')),
    env: () => ({ secure: window.isSecureContext, randomUUID: typeof crypto?.randomUUID, subtle: typeof crypto?.subtle, clipboard: typeof navigator.clipboard, share: typeof navigator.share, storage: typeof navigator.storage, origin: location.origin }),
    clickAction(id) { document.querySelector(`#extras-menu [data-action="${id}"]`).click(); },
    switchChat(chatId) { activeChat = chatId; state['chat.active'] = { chatId, characterId: null }; for (const fn of handlers.get('CHAT_SWITCHED') || []) fn({ chatId }); },
    remount() { dispose?.(); actions.length = 0; extrasMenu.replaceChildren(); mount(); },
    unmount() { dispose?.(); dispose = null; actions.length = 0; extrasMenu.replaceChildren(); },
    mount() { if (!dispose) mount(); },
    stop() { polling = false; },
    ready: true,
};
