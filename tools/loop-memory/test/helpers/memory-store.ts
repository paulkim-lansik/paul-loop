import { randomUUID } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getTableName, SQL } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { LoopDb } from '../../src/client';
import { memoryNote } from '../../src/schema/memory';

// In-process relational fixture. Production adapters/ops/provenance run unchanged. Conditions are
// compiled with the real PgDialect; unsupported SQL throws rather than silently matching all rows.
export function fixtureStore() {
  let notes: any[] = [], ops: any[] = [];
  let owner: { owner: string; embedding_id: string } | null = null;
  const locks = new Set<string>();
  const queries: { sql: string; params: unknown[] }[] = [];
  const fields = Object.fromEntries(Object.entries(memoryNote).filter(([,v]: any) => v?.name).map(([k,v]: any) => [v.name, k]));
  const dialect = new PgDialect();
  function match(row: any, condition: SQL | undefined) {
    if (!condition) return true;
    const compiled = dialect.sqlToQuery(condition); queries.push(compiled);
    let expression = compiled.sql.replace(/"memory_note"\."(\w+)" (= \$(\d+)|is (not )?null)/g,
      (_all, column, _op, index, not) => {
        if (!(column in fields)) throw Error(`unsupported fixture column ${column}`);
        const v = row[fields[column]!];
        return String(index ? v === compiled.params[Number(index)-1] : not ? v != null : v == null);
      });
    expression = expression.replace(/\band\b/g, '&&').replace(/\bor\b/g, '||');
    if (!/^(?:true|false|[()&|\s])+$/.test(expression)) throw Error(`unsupported fixture condition ${compiled.sql}`);
    return Function(`return (${expression})`)();
  }
  function projection(row: any, columns: any) {
    if (!columns) return { ...row };
    return Object.fromEntries(Object.entries(columns).map(([key, column]: any) => {
      if (column instanceof SQL) {
        const q = dialect.sqlToQuery(column);
        if (!q.sql.includes('<=>')) throw Error(`unsupported fixture projection ${q.sql}`);
        const v = JSON.parse(String(q.params[0])) as number[];
        const a = row.embedding as number[];
        const dot = a.reduce((s,x,i) => s+x*(v[i]??0),0);
        return [key, 1-dot/(Math.hypot(...a)*Math.hypot(...v))];
      }
      return [key, row[fields[column.name]!]];
    }));
  }
  const db: any = {
    select(columns?: any) {
      let condition: SQL | undefined, maximum = Infinity, sorted = false;
      const q: any = { from(table: any) { if (getTableName(table) !== 'memory_note') throw Error('unsupported fixture table'); return q; },
        where(c: SQL) { condition=c; return q; }, limit(n: number) {maximum=n;return q;}, orderBy() {sorted=true;return q;},
        then(yes: any, no: any) {
          try { let rows=notes.filter(n=>match(n,condition)).map(n=>projection(n,columns));
            if(sorted) rows.sort((a,b)=>a.distance-b.distance);
            return Promise.resolve(rows.slice(0,maximum)).then(yes,no);
          } catch(e) {return Promise.reject(e).then(yes,no);}
        } };
      return q;
    },
    insert(table: any) { return { values(value: any) {
      const list=getTableName(table)==='memory_note'?notes:ops;
      const row={ id:randomUUID(), deletedAt:null, embedding:null, keywords:[], tags:[], links:[], context:'', provenance:null, ...value };
      list.push(row);
      return { returning: async()=>[{...row}], then:(yes:any,no:any)=>Promise.resolve().then(yes,no) };
    } }; },
    update(table: any) { if(getTableName(table)!=='memory_note') throw Error('unsupported fixture update'); return { set(patch:any) {return { where(condition:SQL) {return { returning: async()=>notes.filter(n=>match(n,condition)).map(n=>Object.assign(n,patch)) };} };} };},
    async transaction(fn:any) { const beforeNotes=structuredClone(notes), beforeOps=structuredClone(ops); try {return await fn(db);} catch(e) {notes=beforeNotes;ops=beforeOps;throw e;} },
  };
  const pool: any = { async connect() { let ownedLock=''; return {
    async query(sql:string, params:any[]=[]) {
      if(sql==='BEGIN'||sql==='BEGIN READ ONLY'||sql==='COMMIT'||sql==='ROLLBACK'||sql.includes('pg_advisory_xact_lock')) return {rows:[]};
      if(sql.startsWith('SELECT owner,')) return {rows:owner?[owner]:[]};
      if(sql.startsWith('SELECT EXISTS')) return {rows:[{occupied:!!(notes.length||ops.length)}]};
      if(sql.startsWith('INSERT INTO memory_store')) {owner={owner:params[0],embedding_id:params[1]};return {rows:[]};}
      if(sql.includes('pg_try_advisory_lock')) {const key=String(params);if(locks.has(key)) return {rows:[{locked:false}]}; locks.add(key);ownedLock=key;return {rows:[{locked:true}]};}
      if(sql.includes('pg_advisory_unlock')) {locks.delete(String(params));return {rows:[]};}
      throw Error(`unsupported fixture pool SQL ${sql}`);
    }, release() {if(ownedLock) locks.delete(ownedLock);},
  };}, async end() {} };
  return { db:db as LoopDb, pool:pool as Pool, queries,
    get notes(){return notes;}, get ops(){return ops;}, get owner(){return owner;}, locks,
  };
}
