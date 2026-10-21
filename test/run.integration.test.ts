import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findExecutable } from '../src/ffmpeg/locate.js';
import { runFfmpeg, type ProgressSnapshot, type RunOptions } from '../src/ffmpeg/run.js';
import type { LogEntry } from '../src/types.js';

const ffmpegPath = findExecutable(process.env.FFMPEG_PATH ?? 'ffmpeg');
const work = mkdtempSync(join(tmpdir(), 'treg-run-'));
const SOURCE = ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=25'];

function run(args: string[], extra: Partial<RunOptions> = {}) {
  const job = runFfmpeg({ ffmpegPath: ffmpegPath!, args, cwd: work, interactive: false, ...extra });
  const progress: ProgressSnapshot[] = [];
  const logs: LogEntry[] = [];
  job.on('progress', (p) => progress.push(p));
  job.on('log', (l) => logs.push(l));
  return { job, progress, logs };
}

describe.skipIf(!ffmpegPath)('runFfmpeg (real ffmpeg)', () => {
  it('reports progress with percent against -t and exits 0', async () => {
    const { job, progress } = run(['-y', ...SOURCE, '-t', '2', '-c:v', 'mpeg4', 'ok.mp4']);
    let started = false;
    job.on('start', (s) => {
      started = true;
      expect(s.mode).toBe('progress');
      expect(s.args).toContain('level+info');
    });
    const result = await job.done;
    expect(started).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.failure).toBeUndefined();
    const last = progress.at(-1)!;
    expect(last.done).toBe(true);
    expect(last.totalSec).toBe(2);
    expect(last.percent).toBeGreaterThan(95);
    expect(result.header.outputs[0]?.path).toBe('ok.mp4');
  });

  it("surfaces ffmpeg's own error for a codec/container mismatch", async () => {
    const { job } = run(['-y', ...SOURCE, '-t', '1', '-c:v', 'mjpeg', 'bad.webm']);
    const result = await job.done;
    expect(result.exitCode).not.toBe(0);
    expect(result.failure?.errors).toContainEqual(
      expect.objectContaining({
        component: 'webm',
        message: expect.stringContaining('Only VP8 or VP9'),
      }),
    );
    expect(result.failure?.mapping.join('\n')).toContain('mjpeg');
    expect(result.failure?.fallbackLines).toEqual([]);
  });

  it('answers the overwrite prompt through onPrompt', async () => {
    writeFileSync(join(work, 'exists.mp4'), '');
    const prompts: string[] = [];
    const no = run([...SOURCE, '-t', '1', 'exists.mp4'], {
      interactive: true,
      onPrompt: (p) => {
        prompts.push(p.file);
        return false;
      },
    });
    const refused = await no.job.done;
    expect(prompts).toEqual(['exists.mp4']);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.failure?.errors[0]?.message).toContain('Not overwriting');

    const yes = run([...SOURCE, '-t', '1', '-c:v', 'mpeg4', 'exists.mp4'], {
      interactive: true,
      onPrompt: () => true,
    });
    expect((await yes.job.done).exitCode).toBe(0);
  });

  it('adds -n when not interactive, so an existing output fails clearly', async () => {
    writeFileSync(join(work, 'exists2.mp4'), '');
    const { job } = run([...SOURCE, '-t', '1', 'exists2.mp4']);
    const result = await job.done;
    expect(result.failure?.errors[0]?.message).toContain('already exists');
  });

  it('cancels gracefully on the first cancel()', async () => {
    const { job } = run(['-y', '-re', ...SOURCE, '-t', '30', '-c:v', 'mpeg4', 'long.mp4']);
    job.once('progress', () => job.cancel());
    const result = await job.done;
    expect(result.cancelled).toBe(true);
    expect(result.failure).toBeUndefined();
    expect(result.elapsedSec).toBeLessThan(15);
  });

  it('keeps an auto log file only on failure', async () => {
    const ok = await run(['-y', ...SOURCE, '-t', '1', '-c:v', 'mpeg4', 'log-ok.mp4'], {
      logFile: 'auto',
    }).job.done;
    expect(ok.logFile).toBeUndefined();

    const bad = await run(['-y', ...SOURCE, '-t', '1', '-c:v', 'libnope', 'log-bad.mp4'], {
      logFile: 'auto',
    }).job.done;
    expect(bad.logFile).toBeDefined();
    expect(existsSync(bad.logFile!)).toBe(true);
    expect(bad.failure?.logFile).toBe(bad.logFile);
  });

  it('falls back to stats parsing when media goes to stdout', async () => {
    const { job, progress } = run(['-y', ...SOURCE, '-t', '1', '-f', 'null', '-']);
    const result = await job.done;
    expect(result.exitCode).toBe(0);
    expect(progress.length).toBeGreaterThan(0);
  });

  it('rejects when the binary cannot start', async () => {
    const job = runFfmpeg({ ffmpegPath: join(work, 'missing-ffmpeg'), args: ['-version'] });
    await expect(job.done).rejects.toThrow(/could not start ffmpeg/);
  });
});
