import { afterEach, vi } from 'vitest';
import { resetFakeSpawn } from './fake-spawn.js';

// No test runs a real process. A test scripts what spawn does with scriptSpawn().
vi.mock('node:child_process', async () => {
  const { fakeSpawn } = await import('./fake-spawn.js');
  const forbidden = (name: string) => () => {
    throw new Error(`a test called child_process.${name}; use spawn with scriptSpawn()`);
  };
  return {
    spawn: fakeSpawn,
    spawnSync: forbidden('spawnSync'),
    exec: forbidden('exec'),
    execSync: forbidden('execSync'),
    execFile: forbidden('execFile'),
    execFileSync: forbidden('execFileSync'),
    fork: forbidden('fork'),
  };
});

// main() turns a thrown spawn into an exit code, so fail the test here as well.
afterEach(() => {
  const stray = resetFakeSpawn();
  if (stray.length > 0) {
    const list = stray.map((c) => `${c.command} ${c.args.join(' ')}`).join('\n');
    throw new Error(`unscripted spawn in this test:\n${list}`);
  }
});
