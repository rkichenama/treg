import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, type TregOptions } from '../src/cli/options.js';
import { analyzeArgs } from '../src/ffmpeg/analyze.js';
import type { ProgressSnapshot, RunResult, StartInfo } from '../src/ffmpeg/run.js';
import { createRenderer, resolveFormat } from '../src/render/index.js';
import { createStyle, shouldColor, truncateVisible, visibleLength } from '../src/render/style.js';
import {
  formatBytes,
  layoutLine,
  renderBar,
  renderTemplate,
  tokenValues,
} from '../src/render/template.js';

const plain = createStyle(false);

class Sink {
  text = '';
  columns = 60;
  isTTY = false;
  write(s: string) {
    this.text += s;
    return true;
  }
}

const start: StartInfo = {
  ffmpegPath: 'ffmpeg',
  args: [],
  mode: 'progress',
  analysis: analyzeArgs(['-i', 'in/a.mp4', 'out/b.mkv']),
};

const snap = (
  percent: number | undefined,
  extra: Partial<ProgressSnapshot> = {},
): ProgressSnapshot => ({
  done: false,
  elapsedSec: 1,
  timeSec: percent === undefined ? 3 : percent / 10,
  ...(percent === undefined ? {} : { percent, totalSec: 10 }),
  speed: 2,
  ...extra,
});

const result = (extra: Partial<RunResult> = {}): RunResult => ({
  exitCode: 0,
  cancelled: false,
  elapsedSec: 5,
  header: { inputs: [], outputs: [], mapping: [] },
  errorCount: 0,
  warningCount: 0,
  ...extra,
});

describe('template', () => {
  it('replaces known tokens and keeps unknown ones', () => {
    expect(renderTemplate('{a} {b} {zzz}', { a: '1', b: '2' })).toBe('1 2 {zzz}');
  });

  it('formats token values', () => {
    const v = tokenValues(snap(42, { sizeBytes: 2048, bitrateKbps: 400.44, fps: 25 }), 'f.mp4');
    expect(v.percent).toBe(' 42%');
    expect(v.size).toBe('2.0 KiB');
    expect(v.bitrate).toBe('400.4 kbit/s');
    expect(v.speed).toBe('2.00x');
    expect(tokenValues(undefined, '').percent).toBe(' --%');
  });

  it('draws determinate and sliding bars at the requested width', () => {
    const chars = { complete: '#', incomplete: '.' };
    expect(renderBar(0.5, 10, chars)).toBe('#####.....');
    expect(renderBar(2, 4, chars)).toBe('####');
    for (let t = 0; t < 30; t++) expect(renderBar(undefined, 10, chars, t)).toHaveLength(10);
    expect(renderBar(undefined, 10, chars, 0)).not.toBe(renderBar(undefined, 10, chars, 3));
  });

  it('fits the line to the terminal width', () => {
    const line = layoutLine({
      template: '{file} {bar} {percent}',
      values: { file: 'x.mp4', percent: ' 50%' },
      columns: 40,
      barWidth: 'auto',
      chars: { complete: '#', incomplete: '.' },
      fraction: 0.5,
      tick: 0,
    });
    expect(visibleLength(line)).toBe(39);
    const narrow = layoutLine({
      template: '{file} {bar} {percent}',
      values: { file: 'a-very-long-file-name.mp4', percent: ' 50%' },
      columns: 20,
      barWidth: 'auto',
      chars: { complete: '#', incomplete: '.' },
      fraction: 0.5,
      tick: 0,
    });
    expect(visibleLength(narrow)).toBeLessThanOrEqual(19);
  });

  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536 * 1024)).toBe('1.5 MiB');
  });
});

