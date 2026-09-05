import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { backedLesson } from '../../loop-engine/test/helpers/backed-lesson.mjs';
import { fixtureStore } from './helpers/memory-store';
import { bindStore, repositoryIdentity } from '../src/store';
import { stubEmbedder } from '../src/embedding';
import { graduateLessons, recallLessons } from '../src/lessons';
import { graduateKnowledge, graduateContext, graduateMarkdownDir, recallKnowledge, RESEARCH_TAG } from '../src/knowledge';

let root:string,dir:string;
const embedder=stubEmbedder(),key='snapshot-order-fixture';
beforeEach(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),'snapshot-order-fixture-')));dir=join(root,'sources');mkdirSync(dir);});
afterEach(()=>rmSync(root,{recursive:true,force:true}));
async function store(){const s=fixtureStore();await bindStore(s.db,s.pool,{...repositoryIdentity(root),signingKey:key,embeddingId:embedder.identity!});return s;}
// Hold exactly A's first connection request. B uses the same real relational fixture/lock and finishes
// its retraction before A can acquire that lock. No sleeps or scheduler timing assumptions.
function delayFirst(pool:Pool){
  const connect=pool.connect.bind(pool);let signal!:()=>void,release!:()=>void,first=true;
  const entered=new Promise<void>(r=>signal=r),gate=new Promise<void>(r=>release=r);
  const delayed={connect:async()=>{if(first){first=false;signal();await gate;}return connect();}} as Pool;
  return {pool:delayed,entered,release};
}
it('a delayed lesson snapshot cannot resurrect a completed invalidation',async()=>{
  const s=await store(),file=join(dir,'lesson.json');
  const lesson=backedLesson({id:'lesson',verified:true,title:'failure',fix:'real fix',signature:['failure']},root);
  writeFileSync(file,JSON.stringify(lesson));await graduateLessons(s.db,s.pool,embedder,dir,key);
  const barrier=delayFirst(s.pool),old=graduateLessons(s.db,barrier.pool,embedder,dir,key);await barrier.entered;
  try {
    writeFileSync(file,JSON.stringify({...lesson,invalid_at:new Date().toISOString()}));
    expect(await graduateLessons(s.db,s.pool,embedder,dir,key)).toMatchObject({purged:1});
    expect(await recallLessons(s.db,embedder,'failure',key)).toEqual([]);
  } finally {barrier.release();}
  expect(await old).toMatchObject({added:0,updated:0});
  expect(await recallLessons(s.db,embedder,'failure',key)).toEqual([]);
  expect(s.notes.filter(n=>!n.deletedAt)).toHaveLength(0);
});
it.each(['adr','context','markdown'])('a delayed %s reader cannot resurrect a completed source retraction',async kind=>{
  const s=await store(),file=join(dir,kind==='adr'?'0001-decision.md':'context.md');
  const content=kind==='adr'?'# ADR-0001: Retained\n**Status**: Accepted\n## Decision\nUse retained choice'
    :kind==='context'?'## Glossary\n\n**Retained**: A retained glossary choice':'# Retained\n\n## Decision\nUse retained choice';
  const graduate=(pool:Pool)=>kind==='adr'?graduateKnowledge(s.db,pool,embedder,dir)
    :kind==='context'?graduateContext(s.db,pool,embedder,file):graduateMarkdownDir(s.db,pool,embedder,dir,RESEARCH_TAG,'research');
  writeFileSync(file,content);expect(await graduate(s.pool)).toMatchObject({added:1});
  const barrier=delayFirst(s.pool),old=graduate(barrier.pool);await barrier.entered;
  try {
    writeFileSync(file,kind==='adr'?content.replace('Accepted','Superseded'):'<!-- loop-memory: empty -->');
    expect(await graduate(s.pool)).toMatchObject({deleted:1});
    expect(await recallKnowledge(s.db,embedder,'retained choice')).toEqual([]);
  } finally {barrier.release();}
  expect(await old).toMatchObject({added:0,updated:0});
  expect(await recallKnowledge(s.db,embedder,'retained choice')).toEqual([]);
  expect(s.notes.filter(n=>!n.deletedAt)).toHaveLength(0);
});
