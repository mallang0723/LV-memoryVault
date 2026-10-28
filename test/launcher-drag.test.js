// Right-edge launcher: vertical clamp / safe area / persistence / gestures (fake DOM, no layout engine).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampPos, toFrac, fromFrac, parseStored, installLauncherDrag, KEY, DRAG_THRESHOLD, LONG_PRESS_MS } from '../src/launcher-drag.js';

const SIZE = { h: 58 }, VIEW = { vh: 844 };
test('vertical clamp respects safe-area insets plus the 4px gap', () => {
    assert.deepEqual(clampPos({ x: -50, y: -50 }, SIZE, VIEW, { top: 47 }), { y: 51 });
    assert.deepEqual(clampPos({ x: 999, y: 999 }, SIZE, VIEW, { bottom: 34 }), { y: 844 - 34 - 4 - 58 });
    assert.deepEqual(clampPos({ y: NaN }, SIZE, { vh: 30 }), { y: 4 }, 'viewport smaller than the button: pinned, no throw');
});
test('vertical fractions round-trip, survive resize, and stay clamped', () => {
    const f = toFrac({ y: 400 }, SIZE, VIEW, { top: 47, bottom: 34 });
    assert.deepEqual(Object.keys(f), ['fy']);
    assert.ok(Math.abs(fromFrac(f, SIZE, VIEW, { top: 47, bottom: 34 }).y - 400) <= 1);
    const small = fromFrac(f, SIZE, { vh: 480 }, { top: 47, bottom: 34 });
    assert.ok(small.y >= 51 && small.y <= 480 - 34 - 4 - 58);
    assert.deepEqual(fromFrac({ fy: -10 }, SIZE, VIEW), { y: 4 });
    assert.deepEqual(fromFrac({ fy: 10 }, SIZE, VIEW), { y: 782 });
    assert.deepEqual(toFrac({ y: 999 }, SIZE, { vh: 30 }), { fy: 0 });
});
test('stored positions accept only finite y fractions, ignoring legacy x', () => {
    for (const raw of ['garbage', 'null', '{}', '{"fx":1}', '{"fy":"0.5"}', '{"fy":1e999}']) assert.equal(parseStored(raw), null);
    assert.deepEqual(parseStored('{"fy":0.5}'), { fy: 0.5 });
    assert.deepEqual(parseStored('{"fx":0.2,"fy":0.5}'), { fy: 0.5 });
    assert.deepEqual(parseStored('{"fx":"bad","fy":0.5}'), { fy: 0.5 });
});

function fakeEnv(stored, { top = 0, bottom = 0, height = 58 } = {}) {
    const timers = []; let now = 0, observer;
    const mem = new Map(stored ? [[KEY, stored]] : []);
    const wl = {};
    const win = { innerWidth: 390, innerHeight: 844, getComputedStyle: () => ({ paddingTop: `${top}px`, paddingBottom: `${bottom}px` }), addEventListener: (t, f) => { wl[t] = f; }, removeEventListener() {}, setTimeout: (f, ms) => { timers.push({ f, at: now + ms }); return timers.length; }, clearTimeout: i => { if (timers[i - 1]) timers[i - 1].f = null; }, MutationObserver: class { constructor(f) { observer = f; } observe() {} disconnect() {} } };
    const makeLauncher = () => {
        const listeners = {}, cls = new Set();
        const style = { m: {}, setProperty(k, v) { this.m[k] = v; }, removeProperty(k) { delete this.m[k]; } };
        const rect = () => ({ left: parseFloat(style.m.left ?? win.innerWidth - 46), top: parseFloat(style.m.top ?? win.innerHeight * 0.44), width: 46, height });
        const el = { id: 'mmc-launcher-v1', style, classList: { add: c => cls.add(c), remove: c => cls.delete(c), has: c => cls.has(c) }, contains: n => n === el, getBoundingClientRect: rect, setPointerCapture() {}, releasePointerCapture() {}, addEventListener(t, f) { listeners[t] = e => f({ type: t, ...e }); } };
        return { el, listeners, style, cls };
    };
    let current = makeLauncher();
    const probe = { style: {}, setAttribute() {}, remove() {} };
    const doc = { body: { append() {} }, documentElement: { clientWidth: 390, clientHeight: 844 }, getElementById: id => (id === current?.el.id ? current.el : null), createElement: () => probe };
    const advance = ms => { now += ms; for (const t of timers) if (t.f && t.at <= now) { const f = t.f; t.f = null; f(); } };
    const ev = (o = {}) => ({ pointerId: 1, button: 0, preventDefault() {}, ...o });
    const click = () => { let opened = true; const e = { target: current.el, stopImmediatePropagation() { opened = false; }, preventDefault() {} }; wl.click(e); return opened; };
    return { win: Object.assign(win, { localStorage: { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: k => mem.delete(k) } }), doc, ...current, mem, advance, ev, click, wl,
        replace() { current = null; observer(); current = makeLauncher(); observer(); return current; } };
}
function assertDocked({ el, style, cls }, width = 390) {
    assert.equal(style.m.left, undefined);
    assert.equal(style.m.right, undefined, 'original CSS keeps right:0');
    assert.equal(el.getBoundingClientRect().left, width - 46);
    assert.equal(cls.has('mvx-moved'), false, 'original tab shape is preserved');
}

