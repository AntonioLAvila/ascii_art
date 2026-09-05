// WebGL2 ASCII renderer.
//
// One full-screen triangle, one draw call per frame. The per-cell average colours arrive
// as a tiny cols x rows texture and the glyphs come from the atlas, so the cost per frame
// is independent of how many characters are on screen — which is what lets a 400-column
// grid track a 60fps video.
//
// Everything is addressed with `texelFetch` at integer coordinates: each output pixel maps
// to exactly one atlas texel, so glyphs stay crisp and never bleed into their neighbours.

import { ADJUST_GLSL } from '../adjust.js';

const VERT = /* glsl */ `#version 300 es
void main() {
  // Oversized triangle covering the clip volume; no attributes needed.
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uCells;
uniform sampler2D uAtlas;
uniform vec2  uResolution;
uniform vec2  uCellPx;
uniform vec2  uGrid;
uniform float uAtlasCols;
uniform float uCount;
uniform int   uColorMode;   // 0 = colour, 1 = grayscale, 2 = mono
uniform vec3  uInk;
uniform vec3  uBg;
uniform float uBrightness;
uniform float uContrast;
uniform float uGamma;
uniform float uSaturation;
uniform float uInvert;

out vec4 fragColor;

${ADJUST_GLSL}

void main() {
  vec2 pix = vec2(gl_FragCoord.x, uResolution.y - gl_FragCoord.y);
  vec2 cell = clamp(floor(pix / uCellPx), vec2(0.0), uGrid - 1.0);
  vec2 inCell = floor(pix - cell * uCellPx);

  vec3 raw = texelFetch(uCells, ivec2(cell), 0).rgb;
  vec3 adjusted = adjustRGB(raw);
  float lum = cellLuma(adjusted);

  float gi = clamp(floor(lum * uCount), 0.0, uCount - 1.0);
  vec2 slot = vec2(mod(gi, uAtlasCols), floor(gi / uAtlasCols));
  float coverage = texelFetch(uAtlas, ivec2(slot * uCellPx + inCell), 0).r;

  // Grayscale is the adjusted colour with the saturation taken out, not the glyph-picking
  // luminance: that one carries gamma and inversion, which belong to the ramp alone.
  vec3 ink = uColorMode == 0 ? adjusted
           : uColorMode == 1 ? vec3(dot(adjusted, LUMA))
           : uInk;
  fragColor = vec4(mix(uBg, ink, coverage), 1.0);
}`;

const UNIFORMS = [
  'uCells', 'uAtlas', 'uResolution', 'uCellPx', 'uGrid', 'uAtlasCols', 'uCount',
  'uColorMode', 'uInk', 'uBg', 'uBrightness', 'uContrast', 'uGamma', 'uSaturation', 'uInvert',
];

const MODES = { color: 0, grayscale: 1, mono: 2 };

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(`shader failed to compile: ${gl.getShaderInfoLog(shader)}`);
  }
  return shader;
}

function hexToRgb(hex) {
  const v = hex.replace('#', '');
  const full = v.length === 3 ? [...v].map((c) => c + c).join('') : v;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
}

export class AsciiRenderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      // Needed so `canvas.toBlob` can read the frame back for a PNG export.
      preserveDrawingBuffer: true,
    });
    if (!gl) throw new Error('WebGL2 is not available in this browser');

    this.canvas = canvas;
    this.gl = gl;
    this.maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);

    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`shader failed to link: ${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;
    this.loc = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(program, n)]));

    this.vao = gl.createVertexArray();
    this.cellsTex = this.#makeTexture();
    this.atlasTex = this.#makeTexture();
    this.atlas = null;
    this.gridSize = [0, 0];

    gl.useProgram(program);
    gl.uniform1i(this.loc.uCells, 0);
    gl.uniform1i(this.loc.uAtlas, 1);
  }

  #makeTexture() {
    const { gl } = this;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) {
      gl.texParameteri(gl.TEXTURE_2D, p, gl.NEAREST);
    }
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T]) {
      gl.texParameteri(gl.TEXTURE_2D, p, gl.CLAMP_TO_EDGE);
    }
    return tex;
  }

  setAtlas(atlas) {
    const { gl } = this;
    this.atlas = atlas;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, atlas.width, atlas.height, 0,
                  gl.RED, gl.UNSIGNED_BYTE, atlas.data);
  }

  /** Largest column count that still fits inside the GPU's texture limits. */
  maxColsFor(cellW) {
    return Math.max(8, Math.floor(this.maxSize / cellW));
  }

  resize(cols, rows) {
    const { cellW, cellH } = this.atlas;
    const width = cols * cellW;
    const height = rows * cellH;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.gridSize = [cols, rows];
  }

  /** `cells` is a cols*rows*4 RGBA byte array of per-cell average colours. */
  render(cells, cols, rows, settings) {
    const { gl, loc } = this;
    this.resize(cols, rows);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.cellsTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cols, rows, 0,
                  gl.RGBA, gl.UNSIGNED_BYTE, cells);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    gl.uniform2f(loc.uResolution, this.canvas.width, this.canvas.height);
    gl.uniform2f(loc.uCellPx, this.atlas.cellW, this.atlas.cellH);
    gl.uniform2f(loc.uGrid, cols, rows);
    gl.uniform1f(loc.uAtlasCols, this.atlas.cols);
    gl.uniform1f(loc.uCount, this.atlas.count);
    gl.uniform1i(loc.uColorMode, MODES[settings.colorMode] ?? 0);
    gl.uniform3fv(loc.uInk, hexToRgb(settings.ink));
    gl.uniform3fv(loc.uBg, hexToRgb(settings.bg));
    gl.uniform1f(loc.uBrightness, settings.brightness);
    gl.uniform1f(loc.uContrast, settings.contrast);
    gl.uniform1f(loc.uGamma, settings.gamma);
    gl.uniform1f(loc.uSaturation, settings.saturation);
    gl.uniform1f(loc.uInvert, settings.invert ? 1 : 0);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
