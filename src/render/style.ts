import type { ColorMode } from '../cli/options.js';

/** Where a renderer writes. A subset of NodeJS.WriteStream. */
export interface Output {
  write(text: string): unknown;
  columns?: number;
  isTTY?: boolean;
}

export interface Style {
  enabled: boolean;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  dim(s: string): string;
  bold(s: string): string;
}

const wrap =
  (enabled: boolean, open: number, close: number) =>
  (s: string): string =>
    enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export function createStyle(enabled: boolean): Style {
  return {
    enabled,
    red: wrap(enabled, 31, 39),
    green: wrap(enabled, 32, 39),
    yellow: wrap(enabled, 33, 39),
    cyan: wrap(enabled, 36, 39),
    dim: wrap(enabled, 2, 22),
    bold: wrap(enabled, 1, 22),
  };
}

export function shouldColor(mode: ColorMode, out: Output, env = process.env): boolean {
  if (mode === 'never') return false;
  if (mode === 'always') return true;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '0') return true;
  return Boolean(out.isTTY) && env.TERM !== 'dumb';
}

// eslint-disable-next-line no-control-regex -- matching ANSI escapes is the point
const ANSI = /\x1b\[[0-9;]*m/g;

/** Printed width of a string: ANSI codes removed, counted by code point. */
export function visibleLength(s: string): number {
  return [...s.replace(ANSI, '')].length;
}

/** Cuts a string to `width` visible characters, keeping ANSI codes intact. */
export function truncateVisible(s: string, width: number): string {
  if (visibleLength(s) <= width) return s;
  let out = '';
  let seen = 0;
  for (let i = 0; i < s.length && seen < width;) {
    ANSI.lastIndex = i;
    const m = ANSI.exec(s);
    if (m && m.index === i) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    out += ch;
    i += ch.length;
    seen++;
  }
  return out + (s.includes('\x1b[') ? '\x1b[0m' : '');
}
