import { describe, expect, it } from 'vitest';
import { StderrParser } from '../src/parse/stderr.js';
import { LogCollector } from '../src/report/collect.js';
import { buildFailureReport, effectiveExitCode } from '../src/report/failure.js';
import { formatFailure } from '../src/report/format.js';
import { createStyle } from '../src/render/style.js';
import { FAILURE_FIXTURES, loadFixture } from './helpers.js';

function reportFor(name: string) {
  const { stderr, meta } = loadFixture(name);
  const parser = new StderrParser();
  const collector = new LogCollector();
  for (const e of [...parser.push(stderr), ...parser.flush()]) {
    if (e.type === 'log') collector.add(e.entry);
  }
  const report = buildFailureReport({
    exitCode: meta.exitCode,
    collector,
    header: parser.header.info,
    errorsSuppressed: false,
  });
  return { report, text: formatFailure(report, createStyle(false)).join('\n') };
}

/** The line from ffmpeg that explains each failure. */
const EXPECTED: Record<(typeof FAILURE_FIXTURES)[number], string> = {
  'codec-mismatch':
    'webm:       Only VP8 or VP9 or AV1 video and Vorbis or Opus audio and WebVTT subtitles are supported for WebM.',
  'missing-input': 'in#0: Error opening input: No such file or directory',
  'unknown-encoder': "vost#0:0: Unknown encoder 'libnope'",
  'bad-option': "Unrecognized option 'nosuchoption'.",
  'bad-filter': "AVFilterGraph: No such filter: 'nosuchfilter'",
  'bad-map': "Stream map '0:s' matches no streams.",
  'exists-no-overwrite': "File 'existing.mp4' already exists. Exiting.",
  'overwrite-prompt-no': 'Not overwriting - exiting',
};

describe('failure report from real ffmpeg output', () => {
  it.each(FAILURE_FIXTURES)('%s shows the reason, not the dump', (name) => {
    const { report, text } = reportFor(name);
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.fallbackLines).toEqual([]);
    expect(text).toContain(EXPECTED[name]);
    // No header noise in the report.
    expect(text).not.toContain('Duration:');
    expect(text).not.toContain('Input #0');
    expect(text.split('\n').length).toBeLessThan(12);
  });

  it('treats exit 0 with a fatal error as failure (ffmpeg 6.1-9.0 overwrite refusal)', () => {
    const collector = new LogCollector();
    const parser = new StderrParser();
    const { stderr } = loadFixture('exists-no-overwrite');
    for (const e of [...parser.push(stderr), ...parser.flush()]) {
      if (e.type === 'log') collector.add(e.entry);
    }
    expect(effectiveExitCode(0, collector)).toBe(1);
    const report = buildFailureReport({
      exitCode: 1,
      ffmpegExitCode: 0,
      collector,
      header: parser.header.info,
      errorsSuppressed: false,
    });
    const text = formatFailure(report, createStyle(false)).join('\n');
    expect(text).toContain('✖ ffmpeg failed (exit 1)');
    expect(text).toContain('ffmpeg exited 0 despite this fatal error');
  });

  it('keeps exit 0 when ffmpeg only logged non-fatal errors', () => {
    const collector = new LogCollector();
    const parser = new StderrParser();
    for (const e of parser.push('[h264 @ 0x1] [error] concealing 12 DC errors\n')) {
      if (e.type === 'log') collector.add(e.entry);
    }
    expect(effectiveExitCode(0, collector)).toBe(0);
    expect(effectiveExitCode(255, collector)).toBe(255);
  });

  it('codec mismatch includes the stream mapping', () => {
    const { text } = reportFor('codec-mismatch');
    expect(text).toContain('mapping: Stream #0:0 -> #0:0 (mpeg4 (native) -> mjpeg (native))');
  });

  it('bad map keeps the continuation hint under its error', () => {
    const { text } = reportFor('bad-map');
    expect(text).toMatch(
      /matches no streams\.\n\s+To ignore this, add a trailing '\?' to the map\./,
    );
  });

  it('falls back to the last raw lines when nothing was tagged', () => {
    const collector = new LogCollector();
    const parser = new StderrParser();
    for (const e of parser.push('Something odd happened\nmore detail\n')) {
      if (e.type === 'log') collector.add(e.entry);
    }
    const report = buildFailureReport({
      exitCode: 1,
      collector,
      header: parser.header.info,
      errorsSuppressed: true,
    });
    const text = formatFailure(report, createStyle(false)).join('\n');
    expect(text).toContain("ffmpeg didn't tag an error");
    expect(text).toContain('  Something odd happened\n  more detail');
    expect(text).toContain('-loglevel hides');
    expect(text).toContain('"logFile": "auto"');
  });

  it('counts repeated errors once', () => {
    const collector = new LogCollector();
    const parser = new StderrParser();
    const line = '[h264 @ 0x1] [error] decode_slice_header error\n';
    for (const e of parser.push(line.repeat(3))) if (e.type === 'log') collector.add(e.entry);
    expect(collector.errors).toEqual([
      { level: 'error', component: 'h264', message: 'decode_slice_header error', count: 3 },
    ]);
    const report = buildFailureReport({
      exitCode: 1,
      collector,
      header: parser.header.info,
      errorsSuppressed: false,
    });
    expect(formatFailure(report, createStyle(false)).join('\n')).toContain('(×3)');
  });
});
