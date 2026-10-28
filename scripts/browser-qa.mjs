// Browser QA of the built extension (dist/frontend.js) against stand-ins for the Lumiverse chat page / Extras menu (qa/harness.html)
// and the real backend entry on the fake Spindle host (qa/backend-env.mjs; no model, no network). Ported from LV-AnonMemory's harness.
// Chromium and Firefox; 360x640 + 390x844 + 768x1024 (touch), 1280x800 + 1280x600 (desktop); two origins:
//  - "insecure": http://qa.test (page.route): a non-loopback http origin is NOT a secure context, so crypto.randomUUID / crypto.subtle /
//    navigator.clipboard / navigator.share are missing exactly as on a phone over plain http,
//  - "secure": http://127.0.0.1:<port>.
// Host themes: a dark and a light one of qa/host-themes.json. Per view: horizontal overflow, text >= 15px (secondary >= 13px), tap targets
// >= 44px, contrast >= 4.5:1, no dead nested scroll box, no request leaving the page, no console errors.
// Tools are not dependencies: PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs, FIREFOX_BIN, CHROMIUM_BIN. Port 0 = random.
// Screenshots + qa-report.json go to QA_SHOT_DIR (default <tmpdir>/memoryvault-qa-receipts), outside the repo.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createQaServer } from './qa-server.mjs';

