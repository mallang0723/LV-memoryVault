import {readFile,mkdir,writeFile} from 'node:fs/promises';
await mkdir('dist',{recursive:true});
const backend=(await Promise.all(['core','chronicle','chronicle-service','service','backend'].map(n=>readFile('src/'+n+'.js','utf8')))).map(s=>s.replace(/^import .* from '\.\/.*';\n/gm,'')).join('\n');
await writeFile('dist/backend.js',backend);
const frontend=(await Promise.all(['core','chronicle','vault-style','scene-view','view','frontend'].map(n=>readFile('src/'+n+'.js','utf8')))).map(s=>s.replace(/^import .* from '\.\/.*';\n/gm,'')).join('\n');
await writeFile('dist/frontend.js',frontend);
console.log(JSON.stringify({ok:true,artifacts:['dist/backend.js','dist/frontend.js'],dependencies:0}));
