import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, loadOptions } from '../src/cli/options.js';

describe('examples/treg.options.json', () => {
  it('lists every option with its default value', () => {
    const file = join(import.meta.dirname, '..', 'examples', 'treg.options.json');
    const { options, warnings } = loadOptions(file);
    expect(warnings).toEqual([]);
    expect(options).toEqual(DEFAULT_OPTIONS);
  });
});
