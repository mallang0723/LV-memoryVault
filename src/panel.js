// Adapter-owned screen (everything the pinned original cannot know about): auto-run interval, 0.4.x migration, permission notice, toasts.
// Plain DOM, no secure-context APIs, phone-sized (body 16px, hints 14px, touch targets >= 44px, one scroll area).
import { downloadJson } from './download.js';

const ID = 'mvx-overlay', TOAST = 'mvx-toast';
export const PANEL_CSS = `
#${ID},#${TOAST}{--bg:#fff;--fg:#1c1b22;--mute:#555463;--line:#c7c6d2;--acc:#4338ca;--accfg:#fff;--soft:#f1f0f8;--warn:#8a4b00;--warnbg:#fff4e0;--ok:#146c2e;font:16px/1.5 system-ui,-apple-system,"Noto Sans KR",sans-serif;color:var(--fg);box-sizing:border-box}
#${ID}[data-theme=dark],#${TOAST}[data-theme=dark]{--bg:#1f1d2b;--fg:#ececf5;--mute:#b9b8c8;--line:#4a485e;--acc:#b4a9ff;--accfg:#16142a;--soft:#2a2840;--warn:#ffcf8a;--warnbg:#3a2c12;--ok:#7ee0a0}
#${ID} *,#${TOAST} *{box-sizing:border-box}
#${ID}{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);padding:12px}
#${ID}[hidden]{display:none}
#${ID} .mvx-card{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:14px;width:100%;max-width:560px;max-height:100%;display:flex;flex-direction:column;min-height:0}
#${ID} .mvx-head{display:flex;align-items:center;gap:8px;padding:12px 12px 8px 16px;border-bottom:1px solid var(--line)}
#${ID} .mvx-head h2{margin:0;font-size:18px;line-height:1.3;flex:1}
#${ID} .mvx-body{padding:12px 16px 16px;overflow-y:auto;overscroll-behavior:contain;min-height:0}
#${ID} section{margin:0 0 18px}
#${ID} h3{margin:0 0 6px;font-size:16px}
#${ID} p{margin:0 0 8px}
#${ID} .mvx-hint{font-size:14px;color:var(--mute)}
#${ID} button,#${ID} input[type=number]{font:inherit;min-height:44px;border-radius:10px;border:1px solid var(--line);background:var(--soft);color:var(--fg);padding:0 14px}
#${ID} button.mvx-primary{background:var(--acc);color:var(--accfg);border-color:var(--acc);font-weight:600}
#${ID} button:disabled{opacity:.6}
#${ID} .mvx-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
#${ID} input[type=number]{width:96px}
#${ID} label.mvx-check{display:flex;gap:10px;align-items:center;min-height:44px}
#${ID} label.mvx-check input{width:24px;height:24px;flex:none}
#${ID} .mvx-note{background:var(--warnbg);color:var(--warn);border-radius:10px;padding:10px 12px;font-size:15px}
#${ID} details.mvx-skips{font-size:15px;margin:6px 0}#${ID} details.mvx-skips summary{min-height:44px;display:flex;align-items:center;cursor:pointer}#${ID} details.mvx-skips li{font-size:15px;margin:4px 0}#${ID} .mvx-ok{color:var(--ok);font-weight:600}
#${ID} textarea.mvx-text{width:100%;height:160px;font:15px/1.4 ui-monospace,monospace;background:var(--soft);color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:8px}
#${TOAST}{position:fixed;left:12px;right:12px;bottom:76px;z-index:2147483001;display:flex;justify-content:center;pointer-events:none}
#${TOAST} div{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:12px;padding:10px 14px;max-width:520px;box-shadow:0 6px 24px rgba(0,0,0,.35);pointer-events:auto}
#${TOAST} small{display:block;font-size:14px;color:var(--mute)}
`;

