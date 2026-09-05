import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backedLesson } from '../../loop-engine/test/helpers/backed-lesson.mjs';
import { lessonContentHash } from '../../loop-engine/lib/lesson-state.mjs';
import { fixtureStore } from './helpers/memory-store';
import { bindStore, repositoryIdentity } from '../src/store';
import { stubEmbedder } from '../src/embedding';
import { graduateLessons, readVerifiedLessons } from '../src/lessons';

let root:string, dir:string;
const embedder=stubEmbedder(), key='lesson-evidence-fixture-signing';
const input={id:'fixture',title:'failure',fix:'actual implementation repair',signature:['fixture failed'],verified:true};
beforeEach(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),'lesson-admission-fixture-')));dir=join(root,'.loop/lessons');mkdirSync(dir,{recursive:true});});
afterEach(()=>rmSync(root,{recursive:true,force:true}));
const save=(value:any,target=dir)=>writeFileSync(join(target,'fixture.json'),JSON.stringify(value));
async function store(owner=root) {const s=fixtureStore();await bindStore(s.db,s.pool,{...repositoryIdentity(owner),signingKey:key,embeddingId:embedder.identity!});return s;}

it('fabricated summaries with recomputed hashes are neither read as verified nor graduated',async()=>{
  save({...input,verification:{version:1,content_hash:lessonContentHash(input),receipts:[{
    id:'invented-pass',failure_id:'invented-fail',seal_id:'invented-seal',run_id:'invented-run',verdict:'PASS',
    root_hash:'a'.repeat(64),command_hash:'b'.repeat(64),fix_target_before:'c'.repeat(64),fix_target_after:'d'.repeat(64),
  }]}});
  expect(readVerifiedLessons(dir,{root})).toEqual([]);
  const s=await store();expect(await graduateLessons(s.db,s.pool,embedder,dir,key)).toMatchObject({added:0});
  expect(s.notes).toHaveLength(0);expect(s.ops).toHaveLength(0);
});
it('rewriting a sealed story retracts a previously graduated note even after recomputing its public hash',async()=>{
  const lesson=backedLesson(input,root);save(lesson);
  const s=await store();expect(await graduateLessons(s.db,s.pool,embedder,dir,key)).toMatchObject({added:1});
  const changed={...lesson,fix:'invented replacement'};changed.verification.content_hash=lessonContentHash(changed);save(changed);
  expect(readVerifiedLessons(dir,{root})).toEqual([]);
  expect(await graduateLessons(s.db,s.pool,embedder,dir,key)).toMatchObject({purged:1,added:0});
  expect(s.notes[0]).toMatchObject({content:'',embedding:null});
});
it('copying the full lesson, seal and verification history into another workspace cannot graduate it',async()=>{
  save(backedLesson(input,root));
  const other=join(root,'other');mkdirSync(other);cpSync(join(root,'.loop'),join(other,'.loop'),{recursive:true});
  const otherDir=join(other,'.loop/lessons');expect(readVerifiedLessons(otherDir,{root:other})).toEqual([]);
  const s=await store(other);expect(await graduateLessons(s.db,s.pool,embedder,otherDir,key)).toMatchObject({added:0});
  expect(s.notes).toHaveLength(0);
});
it('a missing backing receipt invalidates a valid producer seal and retracts recall material',async()=>{
  const lesson=backedLesson(input,root);save(lesson);
  const s=await store();await graduateLessons(s.db,s.pool,embedder,dir,key);
  rmSync(join(root,'.loop/evidence',lesson.verification.receipts[0].failure_id+'.json'));
  expect(readVerifiedLessons(dir,{root})).toEqual([]);
  expect(await graduateLessons(s.db,s.pool,embedder,dir,key)).toMatchObject({purged:1});
});
