// The canonical render maths: adjustments, the noise field, and dithering.
//
// Three renderers have to agree on which character a cell becomes: the WebGL shader (live
// preview), the JS path below (text exports and clipboard), and `server/settings.py`
// (video exports). Keeping the GLSL next to the JS makes divergence obvious; if you edit
// one, edit all three.
//
// Two rules keep the three in step:
//   * Anything a fragment shader can evaluate per cell — the adjustments, the noise field,
//     ordered dithering — is written twice here, once in JS and once as GLSL.
//   * Error diffusion (Floyd-Steinberg, Atkinson) cannot be: each cell depends on the cells
//     before it. Those run on the CPU in `computeIndices` and the result is handed to the
//     shader as a texture of glyph indices.

export const LUMA = [0.2126, 0.7152, 0.0722];

export const DEFAULT_ADJUST = {
  brightness: 0,
  contrast: 1,
  gamma: 1,
  saturation: 1,
  invert: false,
};

export const DEFAULT_EFFECTS = {
  dither: 'none',          // none | bayer | floyd | atkinson
  ditherStrength: 0.8,
  fx: 'none',              // none | noise
  fxStrength: 0.35,
  noiseScale: 24,
  noiseSpeed: 0.35,
  fxDirX: 0,
  fxDirY: -1,
};

/** Dither modes the shader can evaluate itself; the rest need the CPU. */
export const SHADER_DITHER = { none: 0, bayer: 1 };
export const NEEDS_CPU_DITHER = new Set(['floyd', 'atkinson']);

export const DIRECTIONS = [
  { key: 'up', label: '↑', x: 0, y: -1 },
  { key: 'down', label: '↓', x: 0, y: 1 },
  { key: 'left', label: '←', x: -1, y: 0 },
  { key: 'right', label: '→', x: 1, y: 0 },
  { key: 'up-left', label: '↖', x: -0.7071, y: -0.7071 },
  { key: 'up-right', label: '↗', x: 0.7071, y: -0.7071 },
  { key: 'down-left', label: '↙', x: -0.7071, y: 0.7071 },
  { key: 'down-right', label: '↘', x: 0.7071, y: 0.7071 },
];

// The canonical 8x8 ordered-dither matrix, spelled out rather than derived so that the JS,
// the GLSL and the numpy copies cannot disagree about the construction.
export const BAYER8 = [
   0, 32,  8, 40,  2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44,  4, 36, 14, 46,  6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
   3, 35, 11, 43,  1, 33,  9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47,  7, 39, 13, 45,  5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
];

// --------------------------------------------------------------------------- adjustments

/** Adjusted colour in 0..1, used as the ink in full-colour mode. */
export function adjustRGB(r, g, b, a) {
  const gray = r * LUMA[0] + g * LUMA[1] + b * LUMA[2];
  const out = [
    gray + (r - gray) * a.saturation,
    gray + (g - gray) * a.saturation,
    gray + (b - gray) * a.saturation,
  ];
  for (let i = 0; i < 3; i++) {
    out[i] = Math.min(1, Math.max(0, (out[i] - 0.5) * a.contrast + 0.5 + a.brightness));
  }
  return out;
}

/** Cell luminance in 0..1, after adjustments — this is what picks the glyph. */
export function cellLuma(r, g, b, a) {
  const rgb = adjustRGB(r, g, b, a);
  let lum = rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2];
  lum = Math.pow(lum, a.gamma);
  return a.invert ? 1 - lum : lum;
}

/** Glyph index for a luminance, matching the shader's clamped floor. */
export function glyphIndex(lum, rampLen) {
  return Math.min(rampLen - 1, Math.max(0, Math.floor(lum * rampLen)));
}

// -------------------------------------------------------------------------- noise field

// An integer hash rather than the usual `fract(sin(...))`: sine differs between GPU
// vendors and between GPU and CPU, which would make the preview and the export drift.
// This one is exact 32-bit arithmetic everywhere, and only the top 24 bits are turned into
// a float so the result is representable in a shader's 32-bit floats.
export function hash2(x, y) {
  // The xor with the golden-ratio constant stops the origin hashing to a flat zero.
  let h = ((Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2545f491) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return (h >>> 8) / 16777216;
}

function smooth(t) {
  return t * t * (3 - 2 * t);
}

/** Value noise in 0..1 at a continuous position. */
export function valueNoise(px, py) {
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const u = smooth(px - ix);
  const v = smooth(py - iy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
}

/** Three octaves of value noise, normalised to 0..1. */
export function fbm(px, py) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let fx = px;
  let fy = py;
  for (let i = 0; i < 3; i++) {
    sum += amp * valueNoise(fx, fy);
    norm += amp;
    amp *= 0.5;
    fx *= 2;
    fy *= 2;
  }
  return sum / norm;
}

/**
 * Signed luminance offset from the noise field at a cell, at time `t` in seconds.
 * The sample position moves against the direction vector so the pattern appears to drift
 * along it.
 */
export function noiseOffset(x, y, t, s) {
  if (s.fx !== 'noise' || s.fxStrength === 0) return 0;
  const scale = Math.max(1, s.noiseScale);
  const px = x / scale - s.fxDirX * t * s.noiseSpeed;
  const py = y / scale - s.fxDirY * t * s.noiseSpeed;
  return (fbm(px, py) - 0.5) * s.fxStrength;
}

// ----------------------------------------------------------------------------- dithering

/** Ordered-dither threshold in 0..1 for a cell. */
export function bayerOffset(x, y) {
  return BAYER8[(((y % 8) + 8) % 8) * 8 + (((x % 8) + 8) % 8)] / 64;
}

/**
 * Glyph index for every cell, applying the noise field and the chosen dither.
 * This is the CPU twin of the shader, and the only implementation for error diffusion.
 * `cells` is the cols*rows*4 RGBA grid; returns one index per cell.
 */
export function computeIndices(cells, cols, rows, s, time = 0) {
  const rampLen = [...s.charset].length;
  const count = cols * rows;
  const luma = new Float32Array(count);

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const p = i * 4;
      luma[i] =
        cellLuma(cells[p] / 255, cells[p + 1] / 255, cells[p + 2] / 255, s) +
        noiseOffset(x, y, time, s);
    }
  }

  const out = new Uint8Array(count);
  if (NEEDS_CPU_DITHER.has(s.dither)) {
    errorDiffuse(luma, out, cols, rows, rampLen, s.dither, s.ditherStrength);
    return out;
  }

  for (let i = 0; i < count; i++) {
    let lum = luma[i];
    if (s.dither === 'bayer') {
      const x = i % cols;
      const y = (i / cols) | 0;
      lum += ((bayerOffset(x, y) - 0.5) * s.ditherStrength) / rampLen;
    }
    out[i] = glyphIndex(lum, rampLen);
  }
  return out;
}

