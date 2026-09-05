// The control rail: every slider, toggle and picker writes into `app.state`.

import { DEFAULT_ADJUST, DIRECTIONS } from '../adjust.js';
import { findCharset } from '../charsets.js';

const $ = (id) => document.getElementById(id);

/** Wire a range input to a state key, with a formatted readout beside it. */
function slider(app, id, key, { format = (v) => v.toFixed(2), after } = {}) {
  const input = $(id);
  const out = $(`${id}Out`);
  const sync = () => { if (out) out.textContent = format(app.state[key]); };

  input.value = app.state[key];
  sync();
  input.addEventListener('input', () => {
    app.state[key] = Number(input.value);
    sync();
    after?.();
  });
  return { input, sync };
}

export function bindControls(app, { rebuildAtlas, markDirty }) {
  const { state } = app;

  // ------------------------------------------------------------------ resolution
  const cols = slider(app, 'cols', 'cols', {
    format: (v) => String(v),
    after: () => { syncGrid(); markDirty(); },
  });
  slider(app, 'cellHeight', 'cellHeight', {
    format: (v) => `${v}px`,
    after: () => { rebuildAtlas(); cols.input.value = state.cols; cols.sync(); syncGrid(); },
  });

  $('colsPresets').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cols]');
    if (!btn) return;
    state.cols = Number(btn.dataset.cols);
    cols.input.value = state.cols;
    cols.sync();
    syncGrid();
    markDirty();
  });

  function syncGrid() {
    $('gridOut').textContent = `${state.cols} x ${state.rows}`;
  }
  // The row count follows from the source aspect ratio, so refresh it as frames render.
  setInterval(syncGrid, 200);

  // ------------------------------------------------------------------- characters
  const preset = $('charsetPreset');
  const custom = $('charsetCustom');

  const rampHint = document.querySelector('#rampHint');
  function applyRamp() {
    rebuildAtlas();
    rampHint.textContent = state.sortRamp
      ? `Rendering as: ${state.charset}`
      : 'Ordered dark \u2192 light.';
  }

  preset.addEventListener('change', () => {
    state.charsetKey = preset.value;
    if (state.charsetKey !== 'custom') custom.value = findCharset(preset.value).chars;
    state.rampInput = custom.value;
    applyRamp();
  });

  custom.addEventListener('input', () => {
    if (!custom.value.length) return;
    // Typing into the ramp is implicitly a custom ramp.
    state.charsetKey = 'custom';
    preset.value = 'custom';
    state.rampInput = custom.value;
    applyRamp();
  });

  $('sortRamp').addEventListener('change', (e) => {
    state.sortRamp = e.target.checked;
    applyRamp();
  });

  $('invert').addEventListener('change', (e) => {
    state.invert = e.target.checked;
    markDirty();
  });

  $('font').addEventListener('change', (e) => {
    state.font = e.target.value;
    state.fontLabel = app.fonts.find((f) => f.key === state.font)?.label || 'monospace';
    rebuildAtlas();
  });

  // ------------------------------------------------------------------------ dither
  $('dither').addEventListener('change', (e) => {
    state.dither = e.target.value;
    markDirty();
  });
  slider(app, 'ditherStrength', 'ditherStrength', { after: markDirty });

  // -------------------------------------------------------------------- noise field
  const fxControls = $('fxControls');
  $('fxMode').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fx]');
    if (!btn) return;
    state.fx = btn.dataset.fx;
    document.querySelectorAll('#fxMode .seg')
      .forEach((seg) => seg.classList.toggle('is-active', seg === btn));
    fxControls.hidden = state.fx === 'none';
    markDirty();
  });

  for (const key of ['fxStrength', 'noiseScale', 'noiseSpeed']) {
    slider(app, key, key, {
      format: key === 'noiseScale' ? (v) => String(v) : undefined,
      after: markDirty,
    });
  }

  const dirs = $('fxDirs');
  dirs.innerHTML = DIRECTIONS
    .map((d) => `<button class="chip" data-dir="${d.key}" title="${d.key}">${d.label}</button>`)
    .join('');
  function syncDirs() {
    dirs.querySelectorAll('[data-dir]').forEach((btn) => {
      const d = DIRECTIONS.find((v) => v.key === btn.dataset.dir);
      btn.classList.toggle('is-active', d.x === state.fxDirX && d.y === state.fxDirY);
    });
  }
  dirs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-dir]');
    if (!btn) return;
    const d = DIRECTIONS.find((v) => v.key === btn.dataset.dir);
    state.fxDirX = d.x;
    state.fxDirY = d.y;
    syncDirs();
    markDirty();
  });
  syncDirs();

  // ------------------------------------------------------------------------ colour
  const inkSwatch = $('inkSwatch');
  $('colorMode').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mode]');
    if (!btn) return;
    state.colorMode = btn.dataset.mode;
    document.querySelectorAll('#colorMode .seg')
      .forEach((s) => s.classList.toggle('is-active', s === btn));
    // The ink colour only does anything in mono mode; grey it out elsewhere.
    inkSwatch.classList.toggle('is-off', state.colorMode !== 'mono');
    markDirty();
  });
  inkSwatch.classList.toggle('is-off', state.colorMode !== 'mono');

  for (const id of ['ink', 'bg']) {
    $(id).value = state[id];
    $(id).addEventListener('input', (e) => {
      state[id] = e.target.value;
      markDirty();
    });
  }

  const adjustSliders = ['brightness', 'contrast', 'gamma', 'saturation']
    .map((key) => slider(app, key, key, { after: markDirty }));

  $('resetAdjust').addEventListener('click', () => {
    Object.assign(state, DEFAULT_ADJUST);
    $('invert').checked = state.invert;
    for (const s of adjustSliders) {
      s.input.value = state[s.input.id];
      s.sync();
    }
    markDirty();
  });

  // ------------------------------------------------------------------------ export
  slider(app, 'exportFps', 'exportFps', { format: (v) => String(v) });
  $('exportTrim').addEventListener('change', (e) => { state.exportTrim = e.target.checked; });

  syncGrid();
}
