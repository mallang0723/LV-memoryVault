// Draggable launcher: clamp / safe area / fractions / persist / tap-vs-drag / long-press reset (fake DOM, no layout engine).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampPos, toFrac, fromFrac, parseStored, installLauncherDrag, KEY, DRAG_THRESHOLD, LONG_PRESS_MS } from '../src/launcher-drag.js';

const SIZE = { w: 46, h: 58 }, VIEW = { vw: 390, vh: 844 };
test('clamp: stays inside the viewport minus safe-area insets', () => {
    assert.deepEqual(clampPos({ x: -50, y: -50 }, SIZE, VIEW, { top: 47, left: 0 }), { x: 4, y: 51 });
    assert.deepEqual(clampPos({ x: 999, y: 999 }, SIZE, VIEW, { bottom: 34, right: 10 }), { x: 390 - 10 - 4 - 46, y: 844 - 34 - 4 - 58 });
    assert.deepEqual(clampPos({ x: NaN, y: NaN }, SIZE, { vw: 30, vh: 30 }), { x: 4, y: 4 }, 'viewport smaller than the button: pinned, no throw');
});
test('fractions survive a resize and stay clamped', () => {
    const f = toFrac({ x: 340, y: 400 }, SIZE, VIEW);
    const back = fromFrac(f, SIZE, VIEW);
    assert.ok(Math.abs(back.x - 340) <= 1 && Math.abs(back.y - 400) <= 1);
    const small = fromFrac(f, SIZE, { vw: 320, vh: 480 });
    assert.ok(small.x >= 4 && small.x <= 320 - 4 - 46 && small.y >= 4 && small.y <= 480 - 4 - 58);
    assert.equal(parseStored('garbage'), null); assert.equal(parseStored('{"fx":"a"}'), null); assert.deepEqual(parseStored('{"fx":1,"fy":0.5}'), { fx: 1, fy: 0.5 });
});

function fakeEnv(stored) {
    const listeners = {}, timers = []; let now = 0;
    const mem = new Map(stored ? [[KEY, stored]] : []);
    const style = { m: {}, setProperty(k, v) { this.m[k] = v; }, removeProperty(k) { delete this.m[k]; } };
    const rect = () => ({ left: parseFloat(style.m.left ?? 344), top: parseFloat(style.m.top ?? 372), width: 46, height: 58 });
    const cls = new Set(), el = { id: 'mmc-launcher-v1', style, classList: { add: c => cls.add(c), remove: c => cls.delete(c), has: c => cls.has(c) }, contains: n => n === el, getBoundingClientRect: rect, setPointerCapture() {}, releasePointerCapture() {}, addEventListener(t, f) { listeners[t] = e => f({ type: t, ...e }); } };
    const probe = { style: {}, setAttribute() {}, remove() {} };
    const doc = { body: { append() {} }, documentElement: { clientWidth: 390, clientHeight: 844 }, getElementById: id => (id === el.id ? el : null), createElement: () => probe };
    const wl = {};
    const win = { innerWidth: 390, innerHeight: 844, getComputedStyle: () => ({ paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px' }), addEventListener: (t, f) => { wl[t] = f; }, removeEventListener() {}, setTimeout: (f, ms) => { timers.push({ f, at: now + ms }); return timers.length; }, clearTimeout: i => { if (timers[i - 1]) timers[i - 1].f = null; }, MutationObserver: class { observe() {} disconnect() {} } };
    const advance = ms => { now += ms; for (const t of timers) if (t.f && t.at <= now) { const f = t.f; t.f = null; f(); } };
    const ev = (o = {}) => ({ pointerId: 1, button: 0, preventDefault() {}, ...o });
    const click = () => { let opened = true; const e = { target: el, stopImmediatePropagation() { opened = false; }, preventDefault() {} }; wl.click(e); return opened; };
    return { win: Object.assign(win, { localStorage: { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: k => mem.delete(k) } }), doc, el, listeners, style, cls, mem, advance, ev, click, wl };
}

test('tap (no movement) is not swallowed and stores nothing', () => {
    const E = fakeEnv(); installLauncherDrag(E.win, E.doc);
    E.listeners.pointerdown(E.ev({ clientX: 360, clientY: 400 })); E.listeners.pointerup(E.ev({ clientX: 360, clientY: 400 }));
    assert.equal(E.click(), true, 'original click handler still runs'); assert.equal(E.mem.size, 0);
    E.listeners.pointerdown(E.ev({ clientX: 360, clientY: 400 })); E.listeners.pointermove(E.ev({ clientX: 360 + DRAG_THRESHOLD - 2, clientY: 400 })); E.listeners.pointerup(E.ev());
    assert.equal(E.click(), true, 'jitter under the threshold is still a tap');
});
test('drag: moves, clamps, persists, swallows the trailing click; restored on a fresh load', () => {
    const E = fakeEnv(); const d = installLauncherDrag(E.win, E.doc);
    E.listeners.pointerdown(E.ev({ clientX: 360, clientY: 400 }));
    E.listeners.pointermove(E.ev({ clientX: 100, clientY: 5000 }));
    assert.equal(E.style.m.left, '100px'.replace('100', String(344 - 260))); assert.equal(E.style.m.top, String(844 - 4 - 58) + 'px', 'clamped to the bottom edge');
    assert.equal(E.style.m.right, 'auto'); assert.ok(E.cls.has('mvx-moved'));
    E.listeners.pointerup(E.ev());
    assert.equal(E.click(), false, 'click after a drag does not open the vault'); assert.equal(E.click(), true, 'next tap opens it');
    const stored = parseStored(E.mem.get(KEY)); assert.ok(stored); d.dispose();
    const F = fakeEnv(E.mem.get(KEY)); installLauncherDrag(F.win, F.doc);
    assert.equal(F.style.m.left, E.style.m.left); assert.equal(F.style.m.top, E.style.m.top);
    F.win.innerWidth = 300; F.win.innerHeight = 500; F.wl.resize();
    assert.ok(parseFloat(F.style.m.left) <= 300 - 4 - 46 && parseFloat(F.style.m.top) <= 500 - 4 - 58, 'resize re-clamps');
});
test('long press without moving resets to the default spot (and a following click is swallowed)', () => {
    const E = fakeEnv(JSON.stringify({ fx: 0.2, fy: 0.5 })); let said = ''; installLauncherDrag(E.win, E.doc, { notify: m => { said = m; } });
    assert.ok(E.style.m.left, 'restored position applied');
    E.listeners.pointerdown(E.ev({ clientX: 100, clientY: 100 })); E.advance(LONG_PRESS_MS + 1); E.listeners.pointerup(E.ev({ clientX: 100, clientY: 100 }));
    assert.equal(E.style.m.left, undefined); assert.equal(E.mem.size, 0); assert.ok(!E.cls.has('mvx-moved')); assert.match(said, /처음/);
    assert.equal(E.click(), false);
});
