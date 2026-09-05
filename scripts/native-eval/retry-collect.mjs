#!/usr/bin/env node
// Immutable collection of disjoint k=1 retry trials; no target execution or promotion.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { save, sha, jsonl } from './adapter.mjs';
import { semanticEvents } from './proof.mjs';
import { finalText, parseGrade } from './grader.mjs';
import { validateReport } from './validate.mjs';
const [rootArg,datasetArg,outputArg,reviewArg]=process.argv.slice(2);
if(!reviewArg)throw Error('usage: retry-collect.mjs RETRY_ROOT DATASET NEW_OUTPUT REVIEW_DIRECTORY');
const root=resolve(rootArg),out=resolve(outputArg),dataset=readFileSync(datasetArg),cases=jsonl(dataset.toString()),reviewDir=resolve(reviewArg);
if(existsSync(out))throw Error('refusing to overwrite collection');mkdirSync(out,{recursive:true,mode:0o700});
const files=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(join(dir,e.name)):e.isFile()?[join(dir,e.name)]:[]);
const obj=p=>JSON.parse(readFileSync(p));
const remap=(row,prefix)=>({...row,trace_refs:row.trace_refs.map(p=>`${prefix}/${p}`),artifact_refs:row.artifact_refs?.map(p=>`${prefix}/${p}`),event_evidence:row.event_evidence?.map(e=>({...e,path:`${prefix}/${e.path}`})),grader:row.grader?{...row.grader,trace_ref:`${prefix}/${row.grader.trace_ref}`,grade_ref:`${prefix}/${row.grader.grade_ref}`}:null});
const summaries=[];
for(const name of ['current-codex','baseline-codex','current-claude','baseline-claude']){
  const dest=join(out,name);mkdirSync(dest,{mode:0o700});let report;
  if(name==='current-codex'){
    for(const d of ['first','remaining','first-grader'])cpSync(join(root,d),join(dest,d),{recursive:true});
    const first=obj(join(root,'first/report.json')),remaining=obj(join(root,'remaining/report.json'));
    report={...remaining,results:cases.map(c=>{
      const a=first.results.find(r=>r.case_id===c.id),b=remaining.results.find(r=>r.case_id===c.id);
      if(a.target.executed&&b.target.executed)throw Error('duplicate k=1 execution: '+c.id);
      return a.target.executed?remap(a,'first'):remap(b,'remaining');
    })};
    const row=report.results.find(r=>r.case_id==='reuse-test-approval'),g=obj(join(dest,'first-grader/grade.json'));
    row.grader={grade_status:g.grade_status,duration_ms:g.run.duration_ms,configured_timeout_ms:g.run.configured_timeout_ms,effective_timeout_ms:g.run.effective_timeout_ms,exit:g.run.exit,completed:g.run.completed,independence:g.independence,model:g.run.observed_models.length===1?g.run.observed_models[0]:null,trace_ref:'first-grader/stdout.jsonl',grade_ref:'first-grader/grade.json'};
    row.grade_draft=g.grade;row.reason='Completed native target and independent draft; native enforcement and accepted metrics remain unqualified';
    const state=`first/${row.case_id}/.eval-state`,target=obj(join(dest,state,'native/target.json'));
    row.trace_refs.push(`${state}/before.json`,`${state}/after.json`);
    row.artifact_refs=Object.keys(cases.find(c=>c.id===row.case_id).files).filter(p=>existsSync(join(dest,'first',row.case_id,p))).map(p=>`first/${row.case_id}/${p}`);
    const links=semanticEvents({caseData:cases.find(c=>c.id===row.case_id),trace:readFileSync(join(dest,state,'native/stdout.jsonl'),'utf8'),target,before:obj(join(dest,state,'before.json')),after:obj(join(dest,state,'after.json'))});
    row.observed_events=[...new Set(links.map(e=>e.event))];row.missing_events=row.required_events.filter(e=>!row.observed_events.includes(e));row.event_evidence=links.map(e=>({...e,path:`${state}/native/stdout.jsonl`}));
  }else{cpSync(join(root,name),dest,{recursive:true});report=obj(join(dest,'report.json'));}
  cpSync(reviewDir,join(dest,'independent-review'),{recursive:true});
  const reviewMeta=obj(join(reviewDir,'target.json')),review=parseGrade(finalText('codex',readFileSync(join(reviewDir,'stdout.jsonl'),'utf8')));
  report.calibration={status:reviewMeta.completed&&reviewMeta.exit===0&&!reviewMeta.fault&&review?.verdict==='PASS'?'reviewed-draft-only':'blocked',verdict:review?.verdict||'INCOMPLETE',trace_ref:'independent-review/stdout.jsonl',source_ref:'independent-review/reviewed-source.json',model:reviewMeta.observed_models.length===1?reviewMeta.observed_models[0]:null};
  report.target_duration_ms=report.results.reduce((n,r)=>n+(r.target.duration_ms||0),0);
  report.evidence=files(dest).filter(p=>!['report.json','validation.json'].includes(relative(dest,p))).map(p=>({path:relative(dest,p),sha256:sha(readFileSync(p))}));
  save(join(dest,'report.json'),report);const errors=validateReport(report,cases,{evidenceRoot:dest,datasetHash:sha(dataset)});save(join(dest,'validation.json'),{errors});if(errors.length)throw Error(name+': '+errors.join('; '));
  summaries.push({name,sha256:sha(readFileSync(join(dest,'report.json'))),executed:report.results.filter(r=>r.target.executed).length,completed:report.results.filter(r=>r.target.completed&&r.target.exit===0&&!r.target.fault).length,not_run:report.results.filter(r=>!r.target.executed).length,graders_completed:report.results.filter(r=>r.grader?.completed&&r.grader.exit===0).length,validated_drafts:report.results.filter(r=>r.grader?.grade_status==='validated-draft').length,accepted:0,status:report.status,target_duration_ms:report.target_duration_ms});
}
save(join(out,'index.json'),{dataset_hash:sha(dataset),k:1,cost_usd:null,shared_budget:obj(join(root,'budget.json')),reports:summaries});console.log(JSON.stringify(summaries));
