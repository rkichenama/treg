import type { LogEntry, LogLevel, ProgressUpdate } from '../types.js';
import { parseClock } from './time.js';

// `[component @ 0x...] [level] message`, component optional.
const TAGGED =
  /^(?:\[(?<component>[^\]]+?)(?: @ (?:0x)?[0-9a-fA-F]+)?\] )?\[(?<level>panic|fatal|error|warning|info|verbose|debug|trace)\] (?<message>.*)$/;

/** Splits a stderr line produced with `-loglevel level+...` into its parts. */
export function parseLogLine(raw: string): LogEntry {
  const m = TAGGED.exec(raw);
  if (!m?.groups) return { message: raw, raw };
  const entry: LogEntry = {
    level: m.groups.level as LogLevel,
    message: m.groups.message ?? '',
    raw,
  };
  if (m.groups.component) entry.component = m.groups.component;
  return entry;
}

export function isErrorLevel(level: LogLevel | undefined): boolean {
  return level === 'panic' || level === 'fatal' || level === 'error';
}

const STATS = /(?:^|\s)L?size=.*time=\S+/;

/** True for ffmpeg's `frame=... time=... speed=...` stats line. */
export function isStatsLine(message: string): boolean {
  return STATS.test(message);
}

const SIZE_UNITS: Record<string, number> = {
  B: 1,
  kB: 1024,
  KiB: 1024,
  mB: 1024 ** 2,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
};

/** Parses a legacy stats line (used when -progress can't be used). */
export function parseStatsLine(message: string): ProgressUpdate | undefined {
  if (!isStatsLine(message)) return undefined;
  const update: ProgressUpdate = { done: false };
  const frame = /frame=\s*(\d+)/.exec(message);
  if (frame) update.frame = Number(frame[1]);
  const fps = /fps=\s*([\d.]+)/.exec(message);
  if (fps) update.fps = Number(fps[1]);
  const size = /L?size=\s*(\d+)\s*([A-Za-z]+)/.exec(message);
  if (size) update.sizeBytes = Number(size[1]) * (SIZE_UNITS[size[2] ?? ''] ?? 1);
  const time = /time=\s*(\S+)/.exec(message);
  const sec = time ? parseClock(time[1] ?? '') : undefined;
  if (sec !== undefined) update.timeSec = Math.max(0, sec);
  const bitrate = /bitrate=\s*([\d.]+)kbits\/s/.exec(message);
  if (bitrate) update.bitrateKbps = Number(bitrate[1]);
  const speed = /speed=\s*([\d.]+)x/.exec(message);
  if (speed) update.speed = Number(speed[1]);
  if (/Lsize=/.test(message)) update.done = true;
  return update;
}
