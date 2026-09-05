import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindStore, storeContext, repositoryIdentity, sha256 } from '../src/store';
import { stubEmbedder } from '../src/embedding';
import { signNote, verifyNote, signContent } from '../src/provenance';
import { graduateLessons, recallLessons, lessonContent, readLessonRecords, lessonStub } from '../src/lessons';
import { syncKnowledge, recallKnowledge, ADR_TAG, graduateKnowledge, parseAdrChunks } from '../src/knowledge';
import { addNote, updateNote, softDeleteNote, recordRecall } from '../src/ops';
import { backedLesson } from '../../loop-engine/test/helpers/backed-lesson.mjs';
import { fixtureStore } from './helpers/memory-store';

let dir:string;
const embedder=stubEmbedder();
const ctx={owner:sha256('repo A'),embeddingId:embedder.identity!,signingKey:'fixture-signing',writable:true,canonical:''};
function write(id:string, patch:any={}) {
  const l={ id, title:'fixture failure', fix:'repaired implementation', signature:['failed fixture check'], verified:true,...patch };
  writeFileSync(join(dir,`${id}.json`),JSON.stringify(backedLesson(l,dir)));
}
async function store() {const s=fixtureStore();await bindStore(s.db,s.pool,ctx);return s;}
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),'loop-memory-hardening-fixture-'));ctx.canonical=dir;});
afterEach(()=>{rmSync(dir,{recursive:true,force:true});for(const key of ['LOOP_LEARNING_OFF','LOOP_MEMORY_OFF','LOOP_MEMORY_RECALL_ONLY'])delete process.env[key];});