describe('style', () => {
  it('measures and truncates around ANSI codes', () => {
    const s = createStyle(true);
    const text = s.red('hello') + ' world';
    expect(visibleLength(text)).toBe(11);
    expect(visibleLength(truncateVisible(text, 7))).toBe(7);
  });

  it('honours color modes and NO_COLOR', () => {
    const tty = { write: () => true, isTTY: true };
    expect(shouldColor('auto', tty, {})).toBe(true);
    expect(shouldColor('auto', tty, { NO_COLOR: '1' })).toBe(false);
    expect(shouldColor('auto', { write: () => true }, {})).toBe(false);
    expect(shouldColor('always', { write: () => true }, { NO_COLOR: '1' })).toBe(true);
    expect(shouldColor('never', tty, {})).toBe(false);
  });
});

function setup(format: 'bar' | 'line' | 'quiet' | 'json', options: Partial<TregOptions> = {}) {
  const out = new Sink();
  const json = new Sink();
  let now = 0;
  const renderer = createRenderer(
    format,
    { options: { ...DEFAULT_OPTIONS, ...options }, out, style: plain, now: () => (now += 1000) },
    json,
  );
  renderer.start(start);
  return { renderer, out, json };
}

describe('renderers', () => {
  it('auto picks bar on a TTY and line otherwise', () => {
    expect(resolveFormat('auto', { write: () => true, isTTY: true })).toBe('bar');
    expect(resolveFormat('auto', { write: () => true })).toBe('line');
    expect(resolveFormat('json', { write: () => true, isTTY: true })).toBe('json');
  });

  it('bar redraws in place and ends with a summary', () => {
    const { renderer, out } = setup('bar');
    renderer.progress(snap(10));
    renderer.progress(snap(60));
    renderer.end(result({ lastProgress: snap(99), elapsedSec: 4 }));
    expect(out.text).toContain('\r\x1b[2K');
    expect(out.text).toContain('b.mkv');
    expect(out.text).toContain('100%');
    expect(out.text).toMatch(/✔ done in 0:04 → b\.mkv\n$/);
  });

  it('bar prints the failure report instead of a summary', () => {
    const { renderer, out } = setup('bar');
    renderer.progress(snap(10));
    renderer.end(
      result({
        exitCode: 1,
        failure: {
          exitCode: 1,
          errors: [{ level: 'error', component: 'webm', message: 'Only VP8 or VP9', count: 1 }],
          warnings: [],
          mapping: [],
          fallbackLines: [],
          errorsSuppressed: false,
        },
      }),
    );
    expect(out.text).toContain('✖ ffmpeg failed (exit 1)');
    expect(out.text).toContain('webm: Only VP8 or VP9');
    expect(out.text).not.toContain('✔');
  });

  it('bar shows warnings only when enabled', () => {
    const warn = {
      level: 'warning' as const,
      component: 'libopus',
      message: 'No bit rate set',
      raw: '',
    };
    const off = setup('bar');
    off.renderer.log(warn);
    expect(off.out.text).toBe('');
    const on = setup('bar', { showWarnings: true });
    on.renderer.log(warn);
    expect(on.out.text).toContain('⚠ libopus: No bit rate set');
  });

  it('line prints at percent steps', () => {
    const { renderer, out } = setup('line', { lineEveryPercent: 25 });
    for (const p of [1, 5, 26, 30, 51, 76, 100]) renderer.progress(snap(p));
    const lines = out.text.trim().split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatch(/^b\.mkv \[ {2}1%\]/);
  });

  it('quiet prints only failures and cancels', () => {
    const ok = setup('quiet');
    ok.renderer.progress(snap(50));
    ok.renderer.end(result());
    expect(ok.out.text).toBe('');
    const cancel = setup('quiet');
    cancel.renderer.end(result({ cancelled: true, lastProgress: snap(20) }));
    expect(cancel.out.text).toContain('■ cancelled at 0:02 / 0:10 (20%)');
  });

  it('json writes one event per line to its own output', () => {
    const { renderer, out, json } = setup('json');
    renderer.progress(snap(50));
    renderer.log({ level: 'error', component: 'webm', message: 'bad', raw: '' });
    renderer.log({ level: 'info', message: 'noise', raw: '' });
    renderer.end(result());
    expect(out.text).toBe('');
    const events = json.text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string });
    expect(events.map((e) => e.type)).toEqual(['start', 'progress', 'log', 'end']);
  });
});
