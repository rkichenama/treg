import type { HeaderInfo, LogEntry, MediaInfo, ProgressUpdate } from '../types.js';
import { LineSplitter } from './lines.js';
import { parseLogLine, parseStatsLine } from './logline.js';
import { parseClock } from './time.js';

export type StderrEvent =
  | { type: 'log'; entry: LogEntry }
  | { type: 'prompt'; file: string; text: string }
  | { type: 'stats'; update: ProgressUpdate };

// ffmpeg prints this without a newline and then waits on stdin.
const PROMPT = /^File '(.*)' already exists\. Overwrite\? \[y\/N\] ?/;
// While pending, wait for the trailing space so it doesn't start the next line.
const PENDING_PROMPT = /^File '(.*)' already exists\. Overwrite\? \[y\/N\] $/;

/**
 * Turns ffmpeg stderr chunks into log entries, overwrite prompts and legacy
 * stats updates, and tracks the header (inputs, outputs, stream mapping).
 */
export class StderrParser {
  readonly header = new HeaderTracker();
  private readonly lines = new LineSplitter();
  private last: LogEntry | undefined;
  private sawTagged = false;

  push(chunk: string): StderrEvent[] {
    const events: StderrEvent[] = [];
    for (const line of this.lines.push(chunk)) this.line(line, events);
    // The prompt has no trailing newline; detect it while it is still pending.
    const pending = this.lines.pending;
    const m = PENDING_PROMPT.exec(pending);
    if (m) {
      this.lines.takePending();
      events.push({ type: 'prompt', file: m[1] ?? '', text: pending });
    }
    return events;
  }

  flush(): StderrEvent[] {
    const events: StderrEvent[] = [];
    for (const line of this.lines.flush()) this.line(line, events);
    return events;
  }

  private line(line: string, events: StderrEvent[]): void {
    // The prompt can arrive glued to the next message on one line.
    const prompt = PROMPT.exec(line);
    if (prompt) {
      events.push({ type: 'prompt', file: prompt[1] ?? '', text: prompt[0] });
      line = line.slice(prompt[0].length);
      if (line.length === 0) return;
    }

    const entry = parseLogLine(line);
    if (entry.level) {
      this.sawTagged = true;
    } else if (this.sawTagged && this.last) {
      // Untagged line after tagged output: continuation of the previous entry.
      entry.continued = true;
      entry.level = this.last.level;
      if (this.last.component) entry.component = this.last.component;
    }

    const stats = parseStatsLine(entry.message);
    if (stats) {
      events.push({ type: 'stats', update: stats });
      return;
    }

    if (!entry.level || entry.level === 'info') this.header.add(entry.message);
    if (!entry.continued) this.last = entry;
    events.push({ type: 'log', entry });
  }
}

const INPUT = /^Input #(\d+), (.+?), from '(.*)':$/;
const OUTPUT = /^Output #(\d+), (.+?), to '(.*)':$/;
const DURATION = /^\s+Duration: ([^,]+),/;
const STREAM = /^\s+Stream #\d+:\d+\S*: (Video|Audio|Subtitle|Data|Attachment): (.*)$/;
const FPS = /(\d+(?:\.\d+)?) fps/;

/** Collects input/output descriptions and the stream mapping block. */
export class HeaderTracker {
  readonly info: HeaderInfo = { inputs: [], outputs: [], mapping: [] };
  private section: 'none' | 'media' | 'mapping' = 'none';
  private current: MediaInfo | undefined;

  add(message: string): void {
    const input = INPUT.exec(message);
    const output = input ? null : OUTPUT.exec(message);
    const media = input ?? output;
    if (media) {
      this.current = {
        index: Number(media[1]),
        format: media[2] ?? '',
        path: media[3] ?? '',
        streams: [],
      };
      (input ? this.info.inputs : this.info.outputs).push(this.current);
      this.section = 'media';
      return;
    }
    if (message === 'Stream mapping:') {
      this.section = 'mapping';
      this.current = undefined;
      return;
    }
    if (!/^\s/.test(message)) {
      this.section = 'none';
      this.current = undefined;
      return;
    }
    if (this.section === 'mapping') {
      if (/^\s+Stream #/.test(message)) this.info.mapping.push(message.trim());
      return;
    }
    if (this.section === 'media' && this.current) {
      const duration = DURATION.exec(message);
      if (duration) {
        const sec = parseClock(duration[1] ?? '');
        if (sec !== undefined) this.current.durationSec = sec;
        return;
      }
      const stream = STREAM.exec(message);
      if (stream) {
        this.current.streams.push(`${stream[1]}: ${stream[2]}`);
        const fps = stream[1] === 'Video' ? FPS.exec(stream[2] ?? '') : null;
        if (fps && this.current.fps === undefined) this.current.fps = Number(fps[1]);
      }
    }
  }
}
