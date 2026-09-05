// Glyph atlas generation.
//
// Every character in the ramp is rasterised once into a single texture; the shader then
// indexes into it per cell. Rebuilt only when the ramp, the font or the cell size changes,
// so it costs nothing during playback.

const MAX_ATLAS_DIM = 4096;

/** Load the fonts the server offers and register them with the document. */
export async function loadFonts() {
  const res = await fetch('/api/fonts');
  if (!res.ok) throw new Error('could not list fonts');
  const { fonts } = await res.json();

  await Promise.all(
    fonts.map(async (f) => {
      const face = new FontFace(f.label, `url(${f.url})`);
      await face.load();
      document.fonts.add(face);
    }),
  );
  return fonts;
}

/**
 * Rasterise `charset` at `cellHeight` pixels.
 * Returns the R8 texture bytes plus the metrics the renderer needs.
 */
export function buildAtlas(family, charset, cellHeight) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // Pick the point size that makes ascent+descent land on the requested cell height, so
  // stacked rows touch exactly and the art has no seams between lines.
  const probe = 100;
  ctx.font = `${probe}px "${family}", monospace`;
  const pm = ctx.measureText('M');
  const probeHeight =
    (pm.fontBoundingBoxAscent + pm.fontBoundingBoxDescent) ||
    (pm.actualBoundingBoxAscent + pm.actualBoundingBoxDescent) * 1.4 ||
    probe * 1.2;

  const fontSize = Math.max(4, Math.round((probe * cellHeight) / probeHeight));
  ctx.font = `${fontSize}px "${family}", monospace`;
  const m = ctx.measureText('M');
  const cellW = Math.max(1, Math.round(m.width));
  const baseline = Math.round(m.fontBoundingBoxAscent || fontSize * 0.8);

  const chars = [...charset];
  const cols = Math.max(1, Math.min(chars.length, Math.floor(MAX_ATLAS_DIM / cellW)));
  const rows = Math.ceil(chars.length / cols);

  canvas.width = cols * cellW;
  canvas.height = rows * cellHeight;

  // Setting canvas dimensions resets the context, so restate the drawing state.
  ctx.font = `${fontSize}px "${family}", monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';
  chars.forEach((ch, i) => {
    const x = (i % cols) * cellW;
    const y = Math.floor(i / cols) * cellHeight;
    ctx.fillText(ch, x, y + baseline);
  });

  // Keep only the alpha channel: coverage is all the shader needs.
  const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const data = new Uint8Array(canvas.width * canvas.height);
  for (let i = 0; i < data.length; i++) data[i] = px[i * 4 + 3];

  return {
    data,
    width: canvas.width,
    height: canvas.height,
    cellW,
    cellH: cellHeight,
    cols,
    rows,
    count: chars.length,
    density: glyphDensity(data, canvas.width, cellW, cellHeight, cols, chars.length),
  };
}

/** Mean ink coverage of each glyph, used to sort a ramp dark -> light. */
function glyphDensity(data, atlasWidth, cellW, cellH, cols, count) {
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const ox = (i % cols) * cellW;
    const oy = Math.floor(i / cols) * cellH;
    let sum = 0;
    for (let y = 0; y < cellH; y++) {
      const base = (oy + y) * atlasWidth + ox;
      for (let x = 0; x < cellW; x++) sum += data[base + x];
    }
    out[i] = sum / (cellW * cellH * 255);
  }
  return out;
}

/** Reorder a ramp so its characters run from least to most ink. */
export function sortByDensity(charset, family, cellHeight = 24) {
  const chars = [...charset];
  const { density } = buildAtlas(family, charset, cellHeight);
  return chars
    .map((ch, i) => ({ ch, d: density[i] }))
    .sort((a, b) => a.d - b.d)
    .map((e) => e.ch)
    .join('');
}
