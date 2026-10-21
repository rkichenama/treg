import type { HeaderInfo } from '../types.js';
import type { Issue, LogCollector } from './collect.js';

/** What treg shows when ffmpeg exits with an error. */
export interface FailureReport {
  exitCode: number;
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

export function buildFailureReport(input: {
  exitCode: number;
  collector: LogCollector;
  header: HeaderInfo;
  errorsSuppressed: boolean;
  logFile?: string;
}): FailureReport {
  const { collector } = input;
  const report: FailureReport = {
    exitCode: input.exitCode,
    errors: collector.errors.map((e) => ({ ...e })),
    warnings: collector.warnings.map((w) => ({ ...w })),
    mapping: [...input.header.mapping],
    fallbackLines: collector.errors.length === 0 ? collector.recentLines() : [],
    errorsSuppressed: input.errorsSuppressed,
  };
  if (input.logFile) report.logFile = input.logFile;
  return report;
}
