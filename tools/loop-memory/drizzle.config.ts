import { defineConfig } from 'drizzle-kit';

// Dedicated loop-memory DB (separate pgvector container — port 5434 / loop_memory).
// Fully separate schema/migrations/connection (LOOP_DATABASE_URL) from any product database.
const url =
  process.env.LOOP_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5434/loop_memory';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: { url },
});
