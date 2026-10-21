import type { ProgressUpdate } from '../types.js';
import { LineSplitter } from './lines.js';
import { parseClock } from './time.js';

/**
 * Parses the `key=value` blocks ffmpeg writes with `-progress <url>`.
 * Each block ends with `progress=continue` or `progress=end`.
 */
export class ProgressParser {
  private readonly lines = new LineSplitter();
  private fields: Record<string, string> = {};

  push(chunk: string): ProgressUpdate[] {
    return this.consume(this.lines.push(chunk));
  }

  flush(): ProgressUpdate[] {
    return this.consume(this.lines.flush());
  }

  private consume(lines: string[]): ProgressUpdate[] {
    const updates: ProgressUpdate[] = [];
    for (const line of lines) {
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key === 'progress') {
        updates.push(toUpdate(this.fields, value === 'end'));
        this.fields = {};
      } else {
        this.fields[key] = value;
      }
    }
    return updates;
  }
}

function toUpdate(f: Record<string, string>, done: boolean): ProgressUpdate {
  const update: ProgressUpdate = { done };
  const frame = num(f.frame);
  if (frame !== undefined) update.frame = frame;
  const fps = num(f.fps);
  if (fps !== undefined) update.fps = fps;
  // out_time_ms is misnamed by ffmpeg and also holds microseconds.
  const us = num(f.out_time_us) ?? num(f.out_time_ms);
  const time = us !== undefined ? us / 1e6 : f.out_time ? parseClock(f.out_time) : undefined;
  if (time !== undefined) update.timeSec = Math.max(0, time);
  const size = num(f.total_size);
  if (size !== undefined) update.sizeBytes = size;
  const bitrate = num(f.bitrate?.replace(/kbits\/s$/, ''));
  if (bitrate !== undefined) update.bitrateKbps = bitrate;
  const speed = num(f.speed?.replace(/x$/, ''));
  if (speed !== undefined) update.speed = speed;
  return update;
}

function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === 'N/A') return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}
