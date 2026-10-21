import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandInputs } from '../src/batch/inputs.js';
import { fillOutputTemplate, planBatch } from '../src/batch/plan.js';
import { batchExitCode, summarizeBatch } from '../src/batch/summary.js';
import type { RunResult } from '../src/ffmpeg/run.js';
import { createStyle } from '../src/render/style.js';
import { formatBatchSummary } from '../src/report/format.js';

const dir = mkdtempSync(join(tmpdir(), 'treg-batch-'));
for (const f of ['a.mov', 'take2.mov', 'take10.mov', 'take1.mov', 'clip.mp4', 'notes.txt']) {
  writeFileSync(join(dir, f), '');
}
mkdirSync(join(dir, 'sub'));
writeFileSync(join(dir, 'sub', 'deep.mov'), '');
mkdirSync(join(dir, 'folder.mov')); // a directory that matches *.mov

const norm = (paths: string[]) => paths.map((p) => p.replace(/\\/g, '/'));

describe('expandInputs', () => {
  it('expands a glob in natural order and skips directories', () => {
    expect(norm(expandInputs(['*.mov'], dir))).toEqual([
      'a.mov',
      'take1.mov',
      'take2.mov',
      'take10.mov',
    ]);
  });

  it('supports ** and braces', () => {
    expect(norm(expandInputs(['**/deep.mov'], dir))).toEqual(['sub/deep.mov']);
    expect(norm(expandInputs(['*.{mp4,txt}'], dir))).toEqual(['clip.mp4', 'notes.txt']);
  });

  it('keeps plain paths, entry order, and drops duplicates', () => {
    expect(norm(expandInputs(['clip.mp4', 'a.mov', '*.mov'], dir))).toEqual([
      'clip.mp4',
      'a.mov',
      'take1.mov',
      'take2.mov',
      'take10.mov',
    ]);
  });

  it('treats backslashes as separators on Windows', () => {
    expect(norm(expandInputs(['sub\\*.mov'], dir, 'win32'))).toEqual(['sub/deep.mov']);
  });

  it('reports every missing file and empty pattern at once', () => {
    expect(() => expandInputs(['nope.mov', '*.mkv', 'a.mov'], dir)).toThrow(
      /file not found: nope\.mov\n.*pattern matched no files: \*\.mkv/,
    );
  });
});

describe('fillOutputTemplate', () => {
  it('fills name, ext, dir and padded index', () => {
    expect(fillOutputTemplate('{dir}/{name}.{ext}.mp4', 'clips/a.b.mov', 3, 12)).toBe(
      'clips/a.b.mov.mp4',
    );
    expect(fillOutputTemplate('out-{index}.mkv', 'x.mov', 3, 12)).toBe('out-03.mkv');
    expect(fillOutputTemplate('{dir}/{name}.mp4', 'x.mov', 1, 1)).toBe('./x.mp4');
  });
});

