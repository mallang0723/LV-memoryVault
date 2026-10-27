// JSON download that works on plain-http origins and phones: Blob + a[download] (not a secure-context API), with a visible
// textarea fallback (select + execCommand('copy')) when the browser ignores the download. navigator.clipboard is deliberately not used.
export function downloadJson(doc, name, { document: d = globalThis.document, URL: U = globalThis.URL, Blob: B = globalThis.Blob } = {}) {
    const text = JSON.stringify(doc, null, 1);
    try {
        const url = U.createObjectURL(new B([text], { type: 'application/json' }));
        const a = d.createElement('a'); a.href = url; a.download = name; a.style.display = 'none';
        d.body.append(a); a.click(); a.remove();
        setTimeout(() => { try { U.revokeObjectURL(url); } catch { /* ignore */ } }, 30_000);
        return { method: 'blob', bytes: text.length };
    } catch { /* fall through to the text box */ }
    const t = d.createElement('textarea'); t.value = text; t.readOnly = true; t.setAttribute('aria-label', '백업 JSON — 전체 선택해 복사하세요'); t.style.cssText = 'position:fixed;inset:10% 5%;width:90%;height:70%;z-index:2147483647';
    d.body.append(t); t.select?.();
    let copied = false; try { copied = !!d.execCommand?.('copy'); } catch { /* manual copy */ }
    return { method: 'textarea', copied, bytes: text.length, remove: () => t.remove() };
}
