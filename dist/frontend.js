// src/shim.js
var RE_API = /^(?:https?:\/\/[^/]+)?\/api\/(?!v\d+(?:\/|$)|auth(?:\/|$)|ws(?:\/|$)|spindle(?:\/|$))/;
var uid = () => {
  try {
    const c = globalThis.crypto;
    if (c?.randomUUID)
      return c.randomUUID();
  } catch {}
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
};
function response(status, data) {
  const text = data === undefined ? "" : JSON.stringify(data);
  return { ok: status >= 200 && status < 300, status, statusText: String(status), headers: { get: () => "application/json" }, json: async () => JSON.parse(text || "null"), text: async () => text, clone: () => response(status, data) };
}
function installShim(ctx, { win = globalThis.window, activeChatId = () => "", timeoutMs = 60000, slowMs = 330000 } = {}) {
  const pending = new Map;
  let onTrigger = null;
  const off = ctx.onBackendMessage((msg) => {
    if (msg?.event === "mv-trigger") {
      onTrigger?.(msg);
      return;
    }
    const p = msg && pending.get(msg.requestId);
    if (p) {
      pending.delete(msg.requestId);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  });
  const request = (method, path, body, signal) => new Promise((resolve, reject) => {
    const requestId = uid();
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("서버 응답이 없어요."));
    }, /generate\/raw/.test(path) ? slowMs : timeoutMs);
    pending.set(requestId, { resolve, timer });
    signal?.addEventListener?.("abort", () => {
      if (pending.delete(requestId)) {
        clearTimeout(timer);
        reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      }
    }, { once: true });
    try {
      ctx.sendToBackend({ requestId, type: "api", method, path, body });
    } catch (e) {
      pending.delete(requestId);
      clearTimeout(timer);
      reject(e);
    }
  });
  onTrigger = (msg) => {
    if (typeof msg.chatId !== "string" || activeChatId() && activeChatId() !== msg.chatId)
      return;
    request("POST", "_trigger/claim", { id: msg.id || `${msg.chatId}:${Date.now()}` }).then((r) => {
      if (r?.ok && r.data?.ok)
        return win.fetch(`/api/chats/${encodeURIComponent(msg.chatId)}`);
    }).catch(() => {});
  };
  const shimFetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input?.url || input);
    const method = String(init?.method || "GET").toUpperCase();
    let body;
    if (typeof init?.body === "string" && init.body) {
      try {
        body = JSON.parse(init.body);
      } catch {}
    }
    try {
      const r = await request(method, url, body, init?.signal);
      return r.ok ? response(200, r.data ?? null) : response(r.status >= 400 ? r.status : 400, { error: r.error });
    } catch (e) {
      if (e?.name === "AbortError")
        throw e;
      return response(503, { error: e?.message || "연결 실패" });
    }
  };
  const hostFetch = win.fetch?.bind(win);
  const baseFetch = (input, init) => RE_API.test(typeof input === "string" ? input : String(input?.url || "")) ? shimFetch(input, init) : hostFetch(input, init);
  win.fetch = baseFetch;
  function createMarinara() {
    const cleanups = [];
    const withActive = (ui) => {
      const id = activeChatId();
      return id ? { ...ui, memoryCabinetUiV1: { ...ui?.memoryCabinetUiV1 || {}, selectedChatId: id } } : ui;
    };
    const marinara = {
      apiFetch: (path, init) => shimFetch(`/api/${String(path).replace(/^\/?(api\/)?/, "")}`, init),
      storage: { get: () => shimFetch("/api/_storage").then((r) => r.json()).then(withActive), patch: (patch) => shimFetch("/api/_storage", { method: "POST", body: JSON.stringify({ patch }) }).then((r) => r.json()) },
      log: { warn: (...a) => console.warn(...a), info: (...a) => console.info(...a) },
      onCleanup: (fn) => {
        cleanups.push(fn);
      }
    };
    return { marinara, runCleanups() {
      for (const f of cleanups.splice(0)) {
        try {
          f();
        } catch {}
      }
    } };
  }
  return { createMarinara, request, dispose() {
    try {
      off?.();
    } catch {}
    if (win.fetch === baseFetch && hostFetch)
      win.fetch = hostFetch;
  } };
}

// src/confirm-guard.js
var BLOCK_MS = 25;
var WINDOW_MS = 6000;
function installConfirmGuard(win, doc, { rootId = "mmc-root-v1", launcherId = "mmc-launcher-v1", notify = () => {}, now = () => win.performance?.now?.() ?? Date.now() } = {}) {
  const native = win.confirm;
  if (typeof native !== "function")
    return { dispose() {}, stats: { blocked: 0 } };
  let inOriginal = false, pending = null;
  const stats = { blocked: 0, accepted: 0 };
  const mark = (e) => {
    const t = e.target, within = (n) => {
      for (;n; n = n.parentNode || n.host)
        if (n.id === rootId || n.id === launcherId)
          return true;
      return false;
    };
    if (!within(t))
      return;
    inOriginal = true;
    win.setTimeout(() => {
      inOriginal = false;
    }, 0);
  };
  const EVENTS = ["click", "change", "keydown", "pointerdown", "submit"];
  for (const ev of EVENTS)
    doc.addEventListener(ev, mark, true);
  const wrapped = function confirm2(message) {
    if (!inOriginal)
      return native.call(win, message);
    const t0 = now();
    let answer, threw = false;
    try {
      answer = native.call(win, message);
    } catch {
      threw = true;
    }
    if (!threw && (answer === true || now() - t0 >= BLOCK_MS))
      return !!answer;
    const key = String(message ?? "");
    const t = now();
    if (pending && pending.key === key && t - pending.at < WINDOW_MS) {
      pending = null;
      stats.accepted++;
      return true;
    }
    pending = { key, at: t };
    stats.blocked++;
    try {
      notify("이 브라우저가 확인 창을 막았어요. 같은 버튼을 한 번 더 누르면 실행돼요.", key.slice(0, 120));
    } catch {}
    return false;
  };
  win.confirm = wrapped;
  return {
    stats,
    dispose() {
      for (const ev of EVENTS)
        doc.removeEventListener(ev, mark, true);
      if (win.confirm === wrapped)
        win.confirm = native;
    }
  };
}

// src/download.js
function downloadJson(doc, name, { document: d = globalThis.document, URL: U = globalThis.URL, Blob: B = globalThis.Blob, container = null } = {}) {
  const text = JSON.stringify(doc, null, 1);
  try {
    const url = U.createObjectURL(new B([text], { type: "application/json" }));
    const a = d.createElement("a");
    a.href = url;
    a.download = name;
    a.style.display = "none";
    d.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => {
      try {
        U.revokeObjectURL(url);
      } catch {}
    }, 30000);
    return { method: "blob", bytes: text.length, text };
  } catch {}
  return { ...showText(text, { document: d, container }), method: "textarea" };
}
function showText(text, { document: d = globalThis.document, container = null } = {}) {
  const t = d.createElement("textarea");
  t.value = text;
  t.readOnly = true;
  t.setAttribute("aria-label", "백업 JSON — 전체 선택해 복사하세요");
  if (container) {
    t.className = "mvx-text";
    container.append(t);
  } else {
    t.style.cssText = "position:fixed;inset:10% 5%;width:90%;height:70%;z-index:2147483647";
    d.body.append(t);
  }
  try {
    t.focus?.();
    t.select?.();
  } catch {}
  let copied = false;
  try {
    copied = !!d.execCommand?.("copy");
  } catch {}
  return { copied, bytes: text.length, text, remove: () => t.remove() };
}

// src/panel.js
var ID = "mvx-overlay";
var TOAST = "mvx-toast";
var PANEL_CSS = `
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
var lum = (css) => {
  const m = String(css || "").match(/[\d.]+/g);
  if (!m || m.length < 3 || m[3] !== undefined && +m[3] === 0)
    return null;
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(+m[0]) + 0.7152 * f(+m[1]) + 0.0722 * f(+m[2]);
};
function detectTheme(win, doc) {
  for (const el of [doc.body, doc.documentElement]) {
    try {
      const l = lum(win.getComputedStyle(el).backgroundColor);
      if (l !== null)
        return l < 0.4 ? "dark" : "light";
    } catch {}
  }
  try {
    return win.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}
function createPanel(ctx, { request, activeChatId = () => "" }, { win = globalThis.window, doc = globalThis.document } = {}) {
  const el = (tag, props = {}, ...kids) => {
    const n = doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class")
        n.className = v;
      else if (k.startsWith("on"))
        n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null)
        n.setAttribute(k, v === true ? "" : v);
    }
    n.append(...kids.flat().filter((x) => x != null && x !== false));
    return n;
  };
  const style = el("style");
  style.textContent = PANEL_CSS;
  (doc.head || doc.documentElement).append(style);
  const call = async (method, path, body) => {
    const r = await request(method, path, body);
    if (!r.ok)
      throw new Error(r.error || "요청 실패");
    return r.data;
  };
  let overlay = null, toastTimer = null, status = null, backedUp = false, lastBackup = null, importResult = null, backupText = "", busy = false, action = null, fab = null;
  function toast(message, detail = "") {
    let t = doc.getElementById(TOAST);
    if (!t) {
      t = el("div", { id: TOAST, role: "status", "aria-live": "polite" });
      doc.body.append(t);
    }
    t.dataset.theme = detectTheme(win, doc);
    t.replaceChildren(el("div", {}, message, detail ? el("small", {}, detail) : null));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.replaceChildren(), 7000);
  }
  async function refresh() {
    try {
      status = await call("GET", "_adapter/status");
    } catch (e) {
      status = { error: String(e?.message || e) };
    }
  }
  const mig = () => status?.migrate;
  const migrationPending = () => {
    const m = mig();
    return !!m && !m.error && m.oldChats > 0 && !m.dismissed && !m.importedAt;
  };
  function render() {
    if (!overlay)
      return;
    overlay.dataset.theme = detectTheme(win, doc);
    const body = overlay.querySelector(".mvx-body");
    const s = status || {};
    const parts = [];
    if (s.error)
      parts.push(el("p", { class: "mvx-note" }, `상태를 읽지 못했어요: ${s.error}`));
    if (s.permissions && !s.permissions.generation)
      parts.push(el("p", { class: "mvx-note" }, "이 확장에 generation 권한이 없어요. 자동 분석과 모델 분석이 동작하지 않습니다. 확장 관리에서 권한을 승인해 주세요."));
    if (s.permissions && !s.permissions.world_books)
      parts.push(el("p", { class: "mvx-note" }, "world_books 권한이 없어 승인한 기억을 로어북에 쓸 수 없어요."));
    const input = el("input", { type: "number", id: "mvx-every", min: s.everyMin ?? 3, max: s.everyMax ?? 100, value: s.every ?? 10, inputmode: "numeric", "aria-label": "자동 분석 간격(사용자 턴)" });
    const save = el("button", { type: "button", class: "mvx-primary", id: "mvx-save", onclick: async () => {
      try {
        const r = await call("POST", "_adapter/settings", { every: Number(input.value) });
        s.every = r.every;
        input.value = r.every;
        toast(`${r.every}턴마다 분석 대상을 쌓습니다.`);
      } catch (e) {
        toast(`저장하지 못했어요: ${e.message}`);
      }
    } }, "저장");
    parts.push(el("section", {}, el("h3", {}, "자동 분석 간격"), el("p", { class: "mvx-hint" }, `사용자 메시지가 이 횟수만큼 쌓일 때마다 그 구간의 대화 원문을 하나의 요약으로 만들어 기억 보관함의 분석에 넘깁니다(별도 요약 모델 호출 없음). ${s.everyMin ?? 3}~${s.everyMax ?? 100}, 기본 ${s.everyDefault ?? 10}.`), el("div", { class: "mvx-row" }, el("label", { for: "mvx-every" }, "사용자 턴"), input, save), el("p", { class: "mvx-hint" }, "실제로 분석이 돌려면 기억 보관함 설정의 「새 요약 갱신 방식」을 「자동 분석 후 승인 대기」(또는 완전 자동 적용)로 바꾸고 모델 연결을 골라야 해요. 기본값(알림 + 모델 정리 버튼)에서는 자동으로 모델을 부르지 않습니다.")));
    const m = mig();
    if (m && m.oldChats > 0 && !m.error)
      parts.push(migrationSection(m));
    else if (m?.error && m.error !== "unsupported")
      parts.push(el("p", { class: "mvx-hint" }, `옛 데이터 확인 실패: ${m.error}`));
    parts.push(el("section", {}, el("h3", {}, "알아 둘 점"), el("p", { class: "mvx-hint" }, "인물별 비밀(아는 사람 제한)은 이름이 맞을 때만 보이는 조건문으로 로어북에 저장돼요. 이름을 바꾸면 깨지고, 그룹 채팅의 합치기(merge) 모드에서는 새거나 빠질 수 있어요. 자세한 내용은 README의 「한계」를 보세요.")));
    body.replaceChildren(...parts);
  }
  const SKIP_WHY = { "already has original data": "이미 원본 데이터가 있어요", "nothing importable": "가져올 약속·앵커가 없어요", "chat gone": "채팅을 찾을 수 없어요" };
  function importSummary(r) {
    const imp = r.chats || 0, sk = r.skipped || 0, fl = r.failed || 0;
    const whys = [...new Set((r.skippedList || []).map((x) => SKIP_WHY[x.reason] || x.reason))].join(", ");
    let text;
    if (!imp && !fl)
      text = `가져온 항목이 없어요. 채팅 ${sk}개를 건너뛰었어요${whys ? `(${whys})` : ""}. 기존 데이터는 그대로 안전하고, 받아 둔 백업도 건드리지 않았어요.`;
    else if (!imp)
      text = `가져오지 못했어요. 실패 ${fl}개${sk ? `, 건너뜀 ${sk}개` : ""}. 기존 데이터와 백업은 그대로예요. 다시 시도해 보세요.`;
    else
      text = `가져왔어요: 채팅 ${imp}개(항목 ${r.imported ?? 0}개)${sk ? `, 건너뜀 ${sk}개${whys ? `(${whys})` : ""}` : ""}${fl ? `, 실패 ${fl}개(다시 시도할 수 있어요)` : ""}. 각 채팅에서 기억 보관함을 열어 확인하세요.`;
    return { text };
  }
  function migrationSection(m) {
    const sec = el("section", { id: "mvx-migrate" }, el("h3", {}, "0.4.x 데이터 옮기기"));
    const r = m.result;
    const resultNodes = () => r ? [
      el("p", { class: r.failed || !r.chats && r.skipped ? "mvx-note" : "mvx-ok" }, importSummary(r).text),
      r.skippedList?.length ? el("details", { class: "mvx-skips" }, el("summary", {}, `건너뛴 채팅 ${r.skippedList.length}개 보기`), el("ul", {}, r.skippedList.map((x) => el("li", {}, `${x.name || "(이름 없는 채팅)"} — ${SKIP_WHY[x.reason] || x.reason}`)))) : null,
      importResult && r.chats ? el("p", { class: "mvx-hint" }, `보류로 들어온 항목(주입 안 함) ${Object.values(importResult).reduce((n, x) => n + (x.held || 0), 0)}개. 원본 화면에서 확인하세요.`) : null
    ] : [];
    if (m.importedAt) {
      sec.append(...resultNodes());
      return sec;
    }
    sec.append(el("p", {}, `옛 버전(0.4.x)이 남긴 기억이 채팅 ${m.oldChats}개, 항목 ${m.oldItems}개 있어요. 새 버전은 저장 형식이 달라 자동으로는 이어지지 않아요.`), el("p", { class: "mvx-hint" }, `① 백업을 먼저 받으세요(전부 들어 있어요). ② 약속·앵커 ${m.importable}개만 새 형식으로 가져올 수 있어요. 장면록·요소·흐름·위키·후보·되돌리기는 백업 파일에만 남습니다.`));
    const dl = el("button", { type: "button", id: "mvx-backup", class: backedUp ? "" : "mvx-primary", disabled: busy, onclick: doBackup }, backedUp ? "백업 다시 받기" : "① 백업 받기");
    sec.append(el("div", { class: "mvx-row" }, dl, el("button", { type: "button", id: "mvx-showtext", disabled: busy, onclick: () => doBackup(null, true) }, "텍스트로 보기")));
    if (backupText) {
      sec.append(el("p", { class: "mvx-hint" }, "아래 글을 전부 복사해 메모 앱·파일에 붙여 두세요."));
      const t = el("textarea", { class: "mvx-text", readonly: true, "aria-label": "백업 JSON — 전체 선택해 복사하세요" });
      t.value = backupText;
      sec.append(t);
    } else
      sec.append(el("p", { class: "mvx-hint" }, "받아도 파일이 안 보이면(일부 앱 내 브라우저) 「텍스트로 보기」로 글을 복사해 두세요."));
    const chk = el("input", { type: "checkbox", id: "mvx-saved", disabled: !backedUp });
    chk.checked = !!overlay.dataset.saved;
    chk.addEventListener("change", () => {
      overlay.dataset.saved = chk.checked ? "1" : "";
      render();
    });
    sec.append(el("label", { class: "mvx-check" }, chk, "백업을 저장했어요"));
    sec.append(el("div", { class: "mvx-row" }, el("button", { type: "button", id: "mvx-import", class: "mvx-primary", disabled: busy || !backedUp || !chk.checked, onclick: doImport }, `② 약속·앵커 ${m.importable}개 가져오기`), el("button", { type: "button", id: "mvx-dismiss", disabled: busy, onclick: doDismiss }, "다시 묻지 않기")));
    if (r)
      sec.append(...resultNodes());
    return sec;
  }
  async function doBackup(_e, asText = false) {
    busy = true;
    render();
    try {
      const doc0 = await call("GET", "_migrate/backup");
      const name = `memory-cabinet-0.4-backup-${new Date().toISOString().slice(0, 10)}.json`;
      backedUp = true;
      if (asText) {
        backupText = JSON.stringify(doc0, null, 1);
        lastBackup = { method: "text" };
      } else {
        const sink = doc.createElement("div");
        const r = downloadJson(doc0, name, { document: doc, container: sink });
        lastBackup = { method: r.method, bytes: r.bytes };
        backupText = r.method === "textarea" ? r.text : "";
        toast(r.method === "blob" ? `백업 파일을 만들었어요(${Math.ceil(r.bytes / 1024)}KB). 받은 파일을 확인해 주세요.` : "파일을 만들 수 없어 글로 보여 드려요. 전부 복사해 두세요.");
      }
      await refresh();
    } catch (e) {
      toast(`백업하지 못했어요: ${e.message}`);
    }
    busy = false;
    render();
    if (backupText) {
      const t = overlay.querySelector("textarea.mvx-text");
      try {
        t?.focus();
        t?.select();
        doc.execCommand?.("copy");
      } catch {}
    }
  }
  async function doImport() {
    busy = true;
    render();
    try {
      importResult = await call("POST", "_migrate/apply", { confirmBackup: true });
      await refresh();
      const rows = Object.values(importResult || {});
      toast(importSummary({ chats: rows.filter((x) => !x.skipped && !x.failed).length, imported: rows.reduce((n, x) => n + (x.items || 0), 0), skipped: rows.filter((x) => x.skipped).length, failed: rows.filter((x) => x.failed).length, skippedList: rows.filter((x) => x.skipped).map((x) => ({ name: x.name, reason: x.skipped })) }).text);
    } catch (e) {
      toast(`가져오지 못했어요: ${e.message}`);
    }
    busy = false;
    render();
  }
  async function doDismiss() {
    try {
      await call("POST", "_migrate/dismiss");
      await refresh();
    } catch {}
    render();
  }
  async function open() {
    if (!overlay) {
      const card = el("div", { class: "mvx-card", role: "dialog", "aria-modal": "true", "aria-labelledby": "mvx-title" }, el("div", { class: "mvx-head" }, el("h2", { id: "mvx-title" }, "기억 보관함 설정"), el("button", { type: "button", id: "mvx-close", "aria-label": "닫기", onclick: close }, "닫기")), el("div", { class: "mvx-body" }));
      overlay = el("div", { id: ID }, card);
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay)
          close();
      });
      overlay.addEventListener("keydown", (e) => {
        if (e.key === "Escape")
          close();
      });
      doc.body.append(overlay);
    }
    overlay.hidden = false;
    render();
    await refresh();
    render();
    try {
      overlay.querySelector("#mvx-close")?.focus();
    } catch {}
  }
  function close() {
    if (overlay)
      overlay.hidden = true;
  }
  try {
    const a = ctx.ui?.registerInputBarAction?.({ id: "memory-cabinet-settings", label: "기억 보관함 설정", subtitle: "자동 분석 간격 · 옛 데이터 옮기기" });
    if (a) {
      action = a;
      a.onClick(() => {
        open();
      });
    }
  } catch {}
  if (!action) {
    fab = el("button", { type: "button", id: "mvx-fab", "aria-label": "기억 보관함 설정", onclick: () => {
      open();
    } }, "기억 설정");
    fab.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:2147482000;min-height:44px;min-width:44px;padding:0 12px;font:15px system-ui;border-radius:12px;border:1px solid #888;background:#fff;color:#111;opacity:.9";
    doc.body.append(fab);
  }
  return {
    open,
    close,
    toast,
    refresh,
    async promptIfMigrationPending() {
      await refresh();
      if (migrationPending())
        await open();
    },
    dispose() {
      try {
        action?.destroy?.();
      } catch {}
      overlay?.remove();
      fab?.remove();
      doc.getElementById(TOAST)?.remove();
      style.remove();
      clearTimeout(toastTimer);
    }
  };
}

// src/host-theme.js
var SEL = ["#mmc-root-v1", ".mmc-launcher", ".mmc-toast"].map((s) => `${s}[data-mmc-theme="marinara"]`).join(",");
var num = (c) => (String(c).match(/-?[\d.]+(?:e-?\d+)?/g) || []).map(Number);
function parse(c) {
  const n = num(c);
  if (n.length < 3)
    return null;
  const k = /^color\(/.test(c) ? 255 : 1;
  return { r: n[0] * k, g: n[1] * k, b: n[2] * k, a: n[3] === undefined ? 1 : n[3] };
}
var over = (c, b) => ({ r: c.r * c.a + b.r * (1 - c.a), g: c.g * c.a + b.g * (1 - c.a), b: c.b * c.a + b.b * (1 - c.a), a: 1 });
var lum2 = (c) => {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
};
var contrast = (a, b) => {
  const x = lum2(a), y = lum2(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
var css = (c) => `rgb(${Math.round(c.r)} ${Math.round(c.g)} ${Math.round(c.b)})`;
var WHITE = { r: 255, g: 255, b: 255, a: 1 };
var BLACK = { r: 20, g: 18, b: 32, a: 1 };
function readable(fg, surfaces, min = 4.6) {
  const list = [].concat(surfaces);
  const dark = lum2(list[0]) < 0.4;
  let c = fg, i = 0;
  while (list.some((b) => contrast(c, b) < min) && i++ < 64) {
    const d = dark ? 6 : -6;
    c = { ...c, r: Math.max(0, Math.min(255, c.r + d)), g: Math.max(0, Math.min(255, c.g + d)), b: Math.max(0, Math.min(255, c.b + d)) };
  }
  return c;
}
var mixc = (a, b, p) => ({ r: a.r * p + b.r * (1 - p), g: a.g * p + b.g * (1 - p), b: a.b * p + b.b * (1 - p), a: 1 });
function installHostTheme(win, doc) {
  const style = doc.createElement("style");
  style.id = "mvx-host-theme";
  (doc.head || doc.documentElement).append(style);
  let timer = null, observer = null, last = "";
  function resolve(varName, fallback) {
    try {
      const p = doc.createElement("span");
      p.style.cssText = `position:absolute;visibility:hidden;color:var(${varName},${fallback})`;
      doc.body.append(p);
      const c = parse(win.getComputedStyle(p).color);
      p.remove();
      return c;
    } catch {
      return null;
    }
  }
  function update() {
    try {
      if (!win.getComputedStyle)
        return;
      const deep = resolve("--lumiverse-bg-deep", "#faf8ff") || { r: 250, g: 248, b: 255, a: 1 };
      deep.a = 1;
      const bg = over(resolve("--lumiverse-bg", "#faf8ff") || deep, deep);
      const card = over(resolve("--lumiverse-bg-elevated", "#ffffff") || bg, bg);
      const dark = lum2(bg) < 0.4;
      const fg = readable(over(resolve("--lumiverse-text", "#1a1025") || BLACK, bg), [bg, card], 7);
      const sunk = mixc(bg, fg, 0.9), paper2 = mixc(card, fg, 0.94);
      const muted = readable(over(resolve("--lumiverse-text-muted", "#5d5c75") || fg, card), [bg, card, sunk, paper2, mixc(bg, fg, 0.8)]);
      const border = over(resolve("--lumiverse-border", "rgba(128,128,128,.3)") || { r: 128, g: 128, b: 128, a: 0.3 }, card);
      const ink = dark ? BLACK : WHITE;
      let primary = over(resolve("--lumiverse-primary", "#5b5fb5") || { r: 91, g: 95, b: 181, a: 1 }, bg), n = 0;
      while ((contrast(ink, primary) < 4.7 || contrast(primary, card) < 4.6 || contrast(primary, bg) < 4.6 || contrast(primary, mixc(primary, card, 0.15)) < 4.6) && n++ < 64) {
        const d = dark ? 5 : -5;
        primary = { ...primary, r: Math.max(0, Math.min(255, primary.r + d)), g: Math.max(0, Math.min(255, primary.g + d)), b: Math.max(0, Math.min(255, primary.b + d)) };
      }
      const accentText = primary;
      const tone = { ok: dark ? { r: 126, g: 224, b: 160, a: 1 } : { r: 26, g: 102, b: 68, a: 1 }, warn: dark ? { r: 255, g: 207, b: 138, a: 1 } : { r: 138, g: 75, b: 0, a: 1 }, bad: dark ? { r: 255, g: 154, b: 147, a: 1 } : { r: 179, g: 38, b: 30, a: 1 }, hold: dark ? { r: 214, g: 201, b: 150, a: 1 } : { r: 107, g: 93, b: 50, a: 1 } };
      const body = `--background:${css(bg)};--card:${css(card)};--foreground:${css(fg)};--muted-foreground:${css(muted)};--border:${css(border)};--primary:${css(primary)};--primary-foreground:${css(ink)};--success:${css(tone.ok)};--destructive:${css(tone.bad)};--mv-warn:${css(tone.warn)};--mv-hold:${css(tone.hold)};--mv-wiki-link:${css(accentText)};--mv-wiki-head-ink:${css(fg)};color-scheme:${dark ? "dark" : "light"};`;
      if (body !== last) {
        last = body;
        style.textContent = `${SEL}{${body}}`;
      }
    } catch {}
  }
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(update, 60);
  };
  update();
  try {
    if (win.MutationObserver) {
      observer = new win.MutationObserver(later);
      for (const n of [doc.documentElement, doc.body])
        n && observer.observe(n, { attributes: true, attributeFilter: ["style", "class", "data-theme"] });
    }
  } catch {}
  return { update, dispose() {
    clearTimeout(timer);
    observer?.disconnect();
    style.remove();
  } };
}

// src/launcher-drag.js
var DRAG_THRESHOLD = 8;
var LONG_PRESS_MS = 700;
var EDGE_GAP = 4;
var KEY = "mvx-launcher-pos-v1";
function clampPos({ y }, { h }, { vh }, ins = {}, gap = EDGE_GAP) {
  const minY = (ins.top || 0) + gap;
  const maxY = Math.max(minY, vh - (ins.bottom || 0) - gap - h);
  return { y: Math.round(Math.min(maxY, Math.max(minY, Number.isFinite(y) ? y : minY))) };
}
function toFrac(pos, size, view, ins = {}, gap = EDGE_GAP) {
  const lo = clampPos({ y: -1e9 }, size, view, ins, gap), hi = clampPos({ y: 1e9 }, size, view, ins, gap);
  const { y } = clampPos(pos, size, view, ins, gap);
  return { fy: hi.y === lo.y ? 0 : (y - lo.y) / (hi.y - lo.y) };
}
function fromFrac({ fy }, size, view, ins = {}, gap = EDGE_GAP) {
  const lo = clampPos({ y: -1e9 }, size, view, ins, gap), hi = clampPos({ y: 1e9 }, size, view, ins, gap);
  const f = Math.min(1, Math.max(0, Number.isFinite(fy) ? fy : 0));
  return clampPos({ y: lo.y + f * (hi.y - lo.y) }, size, view, ins, gap);
}
function parseStored(raw) {
  try {
    const o = JSON.parse(raw);
    return o && Number.isFinite(o.fy) ? { fy: o.fy } : null;
  } catch {
    return null;
  }
}
function installLauncherDrag(win, doc, { id = "mmc-launcher-v1", notify = () => {}, storage } = {}) {
  const store = { get() {
    try {
      return (storage || win.localStorage).getItem(KEY);
    } catch {
      return null;
    }
  }, set(v) {
    try {
      (storage || win.localStorage).setItem(KEY, v);
    } catch {}
  }, del() {
    try {
      (storage || win.localStorage).removeItem(KEY);
    } catch {}
  } };
  let el = null, saved = parseStored(store.get()), probe = null;
  let g = null;
  let swallow = false;
  const insets = () => {
    try {
      if (!probe) {
        probe = doc.createElement("div");
        probe.setAttribute("aria-hidden", "true");
        probe.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top,0px) 0 env(safe-area-inset-bottom,0px) 0";
        doc.body.append(probe);
      }
      const s = win.getComputedStyle(probe);
      return { top: parseFloat(s.paddingTop) || 0, bottom: parseFloat(s.paddingBottom) || 0 };
    } catch {
      return {};
    }
  };
  const view = () => ({ vh: Math.round(win.innerHeight || doc.documentElement.clientHeight) });
  const size = () => ({ h: Math.max(44, el.getBoundingClientRect().height) });
  const place = (p) => {
    el.style.setProperty("top", p.y + "px", "important");
    el.style.setProperty("bottom", "auto", "important");
  };
  const unplace = () => {
    for (const k of ["top", "bottom"])
      el.style.removeProperty(k);
  };
  const apply = () => {
    if (!el)
      return;
    if (saved) {
      place(fromFrac(saved, size(), view(), insets()));
      return;
    }
    unplace();
    const y = el.getBoundingClientRect().top;
    const p = clampPos({ y }, size(), view(), insets());
    if (p.y !== Math.round(y))
      place(p);
  };
  function reset() {
    saved = null;
    store.del();
    apply();
  }
  function onDown(e) {
    if (e.button > 0 || g && g.id !== e.pointerId)
      return;
    const r = el.getBoundingClientRect();
    g = { id: e.pointerId, sx: e.clientX, sy: e.clientY, oy: r.top, dragging: false, long: false, timer: null };
    try {
      el.setPointerCapture?.(e.pointerId);
    } catch {}
    g.timer = win.setTimeout(() => {
      if (g && !g.dragging) {
        g.long = true;
        swallow = true;
        reset();
        notify("기억 버튼 위치를 처음으로 돌렸어요.");
      }
    }, LONG_PRESS_MS);
  }
  function onMove(e) {
    if (!g || e.pointerId !== g.id || g.long)
      return;
    const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
    if (!g.dragging) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD)
        return;
      g.dragging = true;
      win.clearTimeout(g.timer);
    }
    e.preventDefault?.();
    place(clampPos({ y: g.oy + dy }, size(), view(), insets()));
  }
  function onUp(e) {
    if (!g || e.pointerId !== g.id)
      return;
    win.clearTimeout(g.timer);
    try {
      el.releasePointerCapture?.(e.pointerId);
    } catch {}
    if (g.dragging && e.type === "pointerup") {
      const r = el.getBoundingClientRect();
      saved = toFrac({ y: r.top }, size(), view(), insets());
      store.set(JSON.stringify(saved));
    }
    if (g.dragging || g.long) {
      swallow = true;
      win.setTimeout(() => {
        swallow = false;
      }, 400);
    }
    g = null;
  }
  const onClick = (e) => {
    if (swallow && el && (e.target === el || el.contains(e.target))) {
      swallow = false;
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  };
  const onCtx = (e) => {
    if (e.target === el || el?.contains?.(e.target))
      e.preventDefault();
  };
  const onResize = () => apply();
  function attach(node) {
    if (el === node)
      return;
    el = node;
    el.style.touchAction = "none";
    el.style.userSelect = "none";
    el.style.setProperty("-webkit-user-select", "none");
    el.style.setProperty("-webkit-touch-callout", "none");
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    apply();
  }
  const scan = () => {
    const n = doc.getElementById(id);
    if (n && n !== el)
      attach(n);
    else if (!n)
      el = null;
  };
  let mo = null;
  try {
    mo = new win.MutationObserver(scan);
    mo.observe(doc.body, { childList: true });
  } catch {}
  scan();
  win.addEventListener("click", onClick, true);
  win.addEventListener("contextmenu", onCtx, true);
  win.addEventListener("resize", onResize);
  win.addEventListener("orientationchange", onResize);
  return {
    reset,
    apply,
    get saved() {
      return saved;
    },
    dispose() {
      mo?.disconnect();
      win.removeEventListener("click", onClick, true);
      win.removeEventListener("contextmenu", onCtx, true);
      win.removeEventListener("resize", onResize);
      win.removeEventListener("orientationchange", onResize);
      win.clearTimeout(g?.timer);
      probe?.remove();
    }
  };
}

// src/original.generated.js
var ORIGINAL_CSS = `/* 기억 보관함 v2.0.0 · 전역 테마 하나(리본 라일락·스토리 로즈·아카이브 그린·마리나라 따르기)가 보관함과 이야기 위키를 함께 칠한다 */
#mmc-root-v1,.mmc-launcher,.mmc-toast{--fs:1;--t-2xs:calc(10.5px*var(--fs));--t-xs:calc(11.5px*var(--fs));--t-sm:calc(12.5px*var(--fs));--t-md:calc(13.5px*var(--fs));--t-lg:calc(15px*var(--fs));--t-xl:calc(17px*var(--fs));--t-2xl:calc(22px*var(--fs));--t-3xl:calc(28px*var(--fs));--mv-font:var(--font-y2k,var(--font-user,-apple-system,BlinkMacSystemFont,"Segoe UI","Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif));--mv-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--mv-r:12px;--mv-r-sm:8px;font-family:var(--mv-font);}
#mmc-root-v1[data-mmc-font-size="large"],.mmc-toast[data-mmc-font-size="large"]{--fs:1.1}
#mmc-root-v1[data-mmc-font-size="xlarge"],.mmc-toast[data-mmc-font-size="xlarge"]{--fs:1.2}
#mmc-root-v1,.mmc-launcher,.mmc-toast,#mmc-root-v1[data-mmc-theme="ribbon"],.mmc-launcher[data-mmc-theme="ribbon"],.mmc-toast[data-mmc-theme="ribbon"]{--mv-bg:#f4f3f9;--mv-paper:#ffffff;--mv-paper-2:#f9f8fd;--mv-sunk:#efeef6;--mv-ink:#23222e;--mv-ink-2:#4f4e63;--mv-muted:#7c7b93;--mv-line:#e4e2ee;--mv-line-2:#cfcce0;--mv-accent:#5b5fb5;--mv-accent-ink:#ffffff;--mv-accent-soft:#ebebf9;--mv-accent-2:#b0679a;--mv-ok:#2e8a62;--mv-warn:#b7791f;--mv-danger:#c0474f;--mv-hold:#8a7f5a;--mv-wiki-link:#4450c4;--mv-wiki-missing:#cc3f3a;--mv-wiki-head:#5b5fb5;--mv-wiki-head-ink:#ffffff;--mv-wiki-box:#f6f5fb;--mv-wiki-rule:#d6d4e6;--mv-scrim:rgba(35,34,46,.42);--mv-shadow:0 30px 80px rgba(35,34,46,.28);}
#mmc-root-v1[data-mmc-theme="rose"],.mmc-launcher[data-mmc-theme="rose"],.mmc-toast[data-mmc-theme="rose"]{--mv-bg:#f7f1f0;--mv-paper:#fffdfc;--mv-paper-2:#fbf6f5;--mv-sunk:#f2e9e8;--mv-ink:#2c2224;--mv-ink-2:#5d4a4e;--mv-muted:#8f7c82;--mv-line:#ecdfdf;--mv-line-2:#dac7c9;--mv-accent:#a14c64;--mv-accent-ink:#ffffff;--mv-accent-soft:#f6e5ea;--mv-accent-2:#7c6a4f;--mv-ok:#3d7f5f;--mv-warn:#aa7424;--mv-danger:#b8404a;--mv-hold:#8d7a55;--mv-wiki-link:#a53f5c;--mv-wiki-missing:#c4382f;--mv-wiki-head:#7d3c4e;--mv-wiki-head-ink:#ffffff;--mv-wiki-box:#faf3f3;--mv-wiki-rule:#e2d1d3;--mv-scrim:rgba(44,34,36,.42);--mv-shadow:0 30px 80px rgba(44,34,36,.28);}
#mmc-root-v1[data-mmc-theme="green"],.mmc-launcher[data-mmc-theme="green"],.mmc-toast[data-mmc-theme="green"]{--mv-bg:#f2f5f4;--mv-paper:#ffffff;--mv-paper-2:#f8faf9;--mv-sunk:#eaf0ee;--mv-ink:#1f2523;--mv-ink-2:#46514e;--mv-muted:#76837f;--mv-line:#dde5e2;--mv-line-2:#c6d2ce;--mv-accent:#00897b;--mv-accent-ink:#ffffff;--mv-accent-soft:#dcf2ef;--mv-accent-2:#0f7fbd;--mv-ok:#1f8a57;--mv-warn:#b7791f;--mv-danger:#d0453f;--mv-hold:#7f8663;--mv-wiki-link:#0f7fbd;--mv-wiki-missing:#d0453f;--mv-wiki-head:#00a495;--mv-wiki-head-ink:#ffffff;--mv-wiki-box:#f5f7f7;--mv-wiki-rule:#ccd6d3;--mv-scrim:rgba(31,37,35,.42);--mv-shadow:0 30px 80px rgba(31,37,35,.26);}
#mmc-root-v1[data-mmc-theme="marinara"],.mmc-launcher[data-mmc-theme="marinara"],.mmc-toast[data-mmc-theme="marinara"]{--mv-bg:var(--background,#faf8ff);--mv-paper:var(--card,#ffffff);--mv-paper-2:color-mix(in srgb,var(--card,#fff) 94%,var(--foreground,#1a1025));--mv-sunk:color-mix(in srgb,var(--background,#faf8ff) 90%,var(--foreground,#1a1025));--mv-ink:var(--foreground,#1a1025);--mv-ink-2:color-mix(in srgb,var(--foreground,#1a1025) 80%,var(--background,#fff));--mv-muted:var(--muted-foreground,#7a64a0);--mv-line:var(--border,color-mix(in srgb,var(--foreground,#1a1025) 14%,transparent));--mv-line-2:color-mix(in srgb,var(--border,#ddd) 65%,var(--foreground,#1a1025));--mv-accent:var(--primary,#8b6cf0);--mv-accent-ink:var(--primary-foreground,#ffffff);--mv-accent-soft:color-mix(in srgb,var(--primary,#8b6cf0) 15%,var(--card,#fff));--mv-accent-2:color-mix(in srgb,var(--primary,#8b6cf0) 45%,#d0679f);--mv-ok:var(--success,#3f9a6e);--mv-warn:#c08a2e;--mv-danger:var(--destructive,#d9534f);--mv-hold:#9a8a5f;--mv-wiki-link:var(--primary,#8b6cf0);--mv-wiki-missing:var(--destructive,#d9534f);--mv-wiki-head:color-mix(in srgb,var(--primary,#8b6cf0) 42%,var(--card,#fff));--mv-wiki-head-ink:var(--foreground,#1a1025);--mv-wiki-box:color-mix(in srgb,var(--card,#fff) 94%,var(--foreground,#1a1025));--mv-wiki-rule:var(--border,#ddd);--mv-scrim:color-mix(in srgb,var(--background,#000) 55%,transparent);--mv-shadow:0 30px 80px rgba(0,0,0,.35);}
#mmc-root-v1[hidden]{display:none!important}
#mmc-root-v1 [hidden]{display:none!important}
#mmc-root-v1 *,#mmc-root-v1 *::before,#mmc-root-v1 *::after,.mmc-launcher *{box-sizing:border-box}
#mmc-root-v1 button,#mmc-root-v1 input,#mmc-root-v1 select,#mmc-root-v1 textarea{font-family:inherit;letter-spacing:normal}
#mmc-root-v1 button{cursor:pointer;-webkit-tap-highlight-color:transparent}
#mmc-root-v1 button:disabled{cursor:not-allowed}
#mmc-root-v1 .mmc-svg,.mmc-launcher .mmc-svg{display:block!important;overflow:visible!important;fill:none!important;stroke:currentColor!important;stroke-linecap:round!important;stroke-linejoin:round!important;pointer-events:none!important;flex:none;width:18px;height:18px}
.mmc-launcher{position:fixed;right:0;top:44%;z-index:141;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;width:46px;height:58px;padding:0;border:1px solid color-mix(in srgb,var(--mv-accent) 70%,#000);border-right:0;border-radius:14px 0 0 14px;background:var(--mv-accent);color:var(--mv-accent-ink);box-shadow:-4px 6px 18px rgba(0,0,0,.18);cursor:pointer;font-family:var(--mv-font);overflow:visible}
.mmc-launcher .mmc-svg{width:20px;height:20px}
.mmc-launcher span{font-size:10px;font-weight:800;letter-spacing:.04em;line-height:1;writing-mode:horizontal-tb}
.mmc-launcher:hover{width:50px}
.mmc-launcher-badge{position:absolute;top:-6px;left:-7px;min-width:19px;height:19px;padding:0 5px;border:2px solid var(--mv-paper);border-radius:999px;background:var(--mv-danger);color:#fff;font:800 10px/15px var(--mv-mono);font-style:normal;text-align:center}
.mmc-launcher-badge[hidden]{display:none!important}
.mmc-launcher.has-summary-alert{animation:mmc-nudge 2.4s ease-in-out 2}
@keyframes mmc-nudge{0%,100%{transform:none}40%{transform:translateX(-4px)}60%{transform:translateX(0)}}
.mmc-toast{position:fixed;left:50%;bottom:28px;z-index:220;max-width:min(520px,calc(100vw - 32px));transform:translate(-50%,14px);opacity:0;pointer-events:none;padding:10px 16px;border-radius:12px;background:var(--mv-ink);color:var(--mv-paper);font:600 var(--t-sm)/1.45 var(--mv-font);box-shadow:0 10px 30px rgba(0,0,0,.25);transition:opacity .18s,transform .18s}
.mmc-toast.is-show{opacity:1;transform:translate(-50%,0)}
.mmc-toast.is-error{background:var(--mv-danger);color:#fff}
@media(max-width:700px){.mmc-launcher{top:auto;bottom:188px;width:42px;height:52px}
.mmc-toast{bottom:calc(84px + env(safe-area-inset-bottom))}}
#mmc-root-v1 .mmc-overlay{position:fixed;inset:0;z-index:170;display:flex;align-items:center;justify-content:center;padding:20px;background:var(--mv-scrim);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px)}
#mmc-root-v1 .mmc-shell{position:relative;width:min(1180px,100%);height:min(900px,calc(100dvh - 40px));display:grid;grid-template-rows:auto auto minmax(0,1fr);overflow:hidden;border:1px solid var(--mv-line-2);border-radius:18px;background:var(--mv-bg);color:var(--mv-ink);box-shadow:var(--mv-shadow);font-size:var(--t-md);line-height:1.5}
#mmc-root-v1 .mmc-bar{display:flex;align-items:center;gap:12px;min-width:0;padding:14px 18px 12px;background:var(--mv-paper)}
#mmc-root-v1 .mmc-brand{display:flex;align-items:center;gap:11px;min-width:0;flex:none}
#mmc-root-v1 .mmc-brand-mark{display:grid;place-items:center;width:40px;height:40px;border-radius:12px;background:var(--mv-accent);color:var(--mv-accent-ink)}
#mmc-root-v1 .mmc-brand-mark .mmc-svg{width:21px;height:21px}
#mmc-root-v1 .mmc-brand-text{display:flex;flex-direction:column;line-height:1.15}
#mmc-root-v1 .mmc-brand-text b{font-size:var(--t-xl);font-weight:800;letter-spacing:-.02em}
#mmc-root-v1 .mmc-brand-text small{margin-top:3px;color:var(--mv-muted);font:600 var(--t-2xs)/1 var(--mv-mono);letter-spacing:.08em}
#mmc-root-v1 .mmc-story{display:flex;align-items:center;gap:10px;min-width:0;max-width:340px;margin-left:10px;padding:6px 12px 6px 7px;border:1px solid var(--mv-line);border-radius:12px;background:var(--mv-paper-2);cursor:pointer}
#mmc-root-v1 .mmc-story:hover{border-color:var(--mv-line-2)}
#mmc-root-v1 .mmc-story-icon{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:var(--mv-accent-soft);color:var(--mv-accent);flex:none}
#mmc-root-v1 .mmc-story-icon .mmc-svg{width:17px;height:17px}
#mmc-root-v1 .mmc-story-copy{display:flex;flex-direction:column;min-width:0;flex:1}
#mmc-root-v1 .mmc-story-copy small{color:var(--mv-muted);font-size:var(--t-2xs);line-height:1.2}
#mmc-root-v1 .mmc-story-copy select{appearance:auto;min-width:0;width:100%;margin:0 0 0 -3px;padding:0;border:0;background:transparent;color:var(--mv-ink);font-size:var(--t-md);font-weight:800;outline:none;cursor:pointer}
#mmc-root-v1 .mmc-bar-spacer{flex:1}
#mmc-root-v1 .mmc-sync{display:inline-flex;align-items:center;gap:7px;min-height:32px;padding:0 11px;border:1px solid var(--mv-line);border-radius:999px;background:var(--mv-paper);color:var(--mv-ink-2);font-size:var(--t-xs);font-weight:700;white-space:nowrap}
#mmc-root-v1 .mmc-sync .mmc-svg{width:14px;height:14px;color:var(--mv-muted)}
#mmc-root-v1 .mmc-sync:hover{border-color:var(--mv-accent);color:var(--mv-accent)}
#mmc-root-v1 .mmc-sync-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--mv-line-2);flex:none}
#mmc-root-v1 .mmc-element-status .mmc-sync-dot{margin-right:6px;vertical-align:0}
#mmc-root-v1 .mmc-sync.is-ok,#mmc-root-v1 .mmc-sync.is-ok .mmc-svg{color:var(--mv-ok)}
#mmc-root-v1 .mmc-sync.is-ok{background:color-mix(in srgb,var(--mv-ok) 9%,var(--mv-paper));border-color:color-mix(in srgb,var(--mv-ok) 30%,var(--mv-line))}
#mmc-root-v1 .mmc-sync.is-ok .mmc-sync-dot,#mmc-root-v1 .mmc-sync-dot.is-ok{background:var(--mv-ok)}
#mmc-root-v1 .mmc-sync.is-bad{color:var(--mv-danger);border-color:color-mix(in srgb,var(--mv-danger) 40%,var(--mv-line));background:color-mix(in srgb,var(--mv-danger) 8%,var(--mv-paper))}
#mmc-root-v1 .mmc-sync.is-bad .mmc-sync-dot{background:var(--mv-danger)}
#mmc-root-v1 .mmc-head-actions{display:flex;gap:4px;flex:none}
#mmc-root-v1 .mmc-icon-btn{display:grid;place-items:center;width:36px;height:36px;padding:0;border:1px solid transparent;border-radius:10px;background:transparent;color:var(--mv-ink-2)}
#mmc-root-v1 .mmc-icon-btn:hover{background:var(--mv-sunk);color:var(--mv-ink)}
#mmc-root-v1 .mmc-icon-btn .mmc-svg{width:19px;height:19px}
#mmc-root-v1 .mmc-tabs{display:flex;align-items:flex-end;gap:2px;padding:0 14px;border-bottom:1px solid var(--mv-line-2);background:var(--mv-paper);overflow-x:auto;scrollbar-width:none}
#mmc-root-v1 .mmc-tabs::-webkit-scrollbar{display:none}
#mmc-root-v1 .mmc-tab{position:relative;display:inline-flex;align-items:center;gap:8px;min-height:44px;margin-bottom:-1px;padding:0 15px;border:1px solid transparent;border-bottom:0;border-radius:12px 12px 0 0;background:transparent;color:var(--mv-muted);font-size:var(--t-md);font-weight:700;white-space:nowrap}
#mmc-root-v1 .mmc-tab:hover{color:var(--mv-ink)}
#mmc-root-v1 .mmc-tab .mmc-svg{width:17px;height:17px}
#mmc-root-v1 .mmc-tab em{min-width:20px;height:20px;padding:0 6px;border-radius:999px;background:var(--mv-sunk);color:var(--mv-ink-2);font:700 var(--t-2xs)/20px var(--mv-mono);font-style:normal;text-align:center}
#mmc-root-v1 .mmc-tab-short{display:none}
#mmc-root-v1 .mmc-tab-dot{width:7px;height:7px;border-radius:50%;background:var(--mv-accent-2)}
#mmc-root-v1 .mmc-tab.is-active{border-color:var(--mv-line-2);background:var(--mv-bg);color:var(--mv-ink)}
#mmc-root-v1 .mmc-tab.is-active::before{content:"";position:absolute;left:12px;right:12px;top:-1px;height:3px;border-radius:0 0 3px 3px;background:var(--mv-accent)}
#mmc-root-v1 .mmc-tab.is-active em{background:var(--mv-accent);color:var(--mv-accent-ink)}
#mmc-root-v1 .mmc-tab.is-active .mmc-svg{color:var(--mv-accent)}
#mmc-root-v1 .mmc-body{min-height:0;overflow:auto;padding:18px 20px 26px;background:var(--mv-bg);overscroll-behavior:contain}
#mmc-root-v1 .mmc-shell[data-tab="wiki"] .mmc-body{padding:0;overflow:hidden}
#mmc-root-v1 .mmc-card{border:1px solid var(--mv-line);border-radius:var(--mv-r);background:var(--mv-paper)}
#mmc-root-v1 .mmc-card-head{display:flex;align-items:center;gap:8px;padding:14px 16px 10px}
#mmc-root-v1 .mmc-card-head b{font-size:var(--t-lg);font-weight:800}
#mmc-root-v1 .mmc-count{min-width:22px;height:22px;padding:0 7px;border-radius:999px;background:var(--mv-accent-soft);color:var(--mv-accent);font:800 var(--t-xs)/22px var(--mv-mono);font-style:normal;text-align:center}
#mmc-root-v1 .mmc-eyebrow{display:block;color:var(--mv-muted);font-size:var(--t-xs);font-weight:700;letter-spacing:.02em}
#mmc-root-v1 .mmc-kicker{display:block;color:var(--mv-muted);font:700 var(--t-2xs)/1.3 var(--mv-mono);letter-spacing:.08em}
#mmc-root-v1 .mmc-muted{color:var(--mv-muted)}
#mmc-root-v1 .mmc-label{display:block;margin-bottom:6px;color:var(--mv-muted);font-size:var(--t-xs);font-weight:800;letter-spacing:.02em}
#mmc-root-v1 .mmc-pill{display:inline-flex;align-items:center;min-height:28px;padding:0 12px;border-radius:999px;background:var(--mv-sunk);color:var(--mv-ink-2);font-size:var(--t-xs);font-weight:800;white-space:nowrap}
#mmc-root-v1 .mmc-pill.is-ok{background:color-mix(in srgb,var(--mv-ok) 13%,var(--mv-paper));color:var(--mv-ok)}
#mmc-root-v1 .mmc-pill.is-bad{background:color-mix(in srgb,var(--mv-danger) 12%,var(--mv-paper));color:var(--mv-danger)}
#mmc-root-v1 .mmc-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:0 14px;border:1px solid var(--mv-line-2);border-radius:10px;background:var(--mv-paper);color:var(--mv-ink);font-size:var(--t-sm);font-weight:700;line-height:1.2;white-space:nowrap;text-decoration:none;word-break:keep-all}
#mmc-root-v1 .mmc-btn .mmc-svg{width:16px;height:16px}
#mmc-root-v1 .mmc-btn:hover{border-color:var(--mv-accent);color:var(--mv-accent)}
#mmc-root-v1 .mmc-btn:disabled{opacity:.45;pointer-events:none}
#mmc-root-v1 .mmc-btn.mmc-sm{min-height:30px;padding:0 11px;border-radius:9px;font-size:var(--t-xs)}
#mmc-root-v1 .mmc-btn.mmc-sm .mmc-svg{width:14px;height:14px}
#mmc-root-v1 .mmc-btn.mmc-primary{border-color:var(--mv-accent);background:var(--mv-accent);color:var(--mv-accent-ink)}
#mmc-root-v1 .mmc-btn.mmc-primary:hover{background:color-mix(in srgb,var(--mv-accent) 88%,#000);color:var(--mv-accent-ink)}
#mmc-root-v1 .mmc-btn.mmc-model-btn{border-color:color-mix(in srgb,var(--mv-accent-2) 50%,var(--mv-line));background:color-mix(in srgb,var(--mv-accent-2) 10%,var(--mv-paper));color:color-mix(in srgb,var(--mv-accent-2) 80%,var(--mv-ink))}
#mmc-root-v1 .mmc-btn.mmc-model-btn:hover{border-color:var(--mv-accent-2)}
#mmc-root-v1 .mmc-btn.mmc-soft{border-color:transparent;background:var(--mv-accent-soft);color:var(--mv-accent)}
#mmc-root-v1 .mmc-btn.mmc-ghost{border-color:transparent;background:transparent;color:var(--mv-ink-2)}
#mmc-root-v1 .mmc-btn.mmc-ghost:hover{background:var(--mv-sunk);color:var(--mv-ink)}
#mmc-root-v1 .mmc-btn.mmc-danger{border-color:color-mix(in srgb,var(--mv-danger) 40%,var(--mv-line));color:var(--mv-danger)}
#mmc-root-v1 .mmc-btn.mmc-danger:hover{background:color-mix(in srgb,var(--mv-danger) 8%,var(--mv-paper));border-color:var(--mv-danger)}
#mmc-root-v1 .mmc-btn.mmc-danger-text{color:var(--mv-danger)}
#mmc-root-v1 .mmc-link{display:inline;padding:0;border:0;background:none;color:var(--mv-accent);font-size:inherit;font-weight:700;text-decoration:underline;text-underline-offset:2px}
#mmc-root-v1 .mmc-mini{min-height:24px;padding:0 8px;border:1px solid var(--mv-line);border-radius:7px;background:var(--mv-paper);color:var(--mv-muted);font-size:var(--t-2xs);font-weight:700;white-space:nowrap}
#mmc-root-v1 .mmc-mini:hover{border-color:var(--mv-accent);color:var(--mv-accent)}
#mmc-root-v1 .mmc-actions{display:flex;flex-wrap:wrap;gap:6px}
#mmc-root-v1 .mmc-inline-actions{display:flex;gap:6px;flex-wrap:wrap}
#mmc-root-v1 .mmc-chips{display:flex;flex-wrap:wrap;gap:5px}
#mmc-root-v1 .mmc-chip{display:inline-flex;align-items:center;min-height:22px;padding:0 8px;border:1px solid var(--mv-line);border-radius:999px;background:var(--mv-paper);color:var(--mv-ink-2);font-size:var(--t-2xs);font-weight:700;white-space:nowrap}
#mmc-root-v1 .mmc-chip.is-soft{border-color:transparent;background:var(--mv-sunk);color:var(--mv-ink-2)}
#mmc-root-v1 .mmc-chip.is-ok{border-color:transparent;background:color-mix(in srgb,var(--mv-ok) 13%,var(--mv-paper));color:var(--mv-ok)}
#mmc-root-v1 .mmc-chip.is-warn{border-color:transparent;background:color-mix(in srgb,var(--mv-warn) 15%,var(--mv-paper));color:color-mix(in srgb,var(--mv-warn) 85%,var(--mv-ink))}
#mmc-root-v1 .mmc-chip.is-high{border-color:transparent;background:color-mix(in srgb,var(--mv-warn) 16%,var(--mv-paper));color:color-mix(in srgb,var(--mv-warn) 85%,var(--mv-ink))}
#mmc-root-v1 .mmc-chip.is-done{border-color:transparent;background:color-mix(in srgb,var(--mv-ok) 13%,var(--mv-paper));color:var(--mv-ok)}
#mmc-root-v1 .mmc-chip.is-hold{border-color:transparent;background:color-mix(in srgb,var(--mv-hold) 16%,var(--mv-paper));color:color-mix(in srgb,var(--mv-hold) 80%,var(--mv-ink))}
#mmc-root-v1 .mmc-chip.is-cancelled{border-color:transparent;background:var(--mv-sunk);color:var(--mv-muted);text-decoration:line-through}
#mmc-root-v1 .mmc-seg{display:inline-flex;flex-wrap:wrap;gap:2px;padding:3px;border-radius:11px;background:var(--mv-sunk)}
#mmc-root-v1 .mmc-seg .mmc-filter,#mmc-root-v1 .mmc-seg>label{display:inline-flex;align-items:center;gap:5px;min-height:30px;padding:0 12px;border:0;border-radius:8px;background:transparent;color:var(--mv-muted);font-size:var(--t-sm);font-weight:700;cursor:pointer;white-space:nowrap}
#mmc-root-v1 .mmc-seg .mmc-filter i{font:700 var(--t-2xs)/1 var(--mv-mono);font-style:normal;opacity:.8}
#mmc-root-v1 .mmc-seg .mmc-filter.is-active,#mmc-root-v1 .mmc-seg>label.is-active{background:var(--mv-paper);color:var(--mv-ink);box-shadow:0 1px 3px rgba(0,0,0,.08)}
#mmc-root-v1 .mmc-seg>label input{position:absolute;opacity:0;pointer-events:none;width:1px;height:1px}
#mmc-root-v1 .mmc-empty{padding:26px 14px;color:var(--mv-muted);font-size:var(--t-sm);line-height:1.6;text-align:center}
#mmc-root-v1 .mmc-empty-large{max-width:440px;margin:60px auto;border:1px dashed var(--mv-line-2);border-radius:var(--mv-r);background:var(--mv-paper)}
#mmc-root-v1 .mmc-check{display:grid;place-items:center;flex:none;width:24px;height:24px;padding:0;border:2px solid var(--mv-line-2);border-radius:50%;background:var(--mv-paper);color:#fff;font-size:13px;font-weight:900;line-height:1}
#mmc-root-v1 .mmc-check:hover{border-color:var(--mv-accent)}
#mmc-root-v1 .mmc-check.is-checked{border-color:var(--mv-ok);background:var(--mv-ok)}
#mmc-root-v1 .mmc-check.mmc-pin-check.is-checked{border-color:var(--mv-accent);background:var(--mv-accent);color:var(--mv-accent-ink);font-size:18px}
#mmc-root-v1 .mmc-evidence-link{display:inline-flex;align-items:center;padding:0;border:0;background:none;color:var(--mv-accent);font-size:var(--t-xs);font-weight:700;text-decoration:underline;text-underline-offset:2px;white-space:nowrap}
#mmc-root-v1 .mmc-searchbox{display:flex;align-items:center;gap:7px;min-width:0;min-height:36px;padding:0 11px;border:1px solid var(--mv-line);border-radius:10px;background:var(--mv-paper);color:var(--mv-muted)}
#mmc-root-v1 .mmc-searchbox:focus-within{border-color:var(--mv-accent)}
#mmc-root-v1 .mmc-searchbox .mmc-svg{width:15px;height:15px}
#mmc-root-v1 .mmc-searchbox input{flex:1;min-width:0;border:0;background:transparent;color:var(--mv-ink);font-size:var(--t-sm);outline:none}
#mmc-root-v1 .mmc-m-only{display:none!important}
#mmc-root-v1 .mmc-summary-alert,#mmc-root-v1 .mmc-agent-note,#mmc-root-v1 .mmc-advanced-memory-note{display:flex;align-items:center;gap:12px;margin:0 0 12px;padding:12px 14px;border:1px solid var(--mv-line);border-radius:var(--mv-r);background:var(--mv-paper)}
#mmc-root-v1 .mmc-summary-alert>div:nth-child(2),#mmc-root-v1 .mmc-advanced-memory-note>div,#mmc-root-v1 .mmc-agent-note-copy{flex:1;min-width:0}
#mmc-root-v1 .mmc-summary-alert b,#mmc-root-v1 .mmc-advanced-memory-note b{display:block;font-size:var(--t-md)}
#mmc-root-v1 .mmc-summary-alert small,#mmc-root-v1 .mmc-advanced-memory-note small{display:block;margin-top:2px;color:var(--mv-muted);font-size:var(--t-xs);line-height:1.5}
#mmc-root-v1 .mmc-summary-alert>div:last-child{display:flex;gap:6px;flex:none}
#mmc-root-v1 .mmc-summary-alert{border-color:color-mix(in srgb,var(--mv-accent) 32%,var(--mv-line));border-left:4px solid var(--mv-accent);background:color-mix(in srgb,var(--mv-accent) 5%,var(--mv-paper))}
#mmc-root-v1 .mmc-undo-alert{border-color:color-mix(in srgb,var(--mv-warn) 38%,var(--mv-line));border-left-color:var(--mv-warn);background:color-mix(in srgb,var(--mv-warn) 6%,var(--mv-paper))}
#mmc-root-v1 .mmc-alert-icon{display:grid;place-items:center;width:34px;height:34px;flex:none;border-radius:10px;background:var(--mv-accent-soft);color:var(--mv-accent)}
#mmc-root-v1 .mmc-alert-icon .mmc-svg{width:18px;height:18px}
#mmc-root-v1 .mmc-agent-note{align-items:flex-start;border-color:color-mix(in srgb,var(--mv-warn) 35%,var(--mv-line));background:color-mix(in srgb,var(--mv-warn) 8%,var(--mv-paper))}
#mmc-root-v1 .mmc-agent-note .mmc-alert-icon,#mmc-root-v1 .mmc-undo-alert .mmc-alert-icon{background:color-mix(in srgb,var(--mv-warn) 16%,var(--mv-paper));color:color-mix(in srgb,var(--mv-warn) 85%,var(--mv-ink))}
#mmc-root-v1 .mmc-agent-note-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px}
#mmc-root-v1 .mmc-agent-note-head b{font-size:var(--t-md)}
#mmc-root-v1 .mmc-agent-note-head span{color:var(--mv-muted);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-agent-note p{margin:4px 0 2px;color:var(--mv-ink-2);font-size:var(--t-sm);line-height:1.55}
#mmc-root-v1 .mmc-agent-note small{display:block;color:var(--mv-muted);font-size:var(--t-xs);line-height:1.5}
#mmc-root-v1 .mmc-advanced-memory-note .mmc-alert-icon{background:var(--mv-sunk);color:var(--mv-ink-2)}
#mmc-root-v1 .mmc-setting-warning{display:flex;flex-direction:column;gap:3px;padding:11px 13px;border-radius:10px;background:color-mix(in srgb,var(--mv-warn) 8%,var(--mv-paper));border:1px solid color-mix(in srgb,var(--mv-warn) 26%,var(--mv-line))}
#mmc-root-v1 .mmc-setting-warning b{font-size:var(--t-sm)}
#mmc-root-v1 .mmc-setting-warning small{color:var(--mv-ink-2);font-size:var(--t-xs);line-height:1.6}
#mmc-root-v1 .mmc-ownership-guard{max-width:640px;margin:20px auto;padding:22px 24px;border:1px solid color-mix(in srgb,var(--mv-danger) 30%,var(--mv-line));border-radius:var(--mv-r);background:var(--mv-paper)}
#mmc-root-v1 .mmc-ownership-guard h2{margin:6px 0 8px;font-size:var(--t-2xl);font-weight:800;letter-spacing:-.02em}
#mmc-root-v1 .mmc-ownership-guard p{margin:0 0 12px;color:var(--mv-ink-2)}
#mmc-root-v1 .mmc-ownership-guard dl{display:flex;flex-direction:column;gap:6px;margin:0 0 14px}
#mmc-root-v1 .mmc-ownership-guard dl>div{display:grid;grid-template-columns:120px minmax(0,1fr);gap:10px;padding:8px 0;border-top:1px solid var(--mv-line)}
#mmc-root-v1 .mmc-ownership-guard dt{color:var(--mv-muted);font-size:var(--t-xs);font-weight:700}
#mmc-root-v1 .mmc-ownership-guard dd{margin:0;font-size:var(--t-sm);word-break:break-all}
#mmc-root-v1 .mmc-ownership-guard code{font-family:var(--mv-mono);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-ownership-actions{display:flex;gap:8px;margin-top:14px}
#mmc-root-v1 .mmc-overview{display:flex;flex-direction:column;gap:14px}
#mmc-root-v1 .mmc-overview>[data-mmc-summary-alert-slot]:empty{display:none}
#mmc-root-v1 .mmc-overview>[data-mmc-summary-alert-slot]>:last-child{margin-bottom:0}
#mmc-root-v1 .mmc-ov-grid{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:14px;align-items:start}
#mmc-root-v1 .mmc-inject{padding:18px 20px}
#mmc-root-v1 .mmc-inject-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
#mmc-root-v1 .mmc-inject-head strong{display:flex;align-items:baseline;gap:7px;margin-top:4px;font-size:var(--t-3xl);font-weight:850;letter-spacing:-.03em;line-height:1.1}
#mmc-root-v1 .mmc-inject-head strong small{color:var(--mv-muted);font-size:var(--t-md);font-weight:700;letter-spacing:0}
#mmc-root-v1 .mmc-meter{display:flex;gap:3px;height:14px;margin:16px 0 12px;border-radius:999px;overflow:hidden;background:var(--mv-sunk)}
#mmc-root-v1 .mmc-meter i{display:block;min-width:6px;height:100%}
#mmc-root-v1 .mmc-meter i.is-promise,#mmc-root-v1 .mmc-legend .is-promise i{background:var(--mv-accent)}
#mmc-root-v1 .mmc-meter i.is-anchor,#mmc-root-v1 .mmc-legend .is-anchor i{background:var(--mv-accent-2)}
#mmc-root-v1 .mmc-meter i.is-wiki,#mmc-root-v1 .mmc-legend .is-wiki i{background:var(--mv-ok)}
#mmc-root-v1 .mmc-meter i.is-empty{flex:1;background:transparent}
#mmc-root-v1 .mmc-legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin:0;padding:0;list-style:none;color:var(--mv-ink-2);font-size:var(--t-sm)}
#mmc-root-v1 .mmc-legend li{display:inline-flex;align-items:center;gap:6px}
#mmc-root-v1 .mmc-legend li i{width:10px;height:10px;border-radius:3px}
#mmc-root-v1 .mmc-legend .is-cond i{background:var(--mv-line-2)}
#mmc-root-v1 .mmc-legend b{font-family:var(--mv-mono);font-weight:800}
#mmc-root-v1 .mmc-inject-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:14px;padding-top:12px;border-top:1px dashed var(--mv-line-2)}
#mmc-root-v1 .mmc-inject-foot small{display:flex;align-items:flex-start;gap:6px;color:var(--mv-muted);font-size:var(--t-xs);line-height:1.5}
#mmc-root-v1 .mmc-inject-foot small .mmc-svg{width:14px;height:14px;margin-top:2px}
#mmc-root-v1 .mmc-inbox{padding-bottom:4px}
#mmc-root-v1 .mmc-inbox-row{display:flex;align-items:center;gap:12px;padding:11px 16px;border-top:1px solid var(--mv-line)}
#mmc-root-v1 .mmc-inbox-icon{display:grid;place-items:center;width:36px;height:36px;flex:none;border-radius:10px;background:color-mix(in srgb,var(--mv-accent-2) 12%,var(--mv-paper));color:var(--mv-accent-2)}
#mmc-root-v1 .mmc-inbox-row.is-accent .mmc-inbox-icon{background:var(--mv-accent-soft);color:var(--mv-accent)}
#mmc-root-v1 .mmc-inbox-row.is-warn .mmc-inbox-icon{background:color-mix(in srgb,var(--mv-warn) 14%,var(--mv-paper));color:color-mix(in srgb,var(--mv-warn) 85%,var(--mv-ink))}
#mmc-root-v1 .mmc-inbox-row.is-muted .mmc-inbox-icon{background:var(--mv-sunk);color:var(--mv-muted)}
#mmc-root-v1 .mmc-inbox-copy{flex:1;min-width:0}
#mmc-root-v1 .mmc-inbox-copy b{display:block;font-size:var(--t-md);font-weight:800;line-height:1.35}
#mmc-root-v1 .mmc-inbox-copy small{display:block;margin-top:2px;color:var(--mv-muted);font-size:var(--t-xs);line-height:1.45}
#mmc-root-v1 .mmc-inbox-actions{display:flex;gap:6px;flex:none}
#mmc-root-v1 .mmc-inbox-empty{display:flex;flex-direction:column;align-items:center;gap:4px;padding:24px 16px 26px;border-top:1px solid var(--mv-line);color:var(--mv-muted);text-align:center}
#mmc-root-v1 .mmc-inbox-empty .mmc-svg{width:26px;height:26px;margin-bottom:4px}
#mmc-root-v1 .mmc-inbox-empty b{color:var(--mv-ink-2);font-size:var(--t-md)}
#mmc-root-v1 .mmc-inbox-empty small{font-size:var(--t-xs)}
#mmc-root-v1 .mmc-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
#mmc-root-v1 .mmc-stat{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:14px 16px;border:1px solid var(--mv-line);border-radius:var(--mv-r);background:var(--mv-paper);color:var(--mv-ink);text-align:left}
#mmc-root-v1 .mmc-stat:hover{border-color:var(--mv-accent)}
#mmc-root-v1 .mmc-stat-top{display:flex;align-items:center;gap:8px;color:var(--mv-ink-2);font-size:var(--t-sm);font-weight:700}
#mmc-root-v1 .mmc-stat-top i{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:var(--mv-accent-soft);color:var(--mv-accent)}
#mmc-root-v1 .mmc-stat-top .mmc-svg{width:15px;height:15px}
#mmc-root-v1 .mmc-stat b{margin-top:6px;font-size:var(--t-3xl);font-weight:850;line-height:1.1;letter-spacing:-.02em}
#mmc-root-v1 .mmc-stat small{color:var(--mv-muted);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-timeline ol{margin:0;padding:0 6px 6px;list-style:none}
#mmc-root-v1 .mmc-timeline li button{display:flex;align-items:center;gap:12px;width:100%;padding:9px 10px;border:0;border-radius:10px;background:transparent;color:var(--mv-ink);text-align:left}
#mmc-root-v1 .mmc-timeline li button:hover{background:var(--mv-sunk)}
#mmc-root-v1 .mmc-timeline li i{display:grid;place-items:center;width:30px;height:30px;flex:none;border-radius:50%;background:var(--mv-accent-soft);color:var(--mv-accent)}
#mmc-root-v1 .mmc-timeline li i.is-anchor{background:color-mix(in srgb,var(--mv-accent-2) 13%,var(--mv-paper));color:var(--mv-accent-2)}
#mmc-root-v1 .mmc-timeline li i.is-element{background:var(--mv-sunk);color:var(--mv-ink-2)}
#mmc-root-v1 .mmc-timeline li i.is-wiki{background:color-mix(in srgb,var(--mv-ok) 13%,var(--mv-paper));color:var(--mv-ok)}
#mmc-root-v1 .mmc-timeline li i .mmc-svg{width:15px;height:15px}
#mmc-root-v1 .mmc-timeline li span{flex:1;min-width:0}
#mmc-root-v1 .mmc-timeline li b{display:block;overflow:hidden;font-size:var(--t-md);font-weight:700;text-overflow:ellipsis;white-space:nowrap}
#mmc-root-v1 .mmc-timeline li small{color:var(--mv-muted);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-timeline li time{flex:none;color:var(--mv-muted);font:600 var(--t-xs)/1 var(--mv-mono)}
#mmc-root-v1 .mmc-split{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:14px;align-items:start}
#mmc-root-v1 .mmc-listpane{display:flex;flex-direction:column;overflow:hidden}
#mmc-root-v1 .mmc-listpane>.mmc-seg{margin:12px 12px 8px;align-self:flex-start}
#mmc-root-v1 .mmc-tickets{display:flex;flex-direction:column}
#mmc-root-v1 .mmc-ticket{position:relative;display:flex;align-items:flex-start;gap:12px;padding:14px 16px 14px 18px;border-top:1px solid var(--mv-line)}
#mmc-root-v1 .mmc-ticket::before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:4px;border-radius:0 4px 4px 0;background:var(--mv-line-2)}
#mmc-root-v1 .mmc-ticket.prio-high::before{background:var(--mv-warn)}
#mmc-root-v1 .mmc-ticket.prio-normal::before{background:var(--mv-accent)}
#mmc-root-v1 .mmc-ticket.prio-low::before{background:var(--mv-line-2)}
#mmc-root-v1 .mmc-ticket.is-selected{background:color-mix(in srgb,var(--mv-accent) 7%,var(--mv-paper))}
#mmc-root-v1 .mmc-ticket .mmc-check{margin-top:1px}
#mmc-root-v1 .mmc-ticket-main{flex:1;min-width:0;padding:0;border:0;background:transparent;color:var(--mv-ink);text-align:left}
#mmc-root-v1 .mmc-ticket-main b{display:block;font-size:var(--t-md);font-weight:800;line-height:1.4}
#mmc-root-v1 .mmc-ticket-main small{display:block;margin-top:2px;color:var(--mv-ink-2);font-size:var(--t-sm);line-height:1.5}
#mmc-root-v1 .mmc-ticket-main .mmc-chips{margin-top:8px}
#mmc-root-v1 .mmc-ticket.is-done .mmc-ticket-main b{color:var(--mv-muted);text-decoration:line-through}
#mmc-root-v1 .mmc-ticket.is-hold .mmc-ticket-main b,#mmc-root-v1 .mmc-ticket.is-cancelled .mmc-ticket-main b{color:var(--mv-ink-2)}
#mmc-root-v1 .mmc-ticket-no{flex:none;color:var(--mv-muted);font:600 var(--t-xs)/1.6 var(--mv-mono)}
#mmc-root-v1 .mmc-listpane-foot{padding:12px 14px;border-top:1px solid var(--mv-line);background:var(--mv-paper-2)}
#mmc-root-v1 .mmc-detail{position:sticky;top:0;padding:18px 20px}
#mmc-root-v1 .mmc-detail-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:50px 20px;color:var(--mv-muted);text-align:center}
#mmc-root-v1 .mmc-detail-empty .mmc-svg{width:30px;height:30px}
#mmc-root-v1 .mmc-detail-empty b{color:var(--mv-ink-2)}
#mmc-root-v1 .mmc-detail-head{display:flex;flex-direction:column;align-items:flex-start;gap:8px}
#mmc-root-v1 .mmc-detail-head h3{margin:0;font-size:var(--t-2xl);font-weight:850;line-height:1.3;letter-spacing:-.02em}
#mmc-root-v1 .mmc-stepper{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;margin:16px 0}
#mmc-root-v1 .mmc-stepper button{min-height:36px;padding:0 6px;border:1px solid var(--mv-line);border-radius:9px;background:var(--mv-paper-2);color:var(--mv-muted);font-size:var(--t-sm);font-weight:800}
#mmc-root-v1 .mmc-stepper button:hover{border-color:var(--mv-accent);color:var(--mv-ink)}
#mmc-root-v1 .mmc-stepper button.is-on{border-color:var(--mv-accent);background:var(--mv-accent);color:var(--mv-accent-ink)}
#mmc-root-v1 .mmc-stepper button.is-on.is-done{border-color:var(--mv-ok);background:var(--mv-ok);color:#fff}
#mmc-root-v1 .mmc-stepper button.is-on.is-hold{border-color:var(--mv-hold);background:var(--mv-hold);color:#fff}
#mmc-root-v1 .mmc-stepper button.is-on.is-cancelled{border-color:var(--mv-muted);background:var(--mv-muted);color:var(--mv-paper)}
#mmc-root-v1 .mmc-detail-sec{margin-top:14px}
#mmc-root-v1 .mmc-detail-body{margin:0;font-size:var(--t-md);line-height:1.7;white-space:pre-wrap}
#mmc-root-v1 .mmc-kv{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:14px}
#mmc-root-v1 .mmc-kv>div{padding:10px 12px;border-radius:10px;background:var(--mv-paper-2);border:1px solid var(--mv-line)}
#mmc-root-v1 .mmc-kv span{display:block;color:var(--mv-muted);font-size:var(--t-2xs);font-weight:700}
#mmc-root-v1 .mmc-kv b{display:block;margin-top:2px;font-size:var(--t-sm);font-weight:800;word-break:keep-all}
#mmc-root-v1 .mmc-quote{margin:0 0 6px;padding:10px 14px;border-left:3px solid var(--mv-accent-2);border-radius:0 10px 10px 0;background:var(--mv-paper-2);color:var(--mv-ink-2);font-size:var(--t-sm);line-height:1.6;white-space:pre-wrap}
#mmc-root-v1 .mmc-inject-pre{margin:0;padding:12px 14px;border-radius:10px;background:var(--mv-sunk);color:var(--mv-ink-2);font:500 var(--t-xs)/1.65 var(--mv-mono);white-space:pre-wrap;word-break:break-word}
#mmc-root-v1 .mmc-inject-pre.is-off{color:var(--mv-muted);font-family:var(--mv-font)}
#mmc-root-v1 .mmc-detail-foot{display:flex;gap:6px;margin-top:18px;padding-top:14px;border-top:1px solid var(--mv-line)}
#mmc-root-v1 .mmc-budget{margin-bottom:12px;padding:14px 16px}
#mmc-root-v1 .mmc-budget-head{display:flex;align-items:center;gap:12px}
#mmc-root-v1 .mmc-budget-head>div{flex:1;min-width:0}
#mmc-root-v1 .mmc-budget-head b{display:block;font-size:var(--t-md);font-weight:800}
#mmc-root-v1 .mmc-budget-head small{display:block;color:var(--mv-muted);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-budget-head strong{font:800 var(--t-xl)/1 var(--mv-mono);color:var(--mv-accent)}
#mmc-root-v1 .mmc-budget.is-over .mmc-budget-head strong{color:var(--mv-warn)}
#mmc-root-v1 .mmc-budget-track{height:10px;margin-top:10px;border-radius:999px;background:var(--mv-sunk);overflow:hidden}
#mmc-root-v1 .mmc-budget-track i{display:block;height:100%;border-radius:999px;background:var(--mv-accent)}
#mmc-root-v1 .mmc-budget.is-over .mmc-budget-track i{background:var(--mv-warn)}
#mmc-root-v1 .mmc-budget-warning{display:block;margin-top:8px;color:color-mix(in srgb,var(--mv-warn) 85%,var(--mv-ink));font-size:var(--t-xs);line-height:1.5}
#mmc-root-v1 .mmc-toolbar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:12px}
#mmc-root-v1 .mmc-lanes{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;align-items:start}
#mmc-root-v1 .mmc-lane{border:1px solid var(--mv-line);border-radius:var(--mv-r);background:var(--mv-paper-2);overflow:hidden}
#mmc-root-v1 .mmc-lane>header{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--mv-line);background:var(--mv-paper)}
#mmc-root-v1 .mmc-lane>header>i{display:grid;place-items:center;width:30px;height:30px;border-radius:9px;background:var(--mv-accent-soft);color:var(--mv-accent)}
#mmc-root-v1 .mmc-lane.is-keyword>header>i{background:color-mix(in srgb,var(--mv-accent-2) 13%,var(--mv-paper));color:var(--mv-accent-2)}
#mmc-root-v1 .mmc-lane>header>i .mmc-svg{width:16px;height:16px}
#mmc-root-v1 .mmc-lane>header>span{flex:1;min-width:0}
#mmc-root-v1 .mmc-lane>header b{display:block;font-size:var(--t-md);font-weight:800}
#mmc-root-v1 .mmc-lane>header small{display:block;color:var(--mv-muted);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-lane-list{display:flex;flex-direction:column;gap:8px;padding:10px}
#mmc-root-v1 .mmc-anchor{display:flex;align-items:flex-start;gap:11px;padding:12px 13px;border:1px solid var(--mv-line);border-radius:11px;background:var(--mv-paper)}
#mmc-root-v1 .mmc-anchor.prio-high{border-left:3px solid var(--mv-warn)}
#mmc-root-v1 .mmc-anchor.is-muted{opacity:.62}
#mmc-root-v1 .mmc-anchor.is-budget-wait{border-style:dashed;border-color:color-mix(in srgb,var(--mv-warn) 55%,var(--mv-line))}
#mmc-root-v1 .mmc-anchor .mmc-check{margin-top:1px}
#mmc-root-v1 .mmc-anchor-main{flex:1;min-width:0;padding:0;border:0;background:transparent;color:var(--mv-ink);text-align:left}
#mmc-root-v1 .mmc-anchor-main b{display:block;font-size:var(--t-md);font-weight:800;line-height:1.4}
#mmc-root-v1 .mmc-anchor-main small{display:block;margin-top:3px;color:var(--mv-ink-2);font-size:var(--t-sm);line-height:1.55}
#mmc-root-v1 .mmc-anchor-main .mmc-chips{margin-top:8px}
#mmc-root-v1 .mmc-kw{display:flex;flex-wrap:wrap;gap:4px;margin-top:7px}
#mmc-root-v1 .mmc-kw i{padding:1px 7px;border-radius:6px;background:color-mix(in srgb,var(--mv-accent-2) 12%,var(--mv-paper));color:color-mix(in srgb,var(--mv-accent-2) 85%,var(--mv-ink));font:600 var(--t-2xs)/1.6 var(--mv-mono);font-style:normal}
#mmc-root-v1 .mmc-kw i::before{content:"#"}
#mmc-root-v1 .mmc-anchor-side{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex:none}
#mmc-root-v1 .mmc-element-page{display:flex;flex-direction:column;gap:14px}
#mmc-root-v1 .mmc-element-toolbox{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:10px 16px;padding:14px 16px}
#mmc-root-v1 .mmc-dock-copy{display:flex;align-items:center;gap:12px;min-width:0}
#mmc-root-v1 .mmc-dock-icon{display:grid;place-items:center;width:38px;height:38px;flex:none;border-radius:11px;background:color-mix(in srgb,var(--mv-accent-2) 13%,var(--mv-paper));color:var(--mv-accent-2)}
#mmc-root-v1 .mmc-dock-copy b{display:block;font-size:var(--t-md);font-weight:800}
#mmc-root-v1 .mmc-dock-copy small{display:block;color:var(--mv-muted);font-size:var(--t-xs);line-height:1.5}
#mmc-root-v1 .mmc-dock-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
#mmc-root-v1 .mmc-element-range{display:flex;align-items:center;gap:6px;color:var(--mv-ink-2);font-size:var(--t-sm);font-weight:700}
#mmc-root-v1 .mmc-element-range label{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
#mmc-root-v1 .mmc-element-range input{width:66px;min-height:34px;padding:0 8px;border:1px solid var(--mv-line-2);border-radius:9px;background:var(--mv-paper);color:var(--mv-ink);font:700 var(--t-sm) var(--mv-mono);text-align:center}
#mmc-root-v1 .mmc-element-status{grid-column:1/-1;display:block;padding-top:10px;line-height:1.6;border-top:1px dashed var(--mv-line-2);color:var(--mv-muted);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-el-wrap{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:14px;align-items:start}
#mmc-root-v1 .mmc-element-list-head{display:flex;gap:8px;margin-bottom:12px}
#mmc-root-v1 .mmc-element-list-head .mmc-searchbox{flex:1}
#mmc-root-v1 .mmc-element-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
#mmc-root-v1 .mmc-element-list>.mmc-empty{grid-column:1/-1;border:1px dashed var(--mv-line-2);border-radius:var(--mv-r);background:var(--mv-paper)}
#mmc-root-v1 .mmc-element-row{position:relative;display:flex;flex-direction:column;border:1px solid var(--mv-line);border-radius:var(--mv-r);background:var(--mv-paper);overflow:hidden}
#mmc-root-v1 .mmc-element-row::before{content:"";position:absolute;top:12px;right:14px;width:9px;height:9px;border-radius:50%;background:var(--mv-bg);box-shadow:inset 0 1px 2px rgba(0,0,0,.18)}
#mmc-root-v1 .mmc-element-row:hover{border-color:var(--mv-accent)}
#mmc-root-v1 .mmc-element-main{flex:1;display:flex;flex-direction:column;gap:8px;padding:14px 16px 12px;border:0;background:transparent;color:var(--mv-ink);text-align:left}
#mmc-root-v1 .mmc-cat-head{display:flex;flex-direction:column;padding-right:18px;padding-bottom:8px;border-bottom:1px solid var(--mv-line)}
#mmc-root-v1 .mmc-cat-head b{font-size:var(--t-lg);font-weight:850;line-height:1.3}
#mmc-root-v1 .mmc-cat-head small{color:var(--mv-muted);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-facts{display:flex;flex-direction:column;gap:3px;margin:0;padding:0;list-style:none}
#mmc-root-v1 .mmc-facts li{position:relative;padding-left:12px;color:var(--mv-ink-2);font-size:var(--t-sm);line-height:1.5}
#mmc-root-v1 .mmc-facts li::before{content:"";position:absolute;left:1px;top:.62em;width:5px;height:5px;border-radius:50%;background:var(--mv-accent)}
#mmc-root-v1 .mmc-facts li.is-more{color:var(--mv-muted);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-facts li.is-more::before{display:none}
#mmc-root-v1 .mmc-element-summary{color:var(--mv-muted);font-size:var(--t-sm)}
#mmc-root-v1 .mmc-element-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px 8px;padding:9px 16px;border-top:1px solid var(--mv-line);background:var(--mv-paper-2);color:var(--mv-muted);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-element-meta>span:first-child{margin-right:auto;font-family:var(--mv-mono)}
#mmc-root-v1 .mmc-el-aside{position:sticky;top:0;display:flex;flex-direction:column;gap:12px}
#mmc-root-v1 .mmc-element-search-test{display:flex;flex-direction:column;gap:8px;padding:0 14px 14px}
#mmc-root-v1 .mmc-element-search-test .mmc-card-head{padding:14px 0 0}
#mmc-root-v1 .mmc-element-search-test>small{font-size:var(--t-xs);line-height:1.5}
#mmc-root-v1 .mmc-element-search-test textarea{width:100%;min-height:72px;padding:10px 12px;border:1px solid var(--mv-line-2);border-radius:10px;background:var(--mv-paper-2);color:var(--mv-ink);font-size:var(--t-sm);line-height:1.5;resize:vertical;outline:none}
#mmc-root-v1 .mmc-element-search-test textarea:focus{border-color:var(--mv-accent)}
#mmc-root-v1 .mmc-element-test-results{display:flex;flex-direction:column;gap:6px}
#mmc-root-v1 .mmc-element-test-results em{color:var(--mv-muted);font-size:var(--t-xs);font-style:normal}
#mmc-root-v1 .mmc-hit{display:flex;flex-direction:column;padding:8px 10px;border-radius:9px;background:color-mix(in srgb,var(--mv-ok) 10%,var(--mv-paper));border:1px solid color-mix(in srgb,var(--mv-ok) 25%,var(--mv-line))}
#mmc-root-v1 .mmc-hit b{font-size:var(--t-sm)}
#mmc-root-v1 .mmc-hit small{color:var(--mv-ok);font:600 var(--t-2xs)/1.5 var(--mv-mono)}
#mmc-root-v1 .mmc-rule-note{padding:10px 12px;border-radius:10px;background:var(--mv-sunk)}
#mmc-root-v1 .mmc-rule-note b{display:block;font-size:var(--t-xs)}
#mmc-root-v1 .mmc-rule-note small{display:block;color:var(--mv-ink-2);font-size:var(--t-xs);line-height:1.6}
#mmc-root-v1 .mmc-wiki-document{height:100%}
#mmc-root-v1 .mmc-wiki-split{display:grid;grid-template-columns:268px minmax(0,1fr);height:100%}
#mmc-root-v1 .mmc-wiki-side{display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--mv-wiki-rule);background:var(--mv-paper-2)}
#mmc-root-v1 .mmc-wiki-side-tools{display:flex;flex-direction:column;gap:6px;padding:14px 14px 10px}
#mmc-root-v1 .mmc-wiki-side-tools select{min-height:34px;padding:0 8px;border:1px solid var(--mv-line);border-radius:9px;background:var(--mv-paper);color:var(--mv-ink);font-size:var(--t-sm)}
#mmc-root-v1 .mmc-wiki-list{flex:1;min-height:0;overflow:auto;padding:0 10px 10px}
#mmc-root-v1 .mmc-wiki-group{margin-top:8px}
#mmc-root-v1 .mmc-wiki-group>h4{display:flex;justify-content:space-between;margin:0;padding:6px 6px 4px;color:var(--mv-muted);font-size:var(--t-xs);font-weight:800}
#mmc-root-v1 .mmc-wiki-group>h4 i{font:700 var(--t-2xs)/1.6 var(--mv-mono);font-style:normal}
#mmc-root-v1 .mmc-wiki-row{display:flex;flex-direction:column;width:100%;padding:6px 8px 7px;border:0;border-left:3px solid transparent;border-radius:0 8px 8px 0;background:transparent;text-align:left}
#mmc-root-v1 .mmc-wiki-row:hover{background:var(--mv-sunk)}
#mmc-root-v1 .mmc-wiki-row.is-active{border-left-color:var(--mv-accent);background:var(--mv-paper)}
#mmc-root-v1 .mmc-wiki-row-top{display:flex;align-items:center;gap:5px;min-width:0}
#mmc-root-v1 .mmc-wiki-row-top b{overflow:hidden;color:var(--mv-wiki-link);font-size:var(--t-sm);font-weight:700;text-overflow:ellipsis;white-space:nowrap}
#mmc-root-v1 .mmc-wiki-row.is-active .mmc-wiki-row-top b{color:var(--mv-ink);font-weight:800}
#mmc-root-v1 .mmc-wiki-row-sum{overflow:hidden;color:var(--mv-muted);font-size:var(--t-2xs);text-overflow:ellipsis;white-space:nowrap}
#mmc-root-v1 .mmc-wiki-badge{flex:none;padding:0 6px;border-radius:999px;background:var(--mv-accent-soft);color:var(--mv-accent);font:800 9.5px/16px var(--mv-font);font-style:normal}
#mmc-root-v1 .mmc-wiki-badge.is-lock{background:var(--mv-sunk);color:var(--mv-ink-2)}
#mmc-root-v1 .mmc-wiki-badge.is-off{background:var(--mv-sunk);color:var(--mv-muted)}
#mmc-root-v1 .mmc-wiki-badge.is-pending{background:color-mix(in srgb,var(--mv-accent-2) 15%,var(--mv-paper));color:var(--mv-accent-2)}
#mmc-root-v1 .mmc-wiki-side-foot{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:12px 14px 14px;border-top:1px solid var(--mv-wiki-rule)}
#mmc-root-v1 .mmc-wiki-side-foot .mmc-btn{padding:0 8px}
#mmc-root-v1 .mmc-wiki-status{grid-column:1/-1;display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px;margin-top:4px;color:var(--mv-muted);font-size:var(--t-2xs)}
#mmc-root-v1 .mmc-wiki-main{min-width:0;min-height:0;overflow:auto;background:var(--mv-paper);scroll-behavior:smooth}
#mmc-root-v1 .mmc-wiki-actionbar{position:sticky;top:0;z-index:3;display:flex;align-items:center;gap:8px;padding:10px 26px;border-bottom:1px solid var(--mv-line);background:color-mix(in srgb,var(--mv-paper) 94%,transparent);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
#mmc-root-v1 .mmc-wiki-back{margin-left:-8px}
#mmc-root-v1 .mmc-wiki-back:not(.has-history){display:none}
#mmc-root-v1 .mmc-wiki-crumb{display:flex;align-items:center;flex-wrap:wrap;gap:5px;flex:1;min-width:0;color:var(--mv-wiki-link);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-wiki-crumb i{color:var(--mv-muted);font-style:normal}
#mmc-root-v1 .mmc-wiki-actions{display:inline-flex;align-items:stretch;flex:none;border:1px solid var(--mv-wiki-rule);border-radius:9px;background:var(--mv-paper)}
#mmc-root-v1 .mmc-wiki-actions>button,#mmc-root-v1 .mmc-wiki-more>summary{display:inline-flex;align-items:center;gap:5px;min-height:30px;padding:0 11px;border:0;border-left:1px solid var(--mv-wiki-rule);background:transparent;color:var(--mv-ink-2);font-size:var(--t-xs);font-weight:700;white-space:nowrap;cursor:pointer}
#mmc-root-v1 .mmc-wiki-actions>button:first-child{border-left:0;border-radius:8px 0 0 8px}
#mmc-root-v1 .mmc-wiki-actions>button:hover,#mmc-root-v1 .mmc-wiki-more>summary:hover{background:var(--mv-sunk);color:var(--mv-ink)}
#mmc-root-v1 .mmc-wiki-actions>button:disabled{opacity:.45}
#mmc-root-v1 .mmc-wiki-actions .mmc-svg{width:14px;height:14px}
#mmc-root-v1 .mmc-wiki-actions em{min-width:18px;padding:0 5px;border-radius:999px;background:var(--mv-accent-2);color:#fff;font:800 var(--t-2xs)/17px var(--mv-mono);font-style:normal;text-align:center}
#mmc-root-v1 .mmc-wiki-more{position:relative}
#mmc-root-v1 .mmc-wiki-more>summary{list-style:none;border-radius:0 8px 8px 0}
#mmc-root-v1 .mmc-wiki-more>summary::-webkit-details-marker{display:none}
#mmc-root-v1 .mmc-wiki-more>div{position:absolute;right:0;top:calc(100% + 6px);z-index:5;display:flex;flex-direction:column;min-width:170px;padding:5px;border:1px solid var(--mv-line-2);border-radius:11px;background:var(--mv-paper);box-shadow:0 12px 30px rgba(0,0,0,.14)}
#mmc-root-v1 .mmc-wiki-more>div button{padding:8px 10px;border:0;border-radius:7px;background:transparent;color:var(--mv-ink);font-size:var(--t-sm);text-align:left}
#mmc-root-v1 .mmc-wiki-more>div button:hover{background:var(--mv-sunk)}
#mmc-root-v1 .mmc-wiki-more>div button.is-danger{color:var(--mv-danger)}
#mmc-root-v1 .mmc-wiki-article{max-width:960px;padding:20px 30px 40px;color:var(--mv-ink);font-size:var(--t-md);line-height:1.75}
#mmc-root-v1 .mmc-wiki-article::after{content:"";display:block;clear:both}
#mmc-root-v1 .mmc-wiki-titlebar{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px 12px;padding-bottom:8px;border-bottom:1px solid var(--mv-wiki-rule)}
#mmc-root-v1 .mmc-wiki-title{margin:0;font-size:calc(34px*var(--fs));font-weight:850;line-height:1.2;letter-spacing:-.03em}
#mmc-root-v1 .mmc-wiki-title small{margin-left:8px;color:var(--mv-muted);font-size:var(--t-md);font-weight:600;letter-spacing:0}
#mmc-root-v1 .mmc-wiki-home .mmc-wiki-title{padding-bottom:8px;border-bottom:1px solid var(--mv-wiki-rule)}
#mmc-root-v1 .mmc-wiki-titlebar small{color:var(--mv-muted);font-size:var(--t-sm)}
#mmc-root-v1 .mmc-wiki-byline{display:block;margin:8px 0 16px;color:var(--mv-muted);font-size:var(--t-xs);line-height:1.6}
#mmc-root-v1 .mmc-wiki-byline b{color:var(--mv-ink-2)}
#mmc-root-v1 .mmc-wiki-byline .mmc-svg{display:inline-block!important;width:12px;height:12px;margin:0 2px -1px 0;vertical-align:-1px}
#mmc-root-v1 .mmc-wiki-banner{display:flex;align-items:center;gap:12px;margin:0 0 18px;padding:11px 14px;border:1px solid color-mix(in srgb,var(--mv-accent-2) 38%,var(--mv-wiki-rule));border-left:4px solid var(--mv-accent-2);border-radius:9px;background:color-mix(in srgb,var(--mv-accent-2) 7%,var(--mv-paper));line-height:1.45}
#mmc-root-v1 .mmc-wiki-banner .mmc-alert-icon{background:transparent;width:22px;height:22px;color:var(--mv-accent-2)}
#mmc-root-v1 .mmc-wiki-banner>div:nth-child(2){flex:1;min-width:0}
#mmc-root-v1 .mmc-wiki-banner b{display:block;font-size:var(--t-sm)}
#mmc-root-v1 .mmc-wiki-banner small{display:block;color:var(--mv-muted);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-wiki-banner>div:last-child{display:flex;gap:6px;flex:none}
#mmc-root-v1 .mmc-wiki-infobox{float:right;width:300px;margin:0 0 18px 24px;border:1px solid var(--mv-wiki-rule);background:var(--mv-wiki-box);font-size:var(--t-sm);line-height:1.5}
#mmc-root-v1 .mmc-wiki-infobox-title{display:block;padding:8px 10px;background:var(--mv-wiki-head);color:var(--mv-wiki-head-ink);font-size:var(--t-lg);font-weight:850;text-align:center}
#mmc-root-v1 .mmc-wiki-lead-image{margin:0;border-bottom:1px solid var(--mv-wiki-rule);background:var(--mv-paper)}
#mmc-root-v1 .mmc-wiki-lead-image img{display:block;width:100%;max-height:340px;object-fit:cover}
#mmc-root-v1 .mmc-wiki-lead-image figcaption{padding:5px 8px;color:var(--mv-muted);font-size:var(--t-2xs);text-align:center}
#mmc-root-v1 .mmc-wiki-infobox table{width:100%;border-collapse:collapse}
#mmc-root-v1 .mmc-wiki-infobox th,#mmc-root-v1 .mmc-wiki-infobox td{padding:7px 10px;border-top:1px solid var(--mv-wiki-rule);vertical-align:top;text-align:left}
#mmc-root-v1 .mmc-wiki-infobox th{width:34%;background:color-mix(in srgb,var(--mv-wiki-head) 9%,var(--mv-wiki-box));color:var(--mv-ink);font-weight:800;white-space:nowrap}
#mmc-root-v1 .mmc-wiki-infobox td{background:var(--mv-paper);word-break:keep-all;overflow-wrap:anywhere}
#mmc-root-v1 .mmc-wiki-state td{padding:5px 8px}
#mmc-root-v1 .mmc-wiki-toggle{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;padding:3px 4px 3px 8px;border:1px solid var(--mv-line);border-radius:999px;background:var(--mv-paper-2);color:var(--mv-muted);font-size:var(--t-xs);font-weight:700}
#mmc-root-v1 .mmc-wiki-toggle i{position:relative;width:30px;height:18px;flex:none;border-radius:999px;background:var(--mv-line-2);transition:background .15s}
#mmc-root-v1 .mmc-wiki-toggle i::after{content:"";position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:left .15s}
#mmc-root-v1 .mmc-wiki-toggle.is-on{border-color:color-mix(in srgb,var(--mv-accent) 40%,var(--mv-line));color:var(--mv-accent)}
#mmc-root-v1 .mmc-wiki-toggle.is-on i{background:var(--mv-accent)}
#mmc-root-v1 .mmc-wiki-toggle.is-on i::after{left:14px}
#mmc-root-v1 .mmc-wiki-lead{margin-bottom:6px}
#mmc-root-v1 .mmc-wiki-summary-lock{display:flex;align-items:center;gap:5px;color:var(--mv-muted);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-wiki-summary-lock .mmc-svg{width:13px;height:13px}
#mmc-root-v1 .mmc-wiki-toc{display:inline-block;min-width:220px;max-width:100%;margin:10px 0 8px;padding:12px 18px 12px 14px;border:1px solid var(--mv-wiki-rule);background:var(--mv-wiki-box)}
#mmc-root-v1 .mmc-wiki-toc>b{display:block;margin-bottom:4px;font-size:var(--t-md);font-weight:850}
#mmc-root-v1 .mmc-wiki-toc ol{margin:0;padding:0;list-style:none}
#mmc-root-v1 .mmc-wiki-toc li[data-wiki-level="2"]{padding-left:18px}
#mmc-root-v1 .mmc-wiki-toc li[data-wiki-level="3"]{padding-left:36px}
#mmc-root-v1 .mmc-wiki-toc button{display:flex;gap:6px;padding:2px 0;border:0;background:transparent;color:var(--mv-wiki-link);font-size:var(--t-sm);text-align:left}
#mmc-root-v1 .mmc-wiki-toc button:hover{text-decoration:underline}
#mmc-root-v1 .mmc-wiki-toc button i{color:var(--mv-wiki-link);font-style:normal;font-weight:700}
#mmc-root-v1 .mmc-wiki-section{margin-top:18px}
#mmc-root-v1 .mmc-wh{display:flex;align-items:center;gap:8px;margin:0 0 10px;padding-bottom:6px;border-bottom:1px solid var(--mv-wiki-rule);color:var(--mv-ink);font-weight:850;line-height:1.35;letter-spacing:-.01em}
#mmc-root-v1 .mmc-wiki-section[data-wiki-level="1"]>.mmc-wh{font-size:var(--t-2xl)}
#mmc-root-v1 .mmc-wiki-section[data-wiki-level="2"]>.mmc-wh{font-size:var(--t-xl);border-bottom-style:dashed}
#mmc-root-v1 .mmc-wiki-section[data-wiki-level="3"]>.mmc-wh{font-size:var(--t-lg);border-bottom:0}
#mmc-root-v1 .mmc-wh-text{flex:1;min-width:0}
#mmc-root-v1 .mmc-wiki-h-num{margin-right:7px;color:var(--mv-accent);font-style:normal}
#mmc-root-v1 .mmc-wiki-manage{display:inline-flex;align-items:center;gap:3px;padding:1px 8px;border-radius:999px;background:var(--mv-accent-soft);color:var(--mv-accent);font-size:var(--t-2xs);font-style:normal;font-weight:800;white-space:nowrap}
#mmc-root-v1 .mmc-wiki-manage .mmc-svg{width:11px;height:11px}
#mmc-root-v1 .mmc-wh-edit{flex:none;padding:0;border:0;background:transparent;color:var(--mv-wiki-link);font-size:var(--t-xs);font-weight:600}
#mmc-root-v1 .mmc-wh-edit:hover{text-decoration:underline}
#mmc-root-v1 .mmc-wiki-body p{margin:0 0 10px}
#mmc-root-v1 .mmc-wiki-body ul,#mmc-root-v1 .mmc-wiki-body ol{margin:0 0 10px;padding-left:24px}
#mmc-root-v1 .mmc-wiki-body ul{list-style:disc}
#mmc-root-v1 .mmc-wiki-body ol{list-style:decimal}
#mmc-root-v1 .mmc-wiki-body li{margin:2px 0}
#mmc-root-v1 .mmc-wiki-body blockquote{margin:0 0 10px;padding:8px 14px;border-left:4px solid var(--mv-wiki-rule);background:var(--mv-wiki-box);color:var(--mv-ink-2)}
#mmc-root-v1 .mmc-wiki-body pre{margin:0 0 10px;padding:10px 12px;border:1px solid var(--mv-wiki-rule);background:var(--mv-wiki-box);font:500 var(--t-xs)/1.6 var(--mv-mono);white-space:pre-wrap}
#mmc-root-v1 .mmc-wiki-body code{padding:1px 5px;border-radius:5px;background:var(--mv-sunk);font:500 .9em var(--mv-mono)}
#mmc-root-v1 .mmc-wiki-body hr{border:0;border-top:1px solid var(--mv-wiki-rule);margin:14px 0}
#mmc-root-v1 .mmc-wiki-body h4,#mmc-root-v1 .mmc-wiki-body h5,#mmc-root-v1 .mmc-wiki-body h6{margin:12px 0 6px;font-size:var(--t-md);font-weight:800}
#mmc-root-v1 .mmc-wiki-body strong{font-weight:800}
#mmc-root-v1 .mmc-wiki-link{display:inline;padding:0;border:0;background:transparent;color:var(--mv-wiki-link);font:inherit;text-align:left;text-decoration:none;cursor:pointer}
#mmc-root-v1 .mmc-wiki-link:hover{text-decoration:underline}
#mmc-root-v1 .mmc-wiki-link.is-missing{color:var(--mv-wiki-missing)}
#mmc-root-v1 .mmc-wiki-cite{display:inline;margin:0 1px;padding:0;border:0;background:transparent;color:var(--mv-wiki-link);font-size:.72em;font-weight:800;vertical-align:super;line-height:0;cursor:pointer}
#mmc-root-v1 .mmc-wiki-cite::before{content:"["}
#mmc-root-v1 .mmc-wiki-cite::after{content:"]"}
#mmc-root-v1 .mmc-wiki-cite.is-missing{color:var(--mv-muted)}
#mmc-root-v1 .mmc-wiki-original{margin:4px 0 10px;padding:6px 10px;border:1px dashed var(--mv-wiki-rule);border-radius:8px;font-size:var(--t-sm)}
#mmc-root-v1 .mmc-wiki-original summary{color:var(--mv-muted);font-size:var(--t-xs);cursor:pointer}
#mmc-root-v1 .mmc-wiki-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}
#mmc-root-v1 .mmc-wiki-figure{margin:0;border:1px solid var(--mv-wiki-rule);background:var(--mv-wiki-box)}
#mmc-root-v1 .mmc-wiki-figure img{display:block;width:100%;aspect-ratio:4/3;object-fit:cover}
#mmc-root-v1 .mmc-wiki-figure figcaption{padding:4px 8px;color:var(--mv-muted);font-size:var(--t-2xs)}
#mmc-root-v1 .mmc-wiki-seealso{display:grid;grid-template-columns:1fr 1fr;gap:12px}
#mmc-root-v1 .mmc-wiki-seealso>div{padding:10px 12px;border:1px solid var(--mv-wiki-rule);background:var(--mv-wiki-box)}
#mmc-root-v1 .mmc-wiki-seealso span{display:block;margin-bottom:4px;color:var(--mv-muted);font-size:var(--t-xs);font-weight:700}
#mmc-root-v1 .mmc-wiki-linkrow{display:flex;flex-wrap:wrap;gap:4px 12px}
#mmc-root-v1 .mmc-wiki-linkrow .mmc-wiki-link::before{content:"→ ";color:var(--mv-muted)}
#mmc-root-v1 .mmc-wiki-sources{margin:0;padding:0;list-style:none;font-size:var(--t-sm)}
#mmc-root-v1 .mmc-wiki-sources li{padding:4px 0}
#mmc-root-v1 .mmc-wiki-sources li>.mmc-wiki-cite{margin-right:6px;font-size:var(--t-xs);vertical-align:baseline;line-height:inherit}
#mmc-root-v1 .mmc-wiki-sources details{margin:4px 0 0 28px}
#mmc-root-v1 .mmc-wiki-sources summary{color:var(--mv-muted);font-size:var(--t-xs);cursor:pointer}
#mmc-root-v1 .mmc-wiki-sources pre{margin:4px 0 0;padding:8px 10px;background:var(--mv-wiki-box);border:1px solid var(--mv-wiki-rule);font:500 var(--t-xs)/1.55 var(--mv-mono);white-space:pre-wrap}
#mmc-root-v1 .mmc-wiki-doc-foot{clear:both;margin-top:26px;padding-top:10px;border-top:1px solid var(--mv-wiki-rule);color:var(--mv-muted);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-wiki-muted{color:var(--mv-muted)}
#mmc-root-v1 .mmc-wiki-recent{margin:0;padding:0;list-style:none;columns:2;column-gap:24px}
#mmc-root-v1 .mmc-wiki-recent li{display:flex;flex-direction:column;padding:4px 0;break-inside:avoid}
#mmc-root-v1 .mmc-wiki-recent small{color:var(--mv-muted);font-size:var(--t-2xs)}
#mmc-root-v1 .mmc-wiki-cats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
#mmc-root-v1 .mmc-wiki-cat{display:flex;justify-content:space-between;align-items:center;padding:9px 12px;border:1px solid var(--mv-wiki-rule);background:var(--mv-wiki-box);color:var(--mv-wiki-link);font-size:var(--t-sm);text-align:left}
#mmc-root-v1 .mmc-wiki-cat small{color:var(--mv-muted);font:700 var(--t-2xs) var(--mv-mono)}
#mmc-root-v1 .mmc-wiki-cat.is-empty{color:var(--mv-muted)}
#mmc-root-v1 .mmc-wiki-cat:hover{border-color:var(--mv-accent)}
#mmc-root-v1 .mmc-wiki-home-actions{display:flex;gap:8px;margin-top:22px}
#mmc-root-v1 .mmc-layer-backdrop{position:absolute;inset:0;z-index:12;display:flex;justify-content:flex-end;background:color-mix(in srgb,var(--mv-ink) 26%,transparent)}
#mmc-root-v1 .mmc-layer{display:flex;flex-direction:column;width:min(560px,100%);height:100%;border-left:1px solid var(--mv-line-2);background:var(--mv-bg);box-shadow:-20px 0 50px rgba(0,0,0,.14);animation:mmc-sheet-in .18s ease-out}
@keyframes mmc-sheet-in{from{transform:translateX(24px);opacity:.4}to{transform:none;opacity:1}}
#mmc-root-v1 .mmc-layer.mmc-source-layer,#mmc-root-v1 .mmc-layer.mmc-wiki-editor,#mmc-root-v1 .mmc-layer.mmc-wiki-draft-layer,#mmc-root-v1 .mmc-layer.mmc-wiki-candidates-layer,#mmc-root-v1 .mmc-layer.mmc-wiki-proposal-layer,#mmc-root-v1 .mmc-layer.mmc-element-candidates-layer,#mmc-root-v1 .mmc-layer.mmc-help-layer,#mmc-root-v1 .mmc-layer.mmc-element-editor{width:min(760px,100%)}
#mmc-root-v1 .mmc-layer>header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 18px 14px;border-bottom:1px solid var(--mv-line);background:var(--mv-paper)}
#mmc-root-v1 .mmc-layer>header>div{min-width:0}
#mmc-root-v1 .mmc-layer>header h3{margin:2px 0 0;font-size:var(--t-xl);font-weight:850;line-height:1.3;letter-spacing:-.02em}
#mmc-root-v1 .mmc-layer>header small{display:block;margin-top:3px;color:var(--mv-muted);font-size:var(--t-xs);line-height:1.5}
#mmc-root-v1 .mmc-sheet-title{display:flex;align-items:center;gap:10px}
#mmc-root-v1 .mmc-sheet-title h3{margin:0!important}
#mmc-root-v1 .mmc-sheet-icon{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:var(--mv-accent);color:var(--mv-accent-ink)}
#mmc-root-v1 .mmc-sheet-icon .mmc-svg{width:18px;height:18px}
#mmc-root-v1 .mmc-sheet-nav,#mmc-root-v1 .mmc-help-tabs{display:flex;gap:2px;padding:0 14px;border-bottom:1px solid var(--mv-line);background:var(--mv-paper);overflow-x:auto;scrollbar-width:none}
#mmc-root-v1 .mmc-sheet-nav button,#mmc-root-v1 .mmc-help-tabs button{position:relative;min-height:42px;padding:0 12px;border:0;background:transparent;color:var(--mv-muted);font-size:var(--t-sm);font-weight:800;white-space:nowrap}
#mmc-root-v1 .mmc-sheet-nav button.is-active,#mmc-root-v1 .mmc-help-tabs button.is-active{color:var(--mv-ink)}
#mmc-root-v1 .mmc-sheet-nav button.is-active::after,#mmc-root-v1 .mmc-help-tabs button.is-active::after{content:"";position:absolute;left:10px;right:10px;bottom:-1px;height:3px;border-radius:3px 3px 0 0;background:var(--mv-accent)}
#mmc-root-v1 .mmc-layer-body{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:12px;padding:16px 18px 20px;overscroll-behavior:contain}
#mmc-root-v1 .mmc-sheet-pane{display:flex;flex-direction:column;gap:12px}
#mmc-root-v1 .mmc-layer-body>*,#mmc-root-v1 .mmc-sheet-pane>*{flex-shrink:0}
#mmc-root-v1 .mmc-layer>footer{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 18px;border-top:1px solid var(--mv-line);background:var(--mv-paper)}
#mmc-root-v1 .mmc-layer>footer>div{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}
#mmc-root-v1 .mmc-field{display:flex;flex-direction:column;gap:5px;min-width:0;color:var(--mv-muted);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-field>span{color:var(--mv-ink-2);font-weight:800}
#mmc-root-v1 .mmc-field small{font-weight:500;color:var(--mv-muted)}
#mmc-root-v1 .mmc-field input,#mmc-root-v1 .mmc-field select,#mmc-root-v1 .mmc-field textarea,#mmc-root-v1 .mmc-setting input,#mmc-root-v1 .mmc-setting select,#mmc-root-v1 .mmc-model-strip select,#mmc-root-v1 .mmc-wiki-edit-section input,#mmc-root-v1 .mmc-wiki-edit-section select,#mmc-root-v1 .mmc-wiki-edit-section textarea,#mmc-root-v1 .mmc-setting-block textarea,#mmc-root-v1 .mmc-raw-repair textarea{width:100%;min-height:38px;padding:8px 11px;border:1px solid var(--mv-line-2);border-radius:10px;background:var(--mv-paper);color:var(--mv-ink);font-size:var(--t-sm);line-height:1.55;outline:none}
#mmc-root-v1 .mmc-field textarea,#mmc-root-v1 .mmc-setting-block textarea,#mmc-root-v1 .mmc-wiki-edit-section textarea{resize:vertical}
#mmc-root-v1 .mmc-field input:focus,#mmc-root-v1 .mmc-field select:focus,#mmc-root-v1 .mmc-field textarea:focus,#mmc-root-v1 .mmc-setting input:focus,#mmc-root-v1 .mmc-setting select:focus,#mmc-root-v1 .mmc-setting-block textarea:focus,#mmc-root-v1 .mmc-wiki-edit-section input:focus,#mmc-root-v1 .mmc-wiki-edit-section textarea:focus{border-color:var(--mv-accent);box-shadow:0 0 0 3px var(--mv-accent-soft)}
#mmc-root-v1 .mmc-field-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
#mmc-root-v1 .mmc-check-line{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid var(--mv-line);border-radius:10px;background:var(--mv-paper);color:var(--mv-ink);font-size:var(--t-sm);cursor:pointer}
#mmc-root-v1 .mmc-check-line input{width:18px;height:18px;margin:2px 0 0;accent-color:var(--mv-accent);flex:none}
#mmc-root-v1 .mmc-check-line span b{display:block;font-weight:800}
#mmc-root-v1 .mmc-check-line span small{display:block;color:var(--mv-muted);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-source-quote{padding:8px 12px;border:1px dashed var(--mv-line-2);border-radius:10px;background:var(--mv-paper);font-size:var(--t-sm)}
#mmc-root-v1 .mmc-source-quote summary{color:var(--mv-muted);font-size:var(--t-xs);font-weight:700;cursor:pointer}
#mmc-root-v1 .mmc-source-quote p{margin:8px 0 0;color:var(--mv-ink-2);white-space:pre-wrap}
#mmc-root-v1 .mmc-trigger-box{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--mv-line);border-radius:12px;background:var(--mv-paper-2)}
#mmc-root-v1 .mmc-trigger-box>div:first-child b{display:block;font-size:var(--t-md)}
#mmc-root-v1 .mmc-trigger-box>div:first-child small{display:block;color:var(--mv-muted);font-size:var(--t-xs);line-height:1.5}
#mmc-root-v1 .mmc-element-editor-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
#mmc-root-v1 .mmc-wiki-summary-row{grid-template-columns:minmax(0,1fr) 180px}
#mmc-root-v1 .mmc-wiki-count{align-self:flex-end;color:var(--mv-muted);font:600 var(--t-2xs) var(--mv-mono)}
#mmc-root-v1 .mmc-wiki-count.is-over{color:var(--mv-danger)}
#mmc-root-v1 .mmc-wiki-edit-sections-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:6px}
#mmc-root-v1 .mmc-wiki-edit-sections-head b{font-size:var(--t-md)}
#mmc-root-v1 .mmc-wiki-edit-sections-head small{margin-left:4px;color:var(--mv-muted);font-size:var(--t-xs);font-weight:500}
#mmc-root-v1 .mmc-wiki-edit-section{display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid var(--mv-line);border-radius:12px;background:var(--mv-paper)}
#mmc-root-v1 .mmc-wiki-edit-section[data-wiki-level="2"]{margin-left:18px}
#mmc-root-v1 .mmc-wiki-edit-section[data-wiki-level="3"]{margin-left:36px}
#mmc-root-v1 .mmc-wiki-edit-section-head{display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;gap:6px}
#mmc-root-v1 .mmc-wiki-edit-section-head select{width:auto}
#mmc-root-v1 .mmc-wiki-edit-image-head{display:flex;justify-content:space-between;align-items:center}
#mmc-root-v1 .mmc-source-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:6px}
#mmc-root-v1 .mmc-source-toolbar span{margin-left:auto;color:var(--mv-muted);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-source-list{display:flex;flex-direction:column;gap:8px}
#mmc-root-v1 .mmc-source-row{display:flex;gap:10px;padding:10px 12px;border:1px solid var(--mv-line);border-radius:11px;background:var(--mv-paper);cursor:pointer}
#mmc-root-v1 .mmc-source-row.is-selected{border-color:var(--mv-accent);background:color-mix(in srgb,var(--mv-accent) 5%,var(--mv-paper))}
#mmc-root-v1 .mmc-source-row input{width:17px;height:17px;margin-top:2px;accent-color:var(--mv-accent);flex:none}
#mmc-root-v1 .mmc-source-copy{min-width:0;flex:1}
#mmc-root-v1 .mmc-source-copy b{display:block;font-size:var(--t-sm)}
#mmc-root-v1 .mmc-source-copy small{display:block;color:var(--mv-muted);font-size:var(--t-2xs)}
#mmc-root-v1 .mmc-source-copy p{margin:4px 0 0;color:var(--mv-ink-2);font-size:var(--t-xs);line-height:1.55;white-space:pre-wrap;word-break:break-word}
#mmc-root-v1 .mmc-model-strip{display:grid;grid-template-columns:minmax(0,1fr) 240px;align-items:center;gap:12px;padding:12px;border:1px solid color-mix(in srgb,var(--mv-accent-2) 30%,var(--mv-line));border-radius:12px;background:color-mix(in srgb,var(--mv-accent-2) 6%,var(--mv-paper))}
#mmc-root-v1 .mmc-model-strip b{display:block;font-size:var(--t-sm)}
#mmc-root-v1 .mmc-model-strip small{display:block;color:var(--mv-muted);font-size:var(--t-xs);line-height:1.5}
#mmc-root-v1 .mmc-wiki-source-group{display:flex;flex-direction:column;gap:8px}
#mmc-root-v1 .mmc-wiki-source-group-head{display:flex;align-items:center;justify-content:space-between}
#mmc-root-v1 .mmc-wiki-source-group-head small{color:var(--mv-muted);font-family:var(--mv-mono)}
#mmc-root-v1 .mmc-candidate-note{padding:10px 12px;border-radius:10px;background:var(--mv-sunk);color:var(--mv-ink-2);font-size:var(--t-xs);line-height:1.6}
#mmc-root-v1 .mmc-warning-note{background:color-mix(in srgb,var(--mv-warn) 10%,var(--mv-paper));color:color-mix(in srgb,var(--mv-warn) 70%,var(--mv-ink))}
#mmc-root-v1 .mmc-candidate-toolbar{position:sticky;top:-16px;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 12px;border:1px solid var(--mv-line);border-radius:10px;background:var(--mv-paper)}
#mmc-root-v1 .mmc-candidate-toolbar b{font-size:var(--t-sm)}
#mmc-root-v1 .mmc-candidate-toolbar small{color:var(--mv-muted);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-candidate-toolbar>div{display:flex;gap:6px}
#mmc-root-v1 .mmc-candidate-group{display:flex;flex-direction:column;gap:8px}
#mmc-root-v1 .mmc-candidate-group-head{display:flex;align-items:center;gap:10px}
#mmc-root-v1 .mmc-candidate-group-head b{display:block;font-size:var(--t-md)}
#mmc-root-v1 .mmc-candidate-group-head small{display:block;color:var(--mv-muted);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-type-chip{display:inline-flex;align-items:center;justify-content:center;min-width:42px;min-height:22px;padding:0 8px;border-radius:999px;background:var(--mv-accent-soft);color:var(--mv-accent);font-size:var(--t-2xs);font-weight:800;white-space:nowrap}
#mmc-root-v1 .mmc-candidate-group.is-anchor .mmc-type-chip{background:color-mix(in srgb,var(--mv-accent-2) 14%,var(--mv-paper));color:var(--mv-accent-2)}
#mmc-root-v1 .mmc-candidate-list{display:flex;flex-direction:column;gap:8px}
#mmc-root-v1 .mmc-candidate{display:flex;gap:10px;padding:11px 12px;border:1px solid var(--mv-line);border-radius:11px;background:var(--mv-paper);cursor:pointer}
#mmc-root-v1 .mmc-candidate.is-selected{border-color:var(--mv-accent);background:color-mix(in srgb,var(--mv-accent) 5%,var(--mv-paper))}
#mmc-root-v1 .mmc-candidate.is-conflict{border-color:color-mix(in srgb,var(--mv-danger) 40%,var(--mv-line));opacity:.8}
#mmc-root-v1 .mmc-candidate input{width:17px;height:17px;margin-top:2px;accent-color:var(--mv-accent);flex:none}
#mmc-root-v1 .mmc-candidate>span{flex:1;min-width:0}
#mmc-root-v1 .mmc-candidate b{display:block;font-size:var(--t-sm)}
#mmc-root-v1 .mmc-candidate small{display:block;color:var(--mv-muted);font-size:var(--t-2xs)}
#mmc-root-v1 .mmc-candidate p{margin:4px 0 0;color:var(--mv-ink-2);font-size:var(--t-xs);line-height:1.55;white-space:pre-wrap}
#mmc-root-v1 .mmc-candidate em{display:block;margin-top:4px;color:var(--mv-accent-2);font-size:var(--t-2xs);font-style:normal}
#mmc-root-v1 .mmc-review-before{display:block!important;margin-top:4px;padding:5px 8px;border-left:2px solid var(--mv-line-2);background:var(--mv-paper-2);line-height:1.45}
#mmc-root-v1 .mmc-conflict-note{color:var(--mv-danger)!important}
#mmc-root-v1 .mmc-review-candidate [data-review-action="add"]{color:var(--mv-ok)}
#mmc-root-v1 .mmc-review-candidate [data-review-action="update"]{color:var(--mv-accent)}
#mmc-root-v1 .mmc-review-candidate [data-review-action="complete"]{color:var(--mv-ok)}
#mmc-root-v1 .mmc-review-candidate [data-review-action="archive"]{color:var(--mv-warn)}
#mmc-root-v1 .mmc-review-candidate [data-review-action="keep"]{color:var(--mv-muted)}
#mmc-root-v1 .mmc-element-candidate,#mmc-root-v1 .mmc-wiki-candidate,#mmc-root-v1 .mmc-wiki-change{display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--mv-line);border-radius:12px;background:var(--mv-paper)}
#mmc-root-v1 .mmc-wiki-candidate.is-selected,#mmc-root-v1 .mmc-wiki-change.is-selected{border-color:var(--mv-accent)}
#mmc-root-v1 .mmc-element-candidate-head,#mmc-root-v1 .mmc-wiki-candidate-head,#mmc-root-v1 .mmc-wiki-change-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
#mmc-root-v1 .mmc-element-candidate-head label,#mmc-root-v1 .mmc-wiki-candidate-head label{display:inline-flex;align-items:center;gap:6px}
#mmc-root-v1 .mmc-element-candidate-head input,#mmc-root-v1 .mmc-wiki-candidate-head input,#mmc-root-v1 .mmc-wiki-change-head input{width:17px;height:17px;accent-color:var(--mv-accent)}
#mmc-root-v1 .mmc-element-candidate-head b,#mmc-root-v1 .mmc-wiki-candidate-head b,#mmc-root-v1 .mmc-wiki-change-head b{font-size:var(--t-md)}
#mmc-root-v1 .mmc-element-candidate-head small,#mmc-root-v1 .mmc-wiki-candidate-head small{margin-left:auto;color:var(--mv-muted);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-wiki-diff{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px}
#mmc-root-v1 .mmc-wiki-diff-side{padding:8px 10px;border-radius:9px;font-size:var(--t-xs);line-height:1.55}
#mmc-root-v1 .mmc-wiki-diff-side b{display:block;margin-bottom:3px;font-size:var(--t-2xs)}
#mmc-root-v1 .mmc-wiki-diff-side p{margin:0 0 3px;white-space:pre-wrap}
#mmc-root-v1 .mmc-wiki-diff-side.is-before{background:color-mix(in srgb,var(--mv-danger) 8%,var(--mv-paper));color:color-mix(in srgb,var(--mv-danger) 60%,var(--mv-ink))}
#mmc-root-v1 .mmc-wiki-diff-side.is-before p{text-decoration:line-through;text-decoration-color:color-mix(in srgb,var(--mv-danger) 50%,transparent)}
#mmc-root-v1 .mmc-wiki-diff-side.is-after{background:color-mix(in srgb,var(--mv-ok) 9%,var(--mv-paper));color:color-mix(in srgb,var(--mv-ok) 60%,var(--mv-ink))}
#mmc-root-v1 .mmc-evidence-group{display:flex;flex-direction:column;gap:8px}
#mmc-root-v1 .mmc-evidence-group h4{margin:0;font-size:var(--t-sm);font-weight:800}
#mmc-root-v1 .mmc-evidence-fact{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid var(--mv-line);border-radius:11px;background:var(--mv-paper)}
#mmc-root-v1 .mmc-evidence-fact.is-focus{border-color:var(--mv-accent);box-shadow:0 0 0 3px var(--mv-accent-soft)}
#mmc-root-v1 .mmc-evidence-fact-head{display:grid;grid-template-columns:auto auto minmax(0,1fr);align-items:baseline;gap:8px}
#mmc-root-v1 .mmc-evidence-fact-head span{color:var(--mv-accent);font:800 var(--t-xs) var(--mv-mono)}
#mmc-root-v1 .mmc-evidence-fact-head small{color:var(--mv-muted);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-evidence-layer pre,#mmc-root-v1 .mmc-evidence-fact pre{margin:0;padding:8px 10px;border-radius:8px;background:var(--mv-sunk);color:var(--mv-ink-2);font:500 var(--t-xs)/1.6 var(--mv-mono);white-space:pre-wrap;word-break:break-word}
#mmc-root-v1 .mmc-evidence-ids{display:flex;flex-wrap:wrap;gap:4px}
#mmc-root-v1 .mmc-evidence-ids code{padding:1px 6px;border-radius:5px;background:var(--mv-sunk);font:500 var(--t-2xs) var(--mv-mono)}
#mmc-root-v1 .mmc-preview-block{border:1px solid var(--mv-line);border-radius:12px;background:var(--mv-paper);overflow:hidden}
#mmc-root-v1 .mmc-preview-block>header{display:flex;justify-content:space-between;align-items:baseline;gap:10px;padding:10px 12px;border-bottom:1px solid var(--mv-line)}
#mmc-root-v1 .mmc-preview-block>header small{color:var(--mv-muted);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-preview-block pre{margin:0;padding:10px 12px;background:var(--mv-paper-2);color:var(--mv-ink-2);font:500 var(--t-xs)/1.65 var(--mv-mono);white-space:pre-wrap;word-break:break-word}
#mmc-root-v1 .mmc-preview-block.is-promise>header{border-left:4px solid var(--mv-accent)}
#mmc-root-v1 .mmc-preview-block.is-anchor>header{border-left:4px solid var(--mv-accent-2)}
#mmc-root-v1 .mmc-preview-block.is-wiki>header{border-left:4px solid var(--mv-ok)}
#mmc-root-v1 .mmc-guide{display:flex;flex-direction:column;gap:8px}
#mmc-root-v1 .mmc-guide section{padding:11px 14px;border:1px solid var(--mv-line);border-left:3px solid var(--mv-accent);border-radius:0 10px 10px 0;background:var(--mv-paper)}
#mmc-root-v1 .mmc-guide b{font-size:var(--t-md)}
#mmc-root-v1 .mmc-guide p{margin:4px 0 0;color:var(--mv-ink-2);font-size:var(--t-sm);line-height:1.65}
#mmc-root-v1 .mmc-guide code{padding:0 4px;border-radius:4px;background:var(--mv-sunk);font:500 .92em var(--mv-mono)}
#mmc-root-v1 .mmc-raw-repair textarea{flex:1;min-height:40dvh;font:500 var(--t-xs)/1.55 var(--mv-mono)}
#mmc-root-v1 .mmc-set-card{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--mv-line);border-radius:12px;background:var(--mv-paper)}
#mmc-root-v1 .mmc-set-head b{display:block;font-size:var(--t-lg);font-weight:850}
#mmc-root-v1 .mmc-set-head small{display:block;margin-top:2px;color:var(--mv-muted);font-size:var(--t-xs);line-height:1.6}
#mmc-root-v1 .mmc-set-head strong{color:var(--mv-ink);font-weight:800}
#mmc-root-v1 .mmc-setting{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--mv-line)}
#mmc-root-v1 .mmc-set-card>.mmc-set-head+.mmc-setting{border-top:1px solid var(--mv-line)}
#mmc-root-v1 .mmc-setting>span b{display:block;font-size:var(--t-sm);font-weight:800}
#mmc-root-v1 .mmc-setting>span small{display:block;color:var(--mv-muted);font-size:var(--t-xs);line-height:1.55}
#mmc-root-v1 .mmc-setting input,#mmc-root-v1 .mmc-setting select{width:auto;min-width:120px;max-width:260px}
#mmc-root-v1 .mmc-setting input[type="number"]{width:110px;min-width:0;font-family:var(--mv-mono);text-align:right}
#mmc-root-v1 .mmc-setting-model{grid-template-columns:minmax(0,1fr) minmax(180px,260px)}
#mmc-root-v1 .mmc-setting-model select{width:100%;max-width:none}
#mmc-root-v1 .mmc-set-card>.mmc-setting:first-child{border-top:0;padding-top:0}
#mmc-root-v1 .mmc-setting-block{display:flex;flex-direction:column;gap:8px;padding:14px;border:1px solid var(--mv-line);border-radius:12px;background:var(--mv-paper)}
#mmc-root-v1 .mmc-setting-block>span,#mmc-root-v1 .mmc-setting-block-head>span{display:flex;flex-direction:column}
#mmc-root-v1 .mmc-setting-block b{font-size:var(--t-sm);font-weight:800}
#mmc-root-v1 .mmc-setting-block small{color:var(--mv-muted);font-size:var(--t-xs);line-height:1.55}
#mmc-root-v1 .mmc-setting-block-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
#mmc-root-v1 .mmc-setting-block textarea{font:500 var(--t-xs)/1.6 var(--mv-mono)}
#mmc-root-v1 .mmc-setting-card{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px;border:1px solid var(--mv-line);border-radius:12px;background:var(--mv-paper)}
#mmc-root-v1 .mmc-setting-card>div:first-child{min-width:0}
#mmc-root-v1 .mmc-setting-card b{display:block;font-size:var(--t-sm);font-weight:800}
#mmc-root-v1 .mmc-setting-card small{display:block;color:var(--mv-muted);font-size:var(--t-xs);line-height:1.55;word-break:break-all}
#mmc-root-v1 .mmc-setting-card em{display:block;margin-top:3px;color:var(--mv-danger);font-size:var(--t-xs);font-style:normal}
#mmc-root-v1 .mmc-theme-cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
#mmc-root-v1 .mmc-theme-card{position:relative;display:block;cursor:pointer}
#mmc-root-v1 .mmc-theme-card input{position:absolute;opacity:0;pointer-events:none}
#mmc-root-v1 .mmc-theme-card-ui{position:relative;display:flex;flex-direction:column;gap:2px;height:100%;padding:10px 10px 12px;border:1.5px solid var(--mv-line);border-radius:12px;background:var(--mv-paper)}
#mmc-root-v1 .mmc-theme-card:hover .mmc-theme-card-ui{border-color:var(--mv-line-2)}
#mmc-root-v1 .mmc-theme-card input:checked+.mmc-theme-card-ui{border-color:var(--mv-accent);box-shadow:0 0 0 3px var(--mv-accent-soft)}
#mmc-root-v1 .mmc-theme-card input:focus-visible+.mmc-theme-card-ui{outline:2px solid var(--mv-accent);outline-offset:2px}
#mmc-root-v1 .mmc-theme-card-ui strong{margin-top:8px;font-size:var(--t-md);font-weight:850}
#mmc-root-v1 .mmc-theme-card-ui small{color:var(--mv-muted);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-theme-check{position:absolute;bottom:12px;right:12px;display:none;place-items:center;width:22px;height:22px;border-radius:50%;background:var(--mv-accent);color:var(--mv-accent-ink);font-size:12px;font-style:normal;font-weight:900}
#mmc-root-v1 .mmc-theme-card input:checked+.mmc-theme-card-ui .mmc-theme-check{display:grid}
#mmc-root-v1 .mmc-tp{display:grid;grid-template-columns:1fr 1fr;gap:5px;height:84px;padding:6px;border-radius:9px;background:var(--tp-desk)}
#mmc-root-v1 .mmc-tp-app,#mmc-root-v1 .mmc-tp-wiki{position:relative;display:flex;flex-direction:column;gap:5px;padding:12px 6px 6px;border-radius:5px;background:var(--tp-bg);overflow:hidden}
#mmc-root-v1 .mmc-tp-wiki{background:var(--tp-paper)}
#mmc-root-v1 .mmc-tp i{position:absolute;left:0;right:0;top:0;height:4px;background:var(--tp-accent)}
#mmc-root-v1 .mmc-tp-app b{display:block;height:9px;border-radius:3px;background:var(--tp-paper)}
#mmc-root-v1 .mmc-tp-wiki b{display:block;height:2px;width:70%;background:var(--tp-link)}
#mmc-root-v1 .mmc-tp-wiki b:nth-of-type(2){width:55%}
#mmc-root-v1 .mmc-tp-wiki b:nth-of-type(3){width:62%}
#mmc-root-v1 .mmc-tp-wiki s{position:absolute;right:5px;top:10px;width:26%;height:60%;border:1px solid var(--tp-rule);background:var(--tp-box);text-decoration:none}
#mmc-root-v1 .mmc-tp-wiki s::before{content:"";position:absolute;left:0;right:0;top:0;height:5px;background:var(--tp-head)}
#mmc-root-v1 [data-tp="ribbon"]{--tp-desk:#dcdbe6;--tp-bg:#f4f3f9;--tp-paper:#fff;--tp-accent:#5b5fb5;--tp-link:#4450c4;--tp-head:#5b5fb5;--tp-box:#f6f5fb;--tp-rule:#d6d4e6}
#mmc-root-v1 [data-tp="rose"]{--tp-desk:#e2d6d5;--tp-bg:#f7f1f0;--tp-paper:#fffdfc;--tp-accent:#a14c64;--tp-link:#a53f5c;--tp-head:#7d3c4e;--tp-box:#faf3f3;--tp-rule:#e2d1d3}
#mmc-root-v1 [data-tp="green"]{--tp-desk:#d3dcda;--tp-bg:#f2f5f4;--tp-paper:#fff;--tp-accent:#00a495;--tp-link:#0f7fbd;--tp-head:#00a495;--tp-box:#f5f7f7;--tp-rule:#ccd6d3}
#mmc-root-v1 [data-tp="marinara"]{--tp-desk:#0c0e11;--tp-bg:#15171c;--tp-paper:#1b1e24;--tp-accent:var(--primary,#8fb3ff);--tp-link:var(--primary,#9fc0ff);--tp-head:#3a4a6e;--tp-box:#1f232a;--tp-rule:#343a45}
#mmc-root-v1 .mmc-theme-note{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:10px;background:var(--mv-accent-soft);color:var(--mv-ink-2);font-size:var(--t-xs);line-height:1.6}
#mmc-root-v1 .mmc-theme-note .mmc-svg{width:15px;height:15px;margin-top:2px;color:var(--mv-accent)}
#mmc-root-v1 .mmc-wiki-theme-link{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--mv-line);border-radius:11px;background:var(--mv-paper-2)}
#mmc-root-v1 .mmc-wiki-theme-link>span:nth-child(2){flex:1;min-width:0}
#mmc-root-v1 .mmc-wiki-theme-link b{display:block;font-size:var(--t-md);font-weight:850}
#mmc-root-v1 .mmc-wiki-theme-link small{display:block;color:var(--mv-muted);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-swatch{width:46px;height:34px;flex:none;border-radius:8px;background:linear-gradient(90deg,var(--tp-bg) 0 34%,var(--tp-accent) 34% 67%,var(--tp-link) 67% 100%);box-shadow:inset 0 0 0 1px rgba(0,0,0,.08)}
#mmc-root-v1 .mmc-busy{position:absolute;inset:0;z-index:30;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:color-mix(in srgb,var(--mv-bg) 86%,transparent);backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px)}
#mmc-root-v1 .mmc-spinner{width:30px;height:30px;border:3px solid var(--mv-line-2);border-top-color:var(--mv-accent);border-radius:50%;animation:mmc-spin .9s linear infinite}
@keyframes mmc-spin{to{transform:rotate(360deg)}}
#mmc-root-v1 .mmc-busy b{font-size:var(--t-md)}
#mmc-root-v1 .mmc-busy small{color:var(--mv-muted);font:600 var(--t-xs) var(--mv-mono)}
@media(max-width:1020px){#mmc-root-v1 .mmc-brand-text small{display:none}
#mmc-root-v1 .mmc-sync span{display:none}
#mmc-root-v1 .mmc-sync{padding:0 9px}
#mmc-root-v1 .mmc-el-wrap{grid-template-columns:minmax(0,1fr)}
#mmc-root-v1 .mmc-el-aside{position:static}
#mmc-root-v1 .mmc-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
#mmc-root-v1 .mmc-wiki-infobox{width:250px}
#mmc-root-v1 .mmc-wiki-cats{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:860px){#mmc-root-v1 .mmc-ov-grid,#mmc-root-v1 .mmc-lanes{grid-template-columns:minmax(0,1fr)}
#mmc-root-v1 .mmc-split{grid-template-columns:minmax(0,1fr)}
#mmc-root-v1 .mmc-detail{position:static}
#mmc-root-v1 .mmc-wiki-split{grid-template-columns:220px minmax(0,1fr)}
#mmc-root-v1 .mmc-wiki-infobox{float:none;width:auto;margin:0 0 16px}}
@media(max-width:700px){#mmc-root-v1 .mmc-overlay{padding:0;align-items:stretch}
#mmc-root-v1 .mmc-shell{width:100vw;height:100dvh;border:0;border-radius:0;grid-template-rows:auto minmax(0,1fr) auto}
#mmc-root-v1 .mmc-bar{flex-wrap:wrap;gap:8px;padding:max(12px,env(safe-area-inset-top)) 12px 10px}
#mmc-root-v1 .mmc-brand-text{display:none}
#mmc-root-v1 .mmc-brand-mark{width:36px;height:36px}
#mmc-root-v1 .mmc-story{order:5;flex:1 1 100%;max-width:none;margin:0}
#mmc-root-v1 .mmc-icon-btn{width:36px;height:36px}
#mmc-root-v1 .mmc-tabs{grid-row:3;justify-content:space-around;gap:0;padding:4px 4px max(6px,env(safe-area-inset-bottom));border-top:1px solid var(--mv-line-2);border-bottom:0;overflow:visible}
#mmc-root-v1 .mmc-tab{flex:1;flex-direction:column;gap:2px;min-height:54px;margin:0;padding:6px 2px 4px;border:0;border-radius:12px;font-size:var(--t-2xs)}
#mmc-root-v1 .mmc-tab .mmc-svg{width:21px;height:21px}
#mmc-root-v1 .mmc-tab-long{display:none}
#mmc-root-v1 .mmc-tab-short{display:inline}
#mmc-root-v1 .mmc-tab em{position:absolute;top:1px;left:calc(50% + 6px);min-width:18px;height:18px;padding:0 5px;font-size:10px;line-height:18px;box-shadow:0 0 0 2px var(--mv-paper)}
#mmc-root-v1 .mmc-tab-dot{position:absolute;top:6px;left:calc(50% + 10px)}
#mmc-root-v1 .mmc-tab.is-active{background:var(--mv-accent-soft);color:var(--mv-accent)}
#mmc-root-v1 .mmc-tab.is-active::before{display:none}
#mmc-root-v1 .mmc-body{padding:14px 12px 20px}
#mmc-root-v1 .mmc-m-only{display:inline-flex!important}
#mmc-root-v1 .mmc-summary-alert,#mmc-root-v1 .mmc-agent-note,#mmc-root-v1 .mmc-advanced-memory-note,#mmc-root-v1 .mmc-wiki-banner{flex-wrap:wrap}
#mmc-root-v1 .mmc-summary-alert>div:nth-child(2),#mmc-root-v1 .mmc-wiki-banner>div:nth-child(2){flex:1 1 calc(100% - 50px)}
#mmc-root-v1 .mmc-summary-alert>div:last-child,#mmc-root-v1 .mmc-wiki-banner>div:last-child{flex:1 1 100%}
#mmc-root-v1 .mmc-summary-alert>div:last-child .mmc-btn,#mmc-root-v1 .mmc-wiki-banner>div:last-child .mmc-btn{flex:1}
#mmc-root-v1 .mmc-inject{padding:16px}
#mmc-root-v1 .mmc-inject-foot{flex-direction:column;align-items:stretch}
#mmc-root-v1 .mmc-inbox-row{flex-wrap:wrap}
#mmc-root-v1 .mmc-inbox-copy{flex:1 1 calc(100% - 52px)}
#mmc-root-v1 .mmc-inbox-actions{margin-left:48px}
#mmc-root-v1 .mmc-kv{grid-template-columns:repeat(2,minmax(0,1fr))}
#mmc-root-v1 .mmc-kv>div:last-child{grid-column:1/-1}
#mmc-root-v1 .mmc-split[data-pane="list"]>.mmc-detail{display:none}
#mmc-root-v1 .mmc-split[data-pane="detail"]>.mmc-listpane{display:none}
#mmc-root-v1 .mmc-listpane-foot .mmc-actions .mmc-btn{flex:1}
#mmc-root-v1 .mmc-toolbar{flex-direction:column;align-items:stretch}
#mmc-root-v1 .mmc-toolbar .mmc-actions .mmc-btn{flex:1}
#mmc-root-v1 .mmc-element-toolbox{grid-template-columns:minmax(0,1fr)}
#mmc-root-v1 .mmc-dock-controls{justify-content:flex-start}
#mmc-root-v1 .mmc-dock-controls>.mmc-btn{flex:1 1 100%}
#mmc-root-v1 .mmc-element-list{grid-template-columns:minmax(0,1fr)}
#mmc-root-v1 .mmc-shell[data-tab="wiki"] .mmc-body{padding:0}
#mmc-root-v1 .mmc-wiki-split{grid-template-columns:minmax(0,1fr)}
#mmc-root-v1 .mmc-wiki-split[data-wiki-pane="doc"]>.mmc-wiki-side{display:none}
#mmc-root-v1 .mmc-wiki-split[data-wiki-pane="list"]>.mmc-wiki-main{display:none}
#mmc-root-v1 .mmc-wiki-side{border-right:0}
#mmc-root-v1 .mmc-wiki-actionbar{padding:8px 12px;flex-wrap:nowrap}
#mmc-root-v1 .mmc-wiki-back,#mmc-root-v1 .mmc-wiki-back:not(.has-history){display:inline-flex}
#mmc-root-v1 .mmc-wiki-crumb{display:none}
#mmc-root-v1 .mmc-wiki-actions{margin-left:auto}
#mmc-root-v1 .mmc-wiki-article{padding:14px 16px 30px}
#mmc-root-v1 .mmc-wiki-title{font-size:calc(28px*var(--fs))}
#mmc-root-v1 .mmc-wiki-infobox{float:none;width:auto;margin:0 0 16px}
#mmc-root-v1 .mmc-wiki-lead-image img{max-height:260px}
#mmc-root-v1 .mmc-wiki-toc{display:block}
#mmc-root-v1 .mmc-wiki-seealso{grid-template-columns:minmax(0,1fr)}
#mmc-root-v1 .mmc-wiki-recent{columns:1}
#mmc-root-v1 .mmc-wiki-home-actions{flex-direction:column}
#mmc-root-v1 .mmc-layer{width:100%!important;border-left:0;animation:none}
#mmc-root-v1 .mmc-layer>header{padding-top:max(14px,env(safe-area-inset-top))}
#mmc-root-v1 .mmc-layer>footer{padding-bottom:max(12px,env(safe-area-inset-bottom));flex-wrap:wrap}
#mmc-root-v1 .mmc-layer>footer>div{flex:1;justify-content:stretch}
#mmc-root-v1 .mmc-layer>footer>div .mmc-btn{flex:1}
#mmc-root-v1 .mmc-field-row,#mmc-root-v1 .mmc-element-editor-grid,#mmc-root-v1 .mmc-wiki-summary-row,#mmc-root-v1 .mmc-model-strip{grid-template-columns:minmax(0,1fr)}
#mmc-root-v1 .mmc-setting,#mmc-root-v1 .mmc-setting-model{grid-template-columns:minmax(0,1fr)}
#mmc-root-v1 .mmc-setting input,#mmc-root-v1 .mmc-setting select{max-width:none;width:100%}
#mmc-root-v1 .mmc-setting input[type="number"]{width:100%;text-align:left}
#mmc-root-v1 .mmc-setting-card{flex-direction:column;align-items:stretch}
#mmc-root-v1 .mmc-setting-block-head{flex-direction:column}
#mmc-root-v1 .mmc-candidate-toolbar{flex-direction:column;align-items:flex-start}
#mmc-root-v1 .mmc-wiki-edit-section-head{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
#mmc-root-v1 .mmc-wiki-edit-section-head input{grid-column:1/-1}
#mmc-root-v1 .mmc-ownership-guard dl>div{grid-template-columns:minmax(0,1fr)}
#mmc-root-v1 .mmc-ownership-actions{flex-direction:column}}
@media(max-width:380px){#mmc-root-v1 .mmc-theme-cards{grid-template-columns:minmax(0,1fr)}
#mmc-root-v1 .mmc-stats{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}}
/* v2.1 · 아는 인물 범위 */
#mmc-root-v1 .mmc-meter i.is-restricted,#mmc-root-v1 .mmc-legend .is-restricted i{background:var(--mv-accent-2)}
#mmc-root-v1 .mmc-preview-block.is-restricted>header{border-left:4px solid var(--mv-accent-2)}
#mmc-root-v1 .mmc-advanced-memory-note.is-warn .mmc-alert-icon{background:color-mix(in srgb,var(--mv-warn) 15%,var(--mv-paper));color:var(--mv-warn)}
#mmc-root-v1 .mmc-advanced-memory-note small+small{margin-top:4px}
#mmc-root-v1 .mmc-scope{display:flex;flex-direction:column;gap:5px;margin-top:8px;padding-top:8px;border-top:1px dashed var(--mv-line)}
#mmc-root-v1 .mmc-scope-label{display:flex;align-items:center;gap:5px;color:var(--mv-ink-2);font-size:var(--t-2xs);font-weight:600}
#mmc-root-v1 .mmc-scope-label .mmc-svg{width:13px;height:13px}
#mmc-root-v1 .mmc-scope.is-restricted .mmc-scope-label{color:var(--mv-accent-2)}
#mmc-root-v1 .mmc-scope.is-pending .mmc-scope-label{color:var(--mv-warn)}
#mmc-root-v1 .mmc-scope-chips{display:flex;flex-wrap:wrap;gap:5px;align-items:center}
#mmc-root-v1 .mmc-scope-chip{display:inline-flex;align-items:center;gap:4px;min-height:28px;padding:2px 9px;border:1px solid var(--mv-line-2);border-radius:6px;background:var(--mv-paper);color:var(--mv-ink-2);font-size:var(--t-2xs);cursor:pointer}
#mmc-root-v1 .mmc-scope-chip input{width:13px;height:13px;margin:0;accent-color:var(--mv-accent-2)}
#mmc-root-v1 .mmc-scope-chip.is-on{border-color:var(--mv-accent-2);background:color-mix(in srgb,var(--mv-accent-2) 10%,var(--mv-paper));color:var(--mv-ink)}
#mmc-root-v1 .mmc-scope-warn{color:var(--mv-warn)!important;font-size:var(--t-2xs);line-height:1.5}
#mmc-root-v1 .mmc-hold-row{display:flex;align-items:center;justify-content:space-between;gap:10px;cursor:default}
#mmc-root-v1 .mmc-hold-row>span:first-child{min-width:0;flex:1}
#mmc-root-v1 .mmc-hold-actions{display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end}
#mmc-root-v1 .mmc-hold-group-actions{margin-left:auto}
@media (max-width:520px){#mmc-root-v1 .mmc-hold-row{flex-direction:column;align-items:stretch}#mmc-root-v1 .mmc-hold-actions{justify-content:flex-start}}
/* v2.1 · 장면 기억 */
#mmc-root-v1 .mmc-episode-note{display:flex;flex-direction:column;gap:2px;min-width:0}
#mmc-root-v1 .mmc-episode-note small{color:var(--mv-muted);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-episode-list{display:grid;gap:12px}
#mmc-root-v1 .mmc-episode{padding:14px 16px}
#mmc-root-v1 .mmc-episode.is-replaced{opacity:.72}
#mmc-root-v1 .mmc-episode-head{display:flex;align-items:flex-start;gap:10px;margin-bottom:8px}
#mmc-root-v1 .mmc-episode-head>div{flex:1;min-width:0}
#mmc-root-v1 .mmc-episode-head b{display:block;font-size:var(--t-md)}
#mmc-root-v1 .mmc-episode-head small{display:block;margin-top:2px;color:var(--mv-muted);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-episode-grid{display:grid;gap:8px;margin:0}
#mmc-root-v1 .mmc-episode-grid>div{display:grid;grid-template-columns:52px minmax(0,1fr);gap:10px}
#mmc-root-v1 .mmc-episode-grid dt{color:var(--mv-muted);font-size:var(--t-2xs);font-weight:700;padding-top:2px}
#mmc-root-v1 .mmc-episode-grid dd{margin:0;color:var(--mv-ink-2);font-size:var(--t-xs);line-height:1.55;min-width:0}
#mmc-root-v1 .mmc-episode-grid dd small{display:block;color:var(--mv-muted);margin-top:2px}
#mmc-root-v1 .mmc-episode-grid ul,#mmc-root-v1 .mmc-episode-cand ul{margin:4px 0 0;padding-left:16px}
#mmc-root-v1 .mmc-episode-facts{list-style:none;padding-left:0!important;display:grid;gap:4px}
#mmc-root-v1 .mmc-episode-facts li{display:flex;flex-wrap:wrap;align-items:center;gap:5px}
#mmc-root-v1 .mmc-episode-facts li>span:not(.mmc-chip){flex:1 1 180px;min-width:0}
#mmc-root-v1 .mmc-episode-facts .mmc-scope{flex:1 1 100%;margin-top:2px;padding-top:4px}
#mmc-root-v1 .mmc-episode-people{list-style:none;padding-left:0!important;display:grid;gap:4px}
#mmc-root-v1 .mmc-episode-old{margin-top:14px}
#mmc-root-v1 .mmc-episode-old summary{cursor:pointer;color:var(--mv-muted);font-size:var(--t-xs);margin-bottom:8px}
#mmc-root-v1 .mmc-episode-cand{display:flex;gap:10px;align-items:flex-start;cursor:default}
#mmc-root-v1 .mmc-episode-cand>span{flex:1;min-width:0}
#mmc-root-v1 .mmc-scope-note{display:block;color:var(--mv-ink-2);font-size:var(--t-2xs);margin-top:4px}
#mmc-root-v1 .mmc-episode-fact-edit{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:6px}
#mmc-root-v1 .mmc-episode-fact-edit select{flex:0 0 auto;min-height:36px}
#mmc-root-v1 .mmc-episode-fact-edit input{flex:1 1 200px;min-width:0;min-height:36px}
#mmc-root-v1 .mmc-episode-fact-edit .mmc-scope{flex:1 1 100%}
/* v2.1 · 진행 흐름 */
#mmc-root-v1 .mmc-meter i.is-thread,#mmc-root-v1 .mmc-legend .is-thread i{background:var(--mv-warn)}
#mmc-root-v1 .mmc-preview-block.is-thread>header{border-left:4px solid var(--mv-warn)}
#mmc-root-v1 .mmc-thread{padding:14px 16px}
#mmc-root-v1 .mmc-thread.is-resolved,#mmc-root-v1 .mmc-thread.is-cancelled{opacity:.75}
#mmc-root-v1 .mmc-thread-state{margin:2px 0 6px;color:var(--mv-ink);font-size:var(--t-sm);line-height:1.55;white-space:pre-wrap}
#mmc-root-v1 .mmc-thread-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
#mmc-root-v1 .mmc-thread-history{margin-top:10px}
#mmc-root-v1 .mmc-thread-history summary{cursor:pointer;color:var(--mv-muted);font-size:var(--t-xs)}
#mmc-root-v1 .mmc-thread-history ol{list-style:none;margin:8px 0 0;padding:0 0 0 10px;border-left:2px solid var(--mv-line);display:grid;gap:6px}
#mmc-root-v1 .mmc-thread-history li{display:flex;flex-wrap:wrap;align-items:center;gap:5px;font-size:var(--t-xs);color:var(--mv-ink-2)}
#mmc-root-v1 .mmc-thread-history li>span:not(.mmc-chip){flex:1 1 200px;min-width:0}
#mmc-root-v1 .mmc-thread-history li small{flex:1 1 100%;color:var(--mv-muted);font-size:var(--t-2xs)}
#mmc-root-v1 .mmc-scope-note .mmc-svg{width:12px;height:12px;vertical-align:-2px;margin-right:3px}
/* v2.1.1 · 후보 전체 선택·전체 보류 */
#mmc-root-v1 .mmc-bulk-toolbar{flex-wrap:wrap;row-gap:8px}
#mmc-root-v1 .mmc-bulk-count{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1 1 180px}
#mmc-root-v1 .mmc-bulk-actions{display:flex;gap:6px;flex:0 0 auto}
#mmc-root-v1 .mmc-bulk-actions .mmc-btn{white-space:nowrap}
@media(max-width:700px){#mmc-root-v1 .mmc-bulk-toolbar{flex-direction:column;align-items:stretch}
#mmc-root-v1 .mmc-bulk-count{flex:0 0 auto}
#mmc-root-v1 .mmc-bulk-actions{width:100%}
#mmc-root-v1 .mmc-bulk-actions .mmc-btn{flex:1 1 0;min-height:36px}}

/* adapter overrides */
/* Adapter overrides for the pinned original (appended after vendor/original/extension.css; the original file is never edited).
   Goal: phone-safe reading and touch sizes - body text >= 15px, secondary >= 13px, touch targets >= 44px, contrast >= 4.5:1,
   and every pane scrolls on short desktop windows. Only sizes/colours/overflow are touched; no structure. */

/* type scale: the original's smallest steps were 10.5 / 11.5 / 12.5 / 13.5 px */
#mmc-root-v1,.mmc-launcher,.mmc-toast{--t-2xs:calc(13px*var(--fs));--t-xs:calc(13px*var(--fs));--t-sm:calc(15px*var(--fs));--t-md:calc(15px*var(--fs));--t-lg:calc(16px*var(--fs))}
.mmc-launcher span{font-size:13px}
#mmc-root-v1 .mmc-tab em{font-size:13px;min-width:22px;height:22px;line-height:22px;top:0}
#mmc-root-v1 .mmc-wiki-cite{font-size:.8em}

/* touch targets */
#mmc-root-v1 .mmc-btn,#mmc-root-v1 .mmc-btn.mmc-sm,#mmc-root-v1 .mmc-icon-btn,#mmc-root-v1 .mmc-sync,#mmc-root-v1 .mmc-mini,#mmc-root-v1 .mmc-filter,#mmc-root-v1 .mmc-seg>label,#mmc-root-v1 .mmc-pill,#mmc-root-v1 .mmc-searchbox,#mmc-root-v1 .mmc-stepper button,#mmc-root-v1 .mmc-wiki-actions>button,#mmc-root-v1 .mmc-wiki-more>summary,#mmc-root-v1 .mmc-bulk-actions .mmc-btn,#mmc-root-v1 .mmc-wiki-cat,#mmc-root-v1 .mmc-ticket-main,#mmc-root-v1 .mmc-tab{min-height:44px}
#mmc-root-v1 .mmc-icon-btn{min-width:44px}
#mmc-root-v1 select,#mmc-root-v1 input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]),#mmc-root-v1 .mmc-element-range input,#mmc-root-v1 .mmc-wiki-side-tools select,#mmc-root-v1 .mmc-episode-fact-edit select,#mmc-root-v1 .mmc-episode-fact-edit input{min-height:44px;font-size:max(15px,var(--t-md))}
#mmc-root-v1 textarea{font-size:max(15px,var(--t-md))}
#mmc-root-v1 .mmc-link{min-height:44px;display:inline-flex;align-items:center}
#mmc-root-v1 .mmc-check,#mmc-root-v1 .mmc-check.mmc-pin-check{min-width:44px;min-height:44px}
#mmc-root-v1 .mmc-type-chip,#mmc-root-v1 .mmc-chip{min-height:24px}
#mmc-root-v1 .mmc-story select{min-height:44px}
#mmc-root-v1 .mmc-story{min-height:56px}
.mmc-launcher{min-width:44px;height:56px}
#mmc-root-v1 .mmc-mini{font-size:15px}
#mmc-root-v1 button:not(.mmc-wiki-cite),#mmc-root-v1 select{min-height:44px!important}

/* contrast: the original's muted text colours were 3.2-4.1:1 on their own paper; darkened to >= 5:1 on every surface of the same theme */
#mmc-root-v1,.mmc-launcher,.mmc-toast,#mmc-root-v1[data-mmc-theme="ribbon"],.mmc-launcher[data-mmc-theme="ribbon"],.mmc-toast[data-mmc-theme="ribbon"]{--mv-muted:#5d5c75}
#mmc-root-v1[data-mmc-theme="rose"],.mmc-launcher[data-mmc-theme="rose"],.mmc-toast[data-mmc-theme="rose"]{--mv-muted:#6f5c62}
#mmc-root-v1[data-mmc-theme="green"],.mmc-launcher[data-mmc-theme="green"],.mmc-toast[data-mmc-theme="green"]{--mv-muted:#56635f}
#mmc-root-v1,.mmc-launcher,.mmc-toast,#mmc-root-v1[data-mmc-theme="ribbon"],#mmc-root-v1[data-mmc-theme="rose"],#mmc-root-v1[data-mmc-theme="green"],.mmc-launcher[data-mmc-theme],.mmc-toast[data-mmc-theme]{--mv-ok:#1a6644}
.mmc-launcher span{font-size:15px}
#mmc-root-v1 .mmc-btn.mmc-sm,#mmc-root-v1 .mmc-btn.mmc-sm span{font-size:15px}
#mmc-root-v1 .mmc-theme-check{font-size:13px}
#mmc-root-v1[data-mmc-theme="green"],.mmc-launcher[data-mmc-theme="green"],.mmc-toast[data-mmc-theme="green"]{--mv-accent:#00796b;--mv-wiki-head:#00796b}
/* tablet widths: seven long tab labels no longer fit at the larger type; use the short labels the original already uses on phones */
@media (min-width:701px) and (max-width:1100px){#mmc-root-v1 .mmc-tab-long{display:none}#mmc-root-v1 .mmc-tab-short{display:inline}#mmc-root-v1 .mmc-tabs{padding:0 6px}#mmc-root-v1 .mmc-tab{padding:0 9px;gap:5px}}
#mmc-root-v1 .mmc-label,#mmc-root-v1 .mmc-sync span{font-size:15px}
#mmc-root-v1 .mmc-detail-empty small,#mmc-root-v1 .mmc-wiki-byline{font-size:13px}
/* draggable launcher (src/launcher-drag.js): keep the original right-edge tab shape, 44px target, and block page scroll while dragging */
.mmc-launcher{touch-action:none;min-width:44px;min-height:44px}
`;
function runOriginal(marinara) {
  (() => {
    const VERSION = "2.1.1";
    const DATA_KEY = "memoryCabinetV1";
    const LEGACY_PROMISE_KEY = "promiseKeeperV1";
    const UI_STORAGE_KEY = "marinara.memoryCabinet.ui.v1";
    const EXT_STORAGE_KEY = "memoryCabinetUiV1";
    const LOREBOOK_TAG = "memory-cabinet-rp";
    const PROMISE_ENTRY_TAG = "memory-cabinet-promises";
    const ANCHOR_ENTRY_TAG = "memory-cabinet-anchors-always";
    const KEYWORD_ENTRY_TAG = "memory-cabinet-anchor-keyword";
    const ELEMENT_HEADER_ENTRY_TAG = "memory-cabinet-element-header";
    const ELEMENT_FACT_ENTRY_TAG = "memory-cabinet-element-facts";
    const ELEMENT_TRIGGER_ENTRY_TAG = "memory-cabinet-element-trigger";
    const BACKUP_ENTRY_TAG = "memory-cabinet-structured-backup";
    const RESTRICTED_ENTRY_TAG = "memory-cabinet-restricted";
    const BOOK_MARKER = "§MEMORY_CABINET_RP_V1§";
    const PROMISE_MARKER = "§MEMORY_CABINET_PROMISES_V1§";
    const ANCHOR_MARKER = "§MEMORY_CABINET_ANCHORS_V1§";
    const KEYWORD_MARKER = "§MEMORY_CABINET_KEYWORD_V1§";
    const ELEMENT_MARKER = "§MEMORY_CABINET_ELEMENT_V1§";
    const ELEMENT_TRIGGER_MARKER = "§MEMORY_CABINET_ELEMENT_TRIGGER_V1§";
    const BACKUP_MARKER = "§MEMORY_CABINET_BACKUP_V1§";
    const RESTRICTED_MARKER = "§MEMORY_CABINET_RESTRICTED_V1§";
    const WIKI_HEADER_ENTRY_TAG = "memory-cabinet-wiki-header";
    const WIKI_ALWAYS_ENTRY_TAG = "memory-cabinet-wiki-always";
    const WIKI_DOC_ENTRY_TAG = "memory-cabinet-wiki-doc";
    const WIKI_TRIGGER_ENTRY_TAG = "memory-cabinet-wiki-trigger";
    const WIKI_MARKER = "§MEMORY_CABINET_WIKI_V1§";
    const WIKI_ALWAYS_MARKER = "§MEMORY_CABINET_WIKI_ALWAYS_V1§";
    const WIKI_TRIGGER_MARKER = "§MEMORY_CABINET_WIKI_TRIGGER_V1§";
    const WIKI_DOC_LIMIT = 400;
    const WIKI_SECTION_BODY_MAX = 8000;
    const WIKI_SECTION_BODY_HARD_MAX = 60000;
    const WIKI_SUMMARY_MAX = 400;
    const WIKI_SECTION_MAX_LEVEL = 3;
    const WIKI_IMAGE_LIMIT = 8;
    const UI_THEMES = [
      { id: "ribbon", label: "리본 라일락", help: "차분한 기본 보라" },
      { id: "rose", label: "스토리 로즈", help: "로즈 먹색의 감성" },
      { id: "green", label: "아카이브 그린", help: "예전 위키 그린을 보관함 전체로" },
      { id: "marinara", label: "루미버스 테마 따르기", help: "호스트 색에서 계산 · 밝음/어두움 자동" }
    ];
    const UI_THEME_IDS = UI_THEMES.map((row) => row.id);
    const TAB_IDS = ["overview", "promise", "thread", "anchor", "episode", "element", "wiki"];
    const MEMORY_NAG_AGENT_ID = "memory-nag";
    const LONG_TERM_MEMORY_AGENT_ID = "long-term-memory";
    const LOREBOOK_KEEPER_AGENT_ID = "lorebook-keeper";
    const AM_SCENE_SOURCE = "advanced-memory-scene";
    const WIKI_SECTION_LIMIT = 16;
    const WIKI_CANDIDATE_LIMIT = 8;
    const WIKI_CATEGORY_LABEL = {
      character: "등장인물",
      relationship: "관계",
      place: "장소",
      object: "물건",
      event: "사건·사고",
      organization: "조직·세력",
      lore: "세계관·규칙",
      misc: "기타"
    };
    const WIKI_SOURCE_KIND_LABEL = { element: "요소 기억", anchor: "기억 앵커", promise: "약속", summary: "요약", message: "대화 원문", manual: "직접 입력" };
    const DEFAULT_WIKI_DRAFT_PROMPT = `You are an archivist writing a reference wiki for an ongoing roleplay.
You do not invent facts. You only organize and narrate what the supplied records already state.

Write for a human reader who wants to look something up later, not for the model.
Each document covers exactly one subject: one person, one relationship, one place, one object, one incident, one organization, or one world rule.
Prefer a short "한눈에 보는 개요" of one or two sentences, then sections with concrete detail.
Use Korean unless the records are clearly in another language.
Attach a citation marker such as [1] or [2] to sentences that come from a specific supplied record, using the numbers shown in the source list.
Leave a sentence uncited only when it is a neutral connecting sentence.
Do not create a document when the records contain nothing durable about that subject.`;
    const DEFAULT_WIKI_UPDATE_PROMPT = `You are revising an existing wiki document using newly recorded memories.
Keep the document's existing voice, structure, and section headings.
Change only what the new records actually contradict or add. Do not rewrite untouched paragraphs.
Never propose a change to a section marked USER-LOCKED. If a new record conflicts with a locked section, report it in "conflicts" instead.
Do not invent facts that the supplied records do not state.
Return the full new body for each section you want to change, not a partial diff.`;
    const DEFAULT_WIKI_INJECTION_PROMPT = `The following wiki documents are the established reference for this story's world, people, and places.
Treat them as already-known background, not as new information to announce.
Stay consistent with them when they are relevant, and do not recite or quote the documents themselves.
When a wiki document and an older recalled scene disagree, the wiki document is the later, authoritative state.`;
    const ROOT_ID = "mmc-root-v1";
    const LAUNCHER_ID = "mmc-launcher-v1";
    const TOAST_ID = "mmc-toast-v1";
    const API_TIMEOUT_MS = 20000;
    const MODEL_TIMEOUT_MS = 180000;
    const ELEMENT_CHUNK_CHARS = 42000;
    const ELEMENT_CANDIDATE_LIMIT = 40;
    const SUMMARY_UPDATE_MODE_LABEL = { notify_only: "알림만", notify_model: "알림 + 모델 정리 버튼", auto_review: "자동 분석 후 승인 대기", auto_apply: "완전 자동 적용 (실험적)" };
    const DEFAULT_ELEMENT_EXTRACTION_PROMPT = `You maintain a compact continuity ledger for an ongoing roleplay. This is not an event summary.
Record only per-entity facts that must stay consistent later.

Test every fact: if this entity reappears 50 turns from now and the writer does not know this fact, would the world contradict itself?

Record durable object attributes, condition, current location, ownership, agreed use, notable usage history, lasting place features, and lasting preferences or possessions.
Do not record one-off actions, scene decoration, ordinary use, plot-event summaries, emotional beats, or facts already obvious from the character/persona description.
Write short labelled fragments, not narrative sentences.
Good: "노란색" / "상태: 고장" / "위치: 작업실" / "U 선호: 소다"
Bad: "이준이가 컴퓨터를 고쳐서 다시 책상 위에 올려두었다"

currentFacts = what is true now. historyFacts = what was true before, or a durable past fact about the entity.
When a current fact is replaced, put the new value in currentFacts and set replacesFactId to the existing fact it supersedes.
Returning zero entities is correct when nothing durable appeared.`;
    const DEFAULT_ELEMENT_INJECTION_PROMPT = `The following element memories contain persistent world-state facts relevant to the current context.
Treat them as already-established continuity, not as new information to announce.
Preserve current states, possessions, locations, preferences, and object details naturally when relevant.
Do not force them into the scene, recite the list, or mention consulting memory.
When current and historical facts differ, current facts take precedence.`;
    const LANGUAGE_CONTRACT = [
      "Language rule (fixed by the extension, do not override):",
      "- Write every canonical field in the SAME language as the supplied source. Never translate the source into Korean.",
      "- When the source language is not Korean, additionally return the matching *Ko field with a short Korean rendering for display only.",
      "- When the source is already Korean, omit every *Ko field.",
      "- The *Ko fields are for the reader's screen. They are never sent back into the roleplay."
    ].join(`
`);
    const KEYWORD_LANGUAGE_CONTRACT = [
      "Keyword-anchor rule (fixed by the extension, do not override):",
      "- When an AI-created or AI-updated anchor uses activation=keyword and the source language is not Korean, keywords MUST contain useful source-language terms AND their corresponding Korean terms in the same keywords array.",
      "- Example: hospital, surgery, 병원, 수술.",
      "- Do not add forced translations for a Korean-language source, and do not alter user-authored manual keywords."
    ].join(`
`);
    const SCOPE_CONTRACT = [
      "Knowledge-scope rule (fixed by the extension, do not override):",
      "- Source text may contain [KNOWN ONLY BY: names] ... [/KNOWN ONLY BY] sections or a [SCENE AUDIENCE ...] line. Those facts are known only to the listed characters.",
      '- For every record, return knownBy: an array of the exact character names who know it, or ["all"] when every character in the roleplay knows it.',
      "- Never merge a restricted fact into a record known by more characters. Keep restricted facts in their own records.",
      "- Mere presence or being mentioned does not grant knowledge of private thoughts, secrets or off-screen events.",
      "- An existing record marked knownBy keeps that restriction unless the source clearly shows the others learned it."
    ].join(`
`);
    const ADVANCED_MEMORY_PRIORITY_RULE = "When these current facts conflict with an older scene or summary recalled by Advanced Memory, treat these current facts as the latest authoritative state.";
    const DEFAULT_REVIEW_PROMPT = [
      "Compare newly created roleplay summaries with the current promise and memory-anchor records.",
      "Classify only durable information that will matter in later roleplay continuity.",
      "PROMISE means an explicit agreed future action, plan, appointment, duty, or commitment. Do not convert wishes, emotions, or guesses into promises.",
      "MEMORY ANCHOR means a relationship change, lasting current state, unresolved ongoing event, stable preference, canon fact, or explicit caution whose loss would materially break continuity.",
      "Prefer updating an existing record when the new summary supersedes it. Do not keep contradictory old and new states active at the same time.",
      "Mark a promise complete only when the source clearly says it was fulfilled. Archive an anchor only when the source clearly makes the old state obsolete.",
      "For anchors, assign lifespan=permanent for durable facts, current_state for temporary ongoing states, and until_event for unresolved threads that should retire when resolved.",
      "Write titles and contents in the same language as the source. Do not translate an English roleplay into Korean."
    ].join(`
`);
    const PRIORITY_WEIGHT = { high: 0, normal: 1, low: 2 };
    const PRIORITY_LABEL = { high: "중요", normal: "보통", low: "낮음" };
    const PROMISE_STATUS_LABEL = { active: "진행 중", hold: "보류", done: "완료", cancelled: "취소" };
    const ANCHOR_CATEGORY_LABEL = {
      relationship: "관계",
      state: "현재 상태",
      event: "진행 사건",
      preference: "성향·취향",
      setting: "설정·사실",
      caution: "주의"
    };
    const ANCHOR_LIFESPAN_LABEL = { permanent: "영구", current_state: "현재 상태", until_event: "사건 종료까지" };
    const REVIEW_ACTION_LABEL = { add: "추가", update: "갱신", keep: "유지", complete: "완료", archive: "보관" };
    const REVIEW_TYPE_LABEL = { promise: "약속", anchor: "앵커" };
    const iconSvg = (body, strokeWidth = 1.8) => `<svg class="mmc-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
    const SVG = {
      memory: iconSvg('<rect x="4.5" y="3.5" width="15" height="17" rx="2.5"/><path d="M9 3.5v7l3-1.9 3 1.9v-7"/><path d="M8 14.5h8M8 17.5h5"/>'),
      close: iconSvg('<path d="M6 6l12 12M18 6 6 18"/>', 2),
      help: iconSvg('<circle cx="12" cy="12" r="9"/><path d="M9.8 9.4a2.5 2.5 0 0 1 4.8.9c0 1.9-2.6 2.2-2.6 4"/><path d="M12 17.3h.01"/>', 1.9),
      gear: iconSvg('<path d="M4 7h6M14 7h6M4 17h10M18 17h2"/><circle cx="12" cy="7" r="2"/><circle cx="16" cy="17" r="2"/>'),
      plus: iconSvg('<path d="M12 5v14M5 12h14"/>', 2),
      spark: iconSvg('<path d="M12 3l1.2 4L17 9l-3.8 1.8L12 15l-1.2-4.2L7 9l3.8-2L12 3Z"/><path d="M5 15.5l.7 2.2L8 19l-2.3 1.3L5 22.5l-.7-2.2L2 19l2.3-1.3L5 15.5Z"/>'),
      message: iconSvg('<path d="M4 5h16v12H9l-5 4V5Z"/><path d="M8 9h8M8 13h5"/>'),
      summary: iconSvg('<path d="M6 3.5h8l4 4V20.5H6Z"/><path d="M14 3.5v4h4M9 11h6M9 14.5h6M9 18h4"/>'),
      pin: iconSvg('<path d="M14.5 4.5l5 5-2.5 1-4 4-.8 4.7-2.4-2.4-2.4-2.4 4.7-.8 4-4 1-2.5-5-5"/><path d="M4.5 19.5l5-5"/>'),
      edit: iconSvg('<path d="M5 19l3.8-.8L18.5 8.5 15.5 5.5 5.8 15.2 5 19Z"/><path d="M13.8 7.2l3 3"/>'),
      trash: iconSvg('<path d="M5 7h14M9 7V4.5h6V7M7 7l1 13h8l1-13M10 10.5v6M14 10.5v6"/>'),
      sync: iconSvg('<path d="M19 8V4.5l-2 2A7 7 0 0 0 5.5 9"/><path d="M5 16v3.5l2-2A7 7 0 0 0 18.5 15"/>'),
      overview: iconSvg('<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>'),
      promise: iconSvg('<path d="M4 6.5l1.5 1.5L8.5 5"/><path d="M4 12.5l1.5 1.5 3-3"/><path d="M4.5 18.5h3"/><path d="M11.5 6.5h8.5M11.5 12.5h8.5M11.5 18.5h8.5"/>'),
      anchor: iconSvg('<circle cx="12" cy="5.5" r="2"/><path d="M12 7.5V20"/><path d="M8.5 11h7"/><path d="M5 13.5a7 7 0 0 0 14 0"/>'),
      element: iconSvg('<rect x="4" y="5" width="16" height="15" rx="2"/><path d="M4 10h16"/><path d="M10 7.5h4"/><path d="M8.5 14h7M8.5 17h4.5"/>'),
      wiki: iconSvg('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.5 2.4 3.6 5.2 3.6 8.5s-1.1 6.1-3.6 8.5c-2.5-2.4-3.6-5.2-3.6-8.5s1.1-6.1 3.6-8.5Z"/>'),
      book: iconSvg('<path d="M5 4.5h11.5a2 2 0 0 1 2 2V20H7a2 2 0 0 1-2-2V4.5Z"/><path d="M5 18a2 2 0 0 1 2-2h11.5"/>'),
      inbox: iconSvg('<path d="M4 13.5l2.2-7.2a1.5 1.5 0 0 1 1.4-1.1h8.8a1.5 1.5 0 0 1 1.4 1.1l2.2 7.2V18a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18Z"/><path d="M4 13.5h4.5l1.2 2h4.6l1.2-2H20"/>'),
      info: iconSvg('<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><path d="M12 7.8h.01"/>', 2),
      lock: iconSvg('<rect x="5.5" y="10.5" width="13" height="9.5" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>'),
      back: iconSvg('<path d="M14.5 6l-6 6 6 6"/>', 2),
      chevron: iconSvg('<path d="M9.5 6l6 6-6 6"/>', 2),
      more: iconSvg('<circle cx="6" cy="12" r=".8"/><circle cx="12" cy="12" r=".8"/><circle cx="18" cy="12" r=".8"/>', 2.4),
      eye: iconSvg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.8"/>'),
      warn: iconSvg('<path d="M12 4l9 16H3L12 4Z"/><path d="M12 10v4.5"/><path d="M12 17.5h.01"/>', 1.9),
      flow: iconSvg('<circle cx="6" cy="6.5" r="2"/><circle cx="18" cy="12" r="2"/><circle cx="6" cy="17.5" r="2"/><path d="M8 6.5h3.5a3 3 0 0 1 3 3V12M8 17.5h3.5a3 3 0 0 0 3-3V12h1.5"/>'),
      scene: iconSvg('<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M3.5 9.5h17"/><path d="M7.5 5.5l2 4M12 5.5l2 4M16.5 5.5l2 4"/><path d="M8 13.5h8M8 16h5"/>'),
      search: iconSvg('<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>', 1.9)
    };
    let state = {
      chats: [],
      connections: [],
      selectedChatId: "",
      activeTab: "overview",
      filter: "active",
      promiseSelectedId: "",
      promisePane: "list",
      settingsTab: "screen",
      elementSearch: "",
      elementTestText: "",
      elementDraft: null,
      elementCandidates: [],
      elementCandidateSelected: new Set,
      elementExtractInfo: null,
      elementCandidateOverflow: 0,
      elementExtractMode: "recent",
      wikiSelectedId: "",
      wikiSearch: "",
      wikiCategoryFilter: "all",
      wikiDraft: null,
      wikiCandidates: [],
      wikiCandidateSelected: new Set,
      wikiDraftTopic: "",
      wikiSourceRows: [],
      wikiSourceSelected: new Set,
      wikiProposalDocId: "",
      wikiProposalSelected: new Set,
      wikiHistory: [],
      koDisplay: "auto",
      agentNotice: { checked: false, memoryNag: "unknown", longTermMemory: "unknown", lorebookKeeper: "unknown", keeperTargetLorebookId: "" },
      chatCharacters: [],
      amSceneRows: [],
      amSceneError: "",
      sceneSettings: null,
      pendingAmRows: [],
      amChatId: "",
      agentNoticeDismissed: {},
      elementExtractTurns: 20,
      elementRangeStart: 1,
      elementRangeEnd: 20,
      expanded: { promise: false, anchor: false },
      currentChat: null,
      currentData: null,
      ownership: { status: "unknown", reason: "", ownerChatId: "", evidence: "", backup: null, discoveryChecked: false },
      quarantinedData: null,
      ownershipDetachLorebookIds: [],
      draft: null,
      layer: null,
      helpTab: "usage",
      sourceMode: "messages",
      sourceRows: [],
      sourceSelected: new Set,
      sourceTarget: "anchor",
      modelConnectionId: "",
      uiFontSize: "normal",
      uiThemeMode: "ribbon",
      reviewPrompt: DEFAULT_REVIEW_PROMPT,
      reviewExtraInstruction: "",
      summaryKnownByChat: {},
      summaryAutoAttemptByChat: {},
      summaryUpdateMode: "notify_model",
      autoReviewBusy: false,
      pendingSummaryRows: [],
      summaryCheckBusy: false,
      passiveFetchCleanup: null,
      candidates: [],
      candidateSelected: new Set,
      reviewCandidates: [],
      reviewSelected: new Set,
      reviewSourceRows: [],
      evidenceView: null,
      healthCandidates: [],
      healthSelected: new Set,
      rawRecovery: null,
      busy: false,
      busyText: "",
      busyStartedAt: 0,
      busyTimer: null,
      syncing: false,
      syncAgain: false,
      hiddenSkipped: {},
      reviewEpisodes: [],
      reviewEpisodeSelected: new Set,
      candEpisodes: [],
      candEpisodeSelected: new Set,
      candBatch: null,
      episodeDraft: null,
      episodeDraftExtraFacts: 0,
      reviewThreads: [],
      reviewThreadSelected: new Set,
      candThreads: [],
      candThreadSelected: new Set,
      threadDraft: null,
      branchSplitBusy: false,
      amAllFingerprints: null,
      staleRecords: [],
      sourceWatchByChat: {},
      syncPromise: null,
      actionLock: false
    };
    const cleanupFns = [];
    const on = (target, type, handler, options) => {
      target?.addEventListener?.(type, handler, options);
      cleanupFns.push(() => target?.removeEventListener?.(type, handler, options));
    };
    function isRecord(value) {
      return !!value && typeof value === "object" && !Array.isArray(value);
    }
    function parseRecord(value) {
      if (isRecord(value))
        return value;
      if (typeof value === "string" && value.trim()) {
        try {
          const parsed = JSON.parse(value);
          return isRecord(parsed) ? parsed : {};
        } catch {}
      }
      return {};
    }
    function safeArray(value) {
      return Array.isArray(value) ? value : [];
    }
    function esc(value) {
      return String(value ?? "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]);
    }
    function uid(prefix = "mmc") {
      if (globalThis.crypto?.randomUUID)
        return `${prefix}_${crypto.randomUUID()}`;
      return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
    }
    function nowIso() {
      return new Date().toISOString();
    }
    function truncate(value, max = 180) {
      const text = String(value || "").trim();
      return text.length > max ? `${text.slice(0, max - 1)}…` : text;
    }
    function normalizeApiPath(path) {
      return String(path || "").replace(/^\/?api\//, "").replace(/^\/+/, "");
    }
    function extractArray(payload, keys = ["items", "results", "chats", "connections", "messages", "entries", "lorebooks"]) {
      if (Array.isArray(payload))
        return payload;
      for (const key of keys)
        if (Array.isArray(payload?.[key]))
          return payload[key];
      if (Array.isArray(payload?.data))
        return payload.data;
      for (const key of keys)
        if (Array.isArray(payload?.data?.[key]))
          return payload.data[key];
      return [];
    }
    function chatMode(chat) {
      return String(chat?.mode || chat?.chatMode || chat?.type || parseRecord(chat?.metadata).mode || "").toLowerCase();
    }
    function isRpChat(chat) {
      const mode = chatMode(chat);
      return ["roleplay", "role_play", "rp", "visual_novel", "visual-novel", "vn"].includes(mode);
    }
    function hostActiveChatId() {
      try {
        return String(localStorage.getItem("marinara-active-chat-id") || "");
      } catch {
        return "";
      }
    }
    function chatLabel(chat) {
      return String(chat?.name || chat?.title || chat?.displayName || "이름 없는 RP");
    }
    function chatSelectLabel(chat) {
      const name = chatLabel(chat);
      const branchName = String(parseRecord(chat?.metadata).branchName || "").trim();
      return branchName ? `${name} · ${branchName}` : name;
    }
    function chatRecentTime(chat) {
      const metadata = parseRecord(chat?.metadata);
      const value = chat?.lastMessageAt || metadata.lastMessageAt || chat?.updatedAt || metadata.updatedAt || "";
      if (typeof value === "number" && Number.isFinite(value))
        return value < 100000000000 ? value * 1000 : value;
      const time = Date.parse(value);
      return Number.isFinite(time) ? time : 0;
    }
    function roleLabel(role) {
      return role === "assistant" ? "NPC" : role === "user" ? "U" : String(role || "기록");
    }
    function sourceDate(value) {
      if (!value)
        return "";
      const d = new Date(value);
      if (Number.isNaN(d.getTime()))
        return "";
      return new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
    }
    function estimateTokens(text) {
      const s = String(text || "");
      let units = 0;
      for (let i = 0;i < s.length; i++) {
        const code = s.codePointAt(i);
        if (code > 65535)
          i += 1;
        const dense = code >= 4352 && code <= 4607 || code >= 12592 && code <= 12687 || code >= 44032 && code <= 55215 || code >= 12352 && code <= 12543 || code >= 13312 && code <= 40959 || code > 65535;
        units += dense ? 4 : 1;
      }
      return Math.ceil(units / 4);
    }
    function textHash(value) {
      const text = String(value || "");
      let hash = 2166136261;
      for (let i = 0;i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(36);
    }
    function summaryRowsFromMetadata(metadata) {
      const meta = parseRecord(metadata);
      let rows = safeArray(meta.summaryEntries).filter((row) => row && row.enabled !== false && String(row.content || "").trim());
      if (!rows.length && String(meta.summary || "").trim()) {
        rows = [{ id: "legacy-summary", title: "현재 통합 요약", content: String(meta.summary), origin: "legacy", enabled: true, updatedAt: meta.updatedAt || "" }];
      }
      return rows.slice().sort((a, b) => String(a.createdAt || a.updatedAt || "").localeCompare(String(b.createdAt || b.updatedAt || "")));
    }
    function messageSourceFingerprint(row) {
      return textHash(`${String(row?.role || "")}|${Number(row?.activeSwipeIndex) || 0}|${String(row?.createdAt || "")}|${String(row?.content || "")}`);
    }
    function sourceFingerprintsForRows(rows, mode = "summaries") {
      const out = {};
      for (const row of safeArray(rows)) {
        if (!isRecord(row))
          continue;
        if (row.sourceKind === AM_SCENE_SOURCE) {
          if (row.sourceFingerprint)
            out[`am:${row.amRecordId}`] = String(row.sourceFingerprint);
          continue;
        }
        const id = String(row.id || "");
        if (!id || id === "legacy-summary")
          continue;
        if (mode === "messages")
          out[`message:${id}`] = messageSourceFingerprint(row);
        else
          out[`summary:${id}`] = textHash(row.content || "");
      }
      return out;
    }
    function summaryRowText(row) {
      if (row?.sourceKind === AM_SCENE_SOURCE) {
        const audience = sourceRowAudience(row);
        const head = [`[장면 요약 · ${row.title || "장면"}${row.timeline ? ` · ${row.timeline}` : ""}${row.startIndex ? ` · #${row.startIndex}–${row.endIndex}` : ""}]`];
        if (audience.audienceIds.length)
          head.push(`[SCENE AUDIENCE — ONLY THESE CHARACTERS KNOW THIS SCENE: ${audience.audienceIds.map(characterName).join(", ")}]`);
        return `${head.join(`
`)}
${labelCharacterConditions(row.content)}`;
      }
      const content = String(row?.content || "");
      return `[${row?.title || "요약"}]
${hasCharacterConditions(content) ? labelCharacterConditions(content) : content}`;
    }
    function summarySignature(row) {
      if (row?.sourceKind === AM_SCENE_SOURCE)
        return `am:${String(row.amRecordId || "")}|${String(row.sourceFingerprint || "")}`;
      return `${String(row?.id || "summary")}|${String(row?.updatedAt || row?.createdAt || "")}|${textHash(row?.content || "")}`;
    }
    function summaryBatchKey(rows = state.pendingSummaryRows) {
      return safeArray(rows).map(summarySignature).sort().join("||");
    }
    function hasUnsavedCandidateLayer() {
      if (state.layer === "candidates")
        return state.candidates.length > 0 || state.candEpisodes.length > 0 || state.candThreads.length > 0;
      if (state.layer === "review-candidates")
        return state.reviewSourceRows.length > 0;
      if (state.layer === "health-candidates")
        return state.healthCandidates.length > 0;
      if (state.layer === "element-candidates")
        return state.elementCandidates.length > 0;
      if (state.layer === "wiki-candidates")
        return state.wikiCandidates.length > 0;
      if (state.layer === "wiki-editor")
        return !!state.wikiDraft;
      if (state.layer === "raw-repair")
        return !!state.rawRecovery?.text;
      return false;
    }
    function candidateCloseMessage() {
      if (state.layer === "review-candidates")
        return "약속·앵커 갱신 후보는 이 RP에 보관됩니다. 나중에 다시 확인할 수 있습니다.";
      if (state.layer === "health-candidates")
        return `아직 적용하지 않은 기억 건강검진 제안이 있습니다.
정말 닫을까요? 닫으면 이번 모델 결과는 사라집니다.`;
      if (state.layer === "element-candidates")
        return `아직 저장하지 않은 요소 기억 후보가 있습니다.
정말 닫을까요? 닫으면 이번 모델 결과는 사라집니다.`;
      if (state.layer === "wiki-candidates")
        return `아직 저장하지 않은 위키 초안이 있습니다.
정말 닫을까요? 닫으면 이번 모델 결과는 사라집니다.`;
      if (state.layer === "wiki-editor")
        return `편집 중인 위키 문서가 있습니다.
정말 닫을까요? 저장하지 않은 수정은 사라집니다.`;
      if (state.layer === "raw-repair")
        return `아직 복구하지 않은 모델 원문 응답이 있습니다.
정말 닫을까요? 닫으면 이번 응답 원문은 사라집니다.`;
      return `아직 저장하지 않은 모델 후보가 있습니다.
정말 닫을까요? 닫으면 이번 모델 결과는 사라집니다.`;
    }
    function clearLayerDrafts(layer = state.layer) {
      if (layer === "candidates") {
        state.candidates = [];
        state.candidateSelected.clear();
        state.candEpisodes = [];
        state.candEpisodeSelected = new Set;
        state.candThreads = [];
        state.candThreadSelected = new Set;
        state.candBatch = null;
      }
      if (layer === "episode-editor") {
        state.episodeDraft = null;
        state.episodeDraftExtraFacts = 0;
      }
      if (layer === "thread-editor")
        state.threadDraft = null;
      if (layer === "review-candidates")
        return;
      if (layer === "health-candidates") {
        state.healthCandidates = [];
        state.healthSelected.clear();
      }
      if (layer === "element-candidates") {
        state.elementCandidates = [];
        state.elementCandidateSelected.clear();
        state.elementExtractInfo = null;
        state.elementCandidateOverflow = 0;
      }
      if (layer === "element-editor")
        state.elementDraft = null;
      if (layer === "wiki-candidates") {
        state.wikiCandidates = [];
        state.wikiCandidateSelected.clear();
      }
      if (layer === "wiki-editor")
        state.wikiDraft = null;
      if (layer === "wiki-draft") {
        state.wikiSourceRows = [];
        state.wikiSourceSelected.clear();
      }
      if (layer === "wiki-proposal") {
        state.wikiProposalDocId = "";
        state.wikiProposalSelected.clear();
      }
      if (layer === "evidence")
        state.evidenceView = null;
      if (layer === "raw-repair")
        state.rawRecovery = null;
      if (layer === "editor")
        state.draft = null;
    }
    function requestCloseLayer({ force = false } = {}) {
      if (!state.layer)
        return true;
      if (!force && state.layer !== "review-candidates" && hasUnsavedCandidateLayer() && !window.confirm(candidateCloseMessage()))
        return false;
      const closing = state.layer;
      clearLayerDrafts(closing);
      state.layer = null;
      state.draft = null;
      render();
      return true;
    }
    function selectionTotals(kind) {
      if (kind === "review")
        return { selected: state.reviewSelected.size + state.reviewEpisodeSelected.size + state.reviewThreadSelected.size, total: state.reviewCandidates.filter((item) => item.action !== "keep").length + state.reviewEpisodes.length + state.reviewThreads.length };
      if (kind === "health")
        return { selected: state.healthSelected.size, total: state.healthCandidates.filter((item) => item.action !== "keep").length };
      return { selected: state.candidateSelected.size + state.candEpisodeSelected.size + state.candThreadSelected.size, total: state.candidates.length + state.candEpisodes.length + state.candThreads.length };
    }
    function selectionCountText(kind) {
      const { selected, total } = selectionTotals(kind);
      return `선택됨 ${selected}/${total}개`;
    }
    function reviewItemConflict(item) {
      const existing = item?.targetId ? safeArray(state.currentData?.items).find((row) => row.id === item.targetId) : null;
      return !!(existing && item.baseUpdatedAt && existing.updatedAt !== item.baseUpdatedAt);
    }
    function selectAllSafe(kind) {
      if (kind === "review") {
        state.reviewSelected = new Set(state.reviewCandidates.map((item, i) => item.action === "keep" || reviewItemConflict(item) || scopeBlocksApply(item) || item.duplicateOf ? null : String(i)).filter(Boolean));
        state.reviewEpisodeSelected = preselectEpisodes(state.reviewEpisodes);
        state.reviewThreadSelected = preselectThreads(state.reviewThreads);
      } else if (kind === "candidate") {
        state.candidateSelected = new Set(state.candidates.map((item, i) => scopeBlocksApply(item) || item.duplicateOf ? null : String(i)).filter(Boolean));
        state.candEpisodeSelected = preselectEpisodes(state.candEpisodes);
        state.candThreadSelected = preselectThreads(state.candThreads);
      } else if (kind === "health") {
        state.healthSelected = new Set(state.healthCandidates.map((item, i) => item.action === "keep" || reviewItemConflict(item) ? null : String(i)).filter(Boolean));
      }
      const { selected, total } = selectionTotals(kind);
      return { selected, skipped: Math.max(0, total - selected) };
    }
    function clearSelection(kind) {
      if (kind === "review") {
        state.reviewSelected = new Set;
        state.reviewEpisodeSelected = new Set;
        state.reviewThreadSelected = new Set;
      } else if (kind === "candidate") {
        state.candidateSelected = new Set;
        state.candEpisodeSelected = new Set;
        state.candThreadSelected = new Set;
      } else if (kind === "health")
        state.healthSelected = new Set;
    }
    function bulkToolbar(kind, note) {
      const clearLabel = kind === "review" ? "전체 보류" : "전체 해제";
      const clearTitle = kind === "review" ? "선택만 풀어요. 후보는 지우지 않고 승인 대기에 그대로 남아요." : "선택만 풀어요. 후보는 그대로 남아요.";
      return `<div class="mmc-candidate-toolbar mmc-bulk-toolbar"><div class="mmc-bulk-count"><b data-selected-count="${kind}">${selectionCountText(kind)}</b><small>${note}</small></div><div class="mmc-bulk-actions"><button type="button" class="mmc-btn mmc-sm" data-action="bulk-select" data-bulk="${kind}" title="충돌·공개 범위 확인·중복 의심 후보는 빼고 고릅니다">전체 선택</button><button type="button" class="mmc-btn mmc-sm" data-action="bulk-clear" data-bulk="${kind}" title="${clearTitle}">${clearLabel}</button></div></div>`;
    }
    function updateCandidateSelectionDom(kind, input) {
      const row = input?.closest?.(".mmc-candidate");
      const list = row?.closest?.(".mmc-candidate-list");
      if (!row || !list)
        return;
      row.classList.toggle("is-selected", !!input.checked);
      if (input.checked) {
        list.prepend(row);
      } else {
        const selectedRows = Array.from(list.querySelectorAll(".mmc-candidate.is-selected"));
        const lastSelected = selectedRows[selectedRows.length - 1];
        if (lastSelected)
          lastSelected.after(row);
        else
          list.append(row);
      }
      const { selected } = selectionTotals(kind);
      const buttonSelector = kind === "review" ? '[data-action="apply-review"]' : kind === "health" ? '[data-action="apply-health"]' : '[data-action="save-candidates"]';
      const button = document.querySelector(buttonSelector);
      if (button) {
        button.disabled = selected <= 0;
        button.textContent = kind === "candidate" ? `선택 ${selected}개 추가` : `선택 ${selected}개 적용`;
      }
      const count = document.querySelector(`[data-selected-count="${kind}"]`);
      if (count)
        count.textContent = selectionCountText(kind);
    }
    async function api(path, options = {}) {
      const clean = normalizeApiPath(path);
      const method = String(options.method || "GET").toUpperCase();
      const headers = new Headers(options.headers || {});
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method))
        headers.set("x-marinara-csrf", "1");
      const body = options.body && typeof options.body !== "string" && !(options.body instanceof FormData) ? JSON.stringify(options.body) : options.body;
      if (body && !(options.body instanceof FormData) && !headers.has("Content-Type"))
        headers.set("Content-Type", "application/json");
      const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, Number(options.timeoutMs)) : API_TIMEOUT_MS;
      const externalSignal = options.signal;
      const controller = new AbortController;
      let timer = null;
      let timedOut = false;
      const abortFromOutside = () => controller.abort();
      if (externalSignal?.aborted)
        controller.abort();
      else
        externalSignal?.addEventListener?.("abort", abortFromOutside, { once: true });
      if (timeoutMs > 0)
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
      try {
        const response = await fetch(`/api/${clean}`, {
          method,
          headers,
          body,
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal
        });
        if (!response.ok) {
          let detail = "";
          try {
            detail = await response.text();
          } catch {}
          const error = new Error(`${response.status} ${response.statusText}${detail ? ` · ${truncate(detail, 240)}` : ""}`);
          error.status = response.status;
          throw error;
        }
        if (response.status === 204)
          return null;
        const type = response.headers.get("content-type") || "";
        return type.includes("json") ? response.json() : response.text();
      } catch (error) {
        const answeredWrite = Number.isFinite(error?.status) && method !== "GET";
        if (!answeredWrite && !timedOut && !externalSignal?.aborted && typeof marinara !== "undefined" && typeof marinara?.apiFetch === "function") {
          try {
            const result = await marinara.apiFetch(clean, { method, headers, body });
            if (result && typeof result.ok === "boolean") {
              if (!result.ok)
                throw error;
              if (result.status === 204)
                return null;
              const type = result.headers?.get?.("content-type") || "";
              return type.includes("json") ? result.json() : result.text();
            }
            return result;
          } catch {}
        }
        if (timedOut)
          throw new Error(`요청이 ${Math.ceil(timeoutMs / 1000)}초를 넘겨 중단됐습니다.`);
        if (externalSignal?.aborted || error?.name === "AbortError")
          throw new Error("요청을 취소했습니다.");
        throw error;
      } finally {
        if (timer)
          clearTimeout(timer);
        externalSignal?.removeEventListener?.("abort", abortFromOutside);
      }
    }
    function defaultData() {
      return {
        version: 1,
        ownerChatId: "",
        enabled: true,
        items: [],
        maxPromises: 8,
        maxAnchors: 10,
        anchorBudgetChars: 2400,
        lorebookId: "",
        promiseEntryId: "",
        anchorEntryId: "",
        backupEntryId: "",
        keywordEntryIds: {},
        elementMemory: {
          schemaVersion: 1,
          originChatId: "",
          entities: [],
          connectionId: "",
          extractionPrompt: "",
          injectionPrompt: "",
          injectionEnabled: false,
          extractTurns: 20,
          headerEntryId: "",
          entityEntryIds: {}
        },
        wiki: {
          schemaVersion: 1,
          originChatId: "",
          docs: [],
          connectionId: "",
          draftPrompt: "",
          updatePrompt: "",
          injectionPrompt: "",
          injectionEnabled: false,
          alwaysBudgetChars: 1200,
          proposals: [],
          headerEntryId: "",
          alwaysEntryId: "",
          docEntryIds: {}
        },
        pendingReview: null,
        lastAutoReviewUndo: null,
        lastSyncAt: "",
        lastSyncError: "",
        legacyImportedAt: "",
        updatedAt: ""
      };
    }
    function normalizeKnownBy(value) {
      const out = [];
      for (const raw of safeArray(value)) {
        const id = String(raw || "").trim().slice(0, 120);
        if (id && !out.includes(id))
          out.push(id);
        if (out.length >= 24)
          break;
      }
      return out;
    }
    function normalizeSourceFingerprints(value) {
      const raw = parseRecord(value);
      const out = {};
      for (const [key, fp] of Object.entries(raw).slice(0, 48)) {
        const k = String(key || "").slice(0, 160);
        const v = String(fp || "").slice(0, 200);
        if (k && v)
          out[k] = v;
      }
      return out;
    }
    function optionalScopeFields(item) {
      const knownBy = normalizeKnownBy(item.knownBy);
      const fps = normalizeSourceFingerprints(item.sourceFingerprints);
      const candidateId = String(item.sourceCandidateId || "").slice(0, 120);
      return { ...knownBy.length ? { knownBy } : {}, ...Object.keys(fps).length ? { sourceFingerprints: fps } : {}, ...candidateId ? { sourceCandidateId: candidateId } : {} };
    }
    function isRestrictedItem(item) {
      return normalizeKnownBy(item?.knownBy).length > 0;
    }
    function normalizePromise(item = {}) {
      return {
        id: String(item.id || uid("promise")),
        type: "promise",
        title: String(item.title || "새 약속"),
        content: String(item.content || item.note || item.quote || ""),
        titleKo: normalizeKoText(item.titleKo, item.title, 200),
        contentKo: normalizeKoText(item.contentKo, item.content, 4000),
        status: ["active", "hold", "done", "cancelled"].includes(item.status) ? item.status : "active",
        priority: ["high", "normal", "low"].includes(item.priority) ? item.priority : "normal",
        scheduleText: String(item.scheduleText || ""),
        sourceType: String(item.sourceType || "manual"),
        sourceIds: safeArray(item.sourceIds || (item.sourceMessageId ? [item.sourceMessageId] : [])).map(String),
        sourceQuote: String(item.sourceQuote || item.quote || ""),
        createdAt: String(item.createdAt || nowIso()),
        updatedAt: String(item.updatedAt || item.createdAt || nowIso()),
        ...optionalScopeFields(item)
      };
    }
    function normalizeAnchor(item = {}) {
      const activation = item.activation === "keyword" ? "keyword" : "always";
      return {
        id: String(item.id || uid("anchor")),
        type: "anchor",
        title: String(item.title || "새 기억 앵커"),
        content: String(item.content || item.note || item.quote || ""),
        titleKo: normalizeKoText(item.titleKo, item.title, 200),
        contentKo: normalizeKoText(item.contentKo, item.content, 4000),
        category: Object.prototype.hasOwnProperty.call(ANCHOR_CATEGORY_LABEL, item.category) ? item.category : "setting",
        priority: ["high", "normal", "low"].includes(item.priority) ? item.priority : "normal",
        active: item.active !== false,
        archived: item.archived === true,
        activation,
        keywords: safeArray(item.keywords).map((x) => String(x).trim()).filter(Boolean).slice(0, 24),
        lifespan: Object.prototype.hasOwnProperty.call(ANCHOR_LIFESPAN_LABEL, item.lifespan) ? item.lifespan : "permanent",
        sourceType: String(item.sourceType || "manual"),
        sourceIds: safeArray(item.sourceIds).map(String),
        sourceQuote: String(item.sourceQuote || ""),
        createdAt: String(item.createdAt || nowIso()),
        updatedAt: String(item.updatedAt || item.createdAt || nowIso()),
        ...optionalScopeFields(item)
      };
    }
    function normalizeItem(item = {}) {
      return item?.type === "anchor" ? normalizeAnchor(item) : normalizePromise(item);
    }
    function hasHangul(value) {
      return /[\uac00-\ud7a3\u1100-\u11ff\u3130-\u318f]/.test(String(value || ""));
    }
    function hasLatin(value) {
      return /[A-Za-z]/.test(String(value || ""));
    }
    function seedKeywordsByScript(value) {
      const text = String(value || "").trim();
      if (!text)
        return { ko: [], en: [] };
      if (hasHangul(text))
        return { ko: [text], en: [] };
      if (hasLatin(text))
        return { ko: [], en: [text] };
      return { ko: [], en: [] };
    }
    function koDisplayOn() {
      return state.koDisplay !== "original";
    }
    function displayText(original, korean) {
      return koDisplayOn() && String(korean || "").trim() ? String(korean) : String(original || "");
    }
    function hasKoText(...values) {
      return values.some((value) => String(value || "").trim());
    }
    function normalizeKoText(value, original, maxChars) {
      const text = String(value || "").trim().slice(0, maxChars);
      if (!text)
        return "";
      if (text === String(original || "").trim())
        return "";
      return text;
    }
    function normalizeTextList(value, max = 8, maxChars = 120) {
      const out = [];
      const seen = new Set;
      for (const raw of safeArray(value)) {
        const text = String(raw || "").trim().replace(/\s+/g, " ").slice(0, maxChars);
        const key = text.toLocaleLowerCase();
        if (!text || seen.has(key))
          continue;
        seen.add(key);
        out.push(text);
        if (out.length >= max)
          break;
      }
      return out;
    }
    function normalizeTriggerGroups(value) {
      const out = [];
      const seen = new Set;
      for (const raw of safeArray(value)) {
        const terms = normalizeTextList(Array.isArray(raw) ? raw : String(raw || "").split(/[,＋+]/), 4, 80);
        if (terms.length < 2)
          continue;
        const key = terms.map((x) => x.toLocaleLowerCase()).sort().join("\x00");
        if (seen.has(key))
          continue;
        seen.add(key);
        out.push(terms);
        if (out.length >= 8)
          break;
      }
      return out;
    }
    function normalizeElementFact(value = {}) {
      const text = String(value.text || value.content || "").trim().slice(0, 300);
      if (!text)
        return null;
      const sourceRaw = isRecord(value.source) ? value.source : null;
      const source = sourceRaw ? {
        messageIds: normalizeTextList(sourceRaw.messageIds, 24, 120),
        fingerprints: normalizeTextList(sourceRaw.fingerprints, 24, 120),
        activeSwipeIndex: Number.isInteger(sourceRaw.activeSwipeIndex) ? sourceRaw.activeSwipeIndex : 0,
        contentHash: String(sourceRaw.contentHash || "")
      } : null;
      return { id: String(value.id || uid("elf")), text, textKo: normalizeKoText(value.textKo, text, 300), source, createdAt: String(value.createdAt || nowIso()) };
    }
    function elementFactKey(value) {
      return String(value?.text || value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
    }
    function uniqueElementFacts(value) {
      const seen = new Set;
      const out = [];
      for (const raw of safeArray(value)) {
        const fact = normalizeElementFact(raw);
        const key = elementFactKey(fact);
        if (!fact || !key || seen.has(key))
          continue;
        seen.add(key);
        out.push(fact);
      }
      return out;
    }
    function balanceElementFacts(currentValue, historyValue) {
      const allCurrent = uniqueElementFacts(currentValue);
      const currentFacts = allCurrent.slice(-8);
      const overflow = allCurrent.slice(0, Math.max(0, allCurrent.length - 8));
      const currentKeys = new Set(currentFacts.map(elementFactKey));
      const historyFacts = uniqueElementFacts([...safeArray(historyValue), ...overflow]).filter((fact) => !currentKeys.has(elementFactKey(fact)));
      return { currentFacts, historyFacts };
    }
    function normalizeElement(value = {}) {
      const facts = balanceElementFacts(value.currentFacts, value.historyFacts);
      return {
        id: String(value.id || uid("element")),
        name: String(value.name || "새 요소").trim().slice(0, 80),
        nameKo: normalizeKoText(value.nameKo, String(value.name || "").trim().slice(0, 80), 80),
        aliases: normalizeTextList(value.aliases, 8, 80),
        standaloneTriggers: normalizeTextList(value.standaloneTriggers, 8, 80),
        triggerGroups: normalizeTriggerGroups(value.triggerGroups),
        currentFacts: facts.currentFacts,
        historyFacts: facts.historyFacts,
        createdAt: String(value.createdAt || nowIso()),
        updatedAt: String(value.updatedAt || value.createdAt || nowIso())
      };
    }
    function normalizeElementMemory(value = {}) {
      const raw = parseRecord(value);
      return {
        schemaVersion: 1,
        originChatId: String(raw.originChatId || ""),
        entities: safeArray(raw.entities).map(normalizeElement).slice(0, 400),
        connectionId: String(raw.connectionId || ""),
        extractionPrompt: String(raw.extractionPrompt || "").slice(0, 8000),
        injectionPrompt: String(raw.injectionPrompt || "").slice(0, 8000),
        injectionEnabled: raw.injectionEnabled === true,
        extractTurns: Math.max(1, Math.min(100, Number(raw.extractTurns) || 20)),
        headerEntryId: String(raw.headerEntryId || ""),
        entityEntryIds: parseRecord(raw.entityEntryIds)
      };
    }
    function normalizeWikiSection(value = {}) {
      const raw = parseRecord(value);
      const heading = String(raw.heading || raw.title || "").trim().replace(/\s+/g, " ").slice(0, 120);
      const body = String(raw.body ?? raw.content ?? "").replace(/\r\n?/g, `
`).slice(0, WIKI_SECTION_BODY_HARD_MAX);
      if (!heading && !body.trim())
        return null;
      const level = Math.max(1, Math.min(WIKI_SECTION_MAX_LEVEL, Number(raw.level) || 1));
      return {
        id: String(raw.id || uid("wsec")),
        heading: heading || "본문",
        headingKo: normalizeKoText(raw.headingKo, heading, 120),
        body,
        bodyKo: normalizeKoText(raw.bodyKo, body, WIKI_SECTION_BODY_HARD_MAX),
        level,
        managed: raw.managed === "user" ? "user" : "ai",
        updatedAt: String(raw.updatedAt || nowIso())
      };
    }
    function normalizeWikiImage(value = {}) {
      const raw = parseRecord(value);
      const url = String(raw.url || "").trim().slice(0, 1000);
      if (!url)
        return null;
      const safe = /^https?:\/\//i.test(url) || /^\/[^/\\]/.test(url);
      if (!safe)
        return null;
      return {
        id: String(raw.id || uid("wimg")),
        url,
        alt: String(raw.alt || "").trim().replace(/\s+/g, " ").slice(0, 200),
        caption: String(raw.caption || "").trim().replace(/\s+/g, " ").slice(0, 300),
        lead: raw.lead === true
      };
    }
    function normalizeWikiSource(value = {}) {
      const raw = parseRecord(value);
      const kind = Object.prototype.hasOwnProperty.call(WIKI_SOURCE_KIND_LABEL, raw.kind) ? raw.kind : "manual";
      const label = String(raw.label || "").trim().replace(/\s+/g, " ").slice(0, 160);
      const quote = String(raw.quote || raw.text || "").trim().slice(0, 1200);
      if (!label && !quote)
        return null;
      return {
        id: String(raw.id || uid("wsrc")),
        kind,
        refId: String(raw.refId || "").slice(0, 160),
        label: label || WIKI_SOURCE_KIND_LABEL[kind],
        quote,
        createdAt: String(raw.createdAt || nowIso())
      };
    }
    function normalizeWikiDoc(value = {}) {
      const raw = parseRecord(value);
      const sections = safeArray(raw.sections).map(normalizeWikiSection).filter(Boolean).slice(0, WIKI_SECTION_LIMIT);
      return {
        id: String(raw.id || uid("wdoc")),
        title: String(raw.title || "새 문서").trim().replace(/\s+/g, " ").slice(0, 120) || "새 문서",
        category: Object.prototype.hasOwnProperty.call(WIKI_CATEGORY_LABEL, raw.category) ? raw.category : "misc",
        subcategory: String(raw.subcategory || "").trim().replace(/\s*\/\s*/g, "/").replace(/\s+/g, " ").slice(0, 80),
        titleKo: normalizeKoText(raw.titleKo, String(raw.title || "").trim().replace(/\s+/g, " ").slice(0, 120), 120),
        summary: String(raw.summary || "").trim().replace(/\s+/g, " ").slice(0, WIKI_SUMMARY_MAX),
        summaryKo: normalizeKoText(raw.summaryKo, String(raw.summary || "").trim().replace(/\s+/g, " ").slice(0, WIKI_SUMMARY_MAX), WIKI_SUMMARY_MAX),
        summaryManaged: raw.summaryManaged === "user" ? "user" : "ai",
        images: safeArray(raw.images).map(normalizeWikiImage).filter(Boolean).slice(0, WIKI_IMAGE_LIMIT),
        sections,
        aliases: normalizeTextList(raw.aliases, 12, 80),
        keywordsKo: normalizeTextList(raw.keywordsKo, 16, 80),
        keywordsEn: normalizeTextList(raw.keywordsEn, 16, 80),
        keywordGroups: normalizeTriggerGroups(raw.keywordGroups),
        relatedDocIds: normalizeTextList(raw.relatedDocIds, 24, 80),
        sources: safeArray(raw.sources).map(normalizeWikiSource).filter(Boolean).slice(0, 24),
        aiLocked: raw.aiLocked === true,
        excludeFromContext: raw.excludeFromContext === true,
        alwaysRemember: raw.alwaysRemember === true,
        createdAt: String(raw.createdAt || nowIso()),
        updatedAt: String(raw.updatedAt || raw.createdAt || nowIso()),
        aiUpdatedAt: String(raw.aiUpdatedAt || "")
      };
    }
    function normalizeWikiProposalChange(value = {}) {
      const raw = parseRecord(value);
      const heading = String(raw.heading || "").trim().slice(0, 120);
      const after = String(raw.after ?? "").replace(/\r\n?/g, `
`).slice(0, WIKI_SECTION_BODY_HARD_MAX);
      if (!heading && !after.trim())
        return null;
      return {
        id: String(raw.id || uid("wchg")),
        sectionId: String(raw.sectionId || ""),
        heading: heading || "본문",
        before: String(raw.before ?? "").replace(/\r\n?/g, `
`).slice(0, WIKI_SECTION_BODY_HARD_MAX),
        after,
        afterKo: normalizeKoText(raw.afterKo, after, WIKI_SECTION_BODY_HARD_MAX),
        reason: String(raw.reason || "").trim().slice(0, 300),
        kind: raw.kind === "summary" ? "summary" : raw.sectionId ? "update" : "add"
      };
    }
    function normalizeWikiProposal(value) {
      const raw = parseRecord(value);
      const docId = String(raw.docId || "");
      const changes = safeArray(raw.changes).map(normalizeWikiProposalChange).filter(Boolean).slice(0, WIKI_SECTION_LIMIT + 1);
      const conflicts = normalizeTextList(raw.conflicts, 12, 300);
      if (!docId || !changes.length && !conflicts.length)
        return null;
      return {
        id: String(raw.id || uid("wprop")),
        docId,
        docTitle: String(raw.docTitle || "").slice(0, 120),
        baseUpdatedAt: String(raw.baseUpdatedAt || ""),
        createdAt: String(raw.createdAt || nowIso()),
        sourceCount: Math.max(0, Number(raw.sourceCount) || 0),
        sources: safeArray(raw.sources).map(normalizeWikiSource).filter(Boolean).slice(0, 24),
        changes,
        conflicts
      };
    }
    function normalizeWiki(value = {}) {
      const raw = parseRecord(value);
      const docs = safeArray(raw.docs).map(normalizeWikiDoc).slice(0, WIKI_DOC_LIMIT);
      const knownIds = new Set(docs.map((doc) => doc.id));
      for (const doc of docs)
        doc.relatedDocIds = doc.relatedDocIds.filter((id) => id !== doc.id && knownIds.has(id));
      return {
        schemaVersion: 1,
        originChatId: String(raw.originChatId || ""),
        docs,
        connectionId: String(raw.connectionId || ""),
        draftPrompt: String(raw.draftPrompt || "").slice(0, 8000),
        updatePrompt: String(raw.updatePrompt || "").slice(0, 8000),
        injectionPrompt: String(raw.injectionPrompt || "").slice(0, 8000),
        injectionEnabled: raw.injectionEnabled === true,
        alwaysBudgetChars: Math.max(300, Math.min(6000, Number(raw.alwaysBudgetChars) || 1200)),
        proposals: safeArray(raw.proposals).map(normalizeWikiProposal).filter(Boolean).filter((row) => knownIds.has(row.docId)).slice(0, 40),
        headerEntryId: String(raw.headerEntryId || ""),
        alwaysEntryId: String(raw.alwaysEntryId || ""),
        docEntryIds: parseRecord(raw.docEntryIds)
      };
    }
    function normalizePendingReview(value) {
      const raw = parseRecord(value);
      const candidates = safeArray(raw.candidates).filter(isRecord).map((row) => ({ ...row }));
      const sourceRows = safeArray(raw.sourceRows).filter(isRecord).map((row) => ({
        id: String(row.id || ""),
        title: String(row.title || ""),
        content: String(row.content || ""),
        origin: String(row.origin || ""),
        enabled: row.enabled !== false,
        createdAt: String(row.createdAt || ""),
        updatedAt: String(row.updatedAt || ""),
        messageCount: Number(row.messageCount) || 0,
        ...row.sourceKind === AM_SCENE_SOURCE ? {
          sourceKind: AM_SCENE_SOURCE,
          amRecordId: String(row.amRecordId || ""),
          sourceFingerprint: String(row.sourceFingerprint || ""),
          audienceCharacterIds: normalizeKnownBy(row.audienceCharacterIds),
          timeline: String(row.timeline || ""),
          startIndex: Number(row.startIndex) || 0,
          endIndex: Number(row.endIndex) || 0
        } : {}
      }));
      const episodes = safeArray(raw.episodes).filter(isRecord).map((row) => ({ ...row }));
      const threads = safeArray(raw.threads).filter(isRecord).map((row) => ({ ...row }));
      if (!candidates.length && !sourceRows.length && !episodes.length && !threads.length)
        return null;
      return {
        ...threads.length ? { threads, selectedThreadIds: safeArray(raw.selectedThreadIds).map(String) } : {},
        ...episodes.length ? { episodes, selectedEpisodeIds: safeArray(raw.selectedEpisodeIds).map(String) } : {},
        candidates,
        selectedIndices: safeArray(raw.selectedIndices).map(String),
        selectedCandidateIds: safeArray(raw.selectedCandidateIds).map(String),
        sourceRows,
        batchKey: String(raw.batchKey || summaryBatchKey(sourceRows)),
        createdAt: String(raw.createdAt || nowIso())
      };
    }
    function normalizeAutoReviewUndo(value) {
      const raw = parseRecord(value);
      const updated = safeArray(raw.updated).filter(isRecord).filter((row) => row.before?.id).map((row) => ({ id: String(row.id), before: normalizeItem(row.before), appliedUpdatedAt: String(row.appliedUpdatedAt || "") }));
      const created = safeArray(raw.created).filter(isRecord).map((row) => ({ id: String(row.id || ""), appliedUpdatedAt: String(row.appliedUpdatedAt || "") })).filter((row) => row.id);
      const episodes = safeArray(raw.episodes).map(String).filter(Boolean);
      const threadCands = safeArray(raw.threadCandidates).map(String).filter(Boolean);
      if (!updated.length && !created.length && !episodes.length && !threadCands.length)
        return null;
      return { createdAt: String(raw.createdAt || nowIso()), sourceBatchKey: String(raw.sourceBatchKey || ""), updated, created, ...episodes.length ? { episodes } : {}, ...threadCands.length ? { threadCandidates: threadCands } : {} };
    }
    function normalizeData(raw) {
      const base = defaultData();
      const value = parseRecord(raw);
      return {
        ...base,
        ...value,
        version: 1,
        ownerChatId: String(value.ownerChatId || ""),
        enabled: value.enabled !== false,
        maxPromises: Math.max(1, Math.min(20, Number(value.maxPromises) || 8)),
        maxAnchors: Math.max(1, Math.min(24, Number(value.maxAnchors) || 10)),
        anchorBudgetChars: Math.max(600, Math.min(12000, Number(value.anchorBudgetChars) || 2400)),
        items: safeArray(value.items).map(normalizeItem),
        lorebookId: String(value.lorebookId || ""),
        promiseEntryId: String(value.promiseEntryId || ""),
        anchorEntryId: String(value.anchorEntryId || ""),
        backupEntryId: String(value.backupEntryId || ""),
        keywordEntryIds: parseRecord(value.keywordEntryIds),
        elementMemory: normalizeElementMemory(value.elementMemory),
        wiki: normalizeWiki(value.wiki),
        pendingReview: normalizePendingReview(value.pendingReview),
        lastAutoReviewUndo: normalizeAutoReviewUndo(value.lastAutoReviewUndo),
        ...Array.isArray(value.episodes) ? { episodes: value.episodes.map(normalizeEpisode).filter(Boolean) } : {},
        ...Array.isArray(value.threads) ? { threads: value.threads.map(normalizeThread).filter(Boolean) } : {},
        lastSyncAt: String(value.lastSyncAt || ""),
        lastSyncError: String(value.lastSyncError || ""),
        legacyImportedAt: String(value.legacyImportedAt || "")
      };
    }
    function advancedMemoryEnabled(chat = state.currentChat) {
      return parseRecord(parseRecord(chat?.metadata).advancedMemory).enabled === true;
    }
    function chatCharacterIds(chat = state.currentChat) {
      let raw = chat?.characterIds;
      if (typeof raw === "string") {
        try {
          raw = JSON.parse(raw);
        } catch {
          raw = [];
        }
      }
      return normalizeKnownBy(raw);
    }
    function groupChatIndividual(chat = state.currentChat) {
      return String(parseRecord(chat?.metadata).groupChatMode || chat?.groupChatMode || "") === "individual";
    }
    function restrictionEffective(chat = state.currentChat) {
      return chatCharacterIds(chat).length <= 1 || groupChatIndividual(chat);
    }
    async function loadChatCharacters() {
      const ids = chatCharacterIds();
      const rows = [];
      for (const id of ids.slice(0, 24)) {
        let name = "";
        try {
          const row = await api(`characters/${encodeURIComponent(id)}`);
          name = String(parseRecord(row?.data).name || row?.name || "").trim();
        } catch {}
        rows.push({ id, name: name || id });
      }
      state.chatCharacters = rows;
    }
    function characterName(id) {
      return state.chatCharacters.find((row) => row.id === id)?.name || String(id || "");
    }
    function knownByLabel(ids) {
      const list = normalizeKnownBy(ids);
      return list.length ? list.map(characterName).join(", ") : "모두";
    }
    function resolveCharacterRefs(values) {
      const ids = [];
      const unknown = [];
      for (const raw of safeArray(values)) {
        const value = String(raw || "").trim();
        if (!value)
          continue;
        const byId = state.chatCharacters.find((row) => row.id === value);
        const byName = state.chatCharacters.filter((row) => row.name.trim().toLocaleLowerCase() === value.toLocaleLowerCase());
        const hit = byId || (byName.length === 1 ? byName[0] : null);
        if (hit) {
          if (!ids.includes(hit.id))
            ids.push(hit.id);
        } else
          unknown.push(value);
      }
      return { ids, unknown };
    }
    const CHAR_CONDITION_RE = /\{\{#if\s+char\s*==\s*([^}]*)\}\}/gi;
    function hasCharacterConditions(text) {
      return /\{\{#if\s+char\s*==/i.test(String(text || ""));
    }
    function labelCharacterConditions(text) {
      return String(text || "").replace(CHAR_CONDITION_RE, (_, cond) => {
        const names = [...String(cond).matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => String(m[1] || m[2] || "").trim()).filter(Boolean);
        return `[KNOWN ONLY BY: ${names.join(", ") || "unknown"}]`;
      }).replace(/\{\{else\}\}/gi, "[OTHERWISE — different knowers]").replace(/\{\{\/if\}\}/gi, "[/KNOWN ONLY BY]");
    }
    function stripCharacterConditionSections(text) {
      let out = String(text || "");
      for (let guard = 0;guard < 50 && /\{\{#if\s+char\s*==/i.test(out); guard += 1) {
        out = out.replace(/\{\{#if\s+char\s*==[^}]*\}\}(?:(?!\{\{#if)[\s\S])*?\{\{\/if\}\}/i, "");
        if (!/\{\{\/if\}\}/i.test(out)) {
          out = out.replace(/\{\{#if\s+char\s*==[^}]*\}\}[\s\S]*$/i, "");
          break;
        }
      }
      return out.trim();
    }
    function sourceRowAudience(row) {
      const chars = chatCharacterIds();
      let audienceIds = [];
      if (row?.sourceKind === AM_SCENE_SOURCE) {
        const audience = normalizeKnownBy(row.audienceCharacterIds);
        if (audience.length && chars.length > 1 && !chars.every((id) => audience.includes(id)))
          audienceIds = audience;
      }
      const inline = hasCharacterConditions(row?.content);
      return { restricted: audienceIds.length > 0 || inline, audienceIds, inline };
    }
    function batchHasRestricted(rows) {
      return safeArray(rows).some((row) => sourceRowAudience(row).restricted);
    }
    function amSceneRowsFromStatus(status) {
      return safeArray(parseRecord(status).records).filter((r) => r && r.kind === "scene" && r.enabled === true && r.status === "closed" && String(r.content || "").trim()).map((r) => ({
        id: `am:${String(r.id)}`,
        title: String(r.title || "").trim() || "장면 요약",
        content: String(r.content),
        origin: "advanced-memory",
        enabled: true,
        createdAt: String(r.createdAt || ""),
        updatedAt: String(r.updatedAt || ""),
        sourceKind: AM_SCENE_SOURCE,
        amRecordId: String(r.id),
        sourceFingerprint: String(r.sourceFingerprint || ""),
        audienceCharacterIds: normalizeKnownBy(r.audienceCharacterIds),
        timeline: String(r.timeline || ""),
        startIndex: Number(r.startIndex) || 0,
        endIndex: Number(r.endIndex) || 0
      })).sort((a, b) => a.startIndex - b.startIndex || a.createdAt.localeCompare(b.createdAt));
    }
    function amKnownKey(chatId) {
      return `am:${chatId}`;
    }
    async function acceptAmStatus(chatId, status) {
      if (!chatId || chatId !== String(state.selectedChatId || ""))
        return;
      state.amChatId = chatId;
      state.sceneSettings = parseRecord(parseRecord(status).settings);
      state.amSceneRows = amSceneRowsFromStatus(status);
      state.amAllFingerprints = new Set(safeArray(parseRecord(status).records).filter((r) => r && r.kind === "scene" && r.enabled !== false).map((r) => String(r.sourceFingerprint || "")).filter(Boolean));
      state.amSceneError = "";
      const key = amKnownKey(chatId);
      if (!Array.isArray(state.summaryKnownByChat[key])) {
        state.summaryKnownByChat[key] = state.amSceneRows.map(summarySignature).slice(-260);
        state.pendingAmRows = [];
        await saveUiState();
      } else {
        const known = new Set(safeArray(state.summaryKnownByChat[key]).map(String));
        state.pendingAmRows = state.amSceneRows.filter((row) => !known.has(summarySignature(row)));
      }
    }
    async function refreshAdvancedMemoryScenes(chatId = String(state.selectedChatId || "")) {
      if (!chatId || !advancedMemoryEnabled()) {
        state.amSceneRows = [];
        state.pendingAmRows = [];
        state.sceneSettings = null;
        state.amSceneError = "";
        state.amChatId = chatId;
        return;
      }
      if (state.amChatId !== chatId) {
        state.amSceneRows = [];
        state.pendingAmRows = [];
        state.sceneSettings = null;
      }
      state.amChatId = chatId;
      try {
        await acceptAmStatus(chatId, await api(`chats/${encodeURIComponent(chatId)}/advanced-memory`));
      } catch (error) {
        state.amSceneError = String(error?.message || error || "고급 메모리 상태를 읽지 못했습니다.");
      }
    }
    function amRowsPending(rows) {
      return safeArray(rows).filter((row) => row?.sourceKind === AM_SCENE_SOURCE);
    }
    function branchParentChatId(chat = state.currentChat) {
      const metadata = parseRecord(chat?.metadata);
      return String(metadata.branchParentChatId || chat?.branchParentChatId || "");
    }
    function hasMeaningfulMemoryData(raw) {
      const value = parseRecord(raw);
      const memory = parseRecord(value.elementMemory);
      const wiki = parseRecord(value.wiki);
      return safeArray(value.items).length > 0 || safeArray(memory.entities).length > 0 || safeArray(wiki.docs).length > 0 || safeArray(value.episodes).length > 0 || safeArray(value.threads).length > 0 || Object.keys(parseRecord(wiki.docEntryIds)).length > 0 || !!String(wiki.headerEntryId || wiki.alwaysEntryId || wiki.originChatId || "") || !!normalizePendingReview(value.pendingReview) || branchHoldCount(value.branchHold) > 0 || !!normalizeAutoReviewUndo(value.lastAutoReviewUndo) || !!String(value.lorebookId || value.promiseEntryId || value.anchorEntryId || value.backupEntryId || "") || Object.keys(parseRecord(value.keywordEntryIds)).length > 0 || Object.keys(parseRecord(memory.entityEntryIds)).length > 0;
    }
    function ownershipAllowsData(ownership = state.ownership) {
      return ["new", "owned", "legacy-owned", "branch-owned", "restored", "confirmed"].includes(String(ownership?.status || ""));
    }
    function managedBookOwner(book) {
      const description = String(book?.description || "");
      const match = description.match(/§MEMORY_CABINET_RP_V1§\s+chat:([^\s]+)/);
      if (match)
        return { ownerChatId: String(match[1]), evidence: "managed-book-marker" };
      if (safeArray(book?.tags).includes(LOREBOOK_TAG) && book?.chatId)
        return { ownerChatId: String(book.chatId), evidence: "managed-book-chatId" };
      return { ownerChatId: "", evidence: "" };
    }
    function parseBackupEntry(entry, expectedChatId) {
      const content = String(entry?.content || "");
      if (entry?.enabled !== false)
        return null;
      if (entry?.tag !== BACKUP_ENTRY_TAG && !content.includes(BACKUP_MARKER))
        return null;
      const start = content.indexOf("{");
      if (start < 0)
        return null;
      try {
        const payload = JSON.parse(content.slice(start));
        if (payload?.marker !== BACKUP_MARKER || String(payload?.ownerChatId || "") !== String(expectedChatId || ""))
          return null;
        const data = normalizeData(payload.data);
        if (data.ownerChatId !== String(expectedChatId || ""))
          return null;
        return { entryId: String(entry.id || ""), savedAt: String(payload.savedAt || ""), data };
      } catch {
        return null;
      }
    }
    function classifyOwnership({ chatId, parentChatId = "", rawData, bookOwnerChatId = "", bookEvidence = "", backup = null, discoveryChecked = true }) {
      const value = parseRecord(rawData);
      const explicitOwner = String(value.ownerChatId || "");
      const originOwner = String(parseRecord(value.elementMemory).originChatId || "");
      const inheritedOwner = explicitOwner || originOwner || String(bookOwnerChatId || "");
      if (explicitOwner) {
        if (explicitOwner === chatId)
          return { status: "owned", ownerChatId: explicitOwner, evidence: "ownerChatId", reason: "" };
        if (parentChatId && parentChatId === explicitOwner)
          return backup ? { status: "recovery", ownerChatId: chatId, evidence: "matching-backup-before-branch-inherit", reason: "이 분기의 기존 백업이 있어 부모 데이터 재상속을 보류함" } : { status: "branch", ownerChatId: explicitOwner, evidence: "branchParentChatId+ownerChatId", reason: "부모 RP에서 정상 상속된 분기 데이터" };
        return { status: "quarantine", ownerChatId: explicitOwner, evidence: "ownerChatId", reason: "다른 RP 소유의 기억 데이터가 감지됨" };
      }
      if (originOwner) {
        if (originOwner === chatId)
          return { status: "legacy-owned", ownerChatId: chatId, evidence: "elementMemory.originChatId", reason: "" };
        if (parentChatId && parentChatId === originOwner)
          return backup ? { status: "recovery", ownerChatId: chatId, evidence: "matching-backup-before-legacy-branch-inherit", reason: "이 분기의 기존 백업이 있어 부모 legacy 데이터 재상속을 보류함" } : { status: "branch", ownerChatId: originOwner, evidence: "branchParentChatId+elementMemory.originChatId", reason: "부모 RP의 v1.8.0 요소 기억을 상속한 분기" };
        return { status: "quarantine", ownerChatId: originOwner, evidence: "elementMemory.originChatId", reason: "요소 기억이 다른 RP를 원본으로 가리킴" };
      }
      if (bookOwnerChatId) {
        if (bookOwnerChatId === chatId)
          return { status: "legacy-owned", ownerChatId: chatId, evidence: bookEvidence || "managed-lorebook", reason: "" };
        if (parentChatId && parentChatId === bookOwnerChatId)
          return backup ? { status: "recovery", ownerChatId: chatId, evidence: "matching-backup-before-book-branch-inherit", reason: "이 분기의 기존 백업이 있어 부모 로어북 데이터 재상속을 보류함" } : { status: "branch", ownerChatId: bookOwnerChatId, evidence: `branchParentChatId+${bookEvidence || "managed-lorebook"}`, reason: "부모 RP의 관리 로어북과 함께 상속된 분기" };
        return { status: "quarantine", ownerChatId: bookOwnerChatId, evidence: bookEvidence || "managed-lorebook", reason: "관리 로어북이 다른 RP를 가리킴" };
      }
      if (hasMeaningfulMemoryData(value))
        return { status: "quarantine", ownerChatId: inheritedOwner, evidence: "none", reason: "소유권 증거가 없는 기존 기억 데이터" };
      if (backup)
        return { status: "recovery", ownerChatId: chatId, evidence: "matching-backup", reason: "metadata가 비어 있지만 이 RP의 전용 백업을 찾음" };
      if (!discoveryChecked)
        return { status: "quarantine", ownerChatId: "", evidence: "backup-check-failed", reason: "로어북 백업 확인에 실패해 새 데이터로 확정할 수 없음" };
      return { status: "new", ownerChatId: chatId, evidence: "empty", reason: "" };
    }
    function timeAfter(value, cutMs) {
      const t = Date.parse(String(value || ""));
      return Number.isFinite(t) && Number.isFinite(cutMs) && t > cutMs;
    }
    async function branchCutPoint(chat) {
      const meta = parseRecord(chat?.metadata);
      const wanted = String(meta.branchMessageId || "");
      try {
        const rows = extractArray(await api(`chats/${encodeURIComponent(chat.id)}/messages`), ["messages", "items", "results"]);
        const hit = wanted && rows.find((row) => String(row.id) === wanted) || rows[rows.length - 1] || null;
        const at = String(hit?.createdAt || "");
        return Number.isFinite(Date.parse(at)) ? { at, messageId: String(hit?.id || "") } : null;
      } catch {
        return null;
      }
    }
    function emptyBranchHold() {
      return { parentChatId: "", cutAt: "", cutMessageId: "", createdAt: "", items: [], entities: [], facts: [], docs: [], episodes: [], threads: [], threadEntries: [] };
    }
    function normalizeBranchHold(value) {
      const raw = parseRecord(value);
      const hold = { ...emptyBranchHold(), ...raw };
      for (const key of ["items", "entities", "facts", "docs", "episodes", "threads", "threadEntries"])
        hold[key] = safeArray(raw[key]).filter(isRecord);
      return hold;
    }
    function branchHoldCount(value) {
      const hold = normalizeBranchHold(value);
      return ["items", "entities", "facts", "docs", "episodes", "threads", "threadEntries"].reduce((sum, key) => sum + hold[key].length, 0);
    }
    function holdPostBranchRecords(data, cut, parentChatId, rawData = data) {
      const next = normalizeData(data);
      const raw = parseRecord(rawData);
      const rawItems = new Map(safeArray(raw.items).filter(isRecord).map((row) => [String(row.id || ""), row]));
      const rawEntities = new Map(safeArray(parseRecord(raw.elementMemory).entities).filter(isRecord).map((row) => [String(row.id || ""), row]));
      const rawDocs = new Map(safeArray(parseRecord(raw.wiki).docs).filter(isRecord).map((row) => [String(row.id || ""), row]));
      const rawFactAt = (entityId, text) => {
        const entity = rawEntities.get(String(entityId)) || {};
        const hit = [...safeArray(entity.currentFacts), ...safeArray(entity.historyFacts)].find((fact) => isRecord(fact) && String(fact.text || fact.content || "").trim() === String(text || "").trim());
        return hit?.createdAt || "";
      };
      next.pendingReview = null;
      next.lastAutoReviewUndo = null;
      const cutMs = Date.parse(String(cut?.at || ""));
      if (!Number.isFinite(cutMs))
        return next;
      const hold = normalizeBranchHold(next.branchHold);
      Object.assign(hold, { parentChatId: String(parentChatId || ""), cutAt: String(cut.at), cutMessageId: String(cut.messageId || ""), createdAt: nowIso() });
      next.items = next.items.filter((item) => {
        const src = rawItems.get(item.id) || {};
        const reason = timeAfter(src.createdAt, cutMs) ? "created" : timeAfter(src.updatedAt, cutMs) ? "updated" : "";
        if (!reason)
          return true;
        hold.items.push({ ...item, holdReason: reason });
        return false;
      });
      const memory = next.elementMemory;
      memory.entities = memory.entities.filter((entity) => {
        if (timeAfter(rawEntities.get(entity.id)?.createdAt, cutMs)) {
          hold.entities.push({ ...entity, holdReason: "created" });
          return false;
        }
        for (const list of ["currentFacts", "historyFacts"]) {
          entity[list] = entity[list].filter((fact) => {
            if (!timeAfter(rawFactAt(entity.id, fact.text), cutMs))
              return true;
            hold.facts.push({ entityId: entity.id, entityName: entity.name, list, fact });
            return false;
          });
        }
        return true;
      });
      next.wiki.docs = next.wiki.docs.filter((doc) => {
        const src = rawDocs.get(doc.id) || {};
        const reason = timeAfter(src.createdAt, cutMs) ? "created" : timeAfter(src.updatedAt, cutMs) ? "updated" : "";
        if (!reason)
          return true;
        hold.docs.push({ ...doc, holdReason: reason });
        return false;
      });
      if (typeof holdPostBranchLayers === "function")
        holdPostBranchLayers(next, hold, cutMs, raw);
      if (branchHoldCount(hold))
        next.branchHold = hold;
      return next;
    }
    function resetManagedPointersForOwner(data, chatId) {
      const next = normalizeData(data);
      const previousBookIds = [next.lorebookId].map(String).filter(Boolean);
      next.ownerChatId = String(chatId);
      next.lorebookId = "";
      next.promiseEntryId = "";
      next.anchorEntryId = "";
      next.backupEntryId = "";
      next.keywordEntryIds = {};
      next.elementMemory.originChatId = String(chatId);
      next.elementMemory.headerEntryId = "";
      next.elementMemory.entityEntryIds = {};
      next.wiki.originChatId = String(chatId);
      next.wiki.headerEntryId = "";
      next.wiki.alwaysEntryId = "";
      next.wiki.docEntryIds = {};
      if (next.restrictedEntryIds)
        next.restrictedEntryIds = {};
      if (next.episodeEntryIds)
        next.episodeEntryIds = {};
      if (next.threadEntryId)
        next.threadEntryId = "";
      if (next.threadRestrictedEntryIds)
        next.threadRestrictedEntryIds = {};
      next.lastSyncAt = "";
      next.lastSyncError = "";
      return { data: next, previousBookIds };
    }
    let uiLoadPromise = null;
    function ensureUiLoaded() {
      if (state.uiLoaded)
        return Promise.resolve();
      if (!uiLoadPromise) {
        const keepSelected = String(state.selectedChatId || "");
        uiLoadPromise = loadUiState().then(() => {
          if (keepSelected)
            state.selectedChatId = keepSelected;
        }).finally(() => {
          uiLoadPromise = null;
        });
      }
      return uiLoadPromise;
    }
    async function readStoredUiState() {
      let saved = {};
      try {
        saved = parseRecord(localStorage.getItem(UI_STORAGE_KEY));
      } catch {}
      try {
        if (typeof marinara !== "undefined" && marinara?.storage?.get) {
          const ext = parseRecord(await marinara.storage.get());
          saved = { ...saved, ...parseRecord(ext[EXT_STORAGE_KEY]) };
        }
      } catch {}
      return saved;
    }
    function mergeUiMaps(stored, current) {
      const known = { ...parseRecord(stored.summaryKnownByChat) };
      for (const [key, list] of Object.entries(parseRecord(current.summaryKnownByChat))) {
        known[key] = Array.from(new Set([...safeArray(known[key]).map(String), ...safeArray(list).map(String)])).slice(-260);
      }
      return {
        summaryKnownByChat: known,
        summaryAutoAttemptByChat: parseRecord(current.summaryAutoAttemptByChat),
        sourceWatchByChat: { ...parseRecord(stored.sourceWatchByChat), ...parseRecord(current.sourceWatchByChat) },
        agentNoticeDismissed: { ...parseRecord(stored.agentNoticeDismissed), ...parseRecord(current.agentNoticeDismissed) }
      };
    }
    async function loadUiState() {
      let saved = {};
      try {
        saved = parseRecord(localStorage.getItem(UI_STORAGE_KEY));
      } catch {}
      try {
        if (typeof marinara !== "undefined" && marinara?.storage?.get) {
          const ext = parseRecord(await marinara.storage.get());
          saved = { ...saved, ...parseRecord(ext[EXT_STORAGE_KEY]) };
        }
      } catch {}
      state.selectedChatId = String(saved.selectedChatId || state.selectedChatId || "");
      state.activeTab = TAB_IDS.includes(saved.activeTab) ? saved.activeTab : "overview";
      state.wikiCategoryFilter = saved.wikiCategoryFilter === "all" || Object.prototype.hasOwnProperty.call(WIKI_CATEGORY_LABEL, saved.wikiCategoryFilter) ? saved.wikiCategoryFilter : "all";
      state.koDisplay = saved.koDisplay === "original" ? "original" : "auto";
      state.agentNoticeDismissed = parseRecord(saved.agentNoticeDismissed);
      state.filter = ["active", "all", "hold", "done", "archived"].includes(saved.filter) ? saved.filter : "active";
      state.expanded = { promise: saved.expandedPromise === true, anchor: saved.expandedAnchor === true };
      state.modelConnectionId = String(saved.modelConnectionId || "");
      state.uiFontSize = ["normal", "large", "xlarge"].includes(saved.uiFontSize) ? saved.uiFontSize : "normal";
      let savedTheme = saved.uiThemeMode === "paper" ? "ribbon" : saved.uiThemeMode;
      if (saved.themeUnifiedV2 !== true && saved.wikiTheme === "green")
        savedTheme = "green";
      state.uiThemeMode = UI_THEME_IDS.includes(savedTheme) ? savedTheme : "ribbon";
      state.reviewPrompt = String(saved.reviewPrompt || "").trim() || DEFAULT_REVIEW_PROMPT;
      state.reviewExtraInstruction = String(saved.reviewExtraInstruction || "");
      state.summaryKnownByChat = parseRecord(saved.summaryKnownByChat);
      state.summaryAutoAttemptByChat = parseRecord(saved.summaryAutoAttemptByChat);
      state.sourceWatchByChat = parseRecord(saved.sourceWatchByChat);
      state.summaryUpdateMode = Object.prototype.hasOwnProperty.call(SUMMARY_UPDATE_MODE_LABEL, saved.summaryUpdateMode) ? saved.summaryUpdateMode : "notify_model";
      state.elementExtractMode = saved.elementExtractMode === "range" ? "range" : "recent";
      state.elementExtractTurns = Math.max(1, Math.min(100, Number(saved.elementExtractTurns) || 20));
      state.elementRangeStart = Math.max(1, Number(saved.elementRangeStart) || 1);
      state.elementRangeEnd = Math.max(state.elementRangeStart, Number(saved.elementRangeEnd) || 20);
      state.uiLoaded = true;
    }
    async function saveUiState(patch = {}) {
      if (!state.uiLoaded)
        await ensureUiLoaded();
      const stored = await readStoredUiState();
      const current = {
        selectedChatId: state.selectedChatId,
        activeTab: state.activeTab,
        filter: state.filter,
        expandedPromise: state.expanded.promise,
        expandedAnchor: state.expanded.anchor,
        modelConnectionId: state.modelConnectionId,
        uiFontSize: state.uiFontSize,
        uiThemeMode: state.uiThemeMode,
        reviewPrompt: state.reviewPrompt,
        reviewExtraInstruction: state.reviewExtraInstruction,
        summaryKnownByChat: state.summaryKnownByChat,
        summaryAutoAttemptByChat: state.summaryAutoAttemptByChat,
        sourceWatchByChat: state.sourceWatchByChat,
        summaryUpdateMode: state.summaryUpdateMode,
        elementExtractMode: state.elementExtractMode,
        elementExtractTurns: state.elementExtractTurns,
        elementRangeStart: state.elementRangeStart,
        elementRangeEnd: state.elementRangeEnd,
        wikiCategoryFilter: state.wikiCategoryFilter,
        themeUnifiedV2: true,
        koDisplay: state.koDisplay,
        agentNoticeDismissed: state.agentNoticeDismissed,
        ...patch
      };
      Object.assign(current, mergeUiMaps(stored, current));
      state.summaryKnownByChat = current.summaryKnownByChat;
      state.summaryAutoAttemptByChat = current.summaryAutoAttemptByChat;
      state.sourceWatchByChat = current.sourceWatchByChat;
      state.agentNoticeDismissed = current.agentNoticeDismissed;
      try {
        localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(current));
      } catch {}
      try {
        if (typeof marinara !== "undefined" && marinara?.storage?.patch)
          await marinara.storage.patch({ [EXT_STORAGE_KEY]: current });
      } catch {}
    }
    async function loadChats() {
      const payload = await api("chats");
      const all = extractArray(payload, ["chats", "items", "results"]).filter((chat) => chat && (chat.id || chat.chatId)).map((chat) => ({ ...chat, id: String(chat.id || chat.chatId), metadata: parseRecord(chat.metadata) }));
      const rp = all.filter(isRpChat);
      state.chats = (rp.length ? rp : all).map((chat, index) => ({ chat, index })).sort((a, b) => chatRecentTime(b.chat) - chatRecentTime(a.chat) || a.index - b.index).map((row) => row.chat);
      if (!state.chats.some((chat) => chat.id === state.selectedChatId))
        state.selectedChatId = state.chats[0]?.id || "";
    }
    function connectionRows(payload) {
      return extractArray(payload, ["connections", "items", "results"]).filter((row) => row && !["image_generation", "video_generation", "embedding"].includes(String(row.provider || ""))).filter((row) => String(row.model || "").trim() || String(row.provider || "") === "grok_subscription").map((row) => ({
        id: String(row.id || ""),
        label: String(row.name || row.label || row.model || row.provider || "연결"),
        model: String(row.model || ""),
        provider: String(row.provider || "")
      })).filter((row) => row.id);
    }
    function chooseDefaultConnection(chat) {
      if (state.modelConnectionId && state.connections.some((c) => c.id === state.modelConnectionId))
        return state.modelConnectionId;
      const deepseek = state.connections.find((c) => /deepseek/i.test(`${c.label} ${c.model} ${c.provider}`));
      if (deepseek)
        return deepseek.id;
      const chatConnection = String(chat?.connectionId || "");
      if (chatConnection && state.connections.some((c) => c.id === chatConnection))
        return chatConnection;
      return state.connections[0]?.id || "";
    }
    async function loadConnections() {
      try {
        state.connections = connectionRows(await api("connections"));
      } catch {
        state.connections = [];
      }
      state.modelConnectionId = chooseDefaultConnection(state.currentChat);
    }
    async function applyOwnershipForCurrentChat(rawData) {
      const chat = state.currentChat;
      const chatId = String(chat?.id || "");
      const resources = await inspectOwnershipResources(chat, rawData);
      const decision = classifyOwnership({
        chatId,
        parentChatId: branchParentChatId(chat),
        rawData,
        bookOwnerChatId: resources.bookOwnerChatId,
        bookEvidence: resources.bookEvidence,
        backup: resources.backup,
        discoveryChecked: resources.discoveryChecked
      });
      state.ownership = { ...decision, backup: resources.backup, discoveryChecked: resources.discoveryChecked };
      state.quarantinedData = null;
      state.ownershipDetachLorebookIds = [];
      if (["quarantine", "recovery"].includes(decision.status)) {
        state.quarantinedData = hasMeaningfulMemoryData(rawData) ? parseRecord(rawData) : null;
        state.currentData = defaultData();
        state.pendingSummaryRows = [];
        restorePendingReview();
        const wrongBookId = decision.status === "quarantine" ? String(parseRecord(rawData).lorebookId || "") : "";
        const detachIds = [...resources.foreignActiveIds, wrongBookId].filter(Boolean);
        try {
          await detachLorebooks(chatId, detachIds);
        } catch (error) {
          console.warn("[기억 보관함] foreign lorebook detach failed", error);
        }
        return;
      }
      if (decision.status === "branch") {
        const prepared = resetManagedPointersForOwner(rawData, chatId);
        prepared.data = holdPostBranchRecords(prepared.data, await branchCutPoint(chat), branchParentChatId(chat), rawData);
        state.currentData = prepared.data;
        state.ownershipDetachLorebookIds = [...new Set([...prepared.previousBookIds, ...resources.foreignActiveIds])];
        state.ownership = { ...decision, status: "branch-owned", ownerChatId: chatId, backup: null, discoveryChecked: resources.discoveryChecked };
        await patchChatMetadata(chatId, { [DATA_KEY]: state.currentData });
        restorePendingReview();
        try {
          await syncLorebook({ silent: true });
        } catch (error) {
          console.warn("[기억 보관함] branch lorebook sync failed", error);
        }
        return;
      }
      const data = normalizeData(rawData);
      if (["new", "legacy-owned"].includes(decision.status))
        data.ownerChatId = chatId;
      if (!data.elementMemory.originChatId)
        data.elementMemory.originChatId = chatId;
      if (!data.wiki.originChatId)
        data.wiki.originChatId = chatId;
      state.currentData = data;
      if (resources.foreignActiveIds.length) {
        try {
          await detachLorebooks(chatId, resources.foreignActiveIds);
        } catch (error) {
          console.warn("[기억 보관함] foreign lorebook detach failed", error);
        }
      }
      if (decision.status === "legacy-owned")
        await patchChatMetadata(chatId, { [DATA_KEY]: data });
      restorePendingReview();
    }
    async function loadCurrentChat() {
      if (!state.selectedChatId) {
        state.currentChat = null;
        state.currentData = null;
        state.ownership = { status: "unknown", reason: "", ownerChatId: "", evidence: "", backup: null, discoveryChecked: false };
        state.quarantinedData = null;
        return;
      }
      let full = null;
      try {
        full = await api(`chats/${encodeURIComponent(state.selectedChatId)}`);
      } catch {}
      const fallback = state.chats.find((chat) => chat.id === state.selectedChatId) || null;
      state.currentChat = full && isRecord(full) ? { ...fallback, ...full, id: state.selectedChatId, metadata: parseRecord(full.metadata) } : fallback;
      await applyOwnershipForCurrentChat(parseRecord(state.currentChat?.metadata)[DATA_KEY]);
      if (!state.modelConnectionId)
        state.modelConnectionId = chooseDefaultConnection(state.currentChat);
      state.elementExtractTurns = state.currentData.elementMemory.extractTurns || state.elementExtractTurns || 20;
      restorePendingReview();
      try {
        await loadChatCharacters();
      } catch (error) {
        state.chatCharacters = [];
        console.warn("[기억 보관함] character names failed", error);
      }
      try {
        await refreshAgentNotice();
      } catch (error) {
        console.warn("[기억 보관함] agent notice check failed", error);
      }
    }
    async function restoreFromMatchingBackup() {
      const backup = state.ownership?.backup;
      const chatId = String(state.currentChat?.id || "");
      if (!backup || !chatId || String(backup.data?.ownerChatId || "") !== chatId)
        throw new Error("이 RP와 일치하는 복구 백업을 찾지 못했습니다.");
      const data = normalizeData(backup.data);
      data.ownerChatId = chatId;
      state.currentData = data;
      state.quarantinedData = null;
      state.ownership = { status: "restored", reason: "", ownerChatId: chatId, evidence: "matching-backup", backup, discoveryChecked: true };
      await patchChatMetadata(chatId, { [DATA_KEY]: data });
      restorePendingReview();
      await syncLorebook({ silent: true });
      await checkNewSummaries({ refreshChat: false, baselineIfUnknown: true, renderAfter: false });
      toast("이 RP의 전용 로어북 백업에서 기억을 복구했습니다.");
      render();
    }
    async function confirmQuarantinedDataForCurrentChat() {
      const chatId = String(state.currentChat?.id || "");
      if (!chatId || !state.quarantinedData || !hasMeaningfulMemoryData(state.quarantinedData))
        throw new Error("확정할 격리 데이터가 없습니다.");
      const prepared = resetManagedPointersForOwner(state.quarantinedData, chatId);
      state.currentData = prepared.data;
      state.quarantinedData = null;
      state.ownershipDetachLorebookIds = [...new Set([...state.ownershipDetachLorebookIds, ...prepared.previousBookIds])];
      state.ownership = { status: "confirmed", reason: "", ownerChatId: chatId, evidence: "user-confirmed-copy", backup: state.ownership?.backup || null, discoveryChecked: true };
      await patchChatMetadata(chatId, { [DATA_KEY]: prepared.data });
      restorePendingReview();
      await syncLorebook({ silent: true });
      await checkNewSummaries({ refreshChat: false, baselineIfUnknown: true, renderAfter: false });
      toast("격리 데이터를 이 RP 소유의 독립 복사본으로 확정했습니다.");
      render();
    }
    function restorePendingReview() {
      state.reviewCandidates = [];
      state.reviewSelected.clear();
      state.reviewSourceRows = [];
      state.reviewEpisodes = [];
      state.reviewEpisodeSelected = new Set;
      state.reviewThreads = [];
      state.reviewThreadSelected = new Set;
      const pending = state.currentData?.pendingReview;
      if (!pending)
        return;
      state.reviewThreads = safeArray(pending.threads).map(normalizeThreadCandidate).filter(Boolean);
      const thSel = new Set(safeArray(pending.selectedThreadIds).map(String));
      state.reviewThreadSelected = new Set(state.reviewThreads.map((cand, i) => thSel.has(cand.candidateId) ? String(i) : null).filter(Boolean));
      state.reviewEpisodes = safeArray(pending.episodes).map(normalizeEpisodeCandidate).filter(Boolean);
      const epSel = new Set(safeArray(pending.selectedEpisodeIds).map(String));
      state.reviewEpisodeSelected = new Set(state.reviewEpisodes.map((cand, i) => epSel.has(cand.candidateId) ? String(i) : null).filter(Boolean));
      state.reviewCandidates = safeArray(pending.candidates).map(normalizeReviewCandidate).filter(Boolean);
      state.reviewSourceRows = safeArray(pending.sourceRows).map((row) => ({ ...row }));
      const selected = new Set(safeArray(pending.selectedIndices).map(String));
      const selectedIds = new Set(safeArray(pending.selectedCandidateIds).map(String));
      state.reviewSelected = new Set(state.reviewCandidates.map((candidate, index) => selectedIds.size ? selectedIds.has(candidate.candidateId) ? String(index) : null : selected.has(String(index)) ? String(index) : null).filter(Boolean));
    }
    async function persistPendingReview() {
      if (!state.currentData)
        return;
      const data = normalizeData(state.currentData);
      data.pendingReview = normalizePendingReview({
        candidates: state.reviewCandidates,
        selectedIndices: [...state.reviewSelected],
        selectedCandidateIds: state.reviewCandidates.filter((_, index) => state.reviewSelected.has(String(index))).map((candidate) => candidate.candidateId),
        episodes: state.reviewEpisodes,
        threads: state.reviewThreads,
        selectedThreadIds: state.reviewThreads.filter((_, index) => state.reviewThreadSelected.has(String(index))).map((cand) => cand.candidateId),
        selectedEpisodeIds: state.reviewEpisodes.filter((_, index) => state.reviewEpisodeSelected.has(String(index))).map((cand) => cand.candidateId),
        sourceRows: state.reviewSourceRows,
        batchKey: summaryBatchKey(state.reviewSourceRows),
        createdAt: data.pendingReview?.createdAt || nowIso()
      });
      await persistData(data, { sync: false, silent: true });
    }
    async function clearPendingReview() {
      if (state.currentData?.pendingReview) {
        const data = normalizeData(state.currentData);
        data.pendingReview = null;
        await persistData(data, { sync: false, silent: true });
      }
      state.reviewCandidates = [];
      state.reviewSelected.clear();
      state.reviewSourceRows = [];
      state.reviewEpisodes = [];
      state.reviewEpisodeSelected = new Set;
      state.reviewThreads = [];
      state.reviewThreadSelected = new Set;
    }
    async function refreshAll({ renderAfter = true } = {}) {
      await loadChats();
      await loadCurrentChat();
      if (!state.connections.length)
        await loadConnections();
      if (renderAfter)
        render();
    }
    function updateLauncherBadge() {
      const launcher = document.getElementById(LAUNCHER_ID);
      const badge = launcher?.querySelector?.(".mmc-launcher-badge");
      const count = state.pendingSummaryRows.length;
      if (!launcher || !badge)
        return;
      launcher.classList.toggle("has-summary-alert", count > 0);
      badge.hidden = count <= 0;
      badge.textContent = count > 9 ? "9+" : String(count);
      launcher.title = count > 0 ? `새 요약 ${count}개 · 기억 갱신 필요` : "기억 보관함";
    }
    async function checkNewSummaries({ refreshChat = true, baselineIfUnknown = true, renderAfter = false, refreshScenes = refreshChat } = {}) {
      const chatId = String(state.selectedChatId || "");
      if (!chatId || state.summaryCheckBusy || !ownershipAllowsData())
        return [];
      state.summaryCheckBusy = true;
      try {
        if (refreshChat) {
          const fresh = await api(`chats/${encodeURIComponent(chatId)}`);
          if (fresh && isRecord(fresh)) {
            const fallback = state.chats.find((chat) => chat.id === chatId) || {};
            state.currentChat = { ...fallback, ...state.currentChat, ...fresh, id: chatId, metadata: parseRecord(fresh.metadata) };
            await applyOwnershipForCurrentChat(parseRecord(state.currentChat.metadata)[DATA_KEY]);
            if (!ownershipAllowsData())
              return [];
          }
        }
        const rows = summaryRowsFromMetadata(state.currentChat?.metadata);
        const hasBaseline = Array.isArray(state.summaryKnownByChat[chatId]);
        let summaryPending = [];
        if (!hasBaseline && baselineIfUnknown) {
          state.summaryKnownByChat[chatId] = rows.map(summarySignature).slice(-260);
          await saveUiState();
        } else {
          const known = new Set(safeArray(state.summaryKnownByChat[chatId]).map(String));
          summaryPending = rows.filter((row) => !known.has(summarySignature(row)));
        }
        if (refreshScenes || state.amChatId !== chatId || !advancedMemoryEnabled())
          await refreshAdvancedMemoryScenes(chatId);
        state.pendingSummaryRows = [...summaryPending, ...state.pendingAmRows];
        updateLauncherBadge();
        if (renderAfter && !document.getElementById(ROOT_ID)?.hidden)
          render();
        if (summaryPending.length && !advancedMemoryEnabled())
          maybeAutoProcessSummaries();
        return state.pendingSummaryRows;
      } catch (error) {
        console.warn("[기억 보관함] summary check failed", error);
        return state.pendingSummaryRows;
      } finally {
        state.summaryCheckBusy = false;
      }
    }
    async function markSummaryRowsReviewed(rows) {
      const chatId = String(state.selectedChatId || "");
      if (!chatId)
        return;
      const seen = new Set(safeArray(state.summaryKnownByChat[chatId]).map(String));
      const amKey = amKnownKey(chatId);
      const sceneSeen = new Set(safeArray(state.summaryKnownByChat[amKey]).map(String));
      const reviewed = new Set;
      for (const row of safeArray(rows)) {
        const sig = summarySignature(row);
        (row?.sourceKind === AM_SCENE_SOURCE ? sceneSeen : seen).add(sig);
        reviewed.add(sig);
      }
      state.summaryKnownByChat[chatId] = Array.from(seen).slice(-260);
      if (sceneSeen.size || Array.isArray(state.summaryKnownByChat[amKey]))
        state.summaryKnownByChat[amKey] = Array.from(sceneSeen).slice(-260);
      state.pendingAmRows = state.pendingAmRows.filter((row) => !reviewed.has(summarySignature(row)));
      state.pendingSummaryRows = state.pendingSummaryRows.filter((row) => !reviewed.has(summarySignature(row)));
      updateLauncherBadge();
      await saveUiState();
      await checkNewSummaries({ refreshChat: false, baselineIfUnknown: false, renderAfter: false });
    }
    async function maybeAutoProcessSummaries() {
      if (!ownershipAllowsData() || advancedMemoryEnabled())
        return;
      if (!state.pendingSummaryRows.length)
        return;
      if (!["auto_review", "auto_apply"].includes(state.summaryUpdateMode))
        return;
      if (state.autoReviewBusy || state.busy || state.layer || state.reviewSourceRows.length)
        return;
      const chatId = String(state.selectedChatId || "");
      if (!chatId)
        return;
      const batchKey = summaryBatchKey(state.pendingSummaryRows);
      if (!batchKey || String(state.summaryAutoAttemptByChat[chatId] || "") === batchKey)
        return;
      if (!state.connections.length)
        await loadConnections();
      state.modelConnectionId = chooseDefaultConnection(state.currentChat);
      if (!state.modelConnectionId) {
        console.warn("[기억 보관함] 자동 요약 정리: 사용할 모델 연결이 없습니다.");
        return;
      }
      state.summaryAutoAttemptByChat[chatId] = batchKey;
      await saveUiState();
      state.autoReviewBusy = true;
      const rows = state.pendingSummaryRows.slice();
      state.sourceMode = "summaries";
      state.sourceTarget = "review";
      state.sourceRows = rows.slice();
      state.sourceSelected = new Set(rows.map((row) => String(row.id || "")));
      try {
        const generated = await generateReviewCandidates(rows, { showLayer: false });
        if (!generated)
          return;
        if (state.summaryUpdateMode === "auto_apply" && state.reviewCandidates.some(scopeBlocksApply)) {
          toast(`일부 인물만 아는 내용이 있어 자동 적용하지 않고 후보 ${state.reviewCandidates.length}개를 검토 대기에 남겼어요.`);
          render();
        } else if (state.summaryUpdateMode === "auto_apply") {
          const actionable = state.reviewCandidates.some((item, i) => item.action !== "keep" && state.reviewSelected.has(String(i)));
          if (actionable) {
            await applyReviewCandidates({ auto: true });
          } else {
            await clearPendingReview();
            await markSummaryRowsReviewed(rows);
            toast("자동 정리 결과 새로 반영할 기억이 없어 이번 요약을 검토 완료 처리했습니다.");
            render();
          }
        } else {
          toast(`새 요약 자동 분석 완료 · 후보 ${state.reviewCandidates.length}개`);
          render();
        }
      } catch (error) {
        console.warn("[기억 보관함] 자동 요약 정리 실패", error);
        if (!state.currentData?.pendingReview) {
          delete state.summaryAutoAttemptByChat[chatId];
          await saveUiState();
        }
        toast(`자동 요약 정리 실패: ${error.message || "모델 호출을 확인해 주세요."}`, true);
        render();
      } finally {
        state.autoReviewBusy = false;
      }
    }
    function observedChatDetailRequest(input, init) {
      try {
        const rawUrl = typeof input === "string" || input instanceof URL ? String(input) : String(input?.url || "");
        if (!rawUrl || !rawUrl.includes("/api/chats/"))
          return null;
        const base = window.location?.origin || "http://localhost";
        const url = new URL(rawUrl, base);
        const method = String(init?.method || typeof input === "object" && input?.method || "GET").toUpperCase();
        if (method !== "GET")
          return null;
        const am = url.pathname.match(/\/api\/chats\/([^/?#]+)\/advanced-memory\/?$/);
        if (am)
          return { chatId: decodeURIComponent(am[1]), kind: "advanced-memory" };
        const match = url.pathname.match(/\/api\/chats\/([^/?#]+)\/?$/);
        if (!match)
          return null;
        return { chatId: decodeURIComponent(match[1]) };
      } catch {
        return null;
      }
    }
    function refreshSummaryAlertDom() {
      updateLauncherBadge();
      const root = document.getElementById(ROOT_ID);
      if (!root || root.hidden)
        return;
      if (state.activeTab === "overview" && !state.layer && !state.busy) {
        render();
        return;
      }
      const slot = root.querySelector("[data-mmc-summary-alert-slot]");
      if (slot)
        slot.innerHTML = statusBanners();
    }
    async function acceptObservedChatSnapshot(chatId, payload) {
      await ensureUiLoaded();
      if (chatId && isRecord(payload) && chatId !== String(state.selectedChatId || "") && isInheritedBranch({ ...payload, id: chatId, metadata: parseRecord(payload.metadata) })) {
        await splitInheritedBranch(chatId);
        return;
      }
      if (!chatId || chatId !== String(state.selectedChatId || "") || !payload || !isRecord(payload))
        return;
      const metadata = parseRecord(payload.metadata);
      const existingMeta = parseRecord(state.currentChat?.metadata);
      const fallback = state.chats.find((chat) => chat.id === chatId) || {};
      state.currentChat = {
        ...fallback,
        ...state.currentChat,
        id: chatId,
        metadata: {
          ...existingMeta,
          summary: metadata.summary,
          summaryEntries: metadata.summaryEntries,
          lastAutomaticSummaryMessageId: metadata.lastAutomaticSummaryMessageId,
          advancedMemory: metadata.advancedMemory,
          groupChatMode: metadata.groupChatMode
        }
      };
      const rows = summaryRowsFromMetadata(metadata);
      const hasBaseline = Array.isArray(state.summaryKnownByChat[chatId]);
      let summaryPending = [];
      if (!hasBaseline) {
        state.summaryKnownByChat[chatId] = rows.map(summarySignature).slice(-260);
        await saveUiState();
      } else {
        const known = new Set(safeArray(state.summaryKnownByChat[chatId]).map(String));
        summaryPending = rows.filter((row) => !known.has(summarySignature(row)));
      }
      state.pendingSummaryRows = [...summaryPending, ...state.pendingAmRows];
      refreshSummaryAlertDom();
      if (summaryPending.length && ownershipAllowsData() && !advancedMemoryEnabled())
        maybeAutoProcessSummaries();
    }
    async function acceptObservedAmSnapshot(chatId, payload) {
      await ensureUiLoaded();
      if (!chatId || chatId !== String(state.selectedChatId || "") || !isRecord(payload) || !advancedMemoryEnabled() || !ownershipAllowsData())
        return;
      await acceptAmStatus(chatId, payload);
      const summaryPending = state.pendingSummaryRows.filter((row) => row?.sourceKind !== AM_SCENE_SOURCE);
      state.pendingSummaryRows = [...summaryPending, ...state.pendingAmRows];
      refreshSummaryAlertDom();
    }
    function installPassiveSummaryObserver() {
      if (state.passiveFetchCleanup || typeof window.fetch !== "function")
        return;
      const originalFetch = window.fetch;
      const wrappedFetch = function(input, init) {
        const observed = observedChatDetailRequest(input, init);
        const result = originalFetch.call(this, input, init);
        if (observed) {
          Promise.resolve(result).then((response) => {
            if (!response?.ok)
              return;
            let clone = null;
            try {
              clone = response.clone();
            } catch {
              return;
            }
            clone.json().then((payload) => observed.kind === "advanced-memory" ? acceptObservedAmSnapshot(observed.chatId, payload) : acceptObservedChatSnapshot(observed.chatId, payload)).catch(() => {});
          }).catch(() => {});
        }
        return result;
      };
      window.fetch = wrappedFetch;
      state.passiveFetchCleanup = () => {
        if (window.fetch === wrappedFetch)
          window.fetch = originalFetch;
        state.passiveFetchCleanup = null;
      };
      cleanupFns.push(() => state.passiveFetchCleanup?.());
    }
    function isInheritedBranch(chat) {
      const meta = parseRecord(chat?.metadata);
      const raw = parseRecord(meta[DATA_KEY]);
      const parent = String(meta.branchParentChatId || "");
      const owner = String(raw.ownerChatId || parseRecord(raw.elementMemory).originChatId || "");
      return !!parent && !!owner && owner === parent && owner !== String(chat?.id || "") && hasMeaningfulMemoryData(raw);
    }
    async function splitInheritedBranch(chatId) {
      const root = document.getElementById(ROOT_ID);
      if (state.branchSplitBusy || state.busy || state.layer || root && !root.hidden)
        return false;
      await ensureUiLoaded();
      state.branchSplitBusy = true;
      const previous = String(state.selectedChatId || "");
      try {
        state.selectedChatId = chatId;
        await loadCurrentChat();
        return true;
      } catch (error) {
        console.warn("[기억 보관함] branch split failed", error);
        return false;
      } finally {
        state.selectedChatId = previous || chatId;
        try {
          if (previous && previous !== chatId)
            await loadCurrentChat();
        } catch {}
        state.branchSplitBusy = false;
      }
    }
    async function splitInheritedBranches() {
      for (const chat of state.chats.filter(isInheritedBranch).slice(0, 12))
        await splitInheritedBranch(chat.id);
    }
    async function primeSummaryObserver() {
      try {
        await loadUiState();
        await loadChats();
        await splitInheritedBranches();
        await loadCurrentChat();
        await checkNewSummaries({ refreshChat: false, baselineIfUnknown: true, renderAfter: false });
      } catch (error) {
        console.warn("[기억 보관함] summary observer init failed", error);
      }
    }
    async function patchChatMetadata(chatId, patch) {
      await api(`chats/${encodeURIComponent(chatId)}/metadata`, { method: "PATCH", body: patch });
      const row = state.chats.find((chat) => chat.id === chatId);
      if (row)
        row.metadata = { ...parseRecord(row.metadata), ...patch };
      if (state.currentChat?.id === chatId)
        state.currentChat.metadata = { ...parseRecord(state.currentChat.metadata), ...patch };
    }
    async function verifyOwnershipBeforePersist() {
      const chatId = String(state.currentChat?.id || "");
      const fresh = await api(`chats/${encodeURIComponent(chatId)}`);
      const raw = parseRecord(fresh?.metadata)[DATA_KEY];
      const owner = String(parseRecord(raw).ownerChatId || "");
      if (owner === chatId)
        return;
      if (state.ownership?.status === "new" && !hasMeaningfulMemoryData(raw))
        return;
      const fallback = state.chats.find((chat) => chat.id === chatId) || {};
      state.currentChat = { ...fallback, ...state.currentChat, ...fresh, id: chatId, metadata: parseRecord(fresh?.metadata) };
      await applyOwnershipForCurrentChat(raw);
      render();
      throw new Error("저장 직전 RP 소유권이 달라져 작업을 중단하고 데이터를 격리했습니다.");
    }
    async function persistData(data, { sync = true, silent = false } = {}) {
      if (!state.currentChat?.id)
        throw new Error("RP방을 먼저 선택해 주세요.");
      if (!ownershipAllowsData())
        throw new Error("소유권 확인 전에는 기억을 저장하거나 동기화할 수 없습니다.");
      await verifyOwnershipBeforePersist();
      const next = normalizeData(data);
      next.ownerChatId = String(state.currentChat.id);
      if (!next.elementMemory.originChatId)
        next.elementMemory.originChatId = String(state.currentChat.id);
      if (!next.wiki.originChatId)
        next.wiki.originChatId = String(state.currentChat.id);
      next.updatedAt = nowIso();
      await patchChatMetadata(state.currentChat.id, { [DATA_KEY]: next });
      state.currentData = next;
      if (sync) {
        try {
          await syncLorebook({ silent: true });
        } catch (error) {
          toast(`기억은 저장했지만 로어북 동기화에 실패했어요. 머리줄의 동기화 버튼으로 다시 시도해 주세요. (${error?.message || "오류"})`, true);
          return state.currentData;
        }
      }
      if (!silent)
        toast("저장했습니다.");
      return state.currentData;
    }
    async function freshOwnedData() {
      const fresh = await api(`chats/${encodeURIComponent(state.selectedChatId)}`);
      const raw = parseRecord(fresh?.metadata)[DATA_KEY];
      const rawOwner = String(parseRecord(raw).ownerChatId || "");
      if (!rawOwner && state.ownership?.status === "new" && !hasMeaningfulMemoryData(raw)) {
        const data = normalizeData(raw);
        data.ownerChatId = String(state.selectedChatId || "");
        return data;
      }
      if (rawOwner !== String(state.selectedChatId || "")) {
        const fallback = state.chats.find((chat) => chat.id === state.selectedChatId) || {};
        state.currentChat = { ...fallback, ...state.currentChat, ...fresh, id: state.selectedChatId, metadata: parseRecord(fresh?.metadata) };
        await applyOwnershipForCurrentChat(raw);
        render();
        throw new Error("저장 직전 RP 소유권이 달라져 작업을 중단하고 데이터를 격리했습니다.");
      }
      return normalizeData(raw);
    }
    function prioritySort(a, b) {
      const p = (PRIORITY_WEIGHT[a.priority] ?? 1) - (PRIORITY_WEIGHT[b.priority] ?? 1);
      if (p)
        return p;
      return String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));
    }
    function activePromises(data = state.currentData) {
      return safeArray(data?.items).filter((item) => item.type === "promise" && item.status === "active").sort(prioritySort);
    }
    function activeAlwaysAnchors(data = state.currentData) {
      return safeArray(data?.items).filter((item) => item.type === "anchor" && item.active && !item.archived && item.activation === "always").sort(prioritySort);
    }
    function activeKeywordAnchors(data = state.currentData) {
      return safeArray(data?.items).filter((item) => item.type === "anchor" && item.active && !item.archived && item.activation === "keyword" && item.keywords.length).sort(prioritySort);
    }
    function anchorLine(item) {
      return `- [${ANCHOR_CATEGORY_LABEL[item.category] || "기억"}] ${truncate(item.title, 90)}: ${truncate(item.content, 360)}`;
    }
    function titleKey(value) {
      return String(value || "").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
    }
    function dedupeByTitle(list) {
      const seen = new Set;
      const kept = [];
      const dropped = [];
      for (const item of safeArray(list)) {
        const key = `${item.type}|${titleKey(item.title)}|${normalizeKnownBy(item.knownBy).slice().sort().join(",")}`;
        if (titleKey(item.title) && seen.has(key)) {
          dropped.push(item);
          continue;
        }
        seen.add(key);
        kept.push(item);
      }
      return { kept, dropped };
    }
    function anchorInjectionPlan(data = state.currentData) {
      const normalized = normalizeData(data || {});
      const deduped = dedupeByTitle(activeAlwaysAnchors(normalized));
      const all = deduped.kept;
      const considered = all.slice(0, normalized.maxAnchors);
      const budget = normalized.anchorBudgetChars;
      const selected = [];
      const excluded = all.slice(normalized.maxAnchors);
      let used = 0;
      for (const item of considered) {
        const cost = anchorLine(item).length + 1;
        if (!selected.length || used + cost <= budget) {
          selected.push(item);
          used += cost;
        } else
          excluded.push(item);
      }
      return { candidates: all, considered, selected, excluded, used, budget, duplicates: deduped.dropped };
    }
    function injectionPlan(data = state.currentData) {
      const d = normalizeData(data || {});
      const promiseDedupe = dedupeByTitle(activePromises(d));
      const promises = promiseDedupe.kept.slice(0, d.maxPromises);
      const aplan = anchorInjectionPlan(d);
      const anchors = aplan.selected.slice();
      const extra = typeof injectionPlanLayers === "function" ? injectionPlanLayers(d) : { threads: [], duplicates: [] };
      const threads = safeArray(extra.threads).slice();
      const cap = Math.max(0, Number(d.alwaysBudgetTokens) || 0);
      const capHeld = [];
      if (cap > 0) {
        const cost = (item) => estimateTokens(item.type === "thread" ? `${item.title} ${item.currentState || ""}` : `${item.title} ${truncate(item.content, 360)}`) + 4;
        let total = [...promises, ...anchors, ...threads].reduce((sum, item) => sum + cost(item), 0);
        const pool = [...promises, ...anchors, ...threads].filter((item) => item.priority !== "high").sort((a, b) => (PRIORITY_WEIGHT[b.priority] ?? 1) - (PRIORITY_WEIGHT[a.priority] ?? 1) || String(a.updatedAt || "").localeCompare(String(b.updatedAt || "")));
        while (total > cap && pool.length) {
          const item = pool.shift();
          for (const list of [promises, anchors, threads]) {
            const i = list.indexOf(item);
            if (i >= 0)
              list.splice(i, 1);
          }
          capHeld.push(item);
          total -= cost(item);
        }
      }
      return { promises, anchors, threads, capHeld, duplicates: [...promiseDedupe.dropped, ...aplan.duplicates, ...safeArray(extra.duplicates)], overflowPromises: promiseDedupe.kept.slice(d.maxPromises), anchorPlan: aplan };
    }
    function managedBookMarker(chatId) {
      return `${BOOK_MARKER} chat:${chatId}`;
    }
    async function readChatMetadata(chatId) {
      try {
        const chat = await api(`chats/${encodeURIComponent(chatId)}`);
        return parseRecord(chat?.metadata);
      } catch {
        return parseRecord(state.chats.find((x) => x.id === chatId)?.metadata);
      }
    }
    async function inspectOwnershipResources(chat, rawData) {
      const metadata = parseRecord(chat?.metadata);
      const raw = parseRecord(rawData);
      const activeIds = safeArray(metadata.activeLorebookIds).map(String).filter(Boolean);
      const wantedIds = new Set([...activeIds, String(raw.lorebookId || "")].filter(Boolean));
      const booksById = new Map;
      let discoveryChecked = false;
      try {
        const payload = await api(`lorebooks?chatId=${encodeURIComponent(chat.id)}`);
        for (const book of extractArray(payload, ["lorebooks", "items", "results"]))
          if (book?.id)
            booksById.set(String(book.id), book);
        discoveryChecked = true;
      } catch {}
      for (const id of wantedIds) {
        if (booksById.has(id))
          continue;
        try {
          const book = await api(`lorebooks/${encodeURIComponent(id)}`);
          if (book?.id)
            booksById.set(String(book.id), book);
        } catch {}
      }
      const directBook = booksById.get(String(raw.lorebookId || "")) || null;
      const directOwner = managedBookOwner(directBook);
      const foreignActiveIds = [];
      const matchingBooks = [];
      for (const [id, book] of booksById) {
        const owner = managedBookOwner(book);
        if (owner.ownerChatId === String(chat.id))
          matchingBooks.push(book);
        else if (activeIds.includes(id) && owner.ownerChatId && owner.ownerChatId !== String(chat.id))
          foreignActiveIds.push(id);
      }
      let backup = null;
      for (const book of matchingBooks) {
        try {
          const entries = extractArray(await api(`lorebooks/${encodeURIComponent(book.id)}/entries`), ["entries", "items", "results"]);
          for (const entry of entries) {
            const parsed = parseBackupEntry(entry, chat.id);
            if (parsed && (!backup || String(parsed.savedAt).localeCompare(String(backup.savedAt)) > 0))
              backup = { ...parsed, bookId: String(book.id) };
          }
        } catch {}
      }
      return {
        discoveryChecked,
        bookOwnerChatId: directOwner.ownerChatId,
        bookEvidence: directOwner.evidence,
        backup,
        foreignActiveIds
      };
    }
    async function detachLorebooks(chatId, removeIds = []) {
      const remove = new Set(safeArray(removeIds).map(String).filter(Boolean));
      if (!remove.size)
        return;
      const meta = await readChatMetadata(chatId);
      const current = safeArray(meta.activeLorebookIds).map(String);
      const next = current.filter((id) => !remove.has(id));
      if (JSON.stringify(current) !== JSON.stringify(next))
        await patchChatMetadata(chatId, { activeLorebookIds: next });
    }
    async function attachLorebook(chatId, lorebookId, removeIds = []) {
      const meta = await readChatMetadata(chatId);
      const remove = new Set(safeArray(removeIds).map(String).filter(Boolean));
      const current = safeArray(meta.activeLorebookIds).map(String);
      const next = [...new Set([...current.filter((id) => !remove.has(id)), String(lorebookId)])];
      if (JSON.stringify(current) !== JSON.stringify(next))
        await patchChatMetadata(chatId, { activeLorebookIds: next });
    }
    async function findManagedBook(chat, data) {
      if (data.lorebookId) {
        try {
          const book = await api(`lorebooks/${encodeURIComponent(data.lorebookId)}`);
          const marker = managedBookMarker(chat.id);
          const belongsHere = String(book?.description || "").includes(marker) || String(book?.chatId || "") === String(chat.id);
          if (book?.id && belongsHere)
            return book;
        } catch {}
      }
      const payload = await api(`lorebooks?chatId=${encodeURIComponent(chat.id)}`);
      const books = extractArray(payload, ["lorebooks", "items", "results"]);
      const marker = managedBookMarker(chat.id);
      return books.find((book) => String(book?.description || "").includes(marker)) || books.find((book) => safeArray(book?.tags).includes(LOREBOOK_TAG) && String(book?.chatId || "") === String(chat.id)) || null;
    }
    async function ensureManagedBook(chat, data) {
      let book = await findManagedBook(chat, data);
      const payload = {
        name: `기억 보관함 · ${chatLabel(chat)}`,
        description: `기억 보관함 확장이 이 RP 전용으로 관리하는 주입 로어북입니다. 확장 안의 기록이 원본이며, 이 로어북은 동기화 결과입니다.
${managedBookMarker(chat.id)}`,
        category: "uncategorized",
        scanDepth: 4,
        tokenBudget: Math.max(2400, Math.ceil((Number(data.anchorBudgetChars) || 2400) / 3) + 1800 + wikiBookBudgetBonus(data)),
        recursiveScanning: true,
        excludeFromVectorization: true,
        chatId: chat.id,
        isGlobal: false,
        enabled: true,
        scope: { mode: "specific", chatIds: [chat.id] },
        tags: [...new Set([...safeArray(book?.tags), LOREBOOK_TAG, "extension-managed"])],
        generatedBy: "user"
      };
      if (!book)
        book = await api("lorebooks", { method: "POST", body: payload });
      else {
        await api(`lorebooks/${encodeURIComponent(book.id)}`, { method: "PATCH", body: payload });
        book = { ...book, ...payload };
      }
      if (!book?.id)
        throw new Error("전용 로어북을 만들지 못했습니다.");
      return { ...book, id: String(book.id) };
    }
    function wikiBookBudgetBonus(data) {
      const wiki = normalizeWiki(data?.wiki);
      if (!wiki.injectionEnabled)
        return 0;
      const always = Math.ceil(wiki.alwaysBudgetChars / 3);
      const docs = Math.min(6, wiki.docs.filter((doc) => wikiDocInjectable(doc, wiki)).length) * 600;
      return always + docs;
    }
    function sharedPromises(data) {
      return injectionPlan(data).promises.filter((item) => !isRestrictedItem(item));
    }
    function sharedAnchors(data) {
      return injectionPlan(data).anchors.filter((item) => !isRestrictedItem(item));
    }
    function restrictedInjectionItems(data) {
      const normalized = normalizeData(data || {});
      const plan = injectionPlan(normalized);
      return [...plan.promises, ...plan.anchors].filter(isRestrictedItem);
    }
    function restrictedContext(chat, item) {
      const names = knownByLabel(item.knownBy);
      const line = item.type === "promise" ? `- ${item.priority === "high" ? "[중요] " : ""}${truncate(item.title, 90)}: ${truncate(item.content, 320)}${item.scheduleText ? ` / 예정: ${truncate(item.scheduleText, 90)}` : ""}` : anchorLine(item);
      return [
        RESTRICTED_MARKER,
        `[${item.type === "promise" ? "약속" : "기억 앵커"} · ${chatLabel(chat)} · ${names}만 아는 기억]`,
        `아래 내용은 ${names}만 알고 있다. 이것을 모르는 인물이 알고 있는 것처럼 말하거나 행동하게 하지 마라.`,
        line
      ].join(`
`);
    }
    function restrictedEntryPayload(chat, item, enabled) {
      return {
        ...constantEntryPayload({
          tag: RESTRICTED_ENTRY_TAG,
          name: `${item.type === "promise" ? "약속" : "기억 앵커"} · ${truncate(item.title, 100)} · 일부만 앎`,
          content: restrictedContext(chat, item),
          enabled,
          order: item.type === "promise" ? 31 : 34,
          dynamicState: { memoryCabinetChatId: String(chat.id), memoryCabinetItemId: String(item.id), managedBy: LOREBOOK_TAG, kind: "restricted" }
        }),
        characterFilterMode: "include",
        characterFilterIds: normalizeKnownBy(item.knownBy)
      };
    }
    function promiseContext(chat, data) {
      const items = sharedPromises(data);
      const lines = [
        PROMISE_MARKER,
        `[약속 · ${chatLabel(chat)}]`,
        "아래는 사용자가 직접 보관한 현재 유효한 약속·계획이다."
      ];
      for (const item of items) {
        const schedule = item.scheduleText ? ` / 예정: ${truncate(item.scheduleText, 90)}` : "";
        lines.push(`- ${item.priority === "high" ? "[중요] " : ""}${truncate(item.title, 90)}: ${truncate(item.content, 320)}${schedule}`);
      }
      lines.push("관련 상황에서 자연스럽게 기억하되 목록을 먼저 낭독하지 말고, 기록에 없는 약속을 새로 만들지 마라.");
      lines.push("같은 일에 대해 이 기록이 떠올린 옛 장면·요약과 다르면 이 기록을 최신 상태로 본다.");
      return lines.join(`
`);
    }
    function anchorContext(chat, data) {
      const items = sharedAnchors(data);
      const lines = [
        ANCHOR_MARKER,
        `[기억 앵커 · ${chatLabel(chat)}]`,
        "아래는 이 RP에서 당장 잊으면 안 되는 사용자가 고정한 사실이다."
      ];
      for (const item of items)
        lines.push(anchorLine(item));
      lines.push("현재 서사와 충돌하지 않는 범위에서 지속적으로 유지하라. 목록 자체를 대사로 낭독하지 마라.");
      lines.push("같은 일에 대해 이 기록이 떠올린 옛 장면·요약과 다르면 이 기록을 최신 상태로 본다.");
      return lines.join(`
`);
    }
    function keywordContext(chat, item) {
      return [
        KEYWORD_MARKER,
        `[조건부 기억 앵커 · ${chatLabel(chat)}]`,
        `[${ANCHOR_CATEGORY_LABEL[item.category] || "기억"}] ${item.title}: ${item.content}`,
        "이 기억은 관련 키워드/상황에서만 자연스럽게 참조하고, 목록이나 시스템 지시처럼 언급하지 마라."
      ].join(`
`);
    }
    function constantEntryPayload({ tag, name, content, enabled, order, dynamicState }) {
      return {
        name,
        content,
        description: `${name} · 기억 보관함 자동 관리`,
        keys: [],
        secondaryKeys: [],
        enabled,
        constant: true,
        selective: false,
        probability: null,
        scanDepth: null,
        matchWholeWords: false,
        caseSensitive: false,
        useRegex: false,
        position: 0,
        depth: 4,
        order,
        role: "system",
        preventRecursion: true,
        excludeRecursion: false,
        delayUntilRecursion: false,
        excludeFromVectorization: true,
        tag,
        dynamicState
      };
    }
    function backupEntryPayload(chat, data) {
      const snapshot = normalizeData(data);
      snapshot.ownerChatId = String(chat.id);
      const savedAt = nowIso();
      return {
        name: "기억 보관함 · 구조화 백업",
        content: `${BACKUP_MARKER}
${JSON.stringify({ marker: BACKUP_MARKER, ownerChatId: String(chat.id), savedAt, data: snapshot })}`,
        description: `기억 보관함 비활성 복구 백업 · owner:${chat.id}`,
        keys: [],
        secondaryKeys: [],
        enabled: false,
        constant: false,
        selective: false,
        probability: null,
        scanDepth: null,
        matchWholeWords: false,
        caseSensitive: false,
        useRegex: false,
        position: 0,
        depth: 4,
        order: 999,
        role: "system",
        preventRecursion: true,
        excludeRecursion: true,
        delayUntilRecursion: false,
        excludeFromVectorization: true,
        tag: BACKUP_ENTRY_TAG,
        dynamicState: { memoryCabinetChatId: String(chat.id), managedBy: LOREBOOK_TAG, kind: "structured-backup", inactiveBackup: true }
      };
    }
    function keywordEntryPayload(chat, item) {
      return {
        name: `기억 앵커 · ${truncate(item.title, 120)}`,
        content: keywordContext(chat, item),
        description: `기억 보관함 조건부 앵커 · item:${item.id}`,
        keys: item.keywords.slice(0, 24),
        secondaryKeys: [],
        enabled: true,
        constant: false,
        selective: false,
        probability: null,
        scanDepth: null,
        matchWholeWords: false,
        caseSensitive: false,
        useRegex: false,
        position: 0,
        depth: 4,
        order: item.priority === "high" ? 35 : item.priority === "low" ? 55 : 45,
        role: "system",
        preventRecursion: true,
        excludeRecursion: false,
        delayUntilRecursion: false,
        excludeFromVectorization: true,
        tag: KEYWORD_ENTRY_TAG,
        dynamicState: { memoryCabinetChatId: String(chat.id), memoryCabinetItemId: String(item.id), managedBy: LOREBOOK_TAG },
        ...isRestrictedItem(item) ? { enabled: restrictionEffective(chat), characterFilterMode: "include", characterFilterIds: normalizeKnownBy(item.knownBy) } : { characterFilterMode: "any", characterFilterIds: [] }
      };
    }
    async function upsertEntry(bookId, entries, entryId, matcher, rawPayload) {
      const payload = { ...rawPayload, locked: true };
      let entry = null;
      if (entryId)
        entry = entries.find((row) => String(row.id) === String(entryId)) || null;
      if (!entry)
        entry = entries.find(matcher) || null;
      if (entry?.id) {
        const updated = await api(`lorebooks/${encodeURIComponent(bookId)}/entries/${encodeURIComponent(entry.id)}`, { method: "PATCH", body: payload });
        return String(updated?.id || entry.id);
      }
      const created = await api(`lorebooks/${encodeURIComponent(bookId)}/entries`, { method: "POST", body: payload });
      if (!created?.id)
        throw new Error("로어북 항목을 만들지 못했습니다.");
      return String(created.id);
    }
    const SYNC_CONTENT_KEYS = ["enabled", "maxPromises", "maxAnchors", "anchorBudgetChars", "items"];
    function syncContentKey(raw) {
      const d = normalizeData(raw || {});
      return JSON.stringify([SYNC_CONTENT_KEYS.map((k) => d[k]), d.episodes || [], d.episodeInjection, d.threads || [], d.alwaysBudgetTokens, d.elementMemory.entities, d.elementMemory.injectionEnabled, d.elementMemory.injectionPrompt, d.wiki.docs, d.wiki.injectionEnabled, d.wiki.alwaysBudgetChars, d.wiki.injectionPrompt]);
    }
    function mergeSyncPointers(latestRaw, synced) {
      const next = normalizeData(latestRaw);
      for (const key of ["ownerChatId", "lorebookId", "promiseEntryId", "anchorEntryId", "backupEntryId", "keywordEntryIds", "lastSyncAt", "lastSyncError"])
        next[key] = synced[key];
      if (synced.restrictedEntryIds || next.restrictedEntryIds)
        next.restrictedEntryIds = parseRecord(synced.restrictedEntryIds);
      for (const key of ["episodeEntryIds", "threadEntryId", "threadRestrictedEntryIds"])
        if (synced[key] !== undefined || next[key] !== undefined)
          next[key] = synced[key];
      next.elementMemory.headerEntryId = synced.elementMemory.headerEntryId;
      next.elementMemory.entityEntryIds = synced.elementMemory.entityEntryIds;
      next.elementMemory.originChatId = synced.elementMemory.originChatId || next.elementMemory.originChatId;
      next.wiki.headerEntryId = synced.wiki.headerEntryId;
      next.wiki.alwaysEntryId = synced.wiki.alwaysEntryId;
      next.wiki.docEntryIds = synced.wiki.docEntryIds;
      next.wiki.originChatId = synced.wiki.originChatId || next.wiki.originChatId;
      return next;
    }
    async function writeSyncResult(chat, synced) {
      const sameChat = String(state.currentChat?.id || "") === String(chat.id);
      const base = sameChat ? state.currentData : parseRecord((await readChatMetadata(chat.id))[DATA_KEY]);
      const merged = mergeSyncPointers(base, synced);
      await patchChatMetadata(chat.id, { [DATA_KEY]: merged });
      if (sameChat)
        state.currentData = merged;
      if (syncContentKey(merged) !== syncContentKey(synced))
        state.syncAgain = true;
    }
    async function syncLorebook({ silent = false } = {}) {
      if (!state.currentChat || !state.currentData)
        return;
      if (state.syncPromise) {
        state.syncAgain = true;
        return state.syncPromise;
      }
      state.syncPromise = (async () => {
        let rounds = 0;
        do {
          state.syncAgain = false;
          await syncLorebookOnce({ silent: silent || rounds > 0 });
          rounds += 1;
        } while (state.syncAgain && rounds < 4);
      })();
      try {
        return await state.syncPromise;
      } finally {
        state.syncPromise = null;
      }
    }
    async function syncLorebookOnce({ silent = false } = {}) {
      if (!state.currentChat || !state.currentData)
        return;
      if (!ownershipAllowsData())
        throw new Error("격리된 기억은 로어북에 동기화할 수 없습니다.");
      await verifyOwnershipBeforePersist();
      state.syncing = true;
      const chat = state.currentChat;
      const data = normalizeData(state.currentData);
      data.ownerChatId = String(chat.id);
      try {
        const previousBookId = String(data.lorebookId || "");
        const book = await ensureManagedBook(chat, data);
        const detachIds = [...new Set([...previousBookId && previousBookId !== String(book.id) ? [previousBookId] : [], ...state.ownershipDetachLorebookIds])];
        await attachLorebook(chat.id, book.id, detachIds);
        const rows = extractArray(await api(`lorebooks/${encodeURIComponent(book.id)}/entries`), ["entries", "items", "results"]);
        const promises = sharedPromises(data);
        data.promiseEntryId = await upsertEntry(book.id, rows, data.promiseEntryId, (entry) => entry?.tag === PROMISE_ENTRY_TAG || String(entry?.content || "").includes(PROMISE_MARKER), constantEntryPayload({
          tag: PROMISE_ENTRY_TAG,
          name: "약속 · 진행 중",
          content: promiseContext(chat, data),
          enabled: data.enabled && promises.length > 0,
          order: 30,
          dynamicState: { memoryCabinetChatId: String(chat.id), managedBy: LOREBOOK_TAG, kind: "promises" }
        }));
        const anchors = sharedAnchors(data);
        data.anchorEntryId = await upsertEntry(book.id, rows, data.anchorEntryId, (entry) => entry?.tag === ANCHOR_ENTRY_TAG || String(entry?.content || "").includes(ANCHOR_MARKER), constantEntryPayload({
          tag: ANCHOR_ENTRY_TAG,
          name: "기억 앵커 · 항상 기억",
          content: anchorContext(chat, data),
          enabled: data.enabled && anchors.length > 0,
          order: 32,
          dynamicState: { memoryCabinetChatId: String(chat.id), managedBy: LOREBOOK_TAG, kind: "anchors" }
        }));
        const keywordItems = dedupeByTitle(activeKeywordAnchors(data)).kept;
        const existingKeywordEntries = rows.filter((entry) => entry?.tag === KEYWORD_ENTRY_TAG || entry?.tag !== RESTRICTED_ENTRY_TAG && String(parseRecord(entry?.dynamicState).memoryCabinetItemId || "").trim());
        const nextMap = {};
        for (const item of keywordItems) {
          const knownId = String(data.keywordEntryIds?.[item.id] || "");
          const id = await upsertEntry(book.id, rows, knownId, (entry) => String(parseRecord(entry?.dynamicState).memoryCabinetItemId || "") === item.id, keywordEntryPayload(chat, item));
          nextMap[item.id] = id;
        }
        const activeIds = new Set(Object.values(nextMap).map(String));
        for (const entry of existingKeywordEntries) {
          if (!entry?.id || activeIds.has(String(entry.id)))
            continue;
          try {
            await api(`lorebooks/${encodeURIComponent(book.id)}/entries/${encodeURIComponent(entry.id)}`, { method: "PATCH", body: { enabled: false } });
          } catch {}
        }
        const restrictedOn = data.enabled && restrictionEffective(chat);
        const existingRestricted = rows.filter((entry) => entry?.tag === RESTRICTED_ENTRY_TAG);
        const nextRestricted = {};
        for (const item of restrictedInjectionItems(data)) {
          nextRestricted[item.id] = await upsertEntry(book.id, rows, String(parseRecord(data.restrictedEntryIds)[item.id] || ""), (entry) => entry?.tag === RESTRICTED_ENTRY_TAG && String(parseRecord(entry?.dynamicState).memoryCabinetItemId || "") === item.id, restrictedEntryPayload(chat, item, restrictedOn));
        }
        const restrictedActive = new Set(Object.values(nextRestricted).map(String));
        for (const entry of existingRestricted) {
          if (!entry?.id || restrictedActive.has(String(entry.id)))
            continue;
          try {
            await api(`lorebooks/${encodeURIComponent(book.id)}/entries/${encodeURIComponent(entry.id)}`, { method: "PATCH", body: { enabled: false } });
          } catch {}
        }
        if (Object.keys(nextRestricted).length || Object.keys(parseRecord(data.restrictedEntryIds)).length)
          data.restrictedEntryIds = nextRestricted;
        await syncEpisodeEntries(book, rows, chat, data);
        if (typeof syncLayerEntries === "function")
          await syncLayerEntries(book, rows, chat, data);
        const memory = data.elementMemory;
        memory.headerEntryId = await upsertEntry(book.id, rows, memory.headerEntryId, (entry) => entry?.tag === ELEMENT_HEADER_ENTRY_TAG, elementHeaderPayload(memory, chat));
        const existingElementEntries = rows.filter((entry) => [ELEMENT_FACT_ENTRY_TAG, ELEMENT_TRIGGER_ENTRY_TAG].includes(String(entry?.tag || "")));
        const nextElementMap = {};
        const activeElementEntryIds = new Set;
        for (const entity of memory.entities) {
          const previous = parseRecord(memory.entityEntryIds?.[entity.id]);
          const factId = await upsertEntry(book.id, rows, String(previous.factId || ""), (entry) => String(parseRecord(entry?.dynamicState).memoryCabinetElementId || "") === entity.id && entry?.tag === ELEMENT_FACT_ENTRY_TAG, elementFactEntryPayload(chat, entity, memory));
          activeElementEntryIds.add(String(factId));
          const proxyIds = [];
          const conditions = elementTriggerConditions(entity);
          for (let i = 0;i < conditions.length; i++) {
            const known = safeArray(previous.proxyIds)[i];
            const proxyId = await upsertEntry(book.id, rows, String(known || ""), (entry) => {
              const ds = parseRecord(entry?.dynamicState);
              return entry?.tag === ELEMENT_TRIGGER_ENTRY_TAG && String(ds.memoryCabinetElementId || "") === entity.id && Number(ds.memoryCabinetConditionIndex) === i;
            }, elementProxyEntryPayload(chat, entity, conditions[i], i, memory));
            proxyIds.push(proxyId);
            activeElementEntryIds.add(String(proxyId));
          }
          nextElementMap[entity.id] = { factId, proxyIds };
        }
        for (const entry of existingElementEntries) {
          if (!entry?.id || activeElementEntryIds.has(String(entry.id)))
            continue;
          try {
            await api(`lorebooks/${encodeURIComponent(book.id)}/entries/${encodeURIComponent(entry.id)}`, { method: "PATCH", body: { enabled: false } });
          } catch {}
        }
        memory.entityEntryIds = nextElementMap;
        memory.originChatId = chat.id;
        data.elementMemory = memory;
        const wiki = data.wiki;
        wiki.headerEntryId = await upsertEntry(book.id, rows, wiki.headerEntryId, (entry) => entry?.tag === WIKI_HEADER_ENTRY_TAG, wikiHeaderPayload(wiki, chat));
        wiki.alwaysEntryId = await upsertEntry(book.id, rows, wiki.alwaysEntryId, (entry) => entry?.tag === WIKI_ALWAYS_ENTRY_TAG, wikiAlwaysPayload(wiki, chat));
        const existingWikiEntries = rows.filter((entry) => [WIKI_DOC_ENTRY_TAG, WIKI_TRIGGER_ENTRY_TAG].includes(String(entry?.tag || "")));
        const nextWikiMap = {};
        const activeWikiEntryIds = new Set;
        for (const doc of wiki.docs) {
          const previous = parseRecord(wiki.docEntryIds?.[doc.id]);
          const bodyId = await upsertEntry(book.id, rows, String(previous.bodyId || ""), (entry) => entry?.tag === WIKI_DOC_ENTRY_TAG && String(parseRecord(entry?.dynamicState).memoryCabinetWikiId || "") === doc.id, wikiDocEntryPayload(chat, doc, wiki));
          activeWikiEntryIds.add(String(bodyId));
          const proxyIds = [];
          const conditions = wikiTriggerConditions(doc);
          for (let i = 0;i < conditions.length; i++) {
            const known = safeArray(previous.proxyIds)[i];
            const proxyId = await upsertEntry(book.id, rows, String(known || ""), (entry) => {
              const ds = parseRecord(entry?.dynamicState);
              return entry?.tag === WIKI_TRIGGER_ENTRY_TAG && String(ds.memoryCabinetWikiId || "") === doc.id && Number(ds.memoryCabinetConditionIndex) === i;
            }, wikiProxyEntryPayload(chat, doc, conditions[i], i, wiki));
            proxyIds.push(proxyId);
            activeWikiEntryIds.add(String(proxyId));
          }
          nextWikiMap[doc.id] = { bodyId, proxyIds };
        }
        for (const entry of existingWikiEntries) {
          if (!entry?.id || activeWikiEntryIds.has(String(entry.id)))
            continue;
          try {
            await api(`lorebooks/${encodeURIComponent(book.id)}/entries/${encodeURIComponent(entry.id)}`, { method: "PATCH", body: { enabled: false } });
          } catch {}
        }
        wiki.docEntryIds = nextWikiMap;
        wiki.originChatId = chat.id;
        data.wiki = wiki;
        data.lorebookId = book.id;
        data.keywordEntryIds = nextMap;
        data.lastSyncAt = nowIso();
        data.lastSyncError = "";
        data.updatedAt = nowIso();
        data.backupEntryId = await upsertEntry(book.id, rows, data.backupEntryId, (entry) => entry?.tag === BACKUP_ENTRY_TAG || String(entry?.content || "").includes(BACKUP_MARKER), backupEntryPayload(chat, data));
        await writeSyncResult(chat, data);
        state.ownershipDetachLorebookIds = [];
        if (!silent)
          toast("전용 로어북을 동기화했습니다.");
      } catch (error) {
        data.lastSyncError = String(error?.message || error);
        try {
          await writeSyncResult(chat, data);
        } catch {}
        state.syncAgain = false;
        if (!silent)
          toast(`동기화 실패: ${data.lastSyncError}`, true);
        throw error;
      } finally {
        state.syncing = false;
        render();
      }
    }
    function elementMemory(data = state.currentData) {
      return normalizeElementMemory(data?.elementMemory);
    }
    function elementKey(value) {
      return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
    }
    function elementFindMatches(entities, value) {
      const key = elementKey(value);
      if (!key)
        return [];
      return safeArray(entities).filter((entity) => [entity.name, ...safeArray(entity.aliases)].some((name) => elementKey(name) === key));
    }
    function elementMessageFingerprint(row) {
      return textHash(`${String(row?.role || "")}|${Number(row?.activeSwipeIndex) || 0}|${String(row?.createdAt || "")}|${String(row?.content || "")}`);
    }
    function collectCompletedTurns(messages) {
      const turns = [];
      let current = null;
      const push = () => {
        if (current && current.hasUser && current.hasAssistant)
          turns.push({ ...current, turn: turns.length + 1 });
        current = null;
      };
      safeArray(messages).forEach((row, index) => {
        const role = String(row?.role || "");
        if (!["user", "assistant"].includes(role) || !String(row?.content || "").trim())
          return;
        if (role === "user") {
          push();
          current = { startMessageIndex: index, endMessageIndex: index, messages: [row], hasUser: true, hasAssistant: false };
        } else if (current?.hasUser) {
          current.messages.push(row);
          current.endMessageIndex = index;
          current.hasAssistant = true;
        }
      });
      push();
      return turns;
    }
    function selectElementTurns(messages, request = {}) {
      const turns = collectCompletedTurns(messages);
      const totalTurns = turns.length;
      if (!totalTurns)
        throw new Error("완결된 RP 턴이 없습니다.");
      const mode = request.mode === "range" ? "range" : "recent";
      let startTurn;
      let endTurn;
      if (mode === "recent") {
        const count = Math.max(1, Math.min(100, Number(request.turns) || 20));
        startTurn = Math.max(1, totalTurns - count + 1);
        endTurn = totalTurns;
      } else {
        startTurn = Number(request.startTurn);
        endTurn = Number(request.endTurn);
        if (!Number.isInteger(startTurn) || !Number.isInteger(endTurn))
          throw new Error("턴 범위는 정수로 입력해 주세요.");
        if (startTurn < 1 || endTurn < 1 || startTurn > endTurn)
          throw new Error("턴 범위를 확인해 주세요.");
        if (endTurn > totalTurns)
          throw new Error(`현재 완결된 RP는 ${totalTurns}턴까지입니다.`);
        if (endTurn - startTurn + 1 > 100)
          throw new Error("한 번에 최대 100턴까지 읽을 수 있습니다.");
      }
      const selectedTurns = turns.slice(startTurn - 1, endTurn);
      const selectedMessages = selectedTurns.flatMap((turn) => turn.messages);
      return { totalTurns, startTurn, endTurn, turns: selectedTurns, messages: selectedMessages };
    }
    function elementSourceText(messages) {
      return safeArray(messages).map((row, index) => `[M${index} ${String(row.role || "record")}] ${String(row.content || "")}`).join(`

`);
    }
    function chunkElementMessages(messages, maxChars = ELEMENT_CHUNK_CHARS) {
      const chunks = [];
      let current = [];
      let currentChars = 0;
      for (const message of safeArray(messages)) {
        const messageChars = String(message?.content || "").length + 32;
        if (current.length && currentChars + messageChars > maxChars) {
          chunks.push(current);
          current = [];
          currentChars = 0;
        }
        current.push(message);
        currentChars += messageChars;
      }
      if (current.length)
        chunks.push(current);
      return chunks;
    }
    function elementSourceFromEvidence(messages, evidence) {
      const picked = [...new Set(safeArray(evidence).map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < messages.length))].sort((a, b) => a - b);
      if (!picked.length)
        return null;
      const rows = picked.map((i) => messages[i]).filter(Boolean);
      const messageIds = rows.map((row) => String(row.id || row.messageId || "")).filter(Boolean);
      const fingerprints = rows.map(elementMessageFingerprint);
      const activeSwipeIndex = Number(rows[0]?.activeSwipeIndex) || 0;
      return { messageIds, fingerprints, activeSwipeIndex, contentHash: textHash(fingerprints.join("|")) };
    }
    function chooseElementExistingCandidates(entities, sourceText) {
      const haystack = String(sourceText || "").toLocaleLowerCase();
      return safeArray(entities).map((entity) => {
        let score = 0;
        [entity.name, ...safeArray(entity.aliases)].forEach((value) => {
          const key = String(value || "").trim().toLocaleLowerCase();
          if (key && haystack.includes(key))
            score += 3;
        });
        return { entity, score };
      }).filter((row) => row.score > 0).sort((a, b) => b.score - a.score || String(b.entity.updatedAt).localeCompare(String(a.entity.updatedAt))).slice(0, 24).map((row) => row.entity);
    }
    function elementExtractionPrompt(memory, messages) {
      const sourceText = elementSourceText(messages);
      const existing = chooseElementExistingCandidates(memory.entities, sourceText);
      const existingText = existing.length ? existing.map((entity) => {
        const lines = [`id=${entity.id} name=${entity.name} aliases=${safeArray(entity.aliases).join(" | ")}`];
        if (entity.standaloneTriggers.length)
          lines.push(`  standaloneTriggers: ${entity.standaloneTriggers.join(" | ")}`);
        entity.triggerGroups.forEach((group) => lines.push(`  triggerGroup: ${group.join(" + ")}`));
        entity.currentFacts.forEach((fact) => lines.push(`  current [${fact.id}] ${fact.text}`));
        entity.historyFacts.forEach((fact) => lines.push(`  history [${fact.id}] ${fact.text}`));
        return lines.join(`
`);
      }).join(`

`) : "(none)";
      const criteria = String(memory.extractionPrompt || "").trim() || DEFAULT_ELEMENT_EXTRACTION_PROMPT;
      const contract = [
        "Response contract — return ONE JSON object and nothing else:",
        '{"entities":[{"action":"create"|"update","existingId":null,"name":"...","nameKo":null,"aliases":["..."],"standaloneTriggers":["..."],"triggerGroups":[["...","..."]],"currentFacts":[{"text":"...","textKo":null,"replacesFactId":null}],"historyFacts":[{"text":"...","textKo":null}],"evidence":[0,1]}]}',
        "- At most 12 entities.",
        "- evidence lists M indexes from the supplied source and must not be empty.",
        "- existingId and replacesFactId must be copied exactly from Existing elements, or null. Never invent one.",
        "- Use action=update whenever the entity already appears in Existing elements.",
        "- aliases identify the same entity; they are NOT retrieval conditions.",
        "- standaloneTriggers are specific phrases that may recall this entity by themselves. Do not use bare generic nouns.",
        "- triggerGroups are AND conditions; all words inside one group must appear. Put generic words here with a specific companion.",
        "- Leave retrieval conditions empty rather than inventing uncertain triggers.",
        "- Put retrieval phrases for BOTH the source language and Korean into standaloneTriggers and triggerGroups when the roleplay is not in Korean.",
        '- Return {"entities":[]} when nothing qualifies.',
        LANGUAGE_CONTRACT
      ].join(`
`);
      return `${criteria}

[Existing elements]
${existingText}
[/Existing elements]

${contract}`;
    }
    function parseElementProposalJson(text, memory, messages) {
      const fragments = collectBalancedJsonFragments(text);
      let parsed = null;
      for (const fragment of fragments) {
        for (const candidate of [fragment, repairJsonishText(fragment)]) {
          try {
            parsed = JSON.parse(candidate);
            break;
          } catch {}
        }
        if (parsed)
          break;
      }
      if (!parsed)
        return { ok: false, rows: [] };
      const rows = Array.isArray(parsed) ? parsed : safeArray(parsed.entities);
      const sourceText = messages.map((row) => String(row.content || "")).join(`
`).toLocaleLowerCase();
      const claimed = new Set;
      const normalized = [];
      for (const raw of rows) {
        if (!isRecord(raw))
          continue;
        const name = String(raw.name || "").trim().replace(/\s+/g, " ").slice(0, 80);
        if (!name)
          continue;
        const aliases = normalizeTextList(raw.aliases, 8, 80);
        if (![name, ...aliases].some((value) => sourceText.includes(String(value).toLocaleLowerCase())))
          continue;
        const source = elementSourceFromEvidence(messages, raw.evidence);
        if (!source)
          continue;
        let target = null;
        const requestedId = String(raw.existingId || "");
        if (requestedId)
          target = memory.entities.find((entity) => entity.id === requestedId) || null;
        if (!target) {
          const matches = elementFindMatches(memory.entities, name).filter((entity) => !claimed.has(entity.id));
          if (matches.length === 1)
            target = matches[0];
        }
        if (target)
          claimed.add(target.id);
        const currentFacts = safeArray(raw.currentFacts).map((fact) => {
          if (!isRecord(fact))
            return null;
          const textValue = String(fact.text || "").trim().slice(0, 300);
          if (!textValue)
            return null;
          const replace = String(fact.replacesFactId || "");
          return { text: textValue, textKo: String(fact.textKo || "").trim().slice(0, 300), replacesFactId: target?.currentFacts.some((row) => row.id === replace) ? replace : null };
        }).filter(Boolean);
        const historyFacts = safeArray(raw.historyFacts).map((fact) => ({
          text: String(isRecord(fact) ? fact.text : fact || "").trim().slice(0, 300),
          textKo: isRecord(fact) ? String(fact.textKo || "").trim().slice(0, 300) : ""
        })).filter((fact) => fact.text);
        if (!currentFacts.length && !historyFacts.length)
          continue;
        normalized.push({
          proposalId: uid("elp"),
          kind: target ? "update" : "create",
          entityId: target?.id || null,
          baseUpdatedAt: target?.updatedAt || null,
          name,
          nameKo: String(raw.nameKo || "").trim().slice(0, 80),
          aliases,
          standaloneTriggers: normalizeTextList(raw.standaloneTriggers, 8, 80),
          triggerGroups: normalizeTriggerGroups(raw.triggerGroups),
          currentFacts,
          historyFacts,
          source
        });
      }
      return { ok: true, rows: normalized };
    }
    function mergeElementProposalSource(left, right) {
      if (!left)
        return right || null;
      if (!right)
        return left;
      const messageIds = normalizeTextList([...safeArray(left.messageIds), ...safeArray(right.messageIds)], 96, 120);
      const fingerprints = normalizeTextList([...safeArray(left.fingerprints), ...safeArray(right.fingerprints)], 96, 120);
      return {
        messageIds,
        fingerprints,
        activeSwipeIndex: Number.isInteger(right.activeSwipeIndex) ? right.activeSwipeIndex : Number(left.activeSwipeIndex) || 0,
        contentHash: textHash(fingerprints.join("|"))
      };
    }
    function mergeElementProposals(rows) {
      const merged = [];
      for (const row of safeArray(rows)) {
        const identities = new Set([row.name, ...safeArray(row.aliases)].map((value) => String(value || "").trim().toLocaleLowerCase()).filter(Boolean));
        if (!identities.size)
          continue;
        const existingIndex = merged.findIndex((candidate) => {
          if (row.entityId && candidate.entityId === row.entityId)
            return true;
          if (row.entityId || candidate.entityId)
            return false;
          return [candidate.name, ...safeArray(candidate.aliases)].some((value) => identities.has(String(value || "").trim().toLocaleLowerCase()));
        });
        if (existingIndex < 0) {
          merged.push({ ...row, currentFacts: safeArray(row.currentFacts).slice(), historyFacts: safeArray(row.historyFacts).slice() });
          continue;
        }
        const target = merged[existingIndex];
        const currentByText = new Map(safeArray(target.currentFacts).map((fact) => [elementFactKey(fact), fact]));
        for (const fact of safeArray(row.currentFacts)) {
          const factKey = elementFactKey(fact);
          if (!factKey)
            continue;
          const prior = currentByText.get(factKey);
          if (!prior) {
            target.currentFacts.push(fact);
            currentByText.set(factKey, fact);
          } else if (!prior.replacesFactId && fact.replacesFactId)
            prior.replacesFactId = fact.replacesFactId;
        }
        const knownFacts = new Set([...target.currentFacts, ...target.historyFacts].map(elementFactKey));
        for (const fact of safeArray(row.historyFacts)) {
          const factKey = elementFactKey(fact);
          if (!factKey || knownFacts.has(factKey))
            continue;
          knownFacts.add(factKey);
          target.historyFacts.push(fact);
        }
        target.aliases = normalizeTextList([...target.aliases, ...row.aliases], 8, 80);
        target.standaloneTriggers = normalizeTextList([...target.standaloneTriggers, ...row.standaloneTriggers], 8, 80);
        target.triggerGroups = normalizeTriggerGroups([...target.triggerGroups, ...row.triggerGroups]);
        target.source = mergeElementProposalSource(target.source, row.source);
      }
      return merged.map((row) => {
        const seen = new Set;
        const currentFacts = safeArray(row.currentFacts).filter((fact) => {
          const key = elementFactKey(fact);
          if (!key || seen.has(key))
            return false;
          seen.add(key);
          return true;
        });
        const historyFacts = safeArray(row.historyFacts).filter((fact) => {
          const key = elementFactKey(fact);
          if (!key || seen.has(key))
            return false;
          seen.add(key);
          return true;
        });
        return { ...row, currentFacts, historyFacts };
      });
    }
    function messageHiddenFromSomeone(row) {
      return normalizeKnownBy(parseRecord(row?.extra).hiddenFromAICharacterIds).length > 0;
    }
    function readableMessages(rows, where) {
      const all = safeArray(rows).filter((row) => ["user", "assistant"].includes(String(row?.role || "")) && String(row?.content || "").trim());
      const kept = all.filter((row) => !messageHiddenFromSomeone(row));
      state.hiddenSkipped = { ...parseRecord(state.hiddenSkipped), [where]: all.length - kept.length };
      return kept;
    }
    function hiddenSkipNote(where) {
      const n = Number(parseRecord(state.hiddenSkipped)[where]) || 0;
      return n ? `특정 인물에게 숨긴 메시지 ${n}개는 읽지 않았어요.` : "";
    }
    async function fetchElementMessages() {
      const payload = await api(`chats/${encodeURIComponent(state.selectedChatId)}/messages`);
      return readableMessages(extractArray(payload, ["messages", "items", "results"]), "element");
    }
    async function previewElementRange() {
      const messages = await fetchElementMessages();
      const req = state.elementExtractMode === "range" ? { mode: "range", startTurn: state.elementRangeStart, endTurn: state.elementRangeEnd } : { mode: "recent", turns: state.elementExtractTurns };
      return selectElementTurns(messages, req);
    }
    async function generateElementCandidates() {
      const data = normalizeData(state.currentData);
      const memory = data.elementMemory;
      const connectionId = String(memory.connectionId || state.modelConnectionId || chooseDefaultConnection(state.currentChat) || "");
      if (!connectionId)
        throw new Error("요소 기억 추출에 사용할 모델 연결을 선택해 주세요.");
      const messages = await fetchElementMessages();
      const req = state.elementExtractMode === "range" ? { mode: "range", startTurn: state.elementRangeStart, endTurn: state.elementRangeEnd } : { mode: "recent", turns: state.elementExtractTurns };
      const selection = selectElementTurns(messages, req);
      const chunks = chunkElementMessages(selection.messages);
      setBusy(true, `요소 기억 후보를 찾는 중… 1/${chunks.length} 청크`);
      try {
        const collected = [];
        const failures = [];
        let successfulChunks = 0;
        for (let chunkIndex = 0;chunkIndex < chunks.length; chunkIndex += 1) {
          const chunk = chunks[chunkIndex];
          state.busyText = `요소 기억 후보를 찾는 중… ${chunkIndex + 1}/${chunks.length} 청크`;
          const busyLabel = document.querySelector(".mmc-busy b");
          if (busyLabel)
            busyLabel.textContent = state.busyText;
          let output = "";
          try {
            const payload = await api("generate/raw", {
              method: "POST",
              timeoutMs: MODEL_TIMEOUT_MS,
              body: {
                connectionId,
                runId: uid("element-extract"),
                streaming: false,
                messages: [
                  { role: "system", content: `${elementExtractionPrompt(memory, chunk)}

This is source chunk ${chunkIndex + 1} of ${chunks.length}. Analyze this chunk independently.` },
                  { role: "user", content: `[SOURCE MESSAGES]
${elementSourceText(chunk)}
[/SOURCE MESSAGES]` }
                ],
                parameters: { maxTokens: 1800, reasoningEffort: null }
              }
            });
            output = extractGeneratedText(payload);
            const parsed = parseElementProposalJson(output, memory, chunk);
            if (!parsed.ok)
              throw new Error("응답 JSON을 읽지 못함");
            successfulChunks += 1;
            collected.push(...parsed.rows);
          } catch (error) {
            failures.push({ index: chunkIndex, message: String(error?.message || "분석 실패"), output: String(output || ""), rows: chunk.slice() });
          }
        }
        if (!successfulChunks) {
          const first = failures.find((row) => row.output) || failures[0];
          if (first.output) {
            state.rawRecovery = { kind: "element", text: first.output, rows: first.rows, extractInfo: { ...selection, chunkCount: chunks.length, failedChunks: failures.length } };
            state.layer = "raw-repair";
            toast(`전체 ${chunks.length}개 청크 분석에 실패했습니다. 첫 응답 원문을 보존했습니다.`, true);
            return;
          }
          throw new Error(`전체 ${chunks.length}개 청크 분석에 실패했습니다: ${first.message}`);
        }
        const merged = mergeElementProposals(collected);
        state.elementCandidateOverflow = Math.max(0, merged.length - ELEMENT_CANDIDATE_LIMIT);
        state.elementCandidates = merged.slice(0, ELEMENT_CANDIDATE_LIMIT);
        state.elementCandidateSelected = new Set(state.elementCandidates.map((_, i) => String(i)));
        state.elementExtractInfo = { ...selection, chunkCount: chunks.length, successfulChunks, failedChunks: failures.length };
        state.layer = "element-candidates";
        if (failures.length)
          toast(`${chunks.length}개 중 ${failures.length}개 청크는 실패했습니다. 성공한 후보 ${state.elementCandidates.length}개는 유지했습니다.`, true);
        else if (state.elementCandidateOverflow)
          toast(`후보 상한을 넘어 ${state.elementCandidateOverflow}개가 미리보기에 포함되지 않았습니다.`, true);
        else if (!state.elementCandidates.length)
          toast("이번 범위에서는 저장할 만한 요소 기억을 찾지 못했습니다.");
      } finally {
        state.busy = false;
        if (state.busyTimer)
          clearInterval(state.busyTimer);
        state.busyTimer = null;
        render();
      }
    }
    function elementCandidateFromDom(candidate, index) {
      const get = (suffix) => document.getElementById(`mmc-ec-${suffix}-${index}`);
      const lines = (value, max) => String(value || "").split(/\n/).map((x) => x.trim()).filter(Boolean).slice(0, max);
      const name = String(get("name")?.value || candidate.name || "").trim().slice(0, 80);
      const aliases = normalizeTextList(lines(get("aliases")?.value, 8), 8, 80);
      const standaloneTriggers = normalizeTextList(lines(get("triggers")?.value, 8), 8, 80);
      const triggerGroups = normalizeTriggerGroups(lines(get("groups")?.value, 8).map((line) => line.split(/[,＋+]/)));
      const currentLines = lines(get("current")?.value, Number.MAX_SAFE_INTEGER);
      const historyLines = lines(get("history")?.value, Number.MAX_SAFE_INTEGER);
      const koByText = new Map([...safeArray(candidate.currentFacts), ...safeArray(candidate.historyFacts)].filter((fact) => fact && fact.textKo).map((fact) => [String(fact.text || ""), String(fact.textKo)]));
      return {
        ...candidate,
        name,
        aliases,
        standaloneTriggers,
        triggerGroups,
        currentFacts: currentLines.map((textValue, i) => ({ text: textValue.slice(0, 300), textKo: koByText.get(textValue) || "", replacesFactId: candidate.currentFacts?.[i]?.replacesFactId || null })),
        historyFacts: historyLines.map((textValue) => ({ text: textValue.slice(0, 300), textKo: koByText.get(textValue) || "" }))
      };
    }
    function mergeFactLines(existingFacts, textLines, now) {
      const byText = new Map(existingFacts.map((fact) => [fact.text, fact]));
      return textLines.map((textValue) => byText.get(textValue) || { id: uid("elf"), text: textValue.slice(0, 300), textKo: "", source: null, createdAt: now });
    }
    async function applyElementCandidates() {
      const selectedIndices = [...state.elementCandidateSelected].map(Number).filter((i) => Number.isInteger(i));
      if (!selectedIndices.length)
        throw new Error("저장할 요소 후보를 선택해 주세요.");
      const data = await freshOwnedData();
      const memory = data.elementMemory;
      let created = 0;
      let updated = 0;
      const conflicts = [];
      const succeeded = new Set;
      const now = nowIso();
      for (const index of selectedIndices) {
        const original = state.elementCandidates[index];
        if (!original)
          continue;
        const proposal = elementCandidateFromDom(original, index);
        if (!proposal.name || !proposal.currentFacts.length && !proposal.historyFacts.length)
          continue;
        if (proposal.kind === "update") {
          const targetIndex = memory.entities.findIndex((entity) => entity.id === proposal.entityId);
          if (targetIndex < 0) {
            conflicts.push(`${proposal.name}: 기존 요소 없음`);
            continue;
          }
          const target = memory.entities[targetIndex];
          if (proposal.baseUpdatedAt && target.updatedAt !== proposal.baseUpdatedAt) {
            conflicts.push(`${target.name}: 검토 중 수정됨`);
            continue;
          }
          const supersededIds = new Set(proposal.currentFacts.map((fact) => fact.replacesFactId).filter(Boolean));
          const keptCurrent = target.currentFacts.filter((fact) => !supersededIds.has(fact.id));
          const demoted = target.currentFacts.filter((fact) => supersededIds.has(fact.id));
          const keptKeys = new Set(keptCurrent.map(elementFactKey));
          const addCurrent = proposal.currentFacts.filter((fact) => !keptKeys.has(elementFactKey(fact.text))).map((fact) => ({ id: uid("elf"), text: fact.text, textKo: fact.textKo || "", source: proposal.source, createdAt: now }));
          const historyKeys = new Set([...target.historyFacts, ...demoted].map(elementFactKey));
          const addHistory = proposal.historyFacts.filter((fact) => !historyKeys.has(elementFactKey(fact.text))).map((fact) => ({ id: uid("elf"), text: fact.text, textKo: fact.textKo || "", source: proposal.source, createdAt: now }));
          target.name = proposal.name;
          if (proposal.nameKo)
            target.nameKo = proposal.nameKo;
          target.aliases = normalizeTextList([...target.aliases, ...proposal.aliases], 8, 80);
          target.standaloneTriggers = normalizeTextList([...target.standaloneTriggers, ...proposal.standaloneTriggers], 8, 80);
          target.triggerGroups = normalizeTriggerGroups([...target.triggerGroups, ...proposal.triggerGroups]);
          const balanced = balanceElementFacts([...keptCurrent, ...addCurrent], [...target.historyFacts, ...demoted, ...addHistory]);
          target.currentFacts = balanced.currentFacts;
          target.historyFacts = balanced.historyFacts;
          target.updatedAt = now;
          updated += 1;
          succeeded.add(index);
          continue;
        }
        if (memory.entities.length >= 400) {
          conflicts.push(`${proposal.name}: 요소 상한`);
          continue;
        }
        if (elementFindMatches(memory.entities, proposal.name).length) {
          conflicts.push(`${proposal.name}: 같은 이름/별칭이 이미 있음`);
          continue;
        }
        memory.entities.push(normalizeElement({
          id: uid("element"),
          name: proposal.name,
          nameKo: proposal.nameKo,
          aliases: proposal.aliases,
          standaloneTriggers: proposal.standaloneTriggers,
          triggerGroups: proposal.triggerGroups,
          currentFacts: proposal.currentFacts.map((fact) => ({ id: uid("elf"), text: fact.text, textKo: fact.textKo || "", source: proposal.source, createdAt: now })),
          historyFacts: proposal.historyFacts.map((fact) => ({ id: uid("elf"), text: fact.text, textKo: fact.textKo || "", source: proposal.source, createdAt: now })),
          createdAt: now,
          updatedAt: now
        }));
        created += 1;
        succeeded.add(index);
      }
      memory.originChatId = state.selectedChatId;
      data.elementMemory = memory;
      await persistData(data);
      if (conflicts.length) {
        state.elementCandidates = state.elementCandidates.filter((_, i) => !succeeded.has(i));
        state.elementCandidateSelected = new Set(state.elementCandidates.map((_, i) => String(i)));
        state.layer = state.elementCandidates.length ? "element-candidates" : null;
        toast(`${created + updated}개 저장 · ${conflicts.length}개는 최신 수정/중복 때문에 남겨뒀습니다.`, true);
      } else {
        state.elementCandidates = [];
        state.elementCandidateSelected.clear();
        state.elementExtractInfo = null;
        state.elementCandidateOverflow = 0;
        state.layer = null;
        toast(`요소 기억 ${created + updated}개를 저장했습니다.${syncFailSuffix()}`, !!syncFailSuffix());
      }
      render();
    }
    function elementFactLines(entity) {
      const current = entity.currentFacts.map((fact) => `- ${fact.text}`).join(`
`);
      const history = entity.historyFacts.slice(-4).map((fact) => `- ${fact.text}`).join(`
`);
      return [current ? `현재:
${current}` : "", history ? `이력:
${history}` : ""].filter(Boolean).join(`
`);
    }
    function elementContext(chat, entity) {
      return [ELEMENT_MARKER, `[요소 기억 · ${chatLabel(chat)} · ${entity.name}]`, elementFactLines(entity)].filter(Boolean).join(`
`);
    }
    function elementTriggerMarker(entityId) {
      return `${ELEMENT_TRIGGER_MARKER}:${entityId}`;
    }
    function elementTriggerConditions(entity) {
      const conditions = [];
      if (entity.standaloneTriggers.length)
        conditions.push({ kind: "standalone", keys: entity.standaloneTriggers.slice() });
      const groups = normalizeTriggerGroups(entity.triggerGroups);
      for (const group of groups) {
        const covered = entity.standaloneTriggers.some((trigger) => group.every((term) => trigger.toLocaleLowerCase().includes(term.toLocaleLowerCase())));
        if (!covered)
          conditions.push({ kind: "group", keys: group.slice() });
      }
      return conditions;
    }
    function elementHeaderContext(memory) {
      const base = String(memory.injectionPrompt || "").trim() || DEFAULT_ELEMENT_INJECTION_PROMPT;
      return `${base}
${ADVANCED_MEMORY_PRIORITY_RULE}`;
    }
    function elementHeaderPayload(memory, chat) {
      const any = memory.injectionEnabled && memory.entities.some((entity) => elementTriggerConditions(entity).length && (entity.currentFacts.length || entity.historyFacts.length));
      return constantEntryPayload({
        tag: ELEMENT_HEADER_ENTRY_TAG,
        name: "요소 기억 · 해석 지침",
        content: elementHeaderContext(memory),
        enabled: any,
        order: 33,
        dynamicState: { memoryCabinetChatId: String(chat.id), managedBy: LOREBOOK_TAG, kind: "element-header" }
      });
    }
    function elementFactEntryPayload(chat, entity, memory) {
      return {
        name: `요소 기억 · ${truncate(entity.name, 120)}`,
        content: elementContext(chat, entity),
        description: `기억 보관함 요소 기억 · element:${entity.id}`,
        keys: [elementTriggerMarker(entity.id)],
        secondaryKeys: [],
        enabled: memory.injectionEnabled && elementTriggerConditions(entity).length > 0,
        constant: false,
        selective: false,
        selectiveLogic: "and",
        probability: null,
        scanDepth: null,
        matchWholeWords: false,
        caseSensitive: true,
        useRegex: false,
        position: 0,
        depth: 4,
        order: 44,
        role: "system",
        preventRecursion: true,
        excludeRecursion: false,
        delayUntilRecursion: true,
        excludeFromVectorization: true,
        tag: ELEMENT_FACT_ENTRY_TAG,
        dynamicState: { memoryCabinetChatId: String(chat.id), memoryCabinetElementId: String(entity.id), managedBy: LOREBOOK_TAG, kind: "element-facts" }
      };
    }
    function elementProxyEntryPayload(chat, entity, condition, index, memory) {
      const group = condition.kind === "group";
      return {
        name: `요소 조건 · ${truncate(entity.name, 100)} · ${index + 1}`,
        content: `<!-- ${elementTriggerMarker(entity.id)} -->`,
        description: `기억 보관함 요소 검색 조건 · element:${entity.id}`,
        keys: group ? [condition.keys[0]] : condition.keys.slice(),
        secondaryKeys: group ? condition.keys.slice(1) : [],
        enabled: memory.injectionEnabled,
        constant: false,
        selective: group,
        selectiveLogic: group ? "and_all" : "and",
        probability: null,
        scanDepth: null,
        matchWholeWords: false,
        caseSensitive: false,
        useRegex: false,
        position: 0,
        depth: 4,
        order: 43,
        role: "system",
        preventRecursion: false,
        excludeRecursion: true,
        delayUntilRecursion: false,
        excludeFromVectorization: true,
        tag: ELEMENT_TRIGGER_ENTRY_TAG,
        dynamicState: { memoryCabinetChatId: String(chat.id), memoryCabinetElementId: String(entity.id), memoryCabinetConditionIndex: index, managedBy: LOREBOOK_TAG, kind: "element-trigger" }
      };
    }
    function matchElementTriggers(entity, text) {
      const haystack = String(text || "").toLocaleLowerCase();
      const reasons = [];
      entity.standaloneTriggers.forEach((trigger) => {
        if (haystack.includes(trigger.toLocaleLowerCase()))
          reasons.push(`단독: ${trigger}`);
      });
      entity.triggerGroups.forEach((group) => {
        if (group.every((term) => haystack.includes(term.toLocaleLowerCase())))
          reasons.push(`조합: ${group.join(" + ")}`);
      });
      return reasons;
    }
    function elementSearchResults(text = state.elementTestText) {
      return elementMemory().entities.map((entity) => ({ entity, reasons: matchElementTriggers(entity, text) })).filter((row) => row.reasons.length);
    }
    function elementConnectionOptions(memory = elementMemory()) {
      const selected = String(memory.connectionId || state.modelConnectionId || "");
      const rows = state.connections.map((row) => `<option value="${esc(row.id)}" ${row.id === selected ? "selected" : ""}>${esc(row.label)}${row.model ? ` · ${esc(row.model)}` : ""}</option>`).join("");
      return `<option value="">기본 후보 모델 사용</option>${rows}`;
    }
    function elementRow(entity) {
      const facts = entity.currentFacts.slice(0, 3).map((fact) => displayText(fact.text, fact.textKo));
      const moreFacts = Math.max(0, entity.currentFacts.length - facts.length);
      const conditionCount = elementTriggerConditions(entity).length;
      const hasEvidence = [...entity.currentFacts, ...entity.historyFacts].some((fact) => fact.source && (safeArray(fact.source.messageIds).length || safeArray(fact.source.fingerprints).length || fact.source.contentHash));
      return `<article class="mmc-element-row" data-element-id="${esc(entity.id)}">
      <button class="mmc-element-main" data-action="edit-element" data-id="${esc(entity.id)}">
        <span class="mmc-cat-head"><b>${esc(displayText(entity.name, entity.nameKo))}</b>${entity.aliases.length ? `<small>${esc(entity.aliases.slice(0, 3).join(" · "))}</small>` : ""}</span>
        ${facts.length ? `<ul class="mmc-facts">${facts.map((text) => `<li>${esc(truncate(text, 90))}</li>`).join("")}${moreFacts ? `<li class="is-more">외 ${moreFacts}개</li>` : ""}</ul>` : '<span class="mmc-element-summary">현재 사실 없음</span>'}
      </button>
      <div class="mmc-element-meta"><span>현재 ${entity.currentFacts.length} · 이력 ${entity.historyFacts.length}</span><span class="mmc-chip ${conditionCount ? "is-ok" : "is-warn"}">${conditionCount ? `검색 조건 ${conditionCount}` : "조건 없음"}</span>${hasEvidence ? `<button class="mmc-evidence-link" data-action="view-evidence" data-kind="element" data-id="${esc(entity.id)}">근거</button>` : ""}</div>
    </article>`;
    }
    function elementExtractionPanel(memory) {
      const range = state.elementExtractMode === "range";
      return `<section class="mmc-card mmc-element-toolbox">
      <div class="mmc-dock-copy"><span class="mmc-dock-icon">${SVG.spark}</span><div><b>원문에서 요소 기억 찾기</b><small>요약이 아니라 완결된 RP 원문을 직접 읽고 후보만 만들어요. 저장은 검토한 뒤에만 돼요.</small></div></div>
      <div class="mmc-dock-controls">
        <div class="mmc-element-mode mmc-seg"><label class="${!range ? "is-active" : ""}"><input type="radio" name="mmc-element-mode" value="recent" ${!range ? "checked" : ""}>최근 턴</label><label class="${range ? "is-active" : ""}"><input type="radio" name="mmc-element-mode" value="range" ${range ? "checked" : ""}>직접 지정</label></div>
        <div class="mmc-element-range">${range ? `<label>시작 <input id="mmc-element-range-start" type="number" min="1" value="${state.elementRangeStart}"></label><span>~</span><label>끝 <input id="mmc-element-range-end" type="number" min="1" value="${state.elementRangeEnd}"></label>` : `<label>최근 <input id="mmc-element-turns" type="number" min="1" max="100" value="${state.elementExtractTurns}"> 턴</label>`}</div>
        <button class="mmc-btn mmc-primary" data-action="extract-elements">${SVG.spark}<span>요소 기억 추출</span></button>
      </div>
      <small class="mmc-element-status"><i class="mmc-sync-dot ${memory.injectionEnabled ? "is-ok" : ""}"></i>주입 ${memory.injectionEnabled ? "켜짐" : "꺼짐"} · 저장된 요소 ${memory.entities.length}개 · 모델 결과는 자동 저장되지 않아요${hiddenSkipNote("element") ? ` · ${esc(hiddenSkipNote("element"))}` : ""} · <button class="mmc-link" data-action="element-settings">요소 설정</button></small>
    </section>`;
    }
    function elementTestResultsMarkup() {
      const results = elementSearchResults();
      return state.elementTestText.trim() ? results.length ? results.map((row) => `<span class="mmc-hit"><b>${esc(row.entity.name)}</b><small>${esc(row.reasons.join(" · "))}</small></span>`).join("") : "<em>일치하는 요소가 없어요.</em>" : "<em>문장을 넣으면 호출될 요소와 이유를 보여 줘요.</em>";
    }
    function elementSearchPanel(memory) {
      return `<section class="mmc-card mmc-element-search-test">
      <header class="mmc-card-head"><b>호출 테스트</b></header>
      <small class="mmc-muted">실제 로어북 조건과 같은 OR / AND 규칙으로 어떤 요소가 불려 올지 미리 확인해요.</small>
      <textarea id="mmc-element-test" rows="3" placeholder="예: 지희가 사물함에서 상자를 꺼냈다">${esc(state.elementTestText)}</textarea>
      <div class="mmc-element-test-results">${elementTestResultsMarkup()}</div>
      <div class="mmc-rule-note"><b>규칙</b><small><strong>별칭</strong>은 같은 대상의 다른 이름이고 자동 검색어가 아니에요. <strong>단독 호출어</strong>는 하나만 나와도, <strong>조합 호출조건</strong>은 같은 줄의 단어가 모두 나와야 불러요.</small></div>
    </section>`;
    }
    function elementFilteredEntities(memory = elementMemory()) {
      const query = String(state.elementSearch || "").trim().toLocaleLowerCase();
      return memory.entities.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).filter((entity) => !query || [entity.name, entity.nameKo, ...entity.aliases, ...entity.currentFacts.map((f) => `${f.text} ${f.textKo}`), ...entity.historyFacts.map((f) => `${f.text} ${f.textKo}`)].join(`
`).toLocaleLowerCase().includes(query));
    }
    function elementListMarkup(memory = elementMemory()) {
      const entities = elementFilteredEntities(memory);
      return entities.length ? entities.map(elementRow).join("") : `<div class="mmc-empty">${memory.entities.length ? "검색 결과가 없어요." : "아직 요소 기억이 없어요. 원문에서 추출하거나 직접 추가해 보세요."}</div>`;
    }
    function elementMainView() {
      const memory = elementMemory();
      return `<div class="mmc-element-page">
      ${elementExtractionPanel(memory)}
      <div class="mmc-el-wrap">
        <section class="mmc-el-main">
          <div class="mmc-element-list-head"><label class="mmc-searchbox">${SVG.search}<input id="mmc-element-search" value="${esc(state.elementSearch)}" placeholder="이름·별칭·사실 검색" aria-label="요소 검색"></label><button class="mmc-btn mmc-primary" data-action="new-element">${SVG.plus}<span>새 요소</span></button></div>
          <div class="mmc-element-list">${elementListMarkup(memory)}</div>
        </section>
        <aside class="mmc-el-aside">${elementSearchPanel(memory)}</aside>
      </div>
    </div>`;
    }
    function elementEditorLayer() {
      const d = state.elementDraft ? normalizeElement(state.elementDraft) : normalizeElement({ id: "", name: "" });
      const current = d.currentFacts.map((fact) => fact.text).join(`
`);
      const history = d.historyFacts.map((fact) => fact.text).join(`
`);
      const groups = d.triggerGroups.map((group) => group.join(", ")).join(`
`);
      return `<div class="mmc-layer-backdrop" data-action="close-layer"><section class="mmc-layer mmc-element-editor" data-layer-stop>
      <header><div><span class="mmc-kicker">ELEMENT MEMORY</span><h3>${d.id ? "요소 기억 편집" : "새 요소 기억"}</h3></div><button class="mmc-icon-btn" data-action="close-layer">${SVG.close}</button></header>
      <div class="mmc-layer-body">
        <label class="mmc-field"><span>이름</span><input id="mmc-element-name" value="${esc(d.name)}" maxlength="80" placeholder="예: 노란 텀블러"></label>
        <label class="mmc-field"><span>별칭 <small>같은 대상의 다른 이름 · 한 줄에 하나</small></span><textarea id="mmc-element-aliases" rows="3">${esc(d.aliases.join(`
`))}</textarea></label>
        <div class="mmc-element-editor-grid">
          <label class="mmc-field"><span>현재 사실 <small>지금 참인 상태 · 한 줄에 하나</small></span><textarea id="mmc-element-current" rows="6" placeholder="상태: 정상
위치: 책상">${esc(current)}</textarea></label>
          <label class="mmc-field"><span>이력 <small>지속적으로 기억할 과거 · 한 줄에 하나</small></span><textarea id="mmc-element-history" rows="6">${esc(history)}</textarea></label>
        </div>
        <section class="mmc-trigger-box"><div><b>검색 조건</b><small>별칭은 대상의 이름일 뿐 검색어가 아닙니다. 일반명사는 조합 조건에 넣는 편이 안전합니다.</small></div>
          <label class="mmc-field"><span>단독 호출어 <small>하나만 나와도 호출 · 한 줄에 하나</small></span><textarea id="mmc-element-triggers" rows="3" placeholder="지희의 종이 상자">${esc(d.standaloneTriggers.join(`
`))}</textarea></label>
          <label class="mmc-field"><span>조합 호출조건 <small>한 줄 안의 단어가 모두 나와야 호출 · 쉼표로 구분</small></span><textarea id="mmc-element-groups" rows="4" placeholder="지희, 상자
지희, 사물함">${esc(groups)}</textarea></label>
        </section>
        ${hasKoText(d.nameKo, ...d.currentFacts.map((fact) => fact.textKo), ...d.historyFacts.map((fact) => fact.textKo)) ? `<details class="mmc-source-quote"><summary>한국어 표시본 보기 · 위 칸의 원문은 그대로 유지됩니다</summary><p>${esc([d.nameKo, ...d.currentFacts.map((fact) => fact.textKo), ...d.historyFacts.map((fact) => fact.textKo)].filter(Boolean).join(`
`))}</p></details>` : ""}
      </div>
      <footer>${d.id ? `<button class="mmc-btn mmc-danger" data-action="delete-element" data-id="${esc(d.id)}">삭제</button>` : "<span></span>"}<div><button class="mmc-btn" data-action="close-layer">취소</button><button class="mmc-btn mmc-primary" data-action="save-element">저장</button></div></footer>
    </section></div>`;
    }
    function elementCandidateRow(item, index) {
      const target = item.kind === "update" ? elementMemory().entities.find((entity) => entity.id === item.entityId) : null;
      return `<article class="mmc-element-candidate">
      <div class="mmc-element-candidate-head"><label><input type="checkbox" data-element-candidate-index="${index}" ${state.elementCandidateSelected.has(String(index)) ? "checked" : ""}><span class="mmc-type-chip">${item.kind === "update" ? "갱신" : "신규"}</span></label><b>${esc(item.name)}</b><small>현재 ${item.currentFacts.length} · 이력 ${item.historyFacts.length}</small></div>
      ${target ? `<div class="mmc-candidate-note">기존 <b>${esc(target.name)}</b> · 최근 수정 ${esc(sourceDate(target.updatedAt) || target.updatedAt)}</div>` : ""}
      <label class="mmc-field"><span>이름</span><input id="mmc-ec-name-${index}" value="${esc(item.name)}" maxlength="80"></label>
      <div class="mmc-element-editor-grid">
        <label class="mmc-field"><span>현재 사실</span><textarea id="mmc-ec-current-${index}" rows="5">${esc(item.currentFacts.map((fact) => fact.text).join(`
`))}</textarea></label>
        <label class="mmc-field"><span>이력</span><textarea id="mmc-ec-history-${index}" rows="5">${esc(item.historyFacts.map((fact) => fact.text).join(`
`))}</textarea></label>
      </div>
      <label class="mmc-field"><span>별칭</span><textarea id="mmc-ec-aliases-${index}" rows="2">${esc(item.aliases.join(`
`))}</textarea></label>
      <div class="mmc-element-editor-grid">
        <label class="mmc-field"><span>단독 호출어</span><textarea id="mmc-ec-triggers-${index}" rows="2">${esc(item.standaloneTriggers.join(`
`))}</textarea></label>
        <label class="mmc-field"><span>조합 호출조건</span><textarea id="mmc-ec-groups-${index}" rows="2">${esc(item.triggerGroups.map((group) => group.join(", ")).join(`
`))}</textarea></label>
      </div>
    </article>`;
    }
    function elementCandidateLayer() {
      const info = state.elementExtractInfo;
      const label = info ? `${info.startTurn}~${info.endTurn}턴 · ${info.chunkCount || 1}청크 · 후보 ${state.elementCandidates.length}개` : `후보 ${state.elementCandidates.length}개`;
      const warnings = [
        info?.failedChunks ? `${info.chunkCount}개 청크 중 ${info.failedChunks}개 분석 실패 · 성공한 결과는 유지됨` : "",
        state.elementCandidateOverflow ? `후보 상한 ${ELEMENT_CANDIDATE_LIMIT}개 초과 · ${state.elementCandidateOverflow}개는 이번 미리보기에 포함되지 않음` : ""
      ].filter(Boolean);
      return `<div class="mmc-layer-backdrop" data-action="close-layer"><section class="mmc-layer mmc-element-candidates-layer" data-layer-stop>
      <header><div><span class="mmc-kicker">ELEMENT REVIEW</span><h3>요소 기억 추출 결과</h3><small>${esc(label)}</small></div><button class="mmc-icon-btn" data-action="close-layer">${SVG.close}</button></header>
      <div class="mmc-layer-body">${warnings.map((text) => `<div class="mmc-candidate-note mmc-warning-note">${esc(text)}</div>`).join("")}<div class="mmc-candidate-toolbar"><b>${state.elementCandidateSelected.size}/${state.elementCandidates.length} 선택</b><div><button class="mmc-btn" data-action="element-select-all">전체 선택</button><button class="mmc-btn" data-action="element-select-none">전체 해제</button></div></div>${state.elementCandidates.length ? state.elementCandidates.map(elementCandidateRow).join("") : '<div class="mmc-empty">저장할 만한 요소 후보가 없습니다.</div>'}</div>
      <footer><span></span><div><button class="mmc-btn" data-action="close-layer">취소</button><button class="mmc-btn mmc-primary" data-action="save-element-candidates" ${state.elementCandidateSelected.size ? "" : "disabled"}>선택 ${state.elementCandidateSelected.size}개 저장</button></div></footer>
    </section></div>`;
    }
    function elementSettingsLayer() {
      const memory = elementMemory();
      return `<div class="mmc-layer-backdrop" data-action="close-layer"><section class="mmc-layer mmc-settings-layer" data-layer-stop>
      <header><div><span class="mmc-kicker">ELEMENT SETTINGS</span><h3>요소 기억 설정</h3></div><button class="mmc-icon-btn" data-action="close-layer">${SVG.close}</button></header>
      <div class="mmc-layer-body">
        <label class="mmc-setting mmc-setting-model"><span><b>요소 추출 모델</b><small>비워 두면 기억 보관함의 기본 후보 모델을 사용합니다.</small></span><select id="mmc-element-model">${elementConnectionOptions(memory)}</select></label>
        <label class="mmc-check-line"><input id="mmc-element-injection-enabled" type="checkbox" ${memory.injectionEnabled ? "checked" : ""}><span>검색 조건이 맞는 요소 기억을 전용 로어북으로 주입하기</span></label>
        <section class="mmc-setting-block"><div class="mmc-setting-block-head"><span><b>요소 추출 지침</b><small>무엇을 요소 기억으로 남길지 정합니다. JSON 형식 규칙은 확장이 별도로 붙입니다.</small></span><button class="mmc-btn" data-action="reset-element-extraction-prompt">기본값 복원</button></div><textarea id="mmc-element-extraction-prompt" rows="10">${esc(memory.extractionPrompt || DEFAULT_ELEMENT_EXTRACTION_PROMPT)}</textarea></section>
        <section class="mmc-setting-block"><div class="mmc-setting-block-head"><span><b>요소 주입 지침</b><small>검색된 요소 기억을 모델이 어떻게 취급할지 정합니다. 실제 위치는 전용 로어북의 system 기억으로 고정합니다.</small></span><button class="mmc-btn" data-action="reset-element-injection-prompt">기본값 복원</button></div><textarea id="mmc-element-injection-prompt" rows="8">${esc(memory.injectionPrompt || DEFAULT_ELEMENT_INJECTION_PROMPT)}</textarea></section>
        <div class="mmc-setting-warning"><b>검색 조건 안내</b><small><strong>별칭</strong>은 같은 대상의 다른 이름이고 자동 검색어가 아닙니다. <strong>단독 호출어</strong>는 하나만 등장해도 기억을 부르며, <strong>조합 호출조건</strong>은 같은 줄의 모든 단어가 등장해야 부릅니다.</small></div>
      </div>
      <footer><span></span><div><button class="mmc-btn" data-action="close-layer">취소</button><button class="mmc-btn mmc-primary" data-action="save-element-settings">설정 저장</button></div></footer>
    </section></div>`;
    }
    function wikiState(data = state.currentData) {
      return normalizeWiki(data?.wiki);
    }
    function wikiKey(value) {
      return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
    }
    function wikiCategoryLabel(doc) {
      return WIKI_CATEGORY_LABEL[doc?.category] || WIKI_CATEGORY_LABEL.misc;
    }
    function wikiCategoryPath(doc) {
      const base = wikiCategoryLabel(doc);
      return doc?.subcategory ? `${base} / ${doc.subcategory}` : base;
    }
    function wikiRetrievalTerms(doc) {
      return normalizeTextList([...safeArray(doc?.keywordsKo), ...safeArray(doc?.keywordsEn)], 24, 80);
    }
    function wikiTriggerConditions(doc) {
      const conditions = [];
      const solo = wikiRetrievalTerms(doc);
      if (solo.length)
        conditions.push({ kind: "standalone", keys: solo });
      for (const group of normalizeTriggerGroups(doc?.keywordGroups)) {
        const covered = solo.some((term) => group.every((word) => term.toLocaleLowerCase().includes(word.toLocaleLowerCase())));
        if (!covered)
          conditions.push({ kind: "group", keys: group.slice() });
      }
      return conditions;
    }
    function wikiDocInjectable(doc, wiki) {
      return !!(wiki.injectionEnabled && !doc.excludeFromContext && wikiTriggerConditions(doc).length > 0 && (doc.summary.trim() || doc.sections.length));
    }
    function wikiAlwaysDocs(wiki) {
      return wiki.docs.filter((doc) => doc.alwaysRemember && !doc.excludeFromContext && doc.summary.trim());
    }
    function wikiDocFullText(doc) {
      return [doc.title, doc.summary, ...safeArray(doc.sections).map((section) => `${section.heading}
${section.body}`)].join(`
`);
    }
    function wikiSearchHaystack(doc) {
      return [
        doc.title,
        doc.titleKo,
        wikiCategoryPath(doc),
        ...safeArray(doc.aliases),
        ...wikiRetrievalTerms(doc),
        doc.summary,
        doc.summaryKo,
        ...safeArray(doc.sections).map((section) => `${section.heading}
${section.headingKo}
${section.body}
${section.bodyKo}`)
      ].join(`
`).toLocaleLowerCase();
    }
    function wikiFindByTitle(docs, title) {
      const key = wikiKey(title);
      if (!key)
        return null;
      return safeArray(docs).find((doc) => wikiKey(doc.title) === key) || safeArray(docs).find((doc) => safeArray(doc.aliases).some((alias) => wikiKey(alias) === key)) || null;
    }
    function wikiUnescape(value) {
      return String(value ?? "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
    }
    function wikiBracketTokens(text) {
      const out = [];
      for (const match of String(text || "").matchAll(/\[([^\[\]\n]{1,80})\]/g))
        out.push(String(match[1]).trim());
      return out;
    }
    function wikiOutgoingTitles(doc) {
      const seen = new Set;
      const out = [];
      for (const token of wikiBracketTokens(wikiDocFullText(doc))) {
        if (!token || /^\d{1,3}$/.test(token))
          continue;
        const key = wikiKey(token);
        if (!key || seen.has(key))
          continue;
        seen.add(key);
        out.push(token);
        if (out.length >= 40)
          break;
      }
      return out;
    }
    function wikiOutgoingRows(doc, docs) {
      const rows = [];
      const pushed = new Set;
      for (const title of wikiOutgoingTitles(doc)) {
        const target = wikiFindByTitle(docs, title);
        if (target && target.id === doc.id)
          continue;
        const key = target ? `id:${target.id}` : `t:${wikiKey(title)}`;
        if (pushed.has(key))
          continue;
        pushed.add(key);
        rows.push({ title: target ? target.title : title, doc: target });
      }
      for (const id of safeArray(doc.relatedDocIds)) {
        const target = docs.find((row) => row.id === id);
        if (!target || target.id === doc.id || pushed.has(`id:${target.id}`))
          continue;
        pushed.add(`id:${target.id}`);
        rows.push({ title: target.title, doc: target });
      }
      return rows;
    }
    function wikiIncomingRows(doc, docs) {
      return docs.filter((row) => {
        if (row.id === doc.id)
          return false;
        if (safeArray(row.relatedDocIds).includes(doc.id))
          return true;
        return wikiOutgoingTitles(row).some((title) => wikiFindByTitle(docs, title)?.id === doc.id);
      });
    }
    function wikiInlineMarkup(text, doc, docs) {
      let out = esc(text);
      out = out.replace(/`([^`\n]{1,200})`/g, (whole, code) => `<code>${code}</code>`);
      out = out.replace(/\*\*([^*\n]{1,200})\*\*/g, "<strong>$1</strong>");
      out = out.replace(/(^|[^*])\*([^*\n]{1,200})\*(?!\*)/g, "$1<em>$2</em>");
      out = out.replace(/\[([^\[\]\n]{1,80})\]/g, (whole, rawToken) => {
        const token = String(rawToken).trim();
        if (/^\d{1,3}$/.test(token)) {
          const index = Number(token);
          const source = safeArray(doc?.sources)[index - 1];
          return `<button type="button" class="mmc-wiki-cite${source ? "" : " is-missing"}" data-action="wiki-source" data-id="${esc(doc?.id || "")}" data-index="${index}" title="${esc(source ? `${WIKI_SOURCE_KIND_LABEL[source.kind]} · ${source.label}` : "연결된 근거가 없습니다")}">${index}</button>`;
        }
        const target = wikiFindByTitle(docs, wikiUnescape(token));
        return `<button type="button" class="mmc-wiki-link${target ? "" : " is-missing"}" data-action="wiki-open" data-id="${esc(target?.id || "")}" title="${esc(target ? target.title : "아직 없는 문서")}">${token}</button>`;
      });
      return out;
    }
    function wikiRenderMarkdown(body, doc, docs) {
      const lines = String(body || "").replace(/\r\n?/g, `
`).split(`
`);
      const out = [];
      let list = "";
      let inCode = false;
      const closeList = () => {
        if (list) {
          out.push(`</${list}>`);
          list = "";
        }
      };
      for (const line of lines) {
        if (/^\s*```/.test(line)) {
          if (inCode) {
            out.push("</pre>");
            inCode = false;
          } else {
            closeList();
            out.push("<pre>");
            inCode = true;
          }
          continue;
        }
        if (inCode) {
          out.push(`${esc(line)}
`);
          continue;
        }
        if (!line.trim()) {
          closeList();
          continue;
        }
        const heading = line.match(/^\s*(#{1,4})\s+(.*)$/);
        if (heading) {
          closeList();
          const level = Math.min(6, 3 + heading[1].length);
          out.push(`<h${level}>${wikiInlineMarkup(heading[2], doc, docs)}</h${level}>`);
          continue;
        }
        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          closeList();
          out.push("<hr>");
          continue;
        }
        const quote = line.match(/^\s*>\s?(.*)$/);
        if (quote) {
          closeList();
          out.push(`<blockquote>${wikiInlineMarkup(quote[1], doc, docs)}</blockquote>`);
          continue;
        }
        const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
        if (bullet) {
          if (list !== "ul") {
            closeList();
            out.push("<ul>");
            list = "ul";
          }
          out.push(`<li>${wikiInlineMarkup(bullet[1], doc, docs)}</li>`);
          continue;
        }
        const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
        if (ordered) {
          if (list !== "ol") {
            closeList();
            out.push("<ol>");
            list = "ol";
          }
          out.push(`<li>${wikiInlineMarkup(ordered[1], doc, docs)}</li>`);
          continue;
        }
        closeList();
        out.push(`<p>${wikiInlineMarkup(line, doc, docs)}</p>`);
      }
      if (inCode)
        out.push("</pre>");
      closeList();
      return out.join("");
    }
    function wikiTriggerMarkerFor(docId) {
      return `${WIKI_TRIGGER_MARKER}:${docId}`;
    }
    function wikiAlwaysContext(chat, wiki) {
      const docs = wikiAlwaysDocs(wiki);
      const lines = [WIKI_ALWAYS_MARKER, `[이야기 위키 · 항상 기억 개요 · ${chatLabel(chat)}]`, "아래는 이 이야기에서 언제나 전제로 두는 위키 문서의 한 줄 개요다. 본문 전체가 아니라 개요만 제공한다."];
      let used = 0;
      for (const doc of docs) {
        const line = `- [${wikiCategoryLabel(doc)}] ${truncate(doc.title, 60)}: ${truncate(doc.summary, 220)}`;
        if (lines.length > 3 && used + line.length + 1 > wiki.alwaysBudgetChars)
          break;
        lines.push(line);
        used += line.length + 1;
      }
      lines.push("자세한 내용이 필요하면 관련 키워드가 등장할 때 해당 문서가 따로 제공된다. 목록 자체를 낭독하지 마라.");
      return lines.join(`
`);
    }
    function wikiDocContext(chat, doc) {
      const body = safeArray(doc.sections).map((section) => `${"#".repeat(Math.max(2, Math.min(4, (Number(section.level) || 1) + 1)))} ${section.heading}
${section.body}`).join(`

`);
      return [
        WIKI_MARKER,
        `[이야기 위키 · ${chatLabel(chat)} · ${doc.title}]`,
        `분류: ${wikiCategoryPath(doc)}`,
        doc.aliases.length ? `별칭: ${doc.aliases.join(" / ")}` : "",
        doc.summary ? `개요: ${doc.summary}` : "",
        body
      ].filter(Boolean).join(`
`).slice(0, 9000);
    }
    function wikiHeaderContext(wiki) {
      const base = String(wiki.injectionPrompt || "").trim() || DEFAULT_WIKI_INJECTION_PROMPT;
      return `${base}
${ADVANCED_MEMORY_PRIORITY_RULE}`;
    }
    function wikiHeaderPayload(wiki, chat) {
      const any = wiki.docs.some((doc) => wikiDocInjectable(doc, wiki)) || wiki.injectionEnabled && wikiAlwaysDocs(wiki).length > 0;
      return constantEntryPayload({
        tag: WIKI_HEADER_ENTRY_TAG,
        name: "이야기 위키 · 해석 지침",
        content: wikiHeaderContext(wiki),
        enabled: any,
        order: 34,
        dynamicState: { memoryCabinetChatId: String(chat.id), managedBy: LOREBOOK_TAG, kind: "wiki-header" }
      });
    }
    function wikiAlwaysPayload(wiki, chat) {
      return constantEntryPayload({
        tag: WIKI_ALWAYS_ENTRY_TAG,
        name: "이야기 위키 · 항상 기억 개요",
        content: wikiAlwaysContext(chat, wiki),
        enabled: wiki.injectionEnabled && wikiAlwaysDocs(wiki).length > 0,
        order: 31,
        dynamicState: { memoryCabinetChatId: String(chat.id), managedBy: LOREBOOK_TAG, kind: "wiki-always" }
      });
    }
    function wikiDocEntryPayload(chat, doc, wiki) {
      return {
        name: `이야기 위키 · ${truncate(doc.title, 110)}`,
        content: wikiDocContext(chat, doc),
        description: `기억 보관함 위키 문서 · wiki:${doc.id}`,
        keys: [wikiTriggerMarkerFor(doc.id)],
        secondaryKeys: [],
        enabled: wikiDocInjectable(doc, wiki),
        constant: false,
        selective: false,
        selectiveLogic: "and",
        probability: null,
        scanDepth: null,
        matchWholeWords: false,
        caseSensitive: true,
        useRegex: false,
        position: 0,
        depth: 4,
        order: 46,
        role: "system",
        preventRecursion: true,
        excludeRecursion: false,
        delayUntilRecursion: true,
        excludeFromVectorization: true,
        tag: WIKI_DOC_ENTRY_TAG,
        dynamicState: { memoryCabinetChatId: String(chat.id), memoryCabinetWikiId: String(doc.id), managedBy: LOREBOOK_TAG, kind: "wiki-doc" }
      };
    }
    function wikiProxyEntryPayload(chat, doc, condition, index, wiki) {
      const group = condition.kind === "group";
      return {
        name: `위키 조건 · ${truncate(doc.title, 90)} · ${index + 1}`,
        content: `<!-- ${wikiTriggerMarkerFor(doc.id)} -->`,
        description: `기억 보관함 위키 검색 조건 · wiki:${doc.id}`,
        keys: group ? [condition.keys[0]] : condition.keys.slice(),
        secondaryKeys: group ? condition.keys.slice(1) : [],
        enabled: wiki.injectionEnabled && !doc.excludeFromContext,
        constant: false,
        selective: group,
        selectiveLogic: group ? "and_all" : "and",
        probability: null,
        scanDepth: null,
        matchWholeWords: false,
        caseSensitive: false,
        useRegex: false,
        position: 0,
        depth: 4,
        order: 45,
        role: "system",
        preventRecursion: false,
        excludeRecursion: true,
        delayUntilRecursion: false,
        excludeFromVectorization: true,
        tag: WIKI_TRIGGER_ENTRY_TAG,
        dynamicState: { memoryCabinetChatId: String(chat.id), memoryCabinetWikiId: String(doc.id), memoryCabinetConditionIndex: index, managedBy: LOREBOOK_TAG, kind: "wiki-trigger" }
      };
    }
    function matchWikiTriggers(doc, text) {
      const haystack = String(text || "").toLocaleLowerCase();
      const reasons = [];
      wikiRetrievalTerms(doc).forEach((term) => {
        if (haystack.includes(term.toLocaleLowerCase()))
          reasons.push(`단독: ${term}`);
      });
      normalizeTriggerGroups(doc.keywordGroups).forEach((group) => {
        if (group.every((word) => haystack.includes(word.toLocaleLowerCase())))
          reasons.push(`조합: ${group.join(" + ")}`);
      });
      return reasons;
    }
    function wikiRelatedMemoryRows(doc, data = state.currentData) {
      const normalized = normalizeData(data || {});
      const terms = [...new Set([doc.title, ...safeArray(doc.aliases), ...wikiRetrievalTerms(doc)].map(wikiKey).filter((value) => value.length >= 2))];
      if (!terms.length)
        return [];
      const since = String(doc.aiUpdatedAt || "");
      const rows = [];
      const touch = (kind, id, label, text, updatedAt) => {
        const stamp = String(updatedAt || "");
        if (since && stamp && stamp <= since)
          return;
        if (since && !stamp)
          return;
        const haystack = `${label}
${text}`.toLocaleLowerCase();
        if (!terms.some((term) => haystack.includes(term)))
          return;
        rows.push({ kind, id: String(id), label: String(label || ""), text: truncate(String(text || ""), 600), updatedAt: stamp });
      };
      for (const entity of normalizeElementMemory(normalized.elementMemory).entities)
        touch("element", entity.id, entity.name, elementFactLines(entity), entity.updatedAt);
      for (const item of safeArray(normalized.items)) {
        if (item.type === "anchor" && item.archived)
          continue;
        if (item.type === "promise" && item.status === "cancelled")
          continue;
        if (isRestrictedItem(item))
          continue;
        touch(item.type === "anchor" ? "anchor" : "promise", item.id, item.title, item.content, item.updatedAt);
      }
      for (const row of summaryRowsFromMetadata(state.currentChat?.metadata))
        touch("summary", row.id, row.title || "요약", stripCharacterConditionSections(row.content), row.updatedAt || row.createdAt);
      return rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 12);
    }
    function wikiProposalFor(docId, wiki = wikiState()) {
      return wiki.proposals.find((row) => row.docId === String(docId)) || null;
    }
    function wikiConnectionId(wiki = wikiState()) {
      return String(wiki.connectionId || state.modelConnectionId || chooseDefaultConnection(state.currentChat) || "");
    }
    async function collectWikiSourceRows() {
      const data = normalizeData(state.currentData);
      const rows = [];
      for (const entity of normalizeElementMemory(data.elementMemory).entities) {
        rows.push({ id: `element:${entity.id}`, kind: "element", refId: entity.id, label: entity.name, text: elementFactLines(entity), updatedAt: entity.updatedAt });
      }
      for (const item of safeArray(data.items)) {
        if (item.type === "anchor" && item.archived)
          continue;
        if (isRestrictedItem(item))
          continue;
        rows.push({ id: `${item.type}:${item.id}`, kind: item.type === "anchor" ? "anchor" : "promise", refId: item.id, label: item.title, text: item.content, updatedAt: item.updatedAt });
      }
      for (const row of summaryRowsFromMetadata(state.currentChat?.metadata)) {
        rows.push({ id: `summary:${row.id}`, kind: "summary", refId: String(row.id || ""), label: String(row.title || "요약"), text: stripCharacterConditionSections(row.content), updatedAt: String(row.updatedAt || row.createdAt || "") });
      }
      try {
        const payload = await api(`chats/${encodeURIComponent(state.selectedChatId)}/messages?limit=120`);
        const messages = readableMessages(extractArray(payload, ["messages", "items", "results"]), "wiki");
        for (const row of messages.slice(-30).reverse()) {
          rows.push({ id: `message:${String(row.id || uid("wmsg"))}`, kind: "message", refId: String(row.id || ""), label: `${roleLabel(row.role)} · ${truncate(String(row.content || ""), 40)}`, text: String(row.content || ""), updatedAt: String(row.createdAt || "") });
        }
      } catch (error) {
        console.warn("[기억 보관함] wiki source messages failed", error);
      }
      return rows.filter((row) => String(row.text || "").trim());
    }
    function wikiSelectedSourceRows() {
      return state.wikiSourceRows.filter((row) => state.wikiSourceSelected.has(String(row.id)));
    }
    function wikiSourceBlock(rows) {
      return rows.map((row, index) => `[${index + 1}] (${WIKI_SOURCE_KIND_LABEL[row.kind] || row.kind}) ${row.label}
${truncate(row.text, 1400)}`).join(`

`);
    }
    function wikiDraftSystemPrompt(wiki, rows) {
      const criteria = String(wiki.draftPrompt || "").trim() || DEFAULT_WIKI_DRAFT_PROMPT;
      const topic = String(state.wikiDraftTopic || "").trim();
      const contract = [
        "Response contract — return ONE JSON object and nothing else:",
        '{"documents":[{"title":"...","titleKo":null,"category":"character","subcategory":"","summary":"...","summaryKo":null,"aliases":["..."],"keywordsKo":["..."],"keywordsEn":["..."],"keywordGroups":[["...","..."]],"sections":[{"heading":"...","headingKo":null,"level":1,"body":"markdown with [1] citations","bodyKo":null}],"cited":[1,2]}]}',
        `- category must be one of: ${Object.keys(WIKI_CATEGORY_LABEL).join(", ")}.`,
        `- At most ${WIKI_CANDIDATE_LIMIT} documents, at most ${WIKI_SECTION_LIMIT} sections each.`,
        "- summary is one or two sentences, at most 200 characters, and must read on its own.",
        "- body is Markdown. Use [n] to cite the numbered source list. Use [문서 제목] to link another wiki document.",
        "- cited lists every source number used anywhere in that document.",
        "- keywordsKo and keywordsEn are retrieval phrases, not the same thing as aliases. Avoid bare generic nouns; put generic words in keywordGroups with a specific companion.",
        `- level is 1, 2, or 3. Use 2 and 3 only for real sub-sections of the section above, at most ${WIKI_SECTION_MAX_LEVEL} levels.`,
        "- keywordsKo holds Korean retrieval phrases and keywordsEn holds Latin-script ones. Never put an English phrase in keywordsKo.",
        '- Return {"documents":[]} when the sources contain nothing worth a document.',
        LANGUAGE_CONTRACT
      ].join(`
`);
      return [criteria, topic ? `
[요청한 주제]
${topic}` : "", `
[SOURCE LIST]
${wikiSourceBlock(rows)}
[/SOURCE LIST]`, `
${contract}`].filter(Boolean).join(`
`);
    }
    function wikiRemapCitations(text, mapping) {
      return String(text || "").replace(/\[(\d{1,3})\]/g, (whole, digits) => {
        const local = mapping.get(Number(digits));
        return local ? `[${local}]` : "";
      });
    }
    function parseWikiDraftJson(output, rows) {
      const fragments = collectBalancedJsonFragments(output);
      let parsed = null;
      for (const fragment of fragments) {
        for (const candidate of [fragment, repairJsonishText(fragment)]) {
          try {
            parsed = JSON.parse(candidate);
            break;
          } catch {}
        }
        if (parsed)
          break;
      }
      if (!parsed)
        return { ok: false, rows: [] };
      const list = Array.isArray(parsed) ? parsed : safeArray(parsed.documents || parsed.docs || parsed.items);
      const out = [];
      for (const raw of list) {
        if (!isRecord(raw))
          continue;
        const title = String(raw.title || "").trim().replace(/\s+/g, " ").slice(0, 120);
        if (!title)
          continue;
        const sections = safeArray(raw.sections).map((section) => normalizeWikiSection(section)).filter(Boolean).slice(0, WIKI_SECTION_LIMIT);
        const summary = String(raw.summary || "").trim().replace(/\s+/g, " ").slice(0, 400);
        if (!summary && !sections.length)
          continue;
        const usedGlobal = new Set;
        const collect = (text) => {
          for (const match of String(text || "").matchAll(/\[(\d{1,3})\]/g))
            usedGlobal.add(Number(match[1]));
        };
        collect(summary);
        sections.forEach((section) => collect(section.body));
        safeArray(raw.cited).map(Number).filter((value) => Number.isInteger(value)).forEach((value) => usedGlobal.add(value));
        const ordered = [...usedGlobal].filter((value) => value >= 1 && value <= rows.length).sort((a, b) => a - b);
        const mapping = new Map(ordered.map((globalIndex, i) => [globalIndex, i + 1]));
        const sources = ordered.map((globalIndex) => {
          const row = rows[globalIndex - 1];
          return normalizeWikiSource({ kind: row.kind, refId: row.refId, label: row.label, quote: truncate(row.text, 1200) });
        }).filter(Boolean);
        out.push(normalizeWikiDoc({
          id: uid("wdoc"),
          title,
          category: raw.category,
          subcategory: raw.subcategory,
          titleKo: String(raw.titleKo || "").trim().slice(0, 120),
          summary: wikiRemapCitations(summary, mapping).replace(/\s+/g, " ").trim(),
          summaryKo: wikiRemapCitations(String(raw.summaryKo || "").trim(), mapping).replace(/\s+/g, " ").trim(),
          summaryManaged: "ai",
          sections: sections.map((section) => ({ ...section, body: wikiRemapCitations(section.body, mapping), bodyKo: wikiRemapCitations(section.bodyKo, mapping), managed: "ai" })),
          aliases: raw.aliases,
          keywordsKo: normalizeTextList([...normalizeTextList(raw.keywordsKo, 16, 80), ...seedKeywordsByScript(title).ko], 16, 80),
          keywordsEn: normalizeTextList([...normalizeTextList(raw.keywordsEn, 16, 80), ...seedKeywordsByScript(title).en], 16, 80),
          keywordGroups: raw.keywordGroups,
          sources,
          aiUpdatedAt: nowIso()
        }));
        if (out.length >= WIKI_CANDIDATE_LIMIT)
          break;
      }
      return { ok: true, rows: out };
    }
    async function generateWikiDrafts() {
      const wiki = wikiState();
      const rows = wikiSelectedSourceRows();
      if (!rows.length)
        throw new Error("초안의 근거로 쓸 기억을 하나 이상 선택해 주세요.");
      const connectionId = wikiConnectionId(wiki);
      if (!connectionId)
        throw new Error("위키 초안에 사용할 모델 연결을 선택해 주세요.");
      setBusy(true, "모델이 위키 초안을 작성하는 중…");
      try {
        const payload = await api("generate/raw", {
          method: "POST",
          timeoutMs: MODEL_TIMEOUT_MS,
          body: {
            connectionId,
            runId: uid("wiki-draft"),
            streaming: false,
            messages: [
              { role: "system", content: wikiDraftSystemPrompt(wiki, rows) },
              { role: "user", content: `[EXISTING WIKI TITLES]
${wiki.docs.map((doc) => doc.title).join(" / ") || "(none)"}
[/EXISTING WIKI TITLES]

위 SOURCE LIST만 근거로 위키 문서 초안을 작성하세요.` }
            ],
            parameters: { maxTokens: 4000, reasoningEffort: null }
          }
        });
        const output = extractGeneratedText(payload);
        const parsed = parseWikiDraftJson(output, rows);
        if (!parsed.ok) {
          openRawRecovery("wiki", output, rows);
          return;
        }
        state.wikiCandidates = parsed.rows;
        state.wikiCandidateSelected = new Set(parsed.rows.map((row, index) => String(index)));
        state.layer = "wiki-candidates";
        if (!parsed.rows.length)
          toast("이번 근거에서는 문서로 만들 만한 내용을 찾지 못했습니다.");
      } finally {
        state.busy = false;
        if (state.busyTimer)
          clearInterval(state.busyTimer);
        state.busyTimer = null;
        render();
      }
    }
    function wikiCandidateFromDom(candidate, index) {
      const get = (suffix) => document.getElementById(`mmc-wc-${suffix}-${index}`);
      const lines = (value, max) => String(value || "").split(/\n/).map((row) => row.trim()).filter(Boolean).slice(0, max);
      return normalizeWikiDoc({
        ...candidate,
        title: String(get("title")?.value || candidate.title || "").trim().slice(0, 120),
        category: String(get("category")?.value || candidate.category || "misc"),
        subcategory: String(get("subcategory")?.value || candidate.subcategory || ""),
        summary: String(get("summary")?.value || candidate.summary || "").trim().slice(0, 400),
        aliases: normalizeTextList(lines(get("aliases")?.value, 12), 12, 80),
        keywordsKo: normalizeTextList(lines(get("ko")?.value, 16), 16, 80),
        keywordsEn: normalizeTextList(lines(get("en")?.value, 16), 16, 80)
      });
    }
    async function applyWikiCandidates() {
      const selected = [...state.wikiCandidateSelected].map(Number).filter((index) => Number.isInteger(index));
      if (!selected.length)
        throw new Error("저장할 문서를 선택해 주세요.");
      const data = await freshOwnedData();
      const wiki = normalizeWiki(data.wiki);
      const conflicts = [];
      const saved = new Set;
      let created = 0;
      for (const index of selected.slice().sort((a, b) => a - b)) {
        const original = state.wikiCandidates[index];
        if (!original)
          continue;
        const doc = wikiCandidateFromDom(original, index);
        if (!doc.title) {
          conflicts.push("제목 없는 문서");
          continue;
        }
        if (wiki.docs.length >= WIKI_DOC_LIMIT) {
          conflicts.push(`${doc.title}: 문서 상한 ${WIKI_DOC_LIMIT}개`);
          continue;
        }
        if (wikiFindByTitle(wiki.docs, doc.title)) {
          conflicts.push(`${doc.title}: 같은 제목/별칭 문서가 이미 있음`);
          continue;
        }
        wiki.docs.push(doc);
        created += 1;
        saved.add(index);
      }
      wiki.originChatId = String(state.selectedChatId || "");
      data.wiki = wiki;
      await persistData(data);
      if (conflicts.length) {
        state.wikiCandidates = state.wikiCandidates.filter((row, index) => !saved.has(index));
        state.wikiCandidateSelected = new Set(state.wikiCandidates.map((row, index) => String(index)));
        state.layer = state.wikiCandidates.length ? "wiki-candidates" : null;
        toast(`${created}개 저장 · ${conflicts.length}개는 중복/상한 때문에 남겨뒀습니다.`, true);
      } else {
        state.wikiCandidates = [];
        state.wikiCandidateSelected.clear();
        state.layer = null;
        toast(`위키 문서 ${created}개를 저장했습니다.`);
      }
      render();
    }
    function wikiUpdateSystemPrompt(wiki) {
      const criteria = String(wiki.updatePrompt || "").trim() || DEFAULT_WIKI_UPDATE_PROMPT;
      const contract = [
        "Response contract — return ONE JSON object and nothing else:",
        '{"summary":null,"summaryKo":null,"changes":[{"sectionId":"...","heading":"...","body":"full new markdown","bodyKo":null,"reason":"why"}],"conflicts":["..."]}',
        "- sectionId must be copied exactly from the document, or null to propose a brand new section.",
        "- Never return a sectionId whose section is marked USER-LOCKED. Put that case in conflicts instead.",
        "- summary is the replacement one-line overview, or null to leave it unchanged.",
        "- body is the complete new text of that section, in Markdown, keeping any [n] citation markers that still apply.",
        `- At most ${WIKI_SECTION_LIMIT} changes.`,
        '- Return {"changes":[],"conflicts":[]} when nothing should change.',
        LANGUAGE_CONTRACT
      ].join(`
`);
      return `${criteria}

${contract}`;
    }
    function wikiDocForPrompt(doc) {
      const lines = [`title: ${doc.title}`, `category: ${wikiCategoryPath(doc)}`, `summary: ${doc.summary || "(none)"}`];
      if (doc.aliases.length)
        lines.push(`aliases: ${doc.aliases.join(" | ")}`);
      for (const section of doc.sections) {
        lines.push(`
--- section id=${section.id} heading="${section.heading}" ${section.managed === "user" ? "USER-LOCKED" : "AI-MANAGED"} ---
${section.body}`);
      }
      return lines.join(`
`);
    }
    function parseWikiProposalJson(output, doc) {
      const fragments = collectBalancedJsonFragments(output);
      let parsed = null;
      for (const fragment of fragments) {
        for (const candidate of [fragment, repairJsonishText(fragment)]) {
          try {
            parsed = JSON.parse(candidate);
            break;
          } catch {}
        }
        if (parsed)
          break;
      }
      if (!parsed || !isRecord(parsed))
        return { ok: false, changes: [], conflicts: [] };
      const lockedIds = new Set(doc.sections.filter((section) => section.managed === "user").map((section) => section.id));
      const byId = new Map(doc.sections.map((section) => [section.id, section]));
      const changes = [];
      const conflicts = normalizeTextList(parsed.conflicts, 12, 300);
      const rawSummary = parsed.summary;
      if (typeof rawSummary === "string" && rawSummary.trim() && rawSummary.trim() !== doc.summary) {
        if (doc.summaryManaged === "user") {
          conflicts.push("개요가 사용자 편집으로 잠겨 있어 개요 변경 제안을 적용하지 않았습니다.");
        } else {
          changes.push(normalizeWikiProposalChange({
            kind: "summary",
            sectionId: "",
            heading: "한눈에 보는 개요",
            before: doc.summary,
            after: rawSummary.trim().replace(/\s+/g, " ").slice(0, WIKI_SUMMARY_MAX),
            afterKo: String(parsed.summaryKo || "").trim().replace(/\s+/g, " ").slice(0, WIKI_SUMMARY_MAX),
            reason: ""
          }));
        }
      }
      for (const raw of safeArray(parsed.changes || parsed.sections)) {
        if (!isRecord(raw))
          continue;
        const body = String(raw.body ?? raw.after ?? "").replace(/\r\n?/g, `
`);
        if (!body.trim())
          continue;
        const sectionId = String(raw.sectionId || "");
        if (sectionId && lockedIds.has(sectionId)) {
          const section = byId.get(sectionId);
          conflicts.push(`잠긴 섹션 "${section?.heading || sectionId}"에 대한 변경 제안이 들어와 적용하지 않았습니다.`);
          continue;
        }
        const target = sectionId ? byId.get(sectionId) : null;
        if (sectionId && !target)
          continue;
        if (target && target.body.trim() === body.trim())
          continue;
        changes.push(normalizeWikiProposalChange({
          sectionId: target ? target.id : "",
          heading: String(raw.heading || target?.heading || "새 섹션"),
          before: target ? target.body : "",
          after: body,
          afterKo: String(raw.bodyKo || "").trim(),
          reason: String(raw.reason || ""),
          kind: target ? "update" : "add"
        }));
        if (changes.length >= WIKI_SECTION_LIMIT + 1)
          break;
      }
      return { ok: true, changes: changes.filter(Boolean), conflicts: normalizeTextList(conflicts, 12, 300) };
    }
    async function storeWikiProposal(doc, parsed, related) {
      if (!parsed.changes.length && !parsed.conflicts.length) {
        toast("모델이 바꿀 내용이 없다고 판단했습니다. 문서는 그대로 둡니다.");
        return;
      }
      const proposal = normalizeWikiProposal({
        docId: doc.id,
        docTitle: doc.title,
        baseUpdatedAt: doc.updatedAt,
        sourceCount: safeArray(related).length,
        sources: safeArray(related).map((row) => normalizeWikiSource({ kind: row.kind, refId: row.id, label: row.label, quote: truncate(row.text, 1200) })).filter(Boolean),
        changes: parsed.changes,
        conflicts: parsed.conflicts
      });
      if (!proposal) {
        toast("적용할 만한 변경 제안이 없습니다.");
        return;
      }
      const data = await freshOwnedData();
      const nextWiki = normalizeWiki(data.wiki);
      const keptProposals = [proposal, ...nextWiki.proposals.filter((row) => row.docId !== doc.id)];
      if (keptProposals.length > 40)
        toast(`변경 제안은 최대 40건까지 보관해요. 가장 오래된 제안 ${keptProposals.length - 40}건이 목록에서 빠졌습니다.`, true);
      nextWiki.proposals = keptProposals.slice(0, 40);
      data.wiki = nextWiki;
      await persistData(data, { sync: false, silent: true });
      state.rawRecovery = null;
      state.wikiProposalDocId = doc.id;
      state.wikiProposalSelected = new Set(proposal.changes.map((row, index) => String(index)));
      state.layer = "wiki-proposal";
      toast(`새 기억 ${safeArray(related).length}건을 근거로 변경 제안 ${proposal.changes.length}건을 만들었습니다. 아직 문서는 바뀌지 않았습니다.`);
    }
    async function generateWikiProposal(docId) {
      const wiki = wikiState();
      const doc = wiki.docs.find((row) => row.id === String(docId));
      if (!doc)
        throw new Error("변경 제안을 만들 문서를 찾지 못했습니다.");
      if (doc.aiLocked)
        throw new Error("AI 수정 잠금이 켜져 있는 문서입니다. 잠금을 풀고 다시 시도해 주세요.");
      const related = wikiRelatedMemoryRows(doc);
      if (!related.length)
        throw new Error("이 문서와 관련된 새 기억이 없습니다.");
      const connectionId = wikiConnectionId(wiki);
      if (!connectionId)
        throw new Error("위키 갱신에 사용할 모델 연결을 선택해 주세요.");
      setBusy(true, "모델이 변경사항을 정리하는 중…");
      try {
        const sourceBlock = related.map((row, index) => `[${index + 1}] (${WIKI_SOURCE_KIND_LABEL[row.kind] || row.kind}) ${row.label}
${truncate(row.text, 900)}`).join(`

`);
        const payload = await api("generate/raw", {
          method: "POST",
          timeoutMs: MODEL_TIMEOUT_MS,
          body: {
            connectionId,
            runId: uid("wiki-update"),
            streaming: false,
            messages: [
              { role: "system", content: wikiUpdateSystemPrompt(wiki) },
              { role: "user", content: `[CURRENT DOCUMENT]
${wikiDocForPrompt(doc)}
[/CURRENT DOCUMENT]

[NEW RECORDS]
${sourceBlock}
[/NEW RECORDS]` }
            ],
            parameters: { maxTokens: 3000, reasoningEffort: null }
          }
        });
        const output = extractGeneratedText(payload);
        const parsed = parseWikiProposalJson(output, doc);
        if (!parsed.ok) {
          state.rawRecovery = { kind: "wiki-update", text: output, rows: related, docId: doc.id };
          state.layer = "raw-repair";
          toast("모델 응답의 JSON 형식이 흔들렸습니다. 원문을 보존했으니 수정 없이 다시 읽거나 직접 고칠 수 있습니다.", true);
          return;
        }
        await storeWikiProposal(doc, parsed, related);
      } finally {
        state.busy = false;
        if (state.busyTimer)
          clearInterval(state.busyTimer);
        state.busyTimer = null;
        render();
      }
    }
    async function applyWikiProposal() {
      const proposal = wikiProposalFor(state.wikiProposalDocId);
      if (!proposal)
        throw new Error("적용할 변경 제안이 없습니다.");
      const picked = proposal.changes.filter((row, index) => state.wikiProposalSelected.has(String(index)));
      if (!picked.length)
        throw new Error("반영할 변경사항을 선택해 주세요.");
      const data = await freshOwnedData();
      const wiki = normalizeWiki(data.wiki);
      const doc = wiki.docs.find((row) => row.id === proposal.docId);
      if (!doc)
        throw new Error("문서를 찾지 못했습니다. 이미 삭제된 것 같습니다.");
      if (doc.aiLocked)
        throw new Error("AI 수정 잠금이 켜져 있어 반영할 수 없습니다.");
      const now = nowIso();
      const skipped = [];
      let applied = 0;
      for (const change of picked) {
        if (change.kind === "summary") {
          if (doc.summaryManaged === "user") {
            skipped.push("개요: 사용자 편집 잠금");
            continue;
          }
          if (doc.summary.trim() !== String(change.before || "").trim()) {
            skipped.push("개요: 그 사이에 직접 수정됨");
            continue;
          }
          doc.summary = String(change.after || "").replace(/\s+/g, " ").trim().slice(0, WIKI_SUMMARY_MAX);
          doc.summaryKo = String(change.afterKo || "").replace(/\s+/g, " ").trim().slice(0, WIKI_SUMMARY_MAX);
          applied += 1;
          continue;
        }
        if (change.sectionId) {
          const section = doc.sections.find((row) => row.id === change.sectionId);
          if (!section) {
            skipped.push(`${change.heading}: 섹션이 사라짐`);
            continue;
          }
          if (section.managed === "user") {
            skipped.push(`${section.heading}: 사용자 편집 잠금`);
            continue;
          }
          if (section.body.trim() !== String(change.before || "").trim()) {
            skipped.push(`${section.heading}: 그 사이에 직접 수정됨`);
            continue;
          }
          section.body = String(change.after || "").slice(0, WIKI_SECTION_BODY_HARD_MAX);
          section.bodyKo = String(change.afterKo || "").slice(0, WIKI_SECTION_BODY_HARD_MAX);
          section.updatedAt = now;
          applied += 1;
          continue;
        }
        if (doc.sections.length >= WIKI_SECTION_LIMIT) {
          skipped.push(`${change.heading}: 섹션 상한`);
          continue;
        }
        const created = normalizeWikiSection({ heading: change.heading, body: change.after, bodyKo: change.afterKo, managed: "ai", level: 1, updatedAt: now });
        if (!created) {
          skipped.push(`${change.heading}: 빈 섹션`);
          continue;
        }
        doc.sections.push(created);
        applied += 1;
      }
      if (!applied) {
        await persistData(data, { sync: false, silent: true });
        throw new Error(`반영할 수 있는 변경사항이 없습니다. ${skipped.join(" / ")}`);
      }
      const existingSourceKeys = new Set(doc.sources.map((row) => `${row.kind}:${row.refId}`));
      for (const source of proposal.sources) {
        if (doc.sources.length >= 24)
          break;
        const key = `${source.kind}:${source.refId}`;
        if (existingSourceKeys.has(key))
          continue;
        existingSourceKeys.add(key);
        doc.sources.push(source);
      }
      doc.updatedAt = now;
      doc.aiUpdatedAt = now;
      wiki.proposals = wiki.proposals.filter((row) => row.id !== proposal.id);
      data.wiki = wiki;
      await persistData(data);
      state.layer = null;
      state.wikiProposalDocId = "";
      state.wikiProposalSelected = new Set;
      toast(skipped.length ? `${applied}건 반영 · ${skipped.length}건은 건너뛰었습니다: ${skipped.join(" / ")}` : `변경사항 ${applied}건을 반영했습니다.`, skipped.length > 0);
      render();
    }
    async function dismissWikiProposal(docId) {
      const data = await freshOwnedData();
      const wiki = normalizeWiki(data.wiki);
      const before = wiki.proposals.length;
      wiki.proposals = wiki.proposals.filter((row) => row.docId !== String(docId));
      if (wiki.proposals.length === before)
        return;
      const doc = wiki.docs.find((row) => row.id === String(docId));
      if (doc)
        doc.aiUpdatedAt = nowIso();
      data.wiki = wiki;
      await persistData(data, { sync: false, silent: true });
      state.layer = null;
      state.wikiProposalDocId = "";
      state.wikiProposalSelected = new Set;
      toast("변경 제안을 무시했습니다. 문서는 그대로입니다.");
      render();
    }
    function wikiCategoryCounts(wiki) {
      const counts = {};
      for (const doc of wiki.docs)
        counts[doc.category] = (counts[doc.category] || 0) + 1;
      return counts;
    }
    function wikiFilteredDocs(wiki) {
      const query = String(state.wikiSearch || "").trim().toLocaleLowerCase();
      return wiki.docs.slice().filter((doc) => state.wikiCategoryFilter === "all" || doc.category === state.wikiCategoryFilter).filter((doc) => !query || wikiSearchHaystack(doc).includes(query)).sort((a, b) => String(a.category).localeCompare(String(b.category)) || String(a.subcategory).localeCompare(String(b.subcategory), "ko") || String(a.title).localeCompare(String(b.title), "ko"));
    }
    function wikiCurrentDoc(wiki = wikiState()) {
      return wiki.docs.find((doc) => doc.id === String(state.wikiSelectedId || "")) || null;
    }
    function wikiDocBadges(doc) {
      return [
        doc.alwaysRemember ? '<i class="mmc-wiki-badge is-always" title="항상 기억">항상</i>' : "",
        doc.aiLocked ? '<i class="mmc-wiki-badge is-lock" title="AI 수정 잠금">\uD83D\uDD12</i>' : "",
        doc.excludeFromContext ? '<i class="mmc-wiki-badge is-off" title="AI 참조 제외">제외</i>' : ""
      ].filter(Boolean).join("");
    }
    function wikiPlainText(value) {
      return String(value || "").replace(/\[(\d{1,3})\]/g, "").replace(/\[([^\[\]\n]{1,80})\]/g, "$1").replace(/[*`#>]/g, "").replace(/\s+/g, " ").trim();
    }
    function wikiListRow(doc, wiki) {
      const pending = wikiProposalFor(doc.id, wiki);
      return `<button class="mmc-wiki-row ${doc.id === state.wikiSelectedId ? "is-active" : ""}" data-action="wiki-open" data-id="${esc(doc.id)}">
      <span class="mmc-wiki-row-top"><b>${esc(displayText(doc.title, doc.titleKo))}</b>${wikiDocBadges(doc)}${pending ? '<i class="mmc-wiki-badge is-pending" title="변경 제안 대기">제안</i>' : ""}</span>
      <span class="mmc-wiki-row-sum">${esc(truncate(wikiPlainText(displayText(doc.summary, doc.summaryKo) || displayText(doc.sections[0]?.body, doc.sections[0]?.bodyKo) || ""), 64)) || "개요 없음"}</span>
    </button>`;
    }
    function wikiListMarkup(wiki) {
      const docs = wikiFilteredDocs(wiki);
      if (!docs.length)
        return `<div class="mmc-empty">${wiki.docs.length ? "검색 결과가 없습니다." : "아직 위키 문서가 없습니다."}</div>`;
      const groups = [];
      for (const doc of docs) {
        const key = `${doc.category}\x00${doc.subcategory}`;
        const last = groups[groups.length - 1];
        if (last && last.key === key)
          last.rows.push(doc);
        else
          groups.push({ key, label: wikiCategoryPath(doc), rows: [doc] });
      }
      return groups.map((group) => `<div class="mmc-wiki-group"><h4>${esc(group.label)}<i>${group.rows.length}</i></h4>${group.rows.map((doc) => wikiListRow(doc, wiki)).join("")}</div>`).join("");
    }
    function wikiSidePanel(wiki) {
      const counts = wikiCategoryCounts(wiki);
      const options = [`<option value="all" ${state.wikiCategoryFilter === "all" ? "selected" : ""}>모든 문서 (${wiki.docs.length})</option>`].concat(Object.entries(WIKI_CATEGORY_LABEL).map(([id, label]) => `<option value="${id}" ${state.wikiCategoryFilter === id ? "selected" : ""}>${label} (${counts[id] || 0})</option>`)).join("");
      return `<aside class="mmc-wiki-side">
      <div class="mmc-wiki-side-tools">
        <label class="mmc-searchbox">${SVG.search}<input id="mmc-wiki-search" class="mmc-wiki-search" value="${esc(state.wikiSearch)}" placeholder="문서 검색" aria-label="문서 검색"></label>
        <select id="mmc-wiki-category-filter" aria-label="분류">${options}</select>
      </div>
      <div class="mmc-wiki-list" data-wiki-list>${wikiListMarkup(wiki)}</div>
      <div class="mmc-wiki-side-foot">
        <button class="mmc-btn mmc-primary" data-action="wiki-new">${SVG.plus}<span>새 문서</span></button>
        <button class="mmc-btn" data-action="wiki-draft-open">${SVG.spark}<span>AI 초안</span></button>
        <div class="mmc-wiki-status"><span>주입 ${wiki.injectionEnabled ? "켜짐" : "꺼짐"} · 항상 기억 ${wikiAlwaysDocs(wiki).length} · 제안 ${wiki.proposals.length}</span><button class="mmc-link" data-action="wiki-settings">위키 설정</button></div>
      </div>
    </aside>`;
    }
    function wikiSectionDomId(section) {
      return `mmc-wiki-h-${section.id}`;
    }
    function wikiHasKo(doc) {
      return !!(String(doc?.titleKo || "").trim() || String(doc?.summaryKo || "").trim() || safeArray(doc?.sections).some((section) => String(section.headingKo || "").trim() || String(section.bodyKo || "").trim()));
    }
    function wikiSectionNumbers(sections) {
      const counters = [0, 0, 0];
      return safeArray(sections).map((section) => {
        const level = Math.max(1, Math.min(WIKI_SECTION_MAX_LEVEL, Number(section.level) || 1));
        counters[level - 1] += 1;
        for (let i = level;i < counters.length; i += 1)
          counters[i] = 0;
        return counters.slice(0, level).map((value) => Math.max(1, value)).join(".");
      });
    }
    function wikiSectionMarkup(doc, section, docs, number) {
      const locked = section.managed === "user";
      const level = Math.max(1, Math.min(WIKI_SECTION_MAX_LEVEL, Number(section.level) || 1));
      const tag = level === 1 ? "h2" : level === 2 ? "h3" : "h4";
      const heading = displayText(section.heading, section.headingKo);
      const body = displayText(section.body, section.bodyKo);
      const showsKo = koDisplayOn() && String(section.bodyKo || "").trim() && body !== section.body;
      return `<section class="mmc-wiki-section ${locked ? "is-locked" : ""}" data-wiki-level="${level}">
      <${tag} id="${esc(wikiSectionDomId(section))}" class="mmc-wh"><span class="mmc-wh-text"><i class="mmc-wiki-h-num">${esc(number)}.</i>${esc(heading)}</span>${locked ? `<i class="mmc-wiki-manage is-locked" title="사용자 편집 · AI가 바꾸지 않습니다">${SVG.lock}사용자 편집</i>` : ""}<button class="mmc-wh-edit" data-action="wiki-edit" data-id="${esc(doc.id)}" title="${locked ? "사용자 편집 섹션" : "AI 관리 섹션 · 변경 제안 대상"}">[편집]</button></${tag}>
      <div class="mmc-wiki-body">${wikiRenderMarkdown(body, doc, docs) || '<p class="mmc-wiki-muted">내용이 비어 있습니다.</p>'}</div>
      ${showsKo ? `<details class="mmc-wiki-original"><summary>원문 보기</summary><div class="mmc-wiki-body">${wikiRenderMarkdown(section.body, doc, docs)}</div></details>` : ""}
    </section>`;
    }
    function wikiImagesMarkup(doc) {
      const images = safeArray(doc.images).filter((image) => image.url);
      if (!images.length)
        return { lead: "", rest: "" };
      const figure = (image, className) => `<figure class="${className}"><img src="${esc(image.url)}" alt="${esc(image.alt)}" loading="lazy" referrerpolicy="no-referrer">${image.caption ? `<figcaption>${esc(image.caption)}</figcaption>` : ""}</figure>`;
      return {
        lead: figure(images[0], "mmc-wiki-lead-image"),
        rest: images.length > 1 ? `<section class="mmc-wiki-section" data-wiki-level="1"><h2 class="mmc-wh"><span class="mmc-wh-text">이미지</span></h2><div class="mmc-wiki-gallery">${images.slice(1).map((image) => figure(image, "mmc-wiki-figure")).join("")}</div></section>` : ""
      };
    }
    function wikiInfoboxMarkup(doc, docs = wikiState().docs) {
      const related = wikiOutgoingRows(doc, docs).slice(0, 6);
      const rows = [
        ["분류", `${esc(wikiCategoryLabel(doc))}${doc.subcategory ? ` › ${esc(doc.subcategory.split("/").join(" › "))}` : ""}`],
        doc.aliases.length ? ["별칭", esc(doc.aliases.join(", "))] : null,
        doc.keywordsKo.length || doc.keywordsEn.length ? ["키워드", esc([...doc.keywordsKo, ...doc.keywordsEn].join(" · "))] : null,
        doc.keywordGroups.length ? ["조합 조건", doc.keywordGroups.map((group) => esc(group.join(" + "))).join("<br>")] : null,
        related.length ? ["관련", related.map((row) => row.doc ? `<button class="mmc-wiki-link" data-action="wiki-open" data-id="${esc(row.doc.id)}">${esc(row.doc.title)}</button>` : `<button class="mmc-wiki-link is-missing" data-action="wiki-new-from-link" data-title="${esc(row.title)}">${esc(row.title)}</button>`).join(", ")] : null,
        ["최근 수정", esc(sourceDate(doc.updatedAt) || doc.updatedAt)],
        doc.aiUpdatedAt ? ["최근 AI 반영", esc(sourceDate(doc.aiUpdatedAt) || doc.aiUpdatedAt)] : null
      ].filter(Boolean);
      const images = wikiImagesMarkup(doc);
      const toggle = (field, label, on, onText, offText, help) => `<tr class="mmc-wiki-state"><th>${label}</th><td><button class="mmc-wiki-toggle ${on ? "is-on" : ""}" data-action="wiki-toggle" data-field="${field}" data-id="${esc(doc.id)}" title="${help}" aria-pressed="${on ? "true" : "false"}"><span>${on ? onText : offText}</span><i></i></button></td></tr>`;
      return `<aside class="mmc-wiki-infobox">
      <b class="mmc-wiki-infobox-title">${esc(displayText(doc.title, doc.titleKo))}</b>
      ${images.lead}
      <table><tbody>
        ${rows.map(([term, value]) => `<tr><th>${term}</th><td>${value}</td></tr>`).join("")}
        ${toggle("alwaysRemember", "항상 기억", doc.alwaysRemember, "켜짐 · 개요만", "조건부", "개요 한 줄만 항상 주입합니다. 본문 전체는 주입하지 않습니다")}
        ${toggle("aiLocked", "AI 수정 잠금", doc.aiLocked, "잠김", "허용", "켜면 AI가 이 문서 내용을 바꾸지 못합니다")}
        ${toggle("excludeFromContext", "AI 참조 제외", doc.excludeFromContext, "제외", "참조", "켜면 RP 생성 컨텍스트에 쓰지 않습니다")}
      </tbody></table>
    </aside>`;
    }
    function wikiHomeMarkup(wiki) {
      const recent = wiki.docs.slice().sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 8);
      const counts = wikiCategoryCounts(wiki);
      return `<div class="mmc-wiki-main">
      <article class="mmc-wiki-article mmc-wiki-home">
        <h1 class="mmc-wiki-title">이야기 위키 <small>대문</small></h1>
        <p class="mmc-wiki-byline">${esc(chatLabel(state.currentChat))}의 등장인물·장소·사건을 정리한 문서 모음 · 문서 ${wiki.docs.length}개</p>
        <div class="mmc-wiki-lead mmc-wiki-body"><p>이 위키는 약속·기억 앵커·요소 기억을 지우지 않고 그 위에 올리는 <strong>사람이 읽고 고치는 문서</strong>예요. AI 초안은 이미 저장된 기억만 근거로 쓰고, 새 기억이 생기면 문서를 바로 바꾸지 않고 변경 제안으로 알려 줘요.</p></div>
        ${recent.length ? `<section class="mmc-wiki-section" data-wiki-level="1"><h2 class="mmc-wh"><span class="mmc-wh-text">최근 바뀐 문서</span></h2><ul class="mmc-wiki-recent">${recent.map((doc) => `<li><button class="mmc-wiki-link" data-action="wiki-open" data-id="${esc(doc.id)}">${esc(displayText(doc.title, doc.titleKo))}</button><small>${esc(wikiCategoryPath(doc))} · ${esc(relTime(doc.updatedAt))}</small></li>`).join("")}</ul></section>` : ""}
        <section class="mmc-wiki-section" data-wiki-level="1"><h2 class="mmc-wh"><span class="mmc-wh-text">분류</span></h2><div class="mmc-wiki-cats">${Object.entries(WIKI_CATEGORY_LABEL).map(([id, label]) => `<button class="mmc-wiki-cat ${counts[id] ? "" : "is-empty"}" data-action="wiki-filter" data-category="${id}"><b>${label}</b><small>${counts[id] || 0}</small></button>`).join("")}</div></section>
        <div class="mmc-wiki-home-actions"><button class="mmc-btn mmc-primary" data-action="wiki-new">${SVG.plus}<span>새 문서</span></button><button class="mmc-btn" data-action="wiki-draft-open">${SVG.spark}<span>기억으로 AI 초안 만들기</span></button></div>
      </article>
    </div>`;
    }
    function wikiDocPanel(wiki) {
      const doc = wikiCurrentDoc(wiki);
      if (!doc)
        return wikiHomeMarkup(wiki);
      const docs = wiki.docs;
      const proposal = wikiProposalFor(doc.id, wiki);
      const related = proposal ? [] : wikiRelatedMemoryRows(doc);
      const outgoing = wikiOutgoingRows(doc, docs);
      const incoming = wikiIncomingRows(doc, docs);
      const banner = proposal ? `<div class="mmc-wiki-banner"><span class="mmc-alert-icon">${SVG.spark}</span><div><b>변경 제안 ${proposal.changes.length}건이 기다리고 있어요</b><small>새 기억 ${proposal.sourceCount}건 기준 · 아직 문서는 바뀌지 않았어요.${proposal.conflicts.length ? ` 잠금 충돌 ${proposal.conflicts.length}건 포함.` : ""}</small></div><div><button class="mmc-btn mmc-sm mmc-primary" data-action="wiki-proposal-open" data-id="${esc(doc.id)}">변경 사항 보기</button><button class="mmc-btn mmc-sm mmc-ghost" data-action="wiki-proposal-dismiss" data-id="${esc(doc.id)}">무시</button></div></div>` : related.length && !doc.aiLocked ? `<div class="mmc-wiki-banner"><span class="mmc-alert-icon">${SVG.spark}</span><div><b>새 기억 ${related.length}건이 이 문서와 관련돼요</b><small>모델을 불러 섹션 단위 변경 제안을 만들어요. 문서를 바로 바꾸지는 않아요.</small></div><div><button class="mmc-btn mmc-sm mmc-primary" data-action="wiki-propose" data-id="${esc(doc.id)}">${SVG.spark}<span>변경 제안 만들기</span></button><button class="mmc-btn mmc-sm mmc-ghost" data-action="wiki-proposal-dismiss" data-id="${esc(doc.id)}">나중에</button></div></div>` : "";
      const linkRow = (row) => row.doc ? `<button class="mmc-wiki-link" data-action="wiki-open" data-id="${esc(row.doc.id)}">${esc(row.doc.title)}</button>` : `<button class="mmc-wiki-link is-missing" data-action="wiki-new-from-link" data-title="${esc(row.title)}" title="아직 없는 문서 · 눌러서 만들기">${esc(row.title)}</button>`;
      const numbers = wikiSectionNumbers(doc.sections);
      const toc = doc.sections.length > 1 ? `<nav class="mmc-wiki-toc"><b>목차</b><ol>${doc.sections.map((section, index) => `<li data-wiki-level="${Math.max(1, Math.min(WIKI_SECTION_MAX_LEVEL, Number(section.level) || 1))}"><button data-action="wiki-toc" data-target="${esc(wikiSectionDomId(section))}"><i>${esc(numbers[index])}.</i>${esc(displayText(section.heading, section.headingKo))}</button></li>`).join("")}</ol></nav>` : "";
      const sources = doc.sources.length ? `<ol class="mmc-wiki-sources">${doc.sources.map((source, index) => `<li><button class="mmc-wiki-cite" data-action="wiki-source" data-id="${esc(doc.id)}" data-index="${index + 1}">${index + 1}</button><b>${esc(WIKI_SOURCE_KIND_LABEL[source.kind] || source.kind)}</b> ${esc(source.label)}${source.quote ? `<details><summary>근거 원문 보기</summary><pre>${esc(source.quote)}</pre></details>` : ""}</li>`).join("")}</ol>` : '<small class="mmc-wiki-muted">연결된 근거 자료가 없어요. AI 초안으로 만든 문서에는 근거가 자동으로 붙어요.</small>';
      const crumbs = [wikiCategoryLabel(doc), ...doc.subcategory.split("/").filter(Boolean)].map((part) => `<span>${esc(part)}</span>`).join("<i>›</i>");
      const managedUser = doc.sections.filter((section) => section.managed === "user").length;
      const previous = state.wikiHistory.length ? wikiState().docs.find((row) => row.id === state.wikiHistory[state.wikiHistory.length - 1]) : null;
      return `<div class="mmc-wiki-main">
      <div class="mmc-wiki-actionbar">
        <button class="mmc-btn mmc-sm mmc-ghost mmc-wiki-back ${previous ? "has-history" : ""}" data-action="wiki-back">${SVG.back}<span>${previous ? esc(truncate(previous.title || "이전 문서", 14)) : "목록"}</span></button>
        <nav class="mmc-wiki-crumb" aria-label="분류 경로">${crumbs}</nav>
        <div class="mmc-wiki-actions">
          <button data-action="wiki-edit" data-id="${esc(doc.id)}">${SVG.edit}<span>편집</span></button>
          ${proposal ? `<button data-action="wiki-proposal-open" data-id="${esc(doc.id)}">변경 제안<em>${proposal.changes.length}</em></button>` : `<button data-action="wiki-propose" data-id="${esc(doc.id)}" ${doc.aiLocked ? "disabled" : ""} title="${doc.aiLocked ? "AI 수정 잠금 중" : "새 기억으로 변경 제안 만들기"}">${SVG.spark}<span>AI 갱신</span></button>`}
          <details class="mmc-wiki-more"><summary aria-label="더 보기">${SVG.more}</summary><div>
            ${wikiHasKo(doc) ? `<button data-action="wiki-toggle-ko">${koDisplayOn() ? "원문으로 보기" : "한국어 표시로 보기"}</button>` : ""}
            <button data-action="wiki-settings">위키 설정</button>
            <button class="is-danger" data-action="wiki-delete" data-id="${esc(doc.id)}">문서 삭제</button>
          </div></details>
        </div>
      </div>
      <article class="mmc-wiki-article">
        <header class="mmc-wiki-titlebar"><h1 class="mmc-wiki-title">${esc(displayText(doc.title, doc.titleKo))}</h1>${doc.aliases.length ? `<small>다른 이름: ${esc(doc.aliases.join(" · "))}</small>` : ""}</header>
        <p class="mmc-wiki-byline">최근 수정 <b>${esc(sourceDate(doc.updatedAt) || doc.updatedAt)}</b> · 섹션 ${doc.sections.length}개${doc.sections.length ? ` (<b>AI 관리 ${doc.sections.length - managedUser}</b>${managedUser ? ` · ${SVG.lock}사용자 편집 ${managedUser}` : ""})` : ""} · 근거 ${doc.sources.length}건${wikiHasKo(doc) ? ` · <button class="mmc-wiki-link" data-action="wiki-toggle-ko">${koDisplayOn() ? "원문으로 보기" : "한국어 표시로 보기"}</button>` : ""}</p>
        ${banner}
        ${wikiInfoboxMarkup(doc, docs)}
        <div class="mmc-wiki-lead mmc-wiki-body">${doc.summary ? wikiRenderMarkdown(displayText(doc.summary, doc.summaryKo), doc, docs) : '<p class="mmc-wiki-muted">개요가 비어 있어요. 항상 기억을 쓰려면 개요가 필요해요.</p>'}${doc.summaryManaged === "user" ? `<p class="mmc-wiki-summary-lock">${SVG.lock}개요는 사용자 편집으로 잠겨 있어 AI 갱신이 덮어쓰지 않아요.</p>` : ""}</div>
        ${toc}
        ${doc.sections.map((section, index) => wikiSectionMarkup(doc, section, docs, numbers[index])).join("") || '<div class="mmc-empty">본문 섹션이 없어요. 편집에서 섹션을 추가해 주세요.</div>'}
        ${wikiImagesMarkup(doc).rest}
        <section class="mmc-wiki-section mmc-wiki-seealso-sec" data-wiki-level="1">
          <h2 class="mmc-wh"><span class="mmc-wh-text">함께 보기</span></h2>
          <div class="mmc-wiki-seealso">
            <div><span>이 문서가 가리키는 문서</span><div class="mmc-wiki-linkrow">${outgoing.length ? outgoing.map(linkRow).join("") : '<small class="mmc-wiki-muted">없음</small>'}</div></div>
            <div><span>이 문서를 가리키는 문서</span><div class="mmc-wiki-linkrow">${incoming.length ? incoming.map((row) => linkRow({ title: row.title, doc: row })).join("") : '<small class="mmc-wiki-muted">없음</small>'}</div></div>
          </div>
        </section>
        <section class="mmc-wiki-section mmc-wiki-refs" data-wiki-level="1"><h2 class="mmc-wh"><span class="mmc-wh-text">근거</span></h2>${sources}</section>
        <footer class="mmc-wiki-doc-foot">
          <small>최근 수정 ${esc(sourceDate(doc.updatedAt) || doc.updatedAt)}${doc.aiUpdatedAt ? ` · 최근 AI 반영 ${esc(sourceDate(doc.aiUpdatedAt) || doc.aiUpdatedAt)}` : ""} · 검색 조건 ${wikiTriggerConditions(doc).length}개</small>
        </footer>
      </article>
    </div>`;
    }
    function wikiMainView() {
      const wiki = wikiState();
      if (state.wikiSelectedId && !wiki.docs.some((doc) => doc.id === state.wikiSelectedId))
        state.wikiSelectedId = "";
      return `<section class="mmc-wiki-document">
      <div class="mmc-wiki-split" data-wiki-pane="${state.wikiSelectedId ? "doc" : "list"}">${wikiSidePanel(wiki)}${wikiDocPanel(wiki)}</div>
    </section>`;
    }
    function wikiCategorySelectOptions(selected) {
      return Object.entries(WIKI_CATEGORY_LABEL).map(([id, label]) => `<option value="${id}" ${selected === id ? "selected" : ""}>${label}</option>`).join("");
    }
    function wikiConnectionOptions(wiki = wikiState()) {
      const selected = String(wiki.connectionId || "");
      const rows = state.connections.map((row) => `<option value="${esc(row.id)}" ${row.id === selected ? "selected" : ""}>${esc(row.label)}${row.model ? ` · ${esc(row.model)}` : ""}</option>`).join("");
      return `<option value="">기본 후보 모델 사용</option>${rows}`;
    }
    function captureWikiDraft() {
      if (!state.wikiDraft)
        return;
      const lines = (id, max) => String(document.getElementById(id)?.value || "").split(/\n/).map((row) => row.trim()).filter(Boolean).slice(0, max);
      const draft = state.wikiDraft;
      draft.title = String(document.getElementById("mmc-wiki-title")?.value ?? draft.title).trim().slice(0, 120);
      draft.category = String(document.getElementById("mmc-wiki-category")?.value || draft.category || "misc");
      draft.subcategory = String(document.getElementById("mmc-wiki-subcategory")?.value ?? draft.subcategory).trim().slice(0, 80);
      draft.summary = String(document.getElementById("mmc-wiki-summary")?.value ?? draft.summary).trim();
      draft.summaryManaged = String(document.getElementById("mmc-wiki-summary-mode")?.value || draft.summaryManaged || "ai") === "user" ? "user" : "ai";
      draft.aliases = normalizeTextList(lines("mmc-wiki-aliases", 12), 12, 80);
      draft.keywordsKo = normalizeTextList(lines("mmc-wiki-ko", 16), 16, 80);
      draft.keywordsEn = normalizeTextList(lines("mmc-wiki-en", 16), 16, 80);
      draft.keywordGroups = normalizeTriggerGroups(lines("mmc-wiki-groups", 8).map((line) => line.split(/[,＋+]/)));
      draft.relatedTitles = lines("mmc-wiki-related", 24);
      draft.sections = safeArray(draft.sections).map((section, index) => ({
        ...section,
        heading: String(document.getElementById(`mmc-wiki-sec-head-${index}`)?.value ?? section.heading).trim().slice(0, 120),
        body: String(document.getElementById(`mmc-wiki-sec-body-${index}`)?.value ?? section.body),
        level: Math.max(1, Math.min(WIKI_SECTION_MAX_LEVEL, Number(document.getElementById(`mmc-wiki-sec-level-${index}`)?.value) || section.level || 1)),
        managed: String(document.getElementById(`mmc-wiki-sec-mode-${index}`)?.value || section.managed) === "user" ? "user" : "ai"
      }));
      draft.images = safeArray(draft.images).map((image, index) => ({
        ...image,
        url: String(document.getElementById(`mmc-wiki-img-url-${index}`)?.value ?? image.url).trim(),
        alt: String(document.getElementById(`mmc-wiki-img-alt-${index}`)?.value ?? image.alt).trim(),
        caption: String(document.getElementById(`mmc-wiki-img-cap-${index}`)?.value ?? image.caption).trim(),
        lead: index === 0
      })).filter((image) => image.url);
    }
    function wikiLengthNoteMarkup(id, length, max) {
      const over = length > max;
      return `<small class="mmc-wiki-count ${over ? "is-over" : ""}" data-wiki-count="${esc(id)}" data-wiki-count-max="${max}">${length.toLocaleString()} / ${max.toLocaleString()}자${over ? ` · ${(length - max).toLocaleString()}자 초과` : ""}</small>`;
    }
    function wikiEditorSectionMarkup(section, index) {
      const levelOptions = Array.from({ length: WIKI_SECTION_MAX_LEVEL }, (unused, i) => i + 1).map((level) => `<option value="${level}" ${Number(section.level || 1) === level ? "selected" : ""}>${"—".repeat(level - 1)}${level}단계</option>`).join("");
      return `<section class="mmc-wiki-edit-section" data-wiki-level="${Number(section.level || 1)}">
      <div class="mmc-wiki-edit-section-head">
        <input id="mmc-wiki-sec-head-${index}" value="${esc(section.heading)}" maxlength="120" placeholder="섹션 제목">
        <select id="mmc-wiki-sec-level-${index}" title="하위 섹션 깊이">${levelOptions}</select>
        <select id="mmc-wiki-sec-mode-${index}" title="AI 갱신 허용 여부"><option value="ai" ${section.managed !== "user" ? "selected" : ""}>AI 관리</option><option value="user" ${section.managed === "user" ? "selected" : ""}>\uD83D\uDD12 사용자 편집</option></select>
        <button class="mmc-btn mmc-danger" data-action="wiki-remove-section" data-index="${index}" title="이 섹션 삭제">삭제</button>
      </div>
      <textarea id="mmc-wiki-sec-body-${index}" rows="7" data-wiki-count-for="mmc-wiki-sec-body-${index}" placeholder="Markdown 본문. [다른 문서 제목]으로 연결하고 [1]로 근거를 가리킵니다.">${esc(section.body)}</textarea>
      ${wikiLengthNoteMarkup(`mmc-wiki-sec-body-${index}`, section.body.length, WIKI_SECTION_BODY_MAX)}
      ${section.bodyKo ? `<details class="mmc-source-quote"><summary>한국어 표시본 (AI 생성) 보기</summary><p>${esc(section.bodyKo)}</p></details>` : ""}
    </section>`;
    }
    function wikiImageEditorMarkup(image, index) {
      return `<section class="mmc-wiki-edit-section">
      <div class="mmc-wiki-edit-image-head"><b>${index === 0 ? "대표 이미지" : `이미지 ${index + 1}`}</b><button class="mmc-btn mmc-danger" data-action="wiki-remove-image" data-index="${index}">삭제</button></div>
      <input id="mmc-wiki-img-url-${index}" value="${esc(image.url)}" maxlength="1000" placeholder="https://… 또는 /로 시작하는 루미버스 경로">
      <input id="mmc-wiki-img-alt-${index}" value="${esc(image.alt)}" maxlength="200" placeholder="alt · 화면 낭독기와 이미지 로드 실패 시 표시">
      <input id="mmc-wiki-img-cap-${index}" value="${esc(image.caption)}" maxlength="300" placeholder="캡션 · 이미지 아래 설명">
    </section>`;
    }
    function wikiEditorLayer() {
      const wiki = wikiState();
      const draft = state.wikiDraft || normalizeWikiDoc({ id: "" });
      const relatedTitles = safeArray(draft.relatedTitles).length ? draft.relatedTitles : safeArray(draft.relatedDocIds).map((id) => wiki.docs.find((doc) => doc.id === id)?.title).filter(Boolean);
      return `<div class="mmc-layer-backdrop" data-action="close-layer"><section class="mmc-layer mmc-wiki-editor" data-layer-stop>
      <header><div><span class="mmc-kicker">STORY WIKI</span><h3>${draft.id ? "위키 문서 편집" : "새 위키 문서"}</h3></div><button class="mmc-icon-btn" data-action="close-layer">${SVG.close}</button></header>
      <div class="mmc-layer-body">
        <label class="mmc-field"><span>제목</span><input id="mmc-wiki-title" value="${esc(draft.title)}" maxlength="120" placeholder="예: 이준 / 지희의 사물함"></label>
        <div class="mmc-field-row">
          <label class="mmc-field"><span>분류</span><select id="mmc-wiki-category">${wikiCategorySelectOptions(draft.category)}</select></label>
          <label class="mmc-field"><span>하위 분류 <small>· / 로 깊이 구분</small></span><input id="mmc-wiki-subcategory" value="${esc(draft.subcategory)}" maxlength="80" placeholder="예: 주요 인물/학교"></label>
        </div>
        <div class="mmc-field-row mmc-wiki-summary-row">
          <label class="mmc-field"><span>한눈에 보는 개요 <small>항상 기억을 켜면 이 한 줄만 상시 주입됩니다</small></span><textarea id="mmc-wiki-summary" rows="3" data-wiki-count-for="mmc-wiki-summary">${esc(draft.summary)}</textarea>${wikiLengthNoteMarkup("mmc-wiki-summary", draft.summary.length, WIKI_SUMMARY_MAX)}</label>
          <label class="mmc-field"><span>개요 관리 <small>사용자 편집이면 AI 갱신에서 보호됩니다</small></span><select id="mmc-wiki-summary-mode"><option value="ai" ${draft.summaryManaged !== "user" ? "selected" : ""}>AI 관리</option><option value="user" ${draft.summaryManaged === "user" ? "selected" : ""}>\uD83D\uDD12 사용자 편집</option></select></label>
        </div>
        ${draft.summaryKo ? `<details class="mmc-source-quote"><summary>개요 한국어 표시본 보기</summary><p>${esc(draft.summaryKo)}</p></details>` : ""}
        <section class="mmc-trigger-box">
          <div><b>검색과 한영 대응</b><small>별칭은 같은 대상의 다른 이름이고 자동 검색어가 아닙니다. 키워드만 실제 호출 조건으로 쓰입니다.</small></div>
          <label class="mmc-field"><span>별칭 <small>한 줄에 하나</small></span><textarea id="mmc-wiki-aliases" rows="2">${esc(draft.aliases.join(`
`))}</textarea></label>
          <div class="mmc-field-row">
            <label class="mmc-field"><span>한국어 키워드 <small>하나만 나와도 호출</small></span><textarea id="mmc-wiki-ko" rows="3">${esc(draft.keywordsKo.join(`
`))}</textarea></label>
            <label class="mmc-field"><span>영어 키워드 <small>영출에서도 찾히게</small></span><textarea id="mmc-wiki-en" rows="3">${esc(draft.keywordsEn.join(`
`))}</textarea></label>
          </div>
          <label class="mmc-field"><span>조합 호출조건 <small>한 줄 안의 단어가 모두 나와야 호출 · 쉼표로 구분</small></span><textarea id="mmc-wiki-groups" rows="2" placeholder="지희, 사물함">${esc(draft.keywordGroups.map((group) => group.join(", ")).join(`
`))}</textarea></label>
        </section>
        <div class="mmc-wiki-edit-sections-head"><b>본문 섹션 <small>직접 추가한 섹션은 사용자 편집으로 시작합니다</small></b><button class="mmc-btn" data-action="wiki-add-section">섹션 추가</button></div>
        ${safeArray(draft.sections).map(wikiEditorSectionMarkup).join("") || '<div class="mmc-empty">섹션이 없습니다. 섹션을 추가해 주세요.</div>'}
        <div class="mmc-wiki-edit-sections-head"><b>이미지 <small>URL만 저장합니다 · 이미지 자체는 모델에 주입하지 않습니다</small></b><button class="mmc-btn" data-action="wiki-add-image">이미지 추가</button></div>
        ${safeArray(draft.images).map(wikiImageEditorMarkup).join("") || '<div class="mmc-empty">연결된 이미지가 없습니다.</div>'}
        <label class="mmc-field"><span>관련 문서 <small>제목 한 줄에 하나 · 본문의 [문서명] 링크와 함께 표시됩니다</small></span><textarea id="mmc-wiki-related" rows="3">${esc(relatedTitles.join(`
`))}</textarea></label>
        ${draft.sources.length ? `<section class="mmc-setting-block"><div class="mmc-setting-block-head"><span><b>근거 자료</b><small>본문의 [1] [2] 번호와 순서가 같습니다.</small></span></div><ol class="mmc-wiki-sources">${draft.sources.map((source, index) => `<li><b>${esc(WIKI_SOURCE_KIND_LABEL[source.kind] || source.kind)}</b> ${esc(source.label)} <button class="mmc-btn mmc-danger" data-action="wiki-remove-source" data-index="${index}">제거</button></li>`).join("")}</ol></section>` : ""}
      </div>
      <footer>${draft.id ? `<button class="mmc-btn mmc-danger" data-action="wiki-delete" data-id="${esc(draft.id)}">${SVG.trash}<span>삭제</span></button>` : "<span></span>"}<div><button class="mmc-btn" data-action="close-layer">취소</button><button class="mmc-btn mmc-primary" data-action="wiki-save">저장</button></div></footer>
    </section></div>`;
    }
    function wikiDraftLayer() {
      const wiki = wikiState();
      const groups = Object.entries(WIKI_SOURCE_KIND_LABEL).filter(([id]) => id !== "manual");
      const rowsByKind = new Map(groups.map(([id]) => [id, []]));
      for (const row of state.wikiSourceRows)
        if (rowsByKind.has(row.kind))
          rowsByKind.get(row.kind).push(row);
      const body = groups.map(([id, label]) => {
        const rows = rowsByKind.get(id) || [];
        if (!rows.length)
          return "";
        return `<section class="mmc-wiki-source-group"><div class="mmc-wiki-source-group-head"><b>${label} <small>${rows.length}</small></b><button class="mmc-btn" data-action="wiki-source-group" data-kind="${id}">이 묶음 선택/해제</button></div>${rows.map((row) => `<label class="mmc-source-row ${state.wikiSourceSelected.has(String(row.id)) ? "is-selected" : ""}"><input type="checkbox" data-wiki-source-id="${esc(row.id)}" ${state.wikiSourceSelected.has(String(row.id)) ? "checked" : ""}><span class="mmc-source-copy"><b>${esc(truncate(row.label, 60))}</b><p>${esc(truncate(row.text, 220))}</p></span></label>`).join("")}</section>`;
      }).filter(Boolean).join("");
      const selectedText = wikiSelectedSourceRows().map((row) => row.text).join(`
`);
      return `<div class="mmc-layer-backdrop" data-action="close-layer"><section class="mmc-layer mmc-wiki-draft-layer" data-layer-stop>
      <header><div><span class="mmc-kicker">WIKI DRAFT</span><h3>기존 기억으로 위키 초안 만들기</h3><small>새 기억을 만들지 않습니다. 고른 기억을 문서로 조직하고 [n] 근거를 연결합니다.</small></div><button class="mmc-icon-btn" data-action="close-layer">${SVG.close}</button></header>
      <div class="mmc-layer-body">
        <label class="mmc-field"><span>주제 <small>선택 · 비워 두면 모델이 알아서 나눕니다</small></span><input id="mmc-wiki-draft-topic" value="${esc(state.wikiDraftTopic)}" maxlength="120" placeholder="예: 이준이라는 인물 / 학교 건물"></label>
        ${hiddenSkipNote("wiki") ? `<div class="mmc-candidate-note">${esc(hiddenSkipNote("wiki"))} 일부 인물만 아는 기억과 요약의 인물별 구간도 위키 근거에서 뺐어요.</div>` : ""}
        <div class="mmc-source-toolbar"><button class="mmc-btn" data-action="wiki-source-all">전체 선택</button><button class="mmc-btn" data-action="wiki-source-none">해제</button><span>${state.wikiSourceSelected.size}개 선택 · 약 ${estimateTokens(selectedText)} tokens</span></div>
        <div class="mmc-source-list">${body || '<div class="mmc-empty">초안의 근거로 쓸 기억이 없습니다. 먼저 약속·앵커·요소 기억을 만들어 주세요.</div>'}</div>
        <section class="mmc-model-strip"><div><b>위키 초안 모델</b><small>고른 기억만 근거로 씁니다. 결과는 미리보기이며 선택 저장 전에는 보관되지 않습니다.</small></div><select id="mmc-wiki-draft-model">${wikiConnectionOptions(wiki)}</select></section>
      </div>
      <footer><span></span><div><button class="mmc-btn" data-action="close-layer">취소</button><button class="mmc-btn mmc-model-btn" data-action="wiki-draft-run" ${state.wikiSourceSelected.size ? "" : "disabled"}>${SVG.spark}<span>초안 만들기</span></button></div></footer>
    </section></div>`;
    }
    function wikiCandidateRowMarkup(item, index) {
      const checked = state.wikiCandidateSelected.has(String(index));
      return `<article class="mmc-wiki-candidate ${checked ? "is-selected" : ""}">
      <div class="mmc-wiki-candidate-head"><label><input type="checkbox" data-wiki-candidate-index="${index}" ${checked ? "checked" : ""}><span class="mmc-type-chip">신규</span></label><b>${esc(item.title)}</b><small>섹션 ${item.sections.length} · 근거 ${item.sources.length}</small></div>
      <div class="mmc-field-row">
        <label class="mmc-field"><span>제목</span><input id="mmc-wc-title-${index}" value="${esc(item.title)}" maxlength="120"></label>
        <label class="mmc-field"><span>분류</span><select id="mmc-wc-category-${index}">${wikiCategorySelectOptions(item.category)}</select></label>
      </div>
      <label class="mmc-field"><span>하위 분류</span><input id="mmc-wc-subcategory-${index}" value="${esc(item.subcategory)}" maxlength="80"></label>
      <label class="mmc-field"><span>개요</span><textarea id="mmc-wc-summary-${index}" rows="2">${esc(item.summary)}</textarea></label>
      <div class="mmc-field-row">
        <label class="mmc-field"><span>별칭</span><textarea id="mmc-wc-aliases-${index}" rows="2">${esc(item.aliases.join(`
`))}</textarea></label>
        <label class="mmc-field"><span>한국어 키워드</span><textarea id="mmc-wc-ko-${index}" rows="2">${esc(item.keywordsKo.join(`
`))}</textarea></label>
      </div>
      <label class="mmc-field"><span>영어 키워드</span><textarea id="mmc-wc-en-${index}" rows="2">${esc(item.keywordsEn.join(`
`))}</textarea></label>
      <details class="mmc-source-quote"><summary>본문 미리보기 · 저장 후 자유롭게 편집할 수 있습니다</summary><div class="mmc-wiki-body">${item.sections.map((section) => `<h5>${esc(section.heading)}</h5>${wikiRenderMarkdown(section.body, item, [])}`).join("")}</div></details>
    </article>`;
    }
    function wikiCandidateLayer() {
      return `<div class="mmc-layer-backdrop" data-action="close-layer"><section class="mmc-layer mmc-wiki-candidates-layer" data-layer-stop>
      <header><div><span class="mmc-kicker">WIKI REVIEW</span><h3>위키 초안 결과</h3><small>후보 ${state.wikiCandidates.length}개 · 선택한 문서만 저장됩니다</small></div><button class="mmc-icon-btn" data-action="close-layer">${SVG.close}</button></header>
      <div class="mmc-layer-body">
        <div class="mmc-candidate-toolbar"><b>${state.wikiCandidateSelected.size}/${state.wikiCandidates.length} 선택</b><div><button class="mmc-btn" data-action="wiki-candidate-all">전체 선택</button><button class="mmc-btn" data-action="wiki-candidate-none">전체 해제</button></div></div>
        ${state.wikiCandidates.length ? state.wikiCandidates.map(wikiCandidateRowMarkup).join("") : '<div class="mmc-empty">저장할 만한 문서 후보가 없습니다.</div>'}
      </div>
      <footer><span></span><div><button class="mmc-btn" data-action="close-layer">취소</button><button class="mmc-btn mmc-primary" data-action="wiki-candidate-save" ${state.wikiCandidateSelected.size ? "" : "disabled"}>선택 ${state.wikiCandidateSelected.size}개 저장</button></div></footer>
    </section></div>`;
    }
    function wikiDiffMarkup(before, after) {
      const beforeLines = String(before || "").split(`
`);
      const afterLines = String(after || "").split(`
`);
      const beforeSet = new Set(beforeLines.map((line) => line.trim()));
      const afterSet = new Set(afterLines.map((line) => line.trim()));
      const removed = beforeLines.filter((line) => line.trim() && !afterSet.has(line.trim()));
      const added = afterLines.filter((line) => line.trim() && !beforeSet.has(line.trim()));
      return `<div class="mmc-wiki-diff">
      ${removed.length ? `<div class="mmc-wiki-diff-side is-before"><b>이전</b>${removed.map((line) => `<p>${esc(line)}</p>`).join("")}</div>` : ""}
      ${added.length ? `<div class="mmc-wiki-diff-side is-after"><b>제안</b>${added.map((line) => `<p>${esc(line)}</p>`).join("")}</div>` : ""}
      ${!removed.length && !added.length ? '<small class="mmc-wiki-muted">줄 단위 차이가 없습니다.</small>' : ""}
    </div>`;
    }
    function wikiProposalLayer() {
      const wiki = wikiState();
      const proposal = wikiProposalFor(state.wikiProposalDocId, wiki);
      if (!proposal)
        return "";
      const doc = wiki.docs.find((row) => row.id === proposal.docId);
      const stale = doc && proposal.baseUpdatedAt && doc.updatedAt !== proposal.baseUpdatedAt;
      return `<div class="mmc-layer-backdrop" data-action="close-layer"><section class="mmc-layer mmc-wiki-proposal-layer" data-layer-stop>
      <header><div><span class="mmc-kicker">WIKI UPDATE</span><h3>${esc(proposal.docTitle || doc?.title || "변경 제안")}</h3><small>새 기억 ${proposal.sourceCount}건 기준 · 변경 ${proposal.changes.length}건</small></div><button class="mmc-icon-btn" data-action="close-layer">${SVG.close}</button></header>
      <div class="mmc-layer-body">
        <div class="mmc-candidate-note">반영을 누르기 전까지 문서는 바뀌지 않습니다. 사용자 편집 잠금 섹션은 반영 대상에서 제외됩니다.</div>
        ${stale ? '<div class="mmc-candidate-note mmc-warning-note">제안을 만든 뒤 문서를 직접 수정했습니다. 그 사이 바뀐 섹션은 덮어쓰지 않고 건너뜁니다.</div>' : ""}
        ${proposal.conflicts.length ? `<div class="mmc-setting-warning"><b>잠금 충돌 ${proposal.conflicts.length}건</b><small>${proposal.conflicts.map((row) => esc(row)).join("<br>")}</small></div>` : ""}
        <div class="mmc-candidate-toolbar"><b>${state.wikiProposalSelected.size}/${proposal.changes.length} 선택</b><div><button class="mmc-btn" data-action="wiki-proposal-all">전체 선택</button><button class="mmc-btn" data-action="wiki-proposal-none">전체 해제</button></div></div>
        ${proposal.changes.map((change, index) => `<article class="mmc-wiki-change ${state.wikiProposalSelected.has(String(index)) ? "is-selected" : ""}">
          <label class="mmc-wiki-change-head"><input type="checkbox" data-wiki-proposal-index="${index}" ${state.wikiProposalSelected.has(String(index)) ? "checked" : ""}><span class="mmc-type-chip">${change.kind === "summary" ? "개요" : change.kind === "add" ? "새 섹션" : "수정"}</span><b>${esc(change.heading)}</b></label>
          ${change.reason ? `<small class="mmc-wiki-muted">${esc(change.reason)}</small>` : ""}
          ${wikiDiffMarkup(change.before, change.after)}
        </article>`).join("") || '<div class="mmc-empty">적용할 변경사항이 없습니다.</div>'}
      </div>
      <footer><button class="mmc-btn" data-action="wiki-proposal-dismiss" data-id="${esc(proposal.docId)}">무시</button><div><button class="mmc-btn" data-action="close-layer">나중에</button><button class="mmc-btn mmc-primary" data-action="wiki-proposal-apply" ${state.wikiProposalSelected.size ? "" : "disabled"}>선택 ${state.wikiProposalSelected.size}건 반영</button></div></footer>
    </section></div>`;
    }
    function wikiSettingsLayer() {
      const wiki = wikiState();
      const theme = UI_THEMES.find((row) => row.id === state.uiThemeMode) || UI_THEMES[0];
      return `<div class="mmc-layer-backdrop" data-action="close-layer"><section class="mmc-layer mmc-settings-layer mmc-sheet" data-layer-stop>
      <header><div class="mmc-sheet-title"><span class="mmc-sheet-icon">${SVG.wiki}</span><h3>이야기 위키 설정</h3></div><button class="mmc-icon-btn" data-action="close-layer" aria-label="닫기">${SVG.close}</button></header>
      <div class="mmc-layer-body">
        <section class="mmc-set-card">
          <div class="mmc-set-head"><b>모양</b><small>위키는 보관함 테마를 그대로 써요. 테마를 바꾸면 보관함 전체가 함께 바뀌어요.</small></div>
          <div class="mmc-wiki-theme-link"><span class="mmc-swatch" data-tp="${theme.id}"></span><span><b>${esc(theme.label)}</b><small>보관함 전체 · 위키 링크·인포박스·목차 색 포함</small></span><button class="mmc-btn mmc-sm" data-action="open-theme-settings">바꾸기</button></div>
        </section>
        <section class="mmc-set-card">
          <div class="mmc-set-head"><b>RP에 쓰기</b></div>
          <label class="mmc-check-line"><input id="mmc-wiki-injection-enabled" type="checkbox" ${wiki.injectionEnabled ? "checked" : ""}><span><b>위키 문서를 전용 로어북으로 RP에 사용하기</b><small>키워드가 맞는 문서만 불러와요.</small></span></label>
          <label class="mmc-setting"><span><b>항상 기억 개요 예산</b><small>항상 기억으로 표시한 문서의 개요만 이 글자 수까지 상시 주입해요. 본문은 상시 주입하지 않아요. 300~6000자.</small></span><input id="mmc-wiki-always-budget" type="number" min="300" max="6000" step="100" value="${wiki.alwaysBudgetChars}"></label>
          <label class="mmc-setting mmc-setting-model"><span><b>위키 모델</b><small>비워 두면 보관함 기본 후보 모델을 써요.</small></span><select id="mmc-wiki-model">${wikiConnectionOptions(wiki)}</select></label>
          <div class="mmc-setting-warning"><b>세 가지 상태는 따로 동작해요</b><small><strong>AI 수정 잠금</strong>은 내용 변경만 막고 참조는 허용해요. <strong>AI 참조 제외</strong>는 RP 컨텍스트에서만 빼요. <strong>항상 기억</strong>은 개요 한 줄만 상시 주입해요.</small></div>
        </section>
        <section class="mmc-setting-block"><div class="mmc-setting-block-head"><span><b>초안 작성 지침</b><small>무엇을 어떤 문체로 문서화할지 정해요. JSON 출력 규칙은 확장이 따로 고정해요.</small></span><button class="mmc-btn mmc-sm" data-action="reset-wiki-draft-prompt">기본값 복원</button></div><textarea id="mmc-wiki-draft-prompt" rows="9">${esc(wiki.draftPrompt || DEFAULT_WIKI_DRAFT_PROMPT)}</textarea></section>
        <section class="mmc-setting-block"><div class="mmc-setting-block-head"><span><b>변경 제안 지침</b><small>새 기억이 생겼을 때 어디까지 고칠지 정해요. 잠금 섹션 보호는 확장이 강제해요.</small></span><button class="mmc-btn mmc-sm" data-action="reset-wiki-update-prompt">기본값 복원</button></div><textarea id="mmc-wiki-update-prompt" rows="8">${esc(wiki.updatePrompt || DEFAULT_WIKI_UPDATE_PROMPT)}</textarea></section>
        <section class="mmc-setting-block"><div class="mmc-setting-block-head"><span><b>위키 주입 지침</b><small>검색된 위키 문서를 모델이 어떻게 다룰지 정해요.</small></span><button class="mmc-btn mmc-sm" data-action="reset-wiki-injection-prompt">기본값 복원</button></div><textarea id="mmc-wiki-injection-prompt" rows="7">${esc(wiki.injectionPrompt || DEFAULT_WIKI_INJECTION_PROMPT)}</textarea></section>
      </div>
      <footer><span></span><div><button class="mmc-btn" data-action="close-layer">취소</button><button class="mmc-btn mmc-primary" data-action="wiki-save-settings">저장</button></div></footer>
    </section></div>`;
    }
    function wikiEditableDraft(doc) {
      const copy = normalizeWikiDoc(JSON.parse(JSON.stringify(doc || {})));
      copy.relatedTitles = [];
      return copy;
    }
    async function saveWikiDoc() {
      captureWikiDraft();
      const draft = state.wikiDraft;
      if (!draft)
        throw new Error("편집 중인 문서가 없습니다.");
      if (!String(draft.title || "").trim())
        throw new Error("문서 제목을 입력해 주세요.");
      const overflow = [];
      const summaryLength = String(draft.summary || "").length;
      if (summaryLength > WIKI_SUMMARY_MAX)
        overflow.push(`한눈에 보는 개요: ${summaryLength.toLocaleString()}자 (상한 ${WIKI_SUMMARY_MAX.toLocaleString()}자)`);
      safeArray(draft.sections).forEach((section, index) => {
        const length = String(section.body || "").length;
        if (length > WIKI_SECTION_BODY_MAX)
          overflow.push(`${index + 1}. ${section.heading || "본문"}: ${length.toLocaleString()}자 (상한 ${WIKI_SECTION_BODY_MAX.toLocaleString()}자)`);
      });
      if (overflow.length) {
        throw new Error(`길이 상한을 넘은 곳이 ${overflow.length}군데 있어 저장하지 않았습니다. 입력한 내용은 그대로 남아 있습니다.
${overflow.join(" / ")}`);
      }
      const sections = safeArray(draft.sections).map(normalizeWikiSection).filter(Boolean);
      if (!sections.length && !String(draft.summary || "").trim())
        throw new Error("개요나 본문 섹션을 하나 이상 입력해 주세요.");
      const data = await freshOwnedData();
      const wiki = normalizeWiki(data.wiki);
      const now = nowIso();
      const relatedDocIds = normalizeTextList(safeArray(draft.relatedTitles).map((title) => wikiFindByTitle(wiki.docs, title)?.id).filter(Boolean).filter((id) => id !== draft.id), 24, 80);
      let autoLocked = 0;
      if (draft.id) {
        const index = wiki.docs.findIndex((row) => row.id === draft.id);
        if (index < 0)
          throw new Error("수정할 문서를 찾지 못했습니다. 이미 삭제된 것 같습니다.");
        const previous = wiki.docs[index];
        const duplicate = wiki.docs.find((row) => row.id !== draft.id && wikiKey(row.title) === wikiKey(draft.title));
        if (duplicate)
          throw new Error("같은 제목의 문서가 이미 있습니다.");
        const previousById = new Map(previous.sections.map((row) => [row.id, row]));
        for (const section of sections) {
          const before = previousById.get(section.id);
          if (!before) {
            if (section.managed !== "user") {
              section.managed = "user";
              autoLocked += 1;
            }
            continue;
          }
          const modeChangedByUser = section.managed !== before.managed;
          if (modeChangedByUser)
            continue;
          if (before.managed !== "ai")
            continue;
          if (section.heading === before.heading && section.body === before.body)
            continue;
          section.managed = "user";
          section.updatedAt = now;
          autoLocked += 1;
        }
        let summaryManaged = draft.summaryManaged === "user" ? "user" : "ai";
        const summaryModeChangedByUser = summaryManaged !== previous.summaryManaged;
        if (!summaryModeChangedByUser && previous.summaryManaged === "ai" && String(draft.summary || "").trim() !== previous.summary) {
          summaryManaged = "user";
          autoLocked += 1;
        }
        wiki.docs[index] = normalizeWikiDoc({
          ...previous,
          ...draft,
          sections,
          relatedDocIds,
          summaryManaged,
          id: previous.id,
          createdAt: previous.createdAt,
          sources: previous.sources,
          aiUpdatedAt: previous.aiUpdatedAt,
          updatedAt: now
        });
        state.wikiSelectedId = previous.id;
      } else {
        if (wiki.docs.length >= WIKI_DOC_LIMIT)
          throw new Error(`위키 문서는 최대 ${WIKI_DOC_LIMIT}개까지 보관할 수 있습니다.`);
        if (wikiFindByTitle(wiki.docs, draft.title))
          throw new Error("같은 제목이나 별칭의 문서가 이미 있습니다.");
        const created = normalizeWikiDoc({ ...draft, id: uid("wdoc"), sections, relatedDocIds, sources: [], createdAt: now, updatedAt: now, aiUpdatedAt: "" });
        wiki.docs.push(created);
        state.wikiSelectedId = created.id;
      }
      wiki.originChatId = String(state.selectedChatId || "");
      data.wiki = wiki;
      await persistData(data, { silent: autoLocked > 0 });
      if (autoLocked)
        toast(`직접 고친 ${autoLocked}곳을 사용자 편집으로 잠갔습니다. AI 갱신이 덮어쓰지 않습니다.`);
      state.layer = null;
      state.wikiDraft = null;
      render();
    }
    async function toggleWikiFlag(docId, field) {
      if (!["aiLocked", "excludeFromContext", "alwaysRemember"].includes(field))
        return;
      const data = await freshOwnedData();
      const wiki = normalizeWiki(data.wiki);
      const doc = wiki.docs.find((row) => row.id === String(docId));
      if (!doc)
        throw new Error("문서를 찾지 못했습니다.");
      if (field === "alwaysRemember" && !doc.alwaysRemember && !doc.summary.trim())
        throw new Error("항상 기억을 켜려면 한눈에 보는 개요를 먼저 채워 주세요.");
      doc[field] = !doc[field];
      doc.updatedAt = nowIso();
      data.wiki = wiki;
      await persistData(data, { silent: true });
      toast(field === "aiLocked" ? doc.aiLocked ? "AI 수정 잠금을 켰습니다." : "AI 수정 잠금을 껐습니다." : field === "excludeFromContext" ? doc.excludeFromContext ? "이 문서를 RP 참조에서 제외했습니다." : "이 문서를 다시 RP 참조에 사용합니다." : doc.alwaysRemember ? "개요를 항상 기억으로 올렸습니다. 본문은 상시 주입하지 않습니다." : "항상 기억을 껐습니다.");
      render();
    }
    async function deleteWikiDoc(docId) {
      const data = await freshOwnedData();
      const wiki = normalizeWiki(data.wiki);
      const before = wiki.docs.length;
      wiki.docs = wiki.docs.filter((row) => row.id !== String(docId));
      if (wiki.docs.length === before)
        throw new Error("삭제할 문서를 찾지 못했습니다.");
      wiki.proposals = wiki.proposals.filter((row) => row.docId !== String(docId));
      for (const doc of wiki.docs)
        doc.relatedDocIds = doc.relatedDocIds.filter((id) => id !== String(docId));
      data.wiki = wiki;
      await persistData(data);
      if (state.wikiSelectedId === String(docId))
        state.wikiSelectedId = "";
      state.layer = null;
      state.wikiDraft = null;
      render();
    }
    async function openWikiDraftLayer() {
      setBusy(true, "기존 기억을 불러오는 중…");
      try {
        state.wikiSourceRows = await collectWikiSourceRows();
        state.wikiSourceSelected = new Set(state.wikiSourceRows.filter((row) => ["element", "anchor", "promise"].includes(row.kind)).slice(0, 40).map((row) => String(row.id)));
        state.layer = "wiki-draft";
      } finally {
        state.busy = false;
        if (state.busyTimer)
          clearInterval(state.busyTimer);
        state.busyTimer = null;
        render();
      }
    }
    async function saveWikiSettings() {
      const data = await freshOwnedData();
      const wiki = normalizeWiki(data.wiki);
      wiki.connectionId = String(document.getElementById("mmc-wiki-model")?.value || "");
      wiki.injectionEnabled = !!document.getElementById("mmc-wiki-injection-enabled")?.checked;
      wiki.alwaysBudgetChars = Math.max(300, Math.min(6000, Number(document.getElementById("mmc-wiki-always-budget")?.value) || wiki.alwaysBudgetChars));
      wiki.draftPrompt = String(document.getElementById("mmc-wiki-draft-prompt")?.value || "").trim().slice(0, 8000);
      wiki.updatePrompt = String(document.getElementById("mmc-wiki-update-prompt")?.value || "").trim().slice(0, 8000);
      wiki.injectionPrompt = String(document.getElementById("mmc-wiki-injection-prompt")?.value || "").trim().slice(0, 8000);
      wiki.originChatId = String(state.selectedChatId || "");
      data.wiki = wiki;
      await persistData(data);
      state.layer = null;
      render();
    }
    function refreshWikiListDom() {
      const list = document.querySelector("[data-wiki-list]");
      if (!list)
        return;
      list.innerHTML = wikiListMarkup(wikiState());
    }
    async function handleWikiAction(action, actionEl) {
      if (action === "wiki-open") {
        const id = String(actionEl.dataset.id || "");
        if (!id) {
          toast("아직 만들어지지 않은 문서입니다.");
          return true;
        }
        if (state.wikiSelectedId && state.wikiSelectedId !== id) {
          state.wikiHistory = [...state.wikiHistory.filter((row) => row !== state.wikiSelectedId), state.wikiSelectedId].slice(-20);
        }
        state.wikiSelectedId = id;
        state.activeTab = "wiki";
        if (state.layer === "evidence")
          state.layer = null;
        await saveUiState();
        render();
        return true;
      }
      if (action === "wiki-filter") {
        const category = String(actionEl.dataset.category || "all");
        state.wikiCategoryFilter = category === "all" || Object.prototype.hasOwnProperty.call(WIKI_CATEGORY_LABEL, category) ? category : "all";
        await saveUiState();
        refreshWikiListDom();
        const select = document.getElementById("mmc-wiki-category-filter");
        if (select)
          select.value = state.wikiCategoryFilter;
        return true;
      }
      if (action === "wiki-back") {
        const previous = state.wikiHistory.pop();
        state.wikiSelectedId = previous && wikiState().docs.some((doc) => doc.id === previous) ? previous : "";
        render();
        return true;
      }
      if (action === "wiki-toggle-ko") {
        state.koDisplay = koDisplayOn() ? "original" : "auto";
        await saveUiState();
        render();
        return true;
      }
      if (action === "wiki-toc") {
        const target = document.getElementById(String(actionEl.dataset.target || ""));
        target?.scrollIntoView?.({ behavior: "smooth", block: "start" });
        return true;
      }
      if (action === "wiki-new") {
        state.wikiDraft = wikiEditableDraft({ id: "", title: "", sections: [normalizeWikiSection({ heading: "기본 정보", body: "", managed: "user" }), normalizeWikiSection({ heading: "현재 상황", body: "", managed: "ai" })] });
        state.wikiDraft.id = "";
        state.layer = "wiki-editor";
        render();
        return true;
      }
      if (action === "wiki-new-from-link") {
        const title = String(actionEl.dataset.title || "").trim();
        const seeded = seedKeywordsByScript(title);
        state.wikiDraft = wikiEditableDraft({ id: "", title, keywordsKo: seeded.ko, keywordsEn: seeded.en, sections: [normalizeWikiSection({ heading: "기본 정보", body: "", managed: "user", level: 1 })] });
        state.wikiDraft.id = "";
        state.layer = "wiki-editor";
        render();
        return true;
      }
      if (action === "wiki-edit") {
        const doc = wikiState().docs.find((row) => row.id === String(actionEl.dataset.id || ""));
        if (!doc)
          return true;
        state.wikiDraft = wikiEditableDraft(doc);
        state.layer = "wiki-editor";
        render();
        return true;
      }
      if (action === "wiki-add-section") {
        captureWikiDraft();
        if (!state.wikiDraft)
          return true;
        if (safeArray(state.wikiDraft.sections).length >= WIKI_SECTION_LIMIT)
          throw new Error(`섹션은 최대 ${WIKI_SECTION_LIMIT}개까지 만들 수 있습니다.`);
        state.wikiDraft.sections = [...safeArray(state.wikiDraft.sections), normalizeWikiSection({ heading: "새 섹션", body: "", managed: "user", level: 1 })];
        render();
        return true;
      }
      if (action === "wiki-remove-section") {
        captureWikiDraft();
        if (!state.wikiDraft)
          return true;
        const index = Number(actionEl.dataset.index);
        state.wikiDraft.sections = safeArray(state.wikiDraft.sections).filter((row, i) => i !== index);
        render();
        return true;
      }
      if (action === "wiki-add-image") {
        captureWikiDraft();
        if (!state.wikiDraft)
          return true;
        if (safeArray(state.wikiDraft.images).length >= WIKI_IMAGE_LIMIT)
          throw new Error(`이미지는 최대 ${WIKI_IMAGE_LIMIT}개까지 연결할 수 있습니다.`);
        state.wikiDraft.images = [...safeArray(state.wikiDraft.images), { id: uid("wimg"), url: "", alt: "", caption: "", lead: false }];
        render();
        return true;
      }
      if (action === "wiki-remove-image") {
        captureWikiDraft();
        if (!state.wikiDraft)
          return true;
        const index = Number(actionEl.dataset.index);
        state.wikiDraft.images = safeArray(state.wikiDraft.images).filter((row, i) => i !== index);
        render();
        return true;
      }
      if (action === "wiki-remove-source") {
        captureWikiDraft();
        if (!state.wikiDraft)
          return true;
        const index = Number(actionEl.dataset.index);
        state.wikiDraft.sources = safeArray(state.wikiDraft.sources).filter((row, i) => i !== index);
        render();
        return true;
      }
      if (action === "wiki-save") {
        await saveWikiDoc();
        return true;
      }
      if (action === "wiki-delete") {
        const id = String(actionEl.dataset.id || state.wikiDraft?.id || "");
        if (!id || !window.confirm("이 위키 문서를 삭제할까요? 약속·앵커·요소 기억 원본은 그대로 남습니다."))
          return true;
        await deleteWikiDoc(id);
        return true;
      }
      if (action === "wiki-toggle") {
        await toggleWikiFlag(actionEl.dataset.id, String(actionEl.dataset.field || ""));
        return true;
      }
      if (action === "wiki-settings") {
        state.layer = "wiki-settings";
        render();
        return true;
      }
      if (action === "wiki-save-settings") {
        await saveWikiSettings();
        return true;
      }
      if (action === "reset-wiki-draft-prompt") {
        const box = document.getElementById("mmc-wiki-draft-prompt");
        if (box)
          box.value = DEFAULT_WIKI_DRAFT_PROMPT;
        return true;
      }
      if (action === "reset-wiki-update-prompt") {
        const box = document.getElementById("mmc-wiki-update-prompt");
        if (box)
          box.value = DEFAULT_WIKI_UPDATE_PROMPT;
        return true;
      }
      if (action === "reset-wiki-injection-prompt") {
        const box = document.getElementById("mmc-wiki-injection-prompt");
        if (box)
          box.value = DEFAULT_WIKI_INJECTION_PROMPT;
        return true;
      }
      if (action === "wiki-draft-open") {
        await openWikiDraftLayer();
        return true;
      }
      if (action === "wiki-source-all") {
        state.wikiSourceRows.forEach((row) => state.wikiSourceSelected.add(String(row.id)));
        render();
        return true;
      }
      if (action === "wiki-source-none") {
        state.wikiSourceSelected.clear();
        render();
        return true;
      }
      if (action === "wiki-source-group") {
        const kind = String(actionEl.dataset.kind || "");
        const rows = state.wikiSourceRows.filter((row) => row.kind === kind);
        const allOn = rows.length > 0 && rows.every((row) => state.wikiSourceSelected.has(String(row.id)));
        rows.forEach((row) => {
          if (allOn)
            state.wikiSourceSelected.delete(String(row.id));
          else
            state.wikiSourceSelected.add(String(row.id));
        });
        render();
        return true;
      }
      if (action === "wiki-draft-run") {
        state.wikiDraftTopic = String(document.getElementById("mmc-wiki-draft-topic")?.value || "").trim().slice(0, 120);
        const chosen = String(document.getElementById("mmc-wiki-draft-model")?.value || "");
        if (chosen !== wikiState().connectionId) {
          const data = normalizeData(state.currentData);
          const wiki = normalizeWiki(data.wiki);
          wiki.connectionId = chosen;
          data.wiki = wiki;
          await persistData(data, { sync: false, silent: true });
        }
        await generateWikiDrafts();
        return true;
      }
      if (action === "wiki-candidate-all") {
        state.wikiCandidateSelected = new Set(state.wikiCandidates.map((row, index) => String(index)));
        render();
        return true;
      }
      if (action === "wiki-candidate-none") {
        state.wikiCandidateSelected.clear();
        render();
        return true;
      }
      if (action === "wiki-candidate-save") {
        await applyWikiCandidates();
        return true;
      }
      if (action === "wiki-propose") {
        await generateWikiProposal(actionEl.dataset.id);
        return true;
      }
      if (action === "wiki-proposal-open") {
        const proposal = wikiProposalFor(actionEl.dataset.id);
        if (!proposal) {
          toast("대기 중인 변경 제안이 없습니다.");
          return true;
        }
        state.wikiProposalDocId = String(actionEl.dataset.id || "");
        state.wikiProposalSelected = new Set(proposal.changes.map((row, index) => String(index)));
        state.layer = "wiki-proposal";
        render();
        return true;
      }
      if (action === "wiki-proposal-all") {
        const proposal = wikiProposalFor(state.wikiProposalDocId);
        state.wikiProposalSelected = new Set(safeArray(proposal?.changes).map((row, index) => String(index)));
        render();
        return true;
      }
      if (action === "wiki-proposal-none") {
        state.wikiProposalSelected.clear();
        render();
        return true;
      }
      if (action === "wiki-proposal-apply") {
        await applyWikiProposal();
        return true;
      }
      if (action === "wiki-proposal-dismiss") {
        const id = String(actionEl.dataset.id || state.wikiProposalDocId || "");
        if (!window.confirm("이 변경 제안을 무시할까요? 문서는 그대로 두고 같은 기억으로 다시 알리지 않습니다."))
          return true;
        await dismissWikiProposal(id);
        return true;
      }
      if (action === "wiki-source") {
        state.evidenceView = { kind: "wiki", id: String(actionEl.dataset.id || ""), index: Number(actionEl.dataset.index) || 0 };
        state.layer = "evidence";
        render();
        return true;
      }
      return false;
    }
    async function handleWikiChange(target) {
      if (target?.id === "mmc-wiki-category-filter") {
        state.wikiCategoryFilter = String(target.value || "all");
        await saveUiState();
        refreshWikiListDom();
        return true;
      }
      if (target?.matches?.("[data-wiki-source-id]")) {
        const id = String(target.dataset.wikiSourceId || "");
        if (target.checked)
          state.wikiSourceSelected.add(id);
        else
          state.wikiSourceSelected.delete(id);
        render();
        return true;
      }
      if (target?.matches?.("[data-wiki-candidate-index]")) {
        const id = String(target.dataset.wikiCandidateIndex || "");
        if (target.checked)
          state.wikiCandidateSelected.add(id);
        else
          state.wikiCandidateSelected.delete(id);
        const row = target.closest?.(".mmc-wiki-candidate");
        if (row)
          row.classList.toggle("is-selected", !!target.checked);
        const button = document.querySelector('[data-action="wiki-candidate-save"]');
        if (button) {
          button.disabled = state.wikiCandidateSelected.size <= 0;
          button.textContent = `선택 ${state.wikiCandidateSelected.size}개 저장`;
        }
        return true;
      }
      if (target?.matches?.("[data-wiki-proposal-index]")) {
        const id = String(target.dataset.wikiProposalIndex || "");
        if (target.checked)
          state.wikiProposalSelected.add(id);
        else
          state.wikiProposalSelected.delete(id);
        const row = target.closest?.(".mmc-wiki-change");
        if (row)
          row.classList.toggle("is-selected", !!target.checked);
        const button = document.querySelector('[data-action="wiki-proposal-apply"]');
        if (button) {
          button.disabled = state.wikiProposalSelected.size <= 0;
          button.textContent = `선택 ${state.wikiProposalSelected.size}건 반영`;
        }
        return true;
      }
      return false;
    }
    function handleWikiInput(target) {
      const countFor = target?.dataset?.wikiCountFor;
      if (countFor) {
        const note = document.querySelector(`[data-wiki-count="${countFor}"]`);
        if (note) {
          const max = Number(note.dataset.wikiCountMax) || 0;
          const length = String(target.value || "").length;
          note.classList.toggle("is-over", max > 0 && length > max);
          note.textContent = `${length.toLocaleString()} / ${max.toLocaleString()}자${max > 0 && length > max ? ` · ${(length - max).toLocaleString()}자 초과` : ""}`;
        }
        return true;
      }
      if (target?.id !== "mmc-wiki-search")
        return false;
      state.wikiSearch = String(target.value || "");
      refreshWikiListDom();
      return true;
    }
    function relTime(value) {
      const time = Date.parse(String(value || ""));
      if (!Number.isFinite(time))
        return "";
      const diff = Math.max(0, Date.now() - time);
      const min = Math.floor(diff / 60000);
      if (min < 1)
        return "방금";
      if (min < 60)
        return `${min}분 전`;
      const hour = Math.floor(min / 60);
      if (hour < 24)
        return `${hour}시간 전`;
      const day = Math.floor(hour / 24);
      if (day < 7)
        return `${day}일 전`;
      return sourceDate(value);
    }
    function tabCounts() {
      const rows = safeArray(state.currentData?.items);
      return {
        overview: 0,
        promise: rows.filter((item) => item.type === "promise" && item.status === "active").length,
        anchor: rows.filter((item) => item.type === "anchor").length,
        episode: liveEpisodes().length,
        thread: threadList().filter((t) => threadInjectable(t.status)).length,
        element: elementMemory().entities.length,
        wiki: wikiState().docs.length
      };
    }
    function tabMeta() {
      return [
        { id: "overview", label: "개요", short: "개요", icon: SVG.overview },
        { id: "promise", label: "약속", short: "약속", icon: SVG.promise },
        { id: "thread", label: "진행 흐름", short: "흐름", icon: SVG.flow },
        { id: "anchor", label: "기억 앵커", short: "앵커", icon: SVG.anchor },
        { id: "episode", label: "장면 기억", short: "장면", icon: SVG.scene },
        { id: "element", label: "요소 기억", short: "요소", icon: SVG.element },
        { id: "wiki", label: "이야기 위키", short: "위키", icon: SVG.wiki }
      ];
    }
    function inboxRows() {
      const rows = [];
      const data = state.currentData;
      if (!data || !ownershipAllowsData())
        return rows;
      if (state.reviewSourceRows.length) {
        rows.push({ tone: "accent", title: `모델 분석 완료 · 갱신 후보 ${state.reviewCandidates.length}개`, sub: "아직 보관함에는 적용되지 않았어요", actions: [["open-review-draft", "결과 확인", "", true]] });
      } else if (state.pendingSummaryRows.length) {
        const advanced = advancedMemoryEnabled();
        const modeText = advanced ? "고급 메모리 보호 모드 · 수동 확인" : SUMMARY_UPDATE_MODE_LABEL[state.summaryUpdateMode] || "알림 + 모델 정리 버튼";
        const actions = [["review-pending", "내용 확인", "", false]];
        if (state.summaryUpdateMode !== "notify_only")
          actions.push(["review-model", "모델로 정리", "", true]);
        const sceneCount = amRowsPending(state.pendingSummaryRows).length;
        const plainCount = state.pendingSummaryRows.length - sceneCount;
        const label = [plainCount ? `새 요약 ${plainCount}개` : "", sceneCount ? `새 장면 요약 ${sceneCount}개` : ""].filter(Boolean).join(" · ");
        rows.push({ tone: "accent", title: `${label} · 기억 갱신이 필요해요`, sub: `${modeText} · 아직 약속·앵커에 반영되지 않았어요`, actions });
      }
      if (safeArray(state.staleRecords).length)
        rows.push({ tone: "warn", title: `근거가 바뀐 기억 ${state.staleRecords.length}개`, sub: "근거 요약·장면·메시지가 바뀌었거나 지워졌어요 · 기억은 그대로 들어가는 중이에요", actions: [["stale-open", "확인", "", true]] });
      const held = branchHoldCount(data.branchHold);
      if (held) {
        const hold = normalizeBranchHold(data.branchHold);
        rows.push({ tone: "warn", title: `분기 확인 대기 ${held}개`, sub: `분기 시점(${sourceDate(hold.cutAt) || "알 수 없음"}) 뒤에 부모 RP에서 생기거나 바뀐 기록이에요 · 이 분기에는 아직 넣지 않았어요`, actions: [["branch-hold-open", "확인", "", true]] });
      }
      const undo = data.lastAutoReviewUndo;
      if (undo) {
        const count = safeArray(undo.updated).length + safeArray(undo.created).length;
        rows.push({ tone: "warn", title: `직전 자동 적용 ${count}개를 되돌릴 수 있어요`, sub: "자동 적용 뒤 직접 고친 기록은 건너뜁니다", actions: [["undo-auto-review", "되돌리기", "", false]] });
      }
      const wiki = wikiState();
      for (const proposal of wiki.proposals.slice(0, 3)) {
        const doc = wiki.docs.find((row) => row.id === proposal.docId);
        rows.push({ tone: "accent2", title: `위키 ‘${truncate(doc?.title || proposal.docTitle || "문서", 24)}’ 변경 제안 ${proposal.changes.length}건`, sub: `새 기억 ${proposal.sourceCount}건 기준${proposal.conflicts.length ? ` · 잠금 충돌 ${proposal.conflicts.length}건` : ""}`, actions: [["wiki-proposal-open", "보기", proposal.docId, false]] });
      }
      const fullPlan = injectionPlan(data);
      if (fullPlan.duplicates.length)
        rows.push({ tone: "muted", title: `제목이 같은 기록 ${fullPlan.duplicates.length}개는 하나만 넣고 있어요`, sub: "같은 일이 두 번 들어가지 않게 최신·중요한 쪽만 넣어요 · 합치거나 정리하려면 해당 탭에서 고쳐 주세요", actions: [["tab", "앵커 보기", "anchor", false]] });
      if (fullPlan.capHeld.length)
        rows.push({ tone: "warn", title: `총 상한 때문에 ${fullPlan.capHeld.length}개가 대기 중`, sub: "중요가 아닌 오래된 기록부터 대기로 돌렸어요 · 지워지지는 않아요", actions: [["settings", "상한 보기", "", false]] });
      const plan = anchorInjectionPlan();
      if (plan.excluded.length)
        rows.push({ tone: "warn", title: `앵커 ${plan.excluded.length}개가 예산 때문에 대기 중`, sub: `항상 기억 ${plan.used.toLocaleString()} / ${plan.budget.toLocaleString()}자 · 지워지지는 않아요`, actions: [["tab", "앵커 보기", "anchor", false]] });
      const keywordless = safeArray(data.items).filter((item) => item.type === "anchor" && item.active && !item.archived && item.activation === "keyword" && !safeArray(item.keywords).length).length;
      if (keywordless)
        rows.push({ tone: "warn", title: `키워드 없는 키워드 앵커 ${keywordless}개`, sub: "키워드가 없으면 떠오르지 않아요", actions: [["tab", "앵커 보기", "anchor", false]] });
      const memory = elementMemory();
      const noCond = memory.entities.filter((entity) => !elementTriggerConditions(entity).length).length;
      if (noCond)
        rows.push({ tone: "muted", title: `검색 조건 없는 요소 ${noCond}개`, sub: "호출어를 넣어야 RP에서 불러올 수 있어요", actions: [["tab", "요소 보기", "element", false]] });
      return rows;
    }
    function inboxMarkup() {
      const rows = inboxRows();
      return `<section class="mmc-card mmc-inbox">
      <header class="mmc-card-head"><b>검토 대기</b>${rows.length ? `<em class="mmc-count">${rows.length}</em>` : ""}</header>
      ${rows.length ? rows.map((row) => `<div class="mmc-inbox-row is-${row.tone}"><span class="mmc-inbox-icon">${row.tone === "warn" ? SVG.warn : SVG.inbox}</span><span class="mmc-inbox-copy"><b>${esc(row.title)}</b><small>${esc(row.sub)}</small></span><span class="mmc-inbox-actions">${row.actions.map(([action, label, value, primary]) => `<button class="mmc-btn mmc-sm ${primary ? "mmc-primary" : "mmc-soft"}" data-action="${action}" ${action === "tab" ? `data-tab="${esc(value)}"` : value ? `data-id="${esc(value)}"` : ""}>${esc(label)}</button>`).join("")}</span></div>`).join("") : `<div class="mmc-inbox-empty">${SVG.inbox}<b>검토할 것이 없어요</b><small>새 요약이나 위키 변경 제안이 생기면 여기에 모여요.</small></div>`}
    </section>`;
    }
    function injectionSummary() {
      const data = state.currentData;
      const chat = state.currentChat;
      const promises = sharedPromises(data);
      const restricted = restrictedInjectionItems(data);
      const plan = anchorInjectionPlan();
      const wiki = wikiState();
      const wikiAlways = wiki.injectionEnabled ? wikiAlwaysDocs(wiki) : [];
      const memory = elementMemory();
      const keywordAnchors = activeKeywordAnchors().length;
      const elementConds = memory.injectionEnabled ? memory.entities.filter((entity) => elementTriggerConditions(entity).length).length : 0;
      const wikiConds = wiki.docs.filter((doc) => wikiDocInjectable(doc, wiki)).length;
      const parts = [
        { id: "promise", label: "약속 · 진행 중", count: promises.length, text: promises.length ? promiseContext(chat, data) : "" },
        { id: "anchor", label: "항상 앵커", count: sharedAnchors(data).length, text: sharedAnchors(data).length ? anchorContext(chat, data) : "" },
        { id: "thread", label: "진행 흐름", count: injectionPlan(data).threads.length, text: threadContext(chat, data) },
        { id: "wiki", label: "위키 개요", count: wikiAlways.length, text: wikiAlways.length ? wikiAlwaysContext(chat, wiki) : "" },
        ...restricted.length ? [{ id: "restricted", label: restrictionEffective() ? "일부 인물만 아는 기억" : "일부 인물만 아는 기억 (병합 그룹이라 넣지 않음)", count: restricted.length, text: restrictionEffective() ? restricted.map((item) => restrictedContext(chat, item)).join(`

`) : "" }] : []
      ].map((part) => ({ ...part, tokens: part.text ? estimateTokens(part.text) : 0 }));
      return { parts, total: parts.reduce((sum, part) => sum + part.tokens, 0), keywordAnchors, elementConds, wikiConds, conditional: keywordAnchors + elementConds + wikiConds, plan };
    }
    function injectMarkup() {
      const info = injectionSummary();
      const data = state.currentData;
      const syncError = data?.lastSyncError;
      return `<section class="mmc-card mmc-inject">
      <div class="mmc-inject-head">
        <div><span class="mmc-eyebrow">매 턴 RP에 늘 들어가는 기억</span><strong>${info.total.toLocaleString()}<small>tokens (약)</small></strong></div>
        <span class="mmc-pill ${syncError ? "is-bad" : data.lorebookId || data.lastSyncAt ? "is-ok" : ""}">${syncError ? "동기화 확인 필요" : data.lorebookId || data.lastSyncAt ? "주입 켜짐" : "아직 동기화 전"}</span>
      </div>
      <div class="mmc-meter" role="img" aria-label="주입 구성">${info.total ? info.parts.filter((part) => part.tokens).map((part) => `<i class="is-${part.id}" style="flex:${part.tokens}"></i>`).join("") : '<i class="is-empty"></i>'}</div>
      <ul class="mmc-legend">${info.parts.map((part) => `<li class="is-${part.id}"><i></i>${esc(part.label)} <b>${part.count}</b></li>`).join("")}<li class="is-cond"><i></i>조건부 (키워드가 나올 때) <b>${info.conditional}</b></li></ul>
      <div class="mmc-inject-foot">
        <small>${SVG.info}<span>조건부: 앵커 키워드 ${info.keywordAnchors} · 요소 ${info.elementConds} · 위키 ${info.wikiConds} · 앵커 예산 ${info.plan.used.toLocaleString()} / ${info.plan.budget.toLocaleString()}자</span></small>
        <button class="mmc-btn mmc-sm mmc-ghost" data-action="inject-preview">${SVG.eye}<span>주입 미리보기</span></button>
      </div>
    </section>`;
    }
    function statCards() {
      const rows = safeArray(state.currentData?.items);
      const promises = rows.filter((item) => item.type === "promise");
      const anchors = rows.filter((item) => item.type === "anchor");
      const plan = anchorInjectionPlan();
      const memory = elementMemory();
      const wiki = wikiState();
      const cards = [
        ["promise", SVG.promise, "약속", promises.filter((item) => item.status === "active").length, `진행 중 · 전체 ${promises.length}`],
        ["anchor", SVG.anchor, "기억 앵커", plan.selected.length + activeKeywordAnchors().length, `주입 중 · 전체 ${anchors.length}`],
        ["element", SVG.element, "요소 기억", memory.entities.length, `검색 가능 ${memory.entities.filter((entity) => elementTriggerConditions(entity).length).length}`],
        ["wiki", SVG.wiki, "이야기 위키", wiki.docs.length, `항상 기억 ${wikiAlwaysDocs(wiki).length} · 제안 ${wiki.proposals.length}`]
      ];
      return `<div class="mmc-stats">${cards.map(([tab, icon, label, value, sub]) => `<button class="mmc-stat" data-action="tab" data-tab="${tab}"><span class="mmc-stat-top"><i>${icon}</i><span>${label}</span></span><b>${value}</b><small>${esc(sub)}</small></button>`).join("")}</div>`;
    }
    function timelineMarkup() {
      const rows = [];
      for (const item of safeArray(state.currentData?.items))
        rows.push({ kind: item.type, icon: item.type === "promise" ? SVG.promise : SVG.anchor, title: displayText(item.title, item.titleKo), label: item.type === "promise" ? "약속" : "기억 앵커", at: item.updatedAt || item.createdAt, created: item.createdAt && item.createdAt === item.updatedAt, action: "edit-item", id: item.id });
      for (const entity of elementMemory().entities)
        rows.push({ kind: "element", icon: SVG.element, title: displayText(entity.name, entity.nameKo), label: "요소 기억", at: entity.updatedAt || entity.createdAt, created: entity.createdAt && entity.createdAt === entity.updatedAt, action: "edit-element", id: entity.id });
      for (const doc of wikiState().docs)
        rows.push({ kind: "wiki", icon: SVG.wiki, title: displayText(doc.title, doc.titleKo), label: "위키 문서", at: doc.updatedAt || doc.createdAt, created: doc.createdAt && doc.createdAt === doc.updatedAt, action: "wiki-open", id: doc.id });
      const list = rows.filter((row) => row.at).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 6);
      return `<section class="mmc-card mmc-timeline">
      <header class="mmc-card-head"><b>최근 변화</b></header>
      ${list.length ? `<ol>${list.map((row) => `<li><button data-action="${row.action}" data-id="${esc(row.id)}"><i class="is-${row.kind}">${row.icon}</i><span><b>${esc(truncate(row.title, 48))}</b><small>${row.label} · ${row.created ? "추가" : "수정"}</small></span><time>${esc(relTime(row.at))}</time></button></li>`).join("")}</ol>` : '<div class="mmc-empty">아직 기록이 없어요.</div>'}
    </section>`;
    }
    function overviewView() {
      return `<div class="mmc-overview">
      <div data-mmc-summary-alert-slot>${statusBanners()}</div>
      <div class="mmc-ov-grid">${injectMarkup()}${inboxMarkup()}</div>
      ${statCards()}
      ${timelineMarkup()}
    </div>`;
    }
    function injectPreviewLayer() {
      const info = injectionSummary();
      const blocks = info.parts.filter((part) => part.text).map((part) => `<section class="mmc-preview-block is-${part.id}"><header><b>${esc(part.label)}</b><small>${part.count}개 · 약 ${part.tokens.toLocaleString()} tokens</small></header><pre>${esc(part.text)}</pre></section>`).join("");
      return `<div class="mmc-layer-backdrop" data-action="close-layer"><section class="mmc-layer mmc-preview-layer" data-layer-stop>
      <header><div><span class="mmc-kicker">INJECTION PREVIEW</span><h3>RP에 늘 들어가는 기억</h3><small>전용 로어북에 이 내용이 상시 항목으로 들어가요. 조건부 항목은 키워드가 나올 때만 붙어요.</small></div><button class="mmc-icon-btn" data-action="close-layer" aria-label="닫기">${SVG.close}</button></header>
      <div class="mmc-layer-body">${blocks || '<div class="mmc-empty">지금은 상시로 들어가는 기억이 없어요.</div>'}<div class="mmc-candidate-note">조건부 · 앵커 키워드 ${info.keywordAnchors}개 · 요소 기억 ${info.elementConds}개 · 위키 문서 ${info.wikiConds}개는 대화에 키워드가 나올 때만 붙습니다.</div></div>
      <footer><button class="mmc-btn" data-action="sync" ${ownershipAllowsData() ? "" : "disabled"}>${SVG.sync}<span>다시 동기화</span></button><div><button class="mmc-btn mmc-primary" data-action="close-layer">확인</button></div></footer>
    </section></div>`;
    }
    function filteredItems(type) {
      const items = safeArray(state.currentData?.items).filter((item) => item.type === type).sort(prioritySort);
      if (type === "promise") {
        if (state.filter === "active")
          return items.filter((item) => item.status === "active");
        if (state.filter === "hold")
          return items.filter((item) => item.status === "hold");
        if (state.filter === "done")
          return items.filter((item) => ["done", "cancelled"].includes(item.status));
        return items;
      }
      if (state.filter === "archived")
        return items.filter((item) => item.archived);
      if (state.filter === "active")
        return items.filter((item) => item.active && !item.archived);
      return items;
    }
    function promiseLine(item) {
      const schedule = item.scheduleText ? ` / 예정: ${truncate(item.scheduleText, 90)}` : "";
      return `- ${item.priority === "high" ? "[중요] " : ""}${truncate(item.title, 90)}: ${truncate(item.content, 320)}${schedule}`;
    }
    function scopeChip(item) {
      if (!isRestrictedItem(item))
        return "";
      const held = !restrictionEffective();
      return `<span class="mmc-chip ${held ? "is-warn" : "is-soft"}" title="${held ? "병합 그룹 응답이라 넣지 않아요" : "이 인물이 응답할 때만 들어가요"}">아는 인물 · ${esc(truncate(knownByLabel(item.knownBy), 24))}${held ? " · 대기" : ""}</span>`;
    }
    function promiseRow(item, index = 0) {
      const checked = item.status === "done";
      const selected = item.id === state.promiseSelectedId;
      const chips = [
        item.scheduleText ? `<span class="mmc-chip">${esc(truncate(item.scheduleText, 28))}</span>` : "",
        item.status !== "active" ? `<span class="mmc-chip is-${item.status}">${esc(PROMISE_STATUS_LABEL[item.status] || item.status)}${item.status === "done" && item.updatedAt ? ` · ${esc(sourceDate(item.updatedAt).split(" ")[0] || "")}` : ""}</span>` : "",
        item.sourceType === "summary" || item.sourceType === "model" ? '<span class="mmc-chip is-soft">요약에서</span>' : item.sourceType === "manual" ? '<span class="mmc-chip is-soft">직접 추가</span>' : "",
        scopeChip(item)
      ].join("");
      return `<article class="mmc-ticket prio-${esc(item.priority || "normal")} is-${esc(item.status)} ${selected ? "is-selected" : ""}" data-item-id="${esc(item.id)}">
      <button class="mmc-check ${checked ? "is-checked" : ""}" data-action="toggle-promise-done" data-id="${esc(item.id)}" title="${checked ? "다시 진행 중" : "완료로 표시"}" aria-label="${checked ? "다시 진행 중" : "완료로 표시"}">${checked ? "✓" : ""}</button>
      <button class="mmc-ticket-main" data-action="promise-open" data-id="${esc(item.id)}">
        <b>${esc(displayText(item.title, item.titleKo))}</b>
        <small>${esc(truncate(displayText(item.content, item.contentKo), 90))}</small>
        ${chips ? `<span class="mmc-chips">${chips}</span>` : ""}
      </button>
      <span class="mmc-ticket-no">${String(index + 1).padStart(2, "0")}</span>
    </article>`;
    }
    function anchorRow(item) {
      const checked = item.active && !item.archived;
      const plan = injectionPlan();
      const injectedAlways = item.activation !== "always" || plan.anchors.some((row) => row.id === item.id);
      const mode = item.archived ? "보관" : !item.active ? "꺼짐" : item.activation === "keyword" ? safeArray(item.keywords).length ? "키워드" : "키워드 없음" : injectedAlways ? "주입 중" : "예산 대기";
      const lifespan = ANCHOR_LIFESPAN_LABEL[item.lifespan] || ANCHOR_LIFESPAN_LABEL.permanent;
      const evidence = item.sourceQuote || safeArray(item.sourceIds).length;
      const wait = checked && item.activation === "always" && !injectedAlways;
      const keywords = item.activation === "keyword" && safeArray(item.keywords).length ? `<span class="mmc-kw">${item.keywords.slice(0, 6).map((word) => `<i>${esc(word)}</i>`).join("")}</span>` : "";
      return `<article class="mmc-anchor ${!checked ? "is-muted" : ""} ${wait ? "is-budget-wait" : ""} prio-${esc(item.priority || "normal")}" data-item-id="${esc(item.id)}">
      <button class="mmc-check mmc-pin-check ${checked ? "is-checked" : ""}" data-action="toggle-anchor-active" data-id="${esc(item.id)}" title="${checked ? "주입 끄기" : "주입 켜기"}" aria-label="${checked ? "주입 끄기" : "주입 켜기"}">${checked ? "•" : ""}</button>
      <button class="mmc-anchor-main" data-action="edit-item" data-id="${esc(item.id)}">
        <b>${esc(displayText(item.title, item.titleKo))}</b>
        <small>${esc(truncate(displayText(item.content, item.contentKo), 150))}</small>
        ${keywords}
        <span class="mmc-chips"><span class="mmc-chip">${esc(ANCHOR_CATEGORY_LABEL[item.category] || "기억")}</span><span class="mmc-chip ${wait || mode === "키워드 없음" ? "is-warn" : mode === "주입 중" || mode === "키워드" ? "is-ok" : ""}">${mode}</span><span class="mmc-chip is-soft">${esc(lifespan)}</span>${item.priority === "high" ? '<span class="mmc-chip is-high">중요</span>' : ""}${scopeChip(item)}</span>
      </button>
      <span class="mmc-anchor-side">${evidence ? `<button class="mmc-evidence-link" data-action="view-evidence" data-kind="item" data-id="${esc(item.id)}">근거</button>` : ""}<button class="mmc-mini" data-action="anchor-move" data-id="${esc(item.id)}" title="${item.activation === "keyword" ? "항상 기억으로 옮기기" : "키워드로 떠오름으로 옮기기"}">${item.activation === "keyword" ? "항상으로" : "키워드로"}</button></span>
    </article>`;
    }
    function promiseDetail(item) {
      if (!item)
        return `<div class="mmc-detail-empty">${SVG.promise}<b>약속을 골라 주세요</b><small>왼쪽 목록에서 약속을 누르면 상세와 RP에 들어가는 문장이 보여요.</small></div>`;
      const data = state.currentData;
      const injected = activePromises().slice(0, data.maxPromises).some((row) => row.id === item.id);
      const evidence = item.sourceQuote || safeArray(item.sourceIds).length;
      const sourceLabel = item.sourceType === "summary" ? "요약에서" : item.sourceType === "model" ? "모델 정리" : item.sourceType === "message" ? "대화에서" : "직접 추가";
      return `<header class="mmc-detail-head">
        <button class="mmc-btn mmc-sm mmc-ghost mmc-m-only" data-action="promise-back">${SVG.back}<span>목록</span></button>
        <span class="mmc-chips">${item.priority === "high" ? '<span class="mmc-chip is-high">중요</span>' : ""}<span class="mmc-chip is-soft">${sourceLabel}</span></span>
        <h3>${esc(displayText(item.title, item.titleKo))}</h3>
      </header>
      <div class="mmc-stepper" role="group" aria-label="약속 상태">${Object.entries(PROMISE_STATUS_LABEL).map(([id, label]) => `<button class="${item.status === id ? "is-on" : ""} is-${id}" data-action="promise-status" data-id="${esc(item.id)}" data-status="${id}">${label}</button>`).join("")}</div>
      <section class="mmc-detail-sec"><span class="mmc-label">내용</span><p class="mmc-detail-body">${esc(displayText(item.content, item.contentKo))}</p></section>
      <div class="mmc-kv"><div><span>예정·조건</span><b>${esc(item.scheduleText || "정하지 않음")}</b></div><div><span>중요도</span><b>${esc(PRIORITY_LABEL[item.priority] || "보통")}</b></div><div><span>최근 수정</span><b>${esc(sourceDate(item.updatedAt) || "-")}</b></div></div>
      ${evidence ? `<section class="mmc-detail-sec"><span class="mmc-label">근거</span>${item.sourceQuote ? `<blockquote class="mmc-quote">${esc(truncate(item.sourceQuote, 260))}</blockquote>` : ""}<button class="mmc-evidence-link" data-action="view-evidence" data-kind="item" data-id="${esc(item.id)}">근거 전체 보기</button></section>` : ""}
      <section class="mmc-detail-sec"><span class="mmc-label">RP에 이렇게 들어가요</span><pre class="mmc-inject-pre ${injected ? "" : "is-off"}">${injected ? esc(promiseLine(item)) : item.status === "active" ? "상시 주입 상한 밖이라 지금은 들어가지 않아요. (설정 › 약속 상시 주입 상한)" : "진행 중인 약속만 RP에 들어가요."}</pre></section>
      <footer class="mmc-detail-foot"><button class="mmc-btn" data-action="edit-item" data-id="${esc(item.id)}">${SVG.edit}<span>편집</span></button><button class="mmc-btn mmc-ghost mmc-danger-text" data-action="delete-item" data-id="${esc(item.id)}">${SVG.trash}<span>삭제</span></button></footer>`;
    }
    function promiseView() {
      const all = safeArray(state.currentData?.items).filter((item) => item.type === "promise");
      const items = filteredItems("promise");
      if (!items.some((item) => item.id === state.promiseSelectedId))
        state.promiseSelectedId = items[0]?.id || "";
      const selected = items.find((item) => item.id === state.promiseSelectedId) || null;
      const count = (filter) => filter === "active" ? all.filter((item) => item.status === "active").length : filter === "hold" ? all.filter((item) => item.status === "hold").length : filter === "done" ? all.filter((item) => ["done", "cancelled"].includes(item.status)).length : all.length;
      const pane = state.promisePane === "detail" && selected ? "detail" : "list";
      return `<div data-mmc-summary-alert-slot>${statusBanners()}</div>
      <div class="mmc-split" data-pane="${pane}">
        <section class="mmc-card mmc-listpane">
          ${filterBar(count)}
          <div class="mmc-tickets">${items.length ? items.map((item, index) => promiseRow(item, index)).join("") : `<div class="mmc-empty">${all.length ? "이 상태의 약속이 없어요." : "아직 보관된 약속이 없어요.<br>직접 추가하거나 대화에서 가져와 보세요."}</div>`}</div>
          <footer class="mmc-listpane-foot">${mainActions()}</footer>
        </section>
        <section class="mmc-card mmc-detail">${promiseDetail(selected)}</section>
      </div>`;
    }
    function anchorView() {
      const items = filteredItems("anchor");
      const always = items.filter((item) => item.activation !== "keyword");
      const keyword = items.filter((item) => item.activation === "keyword");
      const all = safeArray(state.currentData?.items).filter((item) => item.type === "anchor");
      const count = (filter) => filter === "active" ? all.filter((item) => item.active && !item.archived).length : filter === "archived" ? all.filter((item) => item.archived).length : all.length;
      const lane = (kind, rows, title, help, icon) => `<section class="mmc-lane is-${kind}"><header><i>${icon}</i><span><b>${title}</b><small>${help}</small></span><em class="mmc-count">${rows.length}</em></header><div class="mmc-lane-list">${rows.length ? rows.map(anchorRow).join("") : `<div class="mmc-empty">${kind === "always" ? "항상 기억할 앵커가 없어요." : "키워드로 떠오를 앵커가 없어요."}</div>`}</div></section>`;
      return `<div data-mmc-summary-alert-slot>${statusBanners()}</div>
      ${anchorBudgetPanel()}
      <div class="mmc-toolbar">${filterBar(count)}${mainActions()}</div>
      <div class="mmc-lanes">
        ${lane("always", always, "항상 기억", "예산 안에서 매 턴 들어가요 · 중요도·최근 수정 순", SVG.pin)}
        ${lane("keyword", keyword, "키워드로 떠오름", "대화에 키워드가 나올 때만 들어가요", SVG.search)}
      </div>`;
    }
    function filterBar(count = null) {
      const options = state.activeTab === "promise" ? [["active", "진행 중"], ["hold", "보류"], ["done", "완료"], ["all", "전체"]] : [["active", "사용 중"], ["archived", "보관됨"], ["all", "전체"]];
      return `<div class="mmc-seg" role="tablist">${options.map(([id, label]) => `<button class="mmc-filter ${state.filter === id ? "is-active" : ""}" data-action="set-filter" data-filter="${id}">${label}${count ? ` <i>${count(id)}</i>` : ""}</button>`).join("")}</div>`;
    }
    function anchorBudgetPanel() {
      const plan = anchorInjectionPlan();
      const keywordCount = activeKeywordAnchors().length;
      const pct = Math.min(100, Math.round(plan.used / Math.max(1, plan.budget) * 100));
      const over = plan.excluded.length > 0;
      return `<section class="mmc-card mmc-budget ${over ? "is-over" : ""}">
      <div class="mmc-budget-head"><div><b>작업기억 예산</b><small>항상 기억 ${plan.used.toLocaleString()} / ${plan.budget.toLocaleString()}자 · 실제 주입 ${plan.selected.length}/${plan.candidates.length}개${keywordCount ? ` · 키워드 ${keywordCount}개 별도` : ""}</small></div><strong>${pct}%</strong><button class="mmc-btn mmc-sm" data-action="health-check">${SVG.spark}<span>기억 건강검진</span></button></div>
      <div class="mmc-budget-track"><i style="width:${pct}%"></i></div>
      ${over ? `<small class="mmc-budget-warning">상한 또는 예산 때문에 ${plan.excluded.length}개가 상시 주입에서 대기 중이에요. 지워지지는 않고, 중요도·최근 수정 순서로 주입할 기억을 고릅니다.</small>` : ""}
    </section>`;
    }
    function mainActions() {
      if (state.activeTab === "promise")
        return `<div class="mmc-actions">
      <button class="mmc-btn mmc-primary" data-action="new-item" data-type="promise">${SVG.plus}<span>직접 추가</span></button>
      <button class="mmc-btn" data-action="open-source" data-source="messages" data-target="promise">${SVG.message}<span>대화에서 가져오기</span></button>
    </div>`;
      return `<div class="mmc-actions">
      <button class="mmc-btn mmc-primary" data-action="new-item" data-type="anchor">${SVG.plus}<span>직접 추가</span></button>
      <button class="mmc-btn" data-action="open-source" data-source="summaries" data-target="anchor">${SVG.summary}<span>요약에서</span></button>
      <button class="mmc-btn" data-action="open-source" data-source="messages" data-target="anchor">${SVG.message}<span>대화에서</span></button>
    </div>`;
    }
    function chatOptions() {
      return state.chats.map((chat) => `<option value="${esc(chat.id)}" ${chat.id === state.selectedChatId ? "selected" : ""}>${esc(chatSelectLabel(chat))}</option>`).join("");
    }
    function pendingSummaryBanner() {
      const count = state.pendingSummaryRows.length;
      const ready = state.reviewSourceRows.length > 0;
      if (ready) {
        return `<section class="mmc-summary-alert is-ready"><span class="mmc-alert-icon">${SVG.inbox}</span><div><b>모델 분석 완료 · 갱신 후보 ${state.reviewCandidates.length}개</b><small>아직 보관함에는 적용되지 않았어요. 결과를 확인한 뒤 골라서 적용하거나 검토 완료로 표시하세요.</small></div><div><button class="mmc-btn mmc-sm mmc-primary" data-action="open-review-draft">결과 확인</button></div></section>`;
      }
      if (!count)
        return "";
      const advanced = advancedMemoryEnabled();
      const modelButton = state.summaryUpdateMode === "notify_only" ? "" : `<button class="mmc-btn mmc-sm mmc-model-btn" data-action="review-model">${SVG.spark}<span>모델로 통합 정리</span></button>`;
      const modeText = advanced ? "고급 메모리 보호 모드 · 자동 처리 없이 수동 확인" : SUMMARY_UPDATE_MODE_LABEL[state.summaryUpdateMode] || "알림 + 모델 정리 버튼";
      const sceneCount = amRowsPending(state.pendingSummaryRows).length;
      const label = [count - sceneCount ? `새 요약 ${count - sceneCount}개` : "", sceneCount ? `새 장면 요약 ${sceneCount}개` : ""].filter(Boolean).join(" · ");
      return `<section class="mmc-summary-alert"><span class="mmc-alert-icon">${SVG.inbox}</span><div><b>${esc(label)} · 기억 갱신이 필요해요</b><small>${esc(modeText)} · 요약 내용은 아직 약속/앵커에 반영되지 않았어요.</small></div><div><button class="mmc-btn mmc-sm" data-action="review-pending">내용 확인</button>${modelButton}</div></section>`;
    }
    function autoUndoBanner() {
      const undo = state.currentData?.lastAutoReviewUndo;
      if (!undo)
        return "";
      const count = safeArray(undo.updated).length + safeArray(undo.created).length;
      return `<section class="mmc-summary-alert mmc-undo-alert"><span class="mmc-alert-icon">${SVG.warn}</span><div><b>직전 자동 적용 ${count}개를 되돌릴 수 있어요</b><small>자동 적용 뒤 직접 수정한 기록은 덮어쓰지 않고 건너뜁니다.</small></div><div><button class="mmc-btn mmc-sm" data-action="undo-auto-review">자동 적용 되돌리기</button></div></section>`;
    }
    function agentActivationFromMetadata(metadata, agentId) {
      const meta = parseRecord(metadata);
      if (meta.enableAgents !== true)
        return "off";
      const overrides = parseRecord(meta.agentOverrides);
      if (overrides[agentId] === false)
        return "off";
      const activeIds = safeArray(meta.activeAgentIds).map(String);
      if (activeIds.includes(agentId))
        return "on";
      if (activeIds.length > 0)
        return "off";
      return "global";
    }
    async function readGlobalAgentEnabled() {
      try {
        const rows = extractArray(await api("agents"), ["agents", "items", "results"]);
        const map = {};
        for (const row of rows) {
          const id = String(row?.id || row?.type || "");
          if (id)
            map[id] = row?.enabled === true;
        }
        return map;
      } catch {
        return null;
      }
    }
    async function refreshAgentNotice() {
      const metadata = parseRecord(state.currentChat?.metadata);
      const next = {
        checked: true,
        memoryNag: agentActivationFromMetadata(metadata, MEMORY_NAG_AGENT_ID),
        longTermMemory: agentActivationFromMetadata(metadata, LONG_TERM_MEMORY_AGENT_ID),
        lorebookKeeper: agentActivationFromMetadata(metadata, LOREBOOK_KEEPER_AGENT_ID),
        keeperTargetLorebookId: String(metadata.lorebookKeeperTargetLorebookId || "").trim(),
        keeperBook: null
      };
      const pairs = [["memoryNag", MEMORY_NAG_AGENT_ID], ["longTermMemory", LONG_TERM_MEMORY_AGENT_ID], ["lorebookKeeper", LOREBOOK_KEEPER_AGENT_ID]];
      if (pairs.some(([key]) => next[key] === "global")) {
        const global = await readGlobalAgentEnabled();
        for (const [key, agentId] of pairs) {
          if (next[key] !== "global")
            continue;
          next[key] = global ? global[agentId] === true ? "on-global" : "off" : "unknown";
        }
      }
      if (next.lorebookKeeper === "on" || next.lorebookKeeper === "on-global")
        next.keeperBook = await readKeeperBookStatus();
      state.agentNotice = next;
    }
    function agentNoticeRows() {
      const notice = state.agentNotice || {};
      const rows = [];
      const active = (value) => value === "on" || value === "on-global";
      if (active(notice.memoryNag)) {
        rows.push({
          id: MEMORY_NAG_AGENT_ID,
          name: "Memory Nag",
          scope: notice.memoryNag === "on" ? "이 RP에서 켜져 있습니다" : "전역 설정으로 켜져 있을 수 있습니다",
          body: "Memory Nag도 RP별 기억 보관소를 따로 만들고 회수합니다. 기억 보관함의 약속·기억 앵커와 역할이 겹쳐 같은 사실이 두 번 주입될 수 있습니다. 둘 중 하나만 쓰는 편을 권합니다.",
          how: "Marinara의 채팅 설정 → Agents에서 직접 끌 수 있습니다. 기억 보관함은 Agent를 임의로 끄지 않습니다."
        });
      }
      if (active(notice.longTermMemory)) {
        rows.push({
          id: LONG_TERM_MEMORY_AGENT_ID,
          name: "Long-Term Memory",
          scope: notice.longTermMemory === "on" ? "이 RP에서 켜져 있습니다" : "전역 설정으로 켜져 있을 수 있습니다",
          body: "Long-Term Memory는 요약·캐릭터 기록·로어북에서 기억을 따로 추출해 회수합니다. 기억 보관함이 관리하는 전용 로어북까지 소스로 삼으면 같은 내용이 중복 추출·주입될 수 있습니다.",
          how: `Long-Term Memory 설정의 소스 목록에서 '${managedBookLabel()}' 로어북을 제외하면 중복을 줄일 수 있습니다. 기억 보관함은 그 설정을 대신 바꾸지 않습니다.`
        });
      }
      if (active(notice.lorebookKeeper)) {
        const bookId = String(state.currentData?.lorebookId || "");
        const target = String(notice.keeperTargetLorebookId || "");
        if (!target || bookId && target === bookId) {
          rows.push({
            id: `${LOREBOOK_KEEPER_AGENT_ID}:${target || "none"}`,
            name: "Lorebook Keeper",
            scope: target ? "대상 로어북이 보관함 책으로 지정되어 있습니다" : `${notice.lorebookKeeper === "on" ? "이 RP에서 켜져 있고" : "전역 설정으로 켜져 있을 수 있고"} 대상 로어북이 비어 있습니다`,
            body: keeperNoticeBody(notice.keeperBook),
            how: "채팅 설정 → Lorebook Keeper의 대상 로어북을 다른 책으로 지정하세요. 기억 보관함은 이 설정을 대신 바꾸지 않습니다."
          });
        }
      }
      return rows.filter((row) => state.agentNoticeDismissed?.[row.id] !== true);
    }
    function managedBookLabel() {
      return `기억 보관함 · ${chatLabel(state.currentChat)}`;
    }
    function keeperNoticeBody(book) {
      const info = parseRecord(book);
      const unlocked = Number(info.unlocked) || 0;
      const foreign = Number(info.foreign) || 0;
      const lines = [unlocked ? `이 상태에서는 Keeper가 '${managedBookLabel()}' 책에 새 항목을 쓸 수 있습니다. 아직 잠기지 않은 보관함 항목이 ${unlocked}개 있어요. 머리줄의 로어북 동기화를 한 번 눌러 잠가 주세요. 그 전에는 Keeper가 이 항목을 덮어쓸 수 있습니다.` : `이 상태에서는 Keeper가 '${managedBookLabel()}' 책에 새 항목을 쓸 수 있습니다. 보관함 항목은 잠겨 있어 덮어쓰이지 않지만, Keeper가 만든 항목이 보관함 책에 섞여 쌓이고 백업·분기 처리에서 빠집니다.`];
      if (foreign)
        lines.push(`지금 이 책에 보관함이 만들지 않은 항목이 ${foreign}개 있어요. 보관함은 이 항목을 지우거나 고치지 않습니다.`);
      return lines.join(" ");
    }
    async function readKeeperBookStatus() {
      const bookId = String(state.currentData?.lorebookId || "");
      if (!bookId)
        return null;
      try {
        const rows = extractArray(await api(`lorebooks/${encodeURIComponent(bookId)}/entries`), ["entries", "items", "results"]);
        const managed = (entry) => String(entry?.tag || "").startsWith("memory-cabinet-");
        return { unlocked: rows.filter((entry) => managed(entry) && entry.locked !== true && entry.locked !== "true").length, foreign: rows.filter((entry) => !managed(entry)).length };
      } catch {
        return null;
      }
    }
    function agentNoticeBanner() {
      const rows = agentNoticeRows();
      if (!rows.length)
        return "";
      return rows.map((row) => `<section class="mmc-agent-note">
      <span class="mmc-alert-icon">${SVG.warn}</span>
      <div class="mmc-agent-note-copy"><div class="mmc-agent-note-head"><b>${esc(row.name)} 사용 중</b><span>${esc(row.scope)}</span></div>
      <p>${esc(row.body)}</p>
      <small>${esc(row.how)}</small></div>
      <button class="mmc-btn mmc-sm mmc-ghost" data-action="dismiss-agent-note" data-id="${esc(row.id)}" title="이 안내 숨기기">숨기기</button>
    </section>`).join("");
    }
    function advancedMemorySettingsCap() {
      const fromStatus = Number(parseRecord(state.sceneSettings).maxContextTokens);
      const fromMeta = Number(parseRecord(parseRecord(state.currentChat?.metadata).advancedMemory).maxContextTokens);
      const value = Number.isFinite(fromStatus) && fromStatus > 0 ? fromStatus : Number.isFinite(fromMeta) && fromMeta > 0 ? fromMeta : 0;
      return value;
    }
    function advancedMemoryBanner() {
      if (!advancedMemoryEnabled())
        return "";
      const info = injectionSummary();
      const cap = advancedMemorySettingsCap();
      const share = cap ? ` · 고급 메모리 문맥 상한 ${cap.toLocaleString()} 중 약 ${Math.max(1, Math.round(info.total / cap * 1000) / 10)}%` : "";
      const scenes = state.amSceneError ? "장면 요약을 읽지 못해 장면 후보는 쉬고 있어요." : `완료된 장면 요약 ${state.amSceneRows.length}개를 약속·앵커 후보 소스로 읽을 수 있어요(읽기만 해요).`;
      return `<section class="mmc-advanced-memory-note"><span class="mmc-alert-icon">${SVG.info}</span><div><b>고급 메모리 사용 중</b><small>순정 자동 요약 대신 고급 메모리가 문맥을 관리합니다. ${esc(scenes)}</small><small>보관함이 매 턴 넣는 기억 약 ${info.total.toLocaleString()} tokens${esc(share)}는 고급 메모리가 살려 둘 최근 대화·회수 장면 예산에서 먼저 빠집니다. 고급 메모리와 순정 Memory Recall은 함께 켜지지 않으며, 보관함은 둘의 설정을 바꾸지 않아요.</small></div></section>`;
    }
    function restrictedModeBanner() {
      const data = state.currentData;
      if (!data || restrictionEffective())
        return "";
      const held = safeArray(data.items).filter((item) => isRestrictedItem(item) && (item.type === "promise" ? item.status === "active" : item.active && !item.archived)).length;
      if (!held)
        return "";
      return `<section class="mmc-advanced-memory-note is-warn"><span class="mmc-alert-icon">${SVG.lock}</span><div><b>일부 인물만 아는 기억 ${held}개를 넣지 않고 있어요</b><small>이 그룹은 병합(Merged) 응답이라 모든 인물이 한 프롬프트를 함께 봅니다. 인물별로 가려 넣을 수 없어 비밀이 새지 않게 주입을 멈췄어요. 그룹 응답 방식을 개별(Individual)로 바꾸면 해당 인물에게만 들어갑니다.</small></div></section>`;
    }
    function statusBanners() {
      if (state.activeTab === "overview")
        return `${advancedMemoryBanner()}${restrictedModeBanner()}${agentNoticeBanner()}`;
      return `${pendingSummaryBanner()}${autoUndoBanner()}`;
    }
    function ownershipGuardView() {
      const ownership = state.ownership || {};
      const backup = ownership.backup;
      const raw = parseRecord(state.quarantinedData);
      const itemCount = safeArray(raw.items).length;
      const elementCount = safeArray(parseRecord(raw.elementMemory).entities).length;
      const claimed = ownership.ownerChatId ? `<code>${esc(ownership.ownerChatId)}</code>` : "확인 불가";
      const recoveryButton = backup ? `<button class="mmc-btn mmc-primary" data-action="restore-memory-backup">기억 복구</button>` : "";
      const confirmButton = state.quarantinedData ? `<button class="mmc-btn" data-action="confirm-quarantined-memory">격리 데이터를 이 RP용으로 확정</button>` : "";
      return `<section class="mmc-ownership-guard"><span class="mmc-kicker">MEMORY OWNERSHIP GUARD</span><h2>${ownership.status === "recovery" ? "복구 가능한 기억을 찾았습니다" : "다른 RP 기억을 격리했습니다"}</h2><p>${esc(ownership.reason || "기억 소유권을 확인해야 합니다.")}</p><dl><div><dt>표시된 소유 RP</dt><dd>${claimed}</dd></div><div><dt>판정 근거</dt><dd>${esc(ownership.evidence || "없음")}</dd></div>${state.quarantinedData ? `<div><dt>격리 내용</dt><dd>약속·앵커 ${itemCount}개 · 요소 ${elementCount}개</dd></div>` : ""}${backup ? `<div><dt>복구 백업</dt><dd>${esc(sourceDate(backup.savedAt) || backup.savedAt || "저장 시각 없음")}</dd></div>` : ""}</dl><div class="mmc-setting-warning"><b>보호 모드</b><small>확인 전에는 이 데이터를 자동 로드·주입·로어북 동기화하지 않습니다. 원본 격리 데이터와 일치하는 로어북 백업도 자동으로 덮어쓰지 않습니다.</small></div><div class="mmc-ownership-actions">${recoveryButton}${confirmButton}</div></section>`;
    }
    function mainView() {
      if (!state.currentChat || !state.currentData)
        return `<div class="mmc-empty mmc-empty-large">RP방을 찾지 못했습니다. 새로고침 후 다시 열어 주세요.</div>`;
      if (!ownershipAllowsData())
        return ownershipGuardView();
      if (state.activeTab === "overview")
        return overviewView();
      if (state.activeTab === "element")
        return `<div data-mmc-summary-alert-slot>${statusBanners()}</div>${elementMainView()}`;
      if (state.activeTab === "wiki")
        return `<div data-mmc-summary-alert-slot>${statusBanners()}</div>${wikiMainView()}`;
      if (state.activeTab === "anchor")
        return anchorView();
      if (state.activeTab === "episode")
        return episodeView();
      if (state.activeTab === "thread")
        return threadView();
      return promiseView();
    }
    function syncChip() {
      const data = state.currentData;
      if (!data)
        return "";
      const error = data.lastSyncError;
      const label = !ownershipAllowsData() ? "소유권 확인 필요" : error ? "동기화 확인 필요" : data.lastSyncAt ? `로어북 동기화됨 · ${relTime(data.lastSyncAt)}` : "로어북 동기화";
      return `<button class="mmc-sync ${error || !ownershipAllowsData() ? "is-bad" : data.lastSyncAt ? "is-ok" : ""}" data-action="sync" title="${esc(error || "전용 로어북 다시 동기화")}"><i class="mmc-sync-dot"></i><span>${esc(label)}</span>${SVG.sync}</button>`;
    }
    function shellMarkup() {
      const counts = tabCounts();
      const tabs = tabMeta().map((tab) => {
        const on = state.activeTab === tab.id;
        const badge = tab.id === "overview" ? inboxRows().length ? '<i class="mmc-tab-dot"></i>' : "" : `<em>${counts[tab.id]}</em>`;
        return `<button class="mmc-tab ${on ? "is-active" : ""}" data-action="tab" data-tab="${tab.id}" ${on ? 'aria-current="page"' : ""}>${tab.icon}<span class="mmc-tab-long">${tab.label}</span><span class="mmc-tab-short">${tab.short}</span>${badge}</button>`;
      }).join("");
      return `<div class="mmc-overlay" data-action="overlay-close">
      <section class="mmc-shell" role="dialog" aria-modal="true" aria-label="기억 보관함" data-tab="${esc(state.activeTab)}">
        <header class="mmc-bar">
          <div class="mmc-brand"><span class="mmc-brand-mark">${SVG.memory}</span><span class="mmc-brand-text"><b>기억 보관함</b><small>MEMORY VAULT · v${VERSION}</small></span></div>
          <label class="mmc-story"><span class="mmc-story-icon">${SVG.book}</span><span class="mmc-story-copy"><small>현재 이야기</small><select id="mmc-chat-select" aria-label="현재 이야기">${chatOptions()}</select></span></label>
          <span class="mmc-bar-spacer"></span>
          ${syncChip()}
          <div class="mmc-head-actions">
            <button class="mmc-icon-btn" data-action="help" title="사용법" aria-label="사용법">${SVG.help}</button>
            <button class="mmc-icon-btn" data-action="settings" title="설정" aria-label="설정">${SVG.gear}</button>
            <button class="mmc-icon-btn" data-action="close" title="닫기" aria-label="닫기">${SVG.close}</button>
          </div>
        </header>
        <nav class="mmc-tabs" aria-label="기억 종류">${tabs}</nav>
        <main class="mmc-body">${mainView()}</main>
        ${state.layer ? layerMarkup() : ""}
        ${state.busy ? busyMarkup() : ""}
      </section>
    </div>`;
    }
    const EPISODE_LIMIT = 600;
    const EPISODE_ENTRY_TAG = "memory-cabinet-episode";
    const EPISODE_MARKER = "§MEMORY_CABINET_EPISODE_V1§";
    const FACT_STATUS_LABEL = { current: "현재", superseded: "지난 사실", uncertain: "불확실" };
    const EPISODE_CONTRACT = [
      "Structured scene records (fixed by the extension):",
      '- In the same JSON array you may add up to 3 objects with kind="episode" (they have no type/action field), one per distinct scene in the source. Skip a scene already listed in RECENT EPISODES unless the source clearly changed it.',
      '- Shape: {"kind":"episode","title":"...","keywords":["0-6 distinctive words that would bring this scene back"],"background":{"date":"in-story date or empty","timeOfDay":"...","place":"..."},"event":{"summary":"what happened","participants":["names"],"keyActions":["key actions or short quoted lines"],"knownBy":["names"]|["all"]},"facts":[{"text":"a fact that follows from the scene","knownBy":["names"]|["all"],"status":"current|superseded|uncertain"}],"characters":[{"name":"...","actions":"...","relationChange":"...","attitudeChange":"..."}]}',
      "- Keep who-knows-what: event.knownBy is who witnessed or learned of the scene; each fact has its own knownBy. Never mark a restricted fact as all.",
      "- Do not copy promises or anchors into facts. Write in the source language."
    ].join(`
`);
    function normalizeEpisodeFact(value = {}) {
      const raw = isRecord(value) ? value : { text: String(value || "") };
      const text = String(raw.text || "").trim().slice(0, 300);
      if (!text)
        return null;
      return { id: String(raw.id || uid("epf")), text, status: Object.prototype.hasOwnProperty.call(FACT_STATUS_LABEL, raw.status) ? raw.status : "current", ...normalizeKnownBy(raw.knownBy).length ? { knownBy: normalizeKnownBy(raw.knownBy) } : {} };
    }
    function normalizeEpisodeCharacter(value = {}) {
      const raw = parseRecord(value);
      const name = String(raw.name || "").trim().slice(0, 80);
      if (!name)
        return null;
      return { name, actions: String(raw.actions || "").trim().slice(0, 240), relationChange: String(raw.relationChange || "").trim().slice(0, 240), attitudeChange: String(raw.attitudeChange || "").trim().slice(0, 240) };
    }
    function normalizeEpisode(value = {}) {
      const raw = parseRecord(value);
      const title = String(raw.title || "").trim().replace(/\s+/g, " ").slice(0, 120);
      if (!title)
        return null;
      const bg = parseRecord(raw.background);
      const ev = parseRecord(raw.event);
      return {
        id: String(raw.id || uid("ep")),
        title,
        keywords: normalizeTextList(raw.keywords, 8, 60),
        background: { date: String(bg.date || "").trim().slice(0, 80), timeOfDay: String(bg.timeOfDay || "").trim().slice(0, 40), place: String(bg.place || "").trim().slice(0, 120) },
        event: { summary: String(ev.summary || "").trim().slice(0, 800), participants: normalizeTextList(ev.participants, 12, 80), keyActions: normalizeTextList(ev.keyActions, 8, 240), ...normalizeKnownBy(ev.knownBy).length ? { knownBy: normalizeKnownBy(ev.knownBy) } : {} },
        facts: safeArray(raw.facts).map(normalizeEpisodeFact).filter(Boolean).slice(0, 16),
        characters: safeArray(raw.characters).map(normalizeEpisodeCharacter).filter(Boolean).slice(0, 10),
        sourceIds: normalizeTextList(raw.sourceIds, 24, 160),
        ...Object.keys(normalizeSourceFingerprints(raw.sourceFingerprints)).length ? { sourceFingerprints: normalizeSourceFingerprints(raw.sourceFingerprints) } : {},
        at: String(raw.at || ""),
        msgIndex: Number(raw.msgIndex) || 0,
        ...raw.replacedBy ? { replacedBy: String(raw.replacedBy) } : {},
        ...raw.sourceCandidateId ? { sourceCandidateId: String(raw.sourceCandidateId) } : {},
        createdAt: String(raw.createdAt || nowIso()),
        updatedAt: String(raw.updatedAt || raw.createdAt || nowIso())
      };
    }
    function episodeList(data = state.currentData) {
      return safeArray(parseRecord(data).episodes).map(normalizeEpisode).filter(Boolean);
    }
    function liveEpisodes(data = state.currentData) {
      return episodeList(data).filter((ep) => !ep.replacedBy);
    }
    function episodeInjectionOn(data) {
      return parseRecord(data).episodeInjection !== false;
    }
    function episodeTimeLine(ep) {
      return [ep.background.date, ep.background.timeOfDay, ep.background.place].filter(Boolean).join(" · ");
    }
    function episodeScopeOf(obj, stored) {
      if (stored)
        return { knownByIds: normalizeKnownBy(obj.knownByIds), scopeConfirmed: obj.scopeConfirmed === true };
      const rawList = Array.isArray(obj.knownBy) ? obj.knownBy : typeof obj.knownBy === "string" && obj.knownBy.trim() ? [obj.knownBy] : [];
      const resolved = resolveCharacterRefs(rawList.filter((v) => String(v).trim().toLocaleLowerCase() !== "all"));
      return { knownByIds: resolved.ids, scopeConfirmed: false };
    }
    function normalizeEpisodeCandidate(row) {
      if (!isRecord(row))
        return null;
      const stored = row.__episodeCandidate === true;
      const base = normalizeEpisode({ ...row, event: { ...parseRecord(row.event), summary: parseRecord(row.event).summary || row.summary }, facts: safeArray(row.facts).map((f) => isRecord(f) ? { ...f, knownBy: [] } : f) });
      if (!base)
        return null;
      const ev = parseRecord(row.event);
      const rawFacts = safeArray(row.facts).map((f) => isRecord(f) ? f : { text: String(f || "") }).filter((f) => String(f.text || "").trim()).slice(0, 16);
      return {
        __episodeCandidate: true,
        candidateId: String(row.candidateId || uid("epc")),
        title: base.title,
        keywords: base.keywords,
        background: base.background,
        characters: base.characters,
        event: { summary: base.event.summary, participants: base.event.participants, keyActions: base.event.keyActions, ...episodeScopeOf(ev, stored) },
        facts: rawFacts.map((f, i) => ({ id: String(f.id || base.facts[i]?.id || uid("epf")), text: String(f.text).trim().slice(0, 300), status: Object.prototype.hasOwnProperty.call(FACT_STATUS_LABEL, f.status) ? f.status : "current", ...episodeScopeOf(f, stored) })),
        scopeNeedsReview: row.scopeNeedsReview === true,
        replacesEpisodeIds: normalizeTextList(row.replacesEpisodeIds, 12, 80),
        duplicateOfEpisode: String(row.duplicateOfEpisode || "")
      };
    }
    function episodeScopeBlocks(cand) {
      if (!cand?.scopeNeedsReview)
        return false;
      return [cand.event, ...safeArray(cand.facts)].some((part) => part && !normalizeKnownBy(part.knownByIds).length && part.scopeConfirmed !== true);
    }
    function batchSourceTime(rows) {
      let best = "";
      for (const row of safeArray(rows)) {
        const t = String(row?.updatedAt || row?.createdAt || "");
        if (t && t > best)
          best = t;
      }
      return best;
    }
    function relateEpisodeCandidates(cands, batchFps) {
      const keys = Object.keys(batchFps);
      const existing = liveEpisodes();
      for (const cand of cands) {
        const same = [];
        const changed = [];
        for (const ep of existing) {
          const fps = normalizeSourceFingerprints(ep.sourceFingerprints);
          const overlap = keys.filter((key) => (key in fps));
          if (!overlap.length)
            continue;
          if (overlap.every((key) => fps[key] === batchFps[key]))
            same.push(ep);
          else
            changed.push(ep);
        }
        const titleSame = same.find((ep) => titleKey(ep.title) === titleKey(cand.title));
        if (titleSame || same.length && keys.length === 1 && !changed.length)
          cand.duplicateOfEpisode = (titleSame || same[0]).id;
        if (changed.length)
          cand.replacesEpisodeIds = changed.map((ep) => ep.id);
      }
    }
    function extractEpisodeCandidates(rawRows, sourceRows, mode) {
      const cands = safeArray(rawRows).filter((row) => isRecord(row) && (row.kind === "episode" || row.type === "episode")).map(normalizeEpisodeCandidate).filter(Boolean).slice(0, 6);
      if (mode === "summaries" && batchHasRestricted(sourceRows))
        cands.forEach((cand) => {
          cand.scopeNeedsReview = true;
        });
      relateEpisodeCandidates(cands, sourceFingerprintsForRows(sourceRows, mode));
      return cands;
    }
    function preselectEpisodes(cands) {
      return new Set(cands.map((cand, i) => episodeScopeBlocks(cand) || cand.duplicateOfEpisode ? null : String(i)).filter(Boolean));
    }
    function recentEpisodesForPrompt() {
      const rows = liveEpisodes().slice(-8).map((ep) => `- ${ep.title}${episodeTimeLine(ep) ? ` (${episodeTimeLine(ep)})` : ""}`);
      return rows.length ? `

[RECENT EPISODES — already recorded]
${rows.join(`
`)}
[/RECENT EPISODES]` : "";
    }
    function applyEpisodeCandidates(data, cands, selected, { fps = {}, sourceIds = [], rows = [] } = {}) {
      const out = { applied: 0, held: [], capped: 0, createdIds: [] };
      const list = safeArray(data.episodes).map(normalizeEpisode).filter(Boolean);
      const at = batchSourceTime(rows);
      const msgIndex = Math.max(0, ...safeArray(rows).map((row) => Number(row?.endIndex) || 0));
      const now = nowIso();
      cands.forEach((cand, i) => {
        if (!selected.has(String(i)))
          return;
        if (episodeScopeBlocks(cand)) {
          out.held.push(i);
          return;
        }
        if (list.some((ep) => ep.sourceCandidateId === cand.candidateId)) {
          out.applied += 1;
          return;
        }
        if (list.filter((ep) => !ep.replacedBy).length >= EPISODE_LIMIT) {
          out.capped += 1;
          out.held.push(i);
          return;
        }
        const episode = normalizeEpisode({
          id: uid("ep"),
          title: cand.title,
          keywords: cand.keywords,
          background: cand.background,
          characters: cand.characters,
          event: { summary: cand.event.summary, participants: cand.event.participants, keyActions: cand.event.keyActions, knownBy: cand.event.knownByIds },
          facts: cand.facts.map((f) => ({ id: f.id, text: f.text, status: f.status, knownBy: f.knownByIds })),
          sourceIds,
          sourceFingerprints: fps,
          at,
          msgIndex,
          sourceCandidateId: cand.candidateId,
          createdAt: now,
          updatedAt: now
        });
        for (const old of list)
          if (cand.replacesEpisodeIds.includes(old.id) && !old.replacedBy) {
            old.replacedBy = episode.id;
            old.updatedAt = now;
          }
        list.push(episode);
        out.createdIds.push(episode.id);
        out.applied += 1;
      });
      data.episodes = list;
      return out;
    }
    function factCoveredByItems(text, data) {
      const key = titleKey(text);
      if (key.length < 6)
        return false;
      return safeArray(data.items).some((item) => injectableItem(item) && titleKey(`${item.title}${item.content}`).includes(key));
    }
    function episodeEntryPlans(chat, data) {
      const plans = [];
      if (!episodeInjectionOn(data))
        return plans;
      const effective = restrictionEffective(chat);
      for (const ep of liveEpisodes(data)) {
        const keys = normalizeTextList([...ep.keywords, ep.background.place], 8, 60).filter((key) => key.length >= 2);
        if (!keys.length)
          continue;
        const eventScope = normalizeKnownBy(ep.event.knownBy);
        const current = ep.facts.filter((fact) => fact.status === "current" && !factCoveredByItems(fact.text, data));
        const groups = new Map;
        const publicFacts = [];
        for (const fact of current) {
          const scope = normalizeKnownBy(fact.knownBy);
          if (!scope.length) {
            publicFacts.push(fact);
            continue;
          }
          const key = scope.slice().sort().join(",");
          if (!groups.has(key))
            groups.set(key, { scope, facts: [] });
          groups.get(key).facts.push(fact);
        }
        const head = `[장면 기억 · ${truncate(ep.title, 80)}]${episodeTimeLine(ep) ? ` ${episodeTimeLine(ep)}` : ""}`;
        const mainLines = [EPISODE_MARKER, head];
        if (ep.event.summary)
          mainLines.push(`- 있었던 일: ${truncate(ep.event.summary, 260)}`);
        for (const fact of publicFacts.slice(0, 6))
          mainLines.push(`- 지금도 유효한 사실: ${truncate(fact.text, 200)}`);
        if (eventScope.length)
          mainLines.splice(2, 0, `이 장면은 ${knownByLabel(eventScope)}만 알고 있다. 모르는 인물이 알고 있는 것처럼 굴게 하지 마라.`);
        mainLines.push("이미 일어난 일이다. 관련될 때만 자연스럽게 반영하고 목록을 낭독하지 마라.");
        plans.push({ episodeId: ep.id, scopeKey: "main", keys, scope: eventScope, content: mainLines.join(`
`), enabled: !eventScope.length || effective, title: ep.title });
        for (const [key, group] of groups) {
          const scope = eventScope.length ? group.scope.filter((id) => eventScope.includes(id)) : group.scope;
          if (!scope.length)
            continue;
          plans.push({
            episodeId: ep.id,
            scopeKey: key,
            keys,
            scope,
            title: ep.title,
            enabled: effective,
            content: [EPISODE_MARKER, head, `아래 사실은 ${knownByLabel(scope)}만 알고 있다. 모르는 인물이 알고 있는 것처럼 굴게 하지 마라.`, ...group.facts.slice(0, 6).map((fact) => `- ${truncate(fact.text, 200)}`)].join(`
`)
          });
        }
      }
      return plans;
    }
    function episodeEntryPayload(chat, plan, dataEnabled) {
      return {
        name: `장면 기억 · ${truncate(plan.title, 100)}${plan.scopeKey === "main" ? "" : " · 일부만 앎"}`,
        content: plan.content,
        description: `기억 보관함 장면 기억 · episode:${plan.episodeId}`,
        keys: plan.keys,
        secondaryKeys: [],
        enabled: dataEnabled && plan.enabled,
        constant: false,
        selective: false,
        probability: null,
        scanDepth: null,
        matchWholeWords: false,
        caseSensitive: false,
        useRegex: false,
        position: 0,
        depth: 4,
        order: 47,
        role: "system",
        preventRecursion: true,
        excludeRecursion: false,
        delayUntilRecursion: false,
        excludeFromVectorization: true,
        tag: EPISODE_ENTRY_TAG,
        dynamicState: { memoryCabinetChatId: String(chat.id), memoryCabinetEpisodeId: plan.episodeId, memoryCabinetScope: plan.scopeKey, managedBy: LOREBOOK_TAG, kind: "episode" },
        ...plan.scope.length ? { characterFilterMode: "include", characterFilterIds: plan.scope } : { characterFilterMode: "any", characterFilterIds: [] }
      };
    }
    async function syncEpisodeEntries(book, rows, chat, data) {
      const existing = rows.filter((entry) => entry?.tag === EPISODE_ENTRY_TAG);
      const known = parseRecord(data.episodeEntryIds);
      const next = {};
      for (const plan of episodeEntryPlans(chat, data)) {
        const mapKey = `${plan.episodeId}|${plan.scopeKey}`;
        next[mapKey] = await upsertEntry(book.id, rows, String(known[mapKey] || ""), (entry) => {
          const ds = parseRecord(entry?.dynamicState);
          return entry?.tag === EPISODE_ENTRY_TAG && String(ds.memoryCabinetEpisodeId || "") === plan.episodeId && String(ds.memoryCabinetScope || "") === plan.scopeKey;
        }, episodeEntryPayload(chat, plan, data.enabled));
      }
      const active = new Set(Object.values(next).map(String));
      for (const entry of existing) {
        if (!entry?.id || active.has(String(entry.id)))
          continue;
        try {
          await api(`lorebooks/${encodeURIComponent(book.id)}/entries/${encodeURIComponent(entry.id)}`, { method: "PATCH", body: { enabled: false } });
        } catch {}
      }
      if (Object.keys(next).length || Object.keys(known).length)
        data.episodeEntryIds = next;
    }
    function factStatusChip(fact) {
      return `<span class="mmc-chip ${fact.status === "current" ? "is-ok" : fact.status === "uncertain" ? "is-warn" : "is-soft"}">${esc(FACT_STATUS_LABEL[fact.status] || fact.status)}</span>`;
    }
    function scopeLabelChip(ids) {
      const list = normalizeKnownBy(ids);
      return list.length ? `<span class="mmc-chip is-soft">아는 인물 · ${esc(truncate(knownByLabel(list), 24))}${restrictionEffective() ? "" : " · 대기"}</span>` : "";
    }
    function episodeCard(ep) {
      const timeLine = episodeTimeLine(ep);
      return `<article class="mmc-card mmc-episode ${ep.replacedBy ? "is-replaced" : ""}" data-episode-id="${esc(ep.id)}">
      <header class="mmc-episode-head"><div><b>${esc(ep.title)}</b>${timeLine ? `<small>${esc(timeLine)}</small>` : ""}</div><span class="mmc-chips">${ep.replacedBy ? '<span class="mmc-chip is-soft">지난 판</span>' : ""}${scopeLabelChip(ep.event.knownBy)}</span><button class="mmc-btn mmc-sm" data-action="edit-episode" data-id="${esc(ep.id)}">${SVG.edit}<span>편집</span></button></header>
      <dl class="mmc-episode-grid">
        ${ep.event.summary ? `<div><dt>사건</dt><dd>${esc(ep.event.summary)}${ep.event.participants.length ? `<small>참여 · ${esc(ep.event.participants.join(", "))}</small>` : ""}${ep.event.keyActions.length ? `<ul>${ep.event.keyActions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>` : ""}</dd></div>` : ""}
        ${ep.facts.length ? `<div><dt>사실</dt><dd><ul class="mmc-episode-facts">${ep.facts.map((fact) => `<li>${factStatusChip(fact)}${scopeLabelChip(fact.knownBy)}<span>${esc(fact.text)}</span></li>`).join("")}</ul></dd></div>` : ""}
        ${ep.characters.length ? `<div><dt>인물</dt><dd><ul class="mmc-episode-people">${ep.characters.map((c) => `<li><b>${esc(c.name)}</b>${[c.actions && `행동 · ${c.actions}`, c.relationChange && `관계 · ${c.relationChange}`, c.attitudeChange && `감정·태도 · ${c.attitudeChange}`].filter(Boolean).map((t) => `<small>${esc(t)}</small>`).join("")}</li>`).join("")}</ul></dd></div>` : ""}
      </dl>
      ${ep.keywords.length || ep.background.place ? `<span class="mmc-kw">${normalizeTextList([...ep.keywords, ep.background.place], 8, 60).map((k) => `<i>${esc(k)}</i>`).join("")}</span>` : ""}
    </article>`;
    }
    function episodeView() {
      const all = episodeList();
      const live = all.filter((ep) => !ep.replacedBy).sort((a, b) => String(b.at || b.createdAt).localeCompare(String(a.at || a.createdAt)));
      const old = all.filter((ep) => ep.replacedBy);
      const on = episodeInjectionOn(state.currentData);
      return `<div data-mmc-summary-alert-slot>${statusBanners()}</div>
      <div class="mmc-toolbar"><div class="mmc-episode-note"><b>장면 기억 ${live.length}개</b><small>${on ? "장소·키워드가 대화에 나올 때 '현재' 사실만 들어가요." : "주입 꺼짐 · 보관만 해요."} 새 요약·장면 검토와 원문 정리에서 함께 만들어져요.</small></div><div class="mmc-actions"><button class="mmc-btn mmc-primary" data-action="new-episode">${SVG.plus}<span>직접 추가</span></button><button class="mmc-btn" data-action="open-source" data-source="summaries" data-target="anchor">${SVG.summary}<span>요약·장면에서</span></button><button class="mmc-btn" data-action="open-source" data-source="messages" data-target="anchor">${SVG.message}<span>대화에서</span></button></div></div>
      <div class="mmc-episode-list">${live.length ? live.map(episodeCard).join("") : '<div class="mmc-empty">아직 장면 기억이 없어요. 새 요약이나 장면을 모델로 정리하면 함께 만들어져요.</div>'}</div>
      ${old.length ? `<details class="mmc-episode-old"><summary>지난 판 ${old.length}개 · 근거가 바뀌어 새로 정리되기 전 기록 (주입하지 않아요)</summary>${old.map(episodeCard).join("")}</details>` : ""}`;
    }
    function episodeCandidateCard(kind, cand, index, selected) {
      const checked = selected.has(String(index));
      const blocked = episodeScopeBlocks(cand);
      const dup = cand.duplicateOfEpisode ? episodeList().find((ep) => ep.id === cand.duplicateOfEpisode) : null;
      const replaced = cand.replacesEpisodeIds.length;
      const part = (sub, idx, obj) => scopeControl(`${kind}-ep-${sub}`, idx, obj.knownByIds, { needsReview: cand.scopeNeedsReview, confirmed: obj.scopeConfirmed });
      return `<div class="mmc-candidate mmc-episode-cand ${checked ? "is-selected" : ""}"><input type="checkbox" data-episode-kind="${kind}" data-episode-index="${index}" ${checked ? "checked" : ""}><span>
      <b>${esc(cand.title)}</b><small>${esc(episodeTimeLine({ background: cand.background }) || "배경 정보 없음")}</small>
      ${cand.event.summary ? `<p>${esc(cand.event.summary)}</p>` : ""}
      ${part("event", index, cand.event)}
      ${cand.facts.length ? `<ul class="mmc-episode-facts">${cand.facts.map((fact, j) => `<li>${factStatusChip(fact)}<span>${esc(fact.text)}</span>${part("fact", `${index}.${j}`, fact)}</li>`).join("")}</ul>` : ""}
      ${cand.characters.length ? `<small>인물 · ${esc(cand.characters.map((c) => [c.name, c.relationChange || c.attitudeChange].filter(Boolean).join(": ")).join(" / "))}</small>` : ""}
      ${dup ? `<small class="mmc-scope-warn">이미 같은 근거로 만든 장면 기억 '${esc(truncate(dup.title, 40))}'이 있어요. 중복이라 선택을 풀어 뒀어요.</small>` : ""}
      ${replaced ? `<small class="mmc-scope-note">근거가 바뀐 기존 장면 기억 ${replaced}개를 '지난 판'으로 돌리고 이 기록으로 바꿔요(지우지 않아요).</small>` : ""}
      ${blocked ? `<small class="mmc-scope-warn">사건과 사실마다 아는 인물을 고르거나 '모두에게 공개'를 눌러야 적용돼요.</small>` : ""}
      ${cand.scopeNeedsReview ? `<button type="button" class="mmc-btn mmc-sm mmc-ghost" data-action="episode-scope-public" data-episode-kind="${kind}" data-index="${index}">범위를 정하지 않은 부분은 모두에게 공개</button>` : ""}
    </span></div>`;
    }
    function episodeCandidateGroup(kind, cands, selected) {
      if (!cands.length)
        return "";
      return `<section class="mmc-candidate-group is-episode"><div class="mmc-candidate-group-head"><span class="mmc-type-chip">장면</span><div><b>장면 기억 후보 ${cands.length}개</b><small>배경·사건·사실(아는 인물)·인물 변화로 정리한 기록</small></div></div><div class="mmc-candidate-list">${cands.map((cand, i) => episodeCandidateCard(kind, cand, i, selected)).join("")}</div></section>`;
    }
    function episodeScopeTarget(kind, index) {
      const m = String(kind).match(/^(rev|cand)-ep-(event|fact)$/);
      if (!m)
        return null;
      const list = m[1] === "rev" ? state.reviewEpisodes : state.candEpisodes;
      if (m[2] === "event")
        return list[Number(index)]?.event || null;
      const [i, j] = String(index).split(".").map(Number);
      return list[i]?.facts?.[j] || null;
    }
    function episodeEditorLayer() {
      const d = normalizeEpisode(state.episodeDraft || { title: "새 장면" }) || normalizeEpisode({ title: "새 장면" });
      const many = state.chatCharacters.length >= 2;
      const factRow = (fact, j) => `<div class="mmc-episode-fact-edit" data-fact-row="${j}"><select id="mmc-ep-fact-status-${j}">${Object.entries(FACT_STATUS_LABEL).map(([id, label]) => `<option value="${id}" ${fact.status === id ? "selected" : ""}>${label}</option>`).join("")}</select><input id="mmc-ep-fact-text-${j}" value="${esc(fact.text)}" maxlength="300" placeholder="사실">${many || normalizeKnownBy(fact.knownBy).length ? scopeControl("epdraft-fact", j, fact.knownBy) : ""}</div>`;
      const facts = [...d.facts, ...Array.from({ length: Math.max(0, state.episodeDraftExtraFacts || 0) }, () => ({ text: "", status: "current" }))];
      return `<div class="mmc-layer-backdrop" data-action="close-layer"><section class="mmc-layer mmc-editor" data-layer-stop>
      <header><div><span class="mmc-kicker">SCENE MEMORY</span><h3>${state.episodeDraft?.id ? "장면 기억 편집" : "새 장면 기억"}</h3></div><button class="mmc-icon-btn" data-action="close-layer">${SVG.close}</button></header>
      <div class="mmc-layer-body">
        <label class="mmc-field"><span>제목</span><input id="mmc-ep-title" value="${esc(d.title)}" maxlength="120"></label>
        <div class="mmc-field-row"><label class="mmc-field"><span>날짜 <small>이야기 속</small></span><input id="mmc-ep-date" value="${esc(d.background.date)}" maxlength="80"></label><label class="mmc-field"><span>시간대</span><input id="mmc-ep-time" value="${esc(d.background.timeOfDay)}" maxlength="40"></label></div>
        <label class="mmc-field"><span>장소 <small>대화에 나오면 이 기억이 떠올라요</small></span><input id="mmc-ep-place" value="${esc(d.background.place)}" maxlength="120"></label>
        <label class="mmc-field"><span>사건 개요</span><textarea id="mmc-ep-summary" rows="3">${esc(d.event.summary)}</textarea></label>
        <div class="mmc-field-row"><label class="mmc-field"><span>참여 인물 <small>쉼표로 구분</small></span><input id="mmc-ep-participants" value="${esc(d.event.participants.join(", "))}"></label><label class="mmc-field"><span>떠오를 키워드 <small>쉼표로 구분</small></span><input id="mmc-ep-keywords" value="${esc(d.keywords.join(", "))}"></label></div>
        <label class="mmc-field"><span>핵심 행동·대사 <small>한 줄에 하나</small></span><textarea id="mmc-ep-actions" rows="3">${esc(d.event.keyActions.join(`
`))}</textarea></label>
        ${many || normalizeKnownBy(d.event.knownBy).length ? `<div class="mmc-field"><span>이 장면을 아는 인물 <small>비우면 모두</small></span>${scopeControl("epdraft-event", 0, d.event.knownBy)}</div>` : ""}
        <div class="mmc-field"><span>사실 <small>상태와 아는 인물을 함께 정해요 · 비운 줄은 지워져요</small></span>${facts.map(factRow).join("")}<button type="button" class="mmc-btn mmc-sm" data-action="episode-add-fact">${SVG.plus}<span>사실 추가</span></button></div>
        <label class="mmc-field"><span>인물 변화 <small>한 줄에 '이름 | 행동 | 관계 변화 | 감정·태도 변화'</small></span><textarea id="mmc-ep-people" rows="3">${esc(d.characters.map((c) => [c.name, c.actions, c.relationChange, c.attitudeChange].join(" | ")).join(`
`))}</textarea></label>
      </div>
      <footer>${state.episodeDraft?.id ? `<button class="mmc-btn mmc-danger" data-action="delete-episode" data-id="${esc(state.episodeDraft.id)}">${SVG.trash}<span>삭제</span></button>` : "<span></span>"}<div><button class="mmc-btn" data-action="close-layer">취소</button><button class="mmc-btn mmc-primary" data-action="save-episode">저장</button></div></footer>
    </section></div>`;
    }
    function captureEpisodeDraft() {
      const base = normalizeEpisode(state.episodeDraft || { title: "새 장면" }) || {};
      const val = (id) => String(document.getElementById(id)?.value || "").trim();
      const scopeIds = (kind, index) => Array.from(document.querySelectorAll(`[data-scope-kind="${kind}"][data-scope-index="${index}"]`)).filter((box) => box.checked).map((box) => String(box.dataset.scopeChar || ""));
      const hasScope = (kind, index) => !!document.querySelector(`[data-scope-kind="${kind}"][data-scope-index="${index}"]`);
      const factRows = Array.from(document.querySelectorAll("[data-fact-row]"));
      const facts = factRows.map((row) => {
        const j = row.dataset.factRow;
        const old = safeArray(base.facts)[Number(j)] || {};
        return { id: old.id, text: val(`mmc-ep-fact-text-${j}`), status: val(`mmc-ep-fact-status-${j}`) || "current", knownBy: hasScope("epdraft-fact", j) ? scopeIds("epdraft-fact", j) : old.knownBy };
      }).filter((fact) => fact.text);
      state.episodeDraft = {
        ...base,
        id: state.episodeDraft?.id || "",
        title: val("mmc-ep-title"),
        keywords: val("mmc-ep-keywords").split(/[,，]/).map((x) => x.trim()).filter(Boolean),
        background: { date: val("mmc-ep-date"), timeOfDay: val("mmc-ep-time"), place: val("mmc-ep-place") },
        event: { summary: val("mmc-ep-summary"), participants: val("mmc-ep-participants").split(/[,，]/).map((x) => x.trim()).filter(Boolean), keyActions: val("mmc-ep-actions").split(/\n/).map((x) => x.trim()).filter(Boolean), knownBy: hasScope("epdraft-event", 0) ? scopeIds("epdraft-event", 0) : base.event?.knownBy },
        facts,
        characters: val("mmc-ep-people").split(/\n/).map((line) => line.split("|").map((x) => x.trim())).filter((p) => p[0]).map(([name, actions = "", relationChange = "", attitudeChange = ""]) => ({ name, actions, relationChange, attitudeChange }))
      };
    }
    async function saveEpisodeDraft() {
      captureEpisodeDraft();
      const draft = state.episodeDraft;
      if (!String(draft?.title || "").trim())
        throw new Error("제목을 입력해 주세요.");
      const data = await freshOwnedData();
      const list = safeArray(data.episodes).map(normalizeEpisode).filter(Boolean);
      const now = nowIso();
      if (draft.id) {
        const idx = list.findIndex((ep) => ep.id === draft.id);
        if (idx < 0)
          throw new Error("수정할 장면 기억을 찾지 못했습니다.");
        list[idx] = normalizeEpisode({ ...list[idx], ...draft, id: list[idx].id, createdAt: list[idx].createdAt, updatedAt: now });
      } else {
        if (list.filter((ep) => !ep.replacedBy).length >= EPISODE_LIMIT)
          throw new Error(`장면 기억은 최대 ${EPISODE_LIMIT}개까지 보관해요. 오래된 기록을 정리한 뒤 추가해 주세요.`);
        list.push(normalizeEpisode({ ...draft, id: uid("ep"), at: now, createdAt: now, updatedAt: now }));
      }
      data.episodes = list;
      await persistData(data);
      state.episodeDraft = null;
      state.episodeDraftExtraFacts = 0;
      state.layer = null;
      render();
    }
    const THREAD_LIMIT = 200;
    const THREAD_ENTRY_TAG = "memory-cabinet-threads";
    const THREAD_RESTRICTED_TAG = "memory-cabinet-thread-restricted";
    const THREAD_MARKER = "§MEMORY_CABINET_THREADS_V1§";
    const THREAD_STATUS_LABEL = { open: "진행 중", hold: "보류", resolved: "해결", cancelled: "취소" };
    const THREAD_ACTION_LABEL = { add: "새 흐름", update: "상태 갱신", resolve: "해결", hold: "보류", cancel: "취소", reopen: "다시 열기" };
    const THREAD_CONTRACT = [
      "Ongoing threads (fixed by the extension):",
      '- In the same JSON array you may add objects with kind="thread" for continuing matters (a borrowed item to return, an exam to prepare, a negotiation in progress).',
      '- Shape: {"kind":"thread","action":"add|update|resolve|hold|cancel|reopen","targetId":"exact id from CURRENT THREADS or null","title":"...","state":"where it stands now, per the source","endCondition":"what would finish it","participants":["names"],"promiseId":"exact id of a related promise from CURRENT MEMORY or null","knownBy":["names"]|["all"],"evidence":"short quote from the source"}',
      "- Use update/resolve/hold/cancel/reopen with an exact targetId. Never create a new thread for a matter already in CURRENT THREADS.",
      "- When a promise in CURRENT MEMORY is the same matter, set promiseId instead of repeating the promise.",
      "- reopen only when the source explicitly shows a resolved or cancelled matter starting again, and quote it in evidence.",
      "- knownBy follows the knowledge-scope rule. A state learned in a restricted section is known only by those characters."
    ].join(`
`);
    function normalizeThreadEntry(value = {}) {
      const raw = parseRecord(value);
      const status = Object.prototype.hasOwnProperty.call(THREAD_STATUS_LABEL, raw.status) ? raw.status : "open";
      return {
        id: String(raw.id || uid("the")),
        status,
        state: String(raw.state || "").trim().slice(0, 300),
        at: String(raw.at || raw.recordedAt || ""),
        msgIndex: Number(raw.msgIndex) || 0,
        recordedAt: String(raw.recordedAt || nowIso()),
        via: raw.via === "manual" ? "manual" : "model",
        evidence: String(raw.evidence || "").trim().slice(0, 300),
        sourceIds: normalizeTextList(raw.sourceIds, 24, 160),
        ...Object.keys(normalizeSourceFingerprints(raw.sourceFingerprints)).length ? { sourceFingerprints: normalizeSourceFingerprints(raw.sourceFingerprints) } : {},
        ...normalizeKnownBy(raw.knownBy).length ? { knownBy: normalizeKnownBy(raw.knownBy) } : {},
        ...raw.candidateId ? { candidateId: String(raw.candidateId) } : {}
      };
    }
    function entryOrder(a, b) {
      return String(a.at || "").localeCompare(String(b.at || "")) || a.msgIndex - b.msgIndex || String(a.recordedAt || "").localeCompare(String(b.recordedAt || ""));
    }
    function normalizeThread(value = {}) {
      const raw = parseRecord(value);
      const title = String(raw.title || "").trim().replace(/\s+/g, " ").slice(0, 120);
      if (!title)
        return null;
      const history = safeArray(raw.history).map(normalizeThreadEntry).sort(entryOrder).slice(-80);
      return {
        id: String(raw.id || uid("thread")),
        title,
        status: Object.prototype.hasOwnProperty.call(THREAD_STATUS_LABEL, raw.status) ? raw.status : "open",
        priority: ["high", "normal", "low"].includes(raw.priority) ? raw.priority : "normal",
        participants: normalizeTextList(raw.participants, 12, 80),
        promiseId: String(raw.promiseId || ""),
        currentState: String(raw.currentState || "").trim().slice(0, 300),
        endCondition: String(raw.endCondition || "").trim().slice(0, 240),
        links: safeArray(raw.links).filter(isRecord).map((l) => ({ kind: ["item", "episode"].includes(l.kind) ? l.kind : "item", id: String(l.id || "") })).filter((l) => l.id).slice(0, 24),
        history,
        ...normalizeKnownBy(raw.knownBy).length ? { knownBy: normalizeKnownBy(raw.knownBy) } : {},
        ...raw.branchAdjusted ? { branchAdjusted: true } : {},
        ...raw.sourceCandidateId ? { sourceCandidateId: String(raw.sourceCandidateId) } : {},
        createdAt: String(raw.createdAt || nowIso()),
        updatedAt: String(raw.updatedAt || raw.createdAt || nowIso())
      };
    }
    function threadList(data = state.currentData) {
      return safeArray(parseRecord(data).threads).map(normalizeThread).filter(Boolean);
    }
    function threadScope(thread, entry) {
      const t = normalizeKnownBy(thread.knownBy);
      const e = normalizeKnownBy(entry?.knownBy);
      if (t.length && e.length)
        return t.filter((id) => e.includes(id));
      return t.length ? t : e;
    }
    function deriveThreadState(thread, viewer = null) {
      const visible = thread.history.filter((entry) => {
        const scope = threadScope(thread, entry);
        if (!scope.length)
          return true;
        return Array.isArray(viewer) && viewer.length && viewer.every((id) => scope.includes(id));
      });
      const last = visible[visible.length - 1];
      if (!last)
        return null;
      return { status: last.status, currentState: last.state || thread.currentState, entry: last };
    }
    function threadOverall(thread) {
      const last = thread.history[thread.history.length - 1];
      return last ? { status: last.status, currentState: last.state || thread.currentState } : { status: thread.status, currentState: thread.currentState };
    }
    function threadSnapshotForPrompt() {
      const rows = threadList().filter((t) => t.status !== "cancelled").slice(-30).map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        state: t.currentState,
        endCondition: t.endCondition,
        ...t.promiseId ? { promiseId: t.promiseId } : {},
        ...normalizeKnownBy(t.knownBy).length ? { knownBy: normalizeKnownBy(t.knownBy).map(characterName) } : {}
      }));
      return `

[CURRENT THREADS]
${JSON.stringify(rows, null, 2)}
[/CURRENT THREADS]`;
    }
    function normalizeThreadCandidate(row) {
      if (!isRecord(row))
        return null;
      const stored = row.__threadCandidate === true;
      const action = Object.prototype.hasOwnProperty.call(THREAD_ACTION_LABEL, String(row.action || "").toLowerCase()) ? String(row.action).toLowerCase() : "add";
      const threads = threadList();
      const target = row.targetId ? threads.find((t) => t.id === String(row.targetId)) : null;
      if (action !== "add" && !target)
        return null;
      const title = String(row.title || target?.title || "").trim().slice(0, 120);
      if (!title)
        return null;
      const scope = stored ? { knownByIds: normalizeKnownBy(row.knownByIds), scopeConfirmed: row.scopeConfirmed === true } : episodeScopeOf(row, false);
      const items = safeArray(state.currentData?.items);
      let promiseId = String(row.promiseId || "");
      if (promiseId && !items.some((item) => item.id === promiseId && item.type === "promise"))
        promiseId = "";
      if (!promiseId && action === "add")
        promiseId = items.find((item) => item.type === "promise" && titleKey(item.title) && titleKey(item.title) === titleKey(title))?.id || "";
      const cand = {
        __threadCandidate: true,
        candidateId: String(row.candidateId || uid("thc")),
        action,
        targetId: target?.id || "",
        title,
        state: String(row.state || row.currentState || "").trim().slice(0, 300),
        endCondition: String(row.endCondition || "").trim().slice(0, 240),
        participants: normalizeTextList(row.participants, 12, 80),
        promiseId,
        evidence: String(row.evidence || "").trim().slice(0, 300),
        ...scope,
        scopeNeedsReview: row.scopeNeedsReview === true,
        similarTo: String(row.similarTo || ""),
        needsConfirm: row.needsConfirm === true,
        rejectReason: String(row.rejectReason || "")
      };
      if (!stored) {
        if (cand.action === "add" && cand.promiseId) {
          const linked = threads.find((t) => t.promiseId === cand.promiseId && t.status !== "cancelled");
          if (linked) {
            cand.action = "update";
            cand.targetId = linked.id;
          }
        }
        if (cand.action === "add")
          cand.similarTo = threads.find((t) => titleKey(t.title) && titleKey(t.title) === titleKey(cand.title))?.id || "";
        if (cand.action === "reopen") {
          if (!["resolved", "cancelled"].includes(target.status)) {
            cand.action = "update";
          } else {
            cand.needsConfirm = true;
            if (!cand.evidence)
              cand.rejectReason = "다시 연다는 근거 인용이 없어요";
          }
        }
      }
      return cand;
    }
    function threadCandidateBlocks(cand) {
      if (cand.rejectReason)
        return true;
      return cand.scopeNeedsReview && cand.scopeConfirmed !== true && !normalizeKnownBy(cand.knownByIds).length;
    }
    function extractThreadCandidates(rawRows, sourceRows, mode) {
      const cands = safeArray(rawRows).filter((row) => isRecord(row) && (row.kind === "thread" || row.type === "thread")).map(normalizeThreadCandidate).filter(Boolean).slice(0, 10);
      const batchAt = batchSourceTime(sourceRows);
      for (const cand of cands) {
        if (mode === "summaries" && batchHasRestricted(sourceRows))
          cand.scopeNeedsReview = true;
        if (cand.action === "reopen" && !cand.rejectReason) {
          const target = threadList().find((t) => t.id === cand.targetId);
          const closing = [...safeArray(target?.history)].reverse().find((entry) => ["resolved", "cancelled"].includes(entry.status));
          if (closing && batchAt && closing.at && batchAt <= closing.at)
            cand.rejectReason = "해결 기록보다 오래된 근거라 다시 열 수 없어요";
        }
      }
      return cands;
    }
    function preselectThreads(cands) {
      return new Set(cands.map((cand, i) => threadCandidateBlocks(cand) || cand.needsConfirm || cand.similarTo ? null : String(i)).filter(Boolean));
    }
    function applyThreadCandidates(data, cands, selected, { fps = {}, sourceIds = [], rows = [] } = {}) {
      const out = { applied: 0, held: [], createdIds: [] };
      const list = safeArray(data.threads).map(normalizeThread).filter(Boolean);
      const at = batchSourceTime(rows) || nowIso();
      const msgIndex = Math.max(0, ...safeArray(rows).map((row) => Number(row?.endIndex) || 0));
      const now = nowIso();
      cands.forEach((cand, i) => {
        if (!selected.has(String(i)))
          return;
        if (threadCandidateBlocks(cand)) {
          out.held.push(i);
          return;
        }
        if (list.some((t) => t.sourceCandidateId === cand.candidateId || t.history.some((entry) => entry.candidateId === cand.candidateId))) {
          out.applied += 1;
          return;
        }
        const status = { add: "open", update: null, resolve: "resolved", hold: "hold", cancel: "cancelled", reopen: "open" }[cand.action];
        const entry = { status: status || "open", state: cand.state, at, msgIndex, recordedAt: now, via: "model", evidence: cand.evidence, sourceIds, sourceFingerprints: fps, knownBy: cand.knownByIds, candidateId: cand.candidateId };
        if (cand.action === "add") {
          if (list.length >= THREAD_LIMIT) {
            out.held.push(i);
            return;
          }
          const thread = normalizeThread({ id: uid("thread"), title: cand.title, status: "open", participants: cand.participants, promiseId: cand.promiseId, endCondition: cand.endCondition, currentState: cand.state, history: [entry], sourceCandidateId: cand.candidateId, createdAt: now, updatedAt: now });
          list.push(thread);
          out.createdIds.push(thread.id);
          out.applied += 1;
          return;
        }
        const idx = list.findIndex((t) => t.id === cand.targetId);
        if (idx < 0) {
          out.held.push(i);
          return;
        }
        const thread = list[idx];
        if (!status)
          entry.status = deriveThreadState(thread, normalizeKnownBy(cand.knownByIds).length ? normalizeKnownBy(cand.knownByIds) : null)?.status || thread.status;
        if (["resolved", "cancelled"].includes(thread.status) && entry.status === "open" && cand.action !== "reopen")
          entry.status = thread.status;
        const next = normalizeThread({ ...thread, history: [...thread.history, entry], endCondition: cand.endCondition || thread.endCondition, participants: normalizeTextList([...thread.participants, ...cand.participants], 12, 80), promiseId: thread.promiseId || cand.promiseId, updatedAt: now });
        const overall = threadOverall(next);
        list[idx] = normalizeThread({ ...next, status: overall.status, currentState: overall.currentState });
        out.applied += 1;
      });
      data.threads = list;
      return out;
    }
    function threadInjectable(status) {
      return status === "open" || status === "hold";
    }
    function injectionPlanLayers(d) {
      const threads = [];
      for (const thread of threadList(d)) {
        if (normalizeKnownBy(thread.knownBy).length)
          continue;
        const pub = deriveThreadState(thread, null);
        if (!pub || !threadInjectable(pub.status))
          continue;
        threads.push({ type: "thread", id: thread.id, title: thread.title, priority: thread.priority, updatedAt: pub.entry?.at || thread.updatedAt, currentState: pub.currentState, status: pub.status, promiseId: thread.promiseId, endCondition: thread.endCondition });
      }
      return { threads, duplicates: [] };
    }
    function threadLine(row, data) {
      const promise = row.promiseId ? safeArray(data.items).find((item) => item.id === row.promiseId) : null;
      const label = THREAD_STATUS_LABEL[row.status] || "진행 중";
      if (promise && sharedPromises(data).some((item) => item.id === promise.id))
        return `- '${truncate(promise.title, 60)}' 약속의 진행 상태[${label}]: ${truncate(row.currentState || "변화 없음", 200)}`;
      return `- [${label}] ${truncate(row.title, 80)}: ${truncate(row.currentState || "진행 중", 200)}${row.endCondition ? ` (끝나는 조건: ${truncate(row.endCondition, 100)})` : ""}`;
    }
    function threadContext(chat, data) {
      const rows = injectionPlan(data).threads;
      if (!rows.length)
        return "";
      return [
        THREAD_MARKER,
        `[진행 흐름 · ${chatLabel(chat)}]`,
        "아래는 이 RP에서 이어지고 있는 일과 지금 상태다.",
        ...rows.map((row) => threadLine(row, data)),
        "끝나는 조건이 채워지기 전에는 이미 끝난 것처럼 다루지 마라. 같은 일에 대해 이 기록이 떠올린 옛 장면·요약과 다르면 이 기록을 최신 상태로 본다."
      ].join(`
`);
    }
    function restrictedThreadPlans(data) {
      const plans = [];
      for (const thread of threadList(data)) {
        const pub = deriveThreadState(thread, null);
        const sets = new Map;
        for (const entry of thread.history) {
          const scope = threadScope(thread, entry);
          if (!scope.length)
            continue;
          if (pub?.entry && entryOrder(entry, pub.entry) <= 0)
            continue;
          const key = scope.slice().sort().join(",");
          sets.set(key, scope);
        }
        for (const [key, scope] of sets) {
          const view = deriveThreadState(thread, scope);
          if (!view || !threadInjectable(view.status))
            continue;
          plans.push({ threadId: thread.id, scopeKey: key, scope, content: [THREAD_MARKER, `[진행 흐름 · ${truncate(thread.title, 80)} · ${knownByLabel(scope)}만 아는 최신 상태]`, `아래 상태는 ${knownByLabel(scope)}만 알고 있다. 모르는 인물이 알고 있는 것처럼 굴게 하지 마라.`, `- [${THREAD_STATUS_LABEL[view.status]}] ${truncate(view.currentState || "", 220)}`].join(`
`), title: thread.title });
        }
      }
      return plans;
    }
    async function syncLayerEntries(book, rows, chat, data) {
      const content = threadContext(chat, data);
      data.threadEntryId = await upsertEntry(book.id, rows, String(data.threadEntryId || ""), (entry) => entry?.tag === THREAD_ENTRY_TAG, constantEntryPayload({ tag: THREAD_ENTRY_TAG, name: "진행 흐름 · 지금 상태", content: content || `${THREAD_MARKER}
(진행 중인 흐름 없음)`, enabled: data.enabled && !!content, order: 31, dynamicState: { memoryCabinetChatId: String(chat.id), managedBy: LOREBOOK_TAG, kind: "threads" } }));
      const effective = restrictionEffective(chat);
      const known = parseRecord(data.threadRestrictedEntryIds);
      const next = {};
      for (const plan of restrictedThreadPlans(data)) {
        const mapKey = `${plan.threadId}|${plan.scopeKey}`;
        next[mapKey] = await upsertEntry(book.id, rows, String(known[mapKey] || ""), (entry) => {
          const ds = parseRecord(entry?.dynamicState);
          return entry?.tag === THREAD_RESTRICTED_TAG && String(ds.memoryCabinetThreadId || "") === plan.threadId && String(ds.memoryCabinetScope || "") === plan.scopeKey;
        }, { ...constantEntryPayload({ tag: THREAD_RESTRICTED_TAG, name: `진행 흐름 · ${truncate(plan.title, 90)} · 일부만 앎`, content: plan.content, enabled: data.enabled && effective, order: 32, dynamicState: { memoryCabinetChatId: String(chat.id), memoryCabinetThreadId: plan.threadId, memoryCabinetScope: plan.scopeKey, managedBy: LOREBOOK_TAG, kind: "thread-restricted" } }), characterFilterMode: "include", characterFilterIds: plan.scope });
      }
      const active = new Set(Object.values(next).map(String));
      for (const entry of rows.filter((e) => e?.tag === THREAD_RESTRICTED_TAG)) {
        if (!entry?.id || active.has(String(entry.id)))
          continue;
        try {
          await api(`lorebooks/${encodeURIComponent(book.id)}/entries/${encodeURIComponent(entry.id)}`, { method: "PATCH", body: { enabled: false } });
        } catch {}
      }
      if (Object.keys(next).length || Object.keys(known).length)
        data.threadRestrictedEntryIds = next;
    }
    function threadStatusChip(status) {
      return `<span class="mmc-chip ${status === "open" ? "is-ok" : status === "hold" ? "is-warn" : "is-soft"}">${esc(THREAD_STATUS_LABEL[status] || status)}</span>`;
    }
    function threadCard(thread) {
      const pub = deriveThreadState(thread, null);
      const overall = threadOverall(thread);
      const promise = thread.promiseId ? safeArray(state.currentData?.items).find((item) => item.id === thread.promiseId) : null;
      const secretNewer = overall.currentState !== pub?.currentState || overall.status !== pub?.status;
      const stale = safeArray(state.staleRecords).some((row) => row.kind === "thread" && row.id === thread.id);
      return `<article class="mmc-card mmc-thread is-${esc(thread.status)}">
      <header class="mmc-episode-head"><div><b>${esc(thread.title)}</b><small>${esc([thread.participants.join(", "), thread.endCondition && `끝나는 조건 · ${thread.endCondition}`].filter(Boolean).join(" · ") || "끝나는 조건 미정")}</small></div><span class="mmc-chips">${threadStatusChip(pub?.status || thread.status)}${promise ? `<span class="mmc-chip is-soft">약속 · ${esc(truncate(promise.title, 20))}</span>` : ""}${scopeLabelChip(thread.knownBy)}${stale ? '<span class="mmc-chip is-warn">근거 바뀜</span>' : ""}${thread.branchAdjusted ? '<span class="mmc-chip is-warn">분기 시점으로 맞춤</span>' : ""}</span><button class="mmc-btn mmc-sm" data-action="edit-thread" data-id="${esc(thread.id)}">${SVG.edit}<span>편집</span></button></header>
      <p class="mmc-thread-state">${esc(pub?.currentState || (normalizeKnownBy(thread.knownBy).length ? overall.currentState : "") || "아직 상태 기록이 없어요")}</p>
      ${secretNewer && pub ? `<small class="mmc-scope-note">${SVG.lock}일부 인물만 아는 더 새 상태가 있어요 · ${esc(truncate(overall.currentState, 120))}</small>` : ""}
      <div class="mmc-thread-actions">${Object.entries(THREAD_STATUS_LABEL).map(([id, label]) => `<button class="mmc-btn mmc-sm ${thread.status === id ? "mmc-primary" : ""}" data-action="thread-status" data-id="${esc(thread.id)}" data-status="${id}" ${thread.status === id ? "disabled" : ""}>${label}</button>`).join("")}</div>
      ${thread.history.length ? `<details class="mmc-thread-history"><summary>상태 기록 ${thread.history.length}개</summary><ol>${thread.history.slice().reverse().map((entry) => `<li>${threadStatusChip(entry.status)}${scopeLabelChip(threadScope(thread, entry))}<span>${esc(entry.state || "")}</span><small>${esc([sourceDate(entry.at) || "", entry.via === "manual" ? "직접 바꿈" : "모델 정리", entry.evidence && `“${truncate(entry.evidence, 60)}”`].filter(Boolean).join(" · "))}</small></li>`).join("")}</ol></details>` : ""}
    </article>`;
    }
    function threadView() {
      const all = threadList();
      const live = all.filter((t) => threadInjectable(t.status));
      const closed = all.filter((t) => !threadInjectable(t.status));
      return `<div data-mmc-summary-alert-slot>${statusBanners()}</div>
      <div class="mmc-toolbar"><div class="mmc-episode-note"><b>진행 흐름 ${live.length}개</b><small>이어지는 일의 지금 상태를 매 턴 넣어요. 약속과 같은 일은 약속에 묶여 한 번만 들어가요.</small></div><div class="mmc-actions"><button class="mmc-btn mmc-primary" data-action="new-thread">${SVG.plus}<span>직접 추가</span></button></div></div>
      <div class="mmc-episode-list">${live.length ? live.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(threadCard).join("") : '<div class="mmc-empty">진행 중인 흐름이 없어요. 새 요약·장면을 모델로 정리하면 함께 제안돼요.</div>'}</div>
      ${closed.length ? `<details class="mmc-episode-old"><summary>해결·취소된 흐름 ${closed.length}개 (넣지 않아요)</summary>${closed.map(threadCard).join("")}</details>` : ""}`;
    }
    function threadCandidateCard(kind, cand, index, selected) {
      const checked = selected.has(String(index));
      const target = cand.targetId ? threadList().find((t) => t.id === cand.targetId) : null;
      const similar = cand.similarTo ? threadList().find((t) => t.id === cand.similarTo) : null;
      const promise = cand.promiseId ? safeArray(state.currentData?.items).find((item) => item.id === cand.promiseId) : null;
      return `<div class="mmc-candidate mmc-episode-cand ${checked ? "is-selected" : ""}"><input type="checkbox" data-thread-kind="${kind}" data-thread-index="${index}" ${checked ? "checked" : ""} ${cand.rejectReason ? "disabled" : ""}><span>
      <b>${esc(cand.title)}</b><small><strong>${esc(THREAD_ACTION_LABEL[cand.action] || cand.action)}</strong>${target ? ` · 지금 ${esc(THREAD_STATUS_LABEL[target.status])}` : ""}${promise ? ` · 약속 '${esc(truncate(promise.title, 30))}'에 연결` : ""}</small>
      ${cand.state ? `<p>${esc(cand.state)}</p>` : ""}
      ${cand.endCondition ? `<small>끝나는 조건 · ${esc(cand.endCondition)}</small>` : ""}
      ${cand.evidence ? `<em>“${esc(cand.evidence)}”</em>` : ""}
      ${cand.needsConfirm && !cand.rejectReason ? `<small class="mmc-scope-warn">해결된 흐름을 다시 여는 제안이에요. 근거를 확인한 뒤 직접 골라 주세요.</small>` : ""}
      ${cand.rejectReason ? `<small class="mmc-scope-warn">적용할 수 없어요 · ${esc(cand.rejectReason)}</small>` : ""}
      ${similar ? `<small class="mmc-scope-warn">제목이 같은 흐름 '${esc(truncate(similar.title, 40))}'이 있어요. 같은 일이면 갱신으로 바꿔 주세요. <button type="button" class="mmc-btn mmc-sm mmc-ghost" data-action="thread-to-update" data-thread-kind="${kind}" data-index="${index}">기존 흐름 갱신으로 바꾸기</button></small>` : ""}
      ${scopeControl(`${kind}-th`, index, cand.knownByIds, { needsReview: cand.scopeNeedsReview, confirmed: cand.scopeConfirmed })}
    </span></div>`;
    }
    function threadCandidateGroup(kind, cands, selected) {
      if (!cands.length)
        return "";
      return `<section class="mmc-candidate-group is-thread"><div class="mmc-candidate-group-head"><span class="mmc-type-chip">흐름</span><div><b>진행 흐름 후보 ${cands.length}개</b><small>새 흐름 · 상태 갱신 · 해결 · 다시 열기</small></div></div><div class="mmc-candidate-list">${cands.map((cand, i) => threadCandidateCard(kind, cand, i, selected)).join("")}</div></section>`;
    }
    function threadScopeTarget(kind, index) {
      const m = String(kind).match(/^(rev|cand)-th$/);
      if (!m)
        return null;
      return (m[1] === "rev" ? state.reviewThreads : state.candThreads)[Number(index)] || null;
    }
    function threadEditorLayer() {
      const d = normalizeThread(state.threadDraft || { title: "새 흐름" }) || normalizeThread({ title: "새 흐름" });
      const promises = safeArray(state.currentData?.items).filter((item) => item.type === "promise");
      const many = state.chatCharacters.length >= 2;
      return `<div class="mmc-layer-backdrop" data-action="close-layer"><section class="mmc-layer mmc-editor" data-layer-stop>
      <header><div><span class="mmc-kicker">ONGOING THREAD</span><h3>${state.threadDraft?.id ? "진행 흐름 편집" : "새 진행 흐름"}</h3></div><button class="mmc-icon-btn" data-action="close-layer">${SVG.close}</button></header>
      <div class="mmc-layer-body">
        <label class="mmc-field"><span>제목</span><input id="mmc-th-title" value="${esc(state.threadDraft?.id ? d.title : String(state.threadDraft?.title || ""))}" maxlength="120" placeholder="예: 우산을 다음 방문 때 돌려주기"></label>
        <label class="mmc-field"><span>지금 상태 <small>바꾸면 상태 기록에 '직접 바꿈'으로 남아요</small></span><textarea id="mmc-th-state" rows="3">${esc(threadOverall(d).currentState)}</textarea></label>
        <label class="mmc-field"><span>끝나는 조건</span><input id="mmc-th-end" value="${esc(d.endCondition)}" maxlength="240" placeholder="예: 우산을 돌려받으면"></label>
        <div class="mmc-field-row"><label class="mmc-field"><span>관련 인물 <small>쉼표로 구분</small></span><input id="mmc-th-people" value="${esc(d.participants.join(", "))}"></label><label class="mmc-field"><span>중요도</span><select id="mmc-th-priority">${["high", "normal", "low"].map((p) => `<option value="${p}" ${d.priority === p ? "selected" : ""}>${PRIORITY_LABEL[p]}</option>`).join("")}</select></label></div>
        <label class="mmc-field"><span>연결할 약속 <small>같은 일이면 연결하세요 · 주입은 약속과 겹치지 않게 상태 한 줄만 더해요</small></span><select id="mmc-th-promise"><option value="">연결 안 함</option>${promises.map((item) => `<option value="${esc(item.id)}" ${d.promiseId === item.id ? "selected" : ""}>${esc(truncate(item.title, 60))} · ${esc(PROMISE_STATUS_LABEL[item.status] || "")}</option>`).join("")}</select></label>
        ${many || normalizeKnownBy(d.knownBy).length ? `<div class="mmc-field"><span>흐름 전체를 아는 인물 <small>비우면 모두</small></span>${scopeControl("thdraft", 0, d.knownBy)}</div>` : ""}
      </div>
      <footer>${state.threadDraft?.id ? `<button class="mmc-btn mmc-danger" data-action="delete-thread" data-id="${esc(state.threadDraft.id)}">${SVG.trash}<span>삭제</span></button>` : "<span></span>"}<div><button class="mmc-btn" data-action="close-layer">취소</button><button class="mmc-btn mmc-primary" data-action="save-thread">저장</button></div></footer>
    </section></div>`;
    }
    async function saveThreadDraft() {
      const val = (id) => String(document.getElementById(id)?.value || "").trim();
      const title = val("mmc-th-title");
      if (!title)
        throw new Error("제목을 입력해 주세요.");
      const scopeBoxes = Array.from(document.querySelectorAll('[data-scope-kind="thdraft"]'));
      const data = await freshOwnedData();
      const list = safeArray(data.threads).map(normalizeThread).filter(Boolean);
      const now = nowIso();
      const stateText = val("mmc-th-state");
      const fields = { title, endCondition: val("mmc-th-end"), participants: val("mmc-th-people").split(/[,，]/).map((x) => x.trim()).filter(Boolean), priority: val("mmc-th-priority") || "normal", promiseId: val("mmc-th-promise") };
      if (state.threadDraft?.id) {
        const idx = list.findIndex((t) => t.id === state.threadDraft.id);
        if (idx < 0)
          throw new Error("수정할 흐름을 찾지 못했습니다.");
        const old = list[idx];
        const knownBy = scopeBoxes.length ? scopeBoxes.filter((b) => b.checked).map((b) => String(b.dataset.scopeChar || "")) : old.knownBy;
        const history = stateText && stateText !== threadOverall(old).currentState ? [...old.history, { status: threadOverall(old).status, state: stateText, at: now, recordedAt: now, via: "manual" }] : old.history;
        const next = normalizeThread({ ...old, ...fields, knownBy, history, updatedAt: now });
        list[idx] = normalizeThread({ ...next, ...threadOverall(next) });
      } else {
        if (list.length >= THREAD_LIMIT)
          throw new Error(`진행 흐름은 최대 ${THREAD_LIMIT}개까지 보관해요. 끝난 흐름을 정리한 뒤 추가해 주세요.`);
        const knownBy = scopeBoxes.filter((b) => b.checked).map((b) => String(b.dataset.scopeChar || ""));
        list.push(normalizeThread({ id: uid("thread"), ...fields, knownBy, status: "open", currentState: stateText, history: stateText ? [{ status: "open", state: stateText, at: now, recordedAt: now, via: "manual" }] : [], createdAt: now, updatedAt: now }));
      }
      data.threads = list;
      await persistData(data);
      state.threadDraft = null;
      state.layer = null;
      render();
    }
    async function setThreadStatus(threadId, status) {
      const data = await freshOwnedData();
      const list = safeArray(data.threads).map(normalizeThread).filter(Boolean);
      const idx = list.findIndex((t) => t.id === threadId);
      if (idx < 0 || !THREAD_STATUS_LABEL[status])
        return;
      const old = list[idx];
      if (["resolved", "cancelled"].includes(old.status) && threadInjectable(status) && !window.confirm(`'${old.title}' 흐름을 다시 진행 중으로 돌릴까요? 매 턴 주입에 다시 들어갑니다.`))
        return;
      const now = nowIso();
      const next = normalizeThread({ ...old, history: [...old.history, { status, state: threadOverall(old).currentState, at: now, recordedAt: now, via: "manual" }], updatedAt: now });
      list[idx] = normalizeThread({ ...next, ...threadOverall(next), branchAdjusted: false });
      data.threads = list;
      await persistData(data);
      render();
    }
    function staleLayerSources(data) {
      const rows = [];
      for (const ep of liveEpisodes(data)) {
        const fps = normalizeSourceFingerprints(ep.sourceFingerprints);
        if (Object.keys(fps).length)
          rows.push({ kind: "episode", id: ep.id, title: `장면 · ${ep.title}`, fps });
      }
      if (typeof threadList === "function") {
        for (const thread of threadList(data).filter((t) => ["open", "hold"].includes(t.status))) {
          const fps = {};
          for (const entry of thread.history)
            Object.assign(fps, normalizeSourceFingerprints(entry.sourceFingerprints));
          if (Object.keys(fps).length)
            rows.push({ kind: "thread", id: thread.id, title: `흐름 · ${thread.title}`, fps });
        }
      }
      return rows;
    }
    function staleLayerEditButton(row) {
      if (row.kind === "episode")
        return `<button class="mmc-btn mmc-sm" data-action="edit-episode" data-id="${esc(row.id)}">장면 편집</button>`;
      if (row.kind === "thread")
        return `<button class="mmc-btn mmc-sm" data-action="edit-thread" data-id="${esc(row.id)}">흐름 편집</button>`;
      return "";
    }
    function acknowledgeStaleLayer(data, row) {
      const ack = (fps) => {
        const out = normalizeSourceFingerprints(fps);
        for (const reason of row.reasons)
          out[reason.key] = reason.type === "changed" && reason.current ? reason.current : "ack";
        return out;
      };
      if (row.kind === "episode" && Array.isArray(data.episodes)) {
        data.episodes = data.episodes.map(normalizeEpisode).filter(Boolean).map((ep) => ep.id === row.id ? normalizeEpisode({ ...ep, sourceFingerprints: ack(ep.sourceFingerprints) }) : ep);
        return true;
      }
      if (row.kind === "thread" && Array.isArray(data.threads) && typeof normalizeThread === "function") {
        data.threads = data.threads.map(normalizeThread).filter(Boolean).map((t) => t.id !== row.id ? t : normalizeThread({ ...t, history: t.history.map((entry) => ({ ...entry, sourceFingerprints: ack(entry.sourceFingerprints) })) }));
        return true;
      }
      return false;
    }
    function holdPostBranchLayers(next, hold, cutMs, raw) {
      if (Array.isArray(next.episodes)) {
        const rawEps = new Map(safeArray(raw.episodes).filter(isRecord).map((row) => [String(row.id || ""), row]));
        next.episodes = next.episodes.filter((ep) => {
          const src = rawEps.get(ep.id) || {};
          const reason = timeAfter(src.createdAt, cutMs) ? "created" : timeAfter(src.updatedAt, cutMs) ? "updated" : "";
          if (!reason)
            return true;
          hold.episodes.push({ ...ep, holdReason: reason });
          return false;
        });
      }
      if (Array.isArray(next.threads) && typeof normalizeThread === "function") {
        const rawThreads = new Map(safeArray(raw.threads).filter(isRecord).map((row) => [String(row.id || ""), row]));
        next.threads = next.threads.filter((thread) => {
          const src = rawThreads.get(thread.id) || {};
          if (timeAfter(src.createdAt, cutMs)) {
            hold.threads.push({ ...thread, holdReason: "created" });
            return false;
          }
          const rawHistory = new Map(safeArray(src.history).filter(isRecord).map((row) => [String(row.id || ""), row]));
          const keep = [];
          thread.history.forEach((entry) => {
            const rawEntry = rawHistory.get(entry.id) || {};
            const at = rawEntry.recordedAt || rawEntry.at || "";
            if (timeAfter(at, cutMs))
              hold.threadEntries.push({ threadId: thread.id, threadTitle: thread.title, entry: { ...entry }, holdReason: "created" });
            else
              keep.push(entry);
          });
          if (keep.length !== thread.history.length) {
            thread.history = keep;
            const last = keep[keep.length - 1];
            if (last) {
              thread.status = last.status;
              thread.currentState = last.state;
            }
            thread.branchAdjusted = true;
          }
          return true;
        });
      }
    }
    function restoreHeldLayerRecord(data, key, row) {
      const clean = { ...row };
      delete clean.holdReason;
      if (key === "episodes") {
        const list = safeArray(data.episodes).map(normalizeEpisode).filter(Boolean);
        if (!list.some((ep) => ep.id === clean.id))
          list.push(normalizeEpisode(clean));
        data.episodes = list;
        return true;
      }
      if (key === "threads" && typeof normalizeThread === "function") {
        const list = safeArray(data.threads).map(normalizeThread).filter(Boolean);
        if (!list.some((t) => t.id === clean.id))
          list.push(normalizeThread(clean));
        data.threads = list;
        return true;
      }
      if (key === "threadEntries" && typeof normalizeThread === "function") {
        const list = safeArray(data.threads).map(normalizeThread).filter(Boolean);
        const thread = list.find((t) => t.id === row.threadId);
        if (!thread)
          return false;
        if (!thread.history.some((entry) => entry.id === row.entry?.id))
          thread.history.push(row.entry);
        data.threads = list.map((t) => t.id === thread.id ? normalizeThread({ ...thread, ...deriveThreadState(thread) }) : t);
        return true;
      }
      return false;
    }
    const SUMMARY_SOURCE_TYPES = new Set(["summary", "summary-model-review", "health-check"]);
    function injectableItem(item) {
      return item.type === "promise" ? ["active", "hold"].includes(item.status) : item.active && !item.archived;
    }
    async function refreshStaleRecords() {
      const data = state.currentData;
      const chatId = String(state.currentChat?.id || "");
      if (!data || !chatId || !ownershipAllowsData()) {
        state.staleRecords = [];
        return;
      }
      const summaries = new Map(safeArray(parseRecord(state.currentChat?.metadata).summaryEntries).filter(isRecord).map((row) => [String(row.id), textHash(row.content || "")]));
      const items = safeArray(data.items).filter(injectableItem);
      const memory = normalizeElementMemory(data.elementMemory);
      const extra = typeof staleLayerSources === "function" ? staleLayerSources(data) : [];
      const needMessages = items.some((item) => Object.keys(normalizeSourceFingerprints(item.sourceFingerprints)).some((key) => key.startsWith("message:"))) || memory.entities.some((entity) => [...entity.currentFacts, ...entity.historyFacts].some((fact) => safeArray(fact.source?.fingerprints).length)) || extra.some((row) => Object.keys(row.fps).some((key) => key.startsWith("message:")));
      let messageFps = null;
      if (needMessages) {
        try {
          messageFps = new Set(extractArray(await api(`chats/${encodeURIComponent(chatId)}/messages`), ["messages", "items", "results"]).map(messageSourceFingerprint));
        } catch {
          messageFps = null;
        }
      }
      const amFps = advancedMemoryEnabled() && state.amAllFingerprints instanceof Set && !state.amSceneError && state.amChatId === chatId ? state.amAllFingerprints : null;
      const watch = parseRecord(state.sourceWatchByChat[chatId]);
      let watchChanged = false;
      const check = (fps) => {
        const reasons = [];
        for (const [key, expected] of Object.entries(fps)) {
          if (expected === "ack")
            continue;
          const kind = key.slice(0, key.indexOf(":"));
          const id = key.slice(key.indexOf(":") + 1);
          if (kind === "summary") {
            const current = summaries.get(id);
            if (current === undefined)
              reasons.push({ key, type: "missing", label: "근거 요약이 지금은 없어요" });
            else if (current !== expected)
              reasons.push({ key, type: "changed", label: "근거 요약 내용이 바뀌었어요", current });
          } else if (kind === "message" && messageFps && !messageFps.has(expected))
            reasons.push({ key, type: "changed", label: "근거 메시지가 바뀌었거나 지워졌어요(스와이프 포함)" });
          else if (kind === "am" && amFps && !amFps.has(expected))
            reasons.push({ key, type: "changed", label: "근거 장면 요약이 바뀌었거나 지워졌어요" });
        }
        return reasons;
      };
      const result = [];
      for (const item of items) {
        const fps = normalizeSourceFingerprints(item.sourceFingerprints);
        const reasons = check(fps);
        for (const id of safeArray(item.sourceIds).map(String)) {
          if (!id || id === "legacy-summary" || id.startsWith("am:") || fps[`summary:${id}`] || fps[`message:${id}`])
            continue;
          if (!SUMMARY_SOURCE_TYPES.has(item.sourceType) && !summaries.has(id))
            continue;
          const wkey = `${item.id}|summary:${id}`;
          const current = summaries.get(id);
          if (!(wkey in watch)) {
            watch[wkey] = current ?? "missing";
            watchChanged = true;
            continue;
          }
          const expected = watch[wkey];
          if (expected === "ack")
            continue;
          if (current === undefined) {
            if (expected !== "missing")
              reasons.push({ key: `summary:${id}`, watchKey: wkey, type: "missing", label: "근거 요약이 지금은 없어요" });
          } else if (expected === "missing") {
            watch[wkey] = current;
            watchChanged = true;
          } else if (current !== expected)
            reasons.push({ key: `summary:${id}`, watchKey: wkey, type: "changed", label: "근거 요약 내용이 바뀌었어요", current });
        }
        if (reasons.length)
          result.push({ kind: "item", id: item.id, title: `${item.type === "promise" ? "약속" : "앵커"} · ${item.title}`, reasons });
      }
      if (messageFps) {
        for (const entity of memory.entities) {
          for (const fact of [...entity.currentFacts, ...entity.historyFacts]) {
            const fps = safeArray(fact.source?.fingerprints);
            if (fps.length && fps.some((fp) => !messageFps.has(fp)))
              result.push({ kind: "fact", id: fact.id, entityId: entity.id, title: `요소 · ${entity.name} · ${truncate(fact.text, 50)}`, reasons: [{ key: "message", type: "changed", label: "근거 메시지가 바뀌었거나 지워졌어요(스와이프 포함)" }] });
          }
        }
      }
      for (const row of extra) {
        const reasons = check(row.fps);
        if (reasons.length)
          result.push({ kind: row.kind, id: row.id, title: row.title, reasons });
      }
      if (watchChanged) {
        const entries = Object.entries(watch);
        state.sourceWatchByChat[chatId] = Object.fromEntries(entries.slice(-3000));
        await saveUiState();
      }
      state.staleRecords = result;
    }
    function staleLayer() {
      const rows = safeArray(state.staleRecords);
      return `<div class="mmc-layer-backdrop" data-action="close-layer"><section class="mmc-layer mmc-source-layer" data-layer-stop>
      <header><div><span class="mmc-kicker">SOURCE CHANGED</span><h3>근거가 바뀐 기억</h3><small>근거가 바뀌었거나 지워졌지만 기억은 그대로 RP에 들어가고 있어요. 확인하고 고치거나, 이대로 둘지 정해 주세요.</small></div><button class="mmc-icon-btn" data-action="close-layer">${SVG.close}</button></header>
      <div class="mmc-layer-body"><div class="mmc-candidate-note">바뀐 요약·장면은 '새 요약' 검토 대기에도 다시 떠요. 그쪽에서 모델로 다시 정리할 수 있어요.</div>${rows.length ? `<div class="mmc-candidate-list">${rows.map((row, index) => `<article class="mmc-candidate mmc-hold-row"><span><b>${esc(truncate(row.title, 90))}</b>${row.reasons.map((r) => `<small>${esc(r.label)}</small>`).join("")}</span><span class="mmc-hold-actions">${row.kind === "item" ? `<button class="mmc-btn mmc-sm" data-action="edit-item" data-id="${esc(row.id)}">편집</button>` : row.kind === "fact" ? `<button class="mmc-btn mmc-sm" data-action="edit-element" data-id="${esc(row.entityId)}">요소 편집</button>` : typeof staleLayerEditButton === "function" ? staleLayerEditButton(row) : ""}<button class="mmc-btn mmc-sm mmc-ghost" data-action="stale-ack" data-index="${index}">이대로 둘게요</button></span></article>`).join("")}</div>` : '<div class="mmc-empty">근거가 바뀐 기억이 없어요.</div>'}</div>
      <footer><button class="mmc-btn" data-action="stale-refresh">${SVG.sync}<span>다시 확인</span></button><div><button class="mmc-btn mmc-primary" data-action="close-layer">닫기</button></div></footer>
    </section></div>`;
    }
    async function acknowledgeStale(index) {
      const row = safeArray(state.staleRecords)[Number(index)];
      if (!row)
        return;
      const chatId = String(state.currentChat?.id || "");
      const data = await freshOwnedData();
      let changed = false;
      if (row.kind === "item") {
        const item = data.items.find((x) => x.id === row.id);
        if (item) {
          const fps = normalizeSourceFingerprints(item.sourceFingerprints);
          for (const reason of row.reasons) {
            if (reason.watchKey) {
              state.sourceWatchByChat[chatId] = { ...parseRecord(state.sourceWatchByChat[chatId]), [reason.watchKey]: "ack" };
              continue;
            }
            fps[reason.key] = reason.type === "changed" && reason.current ? reason.current : "ack";
          }
          if (Object.keys(fps).length) {
            item.sourceFingerprints = fps;
            changed = true;
          }
        }
      } else if (row.kind === "fact") {
        for (const entity of data.elementMemory.entities)
          for (const fact of [...entity.currentFacts, ...entity.historyFacts]) {
            if (fact.id !== row.id || !fact.source)
              continue;
            fact.source = { ...fact.source, fingerprints: [], contentHash: "" };
            changed = true;
          }
      } else if (typeof acknowledgeStaleLayer === "function")
        changed = acknowledgeStaleLayer(data, row) || changed;
      await saveUiState();
      if (changed)
        await persistData(data, { sync: false, silent: true });
      state.staleRecords = safeArray(state.staleRecords).filter((_, i) => i !== Number(index));
      if (!state.staleRecords.length)
        state.layer = null;
      toast("이 기억은 지금 그대로 두고, 같은 근거 변화로는 다시 알리지 않을게요.");
      render();
    }
    const BRANCH_HOLD_GROUPS = [
      ["items", "약속 · 기억 앵커", (row) => `${row.type === "promise" ? "약속" : "앵커"} · ${row.title}`],
      ["episodes", "장면 기억", (row) => `장면 · ${row.title || "장면"}`],
      ["threads", "진행 흐름", (row) => `흐름 · ${row.title}`],
      ["threadEntries", "진행 흐름의 상태 기록", (row) => `흐름 '${row.threadTitle || ""}' · ${truncate(row.entry?.state || "", 60)}`],
      ["entities", "요소 기억", (row) => `요소 · ${row.name}`],
      ["facts", "요소 기억의 사실", (row) => `${row.entityName || "요소"} · ${truncate(row.fact?.text || "", 70)}`],
      ["docs", "위키 문서", (row) => `위키 · ${row.title}`]
    ];
    function branchHoldLayer() {
      const hold = normalizeBranchHold(state.currentData?.branchHold);
      const groups = BRANCH_HOLD_GROUPS.map(([key, label, line]) => {
        const rows = hold[key];
        if (!rows.length)
          return "";
        return `<section class="mmc-candidate-group"><div class="mmc-candidate-group-head"><span class="mmc-type-chip">${esc(label)}</span><div><b>${esc(label)} ${rows.length}개</b></div><div class="mmc-hold-group-actions"><button class="mmc-btn mmc-sm" data-action="branch-hold-keep" data-kind="${key}" data-index="all">모두 넣기</button></div></div><div class="mmc-candidate-list">${rows.map((row, index) => `<article class="mmc-candidate mmc-hold-row"><span><b>${esc(truncate(line(row), 90))}</b><small>${row.holdReason === "updated" ? "분기 시점 뒤에 부모에서 바뀐 기록 · 분기 시점의 옛 내용은 남아 있지 않아요" : "분기 시점 뒤에 부모에서 생긴 기록"}</small></span><span class="mmc-hold-actions"><button class="mmc-btn mmc-sm" data-action="branch-hold-keep" data-kind="${key}" data-index="${index}">이 분기에 넣기</button><button class="mmc-btn mmc-sm mmc-ghost" data-action="branch-hold-drop" data-kind="${key}" data-index="${index}">빼기</button></span></article>`).join("")}</div></section>`;
      }).join("");
      return `<div class="mmc-layer-backdrop" data-action="close-layer"><section class="mmc-layer mmc-source-layer" data-layer-stop>
      <header><div><span class="mmc-kicker">BRANCH CHECK</span><h3>분기 확인 대기</h3><small>분기 시점 ${esc(sourceDate(hold.cutAt) || hold.cutAt || "")} 이후 부모 RP에서 생기거나 바뀐 기록이에요. 이 분기에는 넣지 않고 기다리는 중이에요.</small></div><button class="mmc-icon-btn" data-action="close-layer">${SVG.close}</button></header>
      <div class="mmc-layer-body"><div class="mmc-candidate-note">'이 분기에 넣기'를 누르면 그 기록이 이 분기의 기억으로 들어가요. '빼기'는 이 분기 보관함에서만 지우고, 부모 RP의 기록은 그대로예요.</div>${groups || '<div class="mmc-empty">확인할 기록이 없어요.</div>'}</div>
      <footer><button class="mmc-btn mmc-danger" data-action="branch-hold-drop" data-kind="all" data-index="all">모두 빼기</button><div><button class="mmc-btn" data-action="close-layer">나중에</button><button class="mmc-btn mmc-primary" data-action="branch-hold-keep" data-kind="all" data-index="all">모두 이 분기에 넣기</button></div></footer>
    </section></div>`;
    }
    function restoreHeldRecord(data, key, row) {
      const clean = { ...row };
      delete clean.holdReason;
      if (key === "items") {
        if (!data.items.some((item) => item.id === clean.id))
          data.items.unshift(normalizeItem(clean));
        return true;
      }
      if (key === "entities") {
        const memory = data.elementMemory;
        if (memory.entities.some((entity) => entity.id === clean.id))
          return true;
        if (memory.entities.length >= 400)
          return false;
        memory.entities.push(normalizeElement(clean));
        return true;
      }
      if (key === "facts") {
        const entity = data.elementMemory.entities.find((row2) => row2.id === row.entityId);
        if (!entity)
          return false;
        const list = row.list === "historyFacts" ? "historyFacts" : "currentFacts";
        if (![...entity.currentFacts, ...entity.historyFacts].some((fact) => fact.id === row.fact?.id))
          entity[list].push(row.fact);
        const balanced = balanceElementFacts(entity.currentFacts, entity.historyFacts);
        entity.currentFacts = balanced.currentFacts;
        entity.historyFacts = balanced.historyFacts;
        return true;
      }
      if (key === "docs") {
        if (data.wiki.docs.some((doc) => doc.id === clean.id))
          return true;
        if (data.wiki.docs.length >= WIKI_DOC_LIMIT)
          return false;
        data.wiki.docs.push(normalizeWikiDoc(clean));
        return true;
      }
      if (typeof restoreHeldLayerRecord === "function")
        return restoreHeldLayerRecord(data, key, row);
      return false;
    }
    async function resolveBranchHold(kind, index, keep) {
      const data = await freshOwnedData();
      const hold = normalizeBranchHold(data.branchHold);
      const keys = kind === "all" ? BRANCH_HOLD_GROUPS.map(([key]) => key) : [kind];
      let moved = 0;
      let failed = 0;
      for (const key of keys) {
        if (!Array.isArray(hold[key]))
          continue;
        const picked = index === "all" ? hold[key].splice(0) : hold[key].splice(Number(index), 1);
        const back = [];
        for (const row of picked) {
          if (!keep) {
            moved += 1;
            continue;
          }
          if (restoreHeldRecord(data, key, row))
            moved += 1;
          else {
            failed += 1;
            back.push(row);
          }
        }
        hold[key].unshift(...back);
      }
      data.branchHold = branchHoldCount(hold) ? hold : null;
      await persistData(data, { silent: true });
      if (!branchHoldCount(hold))
        state.layer = null;
      toast(`${keep ? `이 분기에 ${moved}개 넣었어요` : `이 분기에서 ${moved}개 뺐어요`}${failed ? ` · ${failed}개는 연결할 요소가 없거나 상한이라 남겨 뒀어요` : ""}`, failed > 0);
      render();
    }
    function layerMarkup() {
      if (state.layer === "branch-hold")
        return branchHoldLayer();
      if (state.layer === "stale")
        return staleLayer();
      if (state.layer === "episode-editor")
        return episodeEditorLayer();
      if (state.layer === "thread-editor")
        return threadEditorLayer();
      if (state.layer === "editor")
        return editorLayer();
      if (state.layer === "element-editor")
        return elementEditorLayer();
      if (state.layer === "element-candidates")
        return elementCandidateLayer();
      if (state.layer === "element-settings")
        return elementSettingsLayer();
      if (state.layer === "wiki-editor")
        return wikiEditorLayer();
      if (state.layer === "wiki-draft")
        return wikiDraftLayer();
      if (state.layer === "wiki-candidates")
        return wikiCandidateLayer();
      if (state.layer === "wiki-proposal")
        return wikiProposalLayer();
      if (state.layer === "wiki-settings")
        return wikiSettingsLayer();
      if (state.layer === "source")
        return sourceLayer();
      if (state.layer === "candidates")
        return candidateLayer();
      if (state.layer === "review-candidates")
        return reviewCandidateLayer();
      if (state.layer === "health-candidates")
        return healthCandidateLayer();
      if (state.layer === "raw-repair")
        return rawRepairLayer();
      if (state.layer === "help")
        return helpLayer();
      if (state.layer === "settings")
        return settingsLayer();
      if (state.layer === "evidence")
        return evidenceLayer();
      if (state.layer === "inject-preview")
        return injectPreviewLayer();
      return "";
    }
    function evidenceIdsMarkup(ids) {
      const rows = safeArray(ids).map(String).filter(Boolean);
      return rows.length ? `<div class="mmc-evidence-ids">${rows.map((id) => `<code>${esc(id)}</code>`).join("")}</div>` : "<small>저장된 원문 ID가 없습니다.</small>";
    }
    function evidenceLayer() {
      const view = state.evidenceView || {};
      if (view.kind === "wiki") {
        const doc = wikiState().docs.find((row) => row.id === view.id);
        if (!doc)
          return "";
        const rows = doc.sources.map((source, index) => `<article class="mmc-evidence-fact ${Number(view.index) === index + 1 ? "is-focus" : ""}"><header class="mmc-evidence-fact-head"><span>[${index + 1}]</span><b>${esc(WIKI_SOURCE_KIND_LABEL[source.kind] || source.kind)}</b><small>${esc(source.label)}</small></header>${source.quote ? `<pre>${esc(source.quote)}</pre>` : "<small>저장된 원문이 없습니다.</small>"}</article>`).join("");
        return `<div class="mmc-layer-backdrop" data-action="close-layer"><section class="mmc-layer mmc-evidence-layer" data-layer-stop><header><div><span class="mmc-kicker">SOURCE EVIDENCE</span><h3>${esc(doc.title)} · 근거</h3></div><button class="mmc-icon-btn" data-action="close-layer">${SVG.close}</button></header><div class="mmc-layer-body">${rows || '<div class="mmc-empty">연결된 근거 자료가 없습니다.</div>'}</div><footer><span></span><button class="mmc-btn mmc-primary" data-action="close-layer">확인</button></footer></section></div>`;
      }
      if (view.kind === "element") {
        const entity = elementMemory().entities.find((row) => row.id === view.id);
        if (!entity)
          return "";
        const groups = [["현재 사실", entity.currentFacts], ["이력", entity.historyFacts]].map(([label, facts]) => {
          const rows = safeArray(facts).filter((fact) => fact.source).map((fact) => `<article class="mmc-evidence-fact"><b>${esc(fact.text)}</b>${evidenceIdsMarkup(fact.source.messageIds)}${safeArray(fact.source.fingerprints).length ? `<details><summary>원문 지문 보기</summary>${evidenceIdsMarkup(fact.source.fingerprints)}</details>` : ""}</article>`).join("");
          return rows ? `<section class="mmc-evidence-group"><h4>${label}</h4>${rows}</section>` : "";
        }).join("");
        return `<div class="mmc-layer-backdrop" data-action="close-layer"><section class="mmc-layer mmc-evidence-layer" data-layer-stop><header><div><span class="mmc-kicker">SOURCE EVIDENCE</span><h3>${esc(entity.name)} · 근거</h3></div><button class="mmc-icon-btn" data-action="close-layer">${SVG.close}</button></header><div class="mmc-layer-body">${groups || '<div class="mmc-empty">표시할 근거 정보가 없습니다.</div>'}</div><footer><span></span><button class="mmc-btn mmc-primary" data-action="close-layer">확인</button></footer></section></div>`;
      }
      const item = safeArray(state.currentData?.items).find((row) => row.id === view.id);
      if (!item)
        return "";
      return `<div class="mmc-layer-backdrop" data-action="close-layer"><section class="mmc-layer mmc-evidence-layer" data-layer-stop><header><div><span class="mmc-kicker">SOURCE EVIDENCE</span><h3>${esc(item.title)} · 근거</h3></div><button class="mmc-icon-btn" data-action="close-layer">${SVG.close}</button></header><div class="mmc-layer-body"><section class="mmc-evidence-group"><h4>저장된 원문</h4>${item.sourceQuote ? `<pre>${esc(item.sourceQuote)}</pre>` : "<small>저장된 원문 인용이 없습니다.</small>"}</section><section class="mmc-evidence-group"><h4>원문 ID</h4>${evidenceIdsMarkup(item.sourceIds)}</section></div><footer><span></span><button class="mmc-btn mmc-primary" data-action="close-layer">확인</button></footer></section></div>`;
    }
    function editorLayer() {
      const d = state.draft || normalizeItem({ type: state.activeTab });
      const isAnchor = d.type === "anchor";
      const source = d.sourceQuote ? `<details class="mmc-source-quote"><summary>가져온 원문 보기</summary><p>${esc(d.sourceQuote)}</p></details>` : "";
      return `<div class="mmc-layer-backdrop" data-action="close-layer"><section class="mmc-layer mmc-editor" data-layer-stop>
      <header><div><span class="mmc-kicker">${isAnchor ? "MEMORY ANCHOR" : "PROMISE NOTE"}</span><h3>${d.id ? "기록 편집" : isAnchor ? "새 기억 앵커" : "새 약속"}</h3></div><button class="mmc-icon-btn" data-action="close-layer">${SVG.close}</button></header>
      <div class="mmc-layer-body">
        <label class="mmc-field"><span>제목</span><input id="mmc-draft-title" value="${esc(d.title)}" maxlength="200"></label>
        <label class="mmc-field"><span>내용</span><textarea id="mmc-draft-content" rows="6">${esc(d.content)}</textarea></label>
        ${hasKoText(d.titleKo, d.contentKo) ? `<details class="mmc-source-quote"><summary>한국어 표시본 보기 · 원문은 위 칸에 그대로 보관됩니다</summary><p>${esc([d.titleKo, d.contentKo].filter(Boolean).join(`
`))}</p></details>` : ""}
        ${isAnchor ? `<div class="mmc-field-row">
          <label class="mmc-field"><span>분류</span><select id="mmc-draft-category">${Object.entries(ANCHOR_CATEGORY_LABEL).map(([id, label]) => `<option value="${id}" ${d.category === id ? "selected" : ""}>${label}</option>`).join("")}</select></label>
          <label class="mmc-field"><span>기억 방식</span><select id="mmc-draft-activation"><option value="always" ${d.activation !== "keyword" ? "selected" : ""}>항상 기억</option><option value="keyword" ${d.activation === "keyword" ? "selected" : ""}>키워드가 나올 때</option></select></label>
        </div>
        <label class="mmc-field"><span>키워드 <small>쉼표로 구분 · 조건부 기억일 때 사용</small></span><input id="mmc-draft-keywords" value="${esc(safeArray(d.keywords).join(", "))}" placeholder="예: 병원, 수술, 진료"></label>
        <div class="mmc-field-row"><label class="mmc-field"><span>중요도</span><select id="mmc-draft-priority">${["high", "normal", "low"].map((p) => `<option value="${p}" ${d.priority === p ? "selected" : ""}>${PRIORITY_LABEL[p]}</option>`).join("")}</select></label><label class="mmc-field"><span>기억 수명</span><select id="mmc-draft-lifespan">${Object.entries(ANCHOR_LIFESPAN_LABEL).map(([id, label]) => `<option value="${id}" ${d.lifespan === id ? "selected" : ""}>${label}</option>`).join("")}</select></label></div>
        <label class="mmc-check-line"><input id="mmc-draft-archived" type="checkbox" ${d.archived ? "checked" : ""}><span>보관만 하고 주입하지 않기</span></label>` : `<div class="mmc-field-row">
          <label class="mmc-field"><span>상태</span><select id="mmc-draft-status">${Object.entries(PROMISE_STATUS_LABEL).map(([id, label]) => `<option value="${id}" ${d.status === id ? "selected" : ""}>${label}</option>`).join("")}</select></label>
          <label class="mmc-field"><span>중요도</span><select id="mmc-draft-priority">${["high", "normal", "low"].map((p) => `<option value="${p}" ${d.priority === p ? "selected" : ""}>${PRIORITY_LABEL[p]}</option>`).join("")}</select></label>
        </div><label class="mmc-field"><span>예정·조건 <small>선택</small></span><input id="mmc-draft-schedule" value="${esc(d.scheduleText || "")}" placeholder="예: 이번 주말 / 퇴원 후 / 다음 비 오는 날"></label>`}
        ${state.chatCharacters.length >= 2 || isRestrictedItem(d) ? `<div class="mmc-field"><span>아는 인물 <small>${restrictionEffective() ? "비우면 모든 인물이 아는 기억 · 고르면 그 인물에게만 들어가요" : "비우면 모든 인물이 아는 기억 · 병합 그룹이라 고르면 주입하지 않아요"}</small></span>${scopeControl("draft", 0, d.knownBy)}</div>` : ""}
        ${source}
      </div>
      <footer>${d.id ? `<button class="mmc-btn mmc-danger" data-action="delete-item" data-id="${esc(d.id)}">${SVG.trash}<span>삭제</span></button>` : `<span></span>`}<div><button class="mmc-btn" data-action="close-layer">취소</button><button class="mmc-btn mmc-primary" data-action="save-draft">저장</button></div></footer>
    </section></div>`;
    }
    function sourceRow(row) {
      const checked = state.sourceSelected.has(String(row.id));
      const meta = state.sourceMode === "summaries" ? row.sourceKind === AM_SCENE_SOURCE ? `고급 메모리 장면${row.timeline ? ` · ${row.timeline}` : ""}${row.startIndex ? ` · #${row.startIndex}–${row.endIndex}` : ""}${sourceRowAudience(row).restricted ? ` · 일부만 앎${sourceRowAudience(row).audienceIds.length ? `: ${knownByLabel(sourceRowAudience(row).audienceIds)}` : ""}` : ""}` : `${row.origin === "automated" ? "자동 요약" : row.origin === "manual" ? "수동 요약" : "요약"}${row.messageCount ? ` · ${row.messageCount}개 메시지` : ""}${hasCharacterConditions(row.content) ? " · 인물별 구간 있음" : ""}` : `${roleLabel(row.role)}${row.createdAt ? ` · ${sourceDate(row.createdAt)}` : ""}`;
      const title = state.sourceMode === "summaries" ? String(row.title || "요약") : truncate(String(row.content || ""), 72);
      const body = state.sourceMode === "summaries" ? labelCharacterConditions(row.content) : String(row.content || "");
      return `<label class="mmc-source-row ${checked ? "is-selected" : ""}"><input type="checkbox" data-source-id="${esc(row.id)}" ${checked ? "checked" : ""}><span class="mmc-source-copy"><b>${esc(title)}</b><small>${esc(meta)}</small><p>${esc(truncate(body, 300))}</p></span></label>`;
    }
    function connectionOptions() {
      if (!state.connections.length)
        return '<option value="">사용 가능한 모델 연결 없음</option>';
      return state.connections.map((c) => {
        const label = c.model && !c.label.includes(c.model) ? `${c.label} · ${c.model}` : c.label;
        return `<option value="${esc(c.id)}" ${c.id === state.modelConnectionId ? "selected" : ""}>${esc(label)}</option>`;
      }).join("");
    }
    function sourceLayer() {
      const isReview = state.sourceTarget === "review";
      const title = isReview ? "새 요약 검토" : state.sourceMode === "summaries" ? "순정 요약에서 가져오기" : "최근 대화에서 가져오기";
      const empty = state.sourceMode === "summaries" ? "이 방에는 아직 분석할 요약이 없습니다. 사용자 메시지가 설정한 횟수만큼 쌓이면 자동으로 만들어집니다." : "불러올 최근 메시지가 없습니다.";
      const modelTitle = isReview ? "약속 + 앵커 통합 정리" : "약속 + 앵커 한 번에 분류";
      const modelHelp = isReview ? "선택한 새 요약과 현재 활성 기록을 함께 비교합니다. 모델은 제안만 하고 자동 적용하지 않습니다." : "선택한 원문은 모델에 한 번만 보내며, 같은 응답에서 약속과 앵커를 함께 분류합니다. DeepSeek 연결이 있으면 처음 기본값으로 우선합니다.";
      const footer = isReview ? `<button class="mmc-btn" data-action="source-mark-reviewed" ${state.sourceSelected.size ? "" : "disabled"}>검토 완료로 표시</button><div><button class="mmc-btn" data-action="source-local-promise" ${state.sourceSelected.size ? "" : "disabled"}>약속으로 수동 정리</button><button class="mmc-btn" data-action="source-local-anchor" ${state.sourceSelected.size ? "" : "disabled"}>앵커로 수동 정리</button><button class="mmc-btn mmc-model-btn" data-action="source-model-review" ${state.sourceSelected.size && state.modelConnectionId ? "" : "disabled"}>${SVG.spark}<span>모델로 통합 정리</span></button></div>` : `<span></span><div><button class="mmc-btn" data-action="source-local" ${state.sourceSelected.size ? "" : "disabled"}>로컬로 가져오기</button><button class="mmc-btn mmc-model-btn" data-action="source-model" ${state.sourceSelected.size && state.modelConnectionId ? "" : "disabled"}>${SVG.spark}<span>모델로 한 번에 정리</span></button></div>`;
      return `<div class="mmc-layer-backdrop" data-action="close-layer"><section class="mmc-layer mmc-source-layer" data-layer-stop>
      <header><div><span class="mmc-kicker">${isReview ? "SUMMARY UPDATE" : "SOURCE · READ ONLY"}</span><h3>${title}</h3></div><button class="mmc-icon-btn" data-action="close-layer">${SVG.close}</button></header>
      <div class="mmc-layer-body">
        ${isReview ? '<div class="mmc-candidate-note">새 요약 자체는 수정하지 않습니다. 필요한 기억만 약속/앵커에 반영한 뒤 이 알림을 검토 완료로 표시합니다.</div>' : ""}
        ${state.sourceMode === "messages" && hiddenSkipNote("source") ? `<div class="mmc-candidate-note">${esc(hiddenSkipNote("source"))}</div>` : ""}
        <div class="mmc-source-toolbar"><button class="mmc-btn" data-action="source-select-all">전체 선택</button><button class="mmc-btn" data-action="source-clear">해제</button><span>${state.sourceSelected.size}개 선택 · 약 ${estimateTokens(sourceToText())} tokens</span></div>
        <div class="mmc-source-list">${state.sourceRows.length ? state.sourceRows.map(sourceRow).join("") : `<div class="mmc-empty">${empty}</div>`}</div>
        <section class="mmc-model-strip"><div><b>${modelTitle}</b><small>${modelHelp}</small></div><select id="mmc-source-model">${connectionOptions()}</select></section>
      </div>
      <footer>${footer}</footer>
    </section></div>`;
    }
    function scopeControl(kind, index, knownByIds, { needsReview = false, confirmed = false } = {}) {
      const ids = normalizeKnownBy(knownByIds);
      const pending = needsReview && !confirmed && !ids.length;
      const groupWarn = ids.length && !restrictionEffective() ? `<small class="mmc-scope-warn mmc-scope-group-warn">병합 그룹 모드에서는 인물별로 가려 넣을 수 없어 이 기억은 주입하지 않아요. 개별 응답 모드에서만 들어갑니다.</small>` : "";
      if (state.chatCharacters.length < 2) {
        return ids.length ? `<span class="mmc-scope"><small class="mmc-scope-label">${SVG.lock}아는 인물 · ${esc(knownByLabel(ids))}</small>${groupWarn}</span>` : "";
      }
      const chips = state.chatCharacters.map((c) => `<label class="mmc-scope-chip ${ids.includes(c.id) ? "is-on" : ""}"><input type="checkbox" data-scope-kind="${kind}" data-scope-index="${index}" data-scope-char="${esc(c.id)}" ${ids.includes(c.id) ? "checked" : ""}><span>${esc(c.name)}</span></label>`).join("");
      const label = ids.length ? `${SVG.lock}아는 인물만 · ${esc(knownByLabel(ids))}` : confirmed || !needsReview ? "모두가 아는 기억" : "공개 범위 확인 필요";
      const publicBtn = needsReview && !(confirmed && !ids.length) ? `<button type="button" class="mmc-btn mmc-sm mmc-ghost" data-action="scope-public" data-scope-kind="${kind}" data-scope-index="${index}">모두에게 공개</button>` : "";
      const warn = pending ? `<small class="mmc-scope-warn">일부 인물만 아는 내용이 섞인 원문이에요. 아는 인물을 고르거나 '모두에게 공개'를 눌러야 적용돼요.</small>` : "";
      return `<span class="mmc-scope ${pending ? "is-pending" : ids.length ? "is-restricted" : ""}"><small class="mmc-scope-label">${label}</small><span class="mmc-scope-chips">${chips}${publicBtn}</span>${warn}${groupWarn}</span>`;
    }
    function refreshDraftScopeDom(scopeEl) {
      if (!scopeEl)
        return;
      const ids = Array.from(scopeEl.querySelectorAll("input[data-scope-char]:checked")).map((box) => String(box.dataset.scopeChar || ""));
      const label = scopeEl.querySelector(".mmc-scope-label");
      if (label)
        label.innerHTML = ids.length ? `${SVG.lock}아는 인물만 · ${esc(knownByLabel(ids))}` : "모두가 아는 기억";
      scopeEl.classList.toggle("is-restricted", ids.length > 0);
      let warn = scopeEl.querySelector(".mmc-scope-group-warn");
      if (ids.length && !restrictionEffective()) {
        if (!warn) {
          warn = document.createElement("small");
          warn.className = "mmc-scope-warn mmc-scope-group-warn";
          scopeEl.append(warn);
        }
        warn.textContent = "병합 그룹 모드에서는 인물별로 가려 넣을 수 없어 이 기억은 주입하지 않아요. 개별 응답 모드에서만 들어갑니다.";
      } else
        warn?.remove();
    }
    function scopeTarget(kind, index) {
      if (kind === "review")
        return state.reviewCandidates[Number(index)] || null;
      if (kind === "candidate")
        return state.candidates[Number(index)] || null;
      return episodeScopeTarget(kind, index) || threadScopeTarget(kind, index);
    }
    function candidateRow(item, index) {
      const checked = state.candidateSelected.has(String(index));
      const detail = item.type === "anchor" ? ["앵커", ANCHOR_CATEGORY_LABEL[item.category] || "설정·사실", ANCHOR_LIFESPAN_LABEL[item.lifespan] || "영구"].join(" · ") : ["약속", PRIORITY_LABEL[item.priority] || "보통"].join(" · ");
      return `<label class="mmc-candidate is-${item.type === "promise" ? "promise" : "anchor"} ${checked ? "is-selected" : ""}"><input type="checkbox" data-candidate-index="${index}" ${checked ? "checked" : ""}><span><b>${esc(item.title)}</b><small>${esc(detail)}</small><p>${esc(item.content)}</p>${safeArray(item.keywords).length ? `<em>${esc(item.keywords.join(" · "))}</em>` : ""}${item.duplicateOf ? `<small class="mmc-scope-warn">중복 의심 · 같은 제목의 기록이 이미 있어요. 기존 기록을 고치는 편이 나을 수 있어요.</small>` : ""}${scopeControl("candidate", index, item.knownByIds, { needsReview: item.scopeNeedsReview, confirmed: item.scopeConfirmed })}</span></label>`;
    }
    function candidateGroup(type) {
      const label = type === "promise" ? "약속" : "기억 앵커";
      const hint = type === "promise" ? "앞으로 지키거나 실행할 약속·계획" : "이후 RP에서 잊으면 곤란한 관계·상태·사건·설정";
      const indices = state.candidates.map((item, index) => ({ item, index })).filter(({ item }) => item.type === type).sort((a, b) => Number(state.candidateSelected.has(String(b.index))) - Number(state.candidateSelected.has(String(a.index)))).map(({ index }) => index);
      if (!indices.length)
        return "";
      return `<section class="mmc-candidate-group is-${type}"><div class="mmc-candidate-group-head"><span class="mmc-type-chip">${label}</span><div><b>${label} 후보 ${indices.length}개</b><small>${hint}</small></div></div><div class="mmc-candidate-list" data-candidate-group="${type}">${indices.map((index) => candidateRow(state.candidates[index], index)).join("")}</div></section>`;
    }
    function candidateLayer() {
      const groups = `${candidateGroup("promise")}${threadCandidateGroup("cand", state.candThreads, state.candThreadSelected)}${candidateGroup("anchor")}${episodeCandidateGroup("cand", state.candEpisodes, state.candEpisodeSelected)}`;
      return `<div class="mmc-layer-backdrop" data-action="close-layer"><section class="mmc-layer mmc-source-layer" data-layer-stop>
      <header><div><span class="mmc-kicker">MODEL SUGGESTIONS</span><h3>약속 · 기억 앵커 후보</h3></div><button class="mmc-icon-btn" data-action="close-layer">${SVG.close}</button></header>
      <div class="mmc-layer-body"><div class="mmc-candidate-note">한 번의 모델 정리 결과를 약속과 기억 앵커로 나눠 표시합니다. 체크한 항목만 실제 보관함에 저장되며, 선택한 후보는 각 분류 안에서 위쪽으로 모입니다.</div>${bulkToolbar("candidate", "저장 전 닫기에는 확인창이 표시됩니다.")}${groups || '<div class="mmc-empty">후보를 찾지 못했습니다.</div>'}</div>
      <footer><span></span><div><button class="mmc-btn" data-action="close-layer">취소</button><button class="mmc-btn mmc-primary" data-action="save-candidates" ${state.candidateSelected.size || state.candEpisodeSelected.size || state.candThreadSelected.size ? "" : "disabled"}>선택 ${state.candidateSelected.size + state.candEpisodeSelected.size + state.candThreadSelected.size}개 추가</button></div></footer>
    </section></div>`;
    }
    function reviewCandidateRow(item, index) {
      const checked = state.reviewSelected.has(String(index));
      const existing = item.targetId ? safeArray(state.currentData?.items).find((row) => row.id === item.targetId) : null;
      const conflict = !!(existing && item.baseUpdatedAt && existing.updatedAt !== item.baseUpdatedAt);
      const title = item.title || existing?.title || "기억 기록";
      const content = item.content || existing?.content || item.reason || "";
      const detail = [REVIEW_ACTION_LABEL[item.action] || item.action, REVIEW_TYPE_LABEL[item.type] || item.type, item.category ? ANCHOR_CATEGORY_LABEL[item.category] : "", item.type === "anchor" ? ANCHOR_LIFESPAN_LABEL[item.lifespan] : ""].filter(Boolean).join(" · ");
      const before = existing && ["update", "complete", "archive"].includes(item.action) ? `<small class="mmc-review-before">기존: ${esc(truncate(existing.content || existing.title, 150))}</small>` : "";
      const dup = item.action === "add" && item.duplicateOf ? safeArray(state.currentData?.items).find((row) => row.id === item.duplicateOf) : null;
      const dupNote = dup ? `<small class="mmc-scope-warn">중복 의심 · 이미 '${esc(truncate(dup.title, 40))}' 기록이 있어요. 새로 추가하면 같은 일이 두 번 쌓여요. <button type="button" class="mmc-btn mmc-sm mmc-ghost" data-action="review-to-update" data-index="${index}">기존 기록 갱신으로 바꾸기</button></small>` : "";
      return `<label class="mmc-candidate mmc-review-candidate is-${item.type === "promise" ? "promise" : "anchor"} ${checked ? "is-selected" : ""} ${conflict ? "is-conflict" : ""}"><input type="checkbox" data-review-index="${index}" ${checked ? "checked" : ""} ${item.action === "keep" || conflict ? "disabled" : ""}><span><b>${esc(title)}</b><small><strong data-review-action="${esc(item.action)}">${esc(detail)}</strong></small>${conflict ? '<small class="mmc-conflict-note">충돌 · 후보 생성 뒤 원본이 수정되어 자동 적용하지 않습니다.</small>' : ""}${before}${dupNote}<p>${esc(content)}</p>${item.reason ? `<em>${esc(item.reason)}</em>` : ""}${["add", "update"].includes(item.action) ? scopeControl("review", index, item.knownByIds, { needsReview: item.scopeNeedsReview, confirmed: item.scopeConfirmed }) : ""}</span></label>`;
    }
    function reviewCandidateGroup(type) {
      const label = type === "promise" ? "약속" : "기억 앵커";
      const indices = state.reviewCandidates.map((item, index) => ({ item, index })).filter(({ item }) => item.type === type).sort((a, b) => Number(state.reviewSelected.has(String(b.index))) - Number(state.reviewSelected.has(String(a.index)))).map(({ index }) => index);
      if (!indices.length)
        return "";
      return `<section class="mmc-candidate-group is-${type}"><div class="mmc-candidate-group-head"><span class="mmc-type-chip">${label}</span><div><b>${label} 갱신 ${indices.length}개</b><small>${type === "promise" ? "추가·갱신·완료 후보" : "추가·갱신·보관 후보"}</small></div></div><div class="mmc-candidate-list" data-review-group="${type}">${indices.map((index) => reviewCandidateRow(state.reviewCandidates[index], index)).join("")}</div></section>`;
    }
    function reviewCandidateLayer() {
      const actionable = state.reviewCandidates.some((item) => item.action !== "keep") || state.reviewEpisodes.length > 0 || state.reviewThreads.length > 0;
      const groups = `${reviewCandidateGroup("promise")}${threadCandidateGroup("rev", state.reviewThreads, state.reviewThreadSelected)}${reviewCandidateGroup("anchor")}${episodeCandidateGroup("rev", state.reviewEpisodes, state.reviewEpisodeSelected)}`;
      return `<div class="mmc-layer-backdrop" data-action="close-layer"><section class="mmc-layer mmc-source-layer" data-layer-stop>
      <header><div><span class="mmc-kicker">MEMORY UPDATE REVIEW</span><h3>약속 · 앵커 갱신 제안</h3></div><button class="mmc-icon-btn" data-action="close-layer">${SVG.close}</button></header>
      <div class="mmc-layer-body"><div class="mmc-candidate-note">새 요약과 현재 기록을 비교한 결과입니다. 약속과 기억 앵커를 분리해 표시하며 ADD/UPDATE/COMPLETE/ARCHIVE는 체크한 것만 적용됩니다. KEEP은 참고 표시입니다.</div>${bulkToolbar("review", "전체 보류는 선택만 풀어요. 후보는 승인 대기에 남아요.")}${groups || '<div class="mmc-empty">새로 반영할 기억을 찾지 못했습니다. 아래 버튼으로 이번 요약을 검토 완료 처리할 수 있습니다.</div>'}</div>
      <footer><div><button class="mmc-btn mmc-danger" data-action="discard-review">후보 폐기</button><button class="mmc-btn" data-action="review-mark-done">이번 요약 검토 완료</button></div><div><button class="mmc-btn" data-action="close-layer">나중에</button><button class="mmc-btn mmc-primary" data-action="apply-review" ${(state.reviewSelected.size || state.reviewEpisodeSelected.size || state.reviewThreadSelected.size) && actionable ? "" : "disabled"}>선택 ${state.reviewSelected.size + state.reviewEpisodeSelected.size + state.reviewThreadSelected.size}개 적용</button></div></footer>
    </section></div>`;
    }
    function healthCandidateRow(item, index) {
      const checked = state.healthSelected.has(String(index));
      const existing = item.targetId ? safeArray(state.currentData?.items).find((row) => row.id === item.targetId) : null;
      const conflict = !!(existing && item.baseUpdatedAt && existing.updatedAt !== item.baseUpdatedAt);
      const title = item.title || existing?.title || "기억 기록";
      const content = item.content || existing?.content || item.reason || "";
      const lifespan = item.type === "anchor" ? ANCHOR_LIFESPAN_LABEL[item.lifespan] || "" : "";
      const detail = [REVIEW_ACTION_LABEL[item.action] || item.action, REVIEW_TYPE_LABEL[item.type] || item.type, item.category ? ANCHOR_CATEGORY_LABEL[item.category] : "", lifespan].filter(Boolean).join(" · ");
      const before = existing && ["update", "complete", "archive"].includes(item.action) ? `<small class="mmc-review-before">기존: ${esc(truncate(existing.content || existing.title, 150))}</small>` : "";
      return `<label class="mmc-candidate mmc-review-candidate is-${item.type === "promise" ? "promise" : "anchor"} ${checked ? "is-selected" : ""} ${conflict ? "is-conflict" : ""}"><input type="checkbox" data-health-index="${index}" ${checked ? "checked" : ""} ${item.action === "keep" || conflict ? "disabled" : ""}><span><b>${esc(title)}</b><small><strong data-review-action="${esc(item.action)}">${esc(detail)}</strong></small>${conflict ? '<small class="mmc-conflict-note">충돌 · 검토 뒤 원본이 수정되어 적용하지 않습니다.</small>' : ""}${before}<p>${esc(content)}</p>${item.reason ? `<em>${esc(item.reason)}</em>` : ""}</span></label>`;
    }
    function healthCandidateLayer() {
      const actionable = state.healthCandidates.some((item) => item.action !== "keep");
      const order = state.healthCandidates.map((_, index) => index).sort((a, b) => Number(state.healthSelected.has(String(b))) - Number(state.healthSelected.has(String(a))));
      return `<div class="mmc-layer-backdrop" data-action="close-layer"><section class="mmc-layer mmc-source-layer" data-layer-stop>
      <header><div><span class="mmc-kicker">MEMORY HEALTH CHECK</span><h3>기억 건강검진</h3></div><button class="mmc-icon-btn" data-action="close-layer">${SVG.close}</button></header>
      <div class="mmc-layer-body"><div class="mmc-candidate-note">현재 약속·앵커와 최근 요약을 비교해 중복, 모순, 오래된 현재 상태, 끝난 사건, 지나치게 긴 기억을 점검했습니다. 모델은 제안만 하며 체크한 변경만 적용됩니다. 새 사실을 임의로 추가하지 않습니다.</div>${bulkToolbar("health", "적용 전 닫기에는 확인창이 표시됩니다.")}<div class="mmc-candidate-list">${state.healthCandidates.length ? order.map((index) => healthCandidateRow(state.healthCandidates[index], index)).join("") : '<div class="mmc-empty">정리할 문제를 찾지 못했습니다. 현재 기억 상태를 그대로 유지해도 됩니다.</div>'}</div></div>
      <footer><span></span><div><button class="mmc-btn" data-action="close-layer">닫기</button><button class="mmc-btn mmc-primary" data-action="apply-health" ${state.healthSelected.size && actionable ? "" : "disabled"}>선택 ${state.healthSelected.size}개 적용</button></div></footer>
    </section></div>`;
    }
    function rawRepairLayer() {
      const recovery = state.rawRecovery || { kind: "candidate", text: "", rows: [] };
      const label = recovery.kind === "review" ? "약속 · 앵커 통합 정리" : recovery.kind === "health" ? "기억 건강검진" : recovery.kind === "element" ? "요소 기억 추출" : recovery.kind === "wiki" ? "이야기 위키 초안" : recovery.kind === "wiki-update" ? "이야기 위키 변경 제안" : "약속 · 기억 앵커 통합 후보";
      return `<div class="mmc-layer-backdrop" data-action="close-layer"><section class="mmc-layer mmc-raw-repair" data-layer-stop>
      <header><div><span class="mmc-kicker">MODEL RESPONSE RECOVERY</span><h3>모델 응답 복구</h3></div><button class="mmc-icon-btn" data-action="close-layer">${SVG.close}</button></header>
      <div class="mmc-layer-body"><div class="mmc-candidate-note"><b>${esc(label)}</b> 응답을 JSON으로 바로 읽지 못했습니다. 자동 복구를 이미 시도했으며, 아래 원문은 재호출 없이 보존되어 있습니다. 그대로 <b>다시 읽기</b>를 먼저 눌러보고, 실패하면 JSON 부분만 남기거나 끝 쉼표 등을 고쳐 다시 읽어 주세요.</div><textarea id="mmc-raw-repair-text" spellcheck="false" aria-label="모델 원문 응답">${esc(recovery.text)}</textarea></div>
      <footer><button class="mmc-btn mmc-danger" data-action="discard-raw-recovery">응답 버리기</button><div><button class="mmc-btn mmc-primary" data-action="parse-raw-recovery">수정본 다시 읽기</button></div></footer>
    </section></div>`;
    }
    async function applyRecoveredRows(text) {
      const recovery = state.rawRecovery;
      if (!recovery)
        throw new Error("복구할 모델 원문이 없습니다.");
      if (recovery.kind === "wiki") {
        const result = parseWikiDraftJson(text, safeArray(recovery.rows));
        if (!result.ok)
          throw new Error("아직 위키 초안 JSON을 읽지 못했습니다. JSON 객체 부분만 남기거나 문법을 조금 고쳐 다시 시도해 주세요.");
        state.wikiCandidates = result.rows;
        state.wikiCandidateSelected = new Set(result.rows.map((row, i) => String(i)));
        state.rawRecovery = null;
        state.layer = "wiki-candidates";
        toast("모델 응답에서 위키 초안을 복구했습니다.");
        return;
      }
      if (recovery.kind === "wiki-update") {
        const doc = wikiState().docs.find((row) => row.id === String(recovery.docId || ""));
        if (!doc)
          throw new Error("변경 제안을 적용할 문서를 찾지 못했습니다.");
        const result = parseWikiProposalJson(text, doc);
        if (!result.ok)
          throw new Error("아직 변경 제안 JSON을 읽지 못했습니다. JSON 객체 부분만 남기거나 문법을 조금 고쳐 다시 시도해 주세요.");
        await storeWikiProposal(doc, result, safeArray(recovery.rows));
        return;
      }
      if (recovery.kind === "element") {
        const memory = elementMemory();
        const result = parseElementProposalJson(text, memory, safeArray(recovery.rows));
        if (!result.ok)
          throw new Error("아직 요소 기억 JSON을 읽지 못했습니다. JSON 객체 부분만 남기거나 문법을 조금 고쳐 다시 시도해 주세요.");
        state.elementCandidateOverflow = Math.max(0, result.rows.length - ELEMENT_CANDIDATE_LIMIT);
        state.elementCandidates = result.rows.slice(0, ELEMENT_CANDIDATE_LIMIT);
        state.elementCandidateSelected = new Set(state.elementCandidates.map((_, i) => String(i)));
        state.elementExtractInfo = recovery.extractInfo || null;
        state.rawRecovery = null;
        state.layer = "element-candidates";
        toast("모델 응답에서 요소 기억 후보를 복구했습니다.");
        return;
      }
      const mode = recovery.kind === "candidate" ? "mixed-candidate" : recovery.kind;
      const result = parseModelRows(text, mode);
      if (!result.ok)
        throw new Error("아직 JSON 후보를 읽지 못했습니다. JSON 배열/객체 부분만 남기거나 문법을 조금 고쳐 다시 시도해 주세요.");
      if (recovery.kind === "candidate") {
        const parsed = result.rows.map(normalizeCandidate).filter(Boolean).slice(0, 12);
        const rows = selectedSourceRows();
        const episodeCands = extractEpisodeCandidates(result.rows, rows, state.sourceMode);
        const threadCands = extractThreadCandidates(result.rows, rows, state.sourceMode);
        if (!parsed.length && !episodeCands.length && !threadCands.length && result.rows.length)
          throw new Error("JSON은 읽었지만 후보 필드(title/content 등)를 해석하지 못했습니다.");
        state.candThreads = threadCands;
        state.candThreadSelected = preselectThreads(threadCands);
        state.candEpisodes = episodeCands;
        state.candEpisodeSelected = preselectEpisodes(episodeCands);
        state.candBatch = { fps: sourceFingerprintsForRows(rows, state.sourceMode), sourceIds: rows.map((row) => String(row.id || "")).filter(Boolean), rows: rows.map((row) => ({ createdAt: row.createdAt, updatedAt: row.updatedAt, endIndex: row.endIndex })) };
        const quote = sourceToText(rows).slice(0, 12000);
        const ids = rows.map((row) => String(row.id || "")).filter(Boolean);
        const fps = sourceFingerprintsForRows(rows, state.sourceMode);
        state.candidates = parsed.map((item) => ({ ...item, id: "", candidateId: uid("cand"), sourceType: "model", sourceIds: ids, sourceQuote: quote, ...Object.keys(fps).length ? { sourceFingerprints: fps } : {} }));
        if (state.sourceMode === "summaries")
          markScopeReview(state.candidates, rows);
        for (const cand of state.candidates) {
          const dup = safeArray(state.currentData?.items).find((row) => row.type === cand.type && titleKey(row.title) && titleKey(row.title) === titleKey(cand.title));
          if (dup)
            cand.duplicateOf = dup.id;
        }
        state.candidateSelected = new Set(state.candidates.map((item, i) => scopeBlocksApply(item) || item.duplicateOf ? null : String(i)).filter(Boolean));
        state.rawRecovery = null;
        state.layer = "candidates";
        toast(result.repaired ? "모델 응답을 보정해 후보를 복구했습니다." : "모델 응답에서 후보를 복구했습니다.");
        return;
      }
      const normalized = result.rows.map(normalizeReviewCandidate).filter((item) => item && (recovery.kind !== "health" || item.action !== "add")).slice(0, 20);
      if (!normalized.length && result.rows.length)
        throw new Error("JSON은 읽었지만 action/type/targetId 같은 후보 필드를 해석하지 못했습니다.");
      if (recovery.kind === "review") {
        state.reviewCandidates = normalized;
        state.reviewEpisodes = extractEpisodeCandidates(result.rows, safeArray(recovery.rows), "summaries");
        state.reviewEpisodeSelected = preselectEpisodes(state.reviewEpisodes);
        state.reviewThreads = extractThreadCandidates(result.rows, safeArray(recovery.rows), "summaries");
        state.reviewThreadSelected = preselectThreads(state.reviewThreads);
        markScopeReview(state.reviewCandidates, safeArray(recovery.rows));
        state.reviewSelected = new Set(normalized.map((item, i) => item.action === "keep" || scopeBlocksApply(item) ? null : String(i)).filter(Boolean));
        state.reviewSourceRows = safeArray(recovery.rows).slice();
        await persistPendingReview();
        state.rawRecovery = null;
        state.layer = "review-candidates";
      } else {
        state.healthCandidates = normalized;
        state.healthSelected = new Set(normalized.map((item, i) => item.action === "keep" ? null : String(i)).filter(Boolean));
        state.rawRecovery = null;
        state.layer = "health-candidates";
      }
      toast(result.repaired ? "모델 응답을 보정해 제안을 복구했습니다." : "모델 응답에서 제안을 복구했습니다.");
    }
    function helpUsageMarkup() {
      return `<div class="mmc-guide mmc-guide-steps">
      <section><b>1. 이야기 고르기</b><p>머리줄의 <strong>현재 이야기</strong>에서 관리할 RP방을 고릅니다. 약속·기억 앵커·요소 기억·위키는 RP별로 따로 보관됩니다.</p></section>
      <section><b>1-1. 개요 탭</b><p>매 턴 RP에 늘 들어가는 기억의 양(약 tokens)과 구성, 검토할 것(새 요약·위키 변경 제안·예산 대기 앵커 등), 최근 변화를 한 화면에 모아 보여 줍니다. <strong>주입 미리보기</strong>로 실제 들어가는 문장을 확인할 수 있습니다.</p></section>
      <section><b>2. 기억 종류 고르기</b><p><strong>약속</strong>은 앞으로 지킬 계획, <strong>기억 앵커</strong>는 중요한 사건·관계·상태, <strong>요소 기억</strong>은 물건·장소·취향처럼 오래 지나도 이어져야 하는 대상별 사실을 관리합니다. <strong>위키</strong>는 이 셋을 지우지 않고 그 위에 올리는, 사람이 읽고 고치는 문서 계층입니다.</p></section>
      <section><b>2-1. 이야기 위키</b><p>등장인물·관계·장소·물건·사건·조직·세계관을 문서로 정리합니다. <strong>AI 초안</strong>은 이미 저장된 요소 기억·약속·앵커·요약·최근 대화만 근거로 삼아 문서를 씁니다. 기억을 새로 만들지 않고 조직할 뿐입니다. 본문의 <code>[1]</code>을 누르면 그 문장의 근거 원문을 볼 수 있고, <code>[문서 제목]</code>은 다른 문서로 이어집니다.</p></section>
      <section><b>2-2. 위키에서 내 수정이 지워지지 않게 하기</b><p>섹션마다 <strong>\uD83D\uDD12 사용자 편집</strong> 또는 <strong>AI 관리</strong>를 고를 수 있습니다. 새 기억이 생기면 문서를 바로 바꾸지 않고 <strong>변경 제안</strong>으로 보여 주며, 반영을 누른 것만 들어갑니다. 잠근 섹션은 충돌 사실만 알리고 절대 덮어쓰지 않습니다. 제안을 만든 뒤 직접 고친 섹션도 건너뜁니다.</p></section>
      <section><b>2-3. 위키의 세 가지 상태</b><p>서로 다른 기능입니다. <strong>AI 수정 잠금</strong>은 내용 변경만 막고 참조는 그대로 허용합니다. <strong>AI 참조 제외</strong>는 RP 생성 컨텍스트에서만 뺍니다. <strong>항상 기억</strong>은 본문 전체가 아니라 <strong>개요 한 줄만</strong> 상시 주입하고, 본문은 키워드가 맞을 때만 불러옵니다.</p></section>
      <section><b>3. 요소 기억 추출</b><p>요소 탭에서 최근 N턴 또는 직접 지정한 완결 RP 턴을 모델에게 읽힙니다. 모델은 후보만 만들며, 저장 전에 이름·현재 사실·이력·검색 조건을 직접 고칠 수 있습니다.</p></section>
      <section><b>4. 검색 조건</b><p>별칭은 같은 대상의 다른 이름이고 자동 검색어가 아닙니다. <strong>단독 호출어</strong>는 하나만 등장해도 호출되고, <strong>조합 호출조건</strong>은 같은 줄의 모든 단어가 있어야 호출됩니다.</p></section>
      <section><b>5. 새 요약이 생겼을 때</b><p>새 순정 요약은 기존 약속·앵커 갱신 알림에 사용됩니다. 요소 기억 수동 추출은 요약이 아니라 원문 RP를 직접 읽습니다.</p></section>
      <section><b>고급 메모리를 사용할 때</b><p>고급 메모리가 켜져 있으면 엔진이 순정 자동 요약을 만들지 않습니다. 대신 고급 메모리가 완료한 <strong>장면 요약</strong>을 읽기만 해서 새 장면이 생기면 검토 대기에 띄웁니다. 장면 요약에서 나온 후보는 자동 적용하지 않고 직접 확인해 적용합니다. 보관함이 매 턴 넣는 기억은 고급 메모리 문맥 예산에서 먼저 빠집니다.</p></section>
      <section><b>일부 인물만 아는 기억</b><p>그룹 RP에서 고급 메모리가 일부 인물에게만 보여 준 장면이나 인물별 구간에서 나온 후보는 <strong>아는 인물</strong>을 고르거나 <strong>모두에게 공개</strong>를 눌러야 적용됩니다. 아는 인물을 고른 기억은 그 인물이 응답할 때만 들어가며, 병합 그룹 응답에서는 가려 넣을 수 없어 넣지 않습니다. 이런 기억은 건강검진과 위키 초안에도 쓰지 않습니다.</p></section>
      <section><b>진행 흐름</b><p>우산 돌려주기, 시험 준비, 계약 협상처럼 이어지는 일을 <strong>지금 상태</strong>와 <strong>상태 기록</strong>으로 추적합니다. 새 요약·장면을 모델로 정리할 때 함께 제안되고, 직접 만들 수도 있습니다. 같은 일의 약속이 있으면 약속에 연결되어 약속 블록과 겹치지 않게 상태 한 줄만 들어갑니다. 해결된 흐름을 다시 여는 제안은 해결 기록보다 나중 근거와 인용이 있을 때만 나오고, 직접 골라야 적용됩니다. 일부 인물만 아는 최신 상태는 그 인물에게만 들어갑니다.</p></section>
      <section><b>장면 기억</b><p>장면마다 배경(날짜·시간대·장소), 사건(개요·참여 인물·핵심 행동), 사실(아는 인물·유효 상태), 인물 변화를 정리합니다. 따로 모델을 부르지 않고 새 요약·장면 정리 때 함께 만들어집니다. 장소나 키워드가 대화에 나올 때 '현재' 사실만 들어갑니다. 같은 근거가 바뀌어 다시 정리되면 옛 장면 기억은 지우지 않고 '지난 판'으로 남깁니다.</p></section>
      <section><b>분기 · 근거가 바뀐 기억</b><p>분기를 만들면 보관함을 열지 않아도 부모 책을 떼고 분기 전용 책을 만듭니다. 분기 시점 뒤에 부모에서 생기거나 바뀐 기록은 '분기 확인 대기'로 옮겨 넣지 않고, 고른 것만 분기에 넣습니다. 근거 요약·장면·메시지가 바뀌거나 지워지면 기억은 그대로 넣되 '근거가 바뀐 기억'으로 알려 줍니다.</p></section>
      <section><b>Lorebook Keeper와 함께 쓸 때</b><p>보관함 항목은 모두 잠겨 있어 Keeper가 덮어쓰지 않습니다. Keeper의 대상 로어북이 비어 있으면 보관함 책에 새 항목이 섞일 수 있으니 다른 책을 지정하세요.</p></section>
      <section><b>소유권 경고가 보일 때</b><p>설정 프로필에서 다른 RP의 metadata가 들어온 경우 기억을 격리합니다. 현재 RP와 일치하는 비활성 로어북 백업이 있으면 기억 복구를 우선하고, 의도적인 복사일 때만 격리 데이터를 현재 RP용으로 확정하세요.</p></section>
      <section><b>6. 설정</b><p>보관함 설정은 화면(테마·글자)·주입·자동화·모델·로어북 탭으로 나뉩니다. 요소 기억과 이야기 위키의 모델·지침·주입 ON/OFF는 각 기능의 설정에서 따로 조절합니다. 위키 설정의 <strong>모양</strong>은 보관함 테마를 그대로 보여 주고, 바꾸기를 누르면 보관함 설정의 테마로 이동합니다.</p></section>
      <section><b>설치할 때</b><p>메시지·채팅 metadata·로어북을 연결해야 하므로 Full page access 권한이 필요합니다. 확장 코드를 검토하고 신뢰하는 경우에만 승인하세요.</p></section>
    </div>`;
    }
    function helpFeaturesMarkup() {
      return `<div class="mmc-guide mmc-guide-features">
      <section><b>약속 보관</b><p>약속·계획을 진행 중 / 보류 / 완료 / 취소 상태로 관리하고, 진행 중인 약속만 현재 기억에 전달합니다.</p></section>
      <section><b>기억 앵커</b><p>관계, 현재 상태, 진행 사건, 성향·취향, 설정·사실, 주의사항을 고정합니다. 항상 기억 또는 키워드 발동을 선택할 수 있습니다.</p></section>
      <section><b>요소 기억</b><p>물건·장소·취향·소유·위치·현재 상태를 대상별로 누적합니다. current/이력을 분리하고, 원문에서 찾은 후보를 사용자가 승인한 뒤에만 저장합니다.</p></section>
      <section><b>요소 검색 조건</b><p>별칭과 검색 조건을 분리해 일반명사 오발화를 줄입니다. 검색 테스트에서 어떤 조건으로 어떤 요소가 호출되는지 미리 확인할 수 있습니다.</p></section>
      <section><b>이야기 위키</b><p>기존 기억을 대체하지 않고 그 위에 얹는 편집 레이어입니다. 분류와 <code>/</code> 하위 분류, 개요, Markdown 본문, 별칭, 한국어·영어 키워드, 관련 문서, 근거 자료를 문서 단위로 보관합니다.</p></section>
      <section><b>위키 근거와 문서 연결</b><p>AI가 쓴 문장에는 가능한 범위에서 <code>[1]</code> 같은 근거 번호가 붙고, 눌러서 원본 기억·요약·대화를 확인할 수 있습니다. <code>[문서 제목]</code>으로 문서를 잇고, 이 문서가 참조하는 문서와 이 문서를 참조하는 문서를 양쪽으로 보여 줍니다.</p></section>
      <section><b>위키 변경 제안</b><p>새 기억이 생겨도 문서를 바로 고치지 않습니다. 관련 기억 건수를 알리고, 섹션 단위 diff로 반영·무시를 고르게 합니다. 잠긴 섹션과 그 사이 직접 고친 섹션은 덮어쓰지 않고 충돌만 알립니다.</p></section>
      <section><b>위키 한영 대응</b><p>요소 기억과 같은 검색 엔진을 씁니다. 별칭은 같은 대상의 다른 이름이고, 실제 호출은 한국어·영어 키워드와 조합 호출조건으로만 일어납니다. 한출·영출 어느 쪽에서도 같은 문서를 찾을 수 있습니다.</p></section>
      <section><b>기억 수명 · 작업기억 예산</b><p>앵커에 영구 / 현재 상태 / 사건 종료까지의 수명을 붙이고, 상시 주입할 기억의 글자 예산을 정해 중요한 기억을 짧게 유지합니다.</p></section>
      <section><b>새 요약 갱신</b><p>순정 자동요약이 새로 생기면 기억 갱신이 필요하다는 알림을 표시합니다. 알림만 받기, 모델 분석 후 승인, 실험적 자동 적용 등 처리 방식을 설정할 수 있습니다.</p></section>
      <section><b>모델 1회 통합 분류</b><p>선택한 대화나 요약을 모델에 한 번 보내 약속과 기억 앵커를 동시에 분류합니다. 새 요약 정리에서는 현재 기록과 비교해 추가·갱신·완료·보관·유지를 제안합니다.</p></section>
      <section><b>기억 건강검진</b><p>원할 때만 모델을 호출해 중복·모순·오래된 상태·끝난 사건·완료된 약속·지나치게 긴 기억을 점검합니다. 새 사실을 임의로 추가하지 않고 정리 후보만 제안합니다.</p></section>
      <section><b>로컬 사용</b><p>모델 호출 없이 최근 대화나 순정 요약을 편집 초안으로 가져와 직접 정리할 수 있습니다.</p></section>
      <section><b>안전장치</b><p>모델 후보는 사용자가 선택한 항목만 반영합니다. RP 소유권이 맞지 않는 기억은 자동 로드·주입·동기화하지 않으며, 전용 로어북에는 주입되지 않는 구조화 백업을 보관합니다. 원본 RP 메시지와 순정 요약은 수정하지 않습니다.</p></section>
      <section><b>테마 하나로 전체 색 맞춤</b><p>리본 라일락 · 스토리 로즈 · 아카이브 그린 · 루미버스 테마 따르기 중 하나를 고르면 보관함 전체와 이야기 위키가 같은 색으로 바뀝니다. 위키만 따로 색이 달라지지 않습니다. 현재 사용자 폰트를 따르고, 보관함 안 글자 크기는 따로 조절할 수 있습니다.</p></section>
    </div>`;
    }
    function helpLayer() {
      const tab = state.helpTab === "features" ? "features" : "usage";
      return `<div class="mmc-layer-backdrop" data-action="close-layer"><section class="mmc-layer mmc-help-layer" data-layer-stop>
      <header><div><span class="mmc-kicker">GUIDE</span><h3>기억 보관함 안내</h3></div><button class="mmc-icon-btn" data-action="close-layer">${SVG.close}</button></header>
      <nav class="mmc-help-tabs" aria-label="기억 보관함 안내 탭"><button class="${tab === "usage" ? "is-active" : ""}" data-action="help-tab" data-help-tab="usage">사용법</button><button class="${tab === "features" ? "is-active" : ""}" data-action="help-tab" data-help-tab="features">포함 기능</button></nav>
      <div class="mmc-layer-body">${tab === "features" ? helpFeaturesMarkup() : helpUsageMarkup()}</div>
      <footer><span></span><button class="mmc-btn mmc-primary" data-action="close-layer">확인</button></footer>
    </section></div>`;
    }
    function themePreviewMarkup(id) {
      return `<span class="mmc-tp" data-tp="${id}" aria-hidden="true"><span class="mmc-tp-app"><i></i><b></b><b></b><b></b></span><span class="mmc-tp-wiki"><i></i><b></b><b></b><b></b><s></s></span></span>`;
    }
    function settingsLayer() {
      const data = state.currentData || defaultData();
      const legacy = parseRecord(state.currentChat?.metadata)[LEGACY_PROMISE_KEY];
      const advanced = advancedMemoryEnabled();
      const tab = ["screen", "inject", "auto", "model", "data"].includes(state.settingsTab) ? state.settingsTab : "screen";
      const tabs = [["screen", "화면"], ["inject", "주입"], ["auto", "자동화"], ["model", "모델"], ["data", "로어북"]];
      const themeCards = UI_THEMES.map((theme) => `<label class="mmc-theme-card">
      <input type="radio" name="mmc-ui-theme" value="${theme.id}" ${state.uiThemeMode === theme.id ? "checked" : ""}>
      <span class="mmc-theme-card-ui">${themePreviewMarkup(theme.id)}<strong>${theme.label}</strong><small>${theme.help}</small><i class="mmc-theme-check">✓</i></span>
    </label>`).join("");
      const pane = (id, body) => `<div class="mmc-sheet-pane" data-settings-pane="${id}" ${tab === id ? "" : "hidden"}>${body}</div>`;
      return `<div class="mmc-layer-backdrop" data-action="close-layer"><section class="mmc-layer mmc-settings-layer mmc-sheet" data-layer-stop>
      <header><div class="mmc-sheet-title"><span class="mmc-sheet-icon">${SVG.gear}</span><h3>보관함 설정</h3></div><button class="mmc-icon-btn" data-action="close-layer" aria-label="닫기">${SVG.close}</button></header>
      <nav class="mmc-sheet-nav" role="tablist">${tabs.map(([id, label]) => `<button class="${tab === id ? "is-active" : ""}" data-action="settings-tab" data-settings-tab="${id}" role="tab">${label}</button>`).join("")}</nav>
      <div class="mmc-layer-body">
        ${pane("screen", `
          <section class="mmc-set-card mmc-theme-setting">
            <div class="mmc-set-head"><b>테마</b><small>하나를 고르면 <strong>보관함 전체</strong>(머리줄·탭·약속·앵커·요소·<strong>위키 문서</strong>·설정)가 같은 색으로 바뀌어요. 고르는 즉시 미리 보여 주고, 저장해야 유지돼요.</small></div>
            <div class="mmc-theme-cards">${themeCards}</div>
            <div class="mmc-theme-note">${SVG.info}<span>예전 ‘위키 탭 테마’(나무위키풍 그린)는 <b>아카이브 그린</b>으로 합쳐졌어요. 이제 위키만 따로 색이 달라지지 않아요.</span></div>
          </section>
          <section class="mmc-set-card">
            <div class="mmc-set-head"><b>읽기</b></div>
            <label class="mmc-setting"><span><b>글자 크기</b><small>기억 보관함 안의 글씨만 바뀌어요.</small></span><select id="mmc-ui-font-size"><option value="normal" ${state.uiFontSize === "normal" ? "selected" : ""}>보통</option><option value="large" ${state.uiFontSize === "large" ? "selected" : ""}>크게</option><option value="xlarge" ${state.uiFontSize === "xlarge" ? "selected" : ""}>아주 크게</option></select></label>
            <label class="mmc-setting"><span><b>기억 표시 언어</b><small>약속·앵커·요소 기억·위키 전체에 적용돼요. 원문은 그대로 보존되고 RP에는 언제나 원문만 들어가요.</small></span><select id="mmc-ko-display"><option value="auto" ${state.koDisplay !== "original" ? "selected" : ""}>번역이 있으면 한국어</option><option value="original" ${state.koDisplay === "original" ? "selected" : ""}>항상 원문</option></select></label>
          </section>`)}
        ${pane("inject", `
          <section class="mmc-set-card">
            <div class="mmc-set-head"><b>상시 주입</b><small>매 턴 RP에 들어가는 양을 정해요. 넘치는 항목은 지우지 않고 대기로 남겨요.</small></div>
            <label class="mmc-setting"><span><b>약속 상시 주입 상한</b><small>중요도 순으로 이 개수까지만 넣어요.</small></span><input id="mmc-max-promises" type="number" min="1" max="20" value="${data.maxPromises}"></label>
            <label class="mmc-setting"><span><b>항상 기억 앵커 상한</b><small>키워드 앵커는 조건부라 이 숫자에 들어가지 않아요.</small></span><input id="mmc-max-anchors" type="number" min="1" max="24" value="${data.maxAnchors}"></label>
            <label class="mmc-setting"><span><b>상시 앵커 기억 예산</b><small>항상 기억 앵커 본문에 쓸 최대 글자 수 · 600~12000자.</small></span><input id="mmc-anchor-budget" type="number" min="600" max="12000" step="100" value="${data.anchorBudgetChars}"></label>
            <label class="mmc-setting"><span><b>장면 기억 넣기</b><small>장소·키워드가 대화에 나올 때 그 장면의 '현재' 사실만 넣어요. 끄면 보관만 해요.</small></span><input id="mmc-episode-injection" type="checkbox" ${episodeInjectionOn(data) ? "checked" : ""}></label>
            <label class="mmc-setting"><span><b>상시 기억 총 상한</b><small>약속·항상 앵커·진행 흐름을 합친 대략의 tokens. 넘치면 '중요'가 아닌 오래된 기록부터 대기로 돌려요. 0이면 끔.</small></span><input id="mmc-total-budget" type="number" min="0" max="20000" step="100" value="${Number(data.alwaysBudgetTokens) || 0}"></label>
          </section>`)}
        ${pane("auto", `
          <section class="mmc-set-card">
            <div class="mmc-set-head"><b>새 요약이 생겼을 때</b></div>
            <label class="mmc-setting mmc-setting-model"><span><b>새 요약 갱신 방식</b><small>새 순정 요약이 확인됐을 때 알림과 모델 처리 방식을 정해요. 자동 분석/적용은 선택 모델을 부르므로 API 비용이 생길 수 있어요. 기본값은 ‘알림 + 모델 정리 버튼’이에요.${advanced ? " 지금은 고급 메모리가 켜져 있어 무인 자동 분석·적용은 멈추고 수동 검토만 제공해요." : ""}</small></span><select id="mmc-summary-update-mode">${Object.entries(SUMMARY_UPDATE_MODE_LABEL).map(([id, label]) => `<option value="${id}" ${state.summaryUpdateMode === id ? "selected" : ""}>${label}</option>`).join("")}</select></label>
            <div class="mmc-setting-warning"><b>자동화 단계 안내</b><small><strong>자동 분석 후 승인 대기</strong>는 모델이 후보까지만 만들고 적용은 사용자가 해요. <strong>완전 자동 적용</strong>은 모델 판단이 곧바로 약속/앵커에 반영되는 실험 기능이에요. 고급 메모리 ON에서는 실제 summaryEntries만 알리고 무인 자동 처리는 하지 않아요.</small></div>
          </section>`)}
        ${pane("model", `
          <section class="mmc-set-card">
            <label class="mmc-setting mmc-setting-model"><span><b>후보·갱신 기본 모델</b><small>DeepSeek 연결이 있으면 처음 기본값으로 우선해요. 자동 분석/적용 모드에서는 새 요약을 감지할 때 이 모델이 자동으로 불릴 수 있어요.</small></span><select id="mmc-settings-model">${connectionOptions()}</select></label>
          </section>
          <section class="mmc-setting-block"><div class="mmc-setting-block-head"><span><b>통합 정리 분류 프롬프트</b><small>약속과 기억 앵커를 어떻게 나눌지 정해요. JSON 출력 형식 규칙은 확장이 따로 고정해요.</small></span><button class="mmc-btn mmc-sm" data-action="reset-review-prompt">기본값 복원</button></div><textarea id="mmc-review-prompt" rows="9">${esc(state.reviewPrompt || DEFAULT_REVIEW_PROMPT)}</textarea></section>
          <label class="mmc-setting-block"><span><b>모델 정리 추가 지침</b><small>개인 취향만 덧붙이세요. 예: 사소한 취향은 앵커로 만들지 말 것 / 관계 변화와 신체 상태를 우선.</small></span><textarea id="mmc-review-extra" rows="4" placeholder="선택 사항">${esc(state.reviewExtraInstruction || "")}</textarea></label>`)}
        ${pane("data", `
          <div class="mmc-setting-card"><div><b>전용 로어북</b><small>${data.lorebookId ? `연결 ID ${esc(data.lorebookId)}` : "아직 생성되지 않음"}${data.lastSyncAt ? ` · 최근 동기화 ${esc(sourceDate(data.lastSyncAt))}` : ""}</small>${data.lastSyncError ? `<em>${esc(data.lastSyncError)}</em>` : ""}</div><button class="mmc-btn" data-action="sync" ${ownershipAllowsData() ? "" : "disabled"}>${SVG.sync}<span>다시 동기화</span></button></div>
          <div class="mmc-setting-card"><div><b>기존 약속보관함 기록 가져오기</b><small>${legacy ? "이 RP에서 기존 promiseKeeperV1 데이터를 찾았어요. 원본은 그대로 두고 기억 보관함으로 복사해요." : "이 RP에서는 기존 약속보관함 데이터를 찾지 못했어요."}</small></div><button class="mmc-btn" data-action="import-legacy" ${legacy ? "" : "disabled"}>복사해 가져오기</button></div>
          <div class="mmc-setting-card"><div><b>요소 기억 · 이야기 위키 설정</b><small>추출·주입 지침과 모델은 각 기능의 설정에서 따로 정해요.</small></div><div class="mmc-inline-actions"><button class="mmc-btn" data-action="element-settings">요소 설정</button><button class="mmc-btn" data-action="wiki-settings">위키 설정</button></div></div>`)}
      </div>
      <footer><span></span><div><button class="mmc-btn" data-action="close-layer">취소</button><button class="mmc-btn mmc-primary" data-action="save-settings">저장</button></div></footer>
    </section></div>`;
    }
    function busyMarkup() {
      return `<div class="mmc-busy"><div class="mmc-spinner"></div><b>${esc(state.busyText || "처리 중…")}</b><small id="mmc-busy-time"></small></div>`;
    }
    function setBusy(onValue, text = "처리 중…") {
      state.busy = !!onValue;
      state.busyText = text;
      if (state.busyTimer)
        clearInterval(state.busyTimer);
      state.busyTimer = null;
      if (onValue) {
        state.busyStartedAt = Date.now();
        state.busyTimer = setInterval(() => {
          const node = document.getElementById("mmc-busy-time");
          if (node)
            node.textContent = `${Math.floor((Date.now() - state.busyStartedAt) / 1000)}초 경과`;
        }, 500);
      }
      render();
    }
    function syncFailSuffix() {
      return state.currentData?.lastSyncError ? " · 로어북 동기화는 실패했어요(머리줄 동기화 버튼으로 다시 시도)" : "";
    }
    function toast(message, error = false) {
      let node = document.getElementById(TOAST_ID);
      if (!node) {
        node = document.createElement("div");
        node.id = TOAST_ID;
        node.className = "mmc-toast";
        document.body.append(node);
        applyUiPreferences();
        cleanupFns.push(() => node.remove());
      }
      node.textContent = String(message || "");
      node.classList.toggle("is-error", error);
      node.classList.add("is-show");
      window.clearTimeout(node.__mmcTimer);
      node.__mmcTimer = window.setTimeout(() => node.classList.remove("is-show"), 2600);
    }
    function applyUiPreferences() {
      const fontSize = ["normal", "large", "xlarge"].includes(state.uiFontSize) ? state.uiFontSize : "normal";
      const themeMode = UI_THEME_IDS.includes(state.uiThemeMode) ? state.uiThemeMode : "ribbon";
      const root = document.getElementById(ROOT_ID);
      const launcher = document.getElementById(LAUNCHER_ID);
      const toastNode = document.getElementById(TOAST_ID);
      for (const node of [root, launcher, toastNode]) {
        if (!node)
          continue;
        node.dataset.mmcFontSize = fontSize;
        node.dataset.mmcTheme = themeMode;
        delete node.dataset.mmcWikiTheme;
      }
    }
    function render() {
      const root = document.getElementById(ROOT_ID);
      if (!root)
        return;
      const previousLayer = String(root.dataset.mmcRenderedLayer || "");
      const nextLayer = String(state.layer || "");
      const previousView = String(root.dataset.mmcRenderedView || "");
      const nextView = `${state.activeTab}:${state.activeTab === "wiki" ? state.wikiSelectedId : ""}`;
      const sameView = previousView === nextView;
      const bodyScroll = sameView ? root.querySelector(".mmc-body")?.scrollTop || 0 : 0;
      const wikiScroll = sameView ? root.querySelector(".mmc-wiki-main")?.scrollTop || 0 : 0;
      const wikiListScroll = root.querySelector(".mmc-wiki-list")?.scrollTop || 0;
      const layerScroll = previousLayer === nextLayer ? root.querySelector(".mmc-layer-body")?.scrollTop || 0 : 0;
      applyUiPreferences();
      root.innerHTML = shellMarkup();
      root.dataset.mmcRenderedLayer = nextLayer;
      root.dataset.mmcRenderedView = nextView;
      const nextBody = root.querySelector(".mmc-body");
      if (nextBody && bodyScroll > 0)
        nextBody.scrollTop = bodyScroll;
      const nextWiki = root.querySelector(".mmc-wiki-main");
      if (nextWiki && wikiScroll > 0)
        nextWiki.scrollTop = wikiScroll;
      const nextWikiList = root.querySelector(".mmc-wiki-list");
      if (nextWikiList && wikiListScroll > 0)
        nextWikiList.scrollTop = wikiListScroll;
      const nextLayerBody = root.querySelector(".mmc-layer-body");
      if (nextLayerBody && layerScroll > 0)
        nextLayerBody.scrollTop = layerScroll;
      updateLauncherBadge();
    }
    function closeModal({ force = false } = {}) {
      const hasGeneratedDraft = state.candidates.length > 0 || state.healthCandidates.length > 0 || state.elementCandidates.length > 0 || state.wikiCandidates.length > 0 || !!state.rawRecovery?.text;
      if (!force && hasGeneratedDraft) {
        const message = state.rawRecovery?.text ? `아직 복구하지 않은 모델 원문 응답이 있습니다.
정말 기억 보관함을 닫을까요? 닫으면 이번 응답 원문은 사라집니다.` : state.healthCandidates.length > 0 ? `아직 적용하지 않은 기억 건강검진 제안이 있습니다.
정말 기억 보관함을 닫을까요? 닫으면 이번 모델 결과는 사라집니다.` : `아직 저장하지 않은 모델 후보가 있습니다.
정말 기억 보관함을 닫을까요? 닫으면 이번 모델 결과는 사라집니다.`;
        if (!window.confirm(message))
          return false;
      }
      const root = document.getElementById(ROOT_ID);
      if (root)
        root.hidden = true;
      state.layer = null;
      state.draft = null;
      state.promisePane = "list";
      state.sourceRows = [];
      state.sourceSelected.clear();
      state.candidates = [];
      state.candidateSelected.clear();
      state.elementCandidates = [];
      state.elementCandidateSelected.clear();
      state.elementExtractInfo = null;
      state.elementCandidateOverflow = 0;
      state.elementDraft = null;
      state.wikiCandidates = [];
      state.wikiCandidateSelected.clear();
      state.wikiDraft = null;
      state.wikiSourceRows = [];
      state.wikiSourceSelected.clear();
      state.wikiProposalDocId = "";
      state.wikiProposalSelected.clear();
      state.reviewCandidates = [];
      state.reviewSelected.clear();
      state.reviewSourceRows = [];
      state.healthCandidates = [];
      state.healthSelected.clear();
      state.rawRecovery = null;
      state.evidenceView = null;
      return true;
    }
    async function openModal() {
      const root = document.getElementById(ROOT_ID);
      if (!root)
        return;
      root.hidden = false;
      setBusy(true, "기억 보관함을 불러오는 중…");
      try {
        await loadUiState();
        await loadChats();
        const onScreen = hostActiveChatId();
        if (onScreen && onScreen !== state.selectedChatId && state.chats.some((chat) => chat.id === onScreen))
          state.selectedChatId = onScreen;
        await loadCurrentChat();
        await loadConnections();
        await checkNewSummaries({ refreshChat: false, refreshScenes: true, baselineIfUnknown: true, renderAfter: false });
        try {
          await refreshStaleRecords();
        } catch (error) {
          console.warn("[기억 보관함] source check failed", error);
        }
        saveUiState();
      } catch (error) {
        console.error("[기억 보관함] load failed", error);
        toast(`불러오기 실패: ${error.message}`, true);
      } finally {
        state.busy = false;
        if (state.busyTimer)
          clearInterval(state.busyTimer);
        state.busyTimer = null;
        render();
      }
    }
    function captureDraft() {
      if (!state.draft)
        return;
      state.draft.title = String(document.getElementById("mmc-draft-title")?.value || "").trim();
      state.draft.content = String(document.getElementById("mmc-draft-content")?.value || "").trim();
      state.draft.priority = String(document.getElementById("mmc-draft-priority")?.value || "normal");
      const scopeBoxes = Array.from(document.querySelectorAll('[data-scope-kind="draft"]'));
      if (scopeBoxes.length)
        state.draft.knownBy = scopeBoxes.filter((box) => box.checked).map((box) => String(box.dataset.scopeChar || ""));
      if (state.draft.type === "anchor") {
        state.draft.category = String(document.getElementById("mmc-draft-category")?.value || "setting");
        state.draft.activation = String(document.getElementById("mmc-draft-activation")?.value || "always") === "keyword" ? "keyword" : "always";
        state.draft.keywords = String(document.getElementById("mmc-draft-keywords")?.value || "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 24);
        state.draft.lifespan = Object.prototype.hasOwnProperty.call(ANCHOR_LIFESPAN_LABEL, document.getElementById("mmc-draft-lifespan")?.value) ? document.getElementById("mmc-draft-lifespan").value : "permanent";
        state.draft.archived = Boolean(document.getElementById("mmc-draft-archived")?.checked);
        if (state.draft.archived)
          state.draft.active = false;
      } else {
        state.draft.status = String(document.getElementById("mmc-draft-status")?.value || "active");
        state.draft.scheduleText = String(document.getElementById("mmc-draft-schedule")?.value || "").trim();
      }
    }
    function selectedSourceRows() {
      return state.sourceRows.filter((row) => state.sourceSelected.has(String(row.id)));
    }
    function sourceToText(rows = selectedSourceRows()) {
      if (state.sourceMode === "summaries")
        return rows.map(summaryRowText).join(`

`);
      return rows.map((row) => `${roleLabel(row.role)}: ${row.content || ""}`).join(`

`);
    }
    async function openSource(mode, target) {
      state.sourceMode = mode === "summaries" ? "summaries" : "messages";
      state.sourceTarget = target === "promise" ? "promise" : "anchor";
      state.sourceSelected.clear();
      setBusy(true, state.sourceMode === "summaries" ? "요약을 불러오는 중…" : "최근 대화를 불러오는 중…");
      try {
        if (state.sourceMode === "summaries") {
          const fresh = await api(`chats/${encodeURIComponent(state.selectedChatId)}`);
          state.currentChat = { ...state.currentChat, ...fresh, metadata: parseRecord(fresh?.metadata) };
          const meta = parseRecord(fresh?.metadata);
          let entries = safeArray(meta.summaryEntries).filter((row) => row && String(row.content || "").trim());
          if (!entries.length && String(meta.summary || "").trim())
            entries = [{ id: "legacy-summary", title: "현재 통합 요약", content: String(meta.summary), origin: "legacy", enabled: true }];
          state.sourceRows = entries.filter((row) => row.enabled !== false).slice().sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""))).slice(0, 80);
          if (advancedMemoryEnabled()) {
            await refreshAdvancedMemoryScenes(String(state.selectedChatId || ""));
            state.sourceRows = [...state.amSceneRows.slice().reverse().slice(0, 80), ...state.sourceRows];
          }
        } else {
          const payload = await api(`chats/${encodeURIComponent(state.selectedChatId)}/messages?limit=120`);
          state.sourceRows = readableMessages(extractArray(payload, ["messages", "items", "results"]), "source").slice(-80).reverse();
        }
        state.layer = "source";
      } finally {
        state.busy = false;
        if (state.busyTimer)
          clearInterval(state.busyTimer);
        state.busyTimer = null;
        render();
      }
    }
    function makeLocalDraft(targetOverride = "") {
      const rows = selectedSourceRows();
      if (!rows.length)
        throw new Error("가져올 원문을 선택해 주세요.");
      const fullText = sourceToText(rows);
      const text = fullText.slice(0, 16000);
      const sourceQuote = fullText.slice(0, 12000);
      const sourceIds = rows.map((row) => String(row.id || "")).filter(Boolean);
      const target = targetOverride === "promise" || targetOverride === "anchor" ? targetOverride : state.sourceTarget;
      if (target === "anchor") {
        const first = rows[0];
        state.draft = normalizeAnchor({
          id: "",
          title: state.sourceMode === "summaries" ? String(first?.title || "요약에서 가져온 기억") : "대화에서 가져온 기억",
          content: text,
          sourceType: state.sourceMode === "summaries" ? "summary" : "message",
          sourceIds,
          sourceQuote,
          sourceFingerprints: sourceFingerprintsForRows(rows, state.sourceMode)
        });
      } else {
        state.draft = normalizePromise({
          id: "",
          title: state.sourceMode === "summaries" ? "요약에서 가져온 약속" : "대화에서 가져온 약속",
          content: text,
          sourceType: state.sourceMode === "summaries" ? "summary" : "message",
          sourceIds,
          sourceQuote,
          sourceFingerprints: sourceFingerprintsForRows(rows, state.sourceMode)
        });
      }
      state.draft.id = "";
      state.layer = "editor";
      render();
    }
    function extractGeneratedText(payload) {
      if (typeof payload === "string")
        return payload.trim();
      const seen = new Set;
      const walk = (value, depth = 0) => {
        if (depth > 9 || value == null)
          return "";
        if (typeof value === "string")
          return value.trim();
        if (typeof value !== "object" || seen.has(value))
          return "";
        seen.add(value);
        if (Array.isArray(value)) {
          const parts = value.map((item) => walk(item, depth + 1)).filter(Boolean);
          return parts.join(`
`).trim();
        }
        for (const key of ["content", "text", "output_text", "output", "response", "message"]) {
          const candidate = value?.[key];
          if (typeof candidate === "string" && candidate.trim())
            return candidate.trim();
          const nested = walk(candidate, depth + 1);
          if (nested)
            return nested;
        }
        for (const key of ["data", "result"]) {
          const nested = walk(value?.[key], depth + 1);
          if (nested)
            return nested;
        }
        const choice = Array.isArray(value?.choices) ? value.choices[0] : null;
        if (choice) {
          const nested = walk(choice, depth + 1);
          if (nested)
            return nested;
        }
        return "";
      };
      return walk(payload);
    }
    function collectBalancedJsonFragments(text) {
      const raw = String(text || "");
      const out = [];
      const seen = new Set;
      const push = (value) => {
        const v = String(value || "").trim();
        if (!v || seen.has(v))
          return;
        seen.add(v);
        out.push(v);
      };
      push(raw);
      for (const match of raw.matchAll(/```(?:json|javascript|js)?\s*([\s\S]*?)```/gi))
        push(match[1]);
      const stack = [];
      let start = -1;
      let quote = "";
      let escaped = false;
      for (let i = 0;i < raw.length; i += 1) {
        const ch = raw[i];
        if (quote) {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (ch === "\\") {
            escaped = true;
            continue;
          }
          if (ch === quote)
            quote = "";
          continue;
        }
        if (stack.length && (ch === '"' || ch === "'")) {
          quote = ch;
          continue;
        }
        if (ch === "[" || ch === "{") {
          if (!stack.length)
            start = i;
          stack.push(ch);
          continue;
        }
        if (ch === "]" || ch === "}") {
          if (!stack.length)
            continue;
          const open = stack[stack.length - 1];
          if (open === "[" && ch !== "]" || open === "{" && ch !== "}") {
            stack.length = 0;
            start = -1;
            continue;
          }
          stack.pop();
          if (!stack.length && start >= 0) {
            push(raw.slice(start, i + 1));
            start = -1;
          }
        }
      }
      return out;
    }
    function repairJsonishText(value) {
      const raw = String(value || "").replace(/^\uFEFF/, "").trim();
      let out = "";
      let quote = "";
      let escaped = false;
      for (let i = 0;i < raw.length; i += 1) {
        const ch = raw[i];
        const next = raw[i + 1];
        if (!quote) {
          if (ch === "/" && next === "/") {
            while (i < raw.length && raw[i] !== `
`)
              i += 1;
            out += `
`;
            continue;
          }
          if (ch === "/" && next === "*") {
            i += 2;
            while (i < raw.length - 1 && !(raw[i] === "*" && raw[i + 1] === "/"))
              i += 1;
            i += 1;
            continue;
          }
          if (ch === '"') {
            quote = '"';
            escaped = false;
            out += ch;
            continue;
          }
          if (ch === "'") {
            quote = "'";
            escaped = false;
            out += '"';
            continue;
          }
          out += ch;
          continue;
        }
        if (quote === '"') {
          out += ch;
          if (escaped)
            escaped = false;
          else if (ch === "\\")
            escaped = true;
          else if (ch === '"')
            quote = "";
          continue;
        }
        if (escaped) {
          if (ch === "'")
            out += "'";
          else if (ch === '"')
            out += "\\\"";
          else
            out += `\\${ch}`;
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === "'") {
          out += '"';
          quote = "";
          continue;
        }
        if (ch === '"') {
          out += "\\\"";
          continue;
        }
        if (ch === `
`) {
          out += "\\n";
          continue;
        }
        if (ch === "\r")
          continue;
        if (ch === "\t") {
          out += "\\t";
          continue;
        }
        out += ch;
      }
      if (quote === "'")
        out += '"';
      let fixed = "";
      quote = "";
      escaped = false;
      let outside = "";
      const flushOutside = () => {
        if (!outside)
          return;
        outside = outside.replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false").replace(/\bNone\b/g, "null").replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3').replace(/,\s*(?=[}\]])/g, "");
        fixed += outside;
        outside = "";
      };
      for (let i = 0;i < out.length; i += 1) {
        const ch = out[i];
        if (!quote) {
          if (ch === '"') {
            flushOutside();
            quote = '"';
            escaped = false;
            fixed += ch;
          } else
            outside += ch;
          continue;
        }
        fixed += ch;
        if (escaped)
          escaped = false;
        else if (ch === "\\")
          escaped = true;
        else if (ch === '"')
          quote = "";
      }
      flushOutside();
      return fixed.trim();
    }
    function rowsFromParsedModel(parsed, mode = "generic") {
      if (Array.isArray(parsed))
        return parsed;
      if (!isRecord(parsed))
        return null;
      const genericKeys = ["items", "candidates", "results", "records", "suggestions", "memories", "updates", "actions", "entries", "output"];
      for (const key of genericKeys)
        if (Array.isArray(parsed[key]))
          return parsed[key];
      for (const key of [...genericKeys, "data", "result", "response", "payload"]) {
        if (isRecord(parsed[key])) {
          const nested = rowsFromParsedModel(parsed[key], mode);
          if (nested)
            return nested;
        }
      }
      if (Array.isArray(parsed.data))
        return parsed.data;
      if (mode === "review" || mode === "health" || mode === "mixed-candidate") {
        const merged = [];
        const promiseRows = parsed.promises || parsed.promise || parsed.promiseItems;
        const anchorRows = parsed.anchors || parsed.anchor || parsed.memoryAnchors || parsed.memory_anchors;
        if (Array.isArray(promiseRows))
          promiseRows.forEach((row) => merged.push(isRecord(row) && !row.type ? { ...row, type: "promise" } : row));
        if (Array.isArray(anchorRows))
          anchorRows.forEach((row) => merged.push(isRecord(row) && !row.type ? { ...row, type: "anchor" } : row));
        if (merged.length || Array.isArray(promiseRows) || Array.isArray(anchorRows))
          return merged;
      } else if (mode === "anchor") {
        for (const key of ["anchors", "memoryAnchors", "memory_anchors"])
          if (Array.isArray(parsed[key]))
            return parsed[key];
      } else if (mode === "promise") {
        for (const key of ["promises", "promiseItems"])
          if (Array.isArray(parsed[key]))
            return parsed[key];
      }
      if (mode === "review" || mode === "health") {
        if (parsed.action || parsed.targetId)
          return [parsed];
      } else if (mode === "mixed-candidate") {
        if ((parsed.type === "promise" || parsed.type === "anchor") && (parsed.title || parsed.content || parsed.text))
          return [parsed];
      } else if (parsed.title || parsed.content || parsed.text)
        return [parsed];
      const values = Object.values(parsed);
      if (values.length && values.every((row) => isRecord(row)))
        return values;
      return null;
    }
    function parseModelRows(text, mode = "generic") {
      const fragments = collectBalancedJsonFragments(text);
      for (const fragment of fragments) {
        for (const candidate of [fragment, repairJsonishText(fragment)]) {
          if (!candidate)
            continue;
          try {
            const parsed = JSON.parse(candidate);
            const rows = rowsFromParsedModel(parsed, mode);
            if (rows !== null)
              return { ok: true, rows, repaired: candidate !== fragment };
          } catch {}
        }
      }
      return { ok: false, rows: [], repaired: false };
    }
    function parseCandidateJson(text) {
      return parseModelRows(text, "mixed-candidate");
    }
    function parseJsonArray(text, mode = "review") {
      return parseModelRows(text, mode);
    }
    function openRawRecovery(kind, text, rows = []) {
      state.rawRecovery = { kind, text: String(text || ""), rows: safeArray(rows).slice() };
      state.layer = "raw-repair";
      toast("모델 응답의 JSON 형식이 흔들렸습니다. 원문을 보존했으니 수정 없이 다시 읽거나 직접 고칠 수 있습니다.", true);
    }
    function normalizeCandidate(row) {
      if (!isRecord(row))
        return null;
      const title = String(row.title || "").trim();
      const content = String(row.content || row.text || "").trim();
      const type = row.type === "promise" ? "promise" : row.type === "anchor" ? "anchor" : "";
      if (!title || !content || !type)
        return null;
      const titleKo = String(row.titleKo || "").trim();
      const contentKo = String(row.contentKo || "").trim();
      const scope = candidateScope(row, null);
      if (type === "promise")
        return { ...normalizePromise({ id: "", title, content, titleKo, contentKo, priority: row.priority, scheduleText: row.scheduleText || row.schedule || "", sourceType: "model" }), ...scope };
      return { ...normalizeAnchor({ id: "", title, content, titleKo, contentKo, category: row.category, priority: row.priority, activation: row.activation, keywords: safeArray(row.keywords), lifespan: row.lifespan, sourceType: "model" }), ...scope };
    }
    function modelSystemPrompt() {
      return [
        "Read the supplied roleplay source ONCE and classify useful continuity into PROMISE and MEMORY ANCHOR candidates in the same response.",
        "PROMISE = an explicit agreed future action, plan, appointment, duty, or commitment. Do not turn wishes, emotions, guesses, or general facts into promises.",
        "MEMORY ANCHOR = a relationship change, lasting current state, unresolved ongoing event, stable preference, canon fact, or explicit caution whose loss would materially break continuity.",
        "Avoid trivial scene details, speculative psychology, duplicates, and unsupported inference.",
        "Return JSON only: an array of 0-12 objects. Every object MUST include type (promise|anchor), title, content.",
        "For promise objects you may also return priority (high|normal|low) and scheduleText.",
        "For anchor objects you may also return category (relationship|state|event|preference|setting|caution), priority (high|normal|low), activation (always|keyword), keywords (array of 0-8 strings), lifespan (permanent|current_state|until_event).",
        "Use lifespan=permanent for durable canon/relationship facts, current_state for temporary states that should be replaced when changed, and until_event for unresolved threads that should retire when the event ends.",
        "Prefer always for facts that should persist every turn. Use keyword only for narrow facts that matter only when a topic returns.",
        "The first character of your response must be [ and the last character must be ]. Do not use Markdown fences or explanatory prose.",
        "Write titles and contents in the same language as the source. Do not translate an English roleplay into Korean.",
        "When the source is not Korean, also return titleKo and contentKo with a short Korean rendering for display only.",
        LANGUAGE_CONTRACT,
        KEYWORD_LANGUAGE_CONTRACT,
        SCOPE_CONTRACT,
        EPISODE_CONTRACT,
        THREAD_CONTRACT
      ].join(`
`);
    }
    function reviewSystemPrompt() {
      const schema = [
        "Return JSON only: an array of zero or more objects.",
        "The first character of your response must be [ and the last character must be ]. Do not use Markdown fences or explanatory prose.",
        "Each object: action (add|update|keep|complete|archive), type (promise|anchor), targetId, title, content, reason.",
        "For promise objects you may also return priority (high|normal|low) and scheduleText.",
        "For anchor objects you may also return category (relationship|state|event|preference|setting|caution), priority (high|normal|low), activation (always|keyword), keywords (array of 0-8 strings), lifespan (permanent|current_state|until_event).",
        "ADD must not use targetId. UPDATE/KEEP/COMPLETE/ARCHIVE must use an exact targetId from CURRENT MEMORY.",
        "COMPLETE is only for promises that were fulfilled. ARCHIVE is only for anchors whose old state is clearly obsolete. KEEP causes no change.",
        "You may also return titleKo and contentKo: a short Korean rendering used only for on-screen display.",
        "Do not invent facts. If nothing should change, return [].",
        LANGUAGE_CONTRACT,
        KEYWORD_LANGUAGE_CONTRACT,
        SCOPE_CONTRACT,
        EPISODE_CONTRACT,
        THREAD_CONTRACT
      ].join(`
`);
      return [state.reviewPrompt || DEFAULT_REVIEW_PROMPT, state.reviewExtraInstruction ? `[USER EXTRA INSTRUCTION]
${state.reviewExtraInstruction}` : "", schema].filter(Boolean).join(`

`);
    }
    function reviewMemorySnapshot() {
      return safeArray(state.currentData?.items).filter((item) => {
        if (item.type === "promise")
          return item.status === "active" || item.status === "hold";
        return item.type === "anchor" && item.active && !item.archived;
      }).map((item) => {
        const scope = isRestrictedItem(item) ? { knownBy: normalizeKnownBy(item.knownBy).map(characterName) } : {};
        return item.type === "promise" ? { id: item.id, type: "promise", title: item.title, content: item.content, status: item.status, priority: item.priority, scheduleText: item.scheduleText, ...scope } : { id: item.id, type: "anchor", title: item.title, content: item.content, category: item.category, priority: item.priority, activation: item.activation, keywords: item.keywords, lifespan: item.lifespan, ...scope };
      });
    }
    function candidateScope(row, existing) {
      const stored = Array.isArray(row.knownByIds);
      let knownByIds = stored ? normalizeKnownBy(row.knownByIds) : [];
      let unknown = stored ? normalizeTextList(row.scopeUnknown, 8, 80) : [];
      let modelSaidAll = row.modelSaidAll === true;
      if (!stored) {
        const raw = Array.isArray(row.knownBy) ? row.knownBy : typeof row.knownBy === "string" && row.knownBy.trim() ? [row.knownBy] : [];
        modelSaidAll = raw.some((value) => String(value).trim().toLocaleLowerCase() === "all");
        const resolved = resolveCharacterRefs(raw.filter((value) => String(value).trim().toLocaleLowerCase() !== "all"));
        knownByIds = resolved.ids;
        unknown = resolved.unknown;
        if (!knownByIds.length && !modelSaidAll && existing && isRestrictedItem(existing))
          knownByIds = normalizeKnownBy(existing.knownBy);
      }
      return { knownByIds, scopeUnknown: unknown, modelSaidAll, scopeNeedsReview: row.scopeNeedsReview === true, scopeConfirmed: row.scopeConfirmed === true };
    }
    function scopeBlocksApply(candidate) {
      return candidate?.scopeNeedsReview === true && candidate?.scopeConfirmed !== true && !normalizeKnownBy(candidate?.knownByIds).length;
    }
    function markScopeReview(candidates, rows) {
      const restricted = batchHasRestricted(rows);
      if (!restricted)
        return false;
      for (const candidate of candidates)
        candidate.scopeNeedsReview = true;
      return true;
    }
    function normalizeReviewCandidate(row) {
      if (!isRecord(row))
        return null;
      const action = ["add", "update", "keep", "complete", "archive"].includes(String(row.action || "").toLowerCase()) ? String(row.action).toLowerCase() : "";
      const type = row.type === "promise" ? "promise" : row.type === "anchor" ? "anchor" : "";
      if (!action || !type)
        return null;
      if (action === "complete" && type !== "promise")
        return null;
      if (action === "archive" && type !== "anchor")
        return null;
      const targetId = String(row.targetId || "");
      const existing = targetId ? safeArray(state.currentData?.items).find((item) => item.id === targetId && item.type === type) : null;
      if (action !== "add" && !existing)
        return null;
      const title = String(row.title || existing?.title || "").trim();
      const content = String(row.content || row.text || existing?.content || "").trim();
      if (["add", "update"].includes(action) && (!title || !content))
        return null;
      const dupOf = action === "add" && !row.duplicateChecked ? safeArray(state.currentData?.items).find((item) => item.type === type && titleKey(item.title) && titleKey(item.title) === titleKey(row.title) && (item.type === "promise" ? item.status !== "cancelled" : !item.archived)) : null;
      const base = { ...candidateScope(row, existing), duplicateOf: String(row.duplicateOf || dupOf?.id || ""), duplicateChecked: true, candidateId: String(row.candidateId || uid("rvc")), action, type, targetId, baseUpdatedAt: String(row.baseUpdatedAt || existing?.updatedAt || ""), title, content, titleKo: String(row.titleKo || "").trim(), contentKo: String(row.contentKo || "").trim(), reason: String(row.reason || "").trim(), priority: ["high", "normal", "low"].includes(row.priority) ? row.priority : existing?.priority || "normal" };
      if (type === "promise")
        return { ...base, scheduleText: String(row.scheduleText || row.schedule || existing?.scheduleText || "") };
      return { ...base, category: Object.prototype.hasOwnProperty.call(ANCHOR_CATEGORY_LABEL, row.category) ? row.category : existing?.category || "setting", activation: row.activation === "keyword" ? "keyword" : row.activation === "always" ? "always" : existing?.activation || "always", keywords: safeArray(row.keywords).map((x) => String(x).trim()).filter(Boolean).slice(0, 8), lifespan: Object.prototype.hasOwnProperty.call(ANCHOR_LIFESPAN_LABEL, row.lifespan) ? row.lifespan : existing?.lifespan || "permanent" };
    }
    function healthSystemPrompt() {
      const schema = [
        "You audit an existing roleplay working-memory list. Do not create new facts and do not propose ADD actions.",
        "Use the recent summaries only as evidence for whether a stored item became obsolete, completed, contradictory, or can be made shorter without losing meaning.",
        "Check especially: duplicate records, contradictory active states, current_state or until_event anchors that are now resolved, fulfilled promises, and overly verbose records that can be compressed.",
        "For duplicates, prefer UPDATE on the record that should remain and ARCHIVE on obsolete duplicate anchors. Never archive durable facts merely because they are old.",
        "COMPLETE is only for promises explicitly fulfilled in the supplied evidence. ARCHIVE is only for anchors clearly obsolete or duplicated. UPDATE must preserve supported facts.",
        "Return JSON only: an array of zero or more objects.",
        "The first character of your response must be [ and the last character must be ]. Do not use Markdown fences or explanatory prose.",
        "Each object: action (update|keep|complete|archive), type (promise|anchor), targetId, title, content, reason.",
        "For promise objects you may also return priority (high|normal|low) and scheduleText.",
        "For anchor objects you may also return category (relationship|state|event|preference|setting|caution), priority (high|normal|low), activation (always|keyword), keywords (array of 0-8 strings), lifespan (permanent|current_state|until_event).",
        "targetId must exactly match an id from CURRENT MEMORY. If no safe maintenance action is needed, return [].",
        "Write titles, contents, and reasons in the same language as the source.",
        "When the source is not Korean, also return titleKo and contentKo with a short Korean rendering for display only.",
        KEYWORD_LANGUAGE_CONTRACT
      ].join(`
`);
      return [schema, state.reviewExtraInstruction ? `[USER EXTRA INSTRUCTION]
${state.reviewExtraInstruction}` : ""].filter(Boolean).join(`

`);
    }
    function healthEvidenceRows() {
      return summaryRowsFromMetadata(state.currentChat?.metadata).slice(-6);
    }
    async function generateHealthCandidates() {
      if (!state.currentData)
        throw new Error("점검할 기억 보관함을 찾지 못했습니다.");
      const connectionId = String(state.modelConnectionId || chooseDefaultConnection(state.currentChat) || "");
      if (!connectionId)
        throw new Error("설정에서 기억 건강검진에 사용할 모델 연결을 선택해 주세요.");
      state.modelConnectionId = connectionId;
      await saveUiState();
      setBusy(true, "모델이 기억 보관함을 건강검진하는 중…");
      try {
        let evidence = healthEvidenceRows();
        if (!evidence.length) {
          try {
            const fresh = await api(`chats/${encodeURIComponent(state.selectedChatId)}`);
            if (fresh) {
              state.currentChat = { ...state.currentChat, ...fresh, id: String(fresh.id || state.selectedChatId), metadata: parseRecord(fresh.metadata) };
              evidence = healthEvidenceRows();
            }
          } catch {}
        }
        const snapshot = reviewMemorySnapshot().filter((row) => !row.knownBy);
        const plan = anchorInjectionPlan();
        const evidenceText = evidence.length ? sourceToTextForSummaryRows(evidence).slice(0, 50000) : "(No recent summary evidence available. In this case only suggest safe duplicate/compression maintenance; do not infer completion or obsolescence.)";
        const payload = await api("generate/raw", {
          method: "POST",
          timeoutMs: MODEL_TIMEOUT_MS,
          body: {
            connectionId,
            runId: uid("memory-health"),
            streaming: false,
            messages: [
              { role: "system", content: healthSystemPrompt() },
              { role: "user", content: `[CURRENT MEMORY]
${JSON.stringify(snapshot, null, 2)}
[/CURRENT MEMORY]

[WORKING MEMORY BUDGET]
Always-anchor budget: ${plan.budget} characters; currently selected ${plan.selected.length}/${plan.candidates.length}, line characters ${plan.used}.
[/WORKING MEMORY BUDGET]

[RECENT SUMMARY EVIDENCE]
${evidenceText}
[/RECENT SUMMARY EVIDENCE]` }
            ],
            parameters: { maxTokens: 2800, reasoningEffort: null }
          }
        });
        const output = extractGeneratedText(payload);
        const parsedResult = parseJsonArray(output, "health");
        if (!parsedResult.ok) {
          openRawRecovery("health", output);
          return;
        }
        const rawRows = parsedResult.rows;
        state.healthCandidates = rawRows.map(normalizeReviewCandidate).filter((item) => item && item.action !== "add").slice(0, 20);
        state.healthSelected = new Set(state.healthCandidates.map((item, i) => item.action === "keep" ? null : String(i)).filter(Boolean));
        state.layer = "health-candidates";
      } finally {
        state.busy = false;
        if (state.busyTimer)
          clearInterval(state.busyTimer);
        state.busyTimer = null;
        render();
      }
    }
    function sourceToTextForSummaryRows(rows) {
      return safeArray(rows).map(summaryRowText).join(`

`);
    }
    async function applyHealthCandidates() {
      const chosen = state.healthCandidates.filter((_, i) => state.healthSelected.has(String(i)) && state.healthCandidates[i].action !== "keep");
      if (!chosen.length)
        throw new Error("적용할 건강검진 변경을 선택해 주세요.");
      const data = await freshOwnedData();
      const evidence = healthEvidenceRows();
      const sourceIds = evidence.map((row) => String(row.id || "")).filter(Boolean);
      const healthFps = sourceFingerprintsForRows(evidence, "summaries");
      const sourceQuote = sourceToTextForSummaryRows(evidence).slice(0, 12000);
      const stamp = nowIso();
      const conflicts = [];
      let applied = 0;
      for (const item of chosen) {
        const index = data.items.findIndex((row) => row.id === item.targetId && row.type === item.type);
        if (index < 0) {
          conflicts.push(item);
          continue;
        }
        const existing = data.items[index];
        if (item.baseUpdatedAt && existing.updatedAt !== item.baseUpdatedAt) {
          conflicts.push(item);
          continue;
        }
        if (isRestrictedItem(existing)) {
          conflicts.push(item);
          continue;
        }
        if (item.action === "update") {
          const mergedSources = Array.from(new Set([...safeArray(existing.sourceIds).map(String), ...sourceIds]));
          data.items[index] = item.type === "promise" ? normalizePromise({ ...existing, sourceFingerprints: { ...normalizeSourceFingerprints(existing.sourceFingerprints), ...healthFps }, title: item.title, content: item.content, titleKo: item.titleKo || existing.titleKo, contentKo: item.contentKo || existing.contentKo, priority: item.priority, scheduleText: item.scheduleText, sourceType: "health-check", sourceIds: mergedSources, sourceQuote: sourceQuote || existing.sourceQuote, updatedAt: stamp }) : normalizeAnchor({ ...existing, sourceFingerprints: { ...normalizeSourceFingerprints(existing.sourceFingerprints), ...healthFps }, title: item.title, content: item.content, titleKo: item.titleKo || existing.titleKo, contentKo: item.contentKo || existing.contentKo, category: item.category, priority: item.priority, activation: item.activation, keywords: item.keywords, lifespan: item.lifespan, sourceType: "health-check", sourceIds: mergedSources, sourceQuote: sourceQuote || existing.sourceQuote, updatedAt: stamp });
        } else if (item.action === "complete" && existing.type === "promise") {
          existing.status = "done";
          existing.sourceType = "health-check";
          existing.sourceIds = Array.from(new Set([...safeArray(existing.sourceIds).map(String), ...sourceIds]));
          existing.sourceQuote = sourceQuote || existing.sourceQuote;
          existing.updatedAt = stamp;
        } else if (item.action === "archive" && existing.type === "anchor") {
          existing.archived = true;
          existing.active = false;
          existing.sourceType = "health-check";
          existing.sourceIds = Array.from(new Set([...safeArray(existing.sourceIds).map(String), ...sourceIds]));
          existing.sourceQuote = sourceQuote || existing.sourceQuote;
          existing.updatedAt = stamp;
        } else
          continue;
        applied += 1;
      }
      if (applied)
        await persistData(data);
      if (conflicts.length) {
        const conflictSet = new Set(conflicts);
        state.healthCandidates = state.healthCandidates.filter((item) => conflictSet.has(item));
        state.healthSelected.clear();
        state.layer = "health-candidates";
        toast(`${applied}개 반영 · 충돌 ${conflicts.length}개는 원본을 보호하고 남겨뒀습니다.`, true);
      } else {
        state.healthCandidates = [];
        state.healthSelected.clear();
        state.layer = null;
        toast(`${applied}개 건강검진 변경을 반영했습니다.`);
      }
      render();
    }
    async function generateReviewCandidates(rows = selectedSourceRows(), { showLayer = true } = {}) {
      if (!rows.length)
        throw new Error("정리할 새 요약을 선택해 주세요.");
      const connectionId = String(document.getElementById("mmc-source-model")?.value || state.modelConnectionId || "");
      if (!connectionId)
        throw new Error("사용할 모델 연결을 선택해 주세요.");
      state.modelConnectionId = connectionId;
      await saveUiState();
      setBusy(true, "모델이 약속과 기억 앵커를 함께 비교하는 중…");
      try {
        const sourceText = sourceToText(rows).slice(0, 1e5);
        const snapshot = reviewMemorySnapshot();
        const payload = await api("generate/raw", {
          method: "POST",
          timeoutMs: MODEL_TIMEOUT_MS,
          body: {
            connectionId,
            runId: uid("memory-review"),
            streaming: false,
            messages: [
              { role: "system", content: reviewSystemPrompt() },
              { role: "user", content: `[CURRENT MEMORY — MAY BE UPDATED]
${JSON.stringify(snapshot, null, 2)}
[/CURRENT MEMORY]${threadSnapshotForPrompt()}${recentEpisodesForPrompt()}

[NEW SUMMARY — SOURCE OF NEW FACTS]
${sourceText}
[/NEW SUMMARY]` }
            ],
            parameters: { maxTokens: 4500, reasoningEffort: null }
          }
        });
        const output = extractGeneratedText(payload);
        const parsedResult = parseJsonArray(output, "review");
        if (!parsedResult.ok) {
          openRawRecovery("review", output, rows);
          return false;
        }
        const rawRows = parsedResult.rows;
        state.reviewCandidates = rawRows.map(normalizeReviewCandidate).filter(Boolean).slice(0, 20);
        state.reviewEpisodes = extractEpisodeCandidates(rawRows, rows, "summaries");
        state.reviewEpisodeSelected = preselectEpisodes(state.reviewEpisodes);
        state.reviewThreads = extractThreadCandidates(rawRows, rows, "summaries");
        state.reviewThreadSelected = preselectThreads(state.reviewThreads);
        markScopeReview(state.reviewCandidates, rows);
        state.reviewSelected = new Set(state.reviewCandidates.map((item, i) => item.action === "keep" || scopeBlocksApply(item) || item.duplicateOf ? null : String(i)).filter(Boolean));
        state.reviewSourceRows = rows.slice();
        await persistPendingReview();
        if (showLayer)
          state.layer = "review-candidates";
        return true;
      } finally {
        state.busy = false;
        if (state.busyTimer)
          clearInterval(state.busyTimer);
        state.busyTimer = null;
        render();
      }
    }
    async function openPendingReview({ runModel = false } = {}) {
      await checkNewSummaries({ refreshChat: true, baselineIfUnknown: true, renderAfter: false });
      if (!state.pendingSummaryRows.length) {
        toast("새로 검토할 요약이 없습니다.");
        render();
        return;
      }
      state.sourceMode = "summaries";
      state.sourceTarget = "review";
      state.sourceRows = state.pendingSummaryRows.slice();
      state.sourceSelected = new Set(state.sourceRows.map((row) => String(row.id || "")));
      state.layer = "source";
      render();
      if (runModel)
        await generateReviewCandidates(state.sourceRows);
    }
    async function applyReviewCandidates({ auto = false } = {}) {
      const chosen = state.reviewCandidates.map((item, index) => ({ item, index })).filter(({ item, index }) => state.reviewSelected.has(String(index)) && item.action !== "keep");
      if (!chosen.length && !state.reviewEpisodeSelected.size && !state.reviewThreadSelected.size)
        throw new Error("적용할 변경을 선택해 주세요.");
      const data = await freshOwnedData();
      const sourceIds = state.reviewSourceRows.map((row) => String(row.id || "")).filter(Boolean);
      const sourceQuote = state.reviewSourceRows.map(summaryRowText).join(`

`).slice(0, 12000);
      const sourceFingerprints = sourceFingerprintsForRows(state.reviewSourceRows, "summaries");
      const now = nowIso();
      const conflicts = [];
      const applied = [];
      const undo = { createdAt: now, sourceBatchKey: summaryBatchKey(state.reviewSourceRows), updated: [], created: [] };
      for (const { item, index: candidateIndex } of chosen) {
        if (["add", "update"].includes(item.action) && scopeBlocksApply(item)) {
          conflicts.push({ item, reason: "공개 범위 확인 필요" });
          continue;
        }
        if (item.action === "add") {
          if (item.candidateId && data.items.some((row) => row.sourceCandidateId === item.candidateId)) {
            applied.push(candidateIndex);
            continue;
          }
          const scope = { knownBy: normalizeKnownBy(item.knownByIds), sourceFingerprints, sourceCandidateId: item.candidateId };
          const created = item.type === "promise" ? normalizePromise({ ...item, ...scope, id: uid("promise"), sourceType: "summary-model-review", sourceIds, sourceQuote, createdAt: now, updatedAt: now }) : normalizeAnchor({ ...item, ...scope, id: uid("anchor"), sourceType: "summary-model-review", sourceIds, sourceQuote, createdAt: now, updatedAt: now });
          data.items.unshift(created);
          undo.created.push({ id: created.id, appliedUpdatedAt: created.updatedAt });
          applied.push(candidateIndex);
          continue;
        }
        const index = data.items.findIndex((row) => row.id === item.targetId && row.type === item.type);
        if (index < 0) {
          conflicts.push({ item, reason: "원본 기록 없음" });
          continue;
        }
        const existing = data.items[index];
        if (item.baseUpdatedAt && existing.updatedAt !== item.baseUpdatedAt) {
          conflicts.push({ item, reason: "후보 생성 뒤 원본 수정됨" });
          continue;
        }
        const before = JSON.parse(JSON.stringify(existing));
        if (item.action === "update") {
          const mergedSources = Array.from(new Set([...safeArray(existing.sourceIds).map(String), ...sourceIds]));
          const knownBy = normalizeKnownBy(item.knownByIds).length ? normalizeKnownBy(item.knownByIds) : item.scopeConfirmed ? [] : normalizeKnownBy(existing.knownBy);
          const scope = { knownBy, sourceFingerprints: { ...normalizeSourceFingerprints(existing.sourceFingerprints), ...sourceFingerprints } };
          data.items[index] = item.type === "promise" ? normalizePromise({ ...existing, ...scope, title: item.title, content: item.content, titleKo: item.titleKo || existing.titleKo, contentKo: item.contentKo || existing.contentKo, priority: item.priority, scheduleText: item.scheduleText, sourceType: "summary-model-review", sourceIds: mergedSources, sourceQuote, updatedAt: now }) : normalizeAnchor({ ...existing, ...scope, title: item.title, content: item.content, titleKo: item.titleKo || existing.titleKo, contentKo: item.contentKo || existing.contentKo, category: item.category, priority: item.priority, activation: item.activation, keywords: item.keywords, lifespan: item.lifespan, sourceType: "summary-model-review", sourceIds: mergedSources, sourceQuote, updatedAt: now });
        } else if (item.action === "complete" && existing.type === "promise") {
          existing.status = "done";
          existing.sourceType = "summary-model-review";
          existing.sourceIds = Array.from(new Set([...safeArray(existing.sourceIds).map(String), ...sourceIds]));
          existing.sourceQuote = sourceQuote || existing.sourceQuote;
          existing.updatedAt = now;
        } else if (item.action === "archive" && existing.type === "anchor") {
          existing.archived = true;
          existing.active = false;
          existing.sourceType = "summary-model-review";
          existing.sourceIds = Array.from(new Set([...safeArray(existing.sourceIds).map(String), ...sourceIds]));
          existing.sourceQuote = sourceQuote || existing.sourceQuote;
          existing.updatedAt = now;
        } else
          continue;
        undo.updated.push({ id: existing.id, before, appliedUpdatedAt: data.items[index].updatedAt });
        applied.push(candidateIndex);
      }
      const ep = applyEpisodeCandidates(data, state.reviewEpisodes, state.reviewEpisodeSelected, { fps: sourceFingerprints, sourceIds, rows: state.reviewSourceRows });
      const th = applyThreadCandidates(data, state.reviewThreads, state.reviewThreadSelected, { fps: sourceFingerprints, sourceIds, rows: state.reviewSourceRows });
      const thHeld = new Set(th.held.map(String));
      const thApplied = state.reviewThreads.filter((cand, i) => state.reviewThreadSelected.has(String(i)) && !thHeld.has(String(i))).map((cand) => cand.candidateId);
      if (thApplied.length)
        undo.threadCandidates = thApplied;
      ep.held.push(...th.held.map((i) => `th${i}`));
      ep.applied += th.applied;
      const epHeld = new Set(ep.held.map(String));
      if (ep.createdIds.length)
        undo.episodes = ep.createdIds;
      const scopeHeld = conflicts.filter((row) => row.reason === "공개 범위 확인 필요").length + ep.held.length;
      const appliedCount = applied.length + ep.applied;
      if (!appliedCount && (conflicts.length || ep.held.length)) {
        state.currentData = data;
        state.reviewSelected.clear();
        state.reviewEpisodeSelected = new Set;
        state.reviewThreadSelected = new Set;
        await persistPendingReview();
        toast(scopeHeld ? `공개 범위를 확인해야 하는 후보 ${scopeHeld}개는 적용하지 않았습니다. 아는 인물을 고르거나 '모두에게 공개'를 눌러 주세요.` : `충돌 ${conflicts.length}개 · 후보 생성 뒤 수정된 원본은 덮어쓰지 않았습니다.`, true);
        render();
        return;
      }
      data.lastAutoReviewUndo = auto && appliedCount ? undo : data.lastAutoReviewUndo;
      if (!conflicts.length && !ep.held.length)
        data.pendingReview = null;
      await persistData(data);
      if (conflicts.length || ep.held.length) {
        const conflictKeys = new Set(conflicts.map(({ item }) => item));
        state.reviewCandidates = state.reviewCandidates.filter((item) => conflictKeys.has(item));
        state.reviewEpisodes = state.reviewEpisodes.filter((_, i) => epHeld.has(String(i)));
        state.reviewEpisodeSelected = new Set;
        state.reviewThreads = state.reviewThreads.filter((_, i) => thHeld.has(String(i)));
        state.reviewThreadSelected = new Set;
        state.reviewSelected = new Set;
        state.layer = "review-candidates";
        await persistPendingReview();
        toast(`${appliedCount}개 반영 · ${scopeHeld ? `공개 범위 확인 ${scopeHeld}개 · ` : ""}충돌 ${conflicts.length + ep.held.length - scopeHeld}개는 남겨뒀습니다.${ep.capped ? ` 장면 기억 상한(${EPISODE_LIMIT}개)에 걸린 ${ep.capped}개도 남겼어요.` : ""}`, true);
        render();
        return;
      }
      await markSummaryRowsReviewed(state.reviewSourceRows);
      state.reviewCandidates = [];
      state.reviewSelected.clear();
      state.reviewSourceRows = [];
      state.reviewEpisodes = [];
      state.reviewEpisodeSelected = new Set;
      state.reviewThreads = [];
      state.reviewThreadSelected = new Set;
      state.layer = null;
      toast(`${auto ? `자동 정리로 ${appliedCount}개 변경을 반영했습니다. 1회 되돌리기가 가능합니다.` : `${appliedCount}개 변경을 반영했습니다.`}${syncFailSuffix()}`, !!syncFailSuffix());
      render();
    }
    async function undoAutoReview() {
      const data = await freshOwnedData();
      const undo = data.lastAutoReviewUndo;
      if (!undo)
        throw new Error("되돌릴 자동 적용 기록이 없습니다.");
      let restored = 0;
      let removed = 0;
      let skipped = 0;
      for (const row of safeArray(undo.updated)) {
        const index = data.items.findIndex((item) => item.id === row.id);
        if (index < 0 || data.items[index].updatedAt !== row.appliedUpdatedAt) {
          skipped += 1;
          continue;
        }
        data.items[index] = normalizeItem(row.before);
        restored += 1;
      }
      const createdById = new Map(safeArray(undo.created).map((row) => [row.id, row]));
      data.items = data.items.filter((item) => {
        const row = createdById.get(item.id);
        if (!row)
          return true;
        if (item.updatedAt !== row.appliedUpdatedAt) {
          skipped += 1;
          return true;
        }
        removed += 1;
        return false;
      });
      const undoEpisodes = new Set(safeArray(undo.episodes).map(String));
      if (undoEpisodes.size && Array.isArray(data.episodes)) {
        const list = data.episodes.map(normalizeEpisode).filter(Boolean);
        const removable = new Set(list.filter((ep) => undoEpisodes.has(ep.id) && ep.updatedAt === ep.createdAt).map((ep) => ep.id));
        skipped += undoEpisodes.size - removable.size;
        removed += removable.size;
        data.episodes = list.filter((ep) => !removable.has(ep.id)).map((ep) => ep.replacedBy && removable.has(ep.replacedBy) ? { ...ep, replacedBy: undefined } : ep).map(normalizeEpisode).filter(Boolean);
      }
      const undoThreads = new Set(safeArray(undo.threadCandidates).map(String));
      if (undoThreads.size && Array.isArray(data.threads)) {
        data.threads = data.threads.map(normalizeThread).filter(Boolean).flatMap((t) => {
          if (undoThreads.has(t.sourceCandidateId) && t.history.every((entry) => !entry.candidateId || undoThreads.has(entry.candidateId))) {
            removed += 1;
            return [];
          }
          const history = t.history.filter((entry) => !(entry.candidateId && undoThreads.has(entry.candidateId)));
          if (history.length === t.history.length)
            return [t];
          restored += 1;
          const next = normalizeThread({ ...t, history });
          return [normalizeThread({ ...next, ...threadOverall(next) })];
        });
      }
      data.lastAutoReviewUndo = null;
      await persistData(data);
      toast(`자동 적용 되돌리기 완료 · 복원 ${restored}개 · 신규 제거 ${removed}개${skipped ? ` · 직접 수정 보호 ${skipped}개` : ""}`);
      render();
    }
    async function generateCandidates() {
      const rows = selectedSourceRows();
      if (!rows.length)
        throw new Error("원문을 선택해 주세요.");
      const connectionId = String(document.getElementById("mmc-source-model")?.value || state.modelConnectionId || "");
      if (!connectionId)
        throw new Error("사용할 모델 연결을 선택해 주세요.");
      state.modelConnectionId = connectionId;
      await saveUiState();
      setBusy(true, "모델이 약속과 기억 앵커를 한 번에 분류하는 중…");
      try {
        const text = sourceToText(rows).slice(0, 1e5);
        const payload = await api("generate/raw", {
          method: "POST",
          timeoutMs: MODEL_TIMEOUT_MS,
          body: {
            connectionId,
            runId: uid("memory-candidate"),
            streaming: false,
            messages: [
              { role: "system", content: modelSystemPrompt() },
              { role: "user", content: `[SOURCE — READ ONLY]
${text}
[/SOURCE]

[CURRENT MEMORY]
${JSON.stringify(reviewMemorySnapshot().filter((row) => row.type === "promise"), null, 2)}
[/CURRENT MEMORY]${threadSnapshotForPrompt()}${recentEpisodesForPrompt()}` }
            ],
            parameters: { maxTokens: 3200, reasoningEffort: null }
          }
        });
        const output = extractGeneratedText(payload);
        const parsedResult = parseCandidateJson(output);
        if (!parsedResult.ok) {
          openRawRecovery("candidate", output, rows);
          return;
        }
        const parsed = parsedResult.rows.map(normalizeCandidate).filter(Boolean).slice(0, 12);
        const episodeCands = extractEpisodeCandidates(parsedResult.rows, rows, state.sourceMode);
        const threadCands = extractThreadCandidates(parsedResult.rows, rows, state.sourceMode);
        if (!parsed.length && !episodeCands.length && !threadCands.length && parsedResult.rows.length) {
          openRawRecovery("candidate", output, rows);
          return;
        }
        state.candThreads = threadCands;
        state.candThreadSelected = preselectThreads(threadCands);
        state.candEpisodes = episodeCands;
        state.candEpisodeSelected = preselectEpisodes(episodeCands);
        state.candBatch = { fps: sourceFingerprintsForRows(rows, state.sourceMode), sourceIds: rows.map((row) => String(row.id || "")).filter(Boolean), rows: rows.map((row) => ({ createdAt: row.createdAt, updatedAt: row.updatedAt, endIndex: row.endIndex })) };
        const quote = sourceToText(rows).slice(0, 12000);
        const ids = rows.map((row) => String(row.id || "")).filter(Boolean);
        const fps = sourceFingerprintsForRows(rows, state.sourceMode);
        state.candidates = parsed.map((item) => ({ ...item, id: "", candidateId: uid("cand"), sourceType: "model", sourceIds: ids, sourceQuote: quote, ...Object.keys(fps).length ? { sourceFingerprints: fps } : {} }));
        if (state.sourceMode === "summaries")
          markScopeReview(state.candidates, rows);
        for (const cand of state.candidates) {
          const dup = safeArray(state.currentData?.items).find((row) => row.type === cand.type && titleKey(row.title) && titleKey(row.title) === titleKey(cand.title));
          if (dup)
            cand.duplicateOf = dup.id;
        }
        state.candidateSelected = new Set(state.candidates.map((item, i) => scopeBlocksApply(item) || item.duplicateOf ? null : String(i)).filter(Boolean));
        state.layer = "candidates";
      } finally {
        state.busy = false;
        if (state.busyTimer)
          clearInterval(state.busyTimer);
        state.busyTimer = null;
        render();
      }
    }
    async function importLegacy() {
      const legacy = parseRecord(state.currentChat?.metadata)[LEGACY_PROMISE_KEY];
      if (!isRecord(legacy))
        throw new Error("가져올 기존 약속보관함 데이터가 없습니다.");
      const data = normalizeData(state.currentData);
      const existingFingerprints = new Set(data.items.map((item) => `${item.type}|${item.title}|${item.content}`));
      let added = 0;
      for (const old of safeArray(legacy.items)) {
        const item = old.type === "note" ? normalizeAnchor({
          title: old.title || "기존 주요사항",
          content: old.content || old.note || old.quote || "",
          category: "setting",
          priority: old.priority,
          active: old.status === "active",
          archived: old.status !== "active",
          sourceType: "legacy-promise-keeper",
          sourceIds: old.sourceMessageId ? [old.sourceMessageId] : [],
          sourceQuote: old.quote || "",
          createdAt: old.createdAt,
          updatedAt: old.updatedAt
        }) : normalizePromise({
          title: old.title || "기존 약속",
          content: old.content || old.note || old.quote || "",
          status: old.status,
          priority: old.priority,
          scheduleText: old.scheduleText,
          sourceType: "legacy-promise-keeper",
          sourceIds: old.sourceMessageId ? [old.sourceMessageId] : [],
          sourceQuote: old.quote || "",
          createdAt: old.createdAt,
          updatedAt: old.updatedAt
        });
        const fp = `${item.type}|${item.title}|${item.content}`;
        if (!item.content.trim() || existingFingerprints.has(fp))
          continue;
        existingFingerprints.add(fp);
        data.items.push(item);
        added += 1;
      }
      data.legacyImportedAt = nowIso();
      await persistData(data);
      toast(`${added}개 기록을 복사해 가져왔습니다. 기존 약속보관함 원본은 유지됩니다.`);
    }
    const LOCKED_ACTIONS = new Set(["save-thread", "delete-thread", "thread-status", "save-episode", "delete-episode", "stale-ack", "branch-hold-keep", "branch-hold-drop", "save-candidates", "apply-review", "apply-health", "save-element-candidates", "save-draft", "save-element", "delete-item", "delete-element", "promise-status", "toggle-promise-done", "toggle-anchor-active", "anchor-move", "save-settings", "save-element-settings", "import-legacy", "undo-auto-review", "restore-memory-backup", "confirm-quarantined-memory", "wiki-save", "wiki-candidate-save", "wiki-proposal-apply", "wiki-delete", "wiki-save-settings", "wiki-toggle", "parse-raw-recovery"]);
    async function handleClick(event) {
      const actionEl = event.target.closest?.("[data-action]");
      if (!actionEl)
        return;
      const action = actionEl.dataset.action;
      if (LOCKED_ACTIONS.has(action)) {
        if (state.actionLock) {
          toast("앞선 저장이 끝나는 중이에요. 잠시 뒤 다시 눌러 주세요.");
          return;
        }
        state.actionLock = true;
        try {
          return await handleClickInner(event, actionEl, action);
        } finally {
          state.actionLock = false;
        }
      }
      return handleClickInner(event, actionEl, action);
    }
    async function handleClickInner(event, actionEl, action) {
      try {
        if (String(action || "").startsWith("wiki-") || String(action || "").startsWith("reset-wiki-")) {
          if (await handleWikiAction(action, actionEl))
            return;
        }
        if (action === "overlay-close" && event.target !== actionEl)
          return;
        if (action === "overlay-close" || action === "close")
          return closeModal();
        if (action === "close-layer" && event.target.closest?.("[data-layer-stop]") && !event.target.closest?.(".mmc-icon-btn, footer"))
          return;
        if (action === "close-layer") {
          requestCloseLayer();
          return;
        }
        if (action === "dismiss-agent-note") {
          const id = String(actionEl.dataset.id || "");
          if (!id)
            return;
          state.agentNoticeDismissed = { ...parseRecord(state.agentNoticeDismissed), [id]: true };
          await saveUiState();
          render();
          return;
        }
        if (action === "help") {
          state.helpTab = "usage";
          state.layer = "help";
          render();
          return;
        }
        if (action === "help-tab") {
          state.helpTab = actionEl.dataset.helpTab === "features" ? "features" : "usage";
          render();
          return;
        }
        if (action === "settings") {
          state.settingsTab = "screen";
          state.layer = "settings";
          render();
          return;
        }
        if (action === "open-theme-settings") {
          state.settingsTab = "screen";
          state.layer = "settings";
          render();
          return;
        }
        if (action === "settings-tab") {
          const next = String(actionEl.dataset.settingsTab || "screen");
          state.settingsTab = next;
          const layer = actionEl.closest?.(".mmc-layer");
          layer?.querySelectorAll?.("[data-settings-pane]").forEach((node) => {
            node.hidden = node.dataset.settingsPane !== next;
          });
          layer?.querySelectorAll?.("[data-settings-tab]").forEach((node) => node.classList.toggle("is-active", node.dataset.settingsTab === next));
          const body = layer?.querySelector?.(".mmc-layer-body");
          if (body)
            body.scrollTop = 0;
          return;
        }
        if (action === "inject-preview") {
          state.layer = "inject-preview";
          render();
          return;
        }
        if (action === "promise-open") {
          state.promiseSelectedId = String(actionEl.dataset.id || "");
          state.promisePane = "detail";
          render();
          return;
        }
        if (action === "promise-back") {
          state.promisePane = "list";
          render();
          return;
        }
        if (action === "promise-status") {
          const next = String(actionEl.dataset.status || "");
          if (!Object.prototype.hasOwnProperty.call(PROMISE_STATUS_LABEL, next))
            return;
          const data = normalizeData(state.currentData);
          const item = data.items.find((x) => x.id === actionEl.dataset.id && x.type === "promise");
          if (!item || item.status === next)
            return;
          item.status = next;
          item.updatedAt = nowIso();
          await persistData(data);
          render();
          return;
        }
        if (action === "anchor-move") {
          const data = normalizeData(state.currentData);
          const item = data.items.find((x) => x.id === actionEl.dataset.id && x.type === "anchor");
          if (!item)
            return;
          if (item.activation !== "keyword" && !safeArray(item.keywords).length) {
            state.draft = { ...item, activation: "keyword", keywords: [], sourceIds: safeArray(item.sourceIds).slice() };
            state.layer = "editor";
            render();
            toast("키워드로 떠오르게 하려면 키워드를 하나 이상 넣어 주세요.");
            return;
          }
          item.activation = item.activation === "keyword" ? "always" : "keyword";
          item.updatedAt = nowIso();
          await persistData(data);
          render();
          return;
        }
        if (action === "restore-memory-backup") {
          if (!window.confirm("현재 metadata 대신 이 RP 전용 로어북의 비활성 백업으로 기억을 복구할까요? 격리 중인 다른 RP 데이터는 적용하지 않습니다."))
            return;
          await restoreFromMatchingBackup();
          return;
        }
        if (action === "confirm-quarantined-memory") {
          if (!window.confirm("격리된 기억을 현재 RP의 독립 복사본으로 확정할까요? 표시된 소유 RP가 다른 방이라면 의도적으로 복사하는 작업입니다. 기존 소유 방의 로어북은 수정하지 않습니다."))
            return;
          await confirmQuarantinedDataForCurrentChat();
          return;
        }
        if (action === "view-evidence") {
          state.evidenceView = { kind: String(actionEl.dataset.kind || "item"), id: String(actionEl.dataset.id || "") };
          state.layer = "evidence";
          render();
          return;
        }
        if (action === "health-check") {
          await generateHealthCandidates();
          return;
        }
        if (action === "review-pending") {
          await openPendingReview({ runModel: false });
          return;
        }
        if (action === "review-model") {
          await openPendingReview({ runModel: true });
          return;
        }
        if (action === "open-review-draft") {
          state.layer = "review-candidates";
          render();
          return;
        }
        if (action === "undo-auto-review") {
          if (!window.confirm("직전 자동 적용을 되돌릴까요? 이후 직접 수정한 기록은 보호하고 건너뜁니다."))
            return;
          await undoAutoReview();
          return;
        }
        if (action === "tab") {
          const nextTab = String(actionEl.dataset.tab || "promise");
          state.activeTab = TAB_IDS.includes(nextTab) ? nextTab : "overview";
          state.filter = "active";
          state.promisePane = "list";
          saveUiState();
          render();
          return;
        }
        if (action === "set-filter") {
          state.filter = actionEl.dataset.filter || "active";
          saveUiState();
          render();
          return;
        }
        if (action === "expand-list") {
          state.expanded[actionEl.dataset.type] = true;
          saveUiState();
          render();
          return;
        }
        if (action === "collapse-list") {
          state.expanded[actionEl.dataset.type] = false;
          saveUiState();
          render();
          return;
        }
        if (action === "element-settings") {
          state.layer = "element-settings";
          render();
          return;
        }
        if (action === "new-element") {
          state.elementDraft = normalizeElement({ id: "", name: "" });
          state.elementDraft.id = "";
          state.layer = "element-editor";
          render();
          return;
        }
        if (action === "edit-element") {
          const entity = elementMemory().entities.find((row) => row.id === actionEl.dataset.id);
          if (!entity)
            return;
          state.elementDraft = JSON.parse(JSON.stringify(entity));
          state.layer = "element-editor";
          render();
          return;
        }
        if (action === "delete-element") {
          const id = String(actionEl.dataset.id || state.elementDraft?.id || "");
          if (!id || !window.confirm("이 요소 기억을 삭제할까요? 전용 로어북 검색에서도 빠집니다."))
            return;
          const data = normalizeData(state.currentData);
          data.elementMemory.entities = data.elementMemory.entities.filter((row) => row.id !== id);
          await persistData(data);
          state.layer = null;
          state.elementDraft = null;
          render();
          return;
        }
        if (action === "save-element") {
          const lines = (id, max) => String(document.getElementById(id)?.value || "").split(/\n/).map((x) => x.trim()).filter(Boolean).slice(0, max);
          const name = String(document.getElementById("mmc-element-name")?.value || "").trim().slice(0, 80);
          if (!name)
            throw new Error("요소 이름을 입력해 주세요.");
          const aliases = normalizeTextList(lines("mmc-element-aliases", 8), 8, 80);
          const standaloneTriggers = normalizeTextList(lines("mmc-element-triggers", 8), 8, 80);
          const triggerGroups = normalizeTriggerGroups(lines("mmc-element-groups", 8).map((line) => line.split(/[,＋+]/)));
          const currentTexts = lines("mmc-element-current", Number.MAX_SAFE_INTEGER).map((x) => x.slice(0, 300));
          const historyTexts = lines("mmc-element-history", Number.MAX_SAFE_INTEGER).map((x) => x.slice(0, 300));
          if (!currentTexts.length && !historyTexts.length)
            throw new Error("현재 사실이나 이력을 하나 이상 입력해 주세요.");
          const data = normalizeData(state.currentData);
          const memory = data.elementMemory;
          const now = nowIso();
          if (state.elementDraft?.id) {
            const idx = memory.entities.findIndex((row) => row.id === state.elementDraft.id);
            if (idx < 0)
              throw new Error("수정할 요소를 찾지 못했습니다.");
            const old = memory.entities[idx];
            memory.entities[idx] = normalizeElement({ ...old, name, aliases, standaloneTriggers, triggerGroups, currentFacts: mergeFactLines(old.currentFacts, currentTexts, now), historyFacts: mergeFactLines(old.historyFacts, historyTexts, now), updatedAt: now });
          } else {
            if (elementFindMatches(memory.entities, name).length)
              throw new Error("같은 이름이나 별칭을 가진 요소가 이미 있습니다.");
            if (memory.entities.length >= 400)
              throw new Error("요소 기억은 최대 400개까지 보관할 수 있어요. 오래된 요소를 정리한 뒤 추가해 주세요.");
            memory.entities.push(normalizeElement({ id: uid("element"), name, aliases, standaloneTriggers, triggerGroups, currentFacts: currentTexts.map((text) => ({ id: uid("elf"), text, source: null, createdAt: now })), historyFacts: historyTexts.map((text) => ({ id: uid("elf"), text, source: null, createdAt: now })), createdAt: now, updatedAt: now }));
          }
          memory.originChatId = state.selectedChatId;
          data.elementMemory = memory;
          await persistData(data);
          state.layer = null;
          state.elementDraft = null;
          render();
          return;
        }
        if (action === "extract-elements") {
          if (state.elementExtractMode === "range") {
            state.elementRangeStart = Math.max(1, Number(document.getElementById("mmc-element-range-start")?.value) || state.elementRangeStart);
            state.elementRangeEnd = Math.max(state.elementRangeStart, Number(document.getElementById("mmc-element-range-end")?.value) || state.elementRangeEnd);
          } else
            state.elementExtractTurns = Math.max(1, Math.min(100, Number(document.getElementById("mmc-element-turns")?.value) || state.elementExtractTurns));
          await saveUiState();
          await generateElementCandidates();
          return;
        }
        if (action === "bulk-select" || action === "bulk-clear") {
          const kind = String(actionEl.dataset.bulk || "");
          if (!["review", "candidate", "health"].includes(kind))
            return;
          if (action === "bulk-select") {
            const { selected, skipped } = selectAllSafe(kind);
            if (kind === "review")
              await persistPendingReview();
            render();
            toast(skipped ? `${selected}개를 골랐어요. ${skipped}개는 충돌·공개 범위·중복 확인이 필요해 직접 골라 주세요.` : `${selected}개를 모두 골랐어요.`);
          } else {
            clearSelection(kind);
            if (kind === "review")
              await persistPendingReview();
            render();
            toast(kind === "review" ? "모두 보류했어요. 후보는 지우지 않고 승인 대기에 그대로 남겨 두었어요." : "선택을 모두 풀었어요.");
          }
          return;
        }
        if (action === "element-select-all") {
          state.elementCandidateSelected = new Set(state.elementCandidates.map((_, i) => String(i)));
          render();
          return;
        }
        if (action === "element-select-none") {
          state.elementCandidateSelected.clear();
          render();
          return;
        }
        if (action === "save-element-candidates") {
          await applyElementCandidates();
          return;
        }
        if (action === "reset-element-extraction-prompt") {
          const box = document.getElementById("mmc-element-extraction-prompt");
          if (box)
            box.value = DEFAULT_ELEMENT_EXTRACTION_PROMPT;
          return;
        }
        if (action === "reset-element-injection-prompt") {
          const box = document.getElementById("mmc-element-injection-prompt");
          if (box)
            box.value = DEFAULT_ELEMENT_INJECTION_PROMPT;
          return;
        }
        if (action === "save-element-settings") {
          const data = normalizeData(state.currentData);
          const memory = data.elementMemory;
          memory.connectionId = String(document.getElementById("mmc-element-model")?.value || "");
          memory.injectionEnabled = !!document.getElementById("mmc-element-injection-enabled")?.checked;
          memory.extractionPrompt = String(document.getElementById("mmc-element-extraction-prompt")?.value || "").trim().slice(0, 8000);
          memory.injectionPrompt = String(document.getElementById("mmc-element-injection-prompt")?.value || "").trim().slice(0, 8000);
          memory.extractTurns = state.elementExtractTurns;
          memory.originChatId = state.selectedChatId;
          data.elementMemory = memory;
          await persistData(data);
          state.layer = null;
          render();
          return;
        }
        if (action === "new-item") {
          state.draft = actionEl.dataset.type === "anchor" ? normalizeAnchor({ id: "" }) : normalizePromise({ id: "" });
          state.draft.id = "";
          state.layer = "editor";
          render();
          return;
        }
        if (action === "edit-item") {
          const item = state.currentData.items.find((x) => x.id === actionEl.dataset.id);
          if (!item)
            return;
          state.draft = { ...item, keywords: safeArray(item.keywords).slice(), sourceIds: safeArray(item.sourceIds).slice() };
          state.layer = "editor";
          render();
          return;
        }
        if (action === "save-draft") {
          captureDraft();
          if (!state.draft?.title?.trim())
            throw new Error("제목을 입력해 주세요.");
          if (!state.draft?.content?.trim())
            throw new Error("내용을 입력해 주세요.");
          if (state.draft.type === "anchor" && state.draft.activation === "keyword" && !state.draft.keywords.length && !state.draft.archived)
            throw new Error("키워드 기억에는 검색 키워드를 하나 이상 입력해 주세요.");
          const data = normalizeData(state.currentData);
          const now = nowIso();
          if (state.draft.id) {
            const idx = data.items.findIndex((x) => x.id === state.draft.id);
            if (idx < 0)
              throw new Error("수정할 기록을 찾지 못했습니다.");
            data.items[idx] = normalizeItem({ ...data.items[idx], ...state.draft, updatedAt: now });
          } else {
            const created = normalizeItem({ ...state.draft, id: uid(state.draft.type), createdAt: now, updatedAt: now });
            data.items.unshift(created);
          }
          await persistData(data);
          state.layer = null;
          state.draft = null;
          render();
          return;
        }
        if (action === "delete-item") {
          const id = actionEl.dataset.id || state.draft?.id;
          if (!id || !confirm("이 기록을 삭제할까요? 확장이 관리하는 주입 내용에서도 빠집니다."))
            return;
          const data = normalizeData(state.currentData);
          data.items = data.items.filter((x) => x.id !== id);
          await persistData(data);
          state.layer = null;
          state.draft = null;
          render();
          return;
        }
        if (action === "toggle-promise-done") {
          const data = normalizeData(state.currentData);
          const item = data.items.find((x) => x.id === actionEl.dataset.id && x.type === "promise");
          if (!item)
            return;
          item.status = item.status === "done" ? "active" : "done";
          item.updatedAt = nowIso();
          await persistData(data);
          render();
          return;
        }
        if (action === "toggle-anchor-active") {
          const data = normalizeData(state.currentData);
          const item = data.items.find((x) => x.id === actionEl.dataset.id && x.type === "anchor");
          if (!item)
            return;
          if (item.archived) {
            item.archived = false;
            item.active = true;
          } else
            item.active = !item.active;
          item.updatedAt = nowIso();
          await persistData(data);
          render();
          return;
        }
        if (action === "open-source") {
          await openSource(actionEl.dataset.source, actionEl.dataset.target);
          return;
        }
        if (action === "source-select-all") {
          state.sourceRows.forEach((row) => state.sourceSelected.add(String(row.id)));
          render();
          return;
        }
        if (action === "source-clear") {
          state.sourceSelected.clear();
          render();
          return;
        }
        if (action === "source-local") {
          makeLocalDraft();
          return;
        }
        if (action === "source-local-promise") {
          makeLocalDraft("promise");
          return;
        }
        if (action === "source-local-anchor") {
          makeLocalDraft("anchor");
          return;
        }
        if (action === "source-model") {
          await generateCandidates();
          return;
        }
        if (action === "source-model-review") {
          await generateReviewCandidates();
          return;
        }
        if (action === "parse-raw-recovery") {
          const box = document.getElementById("mmc-raw-repair-text");
          const text = String(box?.value || state.rawRecovery?.text || "");
          if (state.rawRecovery)
            state.rawRecovery.text = text;
          await applyRecoveredRows(text);
          render();
          return;
        }
        if (action === "discard-raw-recovery") {
          if (!window.confirm("보존 중인 모델 원문 응답을 버릴까요? 다시 모델을 호출하지 않으면 복구할 수 없습니다."))
            return;
          const wasElement = ["element", "wiki", "wiki-update"].includes(String(state.rawRecovery?.kind || ""));
          state.rawRecovery = null;
          state.layer = wasElement ? null : "source";
          render();
          return;
        }
        if (action === "source-mark-reviewed") {
          const rows = selectedSourceRows();
          await markSummaryRowsReviewed(rows);
          state.layer = null;
          toast("선택한 요약을 검토 완료로 표시했습니다.");
          render();
          return;
        }
        if (action === "review-mark-done") {
          const rows = state.reviewSourceRows.slice();
          await clearPendingReview();
          await markSummaryRowsReviewed(rows);
          state.layer = null;
          toast("이번 요약을 검토 완료로 표시했습니다.");
          render();
          return;
        }
        if (action === "discard-review") {
          if (!window.confirm("승인 대기 후보를 폐기할까요? 원본 요약과 기존 기억은 그대로 유지됩니다."))
            return;
          await clearPendingReview();
          state.layer = null;
          toast("승인 대기 후보를 폐기했습니다. 원본 요약은 그대로입니다.");
          render();
          return;
        }
        if (action === "branch-hold-open") {
          state.layer = "branch-hold";
          render();
          return;
        }
        if (action === "new-thread") {
          state.threadDraft = { title: "" };
          state.layer = "thread-editor";
          render();
          return;
        }
        if (action === "edit-thread") {
          const t = threadList().find((row) => row.id === actionEl.dataset.id);
          if (!t)
            return;
          state.threadDraft = JSON.parse(JSON.stringify(t));
          state.layer = "thread-editor";
          render();
          return;
        }
        if (action === "save-thread") {
          await saveThreadDraft();
          return;
        }
        if (action === "thread-status") {
          await setThreadStatus(String(actionEl.dataset.id || ""), String(actionEl.dataset.status || ""));
          return;
        }
        if (action === "delete-thread") {
          const id = String(actionEl.dataset.id || "");
          if (!id || !window.confirm("이 진행 흐름을 지울까요? 상태 기록도 함께 지워지고 주입에서 빠집니다."))
            return;
          const data = await freshOwnedData();
          data.threads = safeArray(data.threads).map(normalizeThread).filter(Boolean).filter((t) => t.id !== id);
          await persistData(data);
          state.threadDraft = null;
          state.layer = null;
          render();
          return;
        }
        if (action === "thread-to-update") {
          const kind = String(actionEl.dataset.threadKind || "");
          const cand = (kind === "rev" ? state.reviewThreads : state.candThreads)[Number(actionEl.dataset.index)];
          if (!cand?.similarTo)
            return;
          Object.assign(cand, { action: "update", targetId: cand.similarTo, similarTo: "" });
          (kind === "rev" ? state.reviewThreadSelected : state.candThreadSelected).add(String(actionEl.dataset.index));
          if (kind === "rev")
            await persistPendingReview();
          render();
          return;
        }
        if (action === "new-episode") {
          state.episodeDraft = { title: "" };
          state.episodeDraftExtraFacts = 1;
          state.layer = "episode-editor";
          render();
          return;
        }
        if (action === "edit-episode") {
          const ep = episodeList().find((row) => row.id === actionEl.dataset.id);
          if (!ep)
            return;
          state.episodeDraft = JSON.parse(JSON.stringify(ep));
          state.episodeDraftExtraFacts = 0;
          state.layer = "episode-editor";
          render();
          return;
        }
        if (action === "episode-add-fact") {
          captureEpisodeDraft();
          state.episodeDraftExtraFacts = (state.episodeDraftExtraFacts || 0) + 1;
          render();
          return;
        }
        if (action === "save-episode") {
          await saveEpisodeDraft();
          return;
        }
        if (action === "delete-episode") {
          const id = String(actionEl.dataset.id || "");
          if (!id || !window.confirm("이 장면 기억을 지울까요? 전용 로어북에서도 빠집니다."))
            return;
          const data = await freshOwnedData();
          data.episodes = safeArray(data.episodes).map(normalizeEpisode).filter(Boolean).filter((ep) => ep.id !== id).map((ep) => ep.replacedBy === id ? normalizeEpisode({ ...ep, replacedBy: "" }) : ep);
          await persistData(data);
          state.episodeDraft = null;
          state.layer = null;
          render();
          return;
        }
        if (action === "episode-scope-public") {
          const kind = String(actionEl.dataset.episodeKind || "");
          const cand = (kind === "rev" ? state.reviewEpisodes : state.candEpisodes)[Number(actionEl.dataset.index)];
          if (!cand)
            return;
          if (!window.confirm("아는 인물을 정하지 않은 사건·사실을 모두가 아는 것으로 저장할까요? 일부 인물만 아는 내용이 섞인 원문에서 나온 후보입니다."))
            return;
          for (const part of [cand.event, ...cand.facts])
            if (!normalizeKnownBy(part.knownByIds).length)
              part.scopeConfirmed = true;
          (kind === "rev" ? state.reviewEpisodeSelected : state.candEpisodeSelected).add(String(actionEl.dataset.index));
          if (kind === "rev")
            await persistPendingReview();
          render();
          return;
        }
        if (action === "stale-open") {
          state.layer = "stale";
          render();
          return;
        }
        if (action === "stale-refresh") {
          await refreshStaleRecords();
          render();
          return;
        }
        if (action === "stale-ack") {
          await acknowledgeStale(actionEl.dataset.index);
          return;
        }
        if (action === "branch-hold-keep" || action === "branch-hold-drop") {
          const keep = action === "branch-hold-keep";
          if (!keep && !window.confirm(actionEl.dataset.kind === "all" ? "확인 대기 기록을 모두 이 분기에서 뺄까요? 부모 RP의 기록은 그대로예요." : "이 기록을 이 분기에서 뺄까요? 부모 RP의 기록은 그대로예요."))
            return;
          await resolveBranchHold(String(actionEl.dataset.kind || ""), String(actionEl.dataset.index || ""), keep);
          return;
        }
        if (action === "review-to-update") {
          const item = state.reviewCandidates[Number(actionEl.dataset.index)];
          const dup = item && safeArray(state.currentData?.items).find((row) => row.id === item.duplicateOf);
          if (!item || !dup)
            return;
          Object.assign(item, { action: "update", targetId: dup.id, baseUpdatedAt: dup.updatedAt, duplicateOf: "" });
          if (!normalizeKnownBy(item.knownByIds).length && isRestrictedItem(dup))
            item.knownByIds = normalizeKnownBy(dup.knownBy);
          state.reviewSelected.add(actionEl.dataset.index);
          await persistPendingReview();
          render();
          return;
        }
        if (action === "scope-public") {
          const target = scopeTarget(String(actionEl.dataset.scopeKind || ""), actionEl.dataset.scopeIndex);
          if (!target)
            return;
          if (!window.confirm("이 후보를 모든 인물이 아는 기억으로 저장할까요? 일부 인물만 아는 원문에서 나온 후보입니다."))
            return;
          target.knownByIds = [];
          target.scopeConfirmed = true;
          if (actionEl.dataset.scopeKind === "review" || String(actionEl.dataset.scopeKind || "").startsWith("rev-"))
            await persistPendingReview();
          render();
          return;
        }
        if (action === "apply-review") {
          await applyReviewCandidates();
          return;
        }
        if (action === "apply-health") {
          await applyHealthCandidates();
          return;
        }
        if (action === "save-candidates") {
          const picked = state.candidates.filter((_, i) => state.candidateSelected.has(String(i)));
          const held = picked.filter(scopeBlocksApply);
          const selected = picked.filter((raw) => !scopeBlocksApply(raw));
          const epPicked = [...state.candEpisodeSelected].filter((i) => !episodeScopeBlocks(state.candEpisodes[Number(i)]));
          const thPicked = [...state.candThreadSelected].filter((i) => !threadCandidateBlocks(state.candThreads[Number(i)]));
          const epHeldCount = state.candEpisodeSelected.size - epPicked.length + state.candThreadSelected.size - thPicked.length;
          if (!selected.length && !epPicked.length && !thPicked.length) {
            if (held.length || epHeldCount)
              toast(`공개 범위를 확인해야 하는 후보 ${held.length + epHeldCount}개는 저장하지 않았습니다.`, true);
            return;
          }
          const data = normalizeData(state.currentData);
          const now = nowIso();
          for (const raw of selected.slice().reverse()) {
            if (raw.candidateId && data.items.some((row) => row.sourceCandidateId === raw.candidateId))
              continue;
            const item = normalizeItem({ ...raw, knownBy: normalizeKnownBy(raw.knownByIds), sourceCandidateId: raw.candidateId, id: uid(raw.type), createdAt: now, updatedAt: now });
            data.items.unshift(item);
          }
          const batch = state.candBatch || {};
          const ep = applyEpisodeCandidates(data, state.candEpisodes, state.candEpisodeSelected, { fps: parseRecord(batch.fps), sourceIds: safeArray(batch.sourceIds), rows: safeArray(batch.rows) });
          const th = applyThreadCandidates(data, state.candThreads, state.candThreadSelected, { fps: parseRecord(batch.fps), sourceIds: safeArray(batch.sourceIds), rows: safeArray(batch.rows) });
          await persistData(data);
          if (held.length || ep.held.length || th.held.length) {
            const thKeep = new Set(th.held.map(String));
            state.candThreads = state.candThreads.filter((_, i) => thKeep.has(String(i)));
            state.candThreadSelected = new Set;
            const keep = new Set(held);
            const epKeep = new Set(ep.held.map(String));
            state.candidates = state.candidates.filter((raw) => keep.has(raw));
            state.candEpisodes = state.candEpisodes.filter((_, i) => epKeep.has(String(i)));
            state.candidateSelected.clear();
            state.candEpisodeSelected = new Set;
            toast(`${selected.length + ep.applied + th.applied}개 저장 · 공개 범위 확인이 필요하거나 상한에 걸린 ${held.length + ep.held.length + th.held.length}개는 남겨뒀습니다.`, true);
            render();
            return;
          }
          state.layer = null;
          state.candidates = [];
          state.candidateSelected.clear();
          state.candEpisodes = [];
          state.candEpisodeSelected = new Set;
          state.candThreads = [];
          state.candThreadSelected = new Set;
          state.candBatch = null;
          render();
          return;
        }
        if (action === "sync") {
          await syncLorebook({ silent: false });
          try {
            await refreshAgentNotice();
            render();
          } catch {}
          return;
        }
        if (action === "import-legacy") {
          await importLegacy();
          render();
          return;
        }
        if (action === "reset-review-prompt") {
          const box = document.getElementById("mmc-review-prompt");
          if (box)
            box.value = DEFAULT_REVIEW_PROMPT;
          return;
        }
        if (action === "save-settings") {
          const data = normalizeData(state.currentData);
          data.maxPromises = Math.max(1, Math.min(20, Number(document.getElementById("mmc-max-promises")?.value) || data.maxPromises));
          data.maxAnchors = Math.max(1, Math.min(24, Number(document.getElementById("mmc-max-anchors")?.value) || data.maxAnchors));
          data.anchorBudgetChars = Math.max(600, Math.min(12000, Number(document.getElementById("mmc-anchor-budget")?.value) || data.anchorBudgetChars));
          const totalBudget = Math.max(0, Math.min(20000, Number(document.getElementById("mmc-total-budget")?.value) || 0));
          const episodeBox = document.getElementById("mmc-episode-injection");
          if (episodeBox && episodeBox.checked !== episodeInjectionOn(data))
            data.episodeInjection = episodeBox.checked;
          if (totalBudget || data.alwaysBudgetTokens)
            data.alwaysBudgetTokens = totalBudget;
          state.modelConnectionId = String(document.getElementById("mmc-settings-model")?.value || state.modelConnectionId || "");
          state.uiFontSize = ["normal", "large", "xlarge"].includes(document.getElementById("mmc-ui-font-size")?.value) ? document.getElementById("mmc-ui-font-size").value : "normal";
          state.koDisplay = String(document.getElementById("mmc-ko-display")?.value || "") === "original" ? "original" : "auto";
          const requestedTheme = String(document.querySelector('input[name="mmc-ui-theme"]:checked')?.value || state.uiThemeMode || "ribbon");
          state.uiThemeMode = UI_THEME_IDS.includes(requestedTheme) ? requestedTheme : "ribbon";
          const requestedMode = String(document.getElementById("mmc-summary-update-mode")?.value || state.summaryUpdateMode || "notify_model");
          if (!Object.prototype.hasOwnProperty.call(SUMMARY_UPDATE_MODE_LABEL, requestedMode))
            throw new Error("새 요약 갱신 방식 설정을 확인해 주세요.");
          if (requestedMode === "auto_apply" && state.summaryUpdateMode !== "auto_apply") {
            const ok = window.confirm(`완전 자동 적용은 새 요약 감지 때 모델 API 비용이 발생하고, 모델의 ADD/UPDATE/COMPLETE/ARCHIVE 판단이 확인 없이 바로 기억 보관함에 반영됩니다.
실험 기능을 켤까요?`);
            if (!ok) {
              const modeBox = document.getElementById("mmc-summary-update-mode");
              if (modeBox)
                modeBox.value = state.summaryUpdateMode;
              return;
            }
          }
          state.summaryUpdateMode = requestedMode;
          state.reviewPrompt = String(document.getElementById("mmc-review-prompt")?.value || "").trim() || DEFAULT_REVIEW_PROMPT;
          state.reviewExtraInstruction = String(document.getElementById("mmc-review-extra")?.value || "");
          await saveUiState();
          await persistData(data);
          state.layer = null;
          render();
          if (state.pendingSummaryRows.length)
            maybeAutoProcessSummaries();
          return;
        }
      } catch (error) {
        console.error("[기억 보관함]", error);
        toast(error.message || "작업에 실패했습니다.", true);
        state.busy = false;
        if (state.busyTimer)
          clearInterval(state.busyTimer);
        state.busyTimer = null;
        render();
      }
    }
    async function handleChange(event) {
      try {
        if (await handleWikiChange(event.target))
          return;
        if (event.target?.id === "mmc-chat-select") {
          const nextChatId = String(event.target.value || "");
          if (nextChatId !== state.selectedChatId && (state.candidates.length || state.healthCandidates.length || state.elementCandidates.length || state.wikiCandidates.length || state.rawRecovery?.text)) {
            const ok = window.confirm(`아직 저장/적용하지 않은 모델 후보가 있습니다.
다른 RP 문서로 이동하면 이번 후보는 사라집니다. 이동할까요?`);
            if (!ok) {
              event.target.value = state.selectedChatId;
              return;
            }
            state.candidates = [];
            state.candidateSelected.clear();
            state.elementCandidates = [];
            state.elementCandidateSelected.clear();
            state.elementExtractInfo = null;
            state.elementDraft = null;
            state.wikiCandidates = [];
            state.wikiCandidateSelected.clear();
            state.wikiDraft = null;
            state.wikiSourceRows = [];
            state.wikiSourceSelected.clear();
            state.wikiProposalDocId = "";
            state.wikiProposalSelected.clear();
            state.wikiSelectedId = "";
            state.wikiHistory = [];
            state.reviewCandidates = [];
            state.reviewSelected.clear();
            state.reviewSourceRows = [];
            state.healthCandidates = [];
            state.healthSelected.clear();
            state.rawRecovery = null;
          }
          state.selectedChatId = nextChatId;
          await saveUiState();
          setBusy(true, "RP 문서를 바꾸는 중…");
          await loadCurrentChat();
          state.modelConnectionId = chooseDefaultConnection(state.currentChat);
          await checkNewSummaries({ refreshChat: false, baselineIfUnknown: true, renderAfter: false });
          state.busy = false;
          if (state.busyTimer)
            clearInterval(state.busyTimer);
          state.busyTimer = null;
          render();
          return;
        }
        if (event.target?.matches?.("[data-scope-kind]")) {
          const kind = String(event.target.dataset.scopeKind || "");
          const charId = String(event.target.dataset.scopeChar || "");
          if (kind === "draft" || kind.startsWith("epdraft") || kind === "thdraft") {
            event.target.closest(".mmc-scope-chip")?.classList.toggle("is-on", !!event.target.checked);
            refreshDraftScopeDom(event.target.closest(".mmc-scope"));
            return;
          }
          const target = scopeTarget(kind, event.target.dataset.scopeIndex);
          if (!target || !charId)
            return;
          const ids = normalizeKnownBy(target.knownByIds).filter((id) => id !== charId);
          if (event.target.checked)
            ids.push(charId);
          target.knownByIds = ids;
          target.scopeConfirmed = true;
          if (kind === "review" || kind.startsWith("rev-"))
            await persistPendingReview();
          render();
          return;
        }
        if (event.target?.matches?.("[data-thread-index]")) {
          const set = event.target.dataset.threadKind === "rev" ? state.reviewThreadSelected : state.candThreadSelected;
          const id = String(event.target.dataset.threadIndex || "");
          if (event.target.checked)
            set.add(id);
          else
            set.delete(id);
          if (event.target.dataset.threadKind === "rev")
            await persistPendingReview();
          render();
          return;
        }
        if (event.target?.matches?.("[data-episode-index]")) {
          const set = event.target.dataset.episodeKind === "rev" ? state.reviewEpisodeSelected : state.candEpisodeSelected;
          const id = String(event.target.dataset.episodeIndex || "");
          if (event.target.checked)
            set.add(id);
          else
            set.delete(id);
          if (event.target.dataset.episodeKind === "rev")
            await persistPendingReview();
          render();
          return;
        }
        if (event.target?.matches?.("[data-source-id]")) {
          const id = String(event.target.dataset.sourceId || "");
          if (event.target.checked)
            state.sourceSelected.add(id);
          else
            state.sourceSelected.delete(id);
          render();
          return;
        }
        if (event.target?.matches?.("[data-candidate-index]")) {
          const id = String(event.target.dataset.candidateIndex || "");
          if (event.target.checked)
            state.candidateSelected.add(id);
          else
            state.candidateSelected.delete(id);
          updateCandidateSelectionDom("candidate", event.target);
          return;
        }
        if (event.target?.matches?.("[data-element-candidate-index]")) {
          const id = String(event.target.dataset.elementCandidateIndex || "");
          if (event.target.checked)
            state.elementCandidateSelected.add(id);
          else
            state.elementCandidateSelected.delete(id);
          render();
          return;
        }
        if (event.target?.matches?.("[data-review-index]")) {
          const id = String(event.target.dataset.reviewIndex || "");
          if (event.target.checked)
            state.reviewSelected.add(id);
          else
            state.reviewSelected.delete(id);
          updateCandidateSelectionDom("review", event.target);
          await persistPendingReview();
          return;
        }
        if (event.target?.matches?.("[data-health-index]")) {
          const id = String(event.target.dataset.healthIndex || "");
          if (event.target.checked)
            state.healthSelected.add(id);
          else
            state.healthSelected.delete(id);
          updateCandidateSelectionDom("health", event.target);
          return;
        }
        if (event.target?.name === "mmc-ui-theme") {
          const preview = UI_THEME_IDS.includes(event.target.value) ? event.target.value : state.uiThemeMode;
          for (const id of [ROOT_ID, LAUNCHER_ID, TOAST_ID]) {
            const node = document.getElementById(id);
            if (node)
              node.dataset.mmcTheme = preview;
          }
          return;
        }
        if (event.target?.name === "mmc-element-mode") {
          state.elementExtractMode = event.target.value === "range" ? "range" : "recent";
          await saveUiState();
          render();
          return;
        }
        if (event.target?.id === "mmc-source-model") {
          state.modelConnectionId = String(event.target.value || "");
          await saveUiState();
          render();
          return;
        }
      } catch (error) {
        toast(error.message || "변경에 실패했습니다.", true);
      }
    }
    function handleInput(event) {
      if (handleWikiInput(event.target))
        return;
      if (event.target?.id === "mmc-element-search") {
        state.elementSearch = String(event.target.value || "");
        const list = document.getElementById(ROOT_ID)?.querySelector?.(".mmc-element-list");
        if (list)
          list.innerHTML = elementListMarkup();
        return;
      }
      if (event.target?.id === "mmc-element-test") {
        state.elementTestText = String(event.target.value || "");
        const box = document.getElementById(ROOT_ID)?.querySelector?.(".mmc-element-test-results");
        if (box)
          box.innerHTML = elementTestResultsMarkup();
        return;
      }
    }
    function installDom() {
      if (document.getElementById(ROOT_ID))
        return;
      const launcher = document.createElement("button");
      launcher.id = LAUNCHER_ID;
      launcher.type = "button";
      launcher.className = "mmc-launcher";
      launcher.title = "기억 보관함";
      launcher.setAttribute("aria-label", "기억 보관함 열기");
      launcher.innerHTML = `${SVG.memory}<span>기억</span><i class="mmc-launcher-badge" hidden>0</i>`;
      document.body.append(launcher);
      const root = document.createElement("div");
      root.id = ROOT_ID;
      root.hidden = true;
      document.body.append(root);
      applyUiPreferences();
      on(launcher, "click", openModal);
      on(root, "click", handleClick);
      on(root, "change", handleChange);
      on(root, "input", handleInput);
      on(document, "keydown", (event) => {
        if (event.key !== "Escape" || root.hidden)
          return;
        if (state.layer)
          requestCloseLayer();
        else
          closeModal();
      });
      installPassiveSummaryObserver();
      const primeTimer = window.setTimeout(() => {
        primeSummaryObserver();
      }, 900);
      cleanupFns.push(() => window.clearTimeout(primeTimer), () => launcher.remove(), () => root.remove());
    }
    function cleanup() {
      if (state.busyTimer)
        clearInterval(state.busyTimer);
      for (const fn of cleanupFns.splice(0)) {
        try {
          fn();
        } catch {}
      }
    }
    try {
      if (typeof marinara !== "undefined" && typeof marinara?.onCleanup === "function")
        marinara.onCleanup(cleanup);
    } catch {}
    if (document.readyState === "loading")
      on(document, "DOMContentLoaded", installDom, { once: true });
    else
      installDom();
  })();
}

// src/frontend.js
function setup(ctx, { win = globalThis.window, doc = globalThis.document } = {}) {
  const activeId = () => {
    try {
      const c = ctx.getActiveChat?.();
      if (c && typeof c.chatId === "string")
        return c.chatId;
    } catch {}
    try {
      return ctx.state?.get?.("chat.active")?.chatId || "";
    } catch {
      return "";
    }
  };
  const syncKey = () => {
    try {
      const id = activeId();
      if (id)
        win.localStorage.setItem("marinara-active-chat-id", id);
    } catch {}
  };
  const shim = installShim(ctx, { win, activeChatId: activeId });
  const panel = createPanel(ctx, shim, { win, doc });
  const guard = installConfirmGuard(win, doc, { notify: (m, d) => panel.toast(m, d) });
  const style = doc.createElement("style");
  style.textContent = ORIGINAL_CSS;
  (doc.head || doc.documentElement).append(style);
  const hostTheme = installHostTheme(win, doc);
  const drag = installLauncherDrag(win, doc, { notify: (m, d) => panel.toast(m, d) });
  let run = null, runFor = "", timer = null, alive = true;
  const mount = () => {
    syncKey();
    runFor = activeId();
    run = shim.createMarinara();
    runOriginal(run.marinara);
  };
  const modalOpen = () => {
    const r = doc.getElementById("mmc-root-v1");
    return !!r && !r.hidden;
  };
  const onSwitch = () => {
    clearTimeout(timer);
    if (!alive || activeId() === runFor)
      return;
    if (modalOpen()) {
      timer = setTimeout(onSwitch, 2000);
      return;
    }
    run?.runCleanups();
    mount();
  };
  mount();
  const offs = [];
  for (const ev of ["CHAT_SWITCHED", "CHAT_CHANGED"]) {
    try {
      const o = ctx.events?.on?.(ev, () => {
        timer = setTimeout(onSwitch, 0);
      });
      if (typeof o === "function")
        offs.push(o);
    } catch {}
  }
  try {
    const o = ctx.state?.subscribe?.("chat.active", () => {
      timer = setTimeout(onSwitch, 0);
    });
    if (typeof o === "function")
      offs.push(o);
  } catch {}
  panel.promptIfMigrationPending();
  return () => {
    alive = false;
    clearTimeout(timer);
    offs.forEach((o) => {
      try {
        o();
      } catch {}
    });
    run?.runCleanups();
    guard.dispose();
    drag.dispose();
    hostTheme.dispose();
    panel.dispose();
    shim.dispose();
    style.remove();
  };
}
export {
  setup
};
