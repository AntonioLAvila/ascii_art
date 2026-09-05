# ascii.art

> **Heads up:** this is vibecoded slop. It was written start to finish by an LLM in one
> sitting, and I haven't reviewed most of it. It works — I clicked around — but there is no
> test suite, and nothing here has been through a human's judgement. Use accordingly.

Turns an image or a video into ASCII art, in full colour, grayscale or a single ink colour,
at whatever resolution you ask for. Drop in a JPG, PNG, WEBP, GIF, MP4, WEBM or MOV and the
result renders live at 60fps while you drag the sliders; export it as a PNG, as text, or as
an MP4, WebM or animated GIF.

Everything runs on your machine. Nothing is uploaded anywhere.

## Running it

```bash
./run.sh          # then open http://localhost:8000
```

The only prerequisites are [uv](https://docs.astral.sh/uv/) and `ffmpeg`. `run.sh` creates
the virtualenv and installs the Python dependencies itself on first run; the frontend is
plain ES modules with no build step, so there is nothing to compile.

```bash
sudo apt install ffmpeg                             # if you don't have it
curl -LsSf https://astral.sh/uv/install.sh | sh     # if you don't have uv
PORT=9000 ./run.sh                                  # a different port
```

## What the controls do

**Resolution** — *Columns* is the width of the character grid; the number of rows follows
from the source's aspect ratio and the shape of the font's characters. *Cell height* is how
many pixels tall each character is drawn, which sets the size of anything you export.

**Characters** — the ramp runs dark to light, so the first character is what a black cell
becomes. Pick a preset or type your own. *Sort by ink density* measures how much of its cell
each glyph actually fills and reorders the ramp accordingly, which rescues a hand-typed set
whose characters aren't in brightness order. *Invert* flips which end of the ramp bright
areas get, for art meant to be read as dark-on-light.

**Colour** — *Colour* keeps each cell's own colour, *Grayscale* drops the saturation, and
*Mono* paints every character in one ink. Brightness, contrast, gamma and saturation are
applied before the character is chosen, so they change the art itself and not just its tint.

**Export** — PNG, TXT, ANSI (24-bit colour, ready to `cat` in a terminal) and a standalone
HTML page are produced in the browser and download instantly. MP4, WebM and GIF are rendered
by the server, which re-reads the source and encodes with ffmpeg; a progress bar tracks it.

## How it works

The interesting part is that the same picture has to come out of three different renderers.

Every frame is reduced to one average colour per character cell. In the browser that is a
`drawImage` into a `cols × rows` canvas — the GPU averages each cell for us — done by
repeated halving so nothing aliases. On the server it is `ffmpeg -vf scale=cols:rows`. That
tiny grid is the only thing that gets uploaded to the GPU per frame, so the cost of a frame
doesn't depend on how many characters are on screen: a 400-column grid tracks a 60fps video
in a single draw call.

From there the live preview is one WebGL2 fragment shader
(`web/js/gl/renderer.js`): it looks up the cell colour, applies the adjustments, turns the
result into a luminance, picks a glyph index from it, and samples that glyph out of an atlas
texture. Text exports repeat the same arithmetic on the CPU (`web/js/sample.js`), and video
exports repeat it again in numpy (`server/ascii_core.py`), where indexing a glyph atlas with
the index grid replaces a per-character drawing loop.

Three implementations of one calculation is a standing invitation to drift, so the maths
lives in one place per language — `web/js/adjust.js`, which also emits the GLSL, and
`server/settings.py` — and the two are checked against each other. On random inputs they
choose the same character every time; on a real frame they agree on ~93% of cells outright
and are never more than one ramp step apart, the remainder being the difference between the
browser's downscale and ffmpeg's.

Animated input is normalised to WebM the moment it is uploaded. Browsers can't seek the
frames of a GIF but they seek video natively, so after that conversion there is one playback
path instead of two, and scrubbing works for free.

## Layout

```
run.sh              start everything
server/
  app.py            FastAPI app + static frontend
  routes.py         upload, media, fonts, export endpoints
  media.py          ffprobe/ffmpeg ingest and frame extraction
  ascii_core.py     numpy frame renderer for exports
  atlas.py          Pillow glyph atlas
  exporters.py      ffmpeg encoding (mp4 / webm / gif)
  jobs.py           background export jobs
  settings.py       the shared render settings + the canonical adjustment maths
web/
  index.html        the UI
  js/adjust.js      the same maths, in JS and as GLSL
  js/gl/            WebGL2 renderer and glyph atlas
  js/sample.js      frame -> cell grid, and the CPU text path
  js/export.js      PNG / TXT / ANSI / HTML, and the export job client
  js/ui/            controls, drag and drop, transport
```

## Notes

Fonts are discovered on the machine rather than bundled, and the browser is served the very
same TTF that Pillow rasterises for exports, so a glyph looks identical in the preview and
in the rendered video.

Uploads live in `media/` and are deleted as you load new files; anything left behind by a
closed tab is cleared the next time the server starts.
