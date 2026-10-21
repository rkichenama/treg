import { describe, expect, it } from 'vitest';
import { LineSplitter } from '../src/parse/lines.js';
import { isStatsLine, parseLogLine, parseStatsLine } from '../src/parse/logline.js';
import { ProgressParser } from '../src/parse/progress.js';
import { StderrParser, type StderrEvent } from '../src/parse/stderr.js';
import { formatClock, parseClock, parseFfmpegDuration } from '../src/parse/time.js';
import { chunks, loadFixture } from './helpers.js';

describe('time', () => {
  it('parses clocks', () => {
    expect(parseClock('00:00:05.00')).toBe(5);
    expect(parseClock('01:02:03.5')).toBe(3723.5);
    expect(parseClock('02:03')).toBe(123);
    expect(parseClock('N/A')).toBeUndefined();
  });

  it('parses ffmpeg duration syntax', () => {
    expect(parseFfmpegDuration('10')).toBe(10);
    expect(parseFfmpegDuration('1.5')).toBe(1.5);
    expect(parseFfmpegDuration('500ms')).toBe(0.5);
    expect(parseFfmpegDuration('00:01:00')).toBe(60);
    expect(parseFfmpegDuration('abc')).toBeUndefined();
  });

  it('formats clocks', () => {
    expect(formatClock(5)).toBe('0:05');
    expect(formatClock(3723.9)).toBe('1:02:03');
    expect(formatClock(undefined)).toBe('--:--');
  });
});

describe('LineSplitter', () => {
  it('splits on CRLF, CR and LF across chunk boundaries', () => {
    const s = new LineSplitter();
    expect(s.push('a\r')).toEqual(['a']);
    expect(s.push('\nb\rc')).toEqual(['b']);
    expect(s.pending).toBe('c');
    expect(s.flush()).toEqual(['c']);
  });
});

describe('ProgressParser', () => {
  it('parses the success fixture into updates ending with done', () => {
    const { progress } = loadFixture('success');
    const parser = new ProgressParser();
    const updates = chunks(progress, 7).flatMap((c) => parser.push(c));
    expect(updates.length).toBeGreaterThan(1);
    const last = updates.at(-1)!;
    expect(last.done).toBe(true);
    expect(last.frame).toBe(125);
    expect(last.timeSec).toBeCloseTo(4.99229, 4);
    expect(last.sizeBytes).toBe(249872);
    expect(last.bitrateKbps).toBe(400.4);
    expect(last.speed).toBe(29.9);
    expect(updates.slice(0, -1).every((u) => !u.done)).toBe(true);
  });

  it('treats N/A as missing', () => {
    const parser = new ProgressParser();
    const [u] = parser.push(
      'frame=0\nbitrate=N/A\nout_time_us=N/A\nspeed=N/A\nprogress=continue\n',
    );
    expect(u).toEqual({ done: false, frame: 0 });
  });
});

describe('parseLogLine', () => {
  it('splits component, level and message', () => {
    expect(parseLogLine('[webm @ 000002243e9c4640] [error] Only VP8 or VP9')).toMatchObject({
      component: 'webm',
      level: 'error',
      message: 'Only VP8 or VP9',
    });
    expect(parseLogLine('[out#0/webm @ 0x7f00] [error] Could not write header')).toMatchObject({
      component: 'out#0/webm',
      level: 'error',
    });
    expect(parseLogLine('[fatal] Filter not found')).toMatchObject({
      level: 'fatal',
      message: 'Filter not found',
    });
    const untagged = parseLogLine('To ignore this, add a trailing ? to the map.');
    expect(untagged.level).toBeUndefined();
    expect(untagged.component).toBeUndefined();
  });
});

describe('stats lines', () => {
  it('parses legacy stats', () => {
    const line =
      'frame=  125 fps=0.0 q=2.0 Lsize=     244kB time=00:00:04.99 bitrate= 400.4kbits/s speed=29.9x    ';
    expect(isStatsLine(line)).toBe(true);
    expect(parseStatsLine(line)).toEqual({
      done: true,
      frame: 125,
      fps: 0,
      sizeBytes: 244 * 1024,
      timeSec: 4.99,
      bitrateKbps: 400.4,
      speed: 29.9,
    });
  });

  it('parses audio-only stats with N/A values', () => {
    const u = parseStatsLine('size=N/A time=00:00:01.00 bitrate=N/A speed=10x');
    expect(u).toMatchObject({ timeSec: 1, speed: 10 });
    expect(isStatsLine('Stream mapping:')).toBe(false);
  });
});

