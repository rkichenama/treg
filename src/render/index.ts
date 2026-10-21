import type { Format } from '../cli/options.js';
import {
  BarRenderer,
  JsonRenderer,
  LineRenderer,
  QuietRenderer,
  type RenderContext,
  type Renderer,
} from './renderers.js';
import type { Output } from './style.js';

export type RenderFormat = Exclude<Format, 'auto' | 'raw'>;

/** auto: a live bar on a terminal, plain lines otherwise. */
export function resolveFormat(format: Format, out: Output): Exclude<Format, 'auto'> {
  if (format !== 'auto') return format;
  return out.isTTY ? 'bar' : 'line';
}

/** `json` writes events to `jsonOut`; the others write to `ctx.out`. */
export function createRenderer(
  format: RenderFormat,
  ctx: RenderContext,
  jsonOut: Output,
): Renderer {
  switch (format) {
    case 'bar':
      return new BarRenderer(ctx);
    case 'line':
      return new LineRenderer(ctx);
    case 'quiet':
      return new QuietRenderer(ctx);
    case 'json':
      return new JsonRenderer(ctx, jsonOut);
  }
}

export type { RenderContext, Renderer };
export { BarRenderer, JsonRenderer, LineRenderer, QuietRenderer };
