import { TregError } from '../errors.js';

export const OPTION_FLAG = '--treg-option';

export interface SplitArgs {
  /** Path given with `--treg-option`, if any. */
  optionsPath?: string;
  /** Everything else, in order, for ffmpeg. */
  ffmpegArgs: string[];
}

/** Removes `--treg-option <file>` (or `--treg-option=<file>`) from argv. */
export function splitArgs(argv: readonly string[]): SplitArgs {
  const ffmpegArgs: string[] = [];
  let optionsPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    let value: string | undefined;
    if (arg === OPTION_FLAG) {
      value = argv[i + 1];
      if (value === undefined || value === '') {
        throw new TregError(`${OPTION_FLAG} needs a path to a JSON file`);
      }
      i++;
    } else if (arg.startsWith(`${OPTION_FLAG}=`)) {
      value = arg.slice(OPTION_FLAG.length + 1);
      if (value === '') throw new TregError(`${OPTION_FLAG} needs a path to a JSON file`);
    } else {
      ffmpegArgs.push(arg);
      continue;
    }
    if (optionsPath !== undefined) throw new TregError(`${OPTION_FLAG} can only be given once`);
    optionsPath = value;
  }

  return optionsPath === undefined ? { ffmpegArgs } : { optionsPath, ffmpegArgs };
}
