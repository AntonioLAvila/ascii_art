// The canonical image-adjustment maths.
//
// Three renderers have to agree on which character a cell becomes: the WebGL shader (live
// preview), the JS path below (text exports and clipboard), and `server/settings.py`
// (video exports). Keeping the GLSL next to the JS makes divergence obvious; if you edit
// one, edit all three.

export const LUMA = [0.2126, 0.7152, 0.0722];

export const DEFAULT_ADJUST = {
  brightness: 0,
  contrast: 1,
  gamma: 1,
  saturation: 1,
  invert: false,
};

/** Cell luminance in 0..1, after adjustments — this is what picks the glyph. */
export function cellLuma(r, g, b, a) {
  const rgb = adjustRGB(r, g, b, a);
  let lum = rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2];
  lum = Math.pow(lum, a.gamma);
  return a.invert ? 1 - lum : lum;
}

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

/** Glyph index for a luminance, matching the shader's clamped floor. */
export function glyphIndex(lum, rampLen) {
  return Math.min(rampLen - 1, Math.max(0, Math.floor(lum * rampLen)));
}

/** GLSL counterpart of the two functions above, injected into the fragment shader. */
export const ADJUST_GLSL = /* glsl */ `
const vec3 LUMA = vec3(${LUMA[0]}, ${LUMA[1]}, ${LUMA[2]});

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
`;