const lum = css => { const m = String(css || '').match(/[\d.]+/g); if (!m || m.length < 3 || (m[3] !== undefined && +m[3] === 0)) return null; const f = v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(+m[0]) + .7152 * f(+m[1]) + .0722 * f(+m[2]); };
export function detectTheme(win, doc) {
    for (const el of [doc.body, doc.documentElement]) { try { const l = lum(win.getComputedStyle(el).backgroundColor); if (l !== null) return l < .4 ? 'dark' : 'light'; } catch { /* next */ } }
    try { return win.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch { return 'light'; }
}

export function createPanel(ctx, { request, activeChatId = () => '' }, { win = globalThis.window, doc = globalThis.document } = {}) {
    const el = (tag, props = {}, ...kids) => { const n = doc.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k === 'class') n.className = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v); } n.append(...kids.flat().filter(x => x != null && x !== false)); return n; };
    const style = el('style'); style.textContent = PANEL_CSS; (doc.head || doc.documentElement).append(style);
    const call = async (method, path, body) => { const r = await request(method, path, body); if (!r.ok) throw new Error(r.error || '요청 실패'); return r.data; };
    let overlay = null, toastTimer = null, status = null, backedUp = false, lastBackup = null, importResult = null, backupText = '', busy = false, action = null, fab = null;

    function toast(message, detail = '') {
        let t = doc.getElementById(TOAST);
        if (!t) { t = el('div', { id: TOAST, role: 'status', 'aria-live': 'polite' }); doc.body.append(t); }
        t.dataset.theme = detectTheme(win, doc);
        t.replaceChildren(el('div', {}, message, detail ? el('small', {}, detail) : null));
        clearTimeout(toastTimer); toastTimer = setTimeout(() => t.replaceChildren(), 7000);
    }

    async function refresh() { try { status = await call('GET', '_adapter/status'); } catch (e) { status = { error: String(e?.message || e) }; } }
    const mig = () => status?.migrate;
    const migrationPending = () => { const m = mig(); return !!m && !m.error && m.oldChats > 0 && !m.dismissed && !m.importedAt; };

    function render() {
        if (!overlay) return;
        overlay.dataset.theme = detectTheme(win, doc);
        const body = overlay.querySelector('.mvx-body');
        const s = status || {};
        const parts = [];
        if (s.error) parts.push(el('p', { class: 'mvx-note' }, `상태를 읽지 못했어요: ${s.error}`));
        if (s.permissions && !s.permissions.generation) parts.push(el('p', { class: 'mvx-note' }, '이 확장에 generation 권한이 없어요. 자동 분석과 모델 분석이 동작하지 않습니다. 확장 관리에서 권한을 승인해 주세요.'));
        if (s.permissions && !s.permissions.world_books) parts.push(el('p', { class: 'mvx-note' }, 'world_books 권한이 없어 승인한 기억을 로어북에 쓸 수 없어요.'));
        // --- auto-run interval ---
        const input = el('input', { type: 'number', id: 'mvx-every', min: s.everyMin ?? 3, max: s.everyMax ?? 100, value: s.every ?? 10, inputmode: 'numeric', 'aria-label': '자동 분석 간격(사용자 턴)' });
        const save = el('button', { type: 'button', class: 'mvx-primary', id: 'mvx-save', onclick: async () => { try { const r = await call('POST', '_adapter/settings', { every: Number(input.value) }); s.every = r.every; input.value = r.every; toast(`${r.every}턴마다 분석 대상을 쌓습니다.`); } catch (e) { toast(`저장하지 못했어요: ${e.message}`); } } }, '저장');
        parts.push(el('section', {},
            el('h3', {}, '자동 분석 간격'),
            el('p', { class: 'mvx-hint' }, `사용자 메시지가 이 횟수만큼 쌓일 때마다 그 구간의 대화 원문을 하나의 요약으로 만들어 기억 보관함의 분석에 넘깁니다(별도 요약 모델 호출 없음). ${s.everyMin ?? 3}~${s.everyMax ?? 100}, 기본 ${s.everyDefault ?? 10}.`),
            el('div', { class: 'mvx-row' }, el('label', { for: 'mvx-every' }, '사용자 턴'), input, save),
            el('p', { class: 'mvx-hint' }, '실제로 분석이 돌려면 기억 보관함 설정의 「새 요약 갱신 방식」을 「자동 분석 후 승인 대기」(또는 완전 자동 적용)로 바꾸고 모델 연결을 골라야 해요. 기본값(알림 + 모델 정리 버튼)에서는 자동으로 모델을 부르지 않습니다.')));
        // --- migration ---
        const m = mig();
        if (m && m.oldChats > 0 && !m.error) parts.push(migrationSection(m));
        else if (m?.error && m.error !== 'unsupported') parts.push(el('p', { class: 'mvx-hint' }, `옛 데이터 확인 실패: ${m.error}`));
        parts.push(el('section', {}, el('h3', {}, '알아 둘 점'), el('p', { class: 'mvx-hint' }, '인물별 비밀(아는 사람 제한)은 이름이 맞을 때만 보이는 조건문으로 로어북에 저장돼요. 이름을 바꾸면 깨지고, 그룹 채팅의 합치기(merge) 모드에서는 새거나 빠질 수 있어요. 자세한 내용은 README의 「한계」를 보세요.')));
        body.replaceChildren(...parts);
    }

    const SKIP_WHY = { 'already has original data': '이미 원본 데이터가 있어요', 'nothing importable': '가져올 약속·앵커가 없어요', 'chat gone': '채팅을 찾을 수 없어요' };
    /** counts for the result toast and summary: imported / skipped / failed chats */
    function importSummary(r) {
        const imp = r.chats || 0, sk = r.skipped || 0, fl = r.failed || 0;
        const whys = [...new Set((r.skippedList || []).map(x => SKIP_WHY[x.reason] || x.reason))].join(', ');
        let text;
        if (!imp && !fl) text = `가져온 항목이 없어요. 채팅 ${sk}개를 건너뛰었어요${whys ? `(${whys})` : ''}. 기존 데이터는 그대로 안전하고, 받아 둔 백업도 건드리지 않았어요.`;
        else if (!imp) text = `가져오지 못했어요. 실패 ${fl}개${sk ? `, 건너뜀 ${sk}개` : ''}. 기존 데이터와 백업은 그대로예요. 다시 시도해 보세요.`;
        else text = `가져왔어요: 채팅 ${imp}개(항목 ${r.imported ?? 0}개)${sk ? `, 건너뜀 ${sk}개${whys ? `(${whys})` : ''}` : ''}${fl ? `, 실패 ${fl}개(다시 시도할 수 있어요)` : ''}. 각 채팅에서 기억 보관함을 열어 확인하세요.`;
        return { text };
    }
    function migrationSection(m) {
        const sec = el('section', { id: 'mvx-migrate' }, el('h3', {}, '0.4.x 데이터 옮기기'));
        const r = m.result;
        const resultNodes = () => r ? [
            el('p', { class: r.failed || (!r.chats && r.skipped) ? 'mvx-note' : 'mvx-ok' }, importSummary(r).text),
            r.skippedList?.length ? el('details', { class: 'mvx-skips' }, el('summary', {}, `건너뛴 채팅 ${r.skippedList.length}개 보기`),
                el('ul', {}, r.skippedList.map(x => el('li', {}, `${x.name || '(이름 없는 채팅)'} — ${SKIP_WHY[x.reason] || x.reason}`)))) : null,
            importResult && r.chats ? el('p', { class: 'mvx-hint' }, `보류로 들어온 항목(주입 안 함) ${Object.values(importResult).reduce((n, x) => n + (x.held || 0), 0)}개. 원본 화면에서 확인하세요.`) : null,
        ] : [];
        if (m.importedAt) { sec.append(...resultNodes()); return sec; }
        sec.append(
            el('p', {}, `옛 버전(0.4.x)이 남긴 기억이 채팅 ${m.oldChats}개, 항목 ${m.oldItems}개 있어요. 새 버전은 저장 형식이 달라 자동으로는 이어지지 않아요.`),
            el('p', { class: 'mvx-hint' }, `① 백업을 먼저 받으세요(전부 들어 있어요). ② 약속·앵커 ${m.importable}개만 새 형식으로 가져올 수 있어요. 장면록·요소·흐름·위키·후보·되돌리기는 백업 파일에만 남습니다.`));
        const dl = el('button', { type: 'button', id: 'mvx-backup', class: backedUp ? '' : 'mvx-primary', disabled: busy, onclick: doBackup }, backedUp ? '백업 다시 받기' : '① 백업 받기');
        sec.append(el('div', { class: 'mvx-row' }, dl, el('button', { type: 'button', id: 'mvx-showtext', disabled: busy, onclick: () => doBackup(null, true) }, '텍스트로 보기')));
        if (backupText) {
            sec.append(el('p', { class: 'mvx-hint' }, '아래 글을 전부 복사해 메모 앱·파일에 붙여 두세요.'));
            const t = el('textarea', { class: 'mvx-text', readonly: true, 'aria-label': '백업 JSON — 전체 선택해 복사하세요' }); t.value = backupText; sec.append(t);
        } else sec.append(el('p', { class: 'mvx-hint' }, '받아도 파일이 안 보이면(일부 앱 내 브라우저) 「텍스트로 보기」로 글을 복사해 두세요.'));
        const chk = el('input', { type: 'checkbox', id: 'mvx-saved', disabled: !backedUp });
        chk.checked = !!overlay.dataset.saved;
        chk.addEventListener('change', () => { overlay.dataset.saved = chk.checked ? '1' : ''; render(); });
        sec.append(el('label', { class: 'mvx-check' }, chk, '백업을 저장했어요'));
        sec.append(el('div', { class: 'mvx-row' },
            el('button', { type: 'button', id: 'mvx-import', class: 'mvx-primary', disabled: busy || !backedUp || !chk.checked, onclick: doImport }, `② 약속·앵커 ${m.importable}개 가져오기`),
            el('button', { type: 'button', id: 'mvx-dismiss', disabled: busy, onclick: doDismiss }, '다시 묻지 않기')));
        if (r) sec.append(...resultNodes());
        return sec;
    }
    async function doBackup(_e, asText = false) {
        busy = true; render();
        try {
            const doc0 = await call('GET', '_migrate/backup');
            const name = `memory-cabinet-0.4-backup-${new Date().toISOString().slice(0, 10)}.json`;
            backedUp = true;
            if (asText) { backupText = JSON.stringify(doc0, null, 1); lastBackup = { method: 'text' }; }
            else {
                const sink = doc.createElement('div');   // downloadJson's text-box fallback lands here; we render it ourselves
                const r = downloadJson(doc0, name, { document: doc, container: sink });
                lastBackup = { method: r.method, bytes: r.bytes };
                backupText = r.method === 'textarea' ? r.text : '';
                toast(r.method === 'blob' ? `백업 파일을 만들었어요(${Math.ceil(r.bytes / 1024)}KB). 받은 파일을 확인해 주세요.` : '파일을 만들 수 없어 글로 보여 드려요. 전부 복사해 두세요.');
            }
            await refresh();
        } catch (e) { toast(`백업하지 못했어요: ${e.message}`); }
        busy = false; render();
        if (backupText) { const t = overlay.querySelector('textarea.mvx-text'); try { t?.focus(); t?.select(); doc.execCommand?.('copy'); } catch { /* manual copy */ } }
    }
    async function doImport() {
        busy = true; render();
        try {
            importResult = await call('POST', '_migrate/apply', { confirmBackup: true });
            await refresh();
            const rows = Object.values(importResult || {});
            toast(importSummary({ chats: rows.filter(x => !x.skipped && !x.failed).length, imported: rows.reduce((n, x) => n + (x.items || 0), 0), skipped: rows.filter(x => x.skipped).length, failed: rows.filter(x => x.failed).length, skippedList: rows.filter(x => x.skipped).map(x => ({ name: x.name, reason: x.skipped })) }).text);
        }
        catch (e) { toast(`가져오지 못했어요: ${e.message}`); }
        busy = false; render();
    }
    async function doDismiss() { try { await call('POST', '_migrate/dismiss'); await refresh(); } catch { /* keep showing */ } render(); }

    async function open() {
        if (!overlay) {
            const card = el('div', { class: 'mvx-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mvx-title' },
                el('div', { class: 'mvx-head' }, el('h2', { id: 'mvx-title' }, '기억 보관함 설정'), el('button', { type: 'button', id: 'mvx-close', 'aria-label': '닫기', onclick: close }, '닫기')),
                el('div', { class: 'mvx-body' }));
            overlay = el('div', { id: ID }, card);
            overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
            overlay.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
            doc.body.append(overlay);
        }
        overlay.hidden = false; render();
        await refresh(); render();
        try { overlay.querySelector('#mvx-close')?.focus(); } catch { /* ignore */ }
    }
    function close() { if (overlay) overlay.hidden = true; }

    // entry point: Extras menu action (host feature-detected); a small floating button when the host has none
    try {
        const a = ctx.ui?.registerInputBarAction?.({ id: 'memory-cabinet-settings', label: '기억 보관함 설정', subtitle: '자동 분석 간격 · 옛 데이터 옮기기' });
        if (a) { action = a; a.onClick(() => { void open(); }); }
    } catch { /* fall back below */ }
    if (!action) {
        fab = el('button', { type: 'button', id: 'mvx-fab', 'aria-label': '기억 보관함 설정', onclick: () => { void open(); } }, '기억 설정');
        fab.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147482000;min-height:44px;min-width:44px;padding:0 12px;font:15px system-ui;border-radius:12px;border:1px solid #888;background:#fff;color:#111;opacity:.9';
        doc.body.append(fab);
    }
    return {
        open, close, toast, refresh,
        /** first run after an upgrade: ask once per page load if 0.4.x data is waiting */
        async promptIfMigrationPending() { await refresh(); if (migrationPending()) await open(); },
        dispose() { try { action?.destroy?.(); } catch { /* ignore */ } overlay?.remove(); fab?.remove(); doc.getElementById(TOAST)?.remove(); style.remove(); clearTimeout(toastTimer); },
    };
}
