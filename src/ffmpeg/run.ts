import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createWriteStream, rmSync, type WriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TregError } from '../errors.js';
import { ProgressParser } from '../parse/progress.js';
import { StderrParser, type StderrEvent } from '../parse/stderr.js';
import { LogCollector } from '../report/collect.js';
import { buildFailureReport, effectiveExitCode, type FailureReport } from '../report/failure.js';
import type { HeaderInfo, LogEntry, ProgressUpdate } from '../types.js';
import {
  analyzeArgs,
  buildArgs,
  expectedDurationSec,
  type ArgAnalysis,
  type ProgressMode,
} from './analyze.js';
import { locateFfprobe } from './locate.js';
import { probeDuration } from './probe.js';

export interface RunOptions {
  /** Resolved path to the ffmpeg binary. */
  ffmpegPath: string;
  /** The user's ffmpeg arguments; treg adds its own flags. */
  args: readonly string[];
  /** Whether someone can answer the overwrite prompt. Default: stdin is a TTY. */
  interactive?: boolean;
  /** Answers ffmpeg's overwrite prompt. Default: no. */
  onPrompt?: (prompt: PromptInfo) => Promise<boolean> | boolean;
  /** null: none; "auto": temp file kept only on failure; or a path. */
  logFile?: string | null;
  /** Run ffprobe when ffmpeg reports no duration. */
  probe?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface PromptInfo {
  file: string;
  text: string;
}

export interface StartInfo {
  ffmpegPath: string;
  /** Final argument list, including treg's flags. */
  args: string[];
  mode: ProgressMode;
  analysis: ArgAnalysis;
}

/** A progress sample plus what treg derives from it. */
export interface ProgressSnapshot extends ProgressUpdate {
  totalSec?: number;
  /** 0-100, when the total is known. */
  percent?: number;
  etaSec?: number;
  elapsedSec: number;
}

export interface RunResult {
  /**
   * ffmpeg's exit code (255 when it died from a signal), except 1 when ffmpeg
   * exited 0 after a fatal error (see effectiveExitCode).
   */
  exitCode: number;
  /** ffmpeg's actual exit code. */
  ffmpegExitCode: number;
  signal?: NodeJS.Signals;
  /** Stopped by cancel() or Ctrl+C. */
  cancelled: boolean;
  elapsedSec: number;
  header: HeaderInfo;
  lastProgress?: ProgressSnapshot;
  /** Present when ffmpeg failed and was not cancelled. */
  failure?: FailureReport;
  /** Errors ffmpeg logged even when it succeeded. */
  errorCount: number;
  warningCount: number;
  /** Kept log file, if any. */
  logFile?: string;
}

export interface RunEvents {
  start: [StartInfo];
  header: [HeaderInfo];
  progress: [ProgressSnapshot];
  log: [LogEntry];
  prompt: [PromptInfo];
  end: [RunResult];
}

const CANCEL_NOTICE = /^Exiting normally, received signal/;

/**
 * One ffmpeg run. Listen to events for live output and await `done` for the
 * result. `done` rejects only when ffmpeg can't be started.
 */
export class FfmpegRun extends EventEmitter<RunEvents> {
  readonly done: Promise<RunResult>;
  private child: ChildProcess | undefined;
  private cancelRequests = 0;
  private cancelled = false;

  constructor(private readonly opts: RunOptions) {
    super();
    this.done = this.run();
    // Avoid unhandled rejections when the caller only uses events.
    this.done.catch(() => undefined);
  }

  /** First call asks ffmpeg to finish cleanly (like pressing q); second kills it. */
  /* istanbul ignore next -- @preserve */
  cancel(): void {
    this.cancelled = true;
    this.cancelRequests++;
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    if (this.cancelRequests === 1 && child.stdin?.writable) {
      child.stdin.write('q');
    } else {
      child.kill();
    }
  }