describe('planBatch', () => {
  it('builds one run per input with -i first and outputs filled in', () => {
    const jobs = planBatch(['a.mov', 'b.mov'], ['-y', '-c:v', 'libx264', '{name}.mp4'], dir);
    expect(jobs).toEqual([
      {
        index: 1,
        input: 'a.mov',
        outputs: ['a.mp4'],
        args: ['-i', 'a.mov', '-y', '-c:v', 'libx264', 'a.mp4'],
      },
      {
        index: 2,
        input: 'b.mov',
        outputs: ['b.mp4'],
        args: ['-i', 'b.mov', '-y', '-c:v', 'libx264', 'b.mp4'],
      },
    ]);
  });

  it('fills every output of a multi-output command', () => {
    const [job] = planBatch(['a.mov'], ['{name}.mp4', '-vn', '{name}.m4a'], dir);
    expect(job?.outputs).toEqual(['a.mp4', 'a.m4a']);
  });

  it('refuses -i on the command line', () => {
    expect(() => planBatch(['a.mov'], ['-i', 'x.mov', 'o.mp4'], dir)).toThrow(/replaces -i/);
    expect(() =>
      planBatch(['a.mov'], ['-i', '{input}', '-i', 'logo.png', 'o-{name}.mp4'], dir),
    ).toThrow(/replaces -i/);
  });

  it('puts each file at -i {input} so input options can come first', () => {
    const [job] = planBatch(
      ['a.mov'],
      ['-re', '-ss', '5', '-i', '{input}', '-t', '2', '{name}.mp4'],
      dir,
    );
    expect(job?.args).toEqual(['-re', '-ss', '5', '-i', 'a.mov', '-t', '2', 'a.mp4']);
  });

  it('refuses a missing output', () => {
    expect(() => planBatch(['a.mov'], ['-c:v', 'libx264'], dir)).toThrow(/needs an output name/);
  });

  it('refuses outputs that collide or overwrite an input', () => {
    expect(() => planBatch(['a.mov', 'b.mov'], ['same.mp4'], dir)).toThrow(
      /"a\.mov" and "b\.mov" would both write "same\.mp4"/,
    );
    expect(() => planBatch(['a.mov'], ['{name}.mov'], dir)).toThrow(
      /would overwrite input "a\.mov"/,
    );
  });

  it('compares paths case-insensitively on Windows', () => {
    expect(() => planBatch(['a.mov', 'A.MOV'], ['out.mp4'], dir, 'win32')).toThrow(/both write/);
  });
});

const run = (extra: Partial<RunResult>): RunResult => ({
  exitCode: 0,
  ffmpegExitCode: 0,
  cancelled: false,
  elapsedSec: 1,
  header: { inputs: [], outputs: [], mapping: [] },
  errorCount: 0,
  warningCount: 0,
  ...extra,
});

const failure = {
  exitCode: 1,
  ffmpegExitCode: 1,
  errors: [
    { level: 'error' as const, component: 'webm', message: 'Only VP8 or VP9\nmore', count: 1 },
  ],
  warnings: [],
  mapping: [],
  fallbackLines: [],
  errorsSuppressed: false,
};

describe('batch summary', () => {
  const jobs = planBatch(['a.mov', 'b.mov', 'c.mov', 'd.mov'], ['{name}.mp4'], dir);

  it('counts statuses and keeps the first error line', () => {
    const s = summarizeBatch(jobs, [
      run({}),
      run({ exitCode: 1, failure }),
      run({ cancelled: true, exitCode: 0 }),
    ]);
    expect(s).toMatchObject({ total: 4, done: 1, failed: 1, cancelled: 1, skipped: 1 });
    expect(s.jobs[1]?.error).toBe('webm: Only VP8 or VP9');
    expect(batchExitCode(s)).toBe(1);
    const text = formatBatchSummary(s, createStyle(false)).join('\n');
    expect(text).toContain('batch: 4 files, 1 done, 1 failed, 1 cancelled, 1 skipped');
    expect(text).toContain('✖ b.mov: webm: Only VP8 or VP9');
    expect(text).toContain('■ c.mov: cancelled');
  });

  it('leaves the failed count out of the header when nothing failed', () => {
    const s = summarizeBatch(jobs, [run({}), run({ cancelled: true })]);
    const lines = formatBatchSummary(s, createStyle(false));
    expect(lines[0]).toBe('batch: 4 files, 1 done, 1 cancelled, 2 skipped');
    expect(lines).toEqual([
      'batch: 4 files, 1 done, 1 cancelled, 2 skipped',
      '  ■ b.mov: cancelled',
    ]);
  });

  it('exits 0 when all succeed or a file is cancelled cleanly', () => {
    expect(
      batchExitCode(
        summarizeBatch(
          jobs,
          jobs.map(() => run({})),
        ),
      ),
    ).toBe(0);
    expect(batchExitCode(summarizeBatch(jobs, [run({ cancelled: true })]))).toBe(0);
    expect(batchExitCode(summarizeBatch(jobs, [run({ cancelled: true, exitCode: 255 })]))).toBe(
      255,
    );
  });
});
