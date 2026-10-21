import { basename } from 'node:path';
import type { TregOptions } from '../cli/options.js';
import type { ProgressSnapshot, PromptInfo, RunResult, StartInfo } from '../ffmpeg/run.js';
import { isErrorLevel } from '../parse/logline.js';
import type { Issue } from '../report/collect.js';
import {
  formatCancelled,
  formatFailure,
  formatHeader,
  formatSuccess,
  formatWarning,
} from '../report/format.js';
import type { HeaderInfo, LogEntry } from '../types.js';
import type { Output, Style } from './style.js';
import { layoutLine, tokenValues } from './template.js';

export interface Renderer {
  start(info: StartInfo): void;
  header(header: HeaderInfo): void;
  progress(snap: ProgressSnapshot): void;
  log(entry: LogEntry): void;
  /** Clears live output before something else uses the terminal. */
  prompt(prompt: PromptInfo): void;
  end(result: RunResult): void;
}

export interface RenderContext {
  options: TregOptions;
  /** Human-readable output (bar, line, messages). */
  out: Output;
  style: Style;
  now?: () => number;
}

function displayFile(info: StartInfo): string {
  const output = info.analysis.outputs.at(-1);
  if (output && !['-', 'pipe:', 'pipe:1'].includes(output)) return basename(output);
  return info.analysis.inputs[0] ? basename(info.analysis.inputs[0]) : '';
}

function writeLines(out: Output, lines: string[]): void {
  if (lines.length > 0) out.write(lines.join('\n') + '\n');
}

/** Shared end-of-run and message output for the text renderers. */
abstract class TextRenderer implements Renderer {
  protected file = '';
  protected last: ProgressSnapshot | undefined;

  constructor(protected readonly ctx: RenderContext) {}

  start(info: StartInfo): void {
    this.file = displayFile(info);
  }

  header(header: HeaderInfo): void {
    if (this.ctx.options.showHeader) this.message(formatHeader(header, this.ctx.style));
  }

  log(entry: LogEntry): void {
    if (!this.ctx.options.showWarnings || entry.continued || entry.level !== 'warning') return;
    const issue: Issue = { level: 'warning', message: entry.message, count: 1 };
    if (entry.component) issue.component = entry.component;
    this.message([formatWarning(issue, this.ctx.style)]);
  }

  prompt(_prompt: PromptInfo): void {
    this.clear();
  }

  end(result: RunResult): void {
    this.finish(result);
    const { style } = this.ctx;
    if (result.cancelled) this.message([formatCancelled(result, style)]);
    else if (result.failure) this.message(formatFailure(result.failure, style));
    else this.message(formatSuccess(result, this.file, style));
  }

  abstract progress(snap: ProgressSnapshot): void;

  /** Called before end messages, e.g. to draw a final bar. */
  protected finish(_result: RunResult): void {}

  /** Removes live output; text renderers without any do nothing. */
  protected clear(): void {}

  /** Prints lines above the live output. */
  protected message(lines: string[]): void {
    this.clear();
    writeLines(this.ctx.out, lines);
  }
}

/** Live single-line progress bar for terminals. */
export class BarRenderer extends TextRenderer {
  private drawn = false;
  private ended = false;
  private lastDraw = -Infinity;
  private tick = 0;

  progress(snap: ProgressSnapshot): void {
    this.last = snap;
    const now = (this.ctx.now ?? Date.now)();
    if (!snap.done && now - this.lastDraw < 1000 / this.ctx.options.refreshHz) return;
    this.lastDraw = now;
    this.draw(snap);
  }

  protected override finish(result: RunResult): void {
    if (!this.last || result.cancelled || result.failure) {
      this.clear();
      return;
    }
    const final = { ...this.last };
    if (final.totalSec !== undefined) final.percent = 100;
    this.draw(final);
    this.ctx.out.write('\n');
    this.drawn = false;
  }

  protected override clear(): void {
    if (this.drawn) this.ctx.out.write('\r\x1b[2K');
    this.drawn = false;
  }

  protected override message(lines: string[]): void {
    super.message(lines);
    if (this.last && !this.ended) this.draw(this.last);
  }

  override end(result: RunResult): void {
    this.ended = true;
    super.end(result);
  }

  private draw(snap: ProgressSnapshot): void {
    const { options, out, style } = this.ctx;
    const line = layoutLine({
      template: options.template,
      values: tokenValues(snap, style.bold(this.file)),
      columns: out.columns ?? 80,
      barWidth: options.barWidth,
      chars: options.barChars,
      fraction: snap.percent !== undefined ? snap.percent / 100 : undefined,
      tick: this.tick++,
    });
    out.write(`\r\x1b[2K${line}`);
    this.drawn = true;
  }
}

/** Plain lines at percent steps, for logs and CI. */
export class LineRenderer extends TextRenderer {
  private nextPercent = 0;
  private nextTime = 0;

  progress(snap: ProgressSnapshot): void {
    this.last = snap;
    const step = this.ctx.options.lineEveryPercent;
    if (snap.percent !== undefined) {
      if (snap.percent + 1e-9 < this.nextPercent) return;
      this.nextPercent = (Math.floor(snap.percent / step) + 1) * step;
    } else {
      // No total: print every 10 s of output time.
      if ((snap.timeSec ?? 0) < this.nextTime) return;
      this.nextTime = (snap.timeSec ?? 0) + 10;
    }
    const v = tokenValues(snap, this.file);
    this.ctx.out.write(
      `${this.file} [${v.percent}] ${v.time} / ${v.total}  speed ${v.speed}  eta ${v.eta}\n`,
    );
  }
}

/** Prints only the failure report (and cancel notice). */
export class QuietRenderer extends TextRenderer {
  progress(): void {}
  override header(): void {}
  override log(): void {}
  override end(result: RunResult): void {
    const { style } = this.ctx;
    if (result.cancelled) this.message([formatCancelled(result, style)]);
    else if (result.failure) this.message(formatFailure(result.failure, style));
  }
}

/** Newline-delimited JSON events. */
export class JsonRenderer implements Renderer {
  private lastEmit = -Infinity;

  constructor(
    private readonly ctx: RenderContext,
    private readonly json: Output,
  ) {}

  private emit(event: Record<string, unknown>): void {
    this.json.write(JSON.stringify(event) + '\n');
  }

  start(info: StartInfo): void {
    this.emit({
      type: 'start',
      ffmpeg: info.ffmpegPath,
      args: info.args,
      mode: info.mode,
      inputs: info.analysis.inputs,
      outputs: info.analysis.outputs,
    });
  }

  header(header: HeaderInfo): void {
    this.emit({ type: 'header', ...header });
  }

  progress(snap: ProgressSnapshot): void {
    const now = (this.ctx.now ?? Date.now)();
    if (!snap.done && now - this.lastEmit < 1000 / this.ctx.options.refreshHz) return;
    this.lastEmit = now;
    this.emit({ type: 'progress', ...snap });
  }

  log(entry: LogEntry): void {
    if (!isErrorLevel(entry.level) && entry.level !== 'warning') return;
    this.emit({
      type: 'log',
      level: entry.level,
      component: entry.component ?? null,
      message: entry.message,
      continued: entry.continued ?? false,
    });
  }

  prompt(prompt: PromptInfo): void {
    this.emit({ type: 'prompt', file: prompt.file });
  }

  end(result: RunResult): void {
    if (result.failure) this.emit({ type: 'error', ...result.failure });
    this.emit({
      type: 'end',
      exitCode: result.exitCode,
      cancelled: result.cancelled,
      elapsedSec: result.elapsedSec,
      logFile: result.logFile ?? null,
    });
  }
}
