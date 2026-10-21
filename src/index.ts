export { VERSION } from './version.js';
export { TregError } from './errors.js';

export {
  runFfmpeg,
  FfmpegRun,
  type RunOptions,
  type RunResult,
  type RunEvents,
  type StartInfo,
  type PromptInfo,
  type ProgressSnapshot,
} from './ffmpeg/run.js';
export { analyzeArgs, buildArgs, expectedDurationSec, type ArgAnalysis } from './ffmpeg/analyze.js';
export { locateFfmpeg, locateFfprobe, findExecutable } from './ffmpeg/locate.js';

export {
  loadOptions,
  resolveOptions,
  DEFAULT_OPTIONS,
  type TregOptions,
  type Format,
} from './cli/options.js';
export { splitArgs } from './cli/args.js';
export { main, type CliIO } from './cli/main.js';

export { parseLogLine, parseStatsLine, isErrorLevel } from './parse/logline.js';
export { ProgressParser } from './parse/progress.js';
export { StderrParser, HeaderTracker, type StderrEvent } from './parse/stderr.js';
export { parseClock, parseFfmpegDuration, formatClock } from './parse/time.js';

export { LogCollector, type Issue } from './report/collect.js';
export { buildFailureReport, type FailureReport } from './report/failure.js';
export { formatFailure } from './report/format.js';

export {
  createRenderer,
  resolveFormat,
  BarRenderer,
  LineRenderer,
  JsonRenderer,
  QuietRenderer,
  type Renderer,
  type RenderContext,
} from './render/index.js';
export { createStyle, type Output, type Style } from './render/style.js';
export { TEMPLATE_TOKENS, renderTemplate } from './render/template.js';

export type { LogEntry, LogLevel, ProgressUpdate, MediaInfo, HeaderInfo } from './types.js';
