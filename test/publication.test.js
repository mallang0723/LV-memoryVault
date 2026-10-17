import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createService} from '../src/service.js';
import {readFileSync} from 'node:fs';
import {vaultStyle} from '../src/vault-style.js';
test('connection picker exposes only owner-scoped names, IDs and models',async()=>{
 let owner;let generation=true;
 const api={permissions:{has:p=>p!=='generation'||generation},chats:{getActive:async()=>({id:'chat'}),get:async()=>({id:'chat',metadata:{}})},userStorage:{exists:async()=>false},connections:{list:async user=>{owner=user;return [{id:'connection',name:'테스트 모델',model:'fixture',api_key:'DO_NOT_EXPOSE',api_url:'DO_NOT_EXPOSE',metadata:{private:'DO_NOT_EXPOSE'}}];}}};
 const service=createService(api),response=await service.run({type:'connections'},'owner');assert.equal(owner,'owner');assert.deepEqual(response.connections,[{id:'connection',name:'테스트 모델',model:'fixture'}]);assert.ok(!JSON.stringify(response).includes('DO_NOT_EXPOSE'));
 generation=false;await assert.rejects(()=>service.run({type:'connections'},'owner'),/권한 필요/);
});
test('source entry points and original styles remain available',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../spindle.json',import.meta.url),'utf8'));
 assert.equal(manifest.github,'https://github.com/mallang0723/LV-memoryVault');assert.equal(manifest.homepage,manifest.github);
 assert.match(readFileSync(new URL('../src/backend.ts',import.meta.url),'utf8'),/import '\.\/backend\.js'/);
 assert.match(readFileSync(new URL('../src/frontend.ts',import.meta.url),'utf8'),/export \{setup\}/);
 assert.match(vaultStyle,/\.mmc-tabs/);assert.match(vaultStyle,/\.mmc-ov-grid/);
 assert.ok(!readFileSync(new URL('../.gitignore',import.meta.url),'utf8').split('\n').includes('dist/'));
});
