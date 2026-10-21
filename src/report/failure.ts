import type { HeaderInfo } from '../types.js';
import type { Issue, LogCollector } from './collect.js';

/** What treg shows when ffmpeg exits with an error. */
export interface FailureReport {
  /** Exit code treg reports (see effectiveExitCode). */
  exitCode: number;
  /** ffmpeg's actual exit code; differs from exitCode only when ffmpeg exited 0. */
  ffmpegExitCode: number;
  /** ffmpeg's own error/fatal messages, in order, deduplicated. */
  errors: Issue[];
  warnings: Issue[];
  /** The `Stream mapping:` lines: what ffmpeg was trying to do. */
  mapping: string[];
  /** Last raw stderr lines; only filled when ffmpeg tagged no errors. */
  fallbackLines: string[];
  /** True when the user's -loglevel hid the error details. */
  errorsSuppressed: boolean;
  logFile?: string;
}

/**
 * ffmpeg 6.1 to 9.0 exit with 0 after some fatal errors, e.g. when refusing
 * to overwrite an existing output (`-n`, or answering no to the prompt).
 * A successful run never logs at fatal level, so report those as exit 1.
 */
export function effectiveExitCode(ffmpegExitCode: number, collector: LogCollector): number {
  return ffmpegExitCode === 0 && collector.hasFatal() ? 1 : ffmpegExitCode;
}

export function buildFailureReport(input: {
  exitCode: number;
  ffmpegExitCode?: number;
  collector: LogCollector;
  header: HeaderInfo;
  errorsSuppressed: boolean;
  logFile?: string;
}): FailureReport {
  const { collector } = input;
  const report: FailureReport = {
    exitCode: input.exitCode,
    ffmpegExitCode: input.ffmpegExitCode ?? input.exitCode,
    errors: collector.errors.map((e) => ({ ...e })),
    warnings: collector.warnings.map((w) => ({ ...w })),
    mapping: [...input.header.mapping],
    fallbackLines: collector.errors.length === 0 ? collector.recentLines() : [],
    errorsSuppressed: input.errorsSuppressed,
  };
  if (input.logFile) report.logFile = input.logFile;
  return report;
}
