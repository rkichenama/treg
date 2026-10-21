import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { splitArgs } from '../src/cli/args.js';
import { DEFAULT_OPTIONS, loadOptions, resolveOptions } from '../src/cli/options.js';
import { TregError } from '../src/errors.js';

describe('splitArgs', () => {
  it('passes everything through without --treg-option', () => {
    expect(splitArgs(['-i', 'a.mp4', 'b.mkv'])).toEqual({ ffmpegArgs: ['-i', 'a.mp4', 'b.mkv'] });
  });

  it('removes --treg-option and its value wherever it appears', () => {
    expect(splitArgs(['-i', 'a.mp4', '--treg-option', 'o.json', 'b.mkv'])).toEqual({
      optionsPath: 'o.json',
      ffmpegArgs: ['-i', 'a.mp4', 'b.mkv'],
    });
    expect(splitArgs(['--treg-option=o.json', '-i', 'a.mp4'])).toEqual({
      optionsPath: 'o.json',
      ffmpegArgs: ['-i', 'a.mp4'],
    });
  });

  it('rejects a missing value or repeats', () => {
    expect(() => splitArgs(['-i', 'a', '--treg-option'])).toThrow(TregError);
    expect(() => splitArgs(['--treg-option=', '-i', 'a'])).toThrow(/needs a path/);
    expect(() => splitArgs(['--treg-option', 'a.json', '--treg-option', 'b.json'])).toThrow(
      /only be given once/,
    );
  });
});

describe('resolveOptions', () => {
  it('fills missing keys from defaults', () => {
    const { options, warnings } = resolveOptions({ format: 'json' });
    expect(options).toEqual({ ...DEFAULT_OPTIONS, format: 'json' });
    expect(warnings).toEqual([]);
  });

  it('merges barChars field by field', () => {
    const { options } = resolveOptions({ barChars: { complete: '#' } });
    expect(options.barChars).toEqual({
      complete: '#',
      incomplete: DEFAULT_OPTIONS.barChars.incomplete,
    });
  });

  it('warns about unknown keys', () => {
    const { warnings } = resolveOptions({ colour: 'never' }, 'o.json');
    expect(warnings).toEqual(['o.json: unknown option "colour" ignored']);
  });

  it('reports every invalid value at once', () => {
    try {
      resolveOptions(
        { format: 'fancy', refreshHz: 'fast', barChars: { complete: '##' } },
        'o.json',
      );
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TregError);
      const msg = (err as Error).message;
      expect(msg).toContain('o.json: "format" must be one of');
      expect(msg).toContain('o.json: "refreshHz" must be a positive number');
      expect(msg).toContain('o.json: "barChars.complete" must be a single character');
    }
  });

  it('rejects non-objects', () => {
    expect(() => resolveOptions([])).toThrow(/must be a JSON object/);
  });

  it('does not share default objects between calls', () => {
    const a = resolveOptions({ barChars: { complete: '#' } }).options;
    expect(DEFAULT_OPTIONS.barChars.complete).toBe('█');
    expect(a.barChars).not.toBe(DEFAULT_OPTIONS.barChars);
  });
});

describe('loadOptions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'treg-opts-'));

  it('returns defaults without a path', () => {
    expect(loadOptions().options).toEqual(DEFAULT_OPTIONS);
  });

  it('reads a file, with or without a BOM', () => {
    const file = join(dir, 'o.json');
    writeFileSync(file, '﻿{"showWarnings": true}');
    expect(loadOptions(file).options.showWarnings).toBe(true);
  });

  it('explains missing files and bad JSON', () => {
    expect(() => loadOptions(join(dir, 'nope.json'))).toThrow(/options file not found/);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ format: json }');
    expect(() => loadOptions(bad)).toThrow(/invalid JSON/);
  });
});
