import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { Pool } from 'pg';
import type { LoopDb } from './client';

export class MemoryError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'MemoryError'; }
}
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export interface StoreContext { owner: string; embeddingId: string; signingKey: string; writable: boolean; canonical?: string }
const stores = new WeakMap<LoopDb, StoreContext>();

/** Local repository identity, never a user-controlled basename. Worktrees share recall but only the
 * canonical checkout writes. Separate clones deliberately require separate stores. */
export function repositoryIdentity(root: string) {
  const current = realpathSync(root);
  let canonical = current;
  try {
    const common = resolve(current, execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: current, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim());
    if (basename(common) === '.git') canonical = realpathSync(dirname(common));
  } catch { /* A standalone directory has its own identity; no implicit shared owner. */ }
  return { owner: sha256(canonical), canonical, current, writable: current === canonical };
}

/** Bind only a truly empty DB. Legacy/unowned rows are never adopted or deleted implicitly.
 * The transaction is short (no embedding/API work) and serializes first-owner races. */
export async function bindStore(db: LoopDb, pool: Pool, context: StoreContext): Promise<void> {
  memoryAccess();
  stores.delete(db);
  if (!context.signingKey) throw new MemoryError('signing_key_missing');
  if (!/^[a-f0-9]{64}$/.test(context.owner)) throw new MemoryError('store_identity_invalid');
  const client = await pool.connect();
  try {
    const frozen = process.env.LOOP_LEARNING_OFF === '1' || process.env.LOOP_MEMORY_RECALL_ONLY === '1';
    await client.query(frozen ? 'BEGIN READ ONLY' : 'BEGIN');
    if (!frozen) await client.query('SELECT pg_advisory_xact_lock(1819109234)');
    const result = await client.query<{ owner: string; embedding_id: string }>(
      "SELECT owner, embedding_id FROM memory_store WHERE id = 'primary'",
    );
    if (result.rows.length === 0) {
      if (frozen) throw new MemoryError('frozen_store_uninitialized');
      memoryAccess(true);
      if (!context.writable || !context.embeddingId) throw new MemoryError('store_uninitialized');
      const counts = await client.query<{ occupied: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM memory_note) OR EXISTS(SELECT 1 FROM memory_op) AS occupied',
      );
      if (counts.rows.length !== 1 || counts.rows[0]?.occupied !== false) throw new MemoryError('legacy_store_unowned');
      await client.query("INSERT INTO memory_store(id, owner, embedding_id) VALUES ('primary', $1, $2)", [context.owner, context.embeddingId]);
    } else if (result.rows.length !== 1 || result.rows[0]?.owner !== context.owner) {
      throw new MemoryError('store_owner_mismatch');
    } else if (context.embeddingId && result.rows[0]?.embedding_id !== context.embeddingId) {
      throw new MemoryError('embedding_identity_mismatch');
    }
    await client.query('COMMIT');
    stores.set(db, Object.freeze({ ...context, embeddingId: context.embeddingId || result.rows[0]!.embedding_id }));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally { client.release(); }
}

export function memoryAccess(write = false): void {
  if (process.env.LOOP_MEMORY_OFF === '1') throw new MemoryError('memory_off');
  if (write && process.env.LOOP_LEARNING_OFF === '1') throw new MemoryError('learning_off');
  if (write && process.env.LOOP_MEMORY_RECALL_ONLY === '1') throw new MemoryError('memory_recall_only');
}

export function storeContext(db: LoopDb, write = false): StoreContext {
  memoryAccess(write);
  const context = stores.get(db);
  if (!context) throw new MemoryError('store_not_bound');
  if (write && !context.writable) throw new MemoryError('worktree_read_only');
  return context;
}
