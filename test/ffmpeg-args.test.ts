import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeArgs, buildArgs, expectedDurationSec } from '../src/ffmpeg/analyze.js';
import { findExecutable, locateFfmpeg, locateFfprobe } from '../src/ffmpeg/locate.js';
import type { HeaderInfo } from '../src/types.js';

const header = (durationSec?: number): HeaderInfo => ({
  inputs: [
    {
      index: 0,
      format: 'mp4',
      path: 'a.mp4',
      streams: [],
      ...(durationSec ? { durationSec } : {}),
    },
  ],
  outputs: [],
  mapping: [],
});

describe('analyzeArgs', () => {
  it('finds inputs, outputs and value options', () => {
    const a = analyzeArgs(['-y', '-i', 'a.mp4', '-c:v', 'libx264', '-crf', '20', '-an', 'b.mkv']);
    expect(a.inputs).toEqual(['a.mp4']);
    expect(a.outputs).toEqual(['b.mkv']);
    expect(a.overwrite).toBe('yes');
    expect(a.infoQuery).toBe(false);
  });

  it('detects stdout output and stdin input', () => {
    expect(analyzeArgs(['-i', 'a.mp4', '-f', 'mp4', '-']).outputToStdout).toBe(true);
    expect(analyzeArgs(['-i', 'a.mp4', '-f', 'mp4', 'pipe:1']).outputToStdout).toBe(true);
    expect(analyzeArgs(['-i', 'pipe:0', 'out.mp4']).inputFromStdin).toBe(true);
  });

  it('detects info queries', () => {
    expect(analyzeArgs(['-version']).infoQuery).toBe(true);
    expect(analyzeArgs(['-h', 'encoder=libx264']).infoQuery).toBe(true);
  });

  it('records loglevel position and time limits', () => {
    const a = analyzeArgs([
      '-v',
      'warning',
      '-ss',
      '10',
      '-i',
      'a.mp4',
      '-t',
      '00:00:30',
      '-frames:v',
      '99',
      'o.mp4',
    ]);
    expect(a.loglevel).toEqual({ index: 1, value: 'warning' });
    expect(a.startSec).toBe(10);
    expect(a.limitSec).toBe(30);
    expect(a.frameLimit).toBe(99);
  });
});

describe('expectedDurationSec', () => {
  it('uses input duration minus seek, capped by -t / -to', () => {
    expect(expectedDurationSec(analyzeArgs(['-i', 'a', 'o']), header(60))).toBe(60);
    expect(expectedDurationSec(analyzeArgs(['-ss', '10', '-i', 'a', 'o']), header(60))).toBe(50);
    expect(expectedDurationSec(analyzeArgs(['-i', 'a', '-t', '5', 'o']), header(60))).toBe(5);
    expect(
      expectedDurationSec(analyzeArgs(['-ss', '10', '-i', 'a', '-to', '25', 'o']), header(60)),
    ).toBe(15);
    expect(expectedDurationSec(analyzeArgs(['-i', 'a', '-t', '5', 'o']), header())).toBe(5);
    expect(expectedDurationSec(analyzeArgs(['-i', 'a', 'o']), header())).toBeUndefined();
  });
});

describe('buildArgs', () => {
  it('injects progress, stats and log flags in progress mode', () => {
    const user = ['-y', '-i', 'a.mp4', 'b.mp4'];
    const r = buildArgs(user, analyzeArgs(user), { interactive: true });
    expect(r.mode).toBe('progress');
    expect(r.args).toEqual([
      '-hide_banner',
      '-progress',
      'pipe:1',
      '-nostats',
      '-loglevel',
      'level+info',
      ...user,
    ]);
  });

  it('keeps the user loglevel and adds the level flag', () => {
    const user = ['-loglevel', 'warning', '-i', 'a', 'b'];
    const r = buildArgs(user, analyzeArgs(user), { interactive: true });
    expect(r.args.slice(-5)).toEqual(['-loglevel', 'level+warning', '-i', 'a', 'b']);
    expect(r.args.filter((x) => x === '-loglevel')).toHaveLength(1);
  });

  it('flags a loglevel that hides errors', () => {
    const user = ['-v', 'quiet', '-i', 'a', 'b'];
    expect(buildArgs(user, analyzeArgs(user), { interactive: true }).errorsSuppressed).toBe(true);
  });

  it('falls back to stats mode when stdout carries media', () => {
    const user = ['-i', 'a', '-f', 'mp4', '-'];
    const r = buildArgs(user, analyzeArgs(user), { interactive: true });
    expect(r.mode).toBe('stats');
    expect(r.args).not.toContain('-progress');
    expect(r.args).not.toContain('-nostats');
  });

  it('adds -n when nobody can answer the overwrite prompt', () => {
    const user = ['-i', 'a', 'b'];
    expect(buildArgs(user, analyzeArgs(user), { interactive: false }).args).toContain('-n');
    expect(buildArgs(user, analyzeArgs(user), { interactive: true }).args).not.toContain('-n');
    const yes = ['-y', ...user];
    expect(buildArgs(yes, analyzeArgs(yes), { interactive: false }).args).not.toContain('-n');
  });
});

describe('locate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'treg-locate-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'ffmpeg.exe'), '');
  writeFileSync(join(bin, 'ffprobe.exe'), '');
  const win = { env: { PATH: bin, PATHEXT: '.EXE;.CMD' }, platform: 'win32' as const };

  it('searches PATH with PATHEXT on Windows', () => {
    expect(findExecutable('ffmpeg', win)?.toLowerCase()).toBe(
      join(bin, 'ffmpeg.exe').toLowerCase(),
    );
  });

  it('accepts an explicit path without extension', () => {
    expect(locateFfmpeg(join(bin, 'ffmpeg'), win).toLowerCase()).toBe(
      join(bin, 'ffmpeg.exe').toLowerCase(),
    );
  });

  it('finds ffprobe next to ffmpeg', () => {
    expect(locateFfprobe(join(bin, 'ffmpeg.exe'), win)?.toLowerCase()).toBe(
      join(bin, 'ffprobe.exe').toLowerCase(),
    );
  });

  it('throws a helpful error when missing', () => {
    expect(() => locateFfmpeg('nope-ffmpeg', { env: { PATH: dir }, platform: 'linux' })).toThrow(
      /ffmpeg not found.*ffmpegPath/,
    );
  });
});
