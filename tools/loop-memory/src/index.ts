export { createLoopDb, LOOP_DATABASE_URL, type LoopDb } from './client';
export { type Embedder, stubEmbedder } from './embedding';
export { type ApiEmbedderOptions, apiEmbedder, type EmbedProvider } from './embedding-api';
export {
  ADR_TAG,
  CONTEXT_TAG,
  DESIGN_TAG,
  type GraduateMarkdownDirResult,
  graduateContext,
  graduateKnowledge,
  graduateMarkdownDir,
  KNOWLEDGE_TAGS,
  type KnowledgeChunk,
  type KnowledgeSyncResult,
  parseAdrChunks,
  parseContextChunks,
  parseMarkdownChunks,
  RESEARCH_TAG,
  recallKnowledge,
  sha8,
  syncKnowledge,
} from './knowledge';
export {
  decideLessonReap,
  type GraduateResult,
  graduateLessons,
  LESSON_TAG,
  type LessonFile,
  type LessonReapDecision,
  type LessonRecord,
  lessonContent,
  lessonStub,
  readLessonRecords,
  readVerifiedLessons,
  recallLessons,
} from './lessons';
export {
  addNote,
  type MemoryOpKind,
  type NoteInput,
  noop,
  type RecallHit,
  recall,
  recordRecall,
  softDeleteNote,
  updateNote,
} from './ops';
export { signContent, signingKeyFromEnv, verifySignature } from './provenance';
export * as schema from './schema/index';
