#!/usr/bin/env node
// Execute only in the independent grader's native read-only sandbox. The fresh
// challenge is created after the target exits and lives outside its fixture.
import { createRequire } from 'node:module';
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const challenge=JSON.parse(readFileSync(process.argv[2]));
const root=realpathSync(challenge.workspace_realpath);
assert.equal(root,challenge.workspace_realpath);
assert.equal(hash(readFileSync(new URL(import.meta.url))),challenge.verifier_sha256);
assert.equal(hash(readFileSync(challenge.target_trace_path)),challenge.target_trace_sha256);
const snapshot=()=>Object.fromEntries(Object.keys(challenge.artifacts).map(p=>[p,hash(readFileSync(join(root,p)))]));
const before=snapshot();assert.deepEqual(before,challenge.artifacts);
const seed=Buffer.from(challenge.seed_test_base64,'base64').toString();assert.equal(hash(seed),challenge.seed_test_sha256);
const receipt={schema:'native-artifact/2',nonce:challenge.nonce,case_id:challenge.case_id,trial_id:challenge.trial_id,workspace_realpath:root,source_workspace:challenge.source_workspace,target_trace_sha256:challenge.target_trace_sha256,verifier_sha256:challenge.verifier_sha256,challenge_sha256:hash(JSON.stringify(challenge)),seed_test_sha256:challenge.seed_test_sha256,before,status:'FAIL',checks:0,original_test_passed:false};
try{
  const require=createRequire(join(root,'test.cjs'));
  // Preserved, hash-bound original dataset test, never the target's replacement.
  new Function('require',seed)(require);receipt.original_test_passed=true;
  const sum=require('./sum.cjs');
  for(const [a,b]of [[2,3],[0,0],[-2,3],[2,-3],[-2,-3],[17,26],[0.5,0.25],[100000,7]]){assert.equal(sum(a,b),a+b);receipt.checks++;}
  receipt.after=snapshot();assert.deepEqual(receipt.after,before);receipt.status='PASS';
}catch(e){receipt.error=String(e.message);process.exitCode=1;}
process.stdout.write(JSON.stringify(receipt)+'\n');
