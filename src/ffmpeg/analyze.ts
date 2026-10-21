import type { HeaderInfo } from '../types.js';
import { parseFfmpegDuration } from '../parse/time.js';

/** Options that never take a value. Everything else starting with `-` does. */
const BOOLEAN_OPTIONS = new Set([
  'y',
  'n',
  'stats',
  'nostats',
  'hide_banner',
  'stdin',
  'nostdin',
  're',
  'shortest',
  'copyts',
  'start_at_zero',
  'vn',
  'an',
  'sn',
  'dn',
  'ignore_unknown',
  'autorotate',
  'accurate_seek',
  'debug_ts',
  'xerror',
  'report',
  'benchmark',
  'benchmark_all',
  'dump',
  'hex',
  'fix_sub_duration',
  'bitexact',
  'autoscale',
  'copy_unknown',
]);

/** Options that make ffmpeg print information instead of transcoding. */
const INFO_OPTIONS = new Set([
  'h',
  '?',
  'help',
  'version',
  'buildconf',
  'formats',
  'muxers',
  'demuxers',
  'devices',
  'codecs',
  'decoders',
  'encoders',
  'bsfs',
  'protocols',
  'filters',
  'pix_fmts',
  'layouts',
  'sample_fmts',
  'dispositions',
  'colors',
  'hwaccels',
  'sources',
  'sinks',
  'L',
]);

export interface ArgAnalysis {
  /** -y or -n, when given. */
  overwrite?: 'yes' | 'no';
  inputs: string[];
  outputs: string[];
  /** True when the args ask ffmpeg for information (-version, -encoders...). */
  infoQuery: boolean;
  outputToStdout: boolean;
  inputFromStdin: boolean;
  /** Position of the -loglevel/-v value in the args. */
  loglevel?: { index: number; value: string };
  hasProgress: boolean;
  hasStats: boolean;
  hasNoStats: boolean;
  hasHideBanner: boolean;
  startSec?: number;
  limitSec?: number;
  toSec?: number;
  frameLimit?: number;
}

const STDOUT = new Set(['-', 'pipe:', 'pipe:1']);
const STDIN = new Set(['-', 'pipe:', 'pipe:0']);

/** Reads what treg needs to know from the user's ffmpeg arguments. */
export function analyzeArgs(args: readonly string[]): ArgAnalysis {
  const a: ArgAnalysis = {
    inputs: [],
    outputs: [],
    infoQuery: false,
    outputToStdout: false,
    inputFromStdin: false,
    hasProgress: false,
    hasStats: false,
    hasNoStats: false,
    hasHideBanner: false,
  };

  for (let i = 0; i < args.length; i++) {
    const tok = args[i] ?? '';
    if (!tok.startsWith('-') || tok === '-') {
      a.outputs.push(tok);
      if (STDOUT.has(tok)) a.outputToStdout = true;
      continue;
    }
    const name = tok.slice(1);
    const [base = '', spec] = name.split(':', 2);

    if (INFO_OPTIONS.has(base)) {
      a.infoQuery = true;
      continue;
    }
    if (BOOLEAN_OPTIONS.has(base) || (base.startsWith('no') && base.length > 2)) {
      if (base === 'y') a.overwrite = 'yes';
      else if (base === 'n') a.overwrite = 'no';
      else if (base === 'stats') a.hasStats = true;
      else if (base === 'nostats') a.hasNoStats = true;
      else if (base === 'hide_banner') a.hasHideBanner = true;
      continue;
    }

    const value = args[i + 1];
    i++;
    if (value === undefined) break;
    switch (base) {
      case 'i':
        a.inputs.push(value);
        if (STDIN.has(value)) a.inputFromStdin = true;
        break;
      case 'loglevel':
      case 'v':
        a.loglevel = { index: i, value };
        break;
      case 'progress':
        a.hasProgress = true;
        break;
      case 'ss':
        a.startSec ??= parseFfmpegDuration(value);
        break;
      case 't':
        a.limitSec = parseFfmpegDuration(value);
        break;
      case 'to':
        a.toSec = parseFfmpegDuration(value);
        break;
      case 'vframes':
        a.frameLimit = Number(value);
        break;
      case 'frames':
        if (spec === undefined || spec === 'v') a.frameLimit = Number(value);
        break;
    }
  }

  return a;
}

/** Best estimate of the output duration, used for percent and ETA. */
export function expectedDurationSec(a: ArgAnalysis, header: HeaderInfo): number | undefined {
  let total = header.inputs.find((i) => i.durationSec !== undefined)?.durationSec;
  if (total !== undefined && a.startSec !== undefined) total = Math.max(0, total - a.startSec);
  if (a.toSec !== undefined && a.limitSec === undefined) {
    const span = a.toSec - (a.startSec ?? 0);
    total = total === undefined ? span : Math.min(total, span);
  }
  if (a.limitSec !== undefined)
    total = total === undefined ? a.limitSec : Math.min(total, a.limitSec);
  return total !== undefined && total > 0 ? total : undefined;
}

export type ProgressMode = 'progress' | 'stats';

export interface BuildResult {
  args: string[];
  mode: ProgressMode;
  /** True when the user's -loglevel hides error messages. */
  errorsSuppressed: boolean;
}

const QUIET_LEVELS = new Set(['quiet', 'panic', '-8', '0']);

/**
 * Adds treg's flags to the user's args. Progress comes from -progress pipe:1
 * unless stdout carries media or the user set -progress themselves; then it
 * falls back to stderr stats lines.
 */
export function buildArgs(
  userArgs: readonly string[],
  a: ArgAnalysis,
  opts: { interactive: boolean },
): BuildResult {
  const mode: ProgressMode = a.outputToStdout || a.hasProgress ? 'stats' : 'progress';
  const pre: string[] = [];
  const args = [...userArgs];

  if (!a.hasHideBanner) pre.push('-hide_banner');
  if (mode === 'progress') {
    pre.push('-progress', 'pipe:1');
    if (!a.hasStats && !a.hasNoStats) pre.push('-nostats');
  }

  let errorsSuppressed = false;
  if (a.loglevel) {
    const flags = a.loglevel.value.split('+');
    const level = flags.at(-1) ?? '';
    errorsSuppressed = QUIET_LEVELS.has(level);
    if (!flags.includes('level')) args[a.loglevel.index] = `level+${a.loglevel.value}`;
  } else {
    pre.push('-loglevel', 'level+info');
  }

  // Without a terminal nobody can answer the overwrite prompt.
  if (!a.overwrite && !opts.interactive) pre.push('-n');

  return { args: [...pre, ...args], mode, errorsSuppressed };
}
