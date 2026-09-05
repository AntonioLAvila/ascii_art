// Application wiring: state, controls, the render loop, and exports.

import { DEFAULT_ADJUST, DEFAULT_EFFECTS, NEEDS_CPU_DITHER, computeIndices } from './adjust.js';
import { CHARSETS, DEFAULT_CHARSET, findCharset } from './charsets.js';
import { buildAtlas, loadFonts, sortByDensity } from './gl/atlas.js';
import { AsciiRenderer } from './gl/renderer.js';
import { Sampler } from './sample.js';
import { Source } from './source.js';
import * as exports from './export.js';
import { bindDropzone, showToast } from './ui/dropzone.js';
import { bindControls } from './ui/controls.js';
import { bindTransport } from './ui/timeline.js';

const $ = (id) => document.getElementById(id);

const state = {
  ...DEFAULT_ADJUST,
  ...DEFAULT_EFFECTS,
  cols: 120,
  rows: 60,
  cellHeight: 16,
  charsetKey: DEFAULT_CHARSET,
  // `rampInput` is what the user typed; `charset` is what actually gets rendered, which
  // differs once the density sort is on. Keeping both means toggling the sort is lossless.
  rampInput: findCharset(DEFAULT_CHARSET).chars,
  charset: findCharset(DEFAULT_CHARSET).chars,
  sortRamp: false,
  font: 'dejavu',
  fontLabel: 'DejaVu Sans Mono',
  colorMode: 'color',
  ink: '#e6edf3',
  bg: '#0d1117',
  exportFps: 24,
  exportTrim: false,
};

const app = {
  state,
  source: null,
  atlas: null,
  fonts: [],
  dirty: true,
  lastCells: null,
  loadedAt: performance.now(),
  animating: false,
};

const canvas = $('gl');
const sampler = new Sampler();
let renderer;

// --------------------------------------------------------------------------- geometry

/** Rows that preserve the source's aspect ratio given non-square character cells. */
function computeRows() {
  if (!app.source || !app.atlas) return state.rows;
  const { cellW, cellH } = app.atlas;
  const ratio = (app.source.height / app.source.width) * (cellW / cellH);
  // A tall source at a large cell size can ask for a canvas past the GPU's limit.
  const maxRows = Math.min(600, Math.floor(renderer.maxSize / cellH));
  return Math.max(2, Math.min(maxRows, Math.round(state.cols * ratio)));
}

/** Keep the grid inside the GPU's texture limits at the current cell size. */
function clampCols() {
  if (!app.atlas) return;
  const max = renderer.maxColsFor(app.atlas.cellW);
  if (state.cols > max) {
    state.cols = max;
    showToast(`Columns limited to ${max} at this cell size`);
  }
}

export function rebuildAtlas() {
  const base = state.charsetKey === 'custom'
    ? state.rampInput
    : findCharset(state.charsetKey).chars;
  state.charset = state.sortRamp ? sortByDensity(base, state.fontLabel) : base;

  app.atlas = buildAtlas(state.fontLabel, state.charset, state.cellHeight);
  renderer.setAtlas(app.atlas);
  clampCols();
  markDirty();
}

export function markDirty() {
  app.dirty = true;
}

// ------------------------------------------------------------------------ render loop

/**
 * The clock the noise field runs on: a video's own playhead, so the effect is identical in
 * the preview and in an export of the same frame, and wall time for a still.
 */
function sourceTime() {
  if (!app.source) return 0;
  return app.source.isVideo
    ? app.source.currentTime
    : (performance.now() - app.loadedAt) / 1000;
}

