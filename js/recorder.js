/* Screen recording engine: getDisplayMedia + optional microphone, mixed with
   Web Audio, captured by MediaRecorder. Two-phase start so the browser's
   share picker runs inside the user gesture and a countdown can run after:
     await recorder.acquire(opts)  -> permissions + streams
     recorder.begin()              -> actual encoding starts               */
(function () {
  'use strict';

  const MIME_CANDIDATES = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];

  function pickMimeType() {
    if (typeof MediaRecorder === 'undefined') return '';
    for (const t of MIME_CANDIDATES) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }

  class ScreenRecorder {
    constructor() {
      this.state = 'idle'; // idle | ready | recording | paused | stopping
      this.onstopped = null; // ({blob, mimeType, width, height}) => void
      this._reset();
    }

    _reset() {
      this.displayStream = null;
      this.micStream = null;
      this.mixedStream = null;
      this.audioCtx = null;
      this.mediaRecorder = null;
      this.chunks = [];
      this.mimeType = '';
      this.micFailed = false;
    }

    static isSupported() {
      return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia
        && typeof MediaRecorder !== 'undefined');
    }

    /* Phase 1 — must be called from a user gesture. */
    async acquire({ quality = '1080', fps = 30, mic = true } = {}) {
      if (this.state !== 'idle') throw new Error('recorder busy');

      const videoConstraints = { frameRate: { ideal: fps } };
      if (quality !== 'auto') {
        const h = parseInt(quality, 10);
        videoConstraints.height = { ideal: h };
        videoConstraints.width = { ideal: Math.round((h * 16) / 9) };
      }

      this.displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: true, // system/tab audio when the user enables it in the picker
      });

      if (mic) {
        try {
          this.micStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
          });
        } catch (err) {
          this.micFailed = true; // keep recording without the mic
        }
      }

      const videoTrack = this.displayStream.getVideoTracks()[0];
      const systemAudio = this.displayStream.getAudioTracks();
      const tracks = [videoTrack];

      if (systemAudio.length || this.micStream) {
        this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const dest = this.audioCtx.createMediaStreamDestination();
        if (systemAudio.length) {
          this.audioCtx.createMediaStreamSource(new MediaStream(systemAudio)).connect(dest);
        }
        if (this.micStream) {
          this.audioCtx.createMediaStreamSource(this.micStream).connect(dest);
        }
        tracks.push(dest.stream.getAudioTracks()[0]);
      }

      this.mixedStream = new MediaStream(tracks);

      // User clicked the browser's native "Stop sharing" button.
      videoTrack.addEventListener('ended', () => {
        if (this.state === 'recording' || this.state === 'paused' || this.state === 'ready') {
          this.stop();
        }
      });

      this.state = 'ready';
      const s = videoTrack.getSettings();
      return { width: s.width || 0, height: s.height || 0, micFailed: this.micFailed };
    }

    /* Phase 2 — start encoding (after any countdown). */
    begin({ quality = '1080' } = {}) {
      if (this.state !== 'ready') throw new Error('acquire() first');

      this.mimeType = pickMimeType();
      const options = { videoBitsPerSecond: quality === '720' ? 5_000_000 : 8_000_000 };
      if (this.mimeType) options.mimeType = this.mimeType;

      this.mediaRecorder = new MediaRecorder(this.mixedStream, options);
      this.chunks = [];
      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size) this.chunks.push(e.data);
      };
      this.mediaRecorder.onstop = () => this._finish();
      this.mediaRecorder.start(500);
      this.state = 'recording';
    }

    pause() {
      if (this.state !== 'recording') return;
      this.mediaRecorder.pause();
      this.state = 'paused';
    }

    resume() {
      if (this.state !== 'paused') return;
      this.mediaRecorder.resume();
      this.state = 'recording';
    }

    stop() {
      if (this.state === 'idle' || this.state === 'stopping') return;
      const prev = this.state;
      this.state = 'stopping';
      if (prev === 'ready' || !this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        // Never started encoding (cancelled during countdown, or picker-stop).
        this._cleanup();
        this.state = 'idle';
        if (this.onstopped) this.onstopped(null);
        return;
      }
      try { this.mediaRecorder.stop(); } catch (e) { this._finish(); }
    }

    _finish() {
      const type = this.mimeType ? this.mimeType.split(';')[0] : 'video/webm';
      const blob = this.chunks.length ? new Blob(this.chunks, { type }) : null;
      const track = this.displayStream && this.displayStream.getVideoTracks()[0];
      const settings = track ? track.getSettings() : {};
      const result = blob ? {
        blob,
        mimeType: type,
        width: settings.width || 0,
        height: settings.height || 0,
      } : null;
      this._cleanup();
      this.state = 'idle';
      if (this.onstopped) this.onstopped(result);
    }

    _cleanup() {
      [this.displayStream, this.micStream].forEach((s) => {
        if (s) s.getTracks().forEach((t) => t.stop());
      });
      if (this.audioCtx && this.audioCtx.state !== 'closed') {
        this.audioCtx.close().catch(() => {});
      }
      const cb = this.onstopped;
      this._reset();
      this.onstopped = cb;
    }
  }

  window.ScreenRecorder = ScreenRecorder;
  window.pickMimeType = pickMimeType;
})();
