import { statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { TregError } from '../errors.js';

interface LocateEnv {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function extensions(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return [''];
  const pathext = (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  return ['', ...pathext.map((e) => e.toLowerCase())];
}

/** Finds an executable by path or on PATH. Returns undefined when missing. */
export function findExecutable(command: string, opts: LocateEnv = {}): string | undefined {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const exts = extensions(env, platform);

  if (isAbsolute(command) || /[\\/]/.test(command)) {
    const base = resolve(opts.cwd ?? process.cwd(), command);
    return exts.map((e) => base + e).find(isFile);
  }

  const pathVar = env.PATH ?? env.Path ?? '';
  for (const dir of pathVar.split(delimiter).filter(Boolean)) {
    const hit = exts.map((e) => join(dir, command + e)).find(isFile);
    if (hit) return hit;
  }
  return undefined;
}

export function locateFfmpeg(command: string, opts: LocateEnv = {}): string {
  const found = findExecutable(command, opts);
  if (!found) {
    throw new TregError(
      `ffmpeg not found ("${command}"). Install ffmpeg and put it on PATH, ` +
        'or set "ffmpegPath" in your --treg-option file.',
      127,
    );
  }
  return found;
}

/** Finds ffprobe next to ffmpeg first, then on PATH. */
export function locateFfprobe(ffmpegPath: string, opts: LocateEnv = {}): string | undefined {
  const sibling = findExecutable(join(dirname(ffmpegPath), 'ffprobe'), opts);
  return sibling ?? findExecutable('ffprobe', opts);
}
