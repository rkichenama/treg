import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandInputs } from '../src/batch/inputs.js';
import { DEFAULT_OPTIONS, loadOptions } from '../src/cli/options.js';

const example = (name: string) => join(import.meta.dirname, '..', 'examples', name);

describe('examples/treg.options.json', () => {
  it('lists every option with its default value', () => {
    const { options, warnings } = loadOptions(example('treg.options.json'));
    expect(warnings).toEqual([]);
    expect(options).toEqual(DEFAULT_OPTIONS);
  });
});

/** Creates each file an example names, with its absolute folder moved under a temp folder. */
function expectLiteralInputs(name: string, absFolder: RegExp) {
  const { options, warnings } = loadOptions(example(name));
  expect(warnings).toEqual([]);
  const root = mkdtempSync(join(tmpdir(), 'treg-example-'));
  const cwd = join(root, 'project', 'work');
  mkdirSync(cwd, { recursive: true });
  const inputs = options.inputs.map((entry) => entry.replace(absFolder, `${root}/`));
  for (const entry of inputs) {
    const file = resolve(cwd, entry);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '');
  }
  expect(expandInputs(inputs, cwd)).toEqual(inputs);
  return options.inputs;
}

describe.runIf(process.platform === 'win32')('examples/treg.inputs.windows.json', () => {
  it('names files literally, with backslashes decoded from JSON', () => {
    const inputs = expectLiteralInputs(
      'treg.inputs.windows.json',
      /^C:[\\/]Users[\\/]me[\\/]Videos[\\/]/,
    );
    expect(inputs).toContain('clips\\[site.com] relative (2160p).mp4');
  });
});

describe.runIf(process.platform !== 'win32')('examples/treg.inputs.mac.json', () => {
  it('names files literally, with a backslash as part of a file name', () => {
    const inputs = expectLiteralInputs('treg.inputs.mac.json', /^\/Users\/me\/Movies\//);
    expect(inputs).toContain('clips/[site.com] back\\slash.mp4');
  });
});