describe('scoped lifecycle using production adapters, ops and signing with relational fixtures',()=>{
 it('updates corrected content, rotates signatures, stubs retirement, reaps invalidation/retraction/deletion',async()=>{
  const s=await store();write('l1');
  expect(await graduateLessons(s.db,s.pool,embedder,dir,ctx.signingKey)).toMatchObject({added:1,updated:0});
  const id=s.notes[0].id;
  expect((await recallLessons(s.db,embedder,'fixture',ctx.signingKey)).map(h=>h.id)).toEqual([id]);
  expect(await graduateLessons(s.db,s.pool,embedder,dir,ctx.signingKey)).toMatchObject({skipped:1,updated:0});
  expect(s.ops).toHaveLength(1);
  write('l1',{fix:'corrected implementation'});
  expect(await graduateLessons(s.db,s.pool,embedder,dir,ctx.signingKey)).toMatchObject({updated:1,added:0});
  expect(s.notes[0].content).toContain('corrected implementation');
  const rotated={...ctx,signingKey:'fixture-rotated'};
  await bindStore(s.db,s.pool,rotated);
  expect(await recallLessons(s.db,embedder,'fixture',rotated.signingKey)).toEqual([]);
  expect(await graduateLessons(s.db,s.pool,embedder,dir,rotated.signingKey)).toMatchObject({updated:1});
  expect(verifyNote(s.notes[0],rotated)).toBe(true);
  write('l1',{fix:'corrected implementation',retired:{at:'2026-09-05',ref:'CLAUDE.md'}});
  expect(await graduateLessons(s.db,s.pool,embedder,dir,rotated.signingKey)).toMatchObject({stubbed:1});
  expect(s.notes[0].content).toBe(lessonStub(readLessonRecords(dir)[0]!, 'CLAUDE.md'));
  const rotated2={...ctx,signingKey:'fixture-rotated-twice'};await bindStore(s.db,s.pool,rotated2);
  expect(await graduateLessons(s.db,s.pool,embedder,dir,rotated2.signingKey)).toMatchObject({stubbed:1});
  expect(verifyNote(s.notes[0],rotated2)).toBe(true);
  write('l1',{invalid_at:'2026-09-05'});
  expect(await graduateLessons(s.db,s.pool,embedder,dir,rotated2.signingKey)).toMatchObject({purged:1});
  expect(s.notes[0]).toMatchObject({content:'',embedding:null,provenance:null,keywords:[]});
  expect(JSON.stringify(s.ops)).not.toContain('corrected implementation');
  for(const patch of [{verified:false},{verification:null},{challenge:{verdict:'reject'}}]) {
    write('l2'); await graduateLessons(s.db,s.pool,embedder,dir,rotated2.signingKey);
    if('verification' in patch) writeFileSync(join(dir,'l2.json'),JSON.stringify({id:'l2',verified:true,title:'legacy'}));
    else write('l2',patch);
    expect(await graduateLessons(s.db,s.pool,embedder,dir,rotated2.signingKey)).toMatchObject({purged:1});
  }
  write('l3');await graduateLessons(s.db,s.pool,embedder,dir,rotated2.signingKey);unlinkSync(join(dir,'l3.json'));
  expect(await graduateLessons(s.db,s.pool,embedder,dir,rotated2.signingKey)).toMatchObject({purged:1});
  await expect(graduateLessons(s.db,s.pool,embedder,join(dir,'missing'),rotated2.signingKey)).rejects.toThrow('lesson_source_missing');
 });
 it('rejects legacy/content-only signatures and altered owner/corpus/source/model/content, for BOTH corpora',async()=>{
  const s=await store();write('l1');await graduateLessons(s.db,s.pool,embedder,dir,ctx.signingKey);
  const original={...s.notes[0]};
  for(const patch of [{ownerId:sha256('other')},{corpus:ADR_TAG},{sourceKey:'another'},{embeddingId:'other-model'},{content:'injected'},{provenance:null},{provenance:signContent(original.content,ctx.signingKey)},{provenance:original.provenance+'xx'}]) {
    Object.assign(s.notes[0],original,patch);
    expect(await recallLessons(s.db,embedder,'fixture',ctx.signingKey)).toEqual([]);
    expect(await recallKnowledge(s.db,embedder,'fixture')).toEqual([]);
  }
  Object.assign(s.notes[0],original);
  const desired=parseAdrChunks('# ADR-0001: Decision\n## Choice\nfixture choice','0001');
  await syncKnowledge(s.db,s.pool,embedder,ADR_TAG,desired);
  const kb=s.notes.find(n=>n.corpus===ADR_TAG);expect(verifyNote(kb,ctx)).toBe(true);
  expect(await recallKnowledge(s.db,embedder,'choice')).toHaveLength(1);
  kb.provenance=signContent(kb.content,ctx.signingKey);
  expect(await recallKnowledge(s.db,embedder,'choice')).toEqual([]);
 });
 it('sync empty snapshots retracts KB, unchanged refresh does not grow audit, locked differs from synced',async()=>{
  const s=await store();const chunks=parseAdrChunks('# ADR-0001: Decision\n## Choice\noriginal','0001');
  expect(await syncKnowledge(s.db,s.pool,embedder,ADR_TAG,chunks)).toMatchObject({added:1});
  expect(await syncKnowledge(s.db,s.pool,embedder,ADR_TAG,chunks)).toMatchObject({noop:1});expect(s.ops).toHaveLength(1);
  await bindStore(s.db,s.pool,{...ctx,signingKey:'rotated-kb'});
  expect(await syncKnowledge(s.db,s.pool,embedder,ADR_TAG,chunks)).toMatchObject({updated:1});
  expect(verifyNote(s.notes[0],storeContext(s.db))).toBe(true);
  const results=await Promise.all([syncKnowledge(s.db,s.pool,embedder,ADR_TAG,chunks),syncKnowledge(s.db,s.pool,embedder,ADR_TAG,chunks)]);
  expect(results.filter(r=>r.locked)).toHaveLength(1);
  expect(await syncKnowledge(s.db,s.pool,embedder,ADR_TAG,[])).toMatchObject({deleted:1});expect(s.notes[0].content).toBe('');
 });
 it('blocks owner/model mismatch and legacy adoption before embedding or destructive sync',async()=>{
  const s=await store();write('l1');await graduateLessons(s.db,s.pool,embedder,dir,ctx.signingKey);
  await expect(bindStore(s.db,s.pool,{...ctx,owner:sha256('repo B')})).rejects.toThrow('store_owner_mismatch');
  await expect(bindStore(s.db,s.pool,{...ctx,embeddingId:'gemini:different:l2-v1:384'})).rejects.toThrow('embedding_identity_mismatch');
  await expect(syncKnowledge(s.db,s.pool,embedder,ADR_TAG,[])).rejects.toThrow('store_not_bound');
  await bindStore(s.db,s.pool,ctx);
  await expect(syncKnowledge(s.db,s.pool,{...embedder,identity:'other'},ADR_TAG,[])).rejects.toThrow('embedding_identity_mismatch');
  const legacy=fixtureStore();legacy.notes.push({content:'unowned legacy'});
  await expect(bindStore(legacy.db,legacy.pool,ctx)).rejects.toThrow('legacy_store_unowned');
  expect(legacy.owner).toBe(null);expect(legacy.notes[0].content).toBe('unowned legacy');
  expect(s.notes[0].deletedAt).toBe(null);
 });
 it('sanitizes before embedding/persistence and stores only minimal audit metadata',async()=>{
  const s=await store();const seen:string[]=[];
  const e={...embedder,embed:async(text:string)=>{seen.push(text);return embedder.embed(text);}};
  const n=await addNote(s.db,e,{content:'email test@example.com token=fixture-private-value phone 010-1234-5678',source:'secret-source-url',context:'password=fixture-context'});
  for(const value of [...seen,n.content,n.context,JSON.stringify(s.ops)]) {expect(value).not.toContain('test@example.com');expect(value).not.toContain('fixture-private-value');expect(value).not.toContain('010-1234-5678');expect(value).not.toContain('fixture-context');}
  expect(s.ops[0].payload).toEqual({content_hash:sha256(n.content),chars:n.content.length,source:undefined});
  await softDeleteNote(s.db,n.id,'private arbitrary reason');expect(JSON.stringify(s.ops)).not.toContain('private arbitrary reason');
 });
 it.each(['LOOP_LEARNING_OFF','LOOP_MEMORY_RECALL_ONLY','LOOP_MEMORY_OFF'])('%s blocks low-level writes and source sync',async flag=>{
  const s=await store();write('l1');await graduateLessons(s.db,s.pool,embedder,dir,ctx.signingKey);
  const snapshot=JSON.stringify([s.notes,s.ops]);process.env[flag]='1';
  for(const work of [()=>addNote(s.db,embedder,{content:'blocked'}),()=>updateNote(s.db,embedder,s.notes[0].id,{content:'blocked'}),()=>softDeleteNote(s.db,s.notes[0].id),()=>recordRecall(s.db,s.notes[0].id),()=>graduateLessons(s.db,s.pool,embedder,dir,ctx.signingKey),()=>syncKnowledge(s.db,s.pool,embedder,ADR_TAG,[])]) await expect(work()).rejects.toThrow(/off|recall_only/);
  if(flag!=='LOOP_MEMORY_OFF') expect(await recallLessons(s.db,embedder,'fixture',ctx.signingKey)).toHaveLength(1);
  else await expect(recallLessons(s.db,embedder,'fixture',ctx.signingKey)).rejects.toThrow('memory_off');
  expect(JSON.stringify([s.notes,s.ops])).toBe(snapshot);
 });
 it('shares git common owner but makes feature worktrees read-only; different clones differ',async()=>{
  const main=join(dir,'main'),wt=join(dir,'feature');mkdirSync(main);
  const git=(...a:string[])=>execFileSync('git',a,{cwd:main,stdio:'ignore'});
  git('init','-q');writeFileSync(join(main,'fixture.txt'),'seed');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture');git('worktree','add','-qb','feature',wt);
  expect(repositoryIdentity(wt)).toMatchObject({owner:repositoryIdentity(main).owner,writable:false});
  const s=await store();await bindStore(s.db,s.pool,{...ctx,writable:false});
  await expect(syncKnowledge(s.db,s.pool,embedder,ADR_TAG,[])).rejects.toThrow('worktree_read_only');
  expect(repositoryIdentity(dir).owner).not.toBe(repositoryIdentity(main).owner);
 });
 it('refuses symlink lesson sources before mutations',async()=>{
  const s=await store();write('good');symlinkSync(join(dir,'good.json'),join(dir,'bad.json'));
  await expect(graduateLessons(s.db,s.pool,embedder,dir,ctx.signingKey)).rejects.toThrow('source_symlink');expect(s.ops).toHaveLength(0);
 });
});
