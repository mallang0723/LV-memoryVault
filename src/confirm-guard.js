// The original asks "are you sure?" with window.confirm (delete, discard, undo...). Phones / embedded views can silently suppress it:
// confirm() then returns false at once, without the user ever seeing a dialog, and every such button looks dead.
// This wrapper is a pure pass-through EXCEPT when (a) the call comes from inside the original's own screen and (b) the browser
// obviously did not show a dialog (it threw, or returned false in under BLOCK_MS - no human answers that fast). Then it asks for
// the same action twice: the first press is cancelled with a visible hint, the same press again within WINDOW_MS goes through.
// Anything else (host code, real answers) is untouched.
export const BLOCK_MS = 25, WINDOW_MS = 6000;

export function installConfirmGuard(win, doc, { rootId = 'mmc-root-v1', launcherId = 'mmc-launcher-v1', notify = () => {}, now = () => (win.performance?.now?.() ?? Date.now()) } = {}) {
    const native = win.confirm;
    if (typeof native !== 'function') return { dispose() {}, stats: { blocked: 0 } };
    let inOriginal = false, pending = null;
    const stats = { blocked: 0, accepted: 0 };
    const mark = e => {
        const t = e.target, within = n => { for (; n; n = n.parentNode || n.host) if (n.id === rootId || n.id === launcherId) return true; return false; };
        if (!within(t)) return;
        inOriginal = true;
        win.setTimeout(() => { inOriginal = false; }, 0);   // the confirm() of a click handler runs in the same task
    };
    const EVENTS = ['click', 'change', 'keydown', 'pointerdown', 'submit'];
    for (const ev of EVENTS) doc.addEventListener(ev, mark, true);
    const wrapped = function confirm(message) {
        if (!inOriginal) return native.call(win, message);
        const t0 = now();
        let answer, threw = false;
        try { answer = native.call(win, message); } catch { threw = true; }
        if (!threw && (answer === true || now() - t0 >= BLOCK_MS)) return !!answer;   // a real answer
        const key = String(message ?? '');
        const t = now();
        if (pending && pending.key === key && t - pending.at < WINDOW_MS) { pending = null; stats.accepted++; return true; }
        pending = { key, at: t }; stats.blocked++;
        try { notify('이 브라우저가 확인 창을 막았어요. 같은 버튼을 한 번 더 누르면 실행돼요.', key.slice(0, 120)); } catch { /* hint only */ }
        return false;
    };
    win.confirm = wrapped;
    return {
        stats,
        dispose() { for (const ev of EVENTS) doc.removeEventListener(ev, mark, true); if (win.confirm === wrapped) win.confirm = native; },
    };
}