function parseAll(text: string, size = 13) {
  const parser = new StderrParser();
  const events: StderrEvent[] = [];
  for (const c of chunks(text, size)) events.push(...parser.push(c));
  events.push(...parser.flush());
  return { parser, events };
}

describe('StderrParser', () => {
  it('reads the header of the success fixture', () => {
    const { parser } = parseAll(loadFixture('success').stderr);
    const { inputs, outputs, mapping } = parser.header.info;
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ path: 'input.mp4', durationSec: 5, fps: 25 });
    expect(inputs[0]!.streams).toHaveLength(2);
    expect(outputs[0]).toMatchObject({ path: 'out.mp4', format: 'mp4' });
    expect(mapping).toEqual([
      'Stream #0:0 -> #0:0 (mpeg4 (native) -> mpeg4 (native))',
      'Stream #0:1 -> #0:1 (aac (native) -> aac (native))',
    ]);
  });

  it('emits stats updates in legacy mode, not log entries', () => {
    const { events } = parseAll(loadFixture('legacy-stats').stderr);
    const stats = events.filter((e) => e.type === 'stats');
    expect(stats.length).toBeGreaterThan(0);
    const logs = events.filter((e) => e.type === 'log');
    expect(logs.some((e) => e.type === 'log' && e.entry.message.includes('frame='))).toBe(false);
    const last = stats.at(-1);
    expect(last?.type === 'stats' && last.update.done).toBe(true);
  });

  it('marks untagged lines after tagged output as continuations', () => {
    const { events } = parseAll(loadFixture('bad-map').stderr);
    const cont = events.find((e) => e.type === 'log' && e.entry.continued);
    expect(cont).toMatchObject({
      entry: { level: 'fatal', message: "To ignore this, add a trailing '?' to the map." },
    });
  });

  it('detects the overwrite prompt glued to the next message', () => {
    const { events } = parseAll(loadFixture('overwrite-prompt-no').stderr, 4096);
    expect(events.find((e) => e.type === 'prompt')).toMatchObject({ file: 'existing.mp4' });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'log',
        entry: expect.objectContaining({ level: 'fatal', message: 'Not overwriting - exiting' }),
      }),
    );
  });

  it('detects a pending prompt before the newline arrives', () => {
    const parser = new StderrParser();
    const events = parser.push("File 'out.mp4' already exists. Overwrite? [y/N] ");
    expect(events).toEqual([
      { type: 'prompt', file: 'out.mp4', text: "File 'out.mp4' already exists. Overwrite? [y/N] " },
    ]);
  });

  it('waits for the prompt trailing space before taking it', () => {
    const parser = new StderrParser();
    expect(parser.push("File 'o.mp4' already exists. Overwrite? [y/N]")).toEqual([]);
    const events = [...parser.push(' '), ...parser.push('[fatal] Not overwriting - exiting\n')];
    expect(events.map((e) => e.type)).toEqual(['prompt', 'log']);
    expect(events[1]).toMatchObject({
      entry: { level: 'fatal', message: 'Not overwriting - exiting' },
    });
  });

  it('still parses a tagged line that starts with stray whitespace', () => {
    const parser = new StderrParser();
    const [event] = parser.push(' [fatal] Not overwriting - exiting\n');
    expect(event).toMatchObject({ type: 'log', entry: { level: 'fatal' } });
  });

  it('keeps untagged lines standalone when nothing was tagged', () => {
    const { events } = parseAll('Unrecognized option foo\nError splitting the argument list\n');
    const logs = events.filter((e) => e.type === 'log');
    expect(logs).toHaveLength(2);
    expect(logs.every((e) => e.type === 'log' && !e.entry.continued)).toBe(true);
  });
});
