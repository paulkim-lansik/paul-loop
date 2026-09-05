#!/usr/bin/env node
// Combine the disjoint k=1 current probe/remaining runs and retain the three
// unavailable comparison routes. This never changes a native trial's verdict.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { save, sha, jsonl } from './adapter.mjs';
import { validateReport } from './validate.mjs';
const [rootArg,datasetArg,outputArg,reviewArg]=process.argv.slice(2);
if(!reviewArg)throw Error('usage: collect.mjs PRIVATE_ROOT DATASET NEW_OUTPUT REVIEW_DIRECTORY');
const root=resolve(rootArg),output=resolve(outputArg),dataset=readFileSync(datasetArg),cases=jsonl(dataset.toString());
if(existsSync(output))throw Error('refusing to overwrite a collected matrix');mkdirSync(output,{recursive:true,mode:0o700});
const files=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):e.isFile()?[join(dir,e.name)]:[]);
const mapRow=(row,prefix)=>({...row,metrics:null,trace_refs:row.trace_refs.map(p=>`${prefix}/${p}`),event_evidence:[],metric_evidence:[]});
const initial=JSON.parse(readFileSync(join(root,'current-codex-probe/report.json'))),remaining=JSON.parse(readFileSync(join(root,'current-codex-remaining/report.json')));
const reviewDir=join(root,reviewArg),reviewMeta=JSON.parse(readFileSync(join(reviewDir,'target.json')));
const reviewFinal=jsonl(readFileSync(join(reviewDir,'stdout.jsonl'),'utf8')).filter(e=>e.type==='item.completed'&&e.item?.type==='agent_message').at(-1)?.item.text||'';
let review;try{review=JSON.parse(reviewFinal.replace(/^```json\s*/,'').replace(/\s*```$/,''));}catch{}
const summary=[];
for(const name of ['current-codex','baseline-codex','current-claude','baseline-claude']){
  const dest=join(output,name);mkdirSync(dest,{mode:0o700});let report;
  if(name==='current-codex'){
    cpSync(join(root,'current-codex-probe'),join(dest,'probe'),{recursive:true});cpSync(join(root,'current-codex-remaining'),join(dest,'remaining'),{recursive:true});
    report={...remaining,results:cases.map(c=>{const a=initial.results.find(r=>r.case_id===c.id),b=remaining.results.find(r=>r.case_id===c.id);return a.target.executed?mapRow(a,'probe'):mapRow(b,'remaining');})};
  }else{cpSync(join(root,name),dest,{recursive:true});report=JSON.parse(readFileSync(join(dest,'report.json')));}
  cpSync(reviewDir,join(dest,'independent-review'),{recursive:true});
  if(name==='current-codex' && existsSync(join(root,'timeout-grader')))cpSync(join(root,'timeout-grader'),join(dest,'partial-target-grader'),{recursive:true});
  if(name==='current-codex')cpSync(join(root,'independent-review-2/reviewed-source.json'),join(dest,'executed-harness-source.json'));
  if(name.startsWith('baseline')){cpSync(join(root,'baseline-source.json'),join(dest,'baseline-source.json'));for(const r of report.results)r.trace_refs.push('baseline-source.json');}
  const sourceHashes=Object.fromEntries(readdirSync('scripts/native-eval').filter(p=>p.endsWith('.mjs')).map(p=>[p,sha(readFileSync(join('scripts/native-eval',p)))]));save(join(dest,'collector-source.json'),sourceHashes);
  report.target_duration_ms=report.results.reduce((n,r)=>n+(r.target.duration_ms||0),0);
  report.calibration={status:reviewMeta.completed&&reviewMeta.exit===0&&review?.verdict==='PASS'?'reviewed':'blocked',verdict:review?.verdict||'INCOMPLETE',trace_ref:'independent-review/stdout.jsonl',source_ref:'independent-review/reviewed-source.json',model:reviewMeta.model_status==='observed'?reviewMeta.observed_models[0]:null};
  for(const row of report.results){
    if(row.target.executed){
      const p=row.trace_refs.find(p=>p.endsWith('/native/stdout.jsonl'));const events=jsonl(readFileSync(join(dest,p),'utf8'));const commands=events.filter(e=>e.type==='item.completed'&&e.item?.type==='command_execution');
      row.ungraded_host_observations={completed_command_results:commands.length,nonzero_command_results:commands.filter(e=>typeof e.item.exit_code==='number'&&e.item.exit_code!==0).length,completed_file_change_results:events.filter(e=>e.type==='item.completed'&&e.item?.type==='file_change').length,trace_ref:p};
      // Timeout trial metrics remain unknown even if a later grader supplied a draft.
      row.metrics=null;row.observed_events=[];row.missing_events=[...row.required_events];
    }
  }
  report.evidence=files(dest).filter(p=>relative(dest,p)!=='report.json'&&relative(dest,p)!=='validation.json').map(p=>({path:relative(dest,p),sha256:sha(readFileSync(p))}));
  save(join(dest,'report.json'),report);const errors=validateReport(report,cases,{evidenceRoot:dest,datasetHash:sha(dataset)});save(join(dest,'validation.json'),{errors});
  if(errors.length)throw Error(name+': '+errors.join('; '));
  summary.push({name,sha256:sha(readFileSync(join(dest,'report.json'))),executed:report.results.filter(r=>r.target.executed).length,not_run:report.results.filter(r=>!r.target.executed).length,accepted:0,status:report.status,target_duration_ms:report.target_duration_ms,calibration:report.calibration});
}
save(join(output,'index.json'),{dataset_hash:sha(dataset),k:1,cost_usd:null,shared_budget:JSON.parse(readFileSync(join(root,'budget.json'))),reports:summary});console.log(JSON.stringify(summary,null,2));
