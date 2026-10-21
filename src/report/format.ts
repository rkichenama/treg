import type { BatchJob } from '../batch/plan.js';
import type { BatchSummary } from '../batch/summary.js';
import type { ProgressSnapshot, RunResult } from '../ffmpeg/run.js';
import { formatClock } from '../parse/time.js';
import type { Style } from '../render/style.js';
import { formatBytes } from '../render/template.js';
import type { HeaderInfo } from '../types.js';
import type { Issue } from './collect.js';
import type { FailureReport } from './failure.js';

const MAX_LABEL = 18;

/* istanbul ignore next -- @preserve */
function issueLines(issues: Issue[], style: Style, color: (s: string) => string): string[] {
  // Untagged-by-component messages come from ffmpeg itself; label them so they
  // don't read as a continuation of the line above.
  const labels = issues.map((i) => `${i.component ?? 'ffmpeg'}:`);
  const width = Math.min(MAX_LABEL, Math.max(0, ...labels.map((l) => l.length)));
  const lines: string[] = [];
  issues.forEach((issue, n) => {
    const label = labels[n] ?? '';
    const prefix = width > 0 ? `${label.padEnd(width)} ` : '';
    const [first = '', ...rest] = issue.message.split('\n');
    const count = issue.count > 1 ? style.dim(` (×${issue.count})`) : '';
    lines.push(`  ${style.dim(prefix)}${color(first)}${count}`);
    const indent = ' '.repeat(2 + prefix.length);
    for (const more of rest) lines.push(`${indent}${style.dim(more)}`);
  });
  return lines;
}

/** Turns a failure report into the lines treg prints. */
/* istanbul ignore next -- @preserve */
export function formatFailure(report: FailureReport, style: Style): string[] {
  const lines = [style.red(style.bold(`✖ ffmpeg failed (exit ${report.exitCode})`))];
  if (report.ffmpegExitCode !== report.exitCode) {
    lines.push(
      style.dim(
        `  ffmpeg exited ${report.ffmpegExitCode} despite this fatal error; treg reports failure.`,
      ),
    );
  }

  if (report.errors.length > 0) {
    lines.push(...issueLines(report.errors, style, (s) => s));
  } else if (report.fallbackLines.length > 0) {
    lines.push(style.dim("  ffmpeg didn't tag an error. Its last output lines:"));
    lines.push(...report.fallbackLines.map((l) => `  ${l}`));
  } else {
    lines.push(style.dim('  ffmpeg printed no error message.'));
  }

  if (report.errorsSuppressed) {
    lines.push(
      style.yellow("  Your -loglevel hides ffmpeg's error messages. Remove it to see why."),
    );
  }

  if (report.mapping.length > 0) {
    lines.push('');
    report.mapping.forEach((m, i) =>
      lines.push(`  ${style.dim(i === 0 ? 'mapping:' : '        ')} ${m}`),
    );
  }

  lines.push(
    report.logFile
      ? `  ${style.dim('full log:')} ${report.logFile}`
      : style.dim('  Full log: set "logFile": "auto" in your --treg-option file.'),
  );
  return lines;
}

/* istanbul ignore next -- @preserve */
export function formatWarning(issue: Issue, style: Style): string {
  const label = issue.component ? `${issue.component}: ` : '';
  return style.yellow(`⚠ ${label}${issue.message}`);
}

/* istanbul ignore next -- @preserve */
export function formatHeader(h: HeaderInfo, style: Style): string[] {
  const lines: string[] = [];
  for (const i of h.inputs) {
    const dur = i.durationSec !== undefined ? `, ${formatClock(i.durationSec)}` : '';
    lines.push(`${style.dim('in ')} ${i.path} ${style.dim(`(${i.format}${dur})`)}`);
    i.streams.forEach((s) => lines.push(`    ${style.dim(s)}`));
  }
  for (const o of h.outputs)
    lines.push(`${style.dim('out')} ${o.path} ${style.dim(`(${o.format})`)}`);
  return lines;
}

/* istanbul ignore next -- @preserve */
function where(snap: ProgressSnapshot | undefined): string {
  if (!snap) return '';
  const pct = snap.percent !== undefined ? ` (${Math.floor(snap.percent)}%)` : '';
  const total = snap.totalSec !== undefined ? ` / ${formatClock(snap.totalSec)}` : '';
  return ` at ${formatClock(snap.timeSec)}${total}${pct}`;
}

export function formatCancelled(result: RunResult, style: Style): string {
  return style.yellow(`■ cancelled${where(result.lastProgress)}`);
}

/* istanbul ignore next -- @preserve */
export function formatSuccess(result: RunResult, file: string, style: Style): string[] {
  const size = result.lastProgress?.sizeBytes;
  const sizeText = size !== undefined ? `, ${formatBytes(size)}` : '';
  const target = file ? ` → ${file}` : '';
  const lines = [
    style.green(`✔ done in ${formatClock(result.elapsedSec)}${target}`) + style.dim(sizeText),
  ];
  if (result.errorCount > 0) {
    lines.push(
      style.yellow(`  ffmpeg logged ${result.errorCount} error(s) but finished; check the output.`),
    );
  }
  return lines;
}

/** `[2/5] clips/b.mov → b.mp4`, printed before each file of a batch. */
export function formatJobLabel(job: BatchJob, total: number, style: Style): string {
  return `${style.dim(`[${job.index}/${total}]`)} ${job.input} → ${job.outputs.join(', ')}`;
}

/** End-of-batch summary: counts, then each file that failed or was cancelled. */
export function formatBatchSummary(summary: BatchSummary, style: Style): string[] {
  const parts = [`${summary.done} done`];
  if (summary.failed > 0) parts.push(style.red(`${summary.failed} failed`));
  if (summary.cancelled > 0) parts.push(style.yellow(`${summary.cancelled} cancelled`));
  if (summary.skipped > 0) parts.push(style.yellow(`${summary.skipped} skipped`));
  const lines = [style.bold(`batch: ${summary.total} files, ${parts.join(', ')}`)];
  for (const job of summary.jobs) {
    if (job.status === 'failed') lines.push(`  ${style.red('✖')} ${job.input}: ${job.error ?? ''}`);
    if (job.status === 'cancelled') lines.push(`  ${style.yellow('■')} ${job.input}: cancelled`);
  }
  return lines;
}
