import type { RunResult } from '../ffmpeg/run.js';
import type { BatchJob } from './plan.js';

export type BatchStatus = 'done' | 'failed' | 'cancelled' | 'skipped';

export interface BatchJobResult {
  index: number;
  input: string;
  outputs: string[];
  status: BatchStatus;
  exitCode?: number;
  /** First ffmpeg error for a failed file, as `component: message`. */
  error?: string;
}

export interface BatchSummary {
  total: number;
  done: number;
  failed: number;
  cancelled: number;
  skipped: number;
  jobs: BatchJobResult[];
}

function firstError(result: RunResult): string {
  const f = result.failure;
  const e = f?.errors[0];
  if (e) return `${e.component ?? 'ffmpeg'}: ${e.message.split('\n')[0]}`;
  const last = f?.fallbackLines.at(-1);
  return last ?? `exit ${result.exitCode}`;
}

/** Combines per-file results; jobs without a result were skipped. */
export function summarizeBatch(
  jobs: readonly BatchJob[],
  results: readonly RunResult[],
): BatchSummary {
  const out: BatchJobResult[] = jobs.map((job, n) => {
    const base = { index: job.index, input: job.input, outputs: job.outputs };
    const r = results[n];
    if (!r) return { ...base, status: 'skipped' };
    if (r.cancelled) return { ...base, status: 'cancelled', exitCode: r.exitCode };
    if (r.failure) return { ...base, status: 'failed', exitCode: r.exitCode, error: firstError(r) };
    return { ...base, status: 'done', exitCode: r.exitCode };
  });
  const count = (s: BatchStatus) => out.filter((j) => j.status === s).length;
  return {
    total: out.length,
    done: count('done'),
    failed: count('failed'),
    cancelled: count('cancelled'),
    skipped: count('skipped'),
    jobs: out,
  };
}

/** First failed file's code; else 130 (or the file's code) when cancelled; else 0. */
export function batchExitCode(summary: BatchSummary): number {
  const failed = summary.jobs.find((j) => j.status === 'failed');
  if (failed) return failed.exitCode ?? 1;
  const cancelled = summary.jobs.find((j) => j.status === 'cancelled');
  if (cancelled) return cancelled.exitCode ? cancelled.exitCode : 130;
  return 0;
}
