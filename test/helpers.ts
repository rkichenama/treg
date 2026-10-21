import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export interface Fixture {
  stderr: string;
  progress: string;
  meta: { args: string[]; stdin: string | null; exitCode: number; ffmpegVersion: string };
}

export function loadFixture(name: string): Fixture {
  const dir = join(fixturesDir, name);
  return {
    stderr: readFileSync(join(dir, 'stderr.txt'), 'utf8'),
    progress: readFileSync(join(dir, 'progress.txt'), 'utf8'),
    meta: JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as Fixture['meta'],
  };
}

/** Splits text into small chunks to exercise chunk-boundary handling. */
export function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

export const FAILURE_FIXTURES = [
  'codec-mismatch',
  'missing-input',
  'unknown-encoder',
  'bad-option',
  'bad-filter',
  'bad-map',
  'exists-no-overwrite',
  'overwrite-prompt-no',
] as const;