function spread(buf, cols, rows, x, y, amount) {
  if (x < 0 || x >= cols || y >= rows) return;
  buf[y * cols + x] += amount;
}

/**
 * Floyd-Steinberg and Atkinson error diffusion over the cell grid.
 *
 * The grid is small — a few thousand cells even at 400 columns — so a scalar scan costs
 * well under a millisecond, which is why this can run per frame during playback.
 */
function errorDiffuse(luma, out, cols, rows, rampLen, mode, strength) {
  const buf = Float32Array.from(luma);
  const atkinson = mode === 'atkinson';

  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      const old = buf[i];
      const idx = glyphIndex(old, rampLen);
      out[i] = idx;
      // The level's representative luminance is the middle of its band.
      const err = (old - (idx + 0.5) / rampLen) * strength;

      if (atkinson) {
        // Atkinson passes on only 6/8 of the error, which is what gives it its airier look.
        const e = err / 8;
        spread(buf, cols, rows, x + 1, y, e);
        spread(buf, cols, rows, x + 2, y, e);
        spread(buf, cols, rows, x - 1, y + 1, e);
        spread(buf, cols, rows, x, y + 1, e);
        spread(buf, cols, rows, x + 1, y + 1, e);
        spread(buf, cols, rows, x, y + 2, e);
      } else {
        spread(buf, cols, rows, x + 1, y, (err * 7) / 16);
        spread(buf, cols, rows, x - 1, y + 1, (err * 3) / 16);
        spread(buf, cols, rows, x, y + 1, (err * 5) / 16);
        spread(buf, cols, rows, x + 1, y + 1, err / 16);
      }
    }
  }
}

// ---------------------------------------------------------------------------------- GLSL

/** GLSL counterpart of everything above that a shader can evaluate per cell. */
export const ADJUST_GLSL = /* glsl */ `
const vec3 LUMA = vec3(${LUMA[0]}, ${LUMA[1]}, ${LUMA[2]});

const int BAYER8[64] = int[64](${BAYER8.join(', ')});

vec3 adjustRGB(vec3 c) {
  float gray = dot(c, LUMA);
  c = vec3(gray) + (c - vec3(gray)) * uSaturation;
  c = (c - 0.5) * uContrast + 0.5 + uBrightness;
  return clamp(c, 0.0, 1.0);
}

float cellLuma(vec3 adjusted) {
  float lum = pow(dot(adjusted, LUMA), uGamma);
  return uInvert > 0.5 ? 1.0 - lum : lum;
}

float hash2(int x, int y) {
  uint h = (uint(x) * 0x27d4eb2du ^ uint(y) * 0x165667b1u) ^ 0x9e3779b9u;
  h = (h ^ (h >> 15)) * 0x2545f491u;
  h = h ^ (h >> 13);
  return float(h >> 8) / 16777216.0;
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 w = f * f * (3.0 - 2.0 * f);
  int ix = int(i.x);
  int iy = int(i.y);
  float a = hash2(ix, iy);
  float b = hash2(ix + 1, iy);
  float c = hash2(ix, iy + 1);
  float d = hash2(ix + 1, iy + 1);
  float top = a + (b - a) * w.x;
  return top + ((c + (d - c) * w.x) - top) * w.y;
}

float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  float norm = 0.0;
  for (int i = 0; i < 3; i++) {
    sum += amp * valueNoise(p);
    norm += amp;
    amp *= 0.5;
    p *= 2.0;
  }
  return sum / norm;
}

float noiseOffset(vec2 cell) {
  if (uFxStrength == 0.0) return 0.0;
  vec2 p = cell / max(1.0, uNoiseScale) - uFxDir * uTime * uNoiseSpeed;
  return (fbm(p) - 0.5) * uFxStrength;
}

float bayerOffset(int x, int y) {
  int bx = int(mod(float(x), 8.0));
  int by = int(mod(float(y), 8.0));
  return float(BAYER8[by * 8 + bx]) / 64.0;
}
`;
