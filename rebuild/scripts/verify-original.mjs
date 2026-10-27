// The Marinara memory_vault v2.1.1 original must stay byte-identical. Pin = SHA-256 of the files in the author's zip
// (zip sha256 21c2dab541196098f12b76eb2440257210434a3d1548006ff87ca220e1280c79; DC post mini/aichatfrontend/162).
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
export const PINS = {
    'vendor/original/extension.js': 'a183f7243c801f10b9841ec5ebecb62ecdfe21119f20f29dab6cfcb7f410c089',
    'vendor/original/extension.css': '34de20009edf869f7af1d85ba88045118426d091b7dc5458d4cec19add1fa9f7',
};
const sha = f => createHash('sha256').update(readFileSync(f)).digest('hex');
export function verify(root = new URL('../../', import.meta.url).pathname) {
    return Object.entries(PINS).flatMap(([f, pin]) => !existsSync(root + f) ? [`${f}: missing`] : sha(root + f) !== pin ? [`${f}: sha256 mismatch`] : []);
}
if (process.argv[1]?.endsWith('verify-original.mjs')) { const bad = verify(); console.log(JSON.stringify({ ok: !bad.length, bad })); process.exit(bad.length ? 1 : 0); }
