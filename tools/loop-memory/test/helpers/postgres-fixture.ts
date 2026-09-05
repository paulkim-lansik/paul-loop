import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync as nativeSpawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process';
import { beforeAll } from 'vitest';
import { createLoopDb as connect, type LoopDb } from '../../src/client';
import { bindStore, repositoryIdentity, storeContext } from '../../src/store';
import { stubEmbedder, type Embedder } from '../../src/embedding';
import { addNote as productionAdd, type NoteInput } from '../../src/ops';
import { signContent, signNote } from '../../src/provenance';
import { sanitizeMemory } from '../../hooks/lib/privacy.mjs';
import { backedLesson } from '../../../loop-engine/test/helpers/backed-lesson.mjs';

// Explicit disposable target only. Collection itself refuses the production/default DB URL.
const value=process.env.LOOP_MEMORY_TEST_DATABASE_URL;
if(!value) throw Error('LOOP_MEMORY_TEST_DATABASE_URL must name an explicit local loop_memory_fixture_* database');
const url=new URL(value);
if(!/^\/loop_memory_fixture_[a-z0-9_]+$/.test(url.pathname) ||
  !(url.searchParams.get('host')?.startsWith('/tmp/loop-mem-fixture-') || ['127.0.0.1','localhost'].includes(url.hostname))) throw Error('integration target is not a named local disposable fixture');
const schema=`memory_fixture_${randomUUID().replaceAll('-','')}`;
url.searchParams.set('options',`-c search_path=${schema},public`);
export const LOOP_DATABASE_URL=url.toString();
export const FIXTURE_SIGNING_KEY='disposable-memory-fixture-signing-key'; // gitleaks:allow
export const fixtureRoot=realpathSync(mkdtempSync(join(tmpdir(),'loop-memory-postgres-fixture-')));
let primary=false;
export function createLoopDb(signingKey=()=>FIXTURE_SIGNING_KEY) {
  const conn=connect(LOOP_DATABASE_URL);
  if(!primary) {
    primary=true;
    beforeAll(async()=>{
      await conn.pool.query(`CREATE SCHEMA ${schema}`);
      await conn.pool.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public');
      const migrations=resolve(import.meta.dirname,'../../drizzle');
      for(const file of readdirSync(migrations).filter(f=>f.endsWith('.sql')).sort()) await conn.pool.query(readFileSync(join(migrations,file),'utf8'));
      await bindStore(conn.db,conn.pool,{...repositoryIdentity(fixtureRoot),embeddingId:stubEmbedder().identity!,signingKey:signingKey()});
    });
    const end=conn.pool.end.bind(conn.pool);
    conn.pool.end=async()=>{await conn.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await end();rmSync(fixtureRoot,{recursive:true,force:true});};
  }
  return conn;
}
/** Positive lesson fixtures carry explicit local evidence summaries. Legacy rejection has separate tests. */
export function lessonJSON(value:any):string {
  return JSON.stringify(backedLesson(value, fixtureRoot));
}
/** Adapt positive note fixtures to scope-aware signing; missing/wrong signatures remain untrusted. */
export function addNote(db:LoopDb,e:Embedder,input:NoteInput) {
  const ctx=storeContext(db), content=sanitizeMemory(input.content);
  const corpus=input.corpus ?? (input.tags?.includes('lesson')?'lesson':input.tags?.[0] ?? 'fixture');
  const sourceKey=input.sourceKey ?? input.keywords?.find(k=>k.startsWith('lesson:')) ?? randomUUID();
  const validLegacy=input.provenance===signContent(input.content,ctx.signingKey);
  return productionAdd(db,e,{...input,corpus,sourceKey,
    provenance:validLegacy || (!input.provenance && !input.keywords?.some(k=>k.startsWith('lesson:')))
      ? signNote(content,corpus,sourceKey,ctx):input.provenance});
}
/** Run the actual CLI in the bound disposable repository, with canonical source snapshots. */
export function spawnSync(command:string,args:string[],opts:SpawnSyncOptionsWithStringEncoding) {
  const next=[...args];
  for(const flag of ['--lessons','--knowledge','--research','--design','--context']) {
    const i=next.indexOf(flag);if(i===-1)continue;
    const target=join(fixtureRoot,flag==='--lessons'?'.loop/lessons':`sources/${flag.slice(2)}`);
    rmSync(target,{recursive:true,force:true});mkdirSync(join(target,'..'),{recursive:true});
    cpSync(next[i+1]!,target,{recursive:true});next[i+1]=target;
  }
  const env={...opts.env,LOOP_DIR:'.loop',CLAUDE_PROJECT_DIR:fixtureRoot,LOOP_DATABASE_URL,
    LOOP_DOTENV_PATH:'/nonexistent-fixture.env',LOOP_MEMORY_SIGNING_KEY:opts.env?.LOOP_MEMORY_SIGNING_KEY??FIXTURE_SIGNING_KEY,
    OPENAI_API_KEY:'',GEMINI_API_KEY:'',LOOP_EMBED_PROVIDER:'',LOOP_EMBED_MODEL:''};
  return nativeSpawnSync(command,next,{...opts,cwd:fixtureRoot,env});
}