const pw = await import(process.env.PLAYWRIGHT_MODULE || 'playwright').catch(e => { console.error('Playwright not found (set PLAYWRIGHT_MODULE):', e.message); process.exit(2); });
const only = (process.env.QA_ONLY || '').split(',').filter(Boolean);
const originsWanted = (process.env.QA_ORIGINS || '').split(',').filter(Boolean);
const shotDir = process.env.QA_SHOT_DIR || path.join(os.tmpdir(), 'memoryvault-qa-receipts');
const VIEWPORTS = [{ width: 360, height: 640, touch: true }, { width: 390, height: 844, touch: true }, { width: 768, height: 1024, touch: true }, { width: 1280, height: 800, touch: false }, { width: 1280, height: 600, touch: false }];
const HOST_THEMES = ['default-dark', 'lumiverse-light'];
const root = process.cwd();
const repoCommit = await new Promise(r => { const p = spawn('git', ['-C', root, 'rev-parse', 'HEAD']); let o = ''; p.stdout.on('data', d => (o += d)); p.on('error', () => r(null)); p.on('close', () => r(o.trim() || null)); });
const qa = await createQaServer(root);
const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    try { const r = await qa.handle({ method: req.method, pathname: new URL(req.url, 'http://x').pathname, search: new URL(req.url, 'http://x').search, session: req.headers['x-qa-session'] || 'default', body }); res.setHeader('Content-Type', r.type); res.end(r.body); } catch { res.statusCode = 404; res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const ORIGINS = { secure: `http://127.0.0.1:${port}/qa/harness.html`, insecure: 'http://qa.test/qa/harness.html' };
const browsers = [['chromium', pw.chromium, process.env.CHROMIUM_BIN || undefined], ['firefox', pw.firefox, process.env.FIREFOX_BIN || undefined]];
const failures = [], rows = [], envRows = [], notes = [], flows = [];

// ---------- in-page measurement ----------
function measure({ rootSel, secondarySel, mainScrollers, detailOn }) {
    const panel = document.querySelector(rootSel);
    if (!panel) return { missing: true };
    const shown = e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !e.closest('[hidden]'); };
    const cn = e => { const cls = [...e.classList].slice(0, 3).join('.'); return e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (cls ? '.' + cls : ''); };
    const name = e => { let n = cn(e); if (!e.classList.length && e.parentElement) n += '<' + cn(e.parentElement); return n + (e.textContent.trim() ? '「' + e.textContent.trim().slice(0, 12) + '」' : ''); };
    const all = [...panel.querySelectorAll('*')].filter(e => !['STYLE', 'SCRIPT', 'TEMPLATE'].includes(e.tagName) && shown(e));
    const vw = innerWidth;
    const overflow = all.filter(e => { const r = e.getBoundingClientRect(); return r.right > vw + 1 || r.left < -1; }).filter(e => !e.closest('svg') && !e.closest('[data-qa-allow-overflow]')).slice(0, 5).map(name);
    const hscroll = document.documentElement.scrollWidth > innerWidth + 1;
    const parse = c => { const m = c.match(/[\d.]+/g); if (!m) return null; const k = /^color\(/.test(c) ? 255 : 1; return { r: +m[0] * k, g: +m[1] * k, b: +m[2] * k, a: m[3] === undefined ? 1 : +m[3] }; };   // color-mix() computes to color(srgb 0-1 ...)
    const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const over = (c, b) => ({ r: c.r * c.a + b.r * (1 - c.a), g: c.g * c.a + b.g * (1 - c.a), b: c.b * c.a + b.b * (1 - c.a), a: 1 });
    const backOf = e => { const layers = []; for (let n = e; n; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.backgroundImage && cs.backgroundImage !== 'none') return null; const c = parse(cs.backgroundColor); if (c && c.a > 0) layers.push(c); if (c && c.a >= 1) break; } let b = parse(getComputedStyle(document.documentElement).getPropertyValue('--lumiverse-bg-deep')) || { r: 10, g: 8, b: 18, a: 1 }; b.a = 1; for (const c of layers.reverse()) b = over(c, b); return b; };
    const ratio = e => { const b = backOf(e); if (!b) return 21; const c = over(parse(getComputedStyle(e).color), b), x = lum(c), y = lum(b); return Math.round((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) * 100) / 100; };
    const inactive = e => !!e.closest('button:disabled, textarea:disabled, select:disabled, input:disabled, [aria-disabled="true"]');
    const texts = all.filter(e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) && !e.closest('svg') && !e.closest('option'));
    const fonts = texts.map(e => ({ e, size: parseFloat(getComputedStyle(e).fontSize), secondary: !!e.closest(secondarySel) }));
    const smallPrimary = fonts.filter(x => !x.secondary && x.size < 14.95), smallSecondary = fonts.filter(x => x.secondary && x.size < 12.95);
    const lowContrast = texts.filter(e => !inactive(e)).map(e => ({ e, r: ratio(e) })).filter(x => x.r < 4.5);
    const fields = [...panel.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]), textarea, select')].filter(shown);
    const smallFieldText = fields.filter(e => parseFloat(getComputedStyle(e).fontSize) < 14.95).map(e => ({ e, size: parseFloat(getComputedStyle(e).fontSize) }));
    const tapSize = e => { const r = e.getBoundingClientRect(); return Math.min(r.width, r.height); };
    const tapTargets = [...panel.querySelectorAll('button, select, input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]), textarea, summary, a[href], [role=button]')].filter(shown).filter(e => !inactive(e) && !e.closest('svg'));
    const checks = [...panel.querySelectorAll('input[type=checkbox], input[type=radio]')].filter(shown).map(e => e.closest('label') || e);
    const taps = [...new Set([...tapTargets, ...checks])];
    const shortTaps = taps.filter(e => tapSize(e) < 43.5);
    const isScroller = e => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1 && e.tagName !== 'TEXTAREA' && e.tagName !== 'SELECT' && !e.closest('svg');
    const scrollers = all.filter(isScroller).filter(e => !mainScrollers.some(s => e.matches(s)));
    // a pane that overflows its viewport but cannot scroll (desktop panes must scroll): any shown block taller than the window whose overflow is hidden and clipped
    const clipped = all.filter(e => { const cs = getComputedStyle(e); return /hidden|clip/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 2 && e.clientHeight > 0 && ['DIV', 'SECTION', 'ASIDE', 'NAV', 'MAIN', 'ARTICLE'].includes(e.tagName) && e.getBoundingClientRect().bottom >= innerHeight - 2; }).slice(0, 5).map(name);
    const fmt = (list, k) => list.slice(0, 5).map(x => name(x.e || x) + '=' + Math.round((k ? x[k] : tapSize(x.e || x)) * 10) / 10);
    return {
        overflow, hscroll, scrollers: scrollers.map(name).slice(0, 5), clipped,
        smallPrimary: smallPrimary.length, smallSecondary: smallSecondary.length, smallField: smallFieldText.length, shortTaps: shortTaps.length, lowContrast: lowContrast.length,
        examples: { primary: fmt(smallPrimary, 'size'), secondary: fmt(smallSecondary, 'size'), field: fmt(smallFieldText, 'size'), taps: fmt(shortTaps), contrast: fmt(lowContrast, 'r') },
        counts: { texts: texts.length, taps: taps.length },
        detail: detailOn ? { primary: [...new Set(smallPrimary.map(x => name(x.e) + '=' + x.size))], secondary: [...new Set(smallSecondary.map(x => name(x.e) + '=' + x.size))], field: [...new Set(smallFieldText.map(x => cn(x.e) + '=' + x.size))], taps: [...new Set(shortTaps.map(e => name(e) + '=' + Math.round(tapSize(e))))], contrast: [...new Set(lowContrast.map(x => name(x.e) + '=' + x.r + ' ' + getComputedStyle(x.e).color))], scrollers: scrollers.map(cn) } : undefined,
    };
}
// secondary text (>= 13px): captions, chips/labels, counters, kickers. Everything else (buttons, fields, body copy) must be >= 15px.
const SECONDARY = 'small, sup, time, code, em, i, [class*="hint"], [class*="meta"], [class*="badge"], [class*="count"], [class*="muted"], [class*="foot"], [class*="note"], [class*="sub"], [class*="chip"], [class*="kicker"], [class*="eyebrow"], [class*="pill"], [class*="ticket-no"], [class*="tab-short"], [class*="theme-check"], [class*="status"], [class*="byline"], .mmc-kv span, pre, .mvx-hint';
const TARGETS = {
    adapter: { rootSel: '#mvx-overlay .mvx-card', mainScrollers: ['.mvx-body'] },
    original: { rootSel: '#mmc-root-v1', mainScrollers: (process.env.QA_ORIGINAL_SCROLLERS || '.mmc-layer-body,.mmc-wiki-main,.mmc-wiki-list,.mmc-main,.mmc-content,.mmc-body,.mmc-scroll,.mmc-panel,.mmc-shell,.mmc-side,.mmc-sidebar,.mmc-pane,.mmc-list,textarea').split(',') },
    launcher: { rootSel: '#mmc-launcher-v1', mainScrollers: [] },
};