function frame() {
  requestAnimationFrame(frame);
  if (!app.source || !app.atlas) return;

  // A drifting noise field has to redraw even when nothing else changed.
  app.animating = state.fx === 'noise' && state.fxStrength > 0 && state.noiseSpeed > 0;
  if (!app.dirty && !app.source.isPlaying && !app.animating) return;
  app.dirty = false;

  state.rows = computeRows();
  const cells = sampler.sample(
    app.source.el, app.source.width, app.source.height, state.cols, state.rows,
  );
  app.lastCells = cells;

  const time = sourceTime();
  // Error diffusion cannot run in the shader; hand it a finished index grid instead.
  const indices = NEEDS_CPU_DITHER.has(state.dither)
    ? computeIndices(cells, state.cols, state.rows, state, time)
    : null;
  renderer.render(cells, state.cols, state.rows, state, indices, time);
  canvas.classList.add('is-ready');
  // A still renders once and then stops, so its readout has to update on that last frame
  // rather than waiting for a sampling window that will never close.
  tickStats(!app.source.isPlaying && !app.animating);
}

let frames = 0;
let fpsSince = performance.now();
function tickStats(force = false) {
  frames++;
  const now = performance.now();
  const elapsed = now - fpsSince;
  if (!force && elapsed < 500) return;
  const fps = Math.round((frames * 1000) / elapsed);
  frames = 0;
  fpsSince = now;
  // A still only redraws when something changes, so a frame rate would be meaningless.
  const live = app.source?.isPlaying || app.animating;
  const rate = live ? `<span class="fps">${fps} fps</span>` : 'still';
  $('stats').innerHTML =
    `${state.cols}x${state.rows} cells · ${canvas.width}x${canvas.height}px · ${rate}`;
}

// ---------------------------------------------------------------------------- loading

export async function loadFile(file) {
  const progress = $('uploadProgress');
  progress.hidden = false;
  try {
    const body = new FormData();
    body.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      throw new Error(detail.detail || 'upload failed');
    }
    const meta = await res.json();

    // Release the previous upload so `media/` does not grow for the whole session.
    const previous = app.source?.meta.id;
    app.source?.destroy();
    app.source = await Source.load(meta);
    app.loadedAt = performance.now();
    if (previous && previous !== meta.id) {
      fetch(`/api/media/${previous}`, { method: 'DELETE' }).catch(() => {});
    }

    $('fileInfo').innerHTML =
      `<b>${escapeHtml(meta.name)}</b> <span class="dim">${meta.width}x${meta.height}` +
      `${meta.kind === 'video' ? ` · ${meta.duration.toFixed(1)}s · ${meta.fps.toFixed(0)}fps` : ''}` +
      `</span>`;
    $('emptyState').hidden = true;
    $('transport').hidden = !app.source.isVideo;
    $('videoExport').hidden = !app.source.isVideo;
    if (app.source.isVideo) {
      $('exportFps').value = state.exportFps = Math.min(60, Math.round(meta.fps) || 24);
      $('exportFpsOut').textContent = state.exportFps;
      await app.source.play();
    }
    markDirty();
  } catch (err) {
    showToast(err.message, true);
  } finally {
    progress.hidden = true;
  }
}

async function loadSample(name) {
  const files = { gradient: 'gradient.jpg', bars: 'bars.png', motion: 'motion.mp4' };
  const path = `/assets/samples/${files[name]}`;
  const res = await fetch(path);
  const blob = await res.blob();
  await loadFile(new File([blob], files[name], { type: blob.type }));
}

// ---------------------------------------------------------------------------- exports

function baseName() {
  const name = app.source?.meta.name || 'ascii';
  return name.replace(/\.[^.]+$/, '');
}

async function runExport(kind) {
  if (!app.source || !app.lastCells) {
    showToast('Load a file first');
    return;
  }
  const { cols, rows } = state;
  const cells = app.lastCells;
  const time = sourceTime();

  try {
    if (kind === 'png') {
      // The canvas already holds the current frame at full cell resolution.
      await exports.exportPNG(canvas, `${baseName()}-ascii.png`);
    } else if (kind === 'txt') {
      const text = exports.asText(cells, cols, rows, state, time);
      exports.download(new Blob([text], { type: 'text/plain' }), `${baseName()}-ascii.txt`);
    } else if (kind === 'ansi') {
      const text = exports.asAnsi(cells, cols, rows, state, time);
      exports.download(new Blob([text], { type: 'text/plain' }), `${baseName()}-ascii.ans`);
    } else if (kind === 'html') {
      const html = exports.asHtml(cells, cols, rows, state, `${baseName()} — ASCII`, time);
      exports.download(new Blob([html], { type: 'text/html' }), `${baseName()}-ascii.html`);
    } else if (kind === 'copy') {
      await navigator.clipboard.writeText(exports.asText(cells, cols, rows, state, time));
      showToast('ASCII copied to the clipboard');
    } else {
      await runAnimationExport(kind);
    }
  } catch (err) {
    showToast(err.message, true);
  }
}

