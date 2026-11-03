import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { main, type CliIO } from '../src/cli/main.js';
import {
  fakeBin,
  fromFixture,
  outputOf,
  runsUntilQuit,
  scriptSpawn,
  spawnCalls,
  type SpawnCall,
} from './fake-spawn.js';

const bin = fakeBin();
const work = mkdtempSync(join(tmpdir(), 'treg-cli-'));
const INPUT = ['-i', 'input.mp4'];

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
    env: { ...process.env, NO_COLOR: '1', PATH: bin.dir },
    cwd: work,
    out,
    err,
  };
}

/** Runs `fn` once, the first time `sink` has written text matching `pattern`. */
function onText(sink: Sink, pattern: RegExp, fn: () => void): void {
  const write = sink.write.bind(sink);
  let fired = false;
  sink.write = (s: string) => {
    const ok = write(s);
    if (!fired && pattern.test(sink.text)) {
      fired = true;
      fn();
    }
    return ok;
  };
}

function options(name: string, value: unknown): string {
  const file = join(work, name);
  writeFileSync(file, JSON.stringify(value));
  return file;
}

const outputs = () => spawnCalls.map(outputOf);

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

  it('emits NDJSON with format json', async () => {
    scriptSpawn(() => fromFixture('success'));
    const t = io();
    const file = options('json.json', { format: 'json' });
    const code = await main(['--treg-option', file, '-y', ...INPUT, '-c:v', 'mpeg4', 'out.mp4'], t);
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
    scriptSpawn(() => fromFixture('codec-mismatch'));
    const t = io();
    const code = await main(['-y', ...INPUT, '-c:v', 'mjpeg', 'out.webm'], t);
    expect(code).not.toBe(0);
    expect(t.err.text).toContain('✖ ffmpeg failed');
    expect(t.err.text).toContain('webm:');
    expect(t.err.text).toContain('Only VP8 or VP9');
    expect(t.err.text).not.toContain('Input #0');
    expect(t.err.text).not.toContain('Press [q]');
  });

  it('prints and returns a negative exit code as signed', async () => {
    scriptSpawn(() => ({ stderr: '[fatal] It broke\n', exitCode: 4294967274 }));
    const t = io();
    expect(await main([...INPUT, 'out.mp4'], t)).toBe(-22);
    expect(t.err.text).toContain('✖ ffmpeg failed (exit -22)');
  });

  it('returns a signed exit code from format raw', async () => {
    scriptSpawn(() => ({ exitCode: 4294967274 }));
    const file = options('raw-signed.json', { format: 'raw' });
    expect(await main(['--treg-option', file, ...INPUT, 'out.mp4'], io())).toBe(-22);
  });

  it('prints line progress and a summary when not on a terminal', async () => {
    scriptSpawn(() => fromFixture('success', { output: 'line.mp4' }));
    const t = io();
    const code = await main(['-y', ...INPUT, '-c:v', 'mpeg4', 'line.mp4'], t);
    expect(code).toBe(0);
    expect(t.err.text).toMatch(/line\.mp4 \[\s*\d+%\]/);
    expect(t.err.text).toMatch(/✔ done in \d+:\d\d → line\.mp4/);
  });

  it('hands an info query to ffmpeg untouched, even when outputs are named', async () => {
    scriptSpawn(() => ({ exitCode: 0 }));
    const t = io();
    const args = ['-hide_banner', '-loglevel', 'error', '-version', '-i', 'missing.mp4', 'n.mp4'];
    expect(await main(args, t)).toBe(0);
    expect(t.err.text).toBe('');
    expect(spawnCalls[0]?.args).toEqual(args);
    expect(spawnCalls[0]?.options.stdio).toBe('inherit');
  });

  it('hands a command with no output file to ffmpeg, which reports the mistake', async () => {
    scriptSpawn(() => ({ exitCode: 1 }));
    const t = io();
    const args = ['-hide_banner', '-loglevel', 'error', ...INPUT];
    expect(await main(args, t)).toBe(1);
    expect(t.err.text).toBe('');
    expect(spawnCalls[0]?.args).toEqual(args);
  });

  it('format raw runs ffmpeg with no treg progress or summary', async () => {
    scriptSpawn(() => fromFixture('success'));
    const t = io();
    const file = options('raw.json', { format: 'raw' });
    const args = ['-y', '-hide_banner', '-loglevel', 'error', ...INPUT, '-c:v', 'mpeg4', 'raw.mp4'];
    const code = await main(['--treg-option', file, ...args], t);
    expect(code).toBe(0);
    expect(spawnCalls[0]?.args).toEqual(args);
    expect(spawnCalls[0]?.options.stdio).toBe('inherit');
    expect(t.err.text).toBe('');
  });

  it('Ctrl+C stops the run, finishes the file, and reports it cancelled', async () => {
    scriptSpawn(() => runsUntilQuit('ctrl-c.mp4'));
    const t = io();
    onText(t.err, /ctrl-c\.mp4 \[\s*\d+%\]/, () => process.emit('SIGINT'));
    const code = await main(['-y', ...INPUT, '-c:v', 'mpeg4', 'ctrl-c.mp4'], t);
    expect(t.err.text).toContain('■ cancelled');
    expect(t.err.text).not.toContain('✖ ffmpeg failed');
    expect(code).toBe(0);
  });

  it('refuses to overwrite without a terminal and says why', async () => {
    scriptSpawn(() => fromFixture('exists-no-overwrite'));
    const t = io();
    const code = await main([...INPUT, 'existing.mp4'], t);
    expect(code).not.toBe(0);
    expect(spawnCalls[0]?.args).toContain('-n');
    expect(t.err.text).toContain("File 'existing.mp4' already exists. Exiting.");
  });
});

