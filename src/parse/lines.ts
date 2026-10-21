/**
 * Splits a byte stream into lines on `\r\n`, `\r` or `\n`. ffmpeg uses a bare
 * `\r` to redraw its stats line, so each redraw becomes its own line.
 */
export class LineSplitter {
  private rest = '';

  push(chunk: string): string[] {
    const parts = (this.rest + chunk).split(/\r\n|\r|\n/);
    this.rest = parts.pop() ?? '';
    return parts.filter((line) => line.length > 0);
  }

  /** Text after the last line break, not yet a full line. */
  get pending(): string {
    return this.rest;
  }

  takePending(): string {
    const rest = this.rest;
    this.rest = '';
    return rest;
  }

  flush(): string[] {
    const rest = this.takePending();
    return rest.length > 0 ? [rest] : [];
  }
}
