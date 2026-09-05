// Playback transport for video sources.

const $ = (id) => document.getElementById(id);

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function bindTransport(app, { markDirty }) {
  const playBtn = $('playBtn');
  const seek = $('seek');
  const timeLabel = $('timeLabel');
  let scrubbing = false;

  const video = () => (app.source?.isVideo ? app.source.el : null);

  playBtn.addEventListener('click', () => {
    const v = video();
    if (!v) return;
    if (v.paused) v.play(); else v.pause();
  });

  seek.addEventListener('input', () => {
    const v = video();
    if (!v || !v.duration) return;
    scrubbing = true;
    v.currentTime = (seek.value / 1000) * v.duration;
    markDirty();
  });
  seek.addEventListener('change', () => { scrubbing = false; });

  $('loop').addEventListener('change', (e) => {
    const v = video();
    if (v) v.loop = e.target.checked;
  });

  $('speed').addEventListener('change', (e) => {
    const v = video();
    if (v) v.playbackRate = Number(e.target.value);
  });

  // Space toggles playback, unless the user is typing in the ramp field.
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.target.matches('input, select, textarea')) return;
    e.preventDefault();
    playBtn.click();
  });

  // One timer drives the readouts; the render loop stays free of DOM work.
  setInterval(() => {
    const v = video();
    if (!v) return;
    playBtn.textContent = v.paused ? '▶' : '❚❚';
    if (!scrubbing && v.duration) seek.value = Math.round((v.currentTime / v.duration) * 1000);
    timeLabel.textContent = `${formatTime(v.currentTime)} / ${formatTime(v.duration || 0)}`;
  }, 100);
}
