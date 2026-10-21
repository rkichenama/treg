import { readFileSync } from 'node:fs';
import { TregError } from '../errors.js';

export const FORMATS = ['auto', 'bar', 'line', 'json', 'quiet', 'raw'] as const;
export type Format = (typeof FORMATS)[number];

export const COLOR_MODES = ['auto', 'always', 'never'] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

export interface TregOptions {
  /** ffmpeg binary: a command on PATH or a path to the executable. */
  ffmpegPath: string;
  /** auto: bar on a terminal, line otherwise. */
  format: Format;
  /** Progress template, see TEMPLATE_TOKENS. */
  template: string;
  /** Bar width in characters, or auto to fill the terminal. */
  barWidth: number | 'auto';
  barChars: { complete: string; incomplete: string };
  color: ColorMode;
  /** Max redraws (bar) or progress events (json) per second. */
  refreshHz: number;
  /** line format: print a line every N percent. */
  lineEveryPercent: number;
  /** Print input/output summary before progress. */
  showHeader: boolean;
  /** Print ffmpeg [warning] lines while running. */
  showWarnings: boolean;
  /** null: no log file; "auto": temp file kept only on failure; or a path. */
  logFile: string | null;
  /** Run ffprobe when ffmpeg doesn't report the input duration. */
  probe: boolean;
  /**
   * Files or glob patterns to convert one by one; replaces -i. Output
   * arguments become templates ({name} {ext} {dir} {index}). Empty: normal run.
   */
  inputs: string[];
}

export const DEFAULT_OPTIONS: TregOptions = {
  ffmpegPath: 'ffmpeg',
  format: 'auto',
  template: '{file} {bar} {percent} | {time}/{total} | {speed} | ETA {eta}',
  barWidth: 'auto',
  barChars: { complete: '▰', incomplete: '▱' },
  color: 'auto',
  refreshHz: 10,
  lineEveryPercent: 10,
  showHeader: false,
  showWarnings: false,
  logFile: null,
  probe: false,
  inputs: [],
};

/** A fresh copy of the defaults, so callers can't mutate the shared object. */
function defaults(): TregOptions {
  return {
    ...DEFAULT_OPTIONS,
    barChars: { ...DEFAULT_OPTIONS.barChars },
    inputs: [...DEFAULT_OPTIONS.inputs],
  };
}

type Check = (value: unknown) => string | undefined;

const isString: Check = (v) => (typeof v === 'string' ? undefined : 'must be a string');
const isNonEmptyString: Check = (v) =>
  typeof v === 'string' && v.length > 0 ? undefined : 'must be a non-empty string';
const isBoolean: Check = (v) => (typeof v === 'boolean' ? undefined : 'must be true or false');
const positive: Check = (v) =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? undefined : 'must be a positive number';
const oneOf =
  (values: readonly string[]): Check =>
  (v) =>
    typeof v === 'string' && values.includes(v)
      ? undefined
      : `must be one of ${values.map((x) => `"${x}"`).join(', ')}`;

const CHECKS: Record<keyof TregOptions, Check> = {
  ffmpegPath: isNonEmptyString,
  format: oneOf(FORMATS),
  template: isString,
  barWidth: (v) =>
    v === 'auto' || (Number.isInteger(v) && (v as number) > 0)
      ? undefined
      : 'must be "auto" or a positive whole number',
  barChars: () => undefined, // checked field by field below
  color: oneOf(COLOR_MODES),
  refreshHz: positive,
  lineEveryPercent: (v) =>
    typeof v === 'number' && v > 0 && v <= 100 ? undefined : 'must be a number from 1 to 100',
  showHeader: isBoolean,
  showWarnings: isBoolean,
  logFile: (v) =>
    v === null || (typeof v === 'string' && v !== '')
      ? undefined
      : 'must be null, "auto" or a file path',
  probe: isBoolean,
  inputs: (v) =>
    Array.isArray(v) && v.every((x) => typeof x === 'string' && x !== '')
      ? undefined
      : 'must be a list of file paths or glob patterns',
};

export interface ResolvedOptions {
  options: TregOptions;
  /** Non-fatal problems, e.g. unknown keys. */
  warnings: string[];
}

/**
 * Validates user options and merges them over the defaults. Collects every
 * problem and throws one TregError listing all of them.
 */
export function resolveOptions(input: unknown, source = 'options'): ResolvedOptions {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new TregError(`${source}: must be a JSON object`);
  }
  const raw = input as Record<string, unknown>;
  const errors: string[] = [];
  const warnings: string[] = [];
  const options = defaults();
  const target = options as unknown as Record<string, unknown>;

  for (const [key, value] of Object.entries(raw)) {
    if (!(key in CHECKS)) {
      warnings.push(`${source}: unknown option "${key}" ignored`);
      continue;
    }
    if (key === 'barChars') {
      errors.push(...mergeBarChars(value, options, source));
      continue;
    }
    const problem = CHECKS[key as keyof TregOptions](value);
    if (problem) errors.push(`${source}: "${key}" ${problem}`);
    else target[key] = value;
  }

  if (errors.length > 0) throw new TregError(errors.join('\n'));
  return { options, warnings };
}

function mergeBarChars(value: unknown, options: TregOptions, source: string): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [`${source}: "barChars" must be an object with "complete" and "incomplete"`];
  }
  const errors: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k !== 'complete' && k !== 'incomplete') {
      errors.push(`${source}: unknown option "barChars.${k}"`);
    } else if (typeof v !== 'string' || [...v].length !== 1) {
      errors.push(`${source}: "barChars.${k}" must be a single character`);
    } else {
      options.barChars[k] = v;
    }
  }
  return errors;
}

/** Loads the `--treg-option` file, or returns the defaults when no path. */
export function loadOptions(path?: string): ResolvedOptions {
  if (path === undefined) {
    return {
      options: defaults(),
      warnings: [],
    };
  }
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new TregError(
      code === 'ENOENT'
        ? `options file not found: ${path}`
        : `cannot read options file ${path}: ${(err as Error).message}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new TregError(`${path}: invalid JSON: ${(err as Error).message}`);
  }
  return resolveOptions(json, path);
}
