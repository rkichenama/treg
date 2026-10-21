import { parse } from 'node:path';
import { TregError } from '../errors.js';
import { analyzeArgs } from '../ffmpeg/analyze.js';
import { pathKey } from './inputs.js';

export interface BatchJob {
  /** 1-based position in the batch. */
  index: number;
  input: string;
  outputs: string[];
  /** Full ffmpeg arguments for this file: `-i <input>` plus the user's args. */
  args: string[];
}

export const OUTPUT_TOKENS = ['name', 'ext', 'dir', 'index'] as const;

/** Fills `{name}`, `{ext}`, `{dir}` and `{index}` for one input. */
export function fillOutputTemplate(
  template: string,
  input: string,
  index: number,
  count: number,
): string {
  const p = parse(input);
  const values: Record<string, string> = {
    name: p.name,
    ext: p.ext.replace(/^\./, ''),
    dir: p.dir === '' ? '.' : p.dir,
    index: String(index).padStart(String(count).length, '0'),
  };
  return template.replace(/\{(name|ext|dir|index)\}/g, (_, key: string) => values[key] ?? '');
}

/**
 * Builds one ffmpeg run per input. Each file goes where `-i {input}` is, or
 * first as `-i <file>` when there's no placeholder (the user's args are then
 * output options). Output arguments are templates. Refuses any other -i, a
 * missing output, and outputs that collide with each other or with an input.
 */
export function planBatch(
  inputs: readonly string[],
  userArgs: readonly string[],
  cwd: string,
  platform = process.platform,
): BatchJob[] {
  const analysis = analyzeArgs(userArgs);
  // `-i {input}` marks where each file goes, so input options can precede it.
  const placeholder = userArgs.findIndex((a, i) => a === '{input}' && userArgs[i - 1] === '-i');
  const usesPlaceholder = analysis.inputs.length === 1 && placeholder >= 0;
  if (analysis.inputs.length > 0 && !usesPlaceholder) {
    throw new TregError(
      `"inputs" in the options file replaces -i. Remove -i ${analysis.inputs.join(', -i ')} ` +
        'from the command line, or write -i "{input}" where each file should go.',
    );
  }
  if (analysis.outputIndexes.length === 0) {
    throw new TregError(
      '"inputs" needs an output name on the command line, e.g. "{name}.mp4". ' +
        `Tokens: ${OUTPUT_TOKENS.map((t) => `{${t}}`).join(' ')}`,
    );
  }

  const inputKeys = new Map(inputs.map((i) => [pathKey(i, cwd, platform), i]));
  const outputOwners = new Map<string, string>();
  const problems: string[] = [];

  const jobs = inputs.map((input, n): BatchJob => {
    const index = n + 1;
    const args = [...userArgs];
    const outputs: string[] = [];
    for (const at of analysis.outputIndexes) {
      const output = fillOutputTemplate(userArgs[at] ?? '', input, index, inputs.length);
      args[at] = output;
      outputs.push(output);
      const key = pathKey(output, cwd, platform);
      const clash = inputKeys.get(key);
      if (clash !== undefined) {
        problems.push(`output "${output}" would overwrite input "${clash}"`);
      }
      const owner = outputOwners.get(key);
      if (owner !== undefined && owner !== input) {
        problems.push(
          `"${owner}" and "${input}" would both write "${output}"; add {name} or {index}`,
        );
      }
      outputOwners.set(key, input);
    }
    if (usesPlaceholder) {
      args[placeholder] = input;
      return { index, input, outputs, args };
    }
    return { index, input, outputs, args: ['-i', input, ...args] };
  });

  if (problems.length > 0) throw new TregError([...new Set(problems)].join('\n'));
  return jobs;
}
