// Turning a frame into a grid of cell colours.
//
// Rather than looping over pixels, the source is drawn into a cols x rows canvas and read
// back: the browser averages each cell for us on the GPU. A single drawImage across a big
// scale factor aliases badly though, so the reduction is done by repeated halving first —
// which lands very close to the box filter ffmpeg uses for the server-side export.

import { LUMA, adjustRGB, cellLuma, computeIndices } from './adjust.js';

export class Sampler {
  constructor() {
    this.out = document.createElement('canvas');
    this.outCtx = this.out.getContext('2d', { willReadFrequently: true });
    this.tmp = document.createElement('canvas');
    this.tmpCtx = this.tmp.getContext('2d');
  }

  /** @returns {Uint8ClampedArray} cols*rows*4 RGBA cell averages. */
  sample(drawable, srcW, srcH, cols, rows) {
    let source = drawable;
    let w = srcW;
    let h = srcH;

    // Halve until we are within 2x of the target, so every source pixel contributes.
    if (srcW > cols * 2 && srcH > rows * 2) {
      const { tmp, tmpCtx } = this;
      let tw = Math.max(cols, srcW >> 1);
      let th = Math.max(rows, srcH >> 1);
      tmp.width = tw;
      tmp.height = th;
      tmpCtx.imageSmoothingEnabled = true;
      tmpCtx.imageSmoothingQuality = 'high';
      tmpCtx.drawImage(source, 0, 0, tw, th);

      while (tw > cols * 2 && th > rows * 2) {
        const nw = Math.max(cols, tw >> 1);
        const nh = Math.max(rows, th >> 1);
        tmpCtx.drawImage(tmp, 0, 0, tw, th, 0, 0, nw, nh);
        tw = nw;
        th = nh;
      }
      source = tmp;
      w = tw;
      h = th;
    }

    const { out, outCtx } = this;
    if (out.width !== cols || out.height !== rows) {
      out.width = cols;
      out.height = rows;
    }
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = 'high';
    outCtx.clearRect(0, 0, cols, rows);
    outCtx.drawImage(source, 0, 0, w, h, 0, 0, cols, rows);
    return outCtx.getImageData(0, 0, cols, rows).data;
  }
}

/**
 * The character grid for a sampled frame — the basis of every text export.
 * Goes through `computeIndices` so the noise field and the dither are in the text too,
 * rather than the text quietly being the undithered version of what is on screen.
 */
export function gridToChars(cells, cols, rows, settings, time = 0) {
  const ramp = [...settings.charset];
  const indices = computeIndices(cells, cols, rows, settings, time);
  const lines = [];
  for (let y = 0; y < rows; y++) {
    let line = '';
    for (let x = 0; x < cols; x++) line += ramp[indices[y * cols + x]];
    lines.push(line);
  }
  return lines;
}

/** Per-cell ink colour, matching what the shader paints. */
export function gridToColors(cells, cols, rows, settings) {
  const out = new Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) {
    const p = i * 4;
    const r = cells[p] / 255;
    const g = cells[p + 1] / 255;
    const b = cells[p + 2] / 255;
    if (settings.colorMode === 'mono') {
      out[i] = settings.ink;
    } else if (settings.colorMode === 'grayscale') {
      const c = adjustRGB(r, g, b, settings);
      const v = Math.round((c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2]) * 255);
      out[i] = rgbHex(v, v, v);
    } else {
      const c = adjustRGB(r, g, b, settings);
      out[i] = rgbHex(...c.map((v) => Math.round(v * 255)));
    }
  }
  return out;
}

function rgbHex(r, g, b) {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}
