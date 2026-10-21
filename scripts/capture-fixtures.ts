/**
 * Records real ffmpeg output for parser and failure-report tests.
 *
 * Usage: pnpm tsx scripts/capture-fixtures.ts [ffmpegPath]
 *
 * Each case runs inside a temp work dir with relative paths, so no
 * machine-specific paths end up in the fixtures. Output per case:
 *   test/fixtures/<case>/stderr.txt    raw stderr bytes
 *   test/fixtures/<case>/progress.txt  raw stdout bytes (-progress pipe:1)
 *   test/fixtures/<case>/meta.json     args, exit code, ffmpeg version
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ffmpeg = process.argv[2] ?? 'ffmpeg';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = join(root, 'test', 'fixtures');

// What treg injects in progress mode.
const PROGRESS_FLAGS = [
  '-hide_banner',
  '-nostats',
  '-progress',
  'pipe:1',
  '-loglevel',
  'level+info',
];
// What treg injects in legacy (stdout output) mode.
const LEGACY_FLAGS = ['-hide_banner', '-loglevel', 'level+info'];

interface Case {
  name: string;
  args: string[];
  stdin?: string;
  discardStdout?: boolean;
}

const cases: Case[] = [
  {
    name: 'success',
    args: [...PROGRESS_FLAGS, '-y', '-i', 'input.mp4', '-c:v', 'mpeg4', '-c:a', 'aac', 'out.mp4'],
  },
  {
    name: 'codec-mismatch',
    args: [...PROGRESS_FLAGS, '-y', '-i', 'input.mp4', '-c:v', 'mjpeg', 'out.webm'],
  },
  { name: 'missing-input', args: [...PROGRESS_FLAGS, '-y', '-i', 'missing.mp4', 'out.mp4'] },
  {
    name: 'unknown-encoder',
    args: [...PROGRESS_FLAGS, '-y', '-i', 'input.mp4', '-c:v', 'libnope', 'out.mp4'],
  },
  {
    name: 'bad-option',
    args: [...PROGRESS_FLAGS, '-y', '-i', 'input.mp4', '-nosuchoption', '1', 'out.mp4'],
  },
  {
    name: 'bad-filter',
    args: [...PROGRESS_FLAGS, '-y', '-i', 'input.mp4', '-vf', 'nosuchfilter', 'out.mp4'],
  },
  { name: 'bad-map', args: [...PROGRESS_FLAGS, '-y', '-i', 'input.mp4', '-map', '0:s', 'out.mp4'] },
  {
    name: 'exists-no-overwrite',
    args: [...PROGRESS_FLAGS, '-n', '-i', 'input.mp4', 'existing.mp4'],
  },
  {
    name: 'overwrite-prompt-no',
    args: [...PROGRESS_FLAGS, '-i', 'input.mp4', 'existing.mp4'],
    stdin: 'n\n',
  },
  {
    name: 'legacy-stats',
    args: [...LEGACY_FLAGS, '-y', '-i', 'input.mp4', '-f', 'null', '-'],
    discardStdout: true,
  },
];

function run(args: string[], cwd: string, stdin?: string) {
  return spawnSync(ffmpeg, args, { cwd, input: stdin ?? '', maxBuffer: 64 * 1024 * 1024 });
}

const version = spawnSync(ffmpeg, ['-version']).stdout.toString().split(/\r?\n/)[0] ?? 'unknown';
const work = mkdtempSync(join(tmpdir(), 'treg-fixtures-'));

try {
  const gen = run(
    [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=5:size=320x240:rate=25',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=5',
      '-c:v',
      'mpeg4',
      '-c:a',
      'aac',
      '-shortest',
      'input.mp4',
    ],
    work,
  );
  if (gen.status !== 0) throw new Error(`could not generate input.mp4: ${gen.stderr.toString()}`);
  writeFileSync(join(work, 'existing.mp4'), '');

  for (const c of cases) {
    const result = run(c.args, work, c.stdin);
    const dir = join(fixturesDir, c.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stderr.txt'), result.stderr);
    writeFileSync(join(dir, 'progress.txt'), c.discardStdout ? '' : result.stdout);
    writeFileSync(
      join(dir, 'meta.json'),
      JSON.stringify(
        { args: c.args, stdin: c.stdin ?? null, exitCode: result.status, ffmpegVersion: version },
        null,
        2,
      ) + '\n',
    );
    console.log(`${c.name.padEnd(22)} exit=${result.status}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
