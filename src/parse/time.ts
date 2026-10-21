const CLOCK = /^(-)?(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/;
const SECONDS = /^(-)?(\d+(?:\.\d+)?)(s|ms|us)?$/;

/** Parses `HH:MM:SS.xx` or `MM:SS.xx`. Returns undefined for `N/A` or junk. */
export function parseClock(value: string): number | undefined {
  const m = CLOCK.exec(value.trim());
  if (!m) return undefined;
  const sign = m[1] ? -1 : 1;
  const hours = m[2] ? Number(m[2]) : 0;
  return sign * (hours * 3600 + Number(m[3]) * 60 + Number(m[4]));
}

/**
 * Parses an ffmpeg duration option value: `[-][HH:]MM:SS[.m...]`
 * or `[-]S+[.m...][s|ms|us]`.
 */
export function parseFfmpegDuration(value: string): number | undefined {
  const clock = parseClock(value);
  if (clock !== undefined) return clock;
  const m = SECONDS.exec(value.trim());
  if (!m) return undefined;
  const sign = m[1] ? -1 : 1;
  const n = Number(m[2]);
  const scale = m[3] === 'ms' ? 1e-3 : m[3] === 'us' ? 1e-6 : 1;
  return sign * n * scale;
}

/** Formats seconds as `H:MM:SS`, or `MM:SS` under an hour. */
export function formatClock(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return '--:--';
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${h}:${mmss}` : mmss;
}
