import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { expandInputs } from '../batch/inputs.js';
import { fillOutputTemplate, planBatch, type BatchJob } from '../batch/plan.js';
import { batchExitCode, summarizeBatch } from '../batch/summary.js';
import { TregError } from '../errors.js';
import { analyzeArgs } from '../ffmpeg/analyze.js';
import { locateFfmpeg } from '../ffmpeg/locate.js';
import { runFfmpeg, type FfmpegRun, type PromptInfo, type RunResult } from '../ffmpeg/run.js';
import { formatBatchSummary, formatJobLabel } from '../report/format.js';
import {
  createRenderer,
  resolveFormat,
  type RenderFormat,
  type Renderer,
} from '../render/index.js';
import { createStyle, shouldColor, type Output, type Style } from '../render/style.js';
import { VERSION } from '../version.js';
import { OPTION_FLAG, rejoinColonSplits, splitArgs } from './args.js';
import { loadOptions, type TregOptions } from './options.js';

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

  if (analysis.infoQuery) return passthrough(ffmpegPath, ffmpegArgs, io);
  if (options.inputs.length > 0) return runBatch(ffmpegPath, ffmpegArgs, options, io);

  // Nothing to show progress for: hand the terminal to ffmpeg.
  if (options.format === 'raw' || analysis.outputs.length === 0) {
    return passthrough(ffmpegPath, ffmpegArgs, io);
  }

  const ui = createUi(options, io, analysis.outputToStdout);
  const job = startJob(ffmpegPath, ffmpegArgs, options.logFile, options, io, ui.renderer());
  const result = await withSigint(() => job.cancel(), job.done);
  return result.exitCode;
}

interface Ui {
  format: RenderFormat;
  style: Style;
  jsonOut: Output;
  renderer(jsonExtra?: Record<string, unknown>): Renderer;
}

function createUi(options: TregOptions, io: CliIO, mediaOnStdout: boolean): Ui {
  const format = resolveFormat(options.format === 'raw' ? 'auto' : options.format, io.stderr);
  const style = createStyle(shouldColor(options.color, io.stderr, io.env));
  // JSON goes to stdout unless ffmpeg is writing media there.
  const jsonOut = mediaOnStdout ? io.stderr : io.stdout;
  return {
    format,
    style,
    jsonOut,
    renderer: (jsonExtra) =>
      createRenderer(format, { options, out: io.stderr, style }, jsonOut, jsonExtra),
  };
}

/** Starts one ffmpeg run with its output going to `renderer`. */
function startJob(
  ffmpegPath: string,
  args: readonly string[],
  logFile: string | null,
  options: TregOptions,
  io: CliIO,
  renderer: Renderer,
): FfmpegRun {
  const job = runFfmpeg({
    ffmpegPath,
    args,
    interactive: Boolean(io.stdin.isTTY) && !analyzeArgs(args).inputFromStdin,
    onPrompt: (p) => ask(p, io),
    logFile: logFile && logFile !== 'auto' ? resolve(io.cwd, logFile) : logFile,
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
  return job;
}

/** Ctrl+C calls `onCancel` while `work` runs (first press: clean stop, second: kill). */
async function withSigint<T>(onCancel: () => void, work: Promise<T>): Promise<T> {
  process.on('SIGINT', onCancel);
  try {
    return await work;
  } finally {
    process.off('SIGINT', onCancel);
  }
}

/** Runs ffmpeg once per file from the `inputs` option. */
async function runBatch(
  ffmpegPath: string,
  userArgs: readonly string[],
  options: TregOptions,
  io: CliIO,
): Promise<number> {
  const inputs = expandInputs(options.inputs, io.cwd);
  const jobs = planBatch(inputs, userArgs, io.cwd);
  const total = jobs.length;
  const logFileFor = (job: BatchJob) =>
    options.logFile && options.logFile !== 'auto'
      ? fillOutputTemplate(options.logFile, job.input, job.index, total)
      : options.logFile;

  if (options.format === 'raw') {
    let code = 0;
    for (const job of jobs) {
      const exit = await passthrough(ffmpegPath, job.args, io);
      if (code === 0) code = exit;
    }
    return code;
  }

  const ui = createUi(options, io, analyzeArgs(userArgs).outputToStdout);
  const text = ui.format === 'bar' || ui.format === 'line';
  if (ui.format === 'json') {
    writeJson(ui.jsonOut, {
      type: 'batch',
      jobs: jobs.map(({ index, input, outputs }) => ({ index, input, outputs })),
    });
  }

  const results: RunResult[] = [];
  let current: FfmpegRun | undefined;
  let stopped = false;
  const onCancel = () => {
    stopped = true;
    current?.cancel();
  };

  await withSigint(
    onCancel,
    (async () => {
      for (const job of jobs) {
        if (stopped) break;
        if (text) io.stderr.write(formatJobLabel(job, total, ui.style) + '\n');
        current = startJob(
          ffmpegPath,
          job.args,
          logFileFor(job),
          options,
          io,
          ui.renderer({ job: job.index }),
        );
        const result = await current.done;
        results.push(result);
        if (result.cancelled) break;
      }
    })(),
  );

  const summary = summarizeBatch(jobs, results);
  if (ui.format === 'json') {
    writeJson(ui.jsonOut, { type: 'summary', ...summary });
  } else if (text || summary.failed + summary.cancelled > 0) {
    io.stderr.write(formatBatchSummary(summary, ui.style).join('\n') + '\n');
  }
  return batchExitCode(summary);
}

function writeJson(out: Output, event: Record<string, unknown>): void {
  out.write(JSON.stringify(event) + '\n');
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
