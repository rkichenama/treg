#!/usr/bin/env node
import { main } from '../src/cli/main.js';

// A reader that stops early (e.g. `| Select-Object -First 1`) closes the pipe;
// keep ffmpeg's run going instead of crashing on the write.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err;
  });
}

process.exitCode = await main(process.argv.slice(2));
