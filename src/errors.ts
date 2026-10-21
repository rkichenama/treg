/* istanbul ignore file -- @preserve */
/** An error treg reports itself (bad options, ffmpeg missing), not ffmpeg's. */
export class TregError extends Error {
  constructor(
    message: string,
    readonly exitCode = 2,
  ) {
    super(message);
    this.name = 'TregError';
  }
}
