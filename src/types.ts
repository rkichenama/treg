/* istanbul ignore file -- @preserve */
export const LOG_LEVELS = [
  'panic',
  'fatal',
  'error',
  'warning',
  'info',
  'verbose',
  'debug',
  'trace',
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** One stderr line from ffmpeg, split into its parts when ffmpeg tagged it. */
export interface LogEntry {
  /** Severity tag from `-loglevel level+...`; undefined for untagged lines. */
  level?: LogLevel;
  /** Component that raised it (`webm`, `out#0/webm`), pointer address removed. */
  component?: string;
  message: string;
  /** True for an untagged line that continues the previous tagged entry. */
  continued?: boolean;
  raw: string;
}

/** One progress sample, from `-progress` blocks or a legacy stats line. */
export interface ProgressUpdate {
  frame?: number;
  fps?: number;
  /** Output timestamp in seconds. */
  timeSec?: number;
  sizeBytes?: number;
  bitrateKbps?: number;
  /** Encoding speed as a multiple of realtime. */
  speed?: number;
  /** True on the final block (`progress=end`). */
  done: boolean;
}

export interface MediaInfo {
  index: number;
  format: string;
  path: string;
  durationSec?: number;
  fps?: number;
  /** Stream descriptions, e.g. `Video: h264 (High), yuv420p, 1920x1080, 25 fps`. */
  streams: string[];
}

/** What ffmpeg printed about its inputs, outputs and stream mapping. */
export interface HeaderInfo {
  inputs: MediaInfo[];
  outputs: MediaInfo[];
  /** Lines of the `Stream mapping:` block, trimmed. */
  mapping: string[];
}
