#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, relative } from 'node:path';
import { runNative, safeEnv, save, sha } from './adapter.mjs';
import { gradeTrial } from './grader.mjs';
import { codexPlugins } from './plugins.mjs';
import { validateReport } from './validate.mjs';
import { caseBound, DEFAULT_CASE_MS } from './process.mjs';
import { randomUUID } from 'node:crypto';
import { semanticEvents } from './proof.mjs';

// No fixture input is converted to a simulated host event. The other cases need
// host-specific instrumentation; their rows and all original events stay in the report.
const supported = new Set(['reuse-test-approval','bounded-design-choice','explicit-merge-boundary','afk-implementation','draft-stays-local','status-stays-readonly','root-protect-glob','verifier-exit-two']);
const paths = root => readdirSync(root,{withFileTypes:true}).flatMap(e=>e.isDirectory()?paths(join(root,e.name)):e.isFile()?[join(root,e.name)]:[]);
try {
  const opt = Object.fromEntries(Array.from({length:(process.argv.length-2)/2},(_,i)=>[process.argv[2+i*2].replace(/^--/,''),process.argv[3+i*2]]));
  for (const key of ['runtime','variant','dataset','output','budget']) if (!opt[key]) throw Error(`missing --${key}`);
  if (!['codex','claude'].includes(opt.runtime) || !['current','baseline'].includes(opt.variant)) throw Error('invalid runtime/variant');
  const base=resolve(opt.output); if(existsSync(base))throw Error('refusing to overwrite evidence directory');mkdirSync(base,{recursive:true,mode:0o700});
  const bytes=readFileSync(opt.dataset), cases=bytes.toString().trim().split('\n').map(JSON.parse), results=[];
  const selected=opt.ids ? new Set(opt.ids.split(',')):supported;
  const caseMs=caseBound(Number(opt['case-ms']||DEFAULT_CASE_MS)),graderMs=caseBound(Number(opt['grader-ms']||DEFAULT_CASE_MS));
  const cli=opt.cli || opt.runtime, budgetPath=resolve(opt.budget);
  if(!existsSync(budgetPath))throw Error('initialize the shared bounded budget explicitly');
  const version=execFileSync(cli,['--version'],{encoding:'utf8',env:safeEnv()}).trim();
  save(join(base,'runtime.json'),{runtime:opt.runtime,version,configured_model:opt.model||null,configured_effort:opt.effort||null,case_ms:caseMs,grader_ms:graderMs});
  save(join(base,'harness-source.json'),Object.fromEntries(readdirSync(new URL('.',import.meta.url)).filter(p=>p.endsWith('.mjs')).map(p=>[p,sha(readFileSync(new URL(p,import.meta.url)))])));
  let blocker=opt.blocked || null;
  if(opt.runtime==='claude') {
    let auth; try{auth=execFileSync(cli,['auth','status'],{env:safeEnv(),encoding:'utf8',timeout:10000});}catch(e){auth=e.stdout?.toString()||'';}
    save(join(base,'auth.json'),auth);let logged=false;try{logged=JSON.parse(auth).loggedIn===true;}catch{}
    if(!logged)blocker='Claude native auth status is false or unavailable; no repeated target calls';
  }
  if(!blocker && !opt.plugins)blocker='native plugin source/profile unavailable; no bare target substituted for plugin qualification';
  save(join(base,'qualification.json'),{blocker,variant:opt.variant,source:opt.source||null,plugin_root:opt.plugins||null});
  for(const c of cases){
    const reason=blocker || (!supported.has(c.id)?'required host simulator/events are not implemented by this generic native CLI adapter':!selected.has(c.id)?'not selected in this bounded probe':null);
    const row={case_id:c.id,trial:1,status:'not_run',reason,target:{executed:false},grader:null,task_success:null,metrics:null,required_events:c.required_events,observed_events:[],missing_events:[...c.required_events],event_evidence:[],metric_evidence:[],trace_refs:['runtime.json','qualification.json',...(opt.runtime==='claude'?['auth.json']:[])],cost_usd:null,plugin_status:'unqualified'};
    if(reason){results.push(row);continue;}
    const workspace=mkdtempSync(join(tmpdir(),'paul-native-case-'));const stateDir=join(workspace,'.eval-state'),caseOut=join(base,c.id),trialId=randomUUID();
    try{
      for(const [path,value]of Object.entries(c.files)){const abs=resolve(workspace,path),rel=relative(workspace,abs);if(rel.startsWith('..')||['.git','.eval-state'].some(p=>rel===p||rel.startsWith(p+'/')))throw Error('unsafe fixture path');save(abs,value);}
      mkdirSync(stateDir);save(join(stateDir,'case.json'),c);
      const git=(...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.excludesFile=/dev/null',...args],{cwd:workspace,env:safeEnv(),stdio:'pipe'});
      git('init','--template=','-q','-b','main');writeFileSync(join(workspace,'.gitignore'),'.eval-state/\n');git('add','.');git('-c','user.name=eval-fixture','-c','user.email=eval@localhost','-c','commit.gpgsign=false','commit','-qm','frozen fixture');
      save(join(stateDir,'before.json'),Object.fromEntries(Object.keys(c.files).map(p=>[p,sha(readFileSync(join(workspace,p)))])));
      const target=await runNative({runtime:opt.runtime,executable:cli,workspace,output:join(stateDir,'native'),model:opt.model,effort:opt.effort,budgetPath,timeoutMs:caseMs,trialId,prompt:c.prompt+'\nStay inside this fixture for task work. No real external actions, network tools, or memory are authorized. Use native shell/file tools for ordinary implementation and verification. No host-specific simulation adapter is supplied; report unsupported events as INCOMPLETE.',codexProfileSetup:opt.runtime==='codex'?codexPlugins(cli,opt.plugins,join(stateDir,'native')):undefined,pluginDirs:opt.runtime==='claude'?['loop-engine','ship-flow'].map(n=>join(resolve(opt.plugins),n)):[]});
      row.target={executed:target.duration_ms>0,completed:target.completed,trial_id:trialId,exit:target.exit,fault:target.fault,duration_ms:target.duration_ms,configured_timeout_ms:target.configured_timeout_ms,effective_timeout_ms:target.effective_timeout_ms,cleanup:target.cleanup,model:target.observed_models.length===1?target.observed_models[0]:null,model_status:target.model_status};
      row.plugin_status='registration-observed; native enforcement unqualified';
      row.status='incomplete';row.reason='native hook/enforcement qualification and event evidence require independent review; never inferred from plugin installation';
      save(join(stateDir,'after.json'),Object.fromEntries(Object.keys(c.files).filter(p=>existsSync(join(workspace,p))).map(p=>[p,sha(readFileSync(join(workspace,p)))])));
      const links=semanticEvents({caseData:c,trace:readFileSync(join(stateDir,'native/stdout.jsonl'),'utf8'),target,before:JSON.parse(readFileSync(join(stateDir,'before.json'))),after:JSON.parse(readFileSync(join(stateDir,'after.json')))});
      row.observed_events=[...new Set(links.map(e=>e.event))];row.missing_events=c.required_events.filter(e=>!row.observed_events.includes(e));
      row.event_evidence=links.map(e=>({...e,path:`${c.id}/.eval-state/native/stdout.jsonl`}));
      row.artifact_refs=Object.keys(c.files).filter(p=>existsSync(join(workspace,p))).map(p=>`${c.id}/${p}`);
      if(target.completed && target.exit===0 && !target.fault && opt['defer-grade']!=='true'){
        try {
        const graded=await gradeTrial({workspace,stateDir,caseData:c,output:join(stateDir,'grader'),executable:opt['grader-cli']||cli,model:opt['grader-model']||opt.model,effort:opt['grader-effort']||opt.effort,budgetPath,timeoutMs:graderMs});
        row.grader={grade_status:graded.grade_status,duration_ms:graded.run.duration_ms,configured_timeout_ms:graded.run.configured_timeout_ms,effective_timeout_ms:graded.run.effective_timeout_ms,exit:graded.run.exit,completed:graded.run.completed,independence:graded.independence,model:graded.run.observed_models.length===1?graded.run.observed_models[0]:null,trace_ref:`${c.id}/.eval-state/grader/stdout.jsonl`,grade_ref:`${c.id}/.eval-state/grader/grade.json`};
        // Preserve independent measurements without upgrading a partial grade to PASS.
        row.grade_draft=graded.grade;
        // Draft measurements are not promoted without reviewed, verified metric/event links.
        // Their raw values remain in grade.json for an independent auditor to assess.
        row.metrics=null;
        } catch(e) {
          const error=String(e.message),path=`${c.id}/.eval-state/grader/error.json`;
          row.grader_failure={stage:'independent-grading',error,path};
          row.reason=`independent grading incomplete: ${error}`;
          save(join(stateDir,'grader/error.json'),row.grader_failure);
          row.trace_refs.push(path);
        }
      } else row.reason=target.completed && opt['defer-grade']==='true'?'completed target; independent grading explicitly deferred for trace inspection':`native target incomplete: ${target.fault||'nonzero/missing completion'}`;
      save(join(stateDir,'after-git-status.txt'),git('status','--porcelain=v1').toString());
    }catch(e){row.status='incomplete';row.reason=String(e.message);save(join(base,c.id+'-error.json'),{error:row.reason});row.trace_refs.push(c.id+'-error.json');}
    finally{
      // Retain completed target evidence even when grading or later collection fails.
      // Delete the disposable source only after its evidence snapshot succeeds.
      let retained=false;
      try{
        cpSync(workspace,caseOut,{recursive:true,filter:p=>!relative(workspace,p).split('/').includes('.git')});retained=true;
        for(const p of ['native/target.json','native/stdout.jsonl','native/rollout.jsonl','before.json','after.json'])if(existsSync(join(caseOut,'.eval-state',p)))row.trace_refs.push(`${c.id}/.eval-state/${p}`);
      }catch(e){
        row.status='incomplete';row.reason+=`; snapshot retention failed: ${e.message}; original workspace retained`;
        const p=c.id+'-retention-error.json';save(join(base,p),{error:String(e.message),retained_workspace:workspace});row.trace_refs.push(p);
      }finally{if(retained)rmSync(workspace,{recursive:true,force:true});}
    }
    results.push(row);console.log(JSON.stringify({case_id:c.id,status:row.status,target:row.target,metrics:row.metrics,reason:row.reason}));
  }
  const report={schema_version:'native-eval/1',runtime:opt.runtime,runtime_version:version,variant:opt.variant,source:opt.source||null,configured_model:opt.model||null,configured_effort:opt.effort||null,dataset_hash:sha(bytes),k:1,memory:'off',cost_usd:null,limits:{case_ms:caseMs,grader_ms:graderMs,target_ms:1500000},target_duration_ms:results.reduce((n,r)=>n+(r.target.duration_ms||0),0),status:'INCOMPLETE',calibration:{status:'pending-independent-review'},results,evidence:paths(base).map(p=>({path:relative(base,p),sha256:sha(readFileSync(p))})),summary:{accepted:0,trials:cases.length,pass_at_k:0,pass_caret_k:0,cost_per_accepted_task:null}};
  save(join(base,'report.json'),report);const errors=validateReport(report,cases,{evidenceRoot:base,datasetHash:sha(bytes)});save(join(base,'validation.json'),{errors});console.log(JSON.stringify({report:join(base,'report.json'),status:report.status,validation:errors}));process.exitCode=errors.length?2:1;
}catch(e){process.stderr.write(`native eval: ${e.message}\n`);process.exitCode=2;}
