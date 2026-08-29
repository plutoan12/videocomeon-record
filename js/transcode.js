/* Lazy-loaded ffmpeg.wasm wrapper (single-thread core, self-hosted in
   vendor/ffmpeg/). Used for:
   - guaranteed MP4 output (H.264 + AAC transcode) where MediaRecorder
     cannot produce mp4 natively
   - fast, no-re-encode clip merging (stream copy concat)
   - animated GIF conversion (two-pass palettegen/paletteuse)
   - audio extraction to MP3 (libmp3lame)
   The ~32MB core is fetched only on first use and then HTTP-cached. */
(function () {
  'use strict';

  const BASE = new URL('../vendor/ffmpeg/', document.currentScript.src).href;

  let ffmpeg = null;
  let loadPromise = null;

  function injectScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('script load failed: ' + src));
      document.head.appendChild(s);
    });
  }

  async function load(onStatus) {
    if (ffmpeg) return ffmpeg;
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      if (onStatus) onStatus('변환 엔진 로딩 중… (최초 1회, 약 32MB)');
      if (!window.FFmpegWASM) await injectScript(BASE + 'ffmpeg.js');
      const { FFmpeg } = window.FFmpegWASM;
      const ff = new FFmpeg();
      // no classWorkerURL: the UMD build must spawn its own classic worker
      // (814.ffmpeg.js, resolved relative to ffmpeg.js) — an explicit
      // classWorkerURL makes it a module worker, which breaks the UMD core
      await ff.load({
        coreURL: BASE + 'ffmpeg-core.js',
        wasmURL: BASE + 'ffmpeg-core.wasm',
      });
      ffmpeg = ff;
      loadPromise = null;
      return ff;
    })();
    try {
      return await loadPromise;
    } catch (e) {
      loadPromise = null;
      throw e;
    }
  }

  async function cleanupFiles(ff, names) {
    for (const n of names) {
      try { await ff.deleteFile(n); } catch (e) { /* not written */ }
    }
  }

  function extOf(mimeType) {
    return mimeType && mimeType.includes('mp4') ? 'mp4' : 'webm';
  }

  /* Transcode any blob to H.264 + AAC mp4. onProgress gets 0..1 (best effort:
     MediaRecorder webm often lacks a duration header, so it may be coarse). */
  async function toMp4(blob, { onProgress, onStatus } = {}) {
    const ff = await load(onStatus);
    const inName = 'in.' + extOf(blob.type);
    const files = [inName, 'out.mp4'];
    const onp = (e) => {
      if (onProgress && isFinite(e.progress)) {
        onProgress(Math.min(1, Math.max(0, e.progress)));
      }
    };
    ff.on('progress', onp);
    try {
      if (onStatus) onStatus('MP4로 변환 중…');
      await ff.writeFile(inName, new Uint8Array(await blob.arrayBuffer()));
      await ff.exec([
        '-i', inName,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-vsync', 'vfr', // MediaRecorder streams lack fps metadata; avoid 1000fps frame duplication
        '-c:a', 'aac', '-b:a', '192k',
        '-movflags', '+faststart',
        'out.mp4',
      ]);
      const data = await ff.readFile('out.mp4');
      if (!data || !data.length) throw new Error('empty output');
      return new Blob([data.buffer], { type: 'video/mp4' });
    } finally {
      ff.off('progress', onp);
      await cleanupFiles(ff, files);
    }
  }

  /* Convert a video blob to an animated GIF. Two ffmpeg passes: a shared
     palette is generated first, then frames are mapped onto it — much better
     color than the default 256-color dither. Never upscales beyond `width`. */
  async function toGif(blob, { fps = 12, width = 480, onProgress, onStatus } = {}) {
    const ff = await load(onStatus);
    const inName = 'in.' + extOf(blob.type);
    const files = [inName, 'pal.png', 'out.gif'];
    let phase = 0; // 0 = palette pass, 1 = render pass
    const onp = (e) => {
      if (onProgress && isFinite(e.progress)) {
        const p = Math.min(1, Math.max(0, e.progress));
        onProgress(phase === 0 ? p * 0.4 : 0.4 + p * 0.6);
      }
    };
    ff.on('progress', onp);
    try {
      if (onStatus) onStatus('GIF로 변환 중…');
      await ff.writeFile(inName, new Uint8Array(await blob.arrayBuffer()));
      const vf = `fps=${fps},scale='min(${width}\\,iw)':-1:flags=lanczos`;
      await ff.exec(['-i', inName, '-vf', vf + ',palettegen=stats_mode=diff', 'pal.png']);
      phase = 1;
      await ff.exec([
        '-i', inName, '-i', 'pal.png',
        '-lavfi', vf + '[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
        'out.gif',
      ]);
      const data = await ff.readFile('out.gif');
      if (!data || !data.length) throw new Error('empty output');
      if (onProgress) onProgress(1);
      return new Blob([data.buffer], { type: 'image/gif' });
    } finally {
      ff.off('progress', onp);
      await cleanupFiles(ff, files);
    }
  }

  /* Extract the audio track to MP3. Throws when the source has no audio. */
  async function toMp3(blob, { onProgress, onStatus } = {}) {
    const ff = await load(onStatus);
    const inName = 'in.' + extOf(blob.type);
    const files = [inName, 'out.mp3'];
    const onp = (e) => {
      if (onProgress && isFinite(e.progress)) {
        onProgress(Math.min(1, Math.max(0, e.progress)));
      }
    };
    ff.on('progress', onp);
    try {
      if (onStatus) onStatus('MP3 추출 중…');
      await ff.writeFile(inName, new Uint8Array(await blob.arrayBuffer()));
      await ff.exec(['-i', inName, '-vn', '-c:a', 'libmp3lame', '-b:a', '192k', 'out.mp3']);
      const data = await ff.readFile('out.mp3');
      if (!data || !data.length) throw new Error('empty output');
      return new Blob([data.buffer], { type: 'audio/mpeg' });
    } finally {
      ff.off('progress', onp);
      await cleanupFiles(ff, files);
    }
  }

  /* Merge same-codec clips without re-encoding (stream copy). Returns the
     merged blob, or throws — caller falls back to the realtime renderer.
     webm inputs are first remuxed (still stream copy) so the concat demuxer
     sees proper duration headers. */
  async function concatCopy(blobs, mimeType, { onProgress, onStatus } = {}) {
    const ff = await load(onStatus);
    const ext = extOf(mimeType);
    const files = ['list.txt', 'out.' + ext];
    try {
      if (onStatus) onStatus('클립 합치는 중… (재인코딩 없음)');
      const listLines = [];
      for (let i = 0; i < blobs.length; i++) {
        const raw = `raw${i}.${ext}`;
        const fixed = `c${i}.${ext}`;
        files.push(raw, fixed);
        await ff.writeFile(raw, new Uint8Array(await blobs[i].arrayBuffer()));
        // rewrite the container so duration/cues are present
        await ff.exec(['-i', raw, '-c', 'copy', fixed]);
        listLines.push(`file '${fixed}'`);
        if (onProgress) onProgress((i + 1) / (blobs.length + 1) * 0.9);
      }
      await ff.writeFile('list.txt', new TextEncoder().encode(listLines.join('\n')));
      await ff.exec(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'out.' + ext]);
      const data = await ff.readFile('out.' + ext);
      if (!data || !data.length) throw new Error('empty output');
      if (onProgress) onProgress(1);
      return new Blob([data.buffer], { type: ext === 'mp4' ? 'video/mp4' : 'video/webm' });
    } finally {
      await cleanupFiles(ff, files);
    }
  }

  window.Transcode = { load, toMp4, toGif, toMp3, concatCopy, isLoaded: () => !!ffmpeg };
})();
