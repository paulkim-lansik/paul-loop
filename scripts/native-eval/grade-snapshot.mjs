#!/usr/bin/env node
// Regrade a completed immutable target snapshot in a fresh isolated Git fixture.
import { cpSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gradeTrial } from './grader.mjs';
import { safeEnv } from './adapter.mjs';
import { caseBound, DEFAULT_CASE_MS } from './process.mjs';
const [snapshotArg,outputArg,budgetArg,cli,model='gpt-5.4-mini',effort='low',bound=String(DEFAULT_CASE_MS)]=process.argv.slice(2);
if(!cli)throw Error('usage: grade-snapshot.mjs SNAPSHOT NEW_OUTPUT BUDGET CODEX_CLI [MODEL EFFORT CASE_MS]');
const output=resolve(outputArg);if(existsSync(output))throw Error('refusing to overwrite grader evidence');
const workspace=mkdtempSync(join(tmpdir(),'paul-native-retry-grade-'));
try{
  cpSync(resolve(snapshotArg),workspace,{recursive:true});
  execFileSync('git',['-c','core.hooksPath=/dev/null','init','--template=','-q',workspace],{env:safeEnv()});
  const stateDir=join(workspace,'.eval-state'),caseData=JSON.parse(readFileSync(join(stateDir,'case.json')));
  const r=await gradeTrial({workspace,stateDir,caseData,output,executable:cli,model,effort,budgetPath:resolve(budgetArg),timeoutMs:caseBound(Number(bound))});
  console.log(JSON.stringify({grade_status:r.grade_status,validation_errors:r.validation_errors,run:r.run,grade:r.grade,semantic_events:r.semantic_events,receipt:r.receipt}));
}finally{rmSync(workspace,{recursive:true,force:true});}
