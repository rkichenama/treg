import { globSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { TregError } from '../errors.js';

const GLOB_CHARS = /[*?[\]{}]/;
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The real path, so aliases (8.3 short names, symlinks, junctions) of one file
 * match. A file that doesn't exist yet, such as an output, keeps its name under
 * its folder's real path.
 */
function realPath(abs: string): string {
  try {
    return realpathSync.native(abs);
  } catch {
    try {
      return join(realpathSync.native(dirname(abs)), basename(abs));
    } catch {
      return abs;
    }
  }
}

/** Key for comparing paths: real, absolute, and case-insensitive on Windows. */
export function pathKey(path: string, cwd: string, platform = process.platform): string {
  const abs = realPath(resolve(cwd, path));
  return platform === 'win32' ? abs.toLowerCase() : abs;
}

/**
 * Turns the `inputs` option into a list of files. An entry naming an existing
 * file is used as-is, even with glob characters in it; otherwise a plain path
 * is missing, and a glob must match at least one file. Matches are sorted naturally per entry,
 * duplicates are dropped, directories are skipped. Every problem is reported
 * in one error.
 */
export function expandInputs(
  entries: readonly string[],
  cwd: string,
  platform = process.platform,
): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  const problems: string[] = [];

  for (const entry of entries) {
    // Globs need forward slashes; on Windows a backslash is a separator, not an escape.
    const pattern = platform === 'win32' ? entry.replace(/\\/g, '/') : entry;
    let matches: string[];
    // An existing file wins, so names like "[site] clip.mp4" aren't read as globs.
    if (isFile(resolve(cwd, entry))) {
      matches = [entry];
    } else if (GLOB_CHARS.test(pattern)) {
      matches = globSync(pattern, { cwd })
        .filter((m) => isFile(resolve(cwd, m)))
        .sort(natural.compare);
      if (matches.length === 0) {
        problems.push(`"inputs": pattern matched no files: ${entry}`);
        continue;
      }
    } else {
      problems.push(`"inputs": file not found: ${entry}`);
      continue;
    }
    for (const match of matches) {
      const key = pathKey(match, cwd, platform);
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(match);
    }
  }

  if (problems.length > 0) throw new TregError(problems.join('\n'));
  return files;
}
