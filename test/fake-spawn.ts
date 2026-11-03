import type { SpawnOptions } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { loadFixture } from './helpers.js';

export interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
}

/** What a fake process does once it starts. */
export interface FakeScript {
  stderr?: string;
  stdout?: string;
  /** Exit code after the output. Ignored when the process keeps running. */
  exitCode?: number;
  /** The process keeps running and handles what it reads from stdin. */
  onStdin?: (text: string, child: FakeChild) => void;
  /** The process keeps running until it's killed or its signal aborts. */
  hang?: boolean;
  /** The process fails to start, with this error code. */
  startError?: string;
}

export type SpawnHandler = (call: SpawnCall) => FakeScript;

/** Stands in for a ChildProcess: same streams, events and exit behavior. */
export class FakeChild extends EventEmitter {
  readonly stdin: PassThrough | null;
  readonly stdout: PassThrough | null;
  readonly stderr: PassThrough | null;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private exited = false;

  constructor(stdio: SpawnOptions['stdio']) {
    super();
    const piped = (fd: number) => {
      const mode: unknown = Array.isArray(stdio) ? stdio[fd] : stdio;
      return mode === undefined || mode === 'pipe' ? new PassThrough() : null;
    };
    this.stdin = piped(0);
    this.stdout = piped(1);
    this.stderr = piped(2);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.exit(null, signal);
    return true;
  }

  /** Ends the process: streams close first, then `close` fires. */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.signalCode = signal;
    this.stdin?.destroy();
    const outputs = [this.stdout, this.stderr].filter((s) => s !== null);
    const ended = outputs.map((s) => once(s, 'end'));
    for (const s of outputs) {
      s.end();
      s.resume();
    }
    void Promise.all(ended).then(() => this.emit('close', code, signal));
  }
}

let handler: SpawnHandler | undefined;
let unscripted: SpawnCall[] = [];

/** Every spawn the current test made, in order. */
export const spawnCalls: SpawnCall[] = [];

/** Sets what spawned processes do for the rest of the current test. */
export function scriptSpawn(next: SpawnHandler): void {
  handler = next;
}

/** Clears state between tests and returns the spawns no test scripted. */
export function resetFakeSpawn(): SpawnCall[] {
  const stray = unscripted;
  handler = undefined;
  unscripted = [];
  spawnCalls.length = 0;
  return stray;
}

function play(child: FakeChild, script: FakeScript): void {
  if (script.startError !== undefined) {
    const err: NodeJS.ErrnoException = new Error(`spawn ${script.startError}`);
    err.code = script.startError;
    child.emit('error', err);
    return;
  }
  // ffmpeg logs its header before it reports progress.
  if (script.stderr) child.stderr?.write(script.stderr);
  if (script.stdout) child.stdout?.write(script.stdout);
  if (script.onStdin) {
    const onStdin = script.onStdin;
    child.stdin?.setEncoding('utf8');
    child.stdin?.on('data', (text: string) => onStdin(text, child));
  } else if (!script.hang) {
    child.exit(script.exitCode ?? 0);
  }
}

/** Replaces `spawn` from node:child_process in every test (see test/setup.ts). */
export function fakeSpawn(command: string, args: string[], options: SpawnOptions = {}): FakeChild {
  const call: SpawnCall = { command, args: [...args], options };
  if (!handler) {
    unscripted.push(call);
    throw new Error(`unscripted spawn in a test: ${command} ${args.join(' ')}`);
  }
  spawnCalls.push(call);
  const script = handler(call);
  const child = new FakeChild(options.stdio);

  const signal = options.signal;
  const abort = () => {
    const err: NodeJS.ErrnoException = new Error('The operation was aborted');
    err.name = 'AbortError';
    err.code = 'ABORT_ERR';
    child.emit('error', err);
    child.exit(null, 'SIGTERM');
  };
  if (signal?.aborted) setImmediate(abort);
  else signal?.addEventListener('abort', abort, { once: true });

  // A real process starts after the caller has attached its listeners.
  setImmediate(() => play(child, script));
  return child;
}

/** A folder with empty ffmpeg and ffprobe files, so locating them works. Nothing runs them. */
export function fakeBin(): { dir: string; ffmpeg: string; ffprobe: string } {
  const dir = mkdtempSync(join(tmpdir(), 'treg-bin-'));
  const ffmpeg = join(dir, 'ffmpeg');
  const ffprobe = join(dir, 'ffprobe');
  writeFileSync(ffmpeg, '');
  writeFileSync(ffprobe, '');
  return { dir, ffmpeg, ffprobe };
}

export const isFfprobe = (call: SpawnCall): boolean => basename(call.command).startsWith('ffprobe');

/** The calls that ran ffmpeg, leaving out ffprobe. */
export const ffmpegCalls = (): SpawnCall[] => spawnCalls.filter((c) => !isFfprobe(c));

/** The output file of a call, with forward slashes. */
export const outputOf = (call: SpawnCall): string => call.args.at(-1)!.replace(/\\/g, '/');

/** Replays a run recorded from real ffmpeg, with its file names swapped for the test's. */
export function fromFixture(
  name: string,
  files: { input?: string; output?: string } = {},
): FakeScript {
  const { stderr, progress, meta } = loadFixture(name);
  return {
    stderr: stderr
      .replaceAll("'input.mp4'", `'${files.input ?? 'input.mp4'}'`)
      .replaceAll("'out.mp4'", `'${files.output ?? 'out.mp4'}'`),
    stdout: progress,
    exitCode: meta.exitCode,
  };
}

/** A recorded run that stops after its first progress block, until `q` ends it cleanly. */
export function runsUntilQuit(output = 'out.mp4'): FakeScript {
  const { stderr = '', stdout = '' } = fromFixture('success', { output });
  const firstBlock = /^[\s\S]*?progress=continue\r?\n/.exec(stdout);
  return {
    stderr: stderr.slice(0, stderr.indexOf('[out#0')),
    stdout: firstBlock?.[0] ?? '',
    onStdin: (text, child) => {
      if (text.includes('q')) child.exit(0);
    },
  };
}

/** The recorded overwrite prompt: stops at the question and acts on the answer. */
export function asksToOverwrite(): FakeScript {
  const { stderr = '' } = fromFixture('overwrite-prompt-no');
  const question = '[y/N] ';
  const cut = stderr.indexOf(question) + question.length;
  return {
    stderr: stderr.slice(0, cut),
    onStdin: (text, child) => {
      if (text.startsWith('y')) {
        child.exit(0);
      } else {
        child.stderr?.write(stderr.slice(cut));
        child.exit(1);
      }
    },
  };
}