  private async run(): Promise<RunResult> {
    // Let the caller attach listeners before the first event.
    await Promise.resolve();
    const opts = this.opts;
    const analysis = analyzeArgs(opts.args);
    const interactive = opts.interactive ?? Boolean(process.stdin.isTTY);
    const built = buildArgs(opts.args, analysis, { interactive });

    let probed: number | undefined;
    const firstInput = analysis.inputs[0];
    if (opts.probe && firstInput && !analysis.inputFromStdin) {
      const ffprobe = locateFfprobe(opts.ffmpegPath, { env: opts.env ?? process.env });
      if (ffprobe) probed = await probeDuration(ffprobe, firstInput);
    }

    const { logPath, logStream } = openLog(opts.logFile);
    const started = Date.now();
    const elapsed = () => (Date.now() - started) / 1000;

    const stderr = new StderrParser();
    const progress = new ProgressParser();
    const collector = new LogCollector();
    let lastProgress: ProgressSnapshot | undefined;
    let headerSent = false;

    const sendHeader = () => {
      if (headerSent) return;
      headerSent = true;
      this.emit('header', stderr.header.info);
    };

    const onUpdate = (update: ProgressUpdate) => {
      sendHeader();
      const totalSec = expectedDurationSec(analysis, stderr.header.info) ?? probed;
      const snap: ProgressSnapshot = { ...update, elapsedSec: elapsed() };
      if (totalSec !== undefined) {
        snap.totalSec = totalSec;
        if (update.timeSec !== undefined) {
          snap.percent = Math.min(100, Math.max(0, (update.timeSec / totalSec) * 100));
          if (update.speed && update.speed > 0) {
            snap.etaSec = Math.max(0, (totalSec - update.timeSec) / update.speed);
          }
        }
      } else if (analysis.frameLimit && update.frame !== undefined) {
        snap.percent = Math.min(100, (update.frame / analysis.frameLimit) * 100);
      }
      lastProgress = snap;
      this.emit('progress', snap);
    };

    const onStderr = (event: StderrEvent) => {
      if (event.type === 'stats') {
        onUpdate(event.update);
      } else if (event.type === 'prompt') {
        void this.answerPrompt({ file: event.file, text: event.text });
      } else {
        if (CANCEL_NOTICE.test(event.entry.message)) this.cancelled = true;
        collector.add(event.entry);
        this.emit('log', event.entry);
      }
    };

    const child = spawn(opts.ffmpegPath, built.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: [
        analysis.inputFromStdin ? 'inherit' : 'pipe',
        built.mode === 'stats' && analysis.outputToStdout ? 'inherit' : 'pipe',
        'pipe',
      ],
      windowsHide: true,
    });
    this.child = child;
    // ffmpeg may exit before reading what we write (q, prompt answer).
    child.stdin?.on('error', () => undefined);

    this.emit('start', {
      ffmpegPath: opts.ffmpegPath,
      args: built.args,
      mode: built.mode,
      analysis,
    });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (built.mode === 'progress') progress.push(chunk).forEach(onUpdate);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      logStream?.write(chunk);
      stderr.push(chunk).forEach(onStderr);
    });

    const { code, signal } = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.on('error', (err) => {
        reject(new TregError(`could not start ffmpeg (${opts.ffmpegPath}): ${err.message}`, 127));
      });
      child.on('close', (code, signal) => resolve({ code, signal }));
    }).finally(() => logStream?.end());

    progress.flush().forEach(onUpdate);
    stderr.flush().forEach(onStderr);
    sendHeader();
    if (logStream && !logStream.closed) await once(logStream, 'close');

    const ffmpegExitCode = code ?? (signal ? 255 : 1);
    const exitCode = effectiveExitCode(ffmpegExitCode, collector);
    const failed = exitCode !== 0 && !this.cancelled;
    let keptLog = logPath;
    if (logPath && opts.logFile === 'auto' && !failed) {
      rmSync(logPath, { force: true });
      keptLog = undefined;
    }

    const result: RunResult = {
      exitCode,
      ffmpegExitCode,
      cancelled: this.cancelled,
      elapsedSec: elapsed(),
      header: stderr.header.info,
      errorCount: collector.errors.length,
      warningCount: collector.warnings.length,
    };
    if (signal) result.signal = signal;
    if (lastProgress) result.lastProgress = lastProgress;
    if (keptLog) result.logFile = keptLog;
    if (failed) {
      result.failure = buildFailureReport({
        exitCode,
        ffmpegExitCode,
        collector,
        header: stderr.header.info,
        errorsSuppressed: built.errorsSuppressed,
        ...(keptLog ? { logFile: keptLog } : {}),
      });
    }
    this.emit('end', result);
    return result;
  }

  /* istanbul ignore next -- @preserve */
  private async answerPrompt(prompt: PromptInfo): Promise<void> {
    this.emit('prompt', prompt);
    let yes: boolean;
    try {
      yes = Boolean(await this.opts.onPrompt?.(prompt));
    } catch {
      yes = false;
    }
    if (this.child?.stdin?.writable) this.child.stdin.write(yes ? 'y\n' : 'n\n');
  }
}

/* istanbul ignore next -- @preserve */
function openLog(logFile: string | null | undefined): {
  logPath?: string;
  logStream?: WriteStream;
} {
  if (!logFile) return {};
  const logPath =
    logFile === 'auto'
      ? join(tmpdir(), `treg-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}.log`)
      : logFile;
  return { logPath, logStream: createWriteStream(logPath) };
}

/** Starts ffmpeg and returns the running job. */
export function runFfmpeg(opts: RunOptions): FfmpegRun {
  return new FfmpegRun(opts);
}