describe('main batch', () => {
  mkdirSync(join(work, 'batch'), { recursive: true });
  for (const name of ['take1', 'take2', 'take10', 'broken']) {
    writeFileSync(join(work, 'batch', `${name}.mp4`), '');
  }

  /** Each file converts, except broken.mp4, which ffmpeg can't open. */
  const converts = (call: SpawnCall) =>
    call.args.some((a) => a.includes('broken'))
      ? fromFixture('missing-input')
      : fromFixture('success', { output: outputOf(call) });

  it('converts each file, keeps going after a failure, and summarizes', async () => {
    scriptSpawn(converts);
    const t = io();
    const file = options('batch.json', { inputs: ['batch/*.mp4'] });
    const code = await main(
      ['--treg-option', file, '-y', '-c:v', 'mpeg4', '{dir}/{name}-out.mkv'],
      t,
    );
    expect(code).not.toBe(0);
    // Natural order: broken, take1, take2, take10.
    expect(outputs()).toEqual([
      'batch/broken-out.mkv',
      'batch/take1-out.mkv',
      'batch/take2-out.mkv',
      'batch/take10-out.mkv',
    ]);
    const err = t.err.text.replace(/\\/g, '/');
    expect(err).toMatch(
      /\[1\/4\] batch\/broken\.mp4[\s\S]*\[2\/4\] batch\/take1\.mp4[\s\S]*\[4\/4\] batch\/take10\.mp4/,
    );
    expect(err).toContain('batch: 4 files, 3 done, 1 failed');
    expect(err).toMatch(/✖ batch\/broken\.mp4: .+/);
  });

  it('tags JSON events with the job and ends with a summary', async () => {
    scriptSpawn(converts);
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

  it('format raw runs every file through ffmpeg, keeps going, and returns the first failure', async () => {
    scriptSpawn((call) => ({ exitCode: call.args.some((a) => a.includes('broken')) ? 3 : 0 }));
    const t = io();
    const file = options('batch-raw.json', {
      format: 'raw',
      inputs: ['batch/broken.mp4', 'batch/take1.mp4'],
    });
    const code = await main(
      [
        '--treg-option',
        file,
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-c:v',
        'mpeg4',
        '{dir}/{name}-raw.mkv',
      ],
      t,
    );
    // broken.mp4 is first and fails; take1 succeeds and must not replace that code.
    expect(code).toBe(3);
    expect(outputs()).toEqual(['batch/broken-raw.mkv', 'batch/take1-raw.mkv']);
    expect(t.err.text).toBe('');
  });

  it('writes each file log to the logFile template', async () => {
    scriptSpawn(converts);
    const t = io();
    mkdirSync(join(work, 'logs'), { recursive: true });
    const file = options('batch-log.json', {
      logFile: 'logs/{name}.log',
      inputs: ['batch/take1.mp4', 'batch/take2.mp4'],
    });
    const code = await main(
      ['--treg-option', file, '-y', '-c:v', 'mpeg4', '{dir}/{name}-logged.mkv'],
      t,
    );
    expect(code).toBe(0);
    for (const name of ['take1', 'take2']) {
      const log = readFileSync(join(work, 'logs', `${name}.log`), 'utf8');
      expect(log).toContain(`${name}-logged.mkv`);
    }
  });

  it('format quiet prints nothing when every file succeeds', async () => {
    scriptSpawn(converts);
    const t = io();
    const file = options('batch-quiet.json', {
      format: 'quiet',
      inputs: ['batch/take1.mp4', 'batch/take2.mp4'],
    });
    const code = await main(
      ['--treg-option', file, '-y', '-c:v', 'mpeg4', '{dir}/{name}-quiet.mkv'],
      t,
    );
    expect(code).toBe(0);
    expect(t.err.text).toBe('');
    expect(t.out.text).toBe('');
  });

  it('format quiet skips file labels but still ends with the summary when a file fails', async () => {
    scriptSpawn(converts);
    const t = io();
    const file = options('batch-quiet-fail.json', {
      format: 'quiet',
      inputs: ['batch/broken.mp4', 'batch/take1.mp4'],
    });
    const code = await main(
      ['--treg-option', file, '-y', '-c:v', 'mpeg4', '{dir}/{name}-quiet-fail.mkv'],
      t,
    );
    expect(code).not.toBe(0);
    expect(t.err.text).not.toContain('[1/2]');
    expect(t.err.text).toMatch(/batch: 2 files, 1 done, 1 failed\n {2}✖ batch\/broken\.mp4: .+\n$/);
  });

  it('Ctrl+C cancels the running file and skips the rest of the batch', async () => {
    scriptSpawn((call) => runsUntilQuit(outputOf(call)));
    const t = io();
    const file = options('batch-sigint.json', { inputs: ['batch/take1.mp4', 'batch/take2.mp4'] });
    onText(t.err, /\[\s*\d+%\]/, () => process.emit('SIGINT'));
    const code = await main(['--treg-option', file, '-c:v', 'mpeg4', '{dir}/{name}-cut.mkv'], t);
    expect(code).toBe(0);
    expect(t.err.text).toContain('batch: 2 files, 0 done, 1 cancelled, 1 skipped');
    expect(outputs()).toEqual(['batch/take1-cut.mkv']);
  });

  it('skips the rest of the batch when ffmpeg alone reports a received signal', async () => {
    scriptSpawn(() => ({ stderr: '[info] Exiting normally, received signal 2.\n', exitCode: 255 }));
    const t = io();
    const file = options('batch-signal.json', { inputs: ['batch/take1.mp4', 'batch/take2.mp4'] });
    const code = await main(['--treg-option', file, '-c:v', 'mpeg4', '{dir}/{name}-signal.mkv'], t);
    // A batch returns the cancelled file's own exit code.
    expect(code).toBe(255);
    expect(t.err.text).toContain('batch: 2 files, 0 done, 1 cancelled, 1 skipped');
    expect(outputs()).toEqual(['batch/take1-signal.mkv']);
  });

  it('Ctrl+C between files starts no further file', async () => {
    scriptSpawn(converts);
    const t = io();
    const file = options('batch-between.json', {
      inputs: ['batch/take1.mp4', 'batch/take2.mp4'],
    });
    // The first file's summary prints after ffmpeg exits, before the next file starts.
    onText(t.err, /✔ done/, () => process.emit('SIGINT'));
    const code = await main(
      ['--treg-option', file, '-y', '-c:v', 'mpeg4', '{dir}/{name}-between.mkv'],
      t,
    );
    expect(code).toBe(0);
    expect(t.err.text).toContain('batch: 2 files, 1 done, 1 skipped');
    expect(outputs()).toEqual(['batch/take1-between.mkv']);
  });

  it('refuses -i on the command line while inputs is set', async () => {
    const t = io();
    const file = options('batch-i.json', { inputs: ['batch/take1.mp4'] });
    expect(await main(['--treg-option', file, '-i', 'x.mp4', 'o.mkv'], t)).toBe(2);
    expect(t.err.text).toContain('replaces -i');
  });
});
