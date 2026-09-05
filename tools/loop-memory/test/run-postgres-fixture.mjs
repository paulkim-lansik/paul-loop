// Explicit development integration lane. Never connects to or stops an existing DB/cluster.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, appendFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const cwd=resolve(import.meta.dirname,'..');
const root=mkdtempSync('/tmp/loop-mem-fixture-');
const socket=join(root,'socket'),data=join(root,'data');
const name=`loop_memory_fixture_${randomUUID().replaceAll('-','')}`;
let pgBin,started=false,status=1;
function command(exe,args){const r=spawnSync(exe,args,{cwd,stdio:'inherit'});if(r.status!==0)throw Error(`fixture command failed: ${exe}`);}
try {
  pgBin=process.env.LOOP_MEMORY_PG_BIN || execFileSync('pg_config',['--bindir'],{encoding:'utf8'}).trim();
  mkdirSync(socket);
  command(join(pgBin,'initdb'),['-D',data,'-U','fixture','--auth=trust','--no-locale','-E','UTF8']);
  appendFileSync(join(data,'postgresql.conf'),`\nlisten_addresses = ''\nunix_socket_directories = '${socket}'\n`);
  command(join(pgBin,'pg_ctl'),['-D',data,'-l',join(root,'postgres.log'),'-w','start']);started=true;
  command(join(pgBin,'createdb'),['-h',socket,'-U','fixture',name]);
  const url=new URL(`postgresql://fixture@localhost/${name}`);url.searchParams.set('host',socket);
  command(join(pgBin,'psql'),['-h',socket,'-U','fixture','-d',name,'-v','ON_ERROR_STOP=1','-c','CREATE EXTENSION vector']);
  // Validate the supported migration CLI (including its TS config loader) on this new DB only.
  const migrated=spawnSync(process.execPath,[join(cwd,'node_modules/drizzle-kit/bin.cjs'),'migrate'],{
    cwd,stdio:'inherit',env:{...process.env,LOOP_DATABASE_URL:url.toString()},
  });
  if(migrated.status!==0)throw Error('disposable fixture migration CLI failed');
  const result=spawnSync(process.execPath,[join(cwd,'node_modules/vitest/vitest.mjs'),'run','--config','vitest.config.integration.ts'],{
    cwd,stdio:'inherit',env:{...process.env,LOOP_MEMORY_TEST_DATABASE_URL:url.toString(),OPENAI_API_KEY:'',GEMINI_API_KEY:''},
  });status=result.status??1;
} catch(e){process.stderr.write(`${e.message}\nSet LOOP_MEMORY_PG_BIN to a local PostgreSQL installation with pgvector. No existing server was used.\n`);}
finally {
  if(started){const r=spawnSync(join(pgBin,'pg_ctl'),['-D',data,'-m','fast','-w','stop'],{stdio:'inherit'});if(r.status!==0){status=1;process.stderr.write(`fixture cleanup failed; retained ${root}\n`);}else{rmSync(root,{recursive:true,force:true});}}
  else rmSync(root,{recursive:true,force:true});
}
process.exit(status);
