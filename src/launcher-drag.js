// Draggable floating launcher (adapter layer). The pinned original creates `#mmc-launcher-v1` (fixed, right edge) and has no drag;
// this module only moves it with inline left/top. Tap still opens the vault (the original's own click handler is untouched).
// Gestures: drag past a small threshold = move (the click that follows is swallowed); long-press (no movement) = back to the default spot.
// Position is stored as fractions of the free area (so it survives resize/rotation) in localStorage, per viewer/device, always try/catch.
export const DRAG_THRESHOLD = 8;     // px of movement before a press becomes a drag
export const LONG_PRESS_MS = 700;    // press-and-hold without moving = reset to default
export const EDGE_GAP = 4;           // px kept between the button and the viewport edge
export const KEY = 'mvx-launcher-pos-v1';

/** Keep a box of size w x h fully inside the viewport minus insets. Returns integer left/top. */
export function clampPos({ x, y }, { w, h }, { vw, vh }, ins = {}, gap = EDGE_GAP) {
    const minX = (ins.left || 0) + gap, minY = (ins.top || 0) + gap;
    const maxX = Math.max(minX, vw - (ins.right || 0) - gap - w), maxY = Math.max(minY, vh - (ins.bottom || 0) - gap - h);
    return { x: Math.round(Math.min(maxX, Math.max(minX, Number.isFinite(x) ? x : maxX))), y: Math.round(Math.min(maxY, Math.max(minY, Number.isFinite(y) ? y : minY))) };
}
/** position -> fractions (0..1) of the free area, and back. */
export function toFrac({ x, y }, size, view, ins = {}, gap = EDGE_GAP) {
    const lo = clampPos({ x: -1e9, y: -1e9 }, size, view, ins, gap), hi = clampPos({ x: 1e9, y: 1e9 }, size, view, ins, gap);
    return { fx: hi.x === lo.x ? 1 : (x - lo.x) / (hi.x - lo.x), fy: hi.y === lo.y ? 0 : (y - lo.y) / (hi.y - lo.y) };
}
export function fromFrac({ fx, fy }, size, view, ins = {}, gap = EDGE_GAP) {
    const lo = clampPos({ x: -1e9, y: -1e9 }, size, view, ins, gap), hi = clampPos({ x: 1e9, y: 1e9 }, size, view, ins, gap);
    const f = v => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
    return clampPos({ x: lo.x + f(fx) * (hi.x - lo.x), y: lo.y + f(fy) * (hi.y - lo.y) }, size, view, ins, gap);
}
export function parseStored(raw) {
    try { const o = JSON.parse(raw); return o && Number.isFinite(o.fx) && Number.isFinite(o.fy) ? { fx: o.fx, fy: o.fy } : null; } catch { return null; }
}

