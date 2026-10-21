import { spawn } from 'node:child_process';

/** Asks ffprobe for a file's duration in seconds. Resolves undefined on any failure. */
export function probeDuration(ffprobePath: string, input: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(
      ffprobePath,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', input],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (out += chunk));
    child.on('error', () => resolve(undefined));
    child.on('close', (code) => {
      const sec = Number(out.trim());
      resolve(code === 0 && Number.isFinite(sec) && sec > 0 ? sec : undefined);
    });
  });
}