async function runAnimationExport(format) {
  const job = $('job');
  const fill = $('jobFill');
  const label = $('jobLabel');
  job.hidden = false;
  job.classList.remove('is-error');
  fill.style.width = '0%';
  label.textContent = `Rendering ${format.toUpperCase()}…`;

  const wasPlaying = app.source.isPlaying;
  app.source.pause();

  const payload = {
    media_id: app.source.meta.id,
    format,
    fps: state.exportFps,
    start: 0,
    end: null,
    settings: {
      cols: state.cols,
      rows: state.rows,
      charset: state.charset,
      invert: state.invert,
      font: state.font,
      cell_height: state.cellHeight,
      color_mode: state.colorMode,
      ink: state.ink,
      bg: state.bg,
      brightness: state.brightness,
      contrast: state.contrast,
      gamma: state.gamma,
      saturation: state.saturation,
      dither: state.dither,
      dither_strength: state.ditherStrength,
      fx: state.fx,
      fx_strength: state.fxStrength,
      noise_scale: state.noiseScale,
      noise_speed: state.noiseSpeed,
      fx_dir_x: state.fxDirX,
      fx_dir_y: state.fxDirY,
    },
  };
  if (state.exportTrim) {
    payload.start = app.source.currentTime;
    payload.end = app.source.duration;
  }

  try {
    const url = await exports.exportAnimation(payload, ({ frame: n, total }) => {
      const pct = total ? Math.round((n / total) * 100) : 0;
      fill.style.width = `${pct}%`;
      label.textContent = `Rendering ${format.toUpperCase()} — frame ${n} of ${total}`;
    });
    label.textContent = `${format.toUpperCase()} ready — downloading`;
    window.location.href = url;
  } catch (err) {
    job.classList.add('is-error');
    label.textContent = err.message;
    throw err;
  } finally {
    if (wasPlaying) app.source.play();
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ------------------------------------------------------------------------------- init

// Anything that escapes a handler should be visible rather than silent in the console.
window.addEventListener('error', (e) => showToast(e.message, true));
window.addEventListener('unhandledrejection', (e) => showToast(String(e.reason), true));

async function init() {
  try {
    renderer = new AsciiRenderer(canvas);
  } catch (err) {
    document.querySelector('.empty-state').innerHTML =
      `<p class="dim">${err.message}</p><p class="small dim">` +
      'This app needs WebGL2. Try a current Chrome, Firefox or Safari.</p>';
    return;
  }

  app.fonts = await loadFonts();
  const fontSelect = $('font');
  fontSelect.innerHTML = app.fonts
    .map((f) => `<option value="${f.key}">${f.label}</option>`)
    .join('');
  const preferred = app.fonts.find((f) => f.key === state.font) || app.fonts[0];
  state.font = preferred.key;
  state.fontLabel = preferred.label;
  fontSelect.value = state.font;

  $('charsetPreset').innerHTML = CHARSETS
    .map((c) => `<option value="${c.key}">${c.label}</option>`)
    .join('');
  $('charsetPreset').value = state.charsetKey;
  $('charsetCustom').value = state.rampInput;

  rebuildAtlas();
  bindControls(app, { rebuildAtlas, markDirty });
  bindTransport(app, { markDirty });
  bindDropzone(loadFile);

  document.querySelectorAll('[data-sample]').forEach((btn) => {
    btn.addEventListener('click', () => loadSample(btn.dataset.sample));
  });
  document.querySelectorAll('[data-export]').forEach((btn) => {
    btn.addEventListener('click', () => runExport(btn.dataset.export));
  });

  requestAnimationFrame(frame);
  loadSample('gradient');
}

init();
