export function lessonContentHash(l: Record<string, any>): string;
export function lessonState(l: Record<string, any>, options?: { root?: string }): {
  invalidated: boolean; rejected: boolean; retired: boolean; verified: boolean;
  receipts: Array<{id: string; failure_id: string; seal_id: string; run_id: string; verdict: string; command_hash: string; root_hash: string; iterations?: number; finished_at?: string}>;
};
