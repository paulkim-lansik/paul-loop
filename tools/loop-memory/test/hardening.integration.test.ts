import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createLoopDb, fixtureRoot, FIXTURE_SIGNING_KEY, LOOP_DATABASE_URL, lessonJSON } from './helpers/postgres-fixture';
import { createLoopDb as connection } from '../src/client';
import { bindStore, repositoryIdentity, sha256 } from '../src/store';
import { stubEmbedder } from '../src/embedding';
import { graduateLessons, recallLessons } from '../src/lessons';
import { graduateKnowledge, recallKnowledge, syncKnowledge, ADR_TAG } from '../src/knowledge';
import { recordRecall } from '../src/ops';
import { memoryNote } from '../src/schema/memory';
import { eq } from 'drizzle-orm';
import { verifyNote } from '../src/provenance';
const {db,pool}=createLoopDb();
const embedder=stubEmbedder();
const context={...repositoryIdentity(fixtureRoot),signingKey:FIXTURE_SIGNING_KEY,embeddingId:embedder.identity!};
const dir=mkdtempSync(join(fixtureRoot,'sources-'));
const file=join(dir,'fixture.json');
const write=(patch:any={})=>writeFileSync(file,lessonJSON({id:'fixture',title:'failure',fix:'implementation fix',verified:true,...patch}));
afterEach(()=>{delete process.env.LOOP_LEARNING_OFF;delete process.env.LOOP_MEMORY_RECALL_ONLY;});
afterAll(async()=>{rmSync(dir,{recursive:true,force:true});await pool.end();});
async function snapshot(){const notes=await pool.query('select * from memory_note order by id'),ops=await pool.query('select * from memory_op order by id'),owner=await pool.query('select * from memory_store');return JSON.stringify([notes.rows,ops.rows,owner.rows]);}
describe('hardening on a named disposable Postgres database',()=>{
 it('content correction, signing rotation, invalidation and sanitized tombstones survive actual SQL',async()=>{
  write();expect(await graduateLessons(db,pool,embedder,dir,FIXTURE_SIGNING_KEY)).toMatchObject({added:1});
  write({fix:'corrected actual code'});expect(await graduateLessons(db,pool,embedder,dir,FIXTURE_SIGNING_KEY)).toMatchObject({updated:1});
  const rotated={...context,signingKey:'fixture-rotated'};await bindStore(db,pool,rotated);
  expect(await recallLessons(db,embedder,'failure',rotated.signingKey)).toEqual([]);
  expect(await graduateLessons(db,pool,embedder,dir,rotated.signingKey)).toMatchObject({updated:1});
  const [note]=await db.select().from(memoryNote);expect(verifyNote(note!,rotated)).toBe(true);
  write({invalid_at:'2026-09-05'});expect(await graduateLessons(db,pool,embedder,dir,rotated.signingKey)).toMatchObject({purged:1});
  const [dead]=await db.select().from(memoryNote).where(eq(memoryNote.id,note!.id));
  expect(dead).toMatchObject({content:'',embedding:null,keywords:[],context:'',provenance:null});
  expect(dead?.deletedAt).not.toBeNull();expect(await recallLessons(db,embedder,'failure',rotated.signingKey)).toEqual([]);
  const logs=await pool.query('select payload from memory_op');expect(JSON.stringify(logs.rows)).not.toContain('corrected actual code');
  await bindStore(db,pool,context);
 });
 it('all-superseded knowledge retracts its last rows (not a no-op)',async()=>{
  const adr=join(dir,'0001-fixture.md');writeFileSync(adr,'# ADR-0001: Local\n**Status**: Accepted\n## Decision\nlocal fixture');
  expect(await graduateKnowledge(db,pool,embedder,dir)).toMatchObject({added:1});
  expect(await recallKnowledge(db,embedder,'local fixture')).toHaveLength(1);
  writeFileSync(adr,'# ADR-0001: Local\n**Status**: Superseded\n## Decision\nlocal fixture');
  expect(await graduateKnowledge(db,pool,embedder,dir)).toMatchObject({deleted:1});
  expect(await recallKnowledge(db,embedder,'local fixture')).toEqual([]);
 });
 it('a failed owner/model rebind revokes the handle and cannot subsequently delete another owner snapshot',async()=>{
  write();await graduateLessons(db,pool,embedder,dir,FIXTURE_SIGNING_KEY);const before=await snapshot();
  await expect(bindStore(db,pool,{...context,owner:sha256('another repository')})).rejects.toThrow('store_owner_mismatch');
  await expect(syncKnowledge(db,pool,embedder,ADR_TAG,[])).rejects.toThrow('store_not_bound');expect(await snapshot()).toBe(before);
  await bindStore(db,pool,context);
  await expect(bindStore(db,pool,{...context,embeddingId:'gemini:other:l2-v1:384'})).rejects.toThrow('embedding_identity_mismatch');
  expect(await snapshot()).toBe(before);await bindStore(db,pool,context);
 });
 it('frozen recall works with Postgres enforcing read-only and writes no counters or registry data',async()=>{
  const url=new URL(LOOP_DATABASE_URL);url.searchParams.set('options',url.searchParams.get('options')+' -c default_transaction_read_only=on');
  const ro=connection(url.toString());const before=await snapshot();
  process.env.LOOP_LEARNING_OFF='1';process.env.LOOP_MEMORY_RECALL_ONLY='1';
  try {
    await bindStore(ro.db,ro.pool,context);
    const r=await recallLessons(ro.db,embedder,'failure',FIXTURE_SIGNING_KEY);expect(r).toHaveLength(1);
    await expect(recordRecall(ro.db,r[0]!.id)).rejects.toThrow('learning_off');
    expect(await snapshot()).toBe(before);
  } finally {await ro.pool.end();}
 });
 it('frozen missing identity and occupied unowned stores fail without adoption or deletion',async()=>{
  const schema=`unowned_fixture_${randomUUID().replaceAll('-','')}`;
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`CREATE TABLE ${schema}.memory_store (id text primary key, owner text, embedding_id text)`);
  await pool.query(`CREATE TABLE ${schema}.memory_note (content text)`);
  await pool.query(`CREATE TABLE ${schema}.memory_op (payload jsonb)`);
  await pool.query(`INSERT INTO ${schema}.memory_note VALUES ('legacy private fixture')`);
  const url=new URL(LOOP_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema},public`);const raw=connection(url.toString());
  try {
    process.env.LOOP_LEARNING_OFF='1';process.env.LOOP_MEMORY_RECALL_ONLY='1';
    await expect(bindStore(raw.db,raw.pool,context)).rejects.toThrow('frozen_store_uninitialized');
    delete process.env.LOOP_LEARNING_OFF;delete process.env.LOOP_MEMORY_RECALL_ONLY;
    await expect(bindStore(raw.db,raw.pool,context)).rejects.toThrow('legacy_store_unowned');
    expect((await raw.pool.query('select * from memory_store')).rows).toHaveLength(0);
    expect((await raw.pool.query('select * from memory_note')).rows).toEqual([{content:'legacy private fixture'}]);
  } finally {await raw.pool.end();await pool.query(`DROP SCHEMA ${schema} CASCADE`);}
 });
});
