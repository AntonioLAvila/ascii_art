// Exports.
//
// Stills and text are produced right here in the page. Animation goes to the server, which
// re-renders the clip with numpy and encodes it with ffmpeg — the browser has no way to
// write an MP4 or a palette-optimised GIF, and the server is already holding the source.

import { gridToChars, gridToColors } from './sample.js';

const ESC = '\x1b[';

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function exportPNG(canvas, filename) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      download(blob, filename);
      resolve();
    }, 'image/png');
  });
}

export function asText(cells, cols, rows, settings) {
  return gridToChars(cells, cols, rows, settings.charset, settings).join('\n');
}

/** 24-bit colour ANSI, ready to `cat` in a terminal. */
export function asAnsi(cells, cols, rows, settings) {
  const lines = gridToChars(cells, cols, rows, settings.charset, settings);
  const colors = gridToColors(cells, cols, rows, settings);
  const bg = hexParts(settings.bg);

  const out = [`${ESC}48;2;${bg.join(';')}m`];
  for (let y = 0; y < rows; y++) {
    let last = null;
    let line = '';
    for (let x = 0; x < cols; x++) {
      const color = colors[y * cols + x];
      if (color !== last) {
        line += `${ESC}38;2;${hexParts(color).join(';')}m`;
        last = color;
      }
      line += lines[y][x];
    }
    out.push(line);
  }
  return `${out.join('\n')}${ESC}0m\n`;
}

/** A standalone HTML page; runs of one colour share a span so the file stays small. */
export function asHtml(cells, cols, rows, settings, title) {
  const lines = gridToChars(cells, cols, rows, settings.charset, settings);
  const colors = gridToColors(cells, cols, rows, settings);

  const body = [];
  for (let y = 0; y < rows; y++) {
    let run = '';
    let runColor = colors[y * cols];
    for (let x = 0; x < cols; x++) {
      const color = colors[y * cols + x];
      if (color !== runColor) {
        body.push(span(run, runColor));
        run = '';
        runColor = color;
      }
      run += lines[y][x];
    }
    body.push(span(run, runColor), '\n');
  }

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  html { background: ${settings.bg}; }
  body { margin: 0; display: grid; place-items: center; min-height: 100vh; }
  pre {
    font: ${settings.cellHeight}px/1 "${settings.fontLabel}", ui-monospace, monospace;
    color: ${settings.ink};
    margin: 0; white-space: pre;
  }
</style></head>
<body><pre>${body.join('')}</pre></body></html>`;
}

function span(text, color) {
  return text ? `<span style="color:${color}">${escapeHtml(text)}</span>` : '';
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function hexParts(hex) {
  const v = hex.replace('#', '');
  const full = v.length === 3 ? [...v].map((c) => c + c).join('') : v;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

/**
 * Kick off a server-side animation export and follow its progress.
 * `onProgress({state, frame, total, error})` is called until the job settles.
 */
export async function exportAnimation(payload, onProgress) {
  const res = await fetch('/api/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error((await safeDetail(res)) || 'export could not be started');
  const { job_id: jobId } = await res.json();

  const final = await new Promise((resolve, reject) => {
    const events = new EventSource(`/api/export/${jobId}/events`);
    events.onmessage = (e) => {
      const status = JSON.parse(e.data);
      onProgress(status);
      if (status.state !== 'running') {
        events.close();
        resolve(status);
      }
    };
    events.onerror = () => {
      events.close();
      reject(new Error('lost contact with the export job'));
    };
  });

  if (final.state === 'error') throw new Error(final.error || 'export failed');
  return `/api/export/${jobId}/download`;
}

async function safeDetail(res) {
  try {
    const body = await res.json();
    return typeof body.detail === 'string' ? body.detail : null;
  } catch {
    return null;
  }
}
