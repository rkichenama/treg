import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { TregError } from '../errors.js';
import { analyzeArgs } from '../ffmpeg/analyze.js';
import { locateFfmpeg } from '../ffmpeg/locate.js';
import { runFfmpeg, type PromptInfo } from '../ffmpeg/run.js';
import { createRenderer, resolveFormat } from '../render/index.js';
import { createStyle, shouldColor, type Output } from '../render/style.js';
import { VERSION } from '../version.js';
import { OPTION_FLAG, rejoinColonSplits, splitArgs } from './args.js';
import { loadOptions } from './options.js';

export interface CliIO {
  stdout: Output;
  stderr: Output;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  env: NodeJS.ProcessEnv;
  cwd: string;
}

const defaultIO = (): CliIO => ({
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  env: process.env,
  cwd: process.cwd(),
});

export const USAGE = `treg ${VERSION} - ffmpeg with a progress bar and readable errors

Usage: treg [${OPTION_FLAG} <options.json>] <ffmpeg arguments>

  treg -i input.mov -c:v libx264 output.mp4
  treg ${OPTION_FLAG} treg.json -i input.mov output.webm

Every argument except ${OPTION_FLAG} goes to ffmpeg unchanged.
The options file is JSON; missing keys use defaults (see README).
ffmpeg's own help: treg -h
`;

/** Runs treg and returns the process exit code (ffmpeg's, when it ran). */
export async function main(argv: readonly string[], io: CliIO = defaultIO()): Promise<number> {
  try {
    return await run(argv, io);
  } catch (err) {
    if (err instanceof TregError) {
      io.stderr.write(`treg: ${err.message.replace(/\n/g, '\ntreg: ')}\n`);
      return err.exitCode;
    }
    io.stderr.write(`treg: unexpected error: ${(err as Error).stack ?? String(err)}\n`);
    return 1;
  }
}

async function run(argv: readonly string[], io: CliIO): Promise<number> {
  const { optionsPath, ffmpegArgs } = splitArgs(rejoinColonSplits(argv));
  if (ffmpegArgs.length === 0) {
    io.stderr.write(USAGE);
    return 1;
  }

  const { options, warnings } = loadOptions(optionsPath && resolve(io.cwd, optionsPath));
  for (const w of warnings) io.stderr.write(`treg: warning: ${w}\n`);

  const ffmpegPath = locateFfmpeg(options.ffmpegPath, { env: io.env, cwd: io.cwd });
  const analysis = analyzeArgs(ffmpegArgs);

  // Nothing to show progress for: hand the terminal to ffmpeg.
  if (options.format === 'raw' || analysis.infoQuery || analysis.outputs.length === 0) {
    return passthrough(ffmpegPath, ffmpegArgs, io);
  }

  const format = resolveFormat(options.format, io.stderr);

  const style = createStyle(shouldColor(options.color, io.stderr, io.env));
  // JSON goes to stdout unless ffmpeg is writing media there.
  const jsonOut = analysis.outputToStdout ? io.stderr : io.stdout;
  const renderer = createRenderer(format, { options, out: io.stderr, style }, jsonOut);
  const interactive = Boolean(io.stdin.isTTY) && !analysis.inputFromStdin;

  const job = runFfmpeg({
    ffmpegPath,
    args: ffmpegArgs,
    interactive,
    onPrompt: (p) => ask(p, io),
    logFile:
      options.logFile && options.logFile !== 'auto'
        ? resolve(io.cwd, options.logFile)
        : options.logFile,
    probe: options.probe,
    cwd: io.cwd,
    env: io.env,
  });
  job.on('start', (s) => renderer.start(s));
  job.on('header', (h) => renderer.header(h));
  job.on('progress', (p) => renderer.progress(p));
  job.on('log', (l) => renderer.log(l));
  job.on('prompt', (p) => renderer.prompt(p));
  job.on('end', (r) => renderer.end(r));

  // Ctrl+C: first asks ffmpeg to stop cleanly, second kills it.
  const onSigint = () => job.cancel();
  process.on('SIGINT', onSigint);
  try {
    const result = await job.done;
    return result.exitCode;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

async function ask(prompt: PromptInfo, io: CliIO): Promise<boolean> {
  const rl = createInterface({
    input: io.stdin,
    output: io.stderr as NodeJS.WritableStream,
    terminal: false,
  });
  try {
    const answer = await rl.question(prompt.text);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** Runs ffmpeg with the user's args and the terminal attached, unchanged. */
function passthrough(ffmpegPath: string, args: readonly string[], io: CliIO): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: 'inherit', cwd: io.cwd, env: io.env });
    // ffmpeg handles Ctrl+C itself; keep treg alive until it exits.
    const ignore = () => undefined;
    process.on('SIGINT', ignore);
    child.on('error', (err) => {
      process.off('SIGINT', ignore);
      reject(new TregError(`could not start ffmpeg (${ffmpegPath}): ${err.message}`, 127));
    });
    child.on('close', (code, signal) => {
      process.off('SIGINT', ignore);
      resolvePromise(code ?? (signal ? 255 : 1));
    });
  });
}
