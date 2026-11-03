import { existsSync, rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { probeDuration } from '../src/ffmpeg/probe.js';
import { runFfmpeg, type ProgressSnapshot, type RunOptions } from '../src/ffmpeg/run.js';
import type { LogEntry } from '../src/types.js';
import {
  asksToOverwrite,
  fakeBin,
  ffmpegCalls,
  fromFixture,
  isFfprobe,
  runsUntilQuit,
  scriptSpawn,
  spawnCalls,
} from './fake-spawn.js';

const bin = fakeBin();
const INPUT = ['-i', 'input.mp4'];

function run(args: string[], extra: Partial<RunOptions> = {}) {
  const job = runFfmpeg({ ffmpegPath: bin.ffmpeg, args, interactive: false, ...extra });
  const progress: ProgressSnapshot[] = [];
  const logs: LogEntry[] = [];
  job.on('progress', (p) => progress.push(p));
  job.on('log', (l) => logs.push(l));
  return { job, progress, logs };
}

describe('runFfmpeg', () => {
  it('reports progress with percent against -t and exits 0', async () => {
    scriptSpawn(() => fromFixture('success'));
    const { job, progress } = run(['-y', ...INPUT, '-t', '4', '-c:v', 'mpeg4', 'out.mp4']);
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
    // -t wins over the 5 s duration in the recorded header.
    expect(last.totalSec).toBe(4);
    expect(last.percent).toBeGreaterThan(95);
    expect(result.header.outputs[0]?.path).toBe('out.mp4');
  });

  it("surfaces ffmpeg's own error for a codec/container mismatch", async () => {
    scriptSpawn(() => fromFixture('codec-mismatch'));
    const { job } = run(['-y', ...INPUT, '-c:v', 'mjpeg', 'out.webm']);
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
    scriptSpawn(() => asksToOverwrite());
    const prompts: string[] = [];
    const no = run([...INPUT, 'existing.mp4'], {
      interactive: true,
      onPrompt: (p) => {
        prompts.push(p.file);
        return false;
      },
    });
    const refused = await no.job.done;
    expect(prompts).toEqual(['existing.mp4']);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.failure?.errors[0]?.message).toContain('Not overwriting');

    const yes = run([...INPUT, '-c:v', 'mpeg4', 'existing.mp4'], {
      interactive: true,
      onPrompt: () => true,
    });
    expect((await yes.job.done).exitCode).toBe(0);
  });

  it('adds -n when not interactive, so an existing output fails clearly', async () => {
    scriptSpawn(() => fromFixture('exists-no-overwrite'));
    const { job } = run([...INPUT, 'existing.mp4']);
    const result = await job.done;
    expect(spawnCalls[0]?.args).toContain('-n');
    expect(result.failure?.errors[0]?.message).toContain('already exists');
  });

  it('cancels gracefully on the first cancel()', async () => {
    scriptSpawn(() => runsUntilQuit('long.mp4'));
    const { job } = run(['-y', ...INPUT, '-c:v', 'mpeg4', 'long.mp4']);
    job.once('progress', () => job.cancel());
    const result = await job.done;
    expect(result.cancelled).toBe(true);
    expect(result.failure).toBeUndefined();
    // Only `q` ends this script, so a clean exit means treg asked ffmpeg to finish.
    expect(result.ffmpegExitCode).toBe(0);
    expect(result.signal).toBeUndefined();
  });

  it('reads the duration from ffprobe', async () => {
    scriptSpawn(() => ({ stdout: '5.000000\n' }));
    expect(await probeDuration(bin.ffprobe, 'input.mp4')).toBe(5);
    expect(spawnCalls[0]?.args.at(-1)).toBe('input.mp4');
  });

  it('stops a pending probe when its signal aborts', async () => {
    scriptSpawn(() => ({ hang: true }));
    const abort = new AbortController();
    const pending = probeDuration(bin.ffprobe, 'input.mp4', abort.signal);
    abort.abort();
    expect(await pending).toBeUndefined();
  });

  it('cancel() during the probe stops it and never starts ffmpeg', async () => {
    scriptSpawn(() => ({ hang: true }));
    const { job } = run(['-y', ...INPUT, '-c:v', 'mpeg4', 'never-started.mp4'], { probe: true });
    let started = false;
    job.on('start', () => (started = true));
    // run() has spawned ffprobe by the time this macrotask runs.
    setImmediate(() => job.cancel());
    const result = await job.done;
    expect(started).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.failure).toBeUndefined();
    expect(spawnCalls.map(isFfprobe)).toEqual([true]);
  });

  it('cancel() before the run begins never starts ffmpeg', async () => {
    scriptSpawn(() => fromFixture('success'));
    const { job } = run(['-y', ...INPUT, '-c:v', 'mpeg4', 'never-begun.mp4']);
    let started = false;
    job.on('start', () => (started = true));
    job.cancel();
    const result = await job.done;
    expect(started).toBe(false);
    expect(result.cancelled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(spawnCalls).toEqual([]);
  });

  it('kills ffmpeg on a second cancel()', async () => {
    scriptSpawn(() => ({ ...runsUntilQuit('stop-kill.mp4'), onStdin: () => undefined }));
    const { job } = run(['-y', ...INPUT, '-c:v', 'mpeg4', 'stop-kill.mp4']);
    job.once('progress', () => {
      job.cancel();
      job.cancel();
    });
    const result = await job.done;
    expect(result.cancelled).toBe(true);
    expect(result.signal).toBe('SIGTERM');
    expect(result.ffmpegExitCode).toBe(255);
  });

  it('takes percent from the frame limit when no duration is known', async () => {
    scriptSpawn((call) =>
      isFfprobe(call)
        ? { exitCode: 1 }
        : { stdout: 'frame=25\nprogress=continue\nframe=50\nprogress=end\n' },
    );
    const { job, progress } = run(['-y', ...INPUT, '-frames:v', '50', '-c:v', 'mpeg4', 'out.mp4'], {
      probe: true,
    });
    const result = await job.done;
    expect(result.exitCode).toBe(0);
    expect(ffmpegCalls()).toHaveLength(1);
    const last = progress.at(-1)!;
    expect(last.totalSec).toBeUndefined();
    expect(last.percent).toBe(100);
  });

  it('keeps an auto log file only on failure', async () => {
    scriptSpawn(() => fromFixture('success'));
    const ok = await run(['-y', ...INPUT, '-c:v', 'mpeg4', 'out.mp4'], { logFile: 'auto' }).job
      .done;
    expect(ok.logFile).toBeUndefined();

    scriptSpawn(() => fromFixture('unknown-encoder'));
    const bad = await run(['-y', ...INPUT, '-c:v', 'libnope', 'out.mp4'], { logFile: 'auto' }).job
      .done;
    expect(bad.logFile).toBeDefined();
    expect(existsSync(bad.logFile!)).toBe(true);
    expect(bad.failure?.logFile).toBe(bad.logFile);
    rmSync(bad.logFile!, { force: true });
  });

  it('falls back to stats parsing when media goes to stdout', async () => {
    scriptSpawn(() => fromFixture('legacy-stats'));
    const { job, progress } = run(['-y', ...INPUT, '-f', 'null', '-']);
    let mode: string | undefined;
    job.on('start', (s) => (mode = s.mode));
    const result = await job.done;
    expect(mode).toBe('stats');
    expect(result.exitCode).toBe(0);
    expect(progress.length).toBeGreaterThan(0);
  });

  it('rejects when the binary cannot start', async () => {
    scriptSpawn(() => ({ startError: 'ENOENT' }));
    const job = runFfmpeg({ ffmpegPath: 'missing-ffmpeg', args: ['-version'] });
    await expect(job.done).rejects.toThrow(/could not start ffmpeg/);
  });
});
