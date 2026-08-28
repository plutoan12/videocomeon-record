/* Video editor: timeline with trim/split/delete segments, speed, volume,
   rotate, facecam (webcam PIP), background music, voice-over narration,
   text/watermark overlays and undo. Export re-encodes the edited result in
   real time via canvas.captureStream + MediaRecorder.
   Depends on window.App (app.js) for shared helpers, resolved lazily. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const MIN_SEG = 0.2; // seconds
  const UNDO_MAX = 60;

  const E = {
    item: null,
    url: null,
    video: null,       // hidden source element for preview
    duration: 0,
    segments: [],      // [{start, end}] sorted, non-overlapping (kept parts)
    sel: 0,
    playing: false,
    speed: 1,
    volume: 1,         // 0..2
    bgmVolume: 0.6,    // 0..2
    voiceVolume: 1,    // 0..2
    rotate: 0,         // 0/90/180/270
    bgm: null,         // File
    bgmUrl: null,
    bgmEl: null,
    facecam: { enabled: false, x: 0.05, y: 0.07, w: 0.28, aspect: 4 / 3 },
    camStream: null,
    voices: [],        // [{startOut, blob, url, el, duration}] on the OUTPUT timeline
    voiceRec: null,    // active narration recording
    voiceWarned: false, // desync warning shown once per session
    filters: { bright: 100, contrast: 100, saturate: 100, preset: 'none' },
    fadeIn: 0,         // seconds on the output timeline
    fadeOut: 0,
    redoStack: [],
    texts: [],         // [{text, x, y, size, color}] x/y top-left fractions, size = % of width
    wm: null,          // {file, url, img, x, y, w, aspect}
    textStyle: { color: '#ffffff', size: 6 },
    undoStack: [],
    raf: 0,
    exporting: null,
    _urls: new Set(),  // object URLs to revoke on cleanup
  };

  function makeUrl(blob) {
    const u = URL.createObjectURL(blob);
    E._urls.add(u);
    return u;
  }

  /* ---------------- helpers ---------------- */
  function fmtT(t) {
    t = Math.max(0, t || 0);
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(1).padStart(4, '0');
    return `${m}:${s}`;
  }

  function editedTotal() {
    return E.segments.reduce((a, s) => a + (s.end - s.start), 0);
  }

  /* map a source time to the OUTPUT timeline (deleted parts removed, speed applied) */
  function computeOutT(srcT) {
    let out = 0;
    for (const seg of E.segments) {
      if (srcT >= seg.end) out += seg.end - seg.start;
      else if (srcT > seg.start) { out += srcT - seg.start; break; }
      else break;
    }
    return out / E.speed;
  }

  /* narration clips are anchored to the output timeline at record time, so
     cut/speed changes made afterwards shift them — tell the user once */
  function warnVoiceDesync() {
    if (!E.voices.length || E.voiceWarned) return;
    E.voiceWarned = true;
    window.App.toast('나레이션이 있는 상태에서 컷·속도를 바꾸면 나레이션 위치가 어긋날 수 있습니다.', 3600);
  }

  function segmentAt(t) {
    for (let i = 0; i < E.segments.length; i++) {
      if (t >= E.segments[i].start - 0.001 && t <= E.segments[i].end + 0.001) return i;
    }
    return -1;
  }

  function seekTo(v, t) {
    return new Promise((res) => {
      const done = () => { v.removeEventListener('seeked', done); res(); };
      v.addEventListener('seeked', done);
      v.currentTime = t;
      setTimeout(done, 2000);
    });
  }

  /* ---------------- undo ---------------- */
  function snapshot() {
    return {
      segments: E.segments.map((s) => ({ ...s })),
      sel: E.sel,
      speed: E.speed,
      volume: E.volume,
      bgmVolume: E.bgmVolume,
      voiceVolume: E.voiceVolume,
      rotate: E.rotate,
      bgmFile: E.bgm,
      voices: E.voices.slice(),
      texts: E.texts.map((t) => ({ ...t })),
      wm: E.wm ? { ...E.wm } : null,
      filters: { ...E.filters },
      fadeIn: E.fadeIn,
      fadeOut: E.fadeOut,
    };
  }

  function pushUndo() {
    E.undoStack.push(snapshot());
    if (E.undoStack.length > UNDO_MAX) E.undoStack.shift();
    E.redoStack = []; // a new action invalidates the redo history
    updateUndoBtn();
  }

  function undo() {
    const snap = E.undoStack.pop();
    if (!snap) return;
    E.redoStack.push(snapshot());
    restoreSnap(snap);
  }

  function redo() {
    const snap = E.redoStack.pop();
    if (!snap) return;
    E.undoStack.push(snapshot());
    restoreSnap(snap);
  }

  function restoreSnap(snap) {
    pause();
    E.segments = snap.segments;
    E.sel = Math.min(snap.sel, E.segments.length - 1);
    E.speed = snap.speed;
    E.volume = snap.volume;
    E.bgmVolume = snap.bgmVolume;
    E.voiceVolume = snap.voiceVolume;
    const rotChanged = E.rotate !== snap.rotate;
    E.rotate = snap.rotate;
    E.voices = snap.voices;
    E.texts = snap.texts;
    E.wm = snap.wm;
    E.filters = { ...snap.filters };
    E.fadeIn = snap.fadeIn;
    E.fadeOut = snap.fadeOut;
    if (snap.bgmFile !== E.bgm) setBgm(snap.bgmFile);
    if (E.video) {
      E.video.playbackRate = E.speed;
      E.video.volume = clamp(E.volume, 0, 1);
      E.video.muted = E.volume === 0;
      const i = segmentAt(E.video.currentTime);
      if (i === -1 && E.segments.length) E.video.currentTime = E.segments[E.sel].start;
    }
    if (rotChanged) setCanvasSize();
    renderTimeline();
    renderTexts();
    renderVoiceList();
    layoutWm();
    syncControlsUI();
    updateUndoBtn();
  }

  function updateUndoBtn() {
    $('edit-undo').disabled = E.undoStack.length === 0;
    $('edit-redo').disabled = E.redoStack.length === 0;
  }

  /* ---------------- filters / fade ---------------- */
  function isDefaultFilter() {
    const f = E.filters;
    return f.bright === 100 && f.contrast === 100 && f.saturate === 100 && f.preset === 'none';
  }

  function filterString() {
    const f = E.filters;
    let s = `brightness(${f.bright}%) contrast(${f.contrast}%) saturate(${f.saturate}%)`;
    if (f.preset === 'gray') s += ' grayscale(1)';
    else if (f.preset === 'sepia') s += ' sepia(1)';
    return s;
  }

  /* 0..1 opacity/volume multiplier at an output-timeline position */
  function fadeFactor(outT) {
    const total = editedTotal() / E.speed;
    let f = 1;
    if (E.fadeIn > 0 && outT < E.fadeIn) f = Math.min(f, outT / E.fadeIn);
    if (E.fadeOut > 0 && outT > total - E.fadeOut) f = Math.min(f, Math.max(0, (total - outT) / E.fadeOut));
    return clamp(f, 0, 1);
  }

  /* ---------------- open / close ---------------- */
  async function open(item) {
    cleanup(); // in case a previous session is live
    E.item = item;
    E.url = makeUrl(item.blob);
    E.segments = [];
    E.sel = 0;
    E.speed = 1; E.volume = 1; E.bgmVolume = 0.6; E.voiceVolume = 1; E.rotate = 0;
    E.playing = false;
    E.voiceWarned = false;
    E.filters = { bright: 100, contrast: 100, saturate: 100, preset: 'none' };
    E.fadeIn = 0; E.fadeOut = 0;
    E.redoStack = [];

    const v = document.createElement('video');
    v.playsInline = true;
    v.preload = 'auto';
    v.src = E.url;
    E.video = v;

    window.App.show('view-edit');
    window.App.toast('불러오는 중…', 1200);

    await new Promise((res) => {
      v.onloadedmetadata = res;
      v.onerror = res;
      setTimeout(res, 5000);
    });

    let dur = v.duration;
    if (!isFinite(dur) || dur <= 0) {
      // webm from MediaRecorder: force duration via the seek hack
      await seekTo(v, 1e7);
      dur = v.duration;
      await seekTo(v, 0);
    }
    if (!isFinite(dur) || dur <= 0) dur = E.item.duration || 0;
    E.duration = dur;
    E.segments = [{ start: 0, end: dur }];

    syncControlsUI();
    setBgm(null);
    renderTexts();
    renderVoiceList();
    updateUndoBtn();
    $('tool-facecam').classList.remove('active');
    setCanvasSize();
    renderTimeline();
    updateLabels();
    await seekTo(v, 0);
    startLoop();
    buildStrip();
  }

  function cleanup() {
    stopLoop();
    if (E.voiceRec) finishVoiceRec();
    if (E.video) { E.video.pause(); E.video.removeAttribute('src'); E.video.load(); E.video = null; }
    if (E.bgmEl) { E.bgmEl.pause(); E.bgmEl = null; }
    E.voices.forEach((vc) => { if (vc.el) vc.el.pause(); });
    E.voices = [];
    E.texts = [];
    E.wm = null;
    E.bgm = null; E.bgmUrl = null;
    E.undoStack = [];
    E.redoStack = [];
    disableFacecam();
    E.playing = false;
    E.url = null;
    E._urls.forEach((u) => URL.revokeObjectURL(u));
    E._urls.clear();
    $('facecam-box').classList.add('hidden');
    $('wm-box').classList.add('hidden');
    $('text-layer').innerHTML = '';
    closeSheets();
  }

  function closeEditor() {
    cleanup();
    window.App.renderLibrary();
    window.App.show('view-videos');
  }

  /* ---------------- canvas preview ---------------- */
  function setCanvasSize() {
    const c = $('edit-canvas');
    const vw = E.video.videoWidth || 1280;
    const vh = E.video.videoHeight || 720;
    const swap = E.rotate === 90 || E.rotate === 270;
    c.width = swap ? vh : vw;
    c.height = swap ? vw : vh;
    layoutOverlays();
  }

  function drawFrame(ctx, c, v) {
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.save();
    if (!isDefaultFilter()) ctx.filter = filterString();
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((E.rotate * Math.PI) / 180);
    ctx.drawImage(v, -vw / 2, -vh / 2, vw, vh);
    ctx.restore();
    const f = fadeFactor(computeOutT(v.currentTime));
    if (f < 1) {
      ctx.fillStyle = `rgba(0,0,0,${(1 - f).toFixed(3)})`;
      ctx.fillRect(0, 0, c.width, c.height);
    }
  }

  function startLoop() {
    stopLoop();
    const c = $('edit-canvas');
    const ctx = c.getContext('2d');
    const tick = () => {
      const v = E.video;
      if (!v) return;
      if (E.playing) {
        const i = segmentAt(v.currentTime);
        const seg = E.segments[Math.max(0, i)];
        if (v.ended || (seg && v.currentTime >= seg.end - 0.02)) {
          const curIdx = i === -1 ? E.segments.length - 1 : i;
          if (curIdx < E.segments.length - 1) {
            v.currentTime = E.segments[curIdx + 1].start;
          } else {
            pause();
            v.currentTime = E.segments[0].start;
          }
        } else if (i === -1) {
          // fell into a deleted gap: jump to the next kept segment
          const next = E.segments.find((s) => s.start > v.currentTime);
          if (next) v.currentTime = next.start;
          else { pause(); v.currentTime = E.segments[0].start; }
        }
        if (E.playing) {
          const outT = computeOutT(v.currentTime);
          syncVoicePreview(outT);
          // fade audio along with the picture
          const f = fadeFactor(outT);
          v.volume = clamp(E.volume, 0, 1) * f;
          if (E.bgmEl && !E.bgmEl.paused) E.bgmEl.volume = clamp(E.bgmVolume, 0, 1) * f;
          E.voices.forEach((vc) => {
            if (vc.el && !vc.el.paused) vc.el.volume = clamp(E.voiceVolume, 0, 1) * f;
          });
        }
      }
      drawFrame(ctx, c, v);
      positionPlayhead();
      E.raf = requestAnimationFrame(tick);
    };
    E.raf = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (E.raf) cancelAnimationFrame(E.raf);
    E.raf = 0;
  }

  /* content box of the video inside the stage (letterboxing-aware) */
  function contentBox() {
    const stage = $('edit-stage');
    const c = $('edit-canvas');
    const sw = stage.clientWidth, sh = stage.clientHeight;
    if (!c.width || !c.height || !sw || !sh) return { left: 0, top: 0, width: sw, height: sh };
    const scale = Math.min(sw / c.width, sh / c.height);
    const w = c.width * scale, h = c.height * scale;
    return { left: (sw - w) / 2, top: (sh - h) / 2, width: w, height: h };
  }

  function layoutOverlays() {
    layoutFacecam();
    layoutWm();
    renderTexts();
  }

  /* ---------------- playback ---------------- */
  function play() {
    const v = E.video;
    if (!v) return;
    if (segmentAt(v.currentTime) === -1) v.currentTime = E.segments[0].start;
    v.playbackRate = E.speed;
    v.volume = clamp(E.volume, 0, 1);
    v.muted = E.volume === 0;
    v.play().catch(() => {});
    if (E.bgmEl) { E.bgmEl.volume = clamp(E.bgmVolume, 0, 1); E.bgmEl.play().catch(() => {}); }
    E.playing = true;
    $('ic-eplay').classList.add('hidden');
    $('ic-epause').classList.remove('hidden');
    $('edit-play').classList.add('playing');
  }

  function pause() {
    if (E.voiceRec) finishVoiceRec();
    if (E.video) E.video.pause();
    if (E.bgmEl) E.bgmEl.pause();
    E.voices.forEach((vc) => { if (vc.el && !vc.el.paused) vc.el.pause(); });
    E.playing = false;
    $('ic-eplay').classList.remove('hidden');
    $('ic-epause').classList.add('hidden');
    $('edit-play').classList.remove('playing');
  }

  function togglePlay() { E.playing ? pause() : play(); }

  /* ---------------- voice-over ---------------- */
  async function toggleVoiceRec() {
    if (E.voiceRec) { pause(); return; } // pause() finishes the recording
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      window.App.toast('마이크를 사용할 수 없습니다: ' + (err && err.name ? err.name : err));
      return;
    }
    const rec = new MediaRecorder(stream);
    const vr = {
      rec,
      stream,
      chunks: [],
      startOut: computeOutT(E.video.currentTime),
      t0: performance.now(),
    };
    rec.ondataavailable = (e) => { if (e.data && e.data.size) vr.chunks.push(e.data); };
    rec.onstop = () => {
      const duration = (performance.now() - vr.t0) / 1000;
      if (!vr.chunks.length || duration < 0.3) return;
      const blob = new Blob(vr.chunks, { type: rec.mimeType || 'audio/webm' });
      pushUndo();
      const url = makeUrl(blob);
      const el = new Audio(url);
      el.preload = 'auto';
      E.voices.push({ startOut: vr.startOut, blob, url, el, duration });
      renderVoiceList();
      window.App.toast('나레이션이 추가되었습니다.', 1600);
    };
    E.voiceRec = vr;
    rec.start(250);
    $('btn-voice-rec').textContent = '■ 녹음 종료';
    $('tool-voice').classList.add('active');
    play();
  }

  /* stop the mic; clip is appended in rec.onstop */
  function finishVoiceRec() {
    const vr = E.voiceRec;
    E.voiceRec = null;
    try { vr.rec.stop(); } catch (e) {}
    vr.stream.getTracks().forEach((t) => t.stop());
    $('btn-voice-rec').textContent = '● 녹음 시작';
    $('tool-voice').classList.remove('active');
  }

  function renderVoiceList() {
    const list = $('voice-list');
    list.innerHTML = '';
    if (!E.voices.length) {
      list.innerHTML = '<span class="bgm-name">아직 녹음된 나레이션이 없습니다.</span>';
      return;
    }
    E.voices.forEach((vc, i) => {
      const row = document.createElement('div');
      row.className = 'voice-item';
      const label = document.createElement('span');
      label.textContent = `클립 ${i + 1} · ${fmtT(vc.duration)} @ ${fmtT(vc.startOut)}`;
      const del = document.createElement('button');
      del.className = 'voice-del';
      del.textContent = '✕';
      del.setAttribute('aria-label', 'Delete narration clip');
      del.addEventListener('click', () => {
        pushUndo();
        vc.el.pause();
        E.voices.splice(i, 1);
        renderVoiceList();
      });
      row.append(label, del);
      list.append(row);
    });
  }

  function syncVoicePreview(outT) {
    if (E.voiceRec) return; // never play narration back into the mic
    for (const vc of E.voices) {
      const rel = outT - vc.startOut;
      if (rel >= 0 && rel < vc.duration - 0.05) {
        if (vc.el.paused) {
          vc.el.currentTime = rel;
          vc.el.volume = clamp(E.voiceVolume, 0, 1);
          vc.el.play().catch(() => {});
        }
      } else if (!vc.el.paused) {
        vc.el.pause();
      }
    }
  }

  /* ---------------- text overlays ---------------- */
  function addText() {
    const input = $('text-input');
    const text = input.value.trim();
    if (!text) { window.App.toast('텍스트를 입력해 주세요.', 1400); return; }
    pushUndo();
    E.texts.push({
      text,
      x: 0.32,
      y: 0.42,
      size: E.textStyle.size,
      color: E.textStyle.color,
    });
    input.value = '';
    renderTexts();
  }

  function renderTexts() {
    const layer = $('text-layer');
    layer.innerHTML = '';
    if (!E.texts.length) return;
    const cb = contentBox();
    E.texts.forEach((t, i) => {
      const el = document.createElement('div');
      el.className = 'text-item';
      el.dataset.idx = i;
      el.style.left = (cb.left + t.x * cb.width) + 'px';
      el.style.top = (cb.top + t.y * cb.height) + 'px';
      el.style.fontSize = (t.size / 100 * cb.width) + 'px';
      el.style.color = t.color;
      const span = document.createElement('span');
      span.textContent = t.text;
      const del = document.createElement('button');
      del.className = 'text-del';
      del.textContent = '✕';
      del.setAttribute('aria-label', 'Delete text');
      del.addEventListener('pointerdown', (e) => e.stopPropagation());
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        pushUndo();
        E.texts.splice(i, 1);
        renderTexts();
      });
      el.append(span, del);
      bindTextDrag(el, t);
      layer.append(el);
    });
  }

  function bindTextDrag(el, t) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      pushUndo();
      const cb = contentBox();
      const startX = e.clientX, startY = e.clientY;
      const ox = t.x, oy = t.y;
      const move = (ev) => {
        t.x = clamp(ox + (ev.clientX - startX) / cb.width, 0, 0.95);
        t.y = clamp(oy + (ev.clientY - startY) / cb.height, 0, 0.93);
        el.style.left = (cb.left + t.x * cb.width) + 'px';
        el.style.top = (cb.top + t.y * cb.height) + 'px';
      };
      const up = () => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', up);
        el.removeEventListener('pointercancel', up);
      };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
    });
  }

  /* ---------------- image watermark ---------------- */
  function setWatermark(file) {
    pushUndo();
    const url = makeUrl(file);
    const img = new Image();
    img.onload = () => {
      E.wm = {
        file, url, img,
        x: 0.7, y: 0.06, w: 0.24,
        aspect: (img.naturalWidth / img.naturalHeight) || 1,
      };
      $('wm-img').src = url;
      $('wm-box').classList.remove('hidden');
      $('btn-wm-remove').classList.remove('hidden');
      layoutWm();
    };
    img.onerror = () => window.App.toast('이미지를 불러올 수 없습니다.');
    img.src = url;
  }

  function removeWatermark() {
    if (!E.wm) return;
    pushUndo();
    E.wm = null;
    layoutWm();
  }

  function layoutWm() {
    const box = $('wm-box');
    if (!E.wm) {
      box.classList.add('hidden');
      $('btn-wm-remove').classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    $('btn-wm-remove').classList.remove('hidden');
    if ($('wm-img').getAttribute('src') !== E.wm.url) $('wm-img').src = E.wm.url;
    const cb = contentBox();
    const w = E.wm.w * cb.width;
    const h = w / E.wm.aspect;
    box.style.width = w + 'px';
    box.style.height = h + 'px';
    box.style.left = (cb.left + E.wm.x * cb.width) + 'px';
    box.style.top = (cb.top + E.wm.y * cb.height) + 'px';
  }

  function bindWm() {
    const box = $('wm-box');
    const resize = $('wm-resize');

    box.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.facecam-resize')) return;
      if (!E.wm) return;
      e.preventDefault();
      box.setPointerCapture(e.pointerId);
      pushUndo();
      const cb = contentBox();
      const startX = e.clientX, startY = e.clientY;
      const ox = E.wm.x, oy = E.wm.y;
      const move = (ev) => {
        const hFrac = (E.wm.w * cb.width / E.wm.aspect) / cb.height;
        E.wm.x = clamp(ox + (ev.clientX - startX) / cb.width, 0, 1 - E.wm.w);
        E.wm.y = clamp(oy + (ev.clientY - startY) / cb.height, 0, Math.max(0, 1 - hFrac));
        layoutWm();
      };
      const up = () => {
        box.removeEventListener('pointermove', move);
        box.removeEventListener('pointerup', up);
        box.removeEventListener('pointercancel', up);
      };
      box.addEventListener('pointermove', move);
      box.addEventListener('pointerup', up);
      box.addEventListener('pointercancel', up);
    });

    resize.addEventListener('pointerdown', (e) => {
      if (!E.wm) return;
      e.preventDefault();
      e.stopPropagation();
      resize.setPointerCapture(e.pointerId);
      pushUndo();
      const cb = contentBox();
      const move = (ev) => {
        const rect = $('wm-box').getBoundingClientRect();
        const w = clamp((ev.clientX - rect.left) / cb.width, 0.06, 0.7);
        E.wm.w = Math.min(w, 1 - E.wm.x);
        layoutWm();
      };
      const up = () => {
        resize.removeEventListener('pointermove', move);
        resize.removeEventListener('pointerup', up);
        resize.removeEventListener('pointercancel', up);
      };
      resize.addEventListener('pointermove', move);
      resize.addEventListener('pointerup', up);
      resize.addEventListener('pointercancel', up);
    });
  }

  /* ---------------- timeline ---------------- */
  async function buildStrip() {
    const tl = $('timeline');
    const strip = $('tl-strip');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = Math.max(1, Math.round(tl.clientWidth * dpr));
    const H = Math.max(1, Math.round(tl.clientHeight * dpr));
    strip.width = W; strip.height = H;
    const ctx = strip.getContext('2d');
    ctx.fillStyle = '#242426';
    ctx.fillRect(0, 0, W, H);

    if (!E.duration) return;
    const v = document.createElement('video');
    v.muted = true; v.preload = 'auto'; v.playsInline = true;
    v.src = E.url;
    await new Promise((res) => { v.onloadeddata = res; v.onerror = res; setTimeout(res, 4000); });
    if (!v.videoWidth) return;
    const n = 10;
    const tileW = W / n;
    const myUrl = E.url;
    for (let i = 0; i < n; i++) {
      if (E.url !== myUrl) break; // editor was closed/reopened
      const t = Math.min(E.duration * (i + 0.5) / n, Math.max(0, E.duration - 0.05));
      await seekTo(v, t);
      try {
        const scale = Math.max(tileW / v.videoWidth, H / v.videoHeight);
        const dw = v.videoWidth * scale, dh = v.videoHeight * scale;
        ctx.drawImage(v, i * tileW + (tileW - dw) / 2, (H - dh) / 2, dw, dh);
      } catch (e) { /* keep going */ }
    }
    v.removeAttribute('src'); v.load();
  }

  function renderTimeline() {
    const ov = $('tl-overlays');
    ov.innerHTML = '';
    const dur = E.duration || 1;
    const addBox = (cls, a, b) => {
      const d = document.createElement('div');
      d.className = cls;
      d.style.left = (a / dur * 100) + '%';
      d.style.width = (Math.max(0, b - a) / dur * 100) + '%';
      ov.appendChild(d);
      return d;
    };
    // deleted gaps
    let cursor = 0;
    for (const seg of E.segments) {
      if (seg.start > cursor + 0.01) addBox('tl-del', cursor, seg.start);
      cursor = seg.end;
    }
    if (cursor < dur - 0.01) addBox('tl-del', cursor, dur);
    // segment boundaries (clickable) + selected highlight
    E.segments.forEach((seg, i) => {
      const d = addBox('tl-seg' + (i === E.sel ? ' sel' : ''), seg.start, seg.end);
      d.dataset.idx = i;
    });
    // handles on selected segment
    const seg = E.segments[E.sel];
    if (seg) {
      $('tl-handle-l').style.left = (seg.start / dur * 100) + '%';
      $('tl-handle-r').style.left = (seg.end / dur * 100) + '%';
    }
    updateLabels();
  }

  function positionPlayhead() {
    if (!E.video || !E.duration) return;
    $('tl-playhead').style.left = (E.video.currentTime / E.duration * 100) + '%';
  }

  function updateLabels() {
    const seg = E.segments[E.sel] || { start: 0, end: 0 };
    $('edit-t-cur').textContent = fmtT(seg.start);
    $('edit-t-end').textContent = fmtT(seg.end);
    $('edit-t-total').textContent = 'Total ' + fmtT(editedTotal() / E.speed);
  }

  function fracFromEvent(e) {
    const rect = $('timeline').getBoundingClientRect();
    return clamp((e.clientX - rect.left) / rect.width, 0, 1);
  }

  function bindTimeline() {
    const tl = $('timeline');

    // scrub / select
    tl.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.tl-handle')) return;
      tl.setPointerCapture(e.pointerId);
      pause();
      const move = (ev) => {
        const t = fracFromEvent(ev) * E.duration;
        E.video.currentTime = t;
        const i = segmentAt(t);
        if (i !== -1 && i !== E.sel) { E.sel = i; renderTimeline(); }
        positionPlayhead();
      };
      move(e);
      const up = () => {
        tl.removeEventListener('pointermove', move);
        tl.removeEventListener('pointerup', up);
        tl.removeEventListener('pointercancel', up);
      };
      tl.addEventListener('pointermove', move);
      tl.addEventListener('pointerup', up);
      tl.addEventListener('pointercancel', up);
    });

    bindHandle($('tl-handle-l'), 'start');
    bindHandle($('tl-handle-r'), 'end');
  }

  function bindHandle(handle, edge) {
    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      pause();
      pushUndo();
      warnVoiceDesync();
      const move = (ev) => {
        const seg = E.segments[E.sel];
        if (!seg) return;
        let t = fracFromEvent(ev) * E.duration;
        if (edge === 'start') {
          const lo = E.sel > 0 ? E.segments[E.sel - 1].end : 0;
          seg.start = clamp(t, lo, seg.end - MIN_SEG);
          E.video.currentTime = seg.start;
        } else {
          const hi = E.sel < E.segments.length - 1 ? E.segments[E.sel + 1].start : E.duration;
          seg.end = clamp(t, seg.start + MIN_SEG, hi);
          E.video.currentTime = seg.end;
        }
        renderTimeline();
        positionPlayhead();
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  /* ---------------- edit operations ---------------- */
  function split() {
    const t = E.video.currentTime;
    const i = segmentAt(t);
    if (i === -1) { window.App.toast('삭제된 구간에서는 나눌 수 없습니다.'); return; }
    const seg = E.segments[i];
    if (t - seg.start < MIN_SEG || seg.end - t < MIN_SEG) {
      window.App.toast('구간 경계에 너무 가깝습니다.');
      return;
    }
    pushUndo();
    warnVoiceDesync();
    E.segments.splice(i, 1, { start: seg.start, end: t }, { start: t, end: seg.end });
    E.sel = i + 1;
    renderTimeline();
  }

  function deleteSel() {
    if (E.segments.length <= 1) {
      window.App.toast('마지막 구간은 삭제할 수 없습니다. 핸들로 잘라내 보세요.');
      return;
    }
    pushUndo();
    warnVoiceDesync();
    E.segments.splice(E.sel, 1);
    E.sel = Math.min(E.sel, E.segments.length - 1);
    E.video.currentTime = E.segments[E.sel].start;
    renderTimeline();
  }

  function rotate() {
    pushUndo();
    E.rotate = (E.rotate + 90) % 360;
    setCanvasSize();
    window.App.toast('회전: ' + E.rotate + '°', 1000);
  }

  /* ---------------- facecam ---------------- */
  async function toggleFacecam() {
    if (E.facecam.enabled) { disableFacecam(); return; }
    try {
      E.camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
    } catch (err) {
      window.App.toast('카메라를 사용할 수 없습니다: ' + (err && err.name ? err.name : err));
      return;
    }
    const camV = $('facecam-video');
    camV.srcObject = E.camStream;
    const track = E.camStream.getVideoTracks()[0];
    const s = track.getSettings();
    if (s.width && s.height) E.facecam.aspect = s.width / s.height;
    E.facecam.enabled = true;
    $('facecam-box').classList.remove('hidden');
    $('tool-facecam').classList.add('active');
    layoutFacecam();
    window.App.toast('페이스캠이 켜졌습니다. 드래그로 이동, 모서리로 크기 조절.', 2200);
  }

  function disableFacecam() {
    if (E.camStream) E.camStream.getTracks().forEach((t) => t.stop());
    E.camStream = null;
    E.facecam.enabled = false;
    const camV = $('facecam-video');
    if (camV) camV.srcObject = null;
    const box = $('facecam-box');
    if (box) box.classList.add('hidden');
    const btn = $('tool-facecam');
    if (btn) btn.classList.remove('active');
  }

  function layoutFacecam() {
    if (!E.facecam.enabled) return;
    const cb = contentBox();
    const box = $('facecam-box');
    const w = E.facecam.w * cb.width;
    const h = w / E.facecam.aspect;
    box.style.width = w + 'px';
    box.style.height = h + 'px';
    box.style.left = (cb.left + E.facecam.x * cb.width) + 'px';
    box.style.top = (cb.top + E.facecam.y * cb.height) + 'px';
  }

  function bindFacecam() {
    const box = $('facecam-box');
    const resize = $('facecam-resize');

    box.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.facecam-resize')) return;
      e.preventDefault();
      box.setPointerCapture(e.pointerId);
      const cb = contentBox();
      const startX = e.clientX, startY = e.clientY;
      const ox = E.facecam.x, oy = E.facecam.y;
      const move = (ev) => {
        const hFrac = (E.facecam.w * cb.width / E.facecam.aspect) / cb.height;
        E.facecam.x = clamp(ox + (ev.clientX - startX) / cb.width, 0, 1 - E.facecam.w);
        E.facecam.y = clamp(oy + (ev.clientY - startY) / cb.height, 0, Math.max(0, 1 - hFrac));
        layoutFacecam();
      };
      const up = () => {
        box.removeEventListener('pointermove', move);
        box.removeEventListener('pointerup', up);
        box.removeEventListener('pointercancel', up);
      };
      box.addEventListener('pointermove', move);
      box.addEventListener('pointerup', up);
      box.addEventListener('pointercancel', up);
    });

    resize.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      resize.setPointerCapture(e.pointerId);
      const cb = contentBox();
      const move = (ev) => {
        const rect = $('facecam-box').getBoundingClientRect();
        const w = clamp((ev.clientX - rect.left) / cb.width, 0.12, 0.6);
        E.facecam.w = Math.min(w, 1 - E.facecam.x);
        layoutFacecam();
      };
      const up = () => {
        resize.removeEventListener('pointermove', move);
        resize.removeEventListener('pointerup', up);
        resize.removeEventListener('pointercancel', up);
      };
      resize.addEventListener('pointermove', move);
      resize.addEventListener('pointerup', up);
      resize.addEventListener('pointercancel', up);
    });
  }

  /* ---------------- background music ---------------- */
  function setBgm(file) {
    if (E.bgmEl) { E.bgmEl.pause(); E.bgmEl = null; }
    E.bgm = file || null;
    E.bgmUrl = null;
    if (file) {
      E.bgmUrl = makeUrl(file);
      E.bgmEl = new Audio(E.bgmUrl);
      E.bgmEl.loop = true;
      $('bgm-name').textContent = file.name;
      $('btn-bgm-remove').classList.remove('hidden');
      $('tool-audio').classList.add('active');
    } else {
      $('bgm-name').textContent = 'No music added';
      $('btn-bgm-remove').classList.add('hidden');
      $('tool-audio').classList.remove('active');
    }
  }

  /* ---------------- tool sheets ---------------- */
  const SHEETS = ['sheet-speed', 'sheet-volume', 'sheet-audio', 'sheet-voice', 'sheet-text', 'sheet-filter', 'sheet-fade'];
  function toggleSheet(id) {
    SHEETS.forEach((s) => $(s).classList.toggle('hidden', s !== id || !$(id).classList.contains('hidden')));
  }
  function closeSheets() {
    SHEETS.forEach((s) => $(s).classList.add('hidden'));
  }

  function syncControlsUI() {
    document.querySelectorAll('#speed-chips .chip').forEach((ch) => {
      ch.classList.toggle('active', parseFloat(ch.dataset.speed) === E.speed);
    });
    $('vol-clip').value = Math.round(E.volume * 100);
    $('vol-clip-val').textContent = Math.round(E.volume * 100) + '%';
    $('vol-bgm').value = Math.round(E.bgmVolume * 100);
    $('vol-bgm-val').textContent = Math.round(E.bgmVolume * 100) + '%';
    $('vol-voice').value = Math.round(E.voiceVolume * 100);
    $('vol-voice-val').textContent = Math.round(E.voiceVolume * 100) + '%';
    $('bgm-name').textContent = E.bgm ? E.bgm.name : 'No music added';
    $('btn-bgm-remove').classList.toggle('hidden', !E.bgm);
    $('tool-audio').classList.toggle('active', !!E.bgm);
    // filters
    $('flt-bright').value = E.filters.bright;
    $('flt-bright-val').textContent = E.filters.bright + '%';
    $('flt-contrast').value = E.filters.contrast;
    $('flt-contrast-val').textContent = E.filters.contrast + '%';
    $('flt-sat').value = E.filters.saturate;
    $('flt-sat-val').textContent = E.filters.saturate + '%';
    document.querySelectorAll('#filter-presets .chip').forEach((ch) => {
      ch.classList.toggle('active', ch.dataset.preset === E.filters.preset);
    });
    $('tool-filter').classList.toggle('active', !isDefaultFilter());
    // fades
    document.querySelectorAll('#fade-in-chips .chip').forEach((ch) => {
      ch.classList.toggle('active', parseFloat(ch.dataset.fade) === E.fadeIn);
    });
    document.querySelectorAll('#fade-out-chips .chip').forEach((ch) => {
      ch.classList.toggle('active', parseFloat(ch.dataset.fade) === E.fadeOut);
    });
    $('tool-fade').classList.toggle('active', E.fadeIn > 0 || E.fadeOut > 0);
    updateLabels();
  }

  /* ---------------- export ---------------- */
  async function doExport() {
    if (E.exporting) return;
    pause();
    closeSheets();
    const token = { cancel: false };
    E.exporting = token;
    $('overlay-export').classList.remove('hidden');
    setProgress(0);

    let result = null;
    try {
      result = await renderExport(token, setProgress);
    } catch (err) {
      window.App.toast('내보내기 실패: ' + (err && err.message ? err.message : err));
    }
    $('overlay-export').classList.add('hidden');
    E.exporting = null;

    if (token.cancel || !result || !result.blob || !result.blob.size) {
      if (token.cancel) window.App.toast('내보내기를 취소했습니다.');
      return;
    }

    window.App.toast('저장 중…');
    const App = window.App;
    const [duration, thumb, name] = await Promise.all([
      App.probeDuration(result.blob),
      App.makeThumb(result.blob),
      editedName(),
    ]);
    const newItem = {
      name,
      blob: result.blob,
      mimeType: result.mimeType,
      duration,
      width: result.width,
      height: result.height,
      createdAt: Date.now(),
      thumb,
      edited: true,
    };
    newItem.id = await VideoDB.add(newItem);
    cleanup();
    App.openPreview(newItem);
  }

  async function editedName() {
    const base = (E.item.name || 'clip') + '-edit';
    const items = await VideoDB.all();
    const names = new Set(items.map((i) => i.name));
    if (!names.has(base)) return base;
    let n = 2;
    while (names.has(`${base}(${n})`)) n++;
    return `${base}(${n})`;
  }

  function setProgress(p) {
    p = clamp(p, 0, 1);
    $('export-bar').style.width = (p * 100).toFixed(1) + '%';
    $('export-pct').textContent = Math.round(p * 100) + '%';
  }

  async function renderExport(token, onProgress) {
    const v = document.createElement('video');
    v.playsInline = true;
    v.preload = 'auto';
    v.src = E.url;
    await new Promise((res) => { v.onloadedmetadata = res; v.onerror = res; setTimeout(res, 5000); });
    if (!isFinite(v.duration) || v.duration <= 0) {
      await seekTo(v, 1e7);
      await seekTo(v, 0);
    }

    const vw = v.videoWidth, vh = v.videoHeight;
    const swap = E.rotate === 90 || E.rotate === 270;
    const canvas = document.createElement('canvas');
    canvas.width = swap ? vh : vw;
    canvas.height = swap ? vw : vh;
    const ctx = canvas.getContext('2d');

    const actx = new (window.AudioContext || window.webkitAudioContext)();
    await actx.resume().catch(() => {});
    const dest = actx.createMediaStreamDestination();
    let vgainNode = null;
    try {
      const vsrc = actx.createMediaElementSource(v);
      vgainNode = actx.createGain();
      vgainNode.gain.value = E.volume;
      vsrc.connect(vgainNode).connect(dest);
    } catch (e) { /* no audio track */ }

    let bgmEl = null;
    let bgainNode = null;
    if (E.bgmUrl) {
      bgmEl = new Audio(E.bgmUrl);
      bgmEl.loop = true;
      const bsrc = actx.createMediaElementSource(bgmEl);
      bgainNode = actx.createGain();
      bgainNode.gain.value = E.bgmVolume;
      bsrc.connect(bgainNode).connect(dest);
    }

    // narration clips: fresh elements routed into the mix
    const voiceGain = actx.createGain();
    voiceGain.gain.value = E.voiceVolume;
    voiceGain.connect(dest);
    const voiceEls = E.voices.map((vc) => {
      const el = new Audio(vc.url);
      el.preload = 'auto';
      const src = actx.createMediaElementSource(el);
      src.connect(voiceGain);
      return { el, startOut: vc.startOut, duration: vc.duration };
    });
    const syncVoicesExport = (outT) => {
      for (const vc of voiceEls) {
        const rel = outT - vc.startOut;
        if (rel >= 0 && rel < vc.duration - 0.05) {
          if (vc.el.paused) {
            vc.el.currentTime = rel;
            vc.el.play().catch(() => {});
          }
        } else if (!vc.el.paused) {
          vc.el.pause();
        }
      }
    };

    const camV = E.facecam.enabled ? $('facecam-video') : null;

    const fps = 30;
    const canvasStream = canvas.captureStream(fps);
    const tracks = [...canvasStream.getVideoTracks(), ...dest.stream.getAudioTracks()];
    const mixed = new MediaStream(tracks);

    const mimeType = window.pickMimeType();
    const recOptions = { videoBitsPerSecond: 8_000_000 };
    if (mimeType) recOptions.mimeType = mimeType;
    const rec = new MediaRecorder(mixed, recOptions);
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((res) => { rec.onstop = res; });

    // frame pump
    let pumping = true;
    const pump = () => {
      if (!pumping) return;
      drawExportFrame(ctx, canvas, v, camV);
      requestAnimationFrame(pump);
    };
    requestAnimationFrame(pump);

    rec.start(500);
    if (bgmEl) bgmEl.play().catch(() => {});

    const totalOut = Math.max(0.001, editedTotal() / E.speed);
    let doneOut = 0;

    for (const seg of E.segments) {
      if (token.cancel) break;
      await seekTo(v, seg.start);
      v.playbackRate = E.speed;
      await v.play().catch(() => {});
      await new Promise((res) => {
        const check = () => {
          if (token.cancel || v.ended || v.currentTime >= seg.end - 0.02) { res(); return; }
          const outT = doneOut + (v.currentTime - seg.start) / E.speed;
          syncVoicesExport(outT);
          const f = fadeFactor(outT);
          if (vgainNode) vgainNode.gain.value = E.volume * f;
          if (bgainNode) bgainNode.gain.value = E.bgmVolume * f;
          voiceGain.gain.value = E.voiceVolume * f;
          onProgress(outT / totalOut);
          requestAnimationFrame(check);
        };
        check();
      });
      v.pause();
      doneOut += (seg.end - seg.start) / E.speed;
      onProgress(doneOut / totalOut);
    }

    if (bgmEl) bgmEl.pause();
    voiceEls.forEach((vc) => vc.el.pause());
    pumping = false;
    rec.stop();
    await stopped;
    v.removeAttribute('src'); v.load();
    actx.close().catch(() => {});

    if (token.cancel) return null;
    const type = mimeType ? mimeType.split(';')[0] : 'video/webm';
    return {
      blob: new Blob(chunks, { type }),
      mimeType: type,
      width: canvas.width,
      height: canvas.height,
    };
  }

  function drawExportFrame(ctx, canvas, v, camV) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (v.videoWidth) {
      ctx.save();
      if (!isDefaultFilter()) ctx.filter = filterString();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((E.rotate * Math.PI) / 180);
      ctx.drawImage(v, -v.videoWidth / 2, -v.videoHeight / 2, v.videoWidth, v.videoHeight);
      ctx.restore();
    }
    if (camV && camV.videoWidth) {
      const w = E.facecam.w * canvas.width;
      const h = w / E.facecam.aspect;
      const x = E.facecam.x * canvas.width;
      const y = E.facecam.y * canvas.height;
      ctx.save();
      ctx.beginPath();
      const r = Math.min(w, h) * 0.08;
      ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
      ctx.clip();
      // cover-fit the webcam frame into the PIP box
      const scale = Math.max(w / camV.videoWidth, h / camV.videoHeight);
      const dw = camV.videoWidth * scale, dh = camV.videoHeight * scale;
      ctx.drawImage(camV, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
      ctx.restore();
    }
    if (E.wm && E.wm.img) {
      const w = E.wm.w * canvas.width;
      const h = w / E.wm.aspect;
      ctx.drawImage(E.wm.img, E.wm.x * canvas.width, E.wm.y * canvas.height, w, h);
    }
    for (const t of E.texts) {
      const fontPx = (t.size / 100) * canvas.width;
      ctx.save();
      ctx.font = `700 ${fontPx}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif`;
      ctx.textBaseline = 'top';
      ctx.shadowColor = 'rgba(0,0,0,.55)';
      ctx.shadowBlur = fontPx * 0.12;
      ctx.shadowOffsetY = fontPx * 0.04;
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x * canvas.width, t.y * canvas.height);
      ctx.restore();
    }
    // fade covers the whole composited frame, overlays included
    const f = fadeFactor(computeOutT(v.currentTime));
    if (f < 1) {
      ctx.fillStyle = `rgba(0,0,0,${(1 - f).toFixed(3)})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
  }

  /* ---------------- frame capture ---------------- */
  function captureFrame() {
    if (!E.video || !E.video.videoWidth) {
      window.App.toast('영상이 아직 준비되지 않았습니다.');
      return;
    }
    const ec = $('edit-canvas');
    const c = document.createElement('canvas');
    c.width = ec.width;
    c.height = ec.height;
    const camV = E.facecam.enabled ? $('facecam-video') : null;
    drawExportFrame(c.getContext('2d'), c, E.video, camV);
    c.toBlob((blob) => {
      if (!blob) { window.App.toast('캡처에 실패했습니다.'); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${E.item.name}-frame-${fmtT(E.video.currentTime).replace(':', 'm').replace('.', 's')}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      window.App.toast('현재 장면을 PNG로 저장했습니다.', 1800);
    }, 'image/png');
  }

  /* ---------------- wiring ---------------- */
  let bound = false;
  function bind() {
    if (bound) return;
    bound = true;
    $('edit-back').addEventListener('click', closeEditor);
    $('edit-export').addEventListener('click', doExport);
    $('edit-undo').addEventListener('click', undo);
    $('edit-redo').addEventListener('click', redo);
    $('edit-play').addEventListener('click', togglePlay);
    $('edit-canvas').addEventListener('click', togglePlay);

    $('tool-split').addEventListener('click', split);
    $('tool-delete').addEventListener('click', deleteSel);
    $('tool-rotate').addEventListener('click', rotate);
    $('tool-facecam').addEventListener('click', toggleFacecam);
    $('tool-speed').addEventListener('click', () => toggleSheet('sheet-speed'));
    $('tool-volume').addEventListener('click', () => toggleSheet('sheet-volume'));
    $('tool-audio').addEventListener('click', () => toggleSheet('sheet-audio'));
    $('tool-voice').addEventListener('click', () => toggleSheet('sheet-voice'));
    $('tool-text').addEventListener('click', () => toggleSheet('sheet-text'));
    $('tool-filter').addEventListener('click', () => toggleSheet('sheet-filter'));
    $('tool-fade').addEventListener('click', () => toggleSheet('sheet-fade'));
    $('tool-capture').addEventListener('click', captureFrame);

    // filter controls
    [['flt-bright', 'bright'], ['flt-contrast', 'contrast'], ['flt-sat', 'saturate']].forEach(([id, key]) => {
      $(id).addEventListener('pointerdown', pushUndo);
      $(id).addEventListener('input', (e) => {
        E.filters[key] = parseInt(e.target.value, 10);
        $(id + '-val').textContent = e.target.value + '%';
        $('tool-filter').classList.toggle('active', !isDefaultFilter());
      });
    });
    $('filter-presets').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      pushUndo();
      E.filters.preset = chip.dataset.preset;
      document.querySelectorAll('#filter-presets .chip').forEach((c) => c.classList.toggle('active', c === chip));
      $('tool-filter').classList.toggle('active', !isDefaultFilter());
    });
    $('btn-filter-reset').addEventListener('click', () => {
      pushUndo();
      E.filters = { bright: 100, contrast: 100, saturate: 100, preset: 'none' };
      syncControlsUI();
    });

    // fade controls
    [['fade-in-chips', 'fadeIn'], ['fade-out-chips', 'fadeOut']].forEach(([id, key]) => {
      $(id).addEventListener('click', (e) => {
        const chip = e.target.closest('.chip');
        if (!chip) return;
        pushUndo();
        E[key] = parseFloat(chip.dataset.fade);
        document.querySelectorAll(`#${id} .chip`).forEach((c) => c.classList.toggle('active', c === chip));
        $('tool-fade').classList.toggle('active', E.fadeIn > 0 || E.fadeOut > 0);
      });
    });

    $('speed-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      pushUndo();
      warnVoiceDesync();
      E.speed = parseFloat(chip.dataset.speed);
      if (E.video) E.video.playbackRate = E.speed;
      document.querySelectorAll('#speed-chips .chip').forEach((c) => c.classList.toggle('active', c === chip));
      updateLabels();
    });

    // snapshot slider state once per adjustment, not per input tick
    ['vol-clip', 'vol-bgm', 'vol-voice'].forEach((id) => {
      $(id).addEventListener('pointerdown', pushUndo);
    });
    $('vol-clip').addEventListener('input', (e) => {
      E.volume = e.target.value / 100;
      $('vol-clip-val').textContent = e.target.value + '%';
      if (E.video) { E.video.volume = clamp(E.volume, 0, 1); E.video.muted = E.volume === 0; }
    });
    $('vol-bgm').addEventListener('input', (e) => {
      E.bgmVolume = e.target.value / 100;
      $('vol-bgm-val').textContent = e.target.value + '%';
      if (E.bgmEl) E.bgmEl.volume = clamp(E.bgmVolume, 0, 1);
    });
    $('vol-voice').addEventListener('input', (e) => {
      E.voiceVolume = e.target.value / 100;
      $('vol-voice-val').textContent = e.target.value + '%';
    });

    $('btn-bgm-pick').addEventListener('click', () => $('bgm-file').click());
    $('bgm-file').addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) { pushUndo(); setBgm(e.target.files[0]); }
      e.target.value = '';
    });
    $('btn-bgm-remove').addEventListener('click', () => { pushUndo(); setBgm(null); });

    $('btn-voice-rec').addEventListener('click', toggleVoiceRec);

    $('btn-text-add').addEventListener('click', addText);
    $('text-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addText(); });
    $('emoji-row').addEventListener('click', (e) => {
      const chip = e.target.closest('.emoji-chip');
      if (!chip) return;
      pushUndo();
      E.texts.push({ text: chip.textContent, x: 0.42, y: 0.36, size: 12, color: '#ffffff' });
      renderTexts();
    });
    $('text-colors').addEventListener('click', (e) => {
      const chip = e.target.closest('.color-chip');
      if (!chip) return;
      E.textStyle.color = chip.dataset.color;
      document.querySelectorAll('#text-colors .color-chip').forEach((c) => c.classList.toggle('active', c === chip));
    });
    $('text-size').addEventListener('input', (e) => {
      E.textStyle.size = parseInt(e.target.value, 10);
      $('text-size-val').textContent = e.target.value + '%';
    });

    $('btn-wm-pick').addEventListener('click', () => $('wm-file').click());
    $('wm-file').addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) setWatermark(e.target.files[0]);
      e.target.value = '';
    });
    $('btn-wm-remove').addEventListener('click', removeWatermark);

    $('export-cancel').addEventListener('click', () => {
      if (E.exporting) E.exporting.cancel = true;
    });

    bindTimeline();
    bindFacecam();
    bindWm();
    window.addEventListener('resize', () => { layoutOverlays(); buildStripDebounced(); });
  }

  let stripTimer = null;
  function buildStripDebounced() {
    if (!E.video) return;
    clearTimeout(stripTimer);
    stripTimer = setTimeout(buildStrip, 300);
  }

  document.addEventListener('DOMContentLoaded', bind);
  if (document.readyState !== 'loading') bind();

  window.Editor = { open };
})();