export function installLauncherDrag(win, doc, { id = 'mmc-launcher-v1', notify = () => {}, storage } = {}) {
    const store = { get() { try { return (storage || win.localStorage).getItem(KEY); } catch { return null; } }, set(v) { try { (storage || win.localStorage).setItem(KEY, v); } catch { /* optional */ } }, del() { try { (storage || win.localStorage).removeItem(KEY); } catch { /* optional */ } } };
    let el = null, saved = parseStored(store.get()), probe = null;
    let g = null;              // active gesture
    let swallow = false;       // eat the click that ends a drag / long press

    const insets = () => {
        try {
            if (!probe) { probe = doc.createElement('div'); probe.setAttribute('aria-hidden', 'true'); probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)'; doc.body.append(probe); }
            const s = win.getComputedStyle(probe);
            return { top: parseFloat(s.paddingTop) || 0, right: parseFloat(s.paddingRight) || 0, bottom: parseFloat(s.paddingBottom) || 0, left: parseFloat(s.paddingLeft) || 0 };
        } catch { return {}; }
    };
    const view = () => { return { vw: Math.round(win.innerWidth || doc.documentElement.clientWidth), vh: Math.round(win.innerHeight || doc.documentElement.clientHeight)  }; };
    const size = () => { const r = el.getBoundingClientRect(); return { w: Math.max(44, r.width), h: Math.max(44, r.height) }; };
    const place = p => { el.classList.add('mvx-moved'); const s = el.style; s.setProperty('left', p.x + 'px', 'important'); s.setProperty('top', p.y + 'px', 'important'); s.setProperty('right', 'auto', 'important'); s.setProperty('bottom', 'auto', 'important'); };
    const unplace = () => { el.classList.remove('mvx-moved'); for (const k of ['left', 'top', 'right', 'bottom']) el.style.removeProperty(k); };
    const apply = () => { if (!el) return; if (!saved) { unplace(); return; } const { vw, vh } = view(); place(fromFrac(saved, size(), { vw, vh }, insets())); };

    function reset() { saved = null; store.del(); if (el) unplace(); }

    function onDown(e) {
        if (e.button > 0 || (g && g.id !== e.pointerId)) return;
        const r = el.getBoundingClientRect();
        g = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, dragging: false, long: false, timer: null };
        try { el.setPointerCapture?.(e.pointerId); } catch { /* optional */ }
        g.timer = win.setTimeout(() => { if (g && !g.dragging) { g.long = true; swallow = true; reset(); notify('기억 버튼 위치를 처음으로 돌렸어요.'); } }, LONG_PRESS_MS);
    }
    function onMove(e) {
        if (!g || e.pointerId !== g.id || g.long) return;
        const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
        if (!g.dragging) { if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return; g.dragging = true; win.clearTimeout(g.timer); }
        e.preventDefault?.();
        const { vw, vh } = view();
        place(clampPos({ x: g.ox + dx, y: g.oy + dy }, size(), { vw, vh }, insets()));
    }
    function onUp(e) {
        if (!g || e.pointerId !== g.id) return;
        win.clearTimeout(g.timer);
        try { el.releasePointerCapture?.(e.pointerId); } catch { /* optional */ }
        if (g.dragging && e.type === 'pointerup') {
            const r = el.getBoundingClientRect(), { vw, vh } = view();
            saved = toFrac({ x: r.left, y: r.top }, size(), { vw, vh }, insets());
            store.set(JSON.stringify(saved));
        }
        if (g.dragging || g.long) { swallow = true; win.setTimeout(() => { swallow = false; }, 400); }   // the click event comes right after pointerup
        g = null;
    }
    // capture on window: runs before the original's click handler on the button
    const onClick = e => { if (swallow && el && (e.target === el || el.contains(e.target))) { swallow = false; e.stopImmediatePropagation(); e.preventDefault(); } };
    const onCtx = e => { if (e.target === el || el?.contains?.(e.target)) e.preventDefault(); };   // long-press menu on touch
    const onResize = () => apply();

    function attach(node) {
        if (el === node) return;
        el = node;
        el.style.touchAction = 'none'; el.style.userSelect = 'none'; el.style.setProperty('-webkit-user-select', 'none'); el.style.setProperty('-webkit-touch-callout', 'none');
        el.addEventListener('pointerdown', onDown);
        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', onUp);
        el.addEventListener('pointercancel', onUp);
        apply();
    }
    const scan = () => { const n = doc.getElementById(id); if (n && n !== el) attach(n); else if (!n) el = null; };
    let mo = null;
    try { mo = new win.MutationObserver(scan); mo.observe(doc.body, { childList: true }); } catch { /* fall back to one scan */ }
    scan();
    win.addEventListener('click', onClick, true);
    win.addEventListener('contextmenu', onCtx, true);
    win.addEventListener('resize', onResize);
    win.addEventListener('orientationchange', onResize);
    return {
        reset, apply, get saved() { return saved; },
        dispose() { mo?.disconnect(); win.removeEventListener('click', onClick, true); win.removeEventListener('contextmenu', onCtx, true); win.removeEventListener('resize', onResize); win.removeEventListener('orientationchange', onResize); win.clearTimeout(g?.timer); probe?.remove(); },
    };
}
