import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as runner from '../scripts/run-check.js';
test('QA never reports spawn denial as exit zero',()=>{
 assert.equal(typeof runner.classifyCheck,'function');
 const result=runner.classifyCheck({status:0,stdout:'',stderr:'',error:Object.assign(new Error('spawn denied'),{code:'EPERM'})});
 assert.equal(result.exitCode,1);assert.equal(result.error,'EPERM');
});
test('QA rejects empty test report despite zero exit status',()=>{
 assert.equal(typeof runner.classifyCheck,'function');
 assert.equal(runner.classifyCheck({status:0,stdout:'',stderr:''},true).exitCode,1);
 assert.equal(runner.classifyCheck({status:0,stdout:'ℹ tests 13\nℹ pass 13\nℹ fail 0',stderr:''},true).exitCode,0);
});
