// The original's "따르기" theme reads Marinara's CSS variables (--background, --card, --foreground ...). Lumiverse has none of them, so the
// original fell back to its light defaults whatever the host looked like. This maps the host's own theme variables onto those names, but
// ONLY for the original's three nodes in "follow" mode (a generated <style>), so nothing else on the page is touched.
// Colours are resolved through the browser (computed colour of a probe), composited over the host background, and text/accent inks are
// picked for >= 4.5:1. Recomputed when the host's theme attributes change.
const SEL = ['#mmc-root-v1', '.mmc-launcher', '.mmc-toast'].map(s => `${s}[data-mmc-theme="marinara"]`).join(',');
const num = c => (String(c).match(/-?[\d.]+(?:e-?\d+)?/g) || []).map(Number);
function parse(c) { const n = num(c); if (n.length < 3) return null; const k = /^color\(/.test(c) ? 255 : 1; return { r: n[0] * k, g: n[1] * k, b: n[2] * k, a: n[3] === undefined ? 1 : n[3] }; }
const over = (c, b) => ({ r: c.r * c.a + b.r * (1 - c.a), g: c.g * c.a + b.g * (1 - c.a), b: c.b * c.a + b.b * (1 - c.a), a: 1 });
const lum = c => { const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(c.r) + .7152 * f(c.g) + .0722 * f(c.b); };
export const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
const css = c => `rgb(${Math.round(c.r)} ${Math.round(c.g)} ${Math.round(c.b)})`;
const WHITE = { r: 255, g: 255, b: 255, a: 1 }, BLACK = { r: 20, g: 18, b: 32, a: 1 };
/** push `fg` away from the surfaces (lighter on a dark theme, darker on a light one) until it reads at >= `min`:1 on every one of them */
function readable(fg, surfaces, min = 4.6) { const list = [].concat(surfaces); const dark = lum(list[0]) < .4; let c = fg, i = 0; while (list.some(b => contrast(c, b) < min) && i++ < 64) { const d = dark ? 6 : -6; c = { ...c, r: Math.max(0, Math.min(255, c.r + d)), g: Math.max(0, Math.min(255, c.g + d)), b: Math.max(0, Math.min(255, c.b + d)) }; } return c; }
const mixc = (a, b, p) => ({ r: a.r * p + b.r * (1 - p), g: a.g * p + b.g * (1 - p), b: a.b * p + b.b * (1 - p), a: 1 });

export function installHostTheme(win, doc) {
    const style = doc.createElement('style'); style.id = 'mvx-host-theme'; (doc.head || doc.documentElement).append(style);
    let timer = null, observer = null, last = '';
    function resolve(varName, fallback) {
        try {
            const p = doc.createElement('span'); p.style.cssText = `position:absolute;visibility:hidden;color:var(${varName},${fallback})`; doc.body.append(p);
            const c = parse(win.getComputedStyle(p).color); p.remove(); return c;
        } catch { return null; }
    }
    function update() {
        try {
            if (!win.getComputedStyle) return;
            const deep = resolve('--lumiverse-bg-deep', '#faf8ff') || { r: 250, g: 248, b: 255, a: 1 }; deep.a = 1;
            const bg = over(resolve('--lumiverse-bg', '#faf8ff') || deep, deep);
            const card = over(resolve('--lumiverse-bg-elevated', '#ffffff') || bg, bg);
            const dark = lum(bg) < .4;
            const fg = readable(over(resolve('--lumiverse-text', '#1a1025') || BLACK, bg), [bg, card], 7);
            const sunk = mixc(bg, fg, .9), paper2 = mixc(card, fg, .94);
            const muted = readable(over(resolve('--lumiverse-text-muted', '#5d5c75') || fg, card), [bg, card, sunk, paper2, mixc(bg, fg, .8)]);
            const border = over(resolve('--lumiverse-border', 'rgba(128,128,128,.3)') || { r: 128, g: 128, b: 128, a: .3 }, card);
            const ink = dark ? BLACK : WHITE;   // text on filled accent buttons
            // the accent is both a button fill (with `ink` on it) and a text colour on the card / tinted surfaces: push it until it works for both
            let primary = over(resolve('--lumiverse-primary', '#5b5fb5') || { r: 91, g: 95, b: 181, a: 1 }, bg), n = 0;
            while ((contrast(ink, primary) < 4.7 || contrast(primary, card) < 4.6 || contrast(primary, bg) < 4.6 || contrast(primary, mixc(primary, card, .15)) < 4.6) && n++ < 64) { const d = dark ? 5 : -5; primary = { ...primary, r: Math.max(0, Math.min(255, primary.r + d)), g: Math.max(0, Math.min(255, primary.g + d)), b: Math.max(0, Math.min(255, primary.b + d)) }; }
            const accentText = primary;
            const tone = { ok: dark ? { r: 126, g: 224, b: 160, a: 1 } : { r: 26, g: 102, b: 68, a: 1 }, warn: dark ? { r: 255, g: 207, b: 138, a: 1 } : { r: 138, g: 75, b: 0, a: 1 }, bad: dark ? { r: 255, g: 154, b: 147, a: 1 } : { r: 179, g: 38, b: 30, a: 1 }, hold: dark ? { r: 214, g: 201, b: 150, a: 1 } : { r: 107, g: 93, b: 50, a: 1 } };
            const body = `--background:${css(bg)};--card:${css(card)};--foreground:${css(fg)};--muted-foreground:${css(muted)};--border:${css(border)};--primary:${css(primary)};--primary-foreground:${css(ink)};--success:${css(tone.ok)};--destructive:${css(tone.bad)};--mv-warn:${css(tone.warn)};--mv-hold:${css(tone.hold)};--mv-wiki-link:${css(accentText)};--mv-wiki-head-ink:${css(fg)};color-scheme:${dark ? 'dark' : 'light'};`;
            if (body !== last) { last = body; style.textContent = `${SEL}{${body}}`; }
        } catch { /* keep the previous colours */ }
    }
    const later = () => { clearTimeout(timer); timer = setTimeout(update, 60); };
    update();
    try { if (win.MutationObserver) { observer = new win.MutationObserver(later); for (const n of [doc.documentElement, doc.body]) n && observer.observe(n, { attributes: true, attributeFilter: ['style', 'class', 'data-theme'] }); } } catch { /* optional */ }
    return { update, dispose() { clearTimeout(timer); observer?.disconnect(); style.remove(); } };
}