try {
    await mkdir(shotDir, { recursive: true });
    const variants = [];
    for (const [bname, type, exe] of browsers) for (const oname of Object.keys(ORIGINS)) for (const vp of VIEWPORTS) variants.push({ bname, type, exe, oname, vp });
    const launched = new Map();
    for (const { bname, type, exe, oname, vp } of variants) {
        const tag = `${bname}-${vp.width}x${vp.height}-${oname}`;
        if (originsWanted.length && !originsWanted.includes(oname)) continue;
        if (only.length && !only.some(o => tag.includes(o))) continue;
        if (!launched.has(bname)) {
            try { launched.set(bname, await type.launch({ ...(exe ? { executablePath: exe } : {}), ...(bname === 'chromium' ? { args: ['--no-sandbox'] } : {}) })); } catch (e) { failures.push(`${bname}: launch failed ${e.message.split('\n')[0]}`); launched.set(bname, null); }
        }
        const browser = launched.get(bname);
        if (!browser) continue;
        const session = `s-${tag}`;
        const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, hasTouch: vp.touch, acceptDownloads: true, ...(bname === 'chromium' && vp.touch ? { isMobile: true, deviceScaleFactor: 2 } : {}), locale: 'ko-KR', permissions: [], reducedMotion: 'reduce', extraHTTPHeaders: { 'x-qa-session': session } });
        if (oname === 'insecure') {
            await context.route('http://qa.test/**', async route => {
                try { const rq = route.request(); const r = await qa.handle({ method: rq.method(), pathname: new URL(rq.url()).pathname, search: new URL(rq.url()).search, session, body: rq.postData() || '' }); await route.fulfill({ status: 200, contentType: r.type, body: r.body }); } catch { await route.fulfill({ status: 404, body: '' }); }
            });
        }
        const page = await context.newPage();
        const errors = [], outside = [], dialogs = [];
        page.on('pageerror', e => errors.push('pageerror: ' + e.message));
        page.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push('console: ' + m.text() + ' ' + (m.location()?.url || '')); });
        page.on('dialog', async d => { dialogs.push(d.type() + ':' + d.message().slice(0, 40)); await page.waitForTimeout(300); await d.accept().catch(() => {}); });   // a "human" accepts after 300 ms
        const origin = new URL(ORIGINS[oname]).origin;
        page.on('request', r => { const u = r.url(); if (u.startsWith('data:') || u.startsWith('blob:')) return; if (!u.startsWith(origin + '/')) outside.push(u); else { const p = new URL(u).pathname; if (!/^\/(qa|dist)\//.test(p) || /\/api\//.test(p)) outside.push(u); } });
        await page.goto(ORIGINS[oname]);
        await page.waitForFunction(() => window.qa?.ready, null, { timeout: 20000 });
        await page.waitForTimeout(800);
        const sleep = ms => page.waitForTimeout(ms);
        const shot = async label => page.screenshot({ path: path.join(shotDir, `${tag}-${label}.png`) }).catch(() => {});
        const step = async (label, fn) => { try { await fn(); } catch (e) { failures.push(`${tag} ${label}: ${e.message.split('\n')[0]}`); await page.screenshot({ path: path.join(shotDir, `FAIL-${tag}-${label.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}.png`) }).catch(() => {}); } };
        let hostTheme = HOST_THEMES[0];
        const check = async (view, target) => {
            const m = await page.evaluate(measure, { ...TARGETS[target], secondarySel: SECONDARY, detailOn: !!process.env.QA_DETAIL });
            if (m.missing) { failures.push(`${tag} ${view}: ${target} root missing`); return null; }
            await shot(`${hostTheme}-${view}`);
            rows.push({ tag, theme: hostTheme, view, ...m });
            const where = `${tag} [${hostTheme}] ${view}`;
            if (m.overflow.length || m.hscroll) failures.push(`${where}: horizontal overflow ${m.overflow.join(' | ')}${m.hscroll ? ' (page scrolls sideways)' : ''}`);
            if (m.scrollers.length) failures.push(`${where}: extra scroll boxes ${m.scrollers.join(', ')}`);
            if (m.clipped.length) failures.push(`${where}: clipped panes that cannot scroll ${m.clipped.join(', ')}`);
            if (m.smallPrimary || m.smallSecondary || m.smallField) failures.push(`${where}: text<15 x${m.smallPrimary} (${m.examples.primary.join(' | ')}) meta<13 x${m.smallSecondary} (${m.examples.secondary.join(' | ')}) field<15 x${m.smallField} (${m.examples.field.join(' | ')})`);
            if (m.shortTaps) failures.push(`${where}: tap<44 x${m.shortTaps} (${m.examples.taps.join(' | ')})`);
            if (m.lowContrast) failures.push(`${where}: contrast<4.5 x${m.lowContrast} (${m.examples.contrast.join(' | ')})`);
            return m;
        };
        const setHost = async name => { hostTheme = name; await page.evaluate(n => qa.setTheme(n), name); await sleep(150); };
        const clickSel = async (sel, label) => { const ok = await page.evaluate(s => { const b = document.querySelector(s); if (!b) return false; b.scrollIntoView({ block: 'center' }); b.click(); return true; }, sel); if (!ok) throw Error('missing ' + (label || sel)); await sleep(250); };
        const until = async (fn, ms = 10000, what = 'condition') => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw Error('timeout waiting for ' + what); await sleep(150); } };
        const state = () => page.evaluate(async () => (await fetch('./__state')).json());
        const rpc = (method, p, body) => page.evaluate(async ([m, pp, b]) => (await (await fetch('./__rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ frame: { requestId: 'q' + Math.random(), type: 'api', method: m, path: pp, body: b }, user: 'qa-user' }) })).json()).replies[0], [method, p, body]);

        await step('environment', async () => {
            const env = await page.evaluate(() => qa.env()); envRows.push({ tag, ...env });
            if (oname === 'insecure' && (env.secure !== false || env.randomUUID !== 'undefined' || env.clipboard !== 'undefined' || env.subtle !== 'undefined' || env.share !== 'undefined')) throw Error('not an insecure context: ' + JSON.stringify(env));
            if (oname === 'secure' && env.secure !== true) throw Error('expected a secure context: ' + JSON.stringify(env));
            if (errors.length) throw Error('errors at start: ' + errors.join(' | '));
        });

        // ----- adapter screen: auto-opens because 0.4.x data exists -----
        await step('adapter: migration prompt opens by itself', async () => { await page.waitForSelector('#mvx-migrate', { timeout: 8000 }); await sleep(300); });
        for (const theme of HOST_THEMES) { await setHost(theme); await step(`adapter views [${theme}]`, async () => { await check('adapter-migrate', 'adapter'); }); }
        await setHost('default-dark');
        await step('adapter: import is locked before backup', async () => { const d = await page.evaluate(() => ({ imp: document.querySelector('#mvx-import').disabled, saved: document.querySelector('#mvx-saved').disabled })); if (!d.imp || !d.saved) throw Error('import not locked: ' + JSON.stringify(d)); });
        await step('adapter: backup downloads a parseable file with every 0.4.x item', async () => {
            const dl = page.waitForEvent('download', { timeout: 8000 });
            await clickSel('#mvx-backup', 'backup button');
            const download = await dl; const f = await download.path(); const text = (await import('node:fs/promises')).readFile(f, 'utf8'); const j = JSON.parse(await text);
            if (j.format !== 'memory-cabinet-lv-backup' || j.chats?.['chat-b']?.data?.items?.length !== 6) throw Error('backup content wrong: ' + JSON.stringify(Object.keys(j.chats || {})));
            if (!/^memory-cabinet-0\.4-backup-.*\.json$/.test(download.suggestedFilename())) throw Error('file name ' + download.suggestedFilename());
            await sleep(300); await check('adapter-after-backup', 'adapter');
        });
        await step('adapter: text fallback (for browsers that ignore downloads)', async () => {
            await clickSel('#mvx-showtext', 'show text');
            const t = await page.evaluate(() => document.querySelector('textarea.mvx-text')?.value.length || 0); if (t < 200) throw Error('no text box');
            await check('adapter-text', 'adapter');
        });
        await step('adapter: "I saved it" unlocks the one-button import (promises+anchors only)', async () => {
            await page.evaluate(() => { const c = document.querySelector('#mvx-saved'); c.click(); });
            await sleep(200);
            if (await page.evaluate(() => document.querySelector('#mvx-import').disabled)) throw Error('still locked');
            await clickSel('#mvx-import', 'import');
            await page.waitForFunction(() => /가져왔어요/.test(document.querySelector('#mvx-migrate')?.textContent || ''), null, { timeout: 8000 });
            const st = await state(); const items = st.chats['chat-b']?.memoryCabinetV1?.items || [];
            if (items.length !== 5 || items.some(i => !['promise', 'anchor'].includes(i.type))) throw Error('imported ' + JSON.stringify(items.map(i => i.type)));
            const secret = items.find(i => i.content.includes('왕국')); if (!secret?.knownBy?.includes('char-haru')) throw Error('restricted anchor lost its knownBy');
            const unknown = items.find(i => i.content.includes('범위 미확정')); if (unknown?.active !== false) throw Error('unknown-scope anchor must be kept but not injected');
            await check('adapter-imported', 'adapter');
        });
        await step('adapter: interval is saved', async () => {
            await page.fill('#mvx-every', '4'); await clickSel('#mvx-save', 'save');
            await sleep(400); const st = await state(); if (st.store['adapter-settings.json']?.every !== 4) throw Error('not saved: ' + JSON.stringify(st.store['adapter-settings.json']));
            await check('adapter-settings', 'adapter');
        });
        await step('adapter: close, reopen from the Extras menu', async () => {
            await clickSel('#mvx-close', 'close'); await sleep(200);
            if (await page.evaluate(() => !document.getElementById('mvx-overlay').hidden)) throw Error('did not close');
            await page.evaluate(() => document.getElementById('extras-btn').click()); await sleep(100);
            await page.evaluate(() => qa.clickAction('memory-cabinet-settings')); await sleep(400);
            if (await page.evaluate(() => document.getElementById('mvx-overlay').hidden)) throw Error('did not reopen');
            await page.keyboard.press('Escape'); await sleep(200);
            if (await page.evaluate(() => !document.getElementById('mvx-overlay').hidden)) throw Error('Escape did not close');
        });

        // ----- the pinned original -----
        await step('original: launcher opens the vault', async () => {
            await check('launcher', 'launcher');
            await clickSel('#mmc-launcher-v1', 'launcher');
            await page.waitForFunction(() => { const r = document.getElementById('mmc-root-v1'); return r && !r.hidden && r.querySelector('.mmc-shell'); }, null, { timeout: 10000 }); await sleep(900);
        });
        for (const theme of HOST_THEMES) {
            await setHost(theme);
            await step(`original tabs [${theme}]`, async () => {
                const tabs = await page.evaluate(() => [...new Set([...document.querySelectorAll('#mmc-root-v1 .mmc-tab[data-tab]')].map(b => b.dataset.tab))]);
                if (tabs.length < 5) throw Error('tabs missing: ' + tabs);
                for (const t of tabs) { await page.evaluate(x => document.querySelector(`#mmc-root-v1 .mmc-tab[data-tab="${x}"]`)?.click(), t); await sleep(350); await check(`original-${t}`, 'original'); }
                await page.evaluate(() => document.querySelector('#mmc-root-v1 .mmc-tab[data-tab]')?.click()); await sleep(200);
                for (const a of ['settings', 'help']) { await page.evaluate(x => document.querySelector(`#mmc-root-v1 [data-action="${x}"]`)?.click(), a); await sleep(450); await check(`original-${a}`, 'original'); await page.evaluate(() => { document.querySelector('#mmc-root-v1 [data-action="close-layer"]')?.click(); }); await sleep(200); }
            });
        }
        // the original's own palettes: default sweep above ran in "ribbon"; the others get overview + a list + settings (marinara = follows the host, dark and light)
        for (const mode of ['rose', 'green', 'marinara']) {
            await step(`original theme ${mode}: switch (stored UI preference, remount)`, async () => {
                await page.evaluate(() => document.querySelector('#mmc-root-v1 [data-action="close"]')?.click()); await sleep(200);
                const cur = (await rpc('GET', '_storage')).data.memoryCabinetUiV1 || {};
                await rpc('POST', '_storage', { patch: { memoryCabinetUiV1: { ...cur, uiThemeMode: mode, selectedChatId: 'chat-a' } } });
                await page.evaluate(() => qa.remount()); await sleep(2200);
                await clickSel('#mmc-launcher-v1', 'launcher'); await sleep(1200);
                const got = await page.evaluate(() => document.getElementById('mmc-root-v1')?.dataset.mmcTheme); if (got !== mode) throw Error('theme is ' + got);
            });
            for (const theme of HOST_THEMES) {
                await setHost(theme);
                await step(`original theme ${mode} [${theme}]`, async () => {
                    for (const t of ['overview', 'promise']) { await page.evaluate(x => document.querySelector(`#mmc-root-v1 .mmc-tab[data-tab="${x}"]`)?.click(), t); await sleep(300); await check(`original-${mode}-${t}`, 'original'); }
                    await page.evaluate(() => document.querySelector('#mmc-root-v1 [data-action="settings"]')?.click()); await sleep(400); await check(`original-${mode}-settings`, 'original');
                    await page.evaluate(() => document.querySelector('#mmc-root-v1 [data-action="close-layer"]')?.click()); await sleep(200);
                });
            }
        }
        await step('original theme: back to ribbon', async () => {
            await page.evaluate(() => document.querySelector('#mmc-root-v1 [data-action="close"]')?.click()); await sleep(200);
            const cur = (await rpc('GET', '_storage')).data.memoryCabinetUiV1 || {};
            await rpc('POST', '_storage', { patch: { memoryCabinetUiV1: { ...cur, uiThemeMode: 'ribbon', selectedChatId: 'chat-a' } } });
            await page.evaluate(() => qa.remount()); await sleep(2200);
            await clickSel('#mmc-launcher-v1', 'launcher'); await sleep(1000);
        });
        await setHost('default-dark');
        await step('original: one deletion goes through confirm() (dialog accepted after a human-like delay)', async () => {
            await page.evaluate(() => document.querySelector('#mmc-root-v1 .mmc-tab[data-tab="promise"]')?.click()); await sleep(400);
            await page.evaluate(() => document.querySelector('#mmc-root-v1 [data-action="edit-item"]')?.click()); await sleep(400);
            const before = (await state()).chats['chat-a'].memoryCabinetV1.items.length;
            await clickSel('#mmc-root-v1 [data-action="delete-item"]', 'delete');
            await until(async () => (await state()).chats['chat-a'].memoryCabinetV1.items.length < before, 10000, 'item deleted').catch(() => {});
            const after = (await state()).chats['chat-a'].memoryCabinetV1.items.length;
            if (!dialogs.some(d => d.startsWith('confirm:'))) throw Error('no confirm dialog was shown: ' + dialogs); if (after !== before - 1) throw Error(`item not deleted (${before} -> ${after})`);
        });
        await step('original: close, then the active chat follows Lumiverse (switch to chat-b)', async () => {
            await page.evaluate(() => document.querySelector('#mmc-root-v1 [data-action="close"]')?.click()); await sleep(300);
            await page.evaluate(() => qa.switchChat('chat-b')); await sleep(1800);
            const sel = await page.evaluate(() => localStorage.getItem('marinara-active-chat-id')); if (sel !== 'chat-b') throw Error('active chat key ' + sel);
            await clickSel('#mmc-launcher-v1', 'launcher'); await sleep(1500);
            const v = await page.evaluate(() => document.querySelector('#mmc-chat-select')?.value); if (v !== 'chat-b') throw Error('vault selected ' + v);
            await page.evaluate(() => document.querySelector('#mmc-root-v1 [data-action="close"]')?.click()); await sleep(200);
            await page.evaluate(() => qa.switchChat('chat-a')); await sleep(1500);
        });
        if (oname === 'insecure' || vp.width === 390) await step('trigger: N turns -> original analyses -> review candidates (auto_review)', async () => {
            await rpc('POST', '_storage', { patch: { memoryCabinetUiV1: { summaryUpdateMode: 'auto_review', selectedChatId: 'chat-a', modelConnectionId: 'conn1' } } });
            await page.evaluate(() => qa.remount()); await sleep(2500);
            let page2 = null;   // a second tab of the same user (same backend): the trigger reaches both, exactly one may analyse
            if (vp.width === 390) { page2 = await context.newPage(); page2.on('dialog', d => d.accept().catch(() => {})); await page2.goto(ORIGINS[oname]); await page2.waitForFunction(() => window.qa?.ready, null, { timeout: 20000 }); await sleep(2500); }
            await page.evaluate(async () => { await fetch('./__turns?chat=chat-a&n=0'); }); await sleep(300);   // baseline
            await page.evaluate(async () => { await fetch('./__turns?chat=chat-a&n=4'); });                 // 4 turns >= N(4): trigger
            await until(async () => (await state()).generate > 0, 15000, 'the original called the model');
            await until(async () => !!(await state()).chats['chat-a'].memoryCabinetV1?.pendingReview, 15000, 'pendingReview stored');
            await sleep(page2 ? 5000 : 500);
            const st = await state(); await page2?.close(); if (st.generate !== 1) throw Error('analysis calls: ' + st.generate + (page2 ? ' (two tabs open: exactly one tab may analyse)' : ''));
            await clickSel('#mmc-launcher-v1', 'launcher'); await sleep(1200); await check('original-review', 'original');
            await page.evaluate(() => document.querySelector('#mmc-root-v1 [data-action="close"]')?.click());
        });
        await step('confirm(): a browser that suppresses the dialog still lets a deliberate second press through', async () => {
            await page.evaluate(() => { qa.unmount(); window.__realConfirm = window.confirm; window.confirm = () => false; qa.mount(); }); await sleep(2200);   // the browser "blocks" confirm: false at once
            await clickSel('#mmc-launcher-v1', 'launcher'); await sleep(1000);
            await page.evaluate(() => document.querySelector('#mmc-root-v1 .mmc-tab[data-tab="anchor"]')?.click()); await sleep(400);
            await page.evaluate(() => document.querySelector('#mmc-root-v1 [data-action="edit-item"]')?.click()); await sleep(400);
            const count = async () => (await state()).chats['chat-a'].memoryCabinetV1.items.length; const before = await count();
            await clickSel('#mmc-root-v1 [data-action="delete-item"]', 'delete'); await sleep(900);
            if (await count() !== before) throw Error('first press must be cancelled when the dialog was suppressed');
            const hint = await page.evaluate(() => document.getElementById('mvx-toast')?.textContent || ''); if (!/확인 창을 막았어요/.test(hint)) throw Error('no visible hint: ' + hint);
            await shot('confirm-hint');
            await clickSel('#mmc-root-v1 [data-action="delete-item"]', 'delete');
            await until(async () => (await state()).chats['chat-a'].memoryCabinetV1.items.length < before, 8000, 'second press deletes');
            await page.evaluate(() => { qa.unmount(); window.confirm = window.__realConfirm; qa.mount(); }); await sleep(2000);
        });
        await step('two chats: switching while the vault is open leaves it alone, then it follows the active chat', async () => {
            await page.evaluate(() => document.getElementById('mmc-root-v1')?.hidden && document.getElementById('mmc-launcher-v1')?.click()); await sleep(900);
            await page.evaluate(() => qa.switchChat('chat-b')); await sleep(2600);
            if (await page.evaluate(() => document.getElementById('mmc-root-v1')?.hidden !== false)) throw Error('the open vault was torn down by a chat switch');
            await page.evaluate(() => document.querySelector('#mmc-root-v1 [data-action="close"]')?.click());
            await sleep(3200);
            await clickSel('#mmc-launcher-v1', 'launcher'); await sleep(1500);
            const v = await page.evaluate(() => document.querySelector('#mmc-chat-select')?.value); if (v !== 'chat-b') throw Error('vault shows ' + v + ' after switching to chat-b');
            await page.evaluate(() => document.querySelector('#mmc-root-v1 [data-action="close"]')?.click());
            await page.evaluate(() => qa.switchChat('chat-a')); await sleep(2500);
        });
        if (errors.length) failures.push(`${tag}: console/page errors: ${[...new Set(errors)].slice(0, 4).join(' | ')}`);
        if (outside.length) failures.push(`${tag}: requests that left the page: ${[...new Set(outside)].slice(0, 4).join(' | ')}`);
        flows.push({ tag, dialogs: dialogs.length });
        await context.close();
    }
    for (const b of launched.values()) await b?.close();
} finally { server.close(); }

const summary = { ok: failures.length === 0, variants: new Set(rows.map(r => r.tag)).size, views: rows.length, failures: failures.length };
await writeFile(path.join(shotDir, 'qa-report.json'), JSON.stringify({ repoCommit, summary, failures, secondaryException: 'pre blocks (evidence quote, injection preview, wiki code block) are judged at >=13px, not 15px', env: envRows, notes, flows, rows: rows.map(({ examples, ...r }) => r) }, null, 1));
console.log(JSON.stringify(summary));
for (const f of failures) console.log('FAIL ' + f);
for (const n of notes) console.log('NOTE ' + n);
process.exit(failures.length ? 1 : 0);