test('tap and movement below the threshold still open the vault and store nothing', () => {
    const E = fakeEnv(); installLauncherDrag(E.win, E.doc);
    E.listeners.pointerdown(E.ev({ clientX: 360, clientY: 400 })); E.listeners.pointerup(E.ev());
    assert.equal(E.click(), true);
    E.listeners.pointerdown(E.ev({ clientX: 360, clientY: 400 }));
    E.listeners.pointermove(E.ev({ clientX: 360 + DRAG_THRESHOLD - 2, clientY: 400 })); E.listeners.pointerup(E.ev());
    assert.equal(E.click(), true); assert.equal(E.mem.size, 0);
});
test('horizontal drag crosses the unchanged threshold but cannot move the tab horizontally', () => {
    const E = fakeEnv(); installLauncherDrag(E.win, E.doc);
    const before = E.el.getBoundingClientRect();
    E.listeners.pointerdown(E.ev({ clientX: 360, clientY: 400 }));
    E.listeners.pointermove(E.ev({ clientX: 360 - DRAG_THRESHOLD, clientY: 400 }));
    assert.equal(E.el.getBoundingClientRect().top, Math.round(before.top)); assertDocked(E);
    E.advance(LONG_PRESS_MS + 1); E.listeners.pointerup(E.ev());
    assert.equal(E.click(), false); assert.ok(E.mem.has(KEY), 'drag cancels long-press reset');
});
test('drag clamps vertically, saves only y, suppresses the trailing click, restores and re-clamps on resize', () => {
    const E = fakeEnv(undefined, { top: 47, bottom: 34 }); const d = installLauncherDrag(E.win, E.doc);
    E.listeners.pointerdown(E.ev({ clientX: 360, clientY: 400 }));
    E.listeners.pointermove(E.ev({ clientX: -100, clientY: -5000 }));
    assert.equal(E.style.m.top, '51px'); assertDocked(E);
    E.listeners.pointermove(E.ev({ clientX: 100, clientY: 5000 }));
    assert.equal(E.style.m.top, '748px'); assertDocked(E);
    E.listeners.pointerup(E.ev());
    assert.equal(E.click(), false); assert.equal(E.click(), true);
    assert.deepEqual(JSON.parse(E.mem.get(KEY)), { fy: 1 }); d.dispose();
    const F = fakeEnv(E.mem.get(KEY), { top: 47, bottom: 34 }); installLauncherDrag(F.win, F.doc);
    assert.equal(F.style.m.top, E.style.m.top); assertDocked(F);
    F.win.innerWidth = 300; F.win.innerHeight = 500; F.wl.resize();
    assert.equal(F.style.m.top, '404px'); assertDocked(F, 300);
    F.win.innerHeight = 480; F.wl.orientationchange(); assert.equal(F.style.m.top, '384px');
});
test('legacy x/y restores only y and the next drag persists only y', () => {
    const E = fakeEnv('{"fx":0.2,"fy":0.5}'); const d = installLauncherDrag(E.win, E.doc);
    assert.deepEqual(d.saved, { fy: 0.5 }); assert.equal(E.style.m.top, '393px'); assertDocked(E);
    E.listeners.pointerdown(E.ev({ clientX: 360, clientY: 400 }));
    E.listeners.pointermove(E.ev({ clientX: 20, clientY: 420 })); E.listeners.pointerup(E.ev());
    assert.deepEqual(Object.keys(JSON.parse(E.mem.get(KEY))), ['fy']); assertDocked(E);
});
test('700ms long press resets to the default spot and swallows the following click', () => {
    const E = fakeEnv('{"fy":0.5}'); let said = ''; installLauncherDrag(E.win, E.doc, { notify: m => { said = m; } });
    E.listeners.pointerdown(E.ev({ clientX: 360, clientY: 400 })); E.advance(LONG_PRESS_MS - 1);
    assert.ok(E.mem.has(KEY)); E.advance(1); E.listeners.pointerup(E.ev());
    assert.equal(E.style.m.top, undefined); assert.equal(E.style.m.bottom, undefined);
    assert.equal(E.mem.size, 0); assertDocked(E); assert.match(said, /처음/); assert.equal(E.click(), false);
});
test('default and reset positions also respect the safe area and minimum 44px target on resize', () => {
    const E = fakeEnv(undefined, { top: 47, bottom: 34, height: 20 }); const d = installLauncherDrag(E.win, E.doc);
    E.win.innerHeight = 130; E.wl.resize(); assert.equal(E.style.m.top, '51px');
    d.reset(); assert.equal(E.style.m.top, '51px'); assertDocked(E);
    E.win.innerHeight = 844; E.wl.resize(); assert.equal(E.style.m.top, undefined, 'default CSS position returns when it fits');
});
test('MutationObserver re-attaches gestures and saved height to a replacement launcher', () => {
    const E = fakeEnv('{"fx":0,"fy":1}'); installLauncherDrag(E.win, E.doc);
    const replacement = E.replace(); assert.equal(replacement.style.m.top, '782px'); assertDocked(replacement);
    replacement.listeners.pointerdown(E.ev({ clientX: 360, clientY: 800 }));
    replacement.listeners.pointermove(E.ev({ clientX: 50, clientY: 700 })); replacement.listeners.pointerup(E.ev());
    assert.equal(replacement.style.m.top, '682px'); assert.equal(E.click(), false); assertDocked(replacement);
});
test('unavailable localStorage does not prevent dragging or resetting', () => {
    const E = fakeEnv(); Object.defineProperty(E.win, 'localStorage', { get() { throw new Error('blocked'); } });
    const d = installLauncherDrag(E.win, E.doc);
    E.listeners.pointerdown(E.ev({ clientX: 360, clientY: 400 }));
    E.listeners.pointermove(E.ev({ clientX: 100, clientY: 500 })); E.listeners.pointerup(E.ev());
    assert.ok(d.saved); assertDocked(E); d.reset(); assert.equal(d.saved, null);
});
