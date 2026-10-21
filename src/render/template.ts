import type { ProgressSnapshot } from '../ffmpeg/run.js';
import { formatClock } from '../parse/time.js';
import { truncateVisible, visibleLength } from './style.js';

export const TEMPLATE_TOKENS = [
  'bar',
  'percent',
  'frame',
  'fps',
  'time',
  'total',
  'speed',
  'eta',
  'elapsed',
  'size',
  'bitrate',
  'file',
] as const;

export type TemplateToken = (typeof TEMPLATE_TOKENS)[number];

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '--';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

/** Text for every token except `bar`. */
export function tokenValues(
  snap: ProgressSnapshot | undefined,
  file: string,
): Record<Exclude<TemplateToken, 'bar'>, string> {
  const percent = snap?.percent;
  return {
    percent: percent === undefined ? ' --%' : `${Math.floor(percent)}%`.padStart(4),
    frame: snap?.frame === undefined ? '-' : String(snap.frame),
    fps: snap?.fps === undefined ? '-' : snap.fps.toFixed(1),
    time: formatClock(snap?.timeSec),
    total: formatClock(snap?.totalSec),
    speed: snap?.speed === undefined ? '--x' : `${snap.speed.toFixed(snap.speed < 10 ? 2 : 1)}x`,
    eta: formatClock(snap?.etaSec),
    elapsed: formatClock(snap?.elapsedSec),
    size: formatBytes(snap?.sizeBytes),
    bitrate: snap?.bitrateKbps === undefined ? '--' : `${snap.bitrateKbps.toFixed(1)} kbit/s`,
    file,
  };
}

/** Replaces `{token}` with its value. Unknown tokens are left as written. */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}

export interface BarChars {
  complete: string;
  incomplete: string;
}

/**
 * Draws the bar. With an unknown fraction, a block slides back and forth;
 * `tick` moves it.
 */
export function renderBar(
  fraction: number | undefined,
  width: number,
  chars: BarChars,
  tick = 0,
): string {
  if (width <= 0) return '';
  if (fraction === undefined) {
    const block = Math.max(1, Math.floor(width / 5));
    const span = width - block;
    const period = Math.max(1, span * 2);
    const step = tick % period;
    const pos = step <= span ? step : period - step;
    return (
      chars.incomplete.repeat(pos) +
      chars.complete.repeat(block) +
      chars.incomplete.repeat(width - pos - block)
    );
  }
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width);
  return chars.complete.repeat(filled) + chars.incomplete.repeat(width - filled);
}

export interface LineLayout {
  template: string;
  values: Record<string, string>;
  columns: number;
  barWidth: number | 'auto';
  chars: BarChars;
  fraction: number | undefined;
  tick: number;
  /** Applied to `{file}` after it is fitted; `values.file` must be plain text. */
  fileStyle?: (s: string) => string;
}

const MIN_AUTO_BAR = 10;

/**
 * Fits `s` to exactly `width` characters: pads it when short, otherwise
 * replaces the middle with `…` so both ends stay visible.
 */
export function fitMiddle(s: string, width: number): string {
  const chars = [...s];
  if (width <= 0) return '';
  if (chars.length <= width) return s + ' '.repeat(width - chars.length);
  if (width === 1) return '…';
  const head = Math.floor((width - 1) / 2);
  const tail = width - 1 - head;
  return chars.slice(0, head).join('') + '…' + chars.slice(chars.length - tail).join('');
}

/**
 * Renders the template to fill `columns` without wrapping. An `auto` bar takes
 * the space the full file name leaves; `{file}` gets the rest, padded or
 * middle-truncated to fit.
 */
export function layoutLine(l: LineLayout): string {
  const file = l.values.file ?? '';
  const fileSlots = l.template.split('{file}').length - 1;
  const hasBar = l.template.includes('{bar}');
  const fixed = visibleLength(renderTemplate(l.template, { ...l.values, bar: '', file: '' }));
  const free = l.columns - 1 - fixed;
  let width: number;
  if (!hasBar) {
    width = 0;
  } else if (l.barWidth === 'auto') {
    width = Math.max(MIN_AUTO_BAR, free - visibleLength(file) * fileSlots);
  } else {
    width = l.barWidth;
  }
  const bar = renderBar(l.fraction, width, l.chars, l.tick);
  let fitted = file;
  if (fileSlots > 0) {
    fitted = fitMiddle(file, Math.floor(Math.max(0, free - width) / fileSlots));
    if (l.fileStyle) fitted = l.fileStyle(fitted);
  }
  return truncateVisible(
    renderTemplate(l.template, { ...l.values, bar, file: fitted }),
    l.columns - 1,
  );
}
