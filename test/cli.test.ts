import { mkdtempSync, writeFileSync } from 'node:fs';
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
