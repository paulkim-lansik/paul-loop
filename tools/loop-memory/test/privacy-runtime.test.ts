import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiEmbedder } from '../src/embedding-api';
import { sanitizeMemory } from '../hooks/lib/privacy.mjs';
import { runtimeEnv } from '../hooks/lib/runtime-env.mjs';
afterEach(()=>vi.unstubAllGlobals());
describe('privacy and common runtime environment',()=>{
 it('redacts and bounds actual outgoing embedding payload; error body never becomes error text',async()=>{
  const fetch=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({data:[{embedding:[1,0]}]}),{status:200})).mockResolvedValueOnce(new Response('token=fixture-server-private',{status:401}));
  vi.stubGlobal('fetch',fetch);
  const e=apiEmbedder({provider:'openai',apiKey:'fixture',dimensions:2,model:'fixture-model'});
  const text='email sensitive@example.com phone 010-2345-6789 token=fixture-outgoing-private https://user:pass@host.test/path?query=private';
  await e.embed(text);
  const payload=String(fetch.mock.calls[0]![1].body);
  for(const secret of ['sensitive@example.com','010-2345-6789','fixture-outgoing-private','user:pass','query=private'])expect(payload).not.toContain(secret);
  expect(sanitizeMemory('a'.repeat(5000),2048)).toHaveLength(2048);
  await expect(e.embed('plain fixture')).rejects.toThrow('openai embeddings HTTP 401');
  expect(e.identity).toBe('openai:fixture-model:l2-v1:2');
 });
 it('rejects empty model and nonfinite/zero vectors without a silent alternative provider',async()=>{
  expect(()=>apiEmbedder({provider:'openai',model:''})).toThrow('embedding identity invalid');
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({data:[{embedding:[0,0]}]}),{status:200})));
  await expect(apiEmbedder({provider:'openai',apiKey:'fixture',dimensions:2}).embed('fixture')).rejects.toThrow('embedding vector invalid');
 });
 it('shell including empty > userConfig > dotenv; dotenv cannot unfreeze learning',()=>{
  const root=mkdtempSync(join(tmpdir(),'loop-memory-env-fixture-'));
  try {
    mkdirSync(join(root,'.loop'));writeFileSync(join(root,'.loop/.env'),'OPENAI_API_KEY=file\nLOOP_EMBED_MODEL=file-model\nLOOP_LEARNING_OFF=0\nLOOP_MEMORY_RECALL_ONLY=0\n');
    const {env}=runtimeEnv(root,{OPENAI_API_KEY:'',CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY:'option',CLAUDE_PLUGIN_OPTION_LOOP_EMBED_MODEL:'option-model',LOOP_LEARNING_OFF:'1',LOOP_MEMORY_RECALL_ONLY:'1'});
    expect(env.OPENAI_API_KEY).toBe('');expect(env.LOOP_EMBED_MODEL).toBe('option-model');expect(env.LOOP_LEARNING_OFF).toBe('1');expect(env.LOOP_MEMORY_RECALL_ONLY).toBe('1');
  } finally {rmSync(root,{recursive:true,force:true});}
 });
 it('standalone CLI actually reads dotenv before provider selection, with zero DB/API access',()=>{
  const root=mkdtempSync(join(tmpdir(),'loop-memory-cli-env-fixture-'));
  try {
    mkdirSync(join(root,'.loop'));writeFileSync(join(root,'.loop/.env'),'OPENAI_API_KEY=fixture-only\nLOOP_EMBED_PROVIDER=gemini\n');
    const base=join(import.meta.dirname,'..');
    const r=spawnSync(join(base,'node_modules/.bin/tsx'),[join(base,'src/cli.ts'),'recall','--query','fixture','--json'],{cwd:root,encoding:'utf8',env:{PATH:process.env.PATH,LOOP_MEMORY_SIGNING_KEY:''}});
    expect(r.status).toBe(1);expect(JSON.parse(r.stdout).reason).toBe('embedding_provider_key_missing');
  } finally {rmSync(root,{recursive:true,force:true});}
 });
});
