// The thing being converted: either a still image or a video element.
//
// GIFs were already transcoded to WebM by the server, so animation is always a `<video>`.
// That means one playback implementation, and seeking/scrubbing work without any custom
// frame decoding.

export class Source {
  constructor(meta, element) {
    this.meta = meta;
    this.el = element;
    this.isVideo = meta.kind === 'video';
    this.width = meta.width;
    this.height = meta.height;
    this.duration = meta.duration || 0;
  }

  static async load(meta) {
    const url = meta.url;
    if (meta.kind === 'image') {
      const img = new Image();
      img.src = url;
      await img.decode();
      return new Source(meta, img);
    }

    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    await new Promise((resolve, reject) => {
      video.addEventListener('loadeddata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error('could not decode this video')),
                             { once: true });
    });
    return new Source(meta, video);
  }

  /** True while new frames are arriving and the canvas must keep redrawing. */
  get isPlaying() {
    return this.isVideo && !this.el.paused && !this.el.ended;
  }

  get currentTime() {
    return this.isVideo ? this.el.currentTime : 0;
  }

  set currentTime(t) {
    if (this.isVideo) this.el.currentTime = t;
  }

  play() {
    return this.isVideo ? this.el.play() : Promise.resolve();
  }

  pause() {
    if (this.isVideo) this.el.pause();
  }

  destroy() {
    if (this.isVideo) {
      this.el.pause();
      this.el.removeAttribute('src');
      this.el.load();
    }
  }
}
