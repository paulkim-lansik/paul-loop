import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/index';

export type LoopDb = NodePgDatabase<typeof schema>;

// loop-memory connection string. Default matches this plugin's docker-compose.yml (port 5434 /
// loop_memory) — a dedicated pgvector instance, separate from any product database you may have.
export const LOOP_DATABASE_URL =
  process.env.LOOP_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5434/loop_memory';

export function createLoopDb(connectionString: string = process.env.LOOP_DATABASE_URL || LOOP_DATABASE_URL): {
  db: LoopDb;
  pool: Pool;
} {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 3000, statement_timeout: 5000 });
  const db = drizzle(pool, { schema });
  return { db, pool };
}
