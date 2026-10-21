import { isErrorLevel } from '../parse/logline.js';
import type { LogEntry, LogLevel } from '../types.js';

/** A distinct ffmpeg error or warning, with how often it repeated. */
export interface Issue {
  level: LogLevel;
  component?: string;
  message: string;
  count: number;
}

const RECENT_LIMIT = 50;

/** Gathers ffmpeg's errors and warnings (deduplicated) while a run is going. */
export class LogCollector {
  readonly errors: Issue[] = [];
  readonly warnings: Issue[] = [];
  private readonly recent: string[] = [];
  private readonly index = new Map<string, Issue>();
  /** Issue that continuation lines attach to; unset after a repeat. */
  private open: Issue | undefined;

  add(entry: LogEntry): Issue | undefined {
    if (entry.raw.trim().length > 0) {
      this.recent.push(entry.raw.trimEnd());
      if (this.recent.length > RECENT_LIMIT) this.recent.shift();
    }

    if (entry.continued) {
      if (this.open) this.open.message += `\n${entry.message}`;
      return undefined;
    }

    const list = isErrorLevel(entry.level)
      ? this.errors
      : entry.level === 'warning'
        ? this.warnings
        : undefined;
    if (!list || !entry.level) {
      this.open = undefined;
      return undefined;
    }

    const key = `${entry.level}|${entry.component ?? ''}|${entry.message}`;
    const seen = this.index.get(key);
    if (seen) {
      seen.count++;
      this.open = undefined;
      return undefined;
    }
    const issue: Issue = { level: entry.level, message: entry.message, count: 1 };
    if (entry.component) issue.component = entry.component;
    this.index.set(key, issue);
    list.push(issue);
    this.open = issue;
    return issue;
  }

  /** Last non-empty raw stderr lines, for when ffmpeg tagged no errors. */
  recentLines(limit = 10): string[] {
    return this.recent.slice(-limit);
  }
}
