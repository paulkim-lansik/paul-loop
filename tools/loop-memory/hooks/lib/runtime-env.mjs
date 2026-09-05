import { loadDotenv } from './load-dotenv.mjs';

/** One precedence contract for CLI and hooks: shell (including explicit empty) > userConfig > file. */
export function runtimeEnv(root, input = process.env) {
  const env = { ...input };
  for (const name of [
    'OPENAI_API_KEY', 'GEMINI_API_KEY', 'LOOP_DATABASE_URL', 'LOOP_MEMORY_SIGNING_KEY',
    'LOOP_DOTENV_PATH', 'LOOP_EMBED_PROVIDER', 'LOOP_EMBED_MODEL',
    'LOOP_RECALL_MAX_DISTANCE', 'LOOP_KNOWLEDGE_MAX_DISTANCE',
  ]) {
    const option = `CLAUDE_PLUGIN_OPTION_${name}`;
    if (!(name in env) && option in env) env[name] = env[option];
  }
  const dotenv = loadDotenv(root, env.LOOP_DOTENV_PATH, env);
  return { env, dotenv };
}
