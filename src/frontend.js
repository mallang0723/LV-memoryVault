import { installShim } from './shim.js';
import { installConfirmGuard } from './confirm-guard.js';
import { createPanel } from './panel.js';
import { installHostTheme } from './host-theme.js';
import { installLauncherDrag } from './launcher-drag.js';
import { runOriginal, ORIGINAL_CSS } from './original.generated.js';

export function setup(ctx, { win = globalThis.window, doc = globalThis.document } = {}) {
    // Lumiverse's active chat. getActiveChat is sync and present in current hosts; older ones fall back to the runtime state.
    const activeId = () => { try { const c = ctx.getActiveChat?.(); if (c && typeof c.chatId === 'string') return c.chatId; } catch { /* older host */ } try { return ctx.state?.get?.('chat.active')?.chatId || ''; } catch { return ''; } };
    const syncKey = () => { try { const id = activeId(); if (id) win.localStorage.setItem('marinara-active-chat-id', id); } catch { /* optional */ } };   // the original's "chat on screen"
    const shim = installShim(ctx, { win, activeChatId: activeId });
    const panel = createPanel(ctx, shim, { win, doc });
    const guard = installConfirmGuard(win, doc, { notify: (m, d) => panel.toast(m, d) });
    const style = doc.createElement('style');
    style.textContent = ORIGINAL_CSS;
    (doc.head || doc.documentElement).append(style);
    const hostTheme = installHostTheme(win, doc);   // after the original css: same specificity, last one wins

    const drag = installLauncherDrag(win, doc, { notify: (m, d) => panel.toast(m, d) });   // moves the original's floating tab; tap still opens
    let run = null, runFor = '', timer = null, alive = true;
    const mount = () => { syncKey(); runFor = activeId(); run = shim.createMarinara(); runOriginal(run.marinara); };   // the pinned original, byte-identical
    const modalOpen = () => { const r = doc.getElementById('mmc-root-v1'); return !!r && !r.hidden; };
    // The original auto-processes only its selected chat. On a chat switch re-run it so it selects the active one (same as opening the vault there).
    const onSwitch = () => {
        clearTimeout(timer);
        if (!alive || activeId() === runFor) return;
        if (modalOpen()) { timer = setTimeout(onSwitch, 2000); return; }   // never tear the original down under an open screen
        run?.runCleanups(); mount();
    };
    mount();
    const offs = [];
    for (const ev of ['CHAT_SWITCHED', 'CHAT_CHANGED']) { try { const o = ctx.events?.on?.(ev, () => { timer = setTimeout(onSwitch, 0); }); if (typeof o === 'function') offs.push(o); } catch { /* optional */ } }
    try { const o = ctx.state?.subscribe?.('chat.active', () => { timer = setTimeout(onSwitch, 0); }); if (typeof o === 'function') offs.push(o); } catch { /* optional */ }
    void panel.promptIfMigrationPending();   // after an upgrade from 0.4.x: offer backup + import once per page load
    return () => { alive = false; clearTimeout(timer); offs.forEach(o => { try { o(); } catch { /* ignore */ } }); run?.runCleanups(); guard.dispose(); drag.dispose(); hostTheme.dispose(); panel.dispose(); shim.dispose(); style.remove(); };
}
