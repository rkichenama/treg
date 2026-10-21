# treg

`ffmpeg` with a progress bar you can shape, and error messages that tell you why it failed.

```
$ treg -i input.mov -c:v libx264 output.mp4
output.mp4 ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱  71% | 0:42/0:59 | 3.20x | ETA 0:05
```

```
$ treg -i input.mp4 -c:v mjpeg out.webm
✖ ffmpeg failed (exit 1)
  webm:       Only VP8 or VP9 or AV1 video and Vorbis or Opus audio and WebVTT subtitles are supported for WebM.
  out#0/webm: Could not write header (incorrect codec parameters ?): Invalid argument

  mapping: Stream #0:0 -> #0:0 (mpeg4 (native) -> mjpeg (native))
```

treg is a drop-in wrapper: every argument goes to `ffmpeg` unchanged, and treg exits with ffmpeg's exit code.

## Standing on ffpb's shoulders

treg is a TypeScript/Node port of **[ffpb](https://github.com/althonos/ffpb)** by
[Martin Larralde](https://github.com/althonos), and it would not exist without it.

ffpb got the important things right:

- **A true drop-in.** Type `ffpb` where you would type `ffmpeg`. No new syntax and nothing to learn.
- **Small and elegant.** The whole tool is one short, readable Python file. It shows how
  much a well-placed wrapper can improve a daily tool.
- **A real progress bar.** It turns ffmpeg's wall of stats into a clean
  [`tqdm`](https://github.com/tqdm/tqdm) bar that counts frames when ffmpeg reports a frame rate.
- **It handles the details.** It catches ffmpeg's `Overwrite? [y/N]` prompt and passes your
  answer through, and lets you swap in another `tqdm`, for example in notebooks.

If you work in Python, use ffpb. treg exists because I wanted the same idea in the Node toolchain,
with control over the output and clearer failures. Thank you, Martin.

## How treg differs from ffpb

|                   | ffpb                                                           | treg                                                                                                                  |
| ----------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Runtime           | Python, installed with `pip`                                   | Node ≥ 20, installed from GitHub (not on npm)                                                                         |
| Progress source   | Reads ffmpeg's stats text from stderr                          | ffmpeg's machine-readable `-progress pipe:1` stream; stderr stats only when stdout carries media                      |
| When ffmpeg fails | Prints ffmpeg's last stderr line, usually `Conversion failed!` | Prints ffmpeg's own error messages with the component that raised them, the stream mapping, and where the full log is |
| Output            | `tqdm` bar                                                     | `bar`, `line`, `json` (NDJSON), `quiet` or `raw`, with a bar template you can change                                  |
| Configuration     | None                                                           | One JSON file via `--treg-option <file.json>`; missing keys use defaults                                              |
| Ctrl+C            | Prints `Exiting.` and exits with 130                           | First press asks ffmpeg to finish cleanly (like pressing `q`), so the output file stays valid; second press kills it  |
| ffmpeg binary     | `ffmpeg` on `PATH`                                             | `ffmpeg` on `PATH`, or any path via `ffmpegPath`                                                                      |
| Use from code     | Python: `ffpb.main()` and `ProgressNotifier`                   | TypeScript: `runFfmpeg()` returns an event emitter                                                                    |

### How the error messages work

treg doesn't guess at what went wrong. It runs ffmpeg with `-loglevel level+info`, which makes
ffmpeg tag every line with its severity and the part of ffmpeg that wrote it:

```
[webm @ 000002243e9c4640] [error] Only VP8 or VP9 or AV1 video ... are supported for WebM.
```

When ffmpeg fails, treg shows only the `error` and `fatal` lines, with repeats collapsed and
pointer addresses removed. If you pass your own `-loglevel`, treg keeps your level and only adds
the tags. If ffmpeg tagged nothing (an old build, or a crash before logging started), treg shows
the last 10 lines it printed instead.

## Install

Requirements: Node 20 or newer, and `ffmpeg` on your `PATH` (or set `ffmpegPath`).

treg isn't on npm. Install the prebuilt package from a
[GitHub release](https://github.com/rkichenama/treg/releases):

```sh
pnpm add -g https://github.com/rkichenama/treg/releases/download/v0.1.0/treg-0.1.0.tgz
# or
npm install -g https://github.com/rkichenama/treg/releases/download/v0.1.0/treg-0.1.0.tgz
```

The release file is already built, so installing runs no scripts. treg has no runtime
dependencies. (Installing straight from the repository with `pnpm add -g github:rkichenama/treg`
fails on pnpm 12, which blocks build scripts in git-hosted packages.)

To build from source instead:

```sh
git clone https://github.com/rkichenama/treg && cd treg
pnpm install && pnpm pack && pnpm add -g ./treg-0.1.0.tgz
```

### PowerShell

pnpm and npm install a `treg.ps1` wrapper next to `treg.cmd`, and PowerShell runs the `.ps1`
one. That wrapper changes some arguments before treg sees them:

- `-c:v` arrives as `-c:` and `v`. treg rejoins these, so `-c:v`, `-b:a` and
  `-metadata:s:v:0` work.
- An unquoted comma, as in `-vf scale=1280:-1,fps=30`, arrives as a space. treg can't undo this.

To pass every argument unchanged, point `treg` at the `.cmd` wrapper. Add this line to your
`$PROFILE`:

```powershell
Set-Alias treg treg.cmd
```

Or quote arguments that contain commas: `-vf 'scale=1280:-1,fps=30'`.

## Usage

```sh
treg [--treg-option <options.json>] <ffmpeg arguments>
```

```sh
treg -i input.mov -c:v libx264 -crf 20 output.mp4
treg --treg-option treg.json -i input.mov output.webm
```

- **Everything except `--treg-option` goes to ffmpeg unchanged, in order.**
- **Information commands pass straight through**, untouched: `-version`, `-h`, `-encoders`, and runs without an output file.
- **Overwrite prompt:** on a terminal, ffmpeg's `Overwrite? [y/N]` prompt is shown and your answer is passed on. Without a terminal, treg adds `-n`, so ffmpeg refuses and treg says why.
- **Ctrl+C:** first press stops cleanly, second press kills ffmpeg.
- **Exit code:** ffmpeg's. treg's own problems print as `treg: ...`:
  - `2` for a bad options file
  - `127` when ffmpeg can't be found

## Options file

All settings live in one JSON file passed with `--treg-option`. Every key is optional, and missing
keys use the defaults. Unknown keys get a warning. Invalid values stop treg before ffmpeg starts,
with every problem listed. [`examples/treg.options.json`](examples/treg.options.json) has every key
set to its default.

| Key                | Default                                                              | Meaning                                                                                          |
| ------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `ffmpegPath`       | `"ffmpeg"`                                                           | Command on `PATH` or path to the ffmpeg executable                                               |
| `format`           | `"auto"`                                                             | `auto`, `bar`, `line`, `json`, `quiet` or `raw`. `auto` is `bar` on a terminal, `line` otherwise |
| `template`         | `"{file} {bar} {percent} \| {time}/{total} \| {speed} \| ETA {eta}"` | Progress line for `bar`. See tokens below                                                        |
| `barWidth`         | `"auto"`                                                             | Bar width in characters, or `auto` to fill the terminal                                          |
| `barChars`         | `{ "complete": "▰", "incomplete": "▱" }`                             | One character each                                                                               |
| `color`            | `"auto"`                                                             | `auto` (terminal only, respects `NO_COLOR`), `always` or `never`                                 |
| `refreshHz`        | `10`                                                                 | Bar redraws or JSON progress events per second                                                   |
| `lineEveryPercent` | `10`                                                                 | `line` format prints every N percent                                                             |
| `showHeader`       | `false`                                                              | Print inputs, streams and outputs before the progress                                            |
| `showWarnings`     | `false`                                                              | Print ffmpeg's warnings while it runs                                                            |
| `logFile`          | `null`                                                               | `null` for none, `"auto"` for a temp file kept only on failure, or a path                        |
| `probe`            | `false`                                                              | Ask `ffprobe` for the duration when ffmpeg doesn't report one                                    |

### Template tokens

| Token       | Example  | Token       | Example         |
| ----------- | -------- | ----------- | --------------- |
| `{bar}`     | `▰▰▰▰▱▱` | `{speed}`   | `3.20x`         |
| `{percent}` | ` 71%`   | `{eta}`     | `0:05`          |
| `{time}`    | `0:42`   | `{elapsed}` | `0:13`          |
| `{total}`   | `0:59`   | `{size}`    | `12.4 MiB`      |
| `{frame}`   | `1050`   | `{bitrate}` | `2400.0 kbit/s` |
| `{fps}`     | `79.5`   | `{file}`    | `output.mp4`    |

When the length is unknown (live input, or `{total}` shows `--:--`), the bar slides back and forth
instead of filling. Set `"probe": true` to ask `ffprobe` for the duration.

### Formats

- **`bar`**: one live line, redrawn in place, sized to the terminal.
- **`line`**: a plain line every `lineEveryPercent`. Good for logs and CI.
- **`quiet`**: nothing unless ffmpeg fails or you cancel.
- **`raw`**: plain ffmpeg; treg adds no flags.
- **`json`**: one JSON object per line on stdout (stderr when ffmpeg writes media to stdout):

```json
{"type":"start","ffmpeg":"C:\\ffmpeg\\bin\\ffmpeg.exe","args":["-hide_banner","..."],"mode":"progress","inputs":["in.mp4"],"outputs":["out.mp4"]}
{"type":"header","inputs":[{"index":0,"format":"mov,mp4,m4a,3gp,3g2,mj2","path":"in.mp4","durationSec":5,"fps":25,"streams":["..."]}],"outputs":["..."],"mapping":["..."]}
{"type":"progress","done":false,"frame":64,"fps":0,"timeSec":2.56,"sizeBytes":131072,"bitrateKbps":409.6,"speed":31.2,"elapsedSec":0.1,"totalSec":5,"percent":51.2,"etaSec":0.08}
{"type":"log","level":"error","component":"webm","message":"Only VP8 or VP9 ...","continued":false}
{"type":"error","exitCode":1,"errors":[{"level":"error","component":"webm","message":"...","count":1}],"warnings":[],"mapping":["..."],"fallbackLines":[],"errorsSuppressed":false}
{"type":"end","exitCode":1,"cancelled":false,"elapsedSec":0.4,"logFile":null}
```

## Use from code

```ts
import { locateFfmpeg, runFfmpeg } from 'treg';

const job = runFfmpeg({
  ffmpegPath: locateFfmpeg('ffmpeg'),
  args: ['-y', '-i', 'in.mov', 'out.mp4'],
});

job.on('progress', (p) => console.log(`${p.percent?.toFixed(1) ?? '?'}%`));
const result = await job.done;

if (result.failure) {
  for (const e of result.failure.errors) console.error(`${e.component ?? 'ffmpeg'}: ${e.message}`);
}
```

Events: `start`, `header`, `progress`, `log`, `prompt`, `end`. `job.cancel()` stops cleanly; call
it twice to kill. Parsers (`StderrParser`, `ProgressParser`, `parseLogLine`) and renderers are
exported too.

## Development

```sh
pnpm install
pnpm check      # typecheck, lint, format check, tests
pnpm dev -i in.mp4 out.mkv      # run from source
pnpm fixtures   # re-record ffmpeg output used by the tests
```

Tests run against real ffmpeg output recorded in `test/fixtures/`. The integration tests also run
the ffmpeg on your `PATH` and are skipped when it isn't installed.

## License

MIT. See [LICENSE](LICENSE). treg is a port of [ffpb](https://github.com/althonos/ffpb),
© 2017-2021 Martin Larralde, MIT; see [NOTICE](NOTICE).
