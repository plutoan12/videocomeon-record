/* App wiring: views, settings, record flow, library, preview.
   Exposes window.App for the editor (js/editor.js). */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /* ---------------- settings ---------------- */
  const SETTINGS_KEY = 'vcr-settings';
  const settings = Object.assign(
    { quality: '1080', fps: 30, countdown: 3, mic: true, format: 'auto' },
    loadSettings()
  );

  function loadSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  function syncSettingsUI() {
    $('btn-quality').textContent = settings.quality === 'auto' ? 'Auto' : settings.quality + 'P';
    $('btn-fps').textContent = settings.fps + ' FPS';
    $('set-quality').value = settings.quality;
    $('set-fps').value = String(settings.fps);
    $('set-countdown').value = String(settings.countdown);
    $('set-mic').value = settings.mic ? 'on' : 'off';
    $('set-format').value = settings.format;
    $('btn-mic').classList.toggle('mic-on', settings.mic);
  }

  /* ---------------- views ---------------- */
  const views = ['view-home', 'view-videos', 'view-edit', 'view-preview'];
  function show(viewId) {
    views.forEach((id) => $(id).classList.toggle('active', id === viewId));
    if (viewId !== 'view-preview') unloadPreview();
  }

  /* ---------------- toast ---------------- */
  let toastTimer = null;
  function toast(msg, ms = 2600) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
  }

  /* ---------------- helpers ---------------- */
  function fmtTimer(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(sec % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }
  function fmtDur(sec) {
    if (!isFinite(sec)) return '--:--';
    sec = Math.round(sec);
    const m = Math.floor(sec / 60);
    const s = String(sec % 60).padStart(2, '0');
    return `${String(m).padStart(2, '0')}:${s}`;
  }
  function extFor(mimeType) {
    return mimeType && mimeType.includes('mp4') ? 'mp4' : 'webm';
  }

  /* Chrome records webm with Infinity duration; probe it via the seek hack. */
  function probeDuration(blob) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      const url = URL.createObjectURL(blob);
      const done = (d) => { URL.revokeObjectURL(url); v.remove(); resolve(isFinite(d) && d > 0 ? d : 0); };
      v.preload = 'metadata';
      v.muted = true;
      v.onerror = () => done(0);
      v.onloadedmetadata = () => {
        if (isFinite(v.duration) && v.duration > 0) { done(v.duration); return; }
        v.currentTime = 1e7;
        v.onseeked = () => done(v.duration);
        setTimeout(() => done(v.duration), 4000);
      };
      v.src = url;
    });
  }

  function makeThumb(blob) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      const url = URL.createObjectURL(blob);
      const done = (data) => { URL.revokeObjectURL(url); v.remove(); resolve(data); };
      const capture = () => {
        try {
          const w = 192;
          const h = Math.max(1, Math.round(w * (v.videoHeight / v.videoWidth || 9 / 16)));
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(v, 0, 0, w, h);
          done(c.toDataURL('image/jpeg', 0.72));
        } catch (e) { done(''); }
      };
      v.preload = 'auto';
      v.muted = true;
      v.playsInline = true;
      v.onerror = () => done('');
      v.onloadeddata = () => {
        v.currentTime = 0.1;
        v.onseeked = capture;
        setTimeout(capture, 3000);
      };
      v.src = url;
    });
  }

  async function nextName() {
    const d = new Date();
    const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const items = await VideoDB.all();
    const n = items.filter((it) => it.name && it.name.startsWith(day)).length + 1;
    return `${day}-${n}`;
  }

  /* ---------------- record flow ---------------- */
  const recorder = new ScreenRecorder();
  let timerInterval = null;
  let recStartTs = 0;
  let pausedTotal = 0;
  let pauseStartTs = 0;

  function setRecordingUI(on) {
    $('btn-record').classList.toggle('recording', on);
    $('btn-record').setAttribute('aria-label', on ? 'Stop recording' : 'Start recording');
    $('btn-pause').classList.toggle('hidden', !on);
    $('btn-mic').classList.toggle('hidden', on);
    $('rec-hint').textContent = on ? 'Tap to Stop' : 'Tap to Start';
    if (!on) {
      $('ic-pause').classList.remove('hidden');
      $('ic-resume').classList.add('hidden');
    }
  }

  function startTimer() {
    recStartTs = performance.now();
    pausedTotal = 0;
    updateTimer();
    timerInterval = setInterval(updateTimer, 250);
  }
  function updateTimer() {
    const elapsed = (performance.now() - recStartTs - pausedTotal) / 1000;
    $('rec-timer').textContent = fmtTimer(elapsed);
  }
  function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  function runCountdown(seconds) {
    if (!seconds) return Promise.resolve();
    const overlay = $('overlay-countdown');
    const num = $('countdown-num');
    overlay.classList.remove('hidden');
    return new Promise((resolve) => {
      let left = seconds;
      num.textContent = left;
      const iv = setInterval(() => {
        left -= 1;
        if (left <= 0) {
          clearInterval(iv);
          overlay.classList.add('hidden');
          resolve();
        } else {
          num.textContent = left;
        }
      }, 1000);
    });
  }

  async function onRecordButton() {
    if (recorder.state === 'recording' || recorder.state === 'paused') {
      recorder.stop();
      return;
    }
    if (recorder.state !== 'idle') return;

    if (!ScreenRecorder.isSupported()) {
      toast('이 브라우저는 화면 녹화를 지원하지 않습니다. 데스크톱 Chrome/Edge/Firefox를 사용해 주세요.');
      return;
    }

    try {
      const info = await recorder.acquire({
        quality: settings.quality,
        fps: settings.fps,
        mic: settings.mic,
      });
      if (info.micFailed) toast('마이크를 사용할 수 없어 화면 소리만 녹음합니다.');
    } catch (err) {
      if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
        toast('화면 선택이 취소되었습니다.');
      } else {
        toast('녹화를 시작할 수 없습니다: ' + (err && err.message ? err.message : err));
      }
      return;
    }

    await runCountdown(settings.countdown);
    if (recorder.state !== 'ready') return; // stopped during countdown

    recorder.begin({ quality: settings.quality });
    setRecordingUI(true);
    startTimer();
  }

  function onPauseButton() {
    if (recorder.state === 'recording') {
      recorder.pause();
      pauseStartTs = performance.now();
      stopTimer();
      $('ic-pause').classList.add('hidden');
      $('ic-resume').classList.remove('hidden');
      $('rec-hint').textContent = 'Paused';
    } else if (recorder.state === 'paused') {
      recorder.resume();
      pausedTotal += performance.now() - pauseStartTs;
      timerInterval = setInterval(updateTimer, 250);
      $('ic-pause').classList.remove('hidden');
      $('ic-resume').classList.add('hidden');
      $('rec-hint').textContent = 'Tap to Stop';
    }
  }

  recorder.onstopped = async (result) => {
    stopTimer();
    setRecordingUI(false);
    $('rec-timer').textContent = '00:00:00';

    if (!result || !result.blob || !result.blob.size) return;

    toast('저장 중…');
    try {
      const [duration, thumb, name] = await Promise.all([
        probeDuration(result.blob),
        makeThumb(result.blob),
        nextName(),
      ]);
      const item = {
        name,
        blob: result.blob,
        mimeType: result.mimeType,
        duration,
        width: result.width,
        height: result.height,
        createdAt: Date.now(),
        thumb,
        edited: false,
      };
      item.id = await VideoDB.add(item);
      openPreview(item);
    } catch (err) {
      toast('저장 실패: ' + (err && err.message ? err.message : err));
    }
  };

  /* ---------------- preview ---------------- */
  let previewItem = null;
  let previewUrl = null;

  function openPreview(item) {
    previewItem = item;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(item.blob);
    const v = $('pv-video');
    v.src = previewUrl;
    // webm duration fix so the seek bar works
    v.onloadedmetadata = () => {
      if (v.duration === Infinity) {
        v.currentTime = 1e7;
        v.onseeked = () => { v.onseeked = null; v.currentTime = 0; };
      }
    };
    show('view-preview');
  }

  function unloadPreview() {
    const v = $('pv-video');
    v.pause();
    v.removeAttribute('src');
    v.load();
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    previewItem = null;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('다운로드를 시작했습니다.');
  }

  function downloadItem(item) {
    downloadBlob(item.blob, `${item.name}.${extFor(item.mimeType)}`);
  }

  async function shareItem(item) {
    const file = new File([item.blob], `${item.name}.${extFor(item.mimeType)}`, { type: item.mimeType });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: item.name });
      } catch (e) { /* user cancelled */ }
    } else {
      toast('이 브라우저는 파일 공유를 지원하지 않습니다. SAVE로 다운로드해 주세요.');
    }
  }

  /* ---------------- MP4 conversion (ffmpeg.wasm, lazy) ---------------- */
  function setConvertProgress(p) {
    $('export-bar').style.width = (p * 100).toFixed(1) + '%';
    $('export-pct').textContent = Math.round(p * 100) + '%';
  }

  /* Convert a blob to H.264+AAC mp4 with the progress overlay.
     mediabunny (WebCodecs, no 32MB engine download) is tried first;
     ffmpeg.wasm remains the fallback for browsers without WebCodecs.
     Returns {blob, mimeType}; falls back to the original on failure. */
  async function ensureMp4(blob) {
    if (!blob.type || blob.type.includes('mp4')) {
      return { blob, mimeType: blob.type || 'video/mp4' };
    }
    if (!window.MBMedia && !window.Transcode) return { blob, mimeType: blob.type };
    $('export-title').textContent = 'MP4로 변환 중…';
    $('overlay-export').classList.remove('hidden');
    setConvertProgress(0);
    try {
      if (window.MBMedia && MBMedia.canEncodeMp4()) {
        try {
          const out = await MBMedia.toMp4(blob, { onProgress: setConvertProgress });
          return { blob: out, mimeType: 'video/mp4' };
        } catch (err) {
          console.warn('mediabunny mp4 conversion failed, falling back to ffmpeg:', err);
          setConvertProgress(0);
        }
      }
      if (!window.Transcode) throw new Error('WebCodecs 미지원');
      const out = await Transcode.toMp4(blob, {
        onProgress: setConvertProgress,
        onStatus: (s) => { $('export-title').textContent = s; },
      });
      return { blob: out, mimeType: 'video/mp4' };
    } catch (err) {
      toast('MP4 변환에 실패해 원본 형식을 유지합니다: ' + (err && err.message ? err.message : err));
      return { blob, mimeType: blob.type };
    } finally {
      $('overlay-export').classList.add('hidden');
      $('export-title').textContent = 'Exporting…';
    }
  }

  /* ---------------- GIF / MP3 conversion (ffmpeg.wasm, lazy) ---------------- */
  let convertBusy = false;

  /* Run one Transcode job with the progress overlay; returns the blob or null. */
  async function runConvert(title, job) {
    if (!window.Transcode || convertBusy) return null;
    convertBusy = true;
    $('export-title').textContent = title;
    $('overlay-export').classList.remove('hidden');
    setConvertProgress(0);
    try {
      return await job({
        onProgress: setConvertProgress,
        onStatus: (s) => { $('export-title').textContent = s; },
      });
    } finally {
      convertBusy = false;
      $('overlay-export').classList.add('hidden');
      $('export-title').textContent = 'Exporting…';
    }
  }

  async function exportGif(item) {
    if (item.duration > 30 && !confirm(
      `영상이 ${Math.round(item.duration)}초입니다. GIF는 길이가 길수록 파일이 매우 커집니다.\n전체를 GIF로 만들까요? (긴 영상은 Edit에서 잘라낸 뒤 변환하는 것을 권장)`
    )) return;
    try {
      const blob = await runConvert('GIF로 변환 중…', (cb) => Transcode.toGif(item.blob, cb));
      if (blob) downloadBlob(blob, `${item.name}.gif`);
    } catch (err) {
      toast('GIF 변환 실패: ' + (err && err.message ? err.message : err));
    }
  }

  async function extractMp3(item) {
    try {
      const blob = await runConvert('MP3 추출 중…', (cb) => Transcode.toMp3(item.blob, cb));
      if (blob) downloadBlob(blob, `${item.name}.mp3`);
    } catch (err) {
      toast('MP3 추출 실패 — 오디오 트랙이 없는 영상일 수 있습니다.');
    }
  }

  /* ---------------- import ---------------- */
  async function importVideoFile(file) {
    if (!file.type.startsWith('video/')) {
      toast('영상 파일이 아닙니다.');
      return;
    }
    toast('불러오는 중…');
    const [duration, thumb] = await Promise.all([probeDuration(file), makeThumb(file)]);
    if (!duration) {
      toast('이 브라우저에서 재생할 수 없는 형식입니다.');
      return;
    }
    const base = (file.name || 'video').replace(/\.[^.]+$/, '') || 'video';
    const items = await VideoDB.all();
    const names = new Set(items.map((i) => i.name));
    let name = base;
    for (let n = 2; names.has(name); n++) name = `${base}(${n})`;
    const item = {
      name,
      blob: file,
      mimeType: file.type,
      duration,
      width: 0,
      height: 0,
      createdAt: Date.now(),
      thumb,
      edited: false,
    };
    item.id = await VideoDB.add(item);
    renderLibrary();
    toast('영상을 가져왔습니다.', 1600);
  }

  /* ---------------- merge clips ---------------- */
  let mergeMode = false;
  let mergeSel = []; // item ids in selection order
  let mergeToken = null;

  function setMergeMode(on) {
    mergeMode = on;
    mergeSel = [];
    $('merge-bar').classList.toggle('hidden', !on);
    updateMergeBar();
    renderLibrary();
  }

  function updateMergeBar() {
    const go = $('merge-go');
    go.textContent = `Merge (${mergeSel.length})`;
    go.disabled = mergeSel.length < 2;
  }

  function loadClipVideo(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const v = document.createElement('video');
      v.preload = 'auto';
      v.playsInline = true;
      v.onloadedmetadata = async () => {
        if (!isFinite(v.duration) || v.duration <= 0) {
          await new Promise((res) => { v.onseeked = res; v.currentTime = 1e7; setTimeout(res, 3000); });
          await new Promise((res) => { v.onseeked = res; v.currentTime = 0; setTimeout(res, 3000); });
        }
        resolve({ v, url, duration: isFinite(v.duration) ? v.duration : 0 });
      };
      v.onerror = () => resolve({ v, url, duration: 0 });
      v.src = url;
    });
  }

  async function saveMerged(blob, type, width, height, expectedDuration) {
    if (settings.format === 'mp4' && type && !type.includes('mp4')) {
      const conv = await ensureMp4(blob);
      blob = conv.blob;
      type = conv.mimeType;
    }
    let [duration, thumb] = await Promise.all([probeDuration(blob), makeThumb(blob)]);
    if (!duration) duration = expectedDuration || 0;
    const d = new Date();
    const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const all = await VideoDB.all();
    const n = all.filter((it) => it.name && it.name.startsWith(day + '-merge')).length + 1;
    const item = {
      name: `${day}-merge-${n}`,
      blob,
      mimeType: type,
      duration,
      width,
      height,
      createdAt: Date.now(),
      thumb,
      edited: false,
    };
    item.id = await VideoDB.add(item);
    setMergeMode(false);
    openPreview(item);
  }

  async function mergeClips(ids) {
    if (mergeToken) return;
    const token = { cancel: false };
    mergeToken = token;
    $('export-title').textContent = 'Merging…';
    $('overlay-export').classList.remove('hidden');
    $('export-bar').style.width = '0%';
    $('export-pct').textContent = '0%';

    const clips = [];
    try {
      // fast path: same-codec clips concatenate without re-encoding —
      // mediabunny packet copy first (pure JS), then ffmpeg stream copy
      const metaItems = (await Promise.all(ids.map((id) => VideoDB.get(id)))).filter(Boolean);
      const types = new Set(metaItems.map((i) => i.mimeType));
      if (metaItems.length >= 2 && types.size === 1) {
        const expected = metaItems.reduce((a, i) => a + (i.duration || 0), 0);
        if (window.MBMedia) {
          try {
            $('export-title').textContent = '클립 합치는 중… (재인코딩 없음)';
            const blob = await MBMedia.concat(
              metaItems.map((i) => i.blob),
              metaItems[0].mimeType,
              { onProgress: setConvertProgress }
            );
            window.App._lastMergeMethod = 'mb-copy';
            await saveMerged(blob, blob.type, metaItems[0].width || 0, metaItems[0].height || 0, expected);
            return;
          } catch (err) {
            console.warn('mediabunny merge failed, trying ffmpeg:', err);
            $('export-title').textContent = 'Merging…';
            setConvertProgress(0);
          }
        }
        if (window.Transcode) {
          try {
            const blob = await Transcode.concatCopy(
              metaItems.map((i) => i.blob),
              metaItems[0].mimeType,
              {
                onProgress: setConvertProgress,
                onStatus: (s) => { $('export-title').textContent = s; },
              }
            );
            window.App._lastMergeMethod = 'copy';
            await saveMerged(blob, blob.type, metaItems[0].width || 0, metaItems[0].height || 0, expected);
            return;
          } catch (err) {
            // codecs differ in detail or the container resisted — re-encode instead
            $('export-title').textContent = 'Merging…';
            setConvertProgress(0);
          }
        }
      }
      window.App._lastMergeMethod = 'render';
      for (const id of ids) {
        const item = await VideoDB.get(id);
        if (item) clips.push(await loadClipVideo(item.blob));
      }
      const usable = clips.filter((c) => c.duration > 0 && c.v.videoWidth);
      if (usable.length < 2) throw new Error('합칠 수 있는 클립이 2개 미만입니다.');

      const W = usable[0].v.videoWidth - (usable[0].v.videoWidth % 2);
      const H = usable[0].v.videoHeight - (usable[0].v.videoHeight % 2);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(2, W);
      canvas.height = Math.max(2, H);
      const cx = canvas.getContext('2d');

      const actx = new (window.AudioContext || window.webkitAudioContext)();
      await actx.resume().catch(() => {});
      const dest = actx.createMediaStreamDestination();
      usable.forEach((c) => {
        try { actx.createMediaElementSource(c.v).connect(dest); } catch (e) { /* no audio */ }
      });

      const stream = new MediaStream([
        ...canvas.captureStream(30).getVideoTracks(),
        ...dest.stream.getAudioTracks(),
      ]);
      const mimeType = pickMimeType();
      const opts = { videoBitsPerSecond: 8_000_000 };
      if (mimeType) opts.mimeType = mimeType;
      const rec = new MediaRecorder(stream, opts);
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
      const stopped = new Promise((res) => { rec.onstop = res; });

      let current = null;
      let pumping = true;
      const pump = () => {
        if (!pumping) return;
        if (current && current.videoWidth) {
          cx.fillStyle = '#000';
          cx.fillRect(0, 0, canvas.width, canvas.height);
          const s = Math.min(canvas.width / current.videoWidth, canvas.height / current.videoHeight);
          const dw = current.videoWidth * s, dh = current.videoHeight * s;
          cx.drawImage(current, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
        }
        requestAnimationFrame(pump);
      };
      requestAnimationFrame(pump);
      rec.start(500);

      const total = usable.reduce((a, c) => a + c.duration, 0);
      let done = 0;
      for (const clip of usable) {
        if (token.cancel) break;
        current = clip.v;
        clip.v.currentTime = 0;
        await new Promise((res) => { clip.v.onseeked = res; setTimeout(res, 2000); });
        await clip.v.play().catch(() => {});
        await new Promise((res) => {
          const check = () => {
            if (token.cancel || clip.v.ended || clip.v.currentTime >= clip.duration - 0.05) { res(); return; }
            const p = (done + clip.v.currentTime) / total;
            $('export-bar').style.width = (p * 100).toFixed(1) + '%';
            $('export-pct').textContent = Math.round(p * 100) + '%';
            requestAnimationFrame(check);
          };
          check();
        });
        clip.v.pause();
        done += clip.duration;
      }

      pumping = false;
      rec.stop();
      await stopped;
      actx.close().catch(() => {});

      if (!token.cancel && chunks.length) {
        const type = mimeType ? mimeType.split(';')[0] : 'video/webm';
        await saveMerged(new Blob(chunks, { type }), type, canvas.width, canvas.height, total);
      } else if (token.cancel) {
        toast('합치기를 취소했습니다.');
      }
    } catch (err) {
      toast('합치기 실패: ' + (err && err.message ? err.message : err));
    } finally {
      clips.forEach((c) => { c.v.pause(); c.v.removeAttribute('src'); c.v.load(); URL.revokeObjectURL(c.url); });
      $('overlay-export').classList.add('hidden');
      $('export-title').textContent = 'Exporting…';
      mergeToken = null;
    }
  }

  /* ---------------- library ---------------- */
  let libTab = 'recording'; // 'recording' | 'edited'

  const ICONS = {
    save: '<svg viewBox="0 0 24 24"><path d="M11 4h2v9.2l3.6-3.6L18 11l-6 6-6-6 1.4-1.4L11 13.2zM5 19h14v2H5z"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M3 17.2V21h3.8L17.9 9.9l-3.8-3.8L3 17.2zM20.7 7.1a1 1 0 0 0 0-1.4l-2.4-2.4a1 1 0 0 0-1.4 0l-1.9 1.9 3.8 3.8 1.9-1.9z"/></svg>',
    rename: '<svg viewBox="0 0 24 24"><path d="M5 4h14a1 1 0 0 1 1 1v3h-2V6H6v12h12v-2h2v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm7 6h9v4h-9z"/></svg>',
    del: '<svg viewBox="0 0 24 24"><path d="M9 3v1H4v2h16V4h-5V3H9zM6 8v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8H6zm3 2h2v9H9v-9zm4 0h2v9h-2v-9z"/></svg>',
    mp4: '<svg viewBox="0 0 24 24"><path d="M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v12h14V6H5zm2 8.5v-5h1.5l1 2 1-2H12v5h-1.3v-2.7l-.7 1.4h-1l-.7-1.4v2.7H7zm6.2 0v-5h2a1.6 1.6 0 0 1 0 3.2h-.7v1.8h-1.3zm1.3-3h.6a.5.5 0 0 0 0-1h-.6v1z"/></svg>',
    gif: '<svg viewBox="0 0 24 24"><path d="M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm1 2v12h14V6H5z"/><text x="12" y="14.6" text-anchor="middle" font-size="6.5" font-weight="700" font-family="inherit">GIF</text></svg>',
    mp3: '<svg viewBox="0 0 24 24"><path d="M13 4v9.3a3.2 3.2 0 1 0 2 3V8h4V4h-6zM8 6H4v2h4V6zm0 4H4v2h4v-2zm-4 4h3v2H4v-2z"/></svg>',
  };

  async function renderLibrary() {
    const list = $('lib-list');
    const items = (await VideoDB.all()).filter((it) => !!it.edited === (libTab === 'edited'));
    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = libTab === 'edited'
        ? '<div class="lib-empty">편집된 영상이 없습니다.<br>Recording 탭에서 영상의 Edit를 눌러 편집해 보세요.</div>'
        : '<div class="lib-empty">아직 녹화된 영상이 없습니다.<br>홈에서 빨간 버튼을 눌러 녹화를 시작해 보세요.</div>';
      return;
    }
    for (const item of items) {
      const el = document.createElement('div');
      el.className = 'lib-item';

      const thumb = document.createElement('button');
      thumb.className = 'lib-thumb';
      thumb.setAttribute('aria-label', 'Play ' + item.name);
      if (item.thumb) thumb.style.backgroundImage = `url("${item.thumb}")`;
      if (mergeMode) {
        const pos = mergeSel.indexOf(item.id);
        if (pos !== -1) {
          thumb.classList.add('merge-selected');
          const badge = document.createElement('span');
          badge.className = 'merge-badge';
          badge.textContent = pos + 1;
          thumb.appendChild(badge);
        }
        thumb.addEventListener('click', () => {
          const i = mergeSel.indexOf(item.id);
          if (i === -1) mergeSel.push(item.id);
          else mergeSel.splice(i, 1);
          updateMergeBar();
          renderLibrary();
        });
      } else {
        thumb.addEventListener('click', () => openPreview(item));
      }

      const info = document.createElement('div');
      info.className = 'lib-info';

      const row1 = document.createElement('div');
      row1.className = 'lib-row1';
      const nameEl = document.createElement('span');
      nameEl.className = 'lib-name';
      nameEl.textContent = item.name;
      const durEl = document.createElement('span');
      durEl.className = 'lib-dur';
      durEl.textContent = fmtDur(item.duration);
      row1.append(nameEl, durEl);

      const actions = document.createElement('div');
      actions.className = 'lib-actions';
      if ((window.MBMedia || window.Transcode) && item.mimeType && !item.mimeType.includes('mp4')) {
        actions.append(libAction(ICONS.mp4, 'MP4', async () => {
          const conv = await ensureMp4(item.blob);
          if (conv.mimeType.includes('mp4')) {
            downloadItem({ name: item.name, blob: conv.blob, mimeType: 'video/mp4' });
          }
        }));
      }
      if (window.Transcode) {
        actions.append(
          libAction(ICONS.gif, 'GIF', () => exportGif(item)),
          libAction(ICONS.mp3, 'MP3', () => extractMp3(item))
        );
      }
      actions.append(
        libAction(ICONS.save, 'Save', () => downloadItem(item)),
        libAction(ICONS.edit, 'Edit', () => Editor.open(item)),
        libAction(ICONS.rename, 'Rename', async () => {
          const name = prompt('새 이름을 입력하세요.', item.name);
          if (!name || name.trim() === '' || name === item.name) return;
          item.name = name.trim();
          await VideoDB.put(item);
          renderLibrary();
        }),
        libAction(ICONS.del, 'Delete', async () => {
          if (!confirm(`"${item.name}" 을(를) 삭제할까요?`)) return;
          await VideoDB.remove(item.id);
          renderLibrary();
        })
      );

      info.append(row1, actions);
      el.append(thumb, info);
      list.append(el);
    }
  }

  function libAction(iconSvg, label, handler) {
    const b = document.createElement('button');
    b.className = 'lib-act';
    b.innerHTML = iconSvg + `<span>${label}</span>`;
    b.addEventListener('click', handler);
    return b;
  }

  function setLibTab(tab) {
    libTab = tab;
    mergeSel = [];
    updateMergeBar();
    $('tab-recording').classList.toggle('active', tab === 'recording');
    $('tab-edited').classList.toggle('active', tab === 'edited');
    renderLibrary();
  }

  /* ---------------- event wiring ---------------- */
  $('btn-record').addEventListener('click', onRecordButton);
  $('btn-pause').addEventListener('click', onPauseButton);
  $('btn-mic').addEventListener('click', () => {
    settings.mic = !settings.mic;
    saveSettings();
    syncSettingsUI();
    toast(settings.mic ? '마이크 켜짐' : '마이크 꺼짐', 1400);
  });

  $('btn-quality').addEventListener('click', () => {
    const order = ['auto', '720', '1080'];
    settings.quality = order[(order.indexOf(settings.quality) + 1) % order.length];
    saveSettings(); syncSettingsUI();
  });
  $('btn-fps').addEventListener('click', () => {
    settings.fps = settings.fps === 30 ? 60 : 30;
    saveSettings(); syncSettingsUI();
  });

  // settings modal
  $('btn-settings').addEventListener('click', () => $('modal-settings').classList.remove('hidden'));
  $('settings-close').addEventListener('click', () => {
    settings.quality = $('set-quality').value;
    settings.fps = parseInt($('set-fps').value, 10);
    settings.countdown = parseInt($('set-countdown').value, 10);
    settings.mic = $('set-mic').value === 'on';
    settings.format = $('set-format').value;
    saveSettings(); syncSettingsUI();
    $('modal-settings').classList.add('hidden');
  });

  // FAQ modal
  const openFaq = () => $('modal-faq').classList.remove('hidden');
  $('card-faq').addEventListener('click', openFaq);
  $('btn-audio-help').addEventListener('click', openFaq);
  $('faq-close').addEventListener('click', () => $('modal-faq').classList.add('hidden'));

  // library
  $('card-videos').addEventListener('click', () => { renderLibrary(); show('view-videos'); });
  $('lib-back').addEventListener('click', () => { setMergeMode(false); show('view-home'); });
  $('tab-recording').addEventListener('click', () => setLibTab('recording'));
  $('tab-edited').addEventListener('click', () => setLibTab('edited'));

  // import
  $('lib-import').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) importVideoFile(e.target.files[0]);
    e.target.value = '';
  });

  // merge
  $('lib-merge').addEventListener('click', () => setMergeMode(!mergeMode));
  $('merge-cancel').addEventListener('click', () => setMergeMode(false));
  $('merge-go').addEventListener('click', () => {
    if (mergeSel.length >= 2) mergeClips(mergeSel.slice());
  });
  $('export-cancel').addEventListener('click', () => {
    if (mergeToken) mergeToken.cancel = true;
  });

  // preview
  $('pv-back').addEventListener('click', () => { renderLibrary(); show('view-videos'); });
  $('pv-home').addEventListener('click', () => show('view-home'));
  $('pv-save').addEventListener('click', () => { if (previewItem) downloadItem(previewItem); });
  $('pv-share').addEventListener('click', () => { if (previewItem) shareItem(previewItem); });
  $('pv-edit').addEventListener('click', () => {
    if (!previewItem) return;
    const item = previewItem;
    Editor.open(item);
  });
  $('pv-delete').addEventListener('click', async () => {
    if (!previewItem) return;
    if (!confirm(`"${previewItem.name}" 을(를) 삭제할까요?`)) return;
    await VideoDB.remove(previewItem.id);
    renderLibrary();
    show('view-videos');
  });

  // leaving the page while recording
  window.addEventListener('beforeunload', (e) => {
    if (recorder.state === 'recording' || recorder.state === 'paused') {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  syncSettingsUI();

  if (!ScreenRecorder.isSupported()) {
    $('rec-hint').textContent = '이 브라우저는 화면 녹화를 지원하지 않습니다 (데스크톱 브라우저를 사용해 주세요)';
  }

  /* API for the editor module */
  window.App = {
    show, toast, openPreview, renderLibrary, probeDuration, makeThumb, fmtDur,
    ensureMp4,
    getFormat: () => settings.format,
  };
})();
