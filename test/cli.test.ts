import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { main, type CliIO } from '../src/cli/main.js';
import { findExecutable } from '../src/ffmpeg/locate.js';

const ffmpegPath = findExecutable(process.env.FFMPEG_PATH ?? 'ffmpeg');
const work = mkdtempSync(join(tmpdir(), 'treg-cli-'));
const SOURCE = ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=25'];

class Sink {
  text = '';
  isTTY = false;
  columns = 80;
  write(s: string) {
    this.text += s;
    return true;
  }
}

function io(): CliIO & { out: Sink; err: Sink } {
  const out = new Sink();
  const err = new Sink();
  return {
    stdout: out,
    stderr: err,
    stdin: Readable.from([]),
    env: { ...process.env, NO_COLOR: '1' },
    cwd: work,
    out,
    err,
  };
}

function options(name: string, value: unknown): string {
  const file = join(work, name);
  writeFileSync(file, JSON.stringify(value));
  return file;
}

describe('main', () => {
  it('prints usage without ffmpeg arguments', async () => {
    const t = io();
    expect(await main([], t)).toBe(1);
    expect(t.err.text).toContain('Usage: treg [--treg-option <options.json>]');
  });

  it('reports option file problems before running ffmpeg', async () => {
    const t = io();
    const file = options('bad.json', { format: 'fancy', refreshHz: 0 });
    expect(await main(['--treg-option', file, '-i', 'a', 'b'], t)).toBe(2);
    expect(t.err.text).toMatch(/^treg: .*"format" must be one of/m);
    expect(t.err.text).toMatch(/^treg: .*"refreshHz" must be a positive number/m);
  });

  it('warns about unknown option keys', async () => {
    const t = io();
    const file = options('typo.json', { ffmpegPath: 'definitely-not-ffmpeg', colour: 'never' });
    expect(await main(['--treg-option', file, '-i', 'a', 'b'], t)).toBe(127);
    expect(t.err.text).toContain('treg: warning:');
    expect(t.err.text).toContain('unknown option "colour"');
    expect(t.err.text).toContain('treg: ffmpeg not found');
  });
});

describe.skipIf(!ffmpegPath)('main (real ffmpeg)', () => {
  it('emits NDJSON with format json', async () => {
    const t = io();
    const file = options('json.json', { format: 'json' });
    const code = await main(
      ['--treg-option', file, '-y', ...SOURCE, '-t', '1', '-c:v', 'mpeg4', 'out.mp4'],
      t,
    );
    expect(code).toBe(0);
    const types = t.out.text
      .trim()
      .split('\n')
      .map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types[0]).toBe('start');
    expect(types).toContain('progress');
    expect(types.at(-1)).toBe('end');
    expect(t.err.text).toBe('');
  });

  it("prints ffmpeg's reason on failure, not the dump", async () => {
    const t = io();
    const code = await main(['-y', ...SOURCE, '-t', '1', '-c:v', 'mjpeg', 'out.webm'], t);
    expect(code).not.toBe(0);
    expect(t.err.text).toContain('✖ ffmpeg failed');
    expect(t.err.text).toContain('webm:');
    expect(t.err.text).toContain('Only VP8 or VP9');
    expect(t.err.text).not.toContain('Input #0');
    expect(t.err.text).not.toContain('Press [q]');
  });

  it('prints line progress and a summary when not on a terminal', async () => {
    const t = io();
    const code = await main(['-y', ...SOURCE, '-t', '1', '-c:v', 'mpeg4', 'line.mp4'], t);
    expect(code).toBe(0);
    expect(t.err.text).toMatch(/line\.mp4 \[\s*\d+%\]/);
    expect(t.err.text).toMatch(/✔ done in \d+:\d\d → line\.mp4/);
  });

  it('refuses to overwrite without a terminal and says why', async () => {
    writeFileSync(join(work, 'taken.mp4'), '');
    const t = io();
    const code = await main([...SOURCE, '-t', '1', 'taken.mp4'], t);
    expect(code).not.toBe(0);
    expect(t.err.text).toContain("File 'taken.mp4' already exists. Exiting.");
  });
});

describe.skipIf(!ffmpegPath)('main batch (real ffmpeg)', () => {
  const src = join(work, 'batch');
  mkdirSync(src, { recursive: true });
  for (const name of ['take1', 'take2', 'take10']) {
    spawnSync(ffmpegPath!, [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=0.5:size=160x120:rate=25',
      '-c:v',
      'mpeg4',
      join(src, `${name}.mp4`),
    ]);
  }
  writeFileSync(join(src, 'broken.mp4'), 'not a video');

  it('converts each file, keeps going after a failure, and summarizes', async () => {
    const t = io();
    const file = options('batch.json', { inputs: ['batch/*.mp4'] });
    const code = await main(
      ['--treg-option', file, '-y', '-c:v', 'mpeg4', '{dir}/{name}-out.mkv'],
      t,
    );
    expect(code).not.toBe(0);
    for (const name of ['take1', 'take2', 'take10']) {
      expect(existsSync(join(src, `${name}-out.mkv`))).toBe(true);
    }
    const err = t.err.text.replace(/\\/g, '/');
    // Natural order: broken, take1, take2, take10.
    expect(err).toMatch(
      /\[1\/4\] batch\/broken\.mp4[\s\S]*\[2\/4\] batch\/take1\.mp4[\s\S]*\[4\/4\] batch\/take10\.mp4/,
    );
    expect(err).toContain('batch: 4 files, 3 done, 1 failed');
    expect(err).toMatch(/✖ batch\/broken\.mp4: .+/);
  });

  it('tags JSON events with the job and ends with a summary', async () => {
    const t = io();
    const file = options('batch-json.json', { format: 'json', inputs: ['batch/take*.mp4'] });
    const code = await main(
      ['--treg-option', file, '-y', '-c:v', 'mpeg4', '{dir}/{name}-json.mkv'],
      t,
    );
    expect(code).toBe(0);
    const events = t.out.text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { type: string; job?: number; done?: number });
    expect(events[0]?.type).toBe('batch');
    expect(events.at(-1)).toMatchObject({ type: 'summary', done: 3 });
    const jobs = new Set(events.filter((e) => e.type === 'end').map((e) => e.job));
    expect([...jobs]).toEqual([1, 2, 3]);
  });

  it('refuses -i on the command line while inputs is set', async () => {
    const t = io();
    const file = options('batch-i.json', { inputs: ['batch/take1.mp4'] });
    expect(await main(['--treg-option', file, '-i', 'x.mp4', 'o.mkv'], t)).toBe(2);
    expect(t.err.text).toContain('replaces -i');
  });
});
