/* Video editor: timeline with trim/split/delete segments, speed, volume,
   rotate, facecam (webcam PIP) and background music. Export re-encodes the
   edited result in real time via canvas.captureStream + MediaRecorder.
   Depends on window.App (app.js) for shared helpers, resolved lazily. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const MIN_SEG = 0.2; // seconds

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
    rotate: 0,         // 0/90/180/270
    bgm: null,         // File
    bgmUrl: null,
    bgmEl: null,
    facecam: { enabled: false, x: 0.05, y: 0.07, w: 0.28, aspect: 4 / 3 },
    camStream: null,
    raf: 0,
    exporting: null,
  };

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

  /* ---------------- open / close ---------------- */
  async function open(item) {
    cleanup(); // in case a previous session is live
    E.item = item;
    E.url = URL.createObjectURL(item.blob);
    E.segments = [];
    E.sel = 0;
    E.speed = 1; E.volume = 1; E.bgmVolume = 0.6; E.rotate = 0;
    E.playing = false;

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

    syncToolUI();
    setCanvasSize();
    renderTimeline();
    updateLabels();
    await seekTo(v, 0);
    startLoop();
    buildStrip();
  }

  function cleanup() {
    stopLoop();
    if (E.video) { E.video.pause(); E.video.removeAttribute('src'); E.video.load(); E.video = null; }
    if (E.url) { URL.revokeObjectURL(E.url); E.url = null; }
    if (E.bgmEl) { E.bgmEl.pause(); E.bgmEl = null; }
    if (E.bgmUrl) { URL.revokeObjectURL(E.bgmUrl); E.bgmUrl = null; }
    E.bgm = null;
    disableFacecam();
    E.playing = false;
    $('facecam-box').classList.add('hidden');
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
    layoutFacecam();
  }

  function drawFrame(ctx, c, v) {
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.save();
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((E.rotate * Math.PI) / 180);
    ctx.drawImage(v, -vw / 2, -vh / 2, vw, vh);
    ctx.restore();
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
    if (E.video) E.video.pause();
    if (E.bgmEl) E.bgmEl.pause();
    E.playing = false;
    $('ic-eplay').classList.remove('hidden');
    $('ic-epause').classList.add('hidden');
    $('edit-play').classList.remove('playing');
  }

  function togglePlay() { E.playing ? pause() : play(); }

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
    E.segments.splice(i, 1, { start: seg.start, end: t }, { start: t, end: seg.end });
    E.sel = i + 1;
    renderTimeline();
  }

  function deleteSel() {
    if (E.segments.length <= 1) {
      window.App.toast('마지막 구간은 삭제할 수 없습니다. 핸들로 잘라내 보세요.');
      return;
    }
    E.segments.splice(E.sel, 1);
    E.sel = Math.min(E.sel, E.segments.length - 1);
    E.video.currentTime = E.segments[E.sel].start;
    renderTimeline();
  }

  function rotate() {
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
    if (E.bgmUrl) { URL.revokeObjectURL(E.bgmUrl); E.bgmUrl = null; }
    E.bgm = file || null;
    if (file) {
      E.bgmUrl = URL.createObjectURL(file);
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
  const SHEETS = ['sheet-speed', 'sheet-volume', 'sheet-audio'];
  function toggleSheet(id) {
    SHEETS.forEach((s) => $(s).classList.toggle('hidden', s !== id || !$(id).classList.contains('hidden')));
  }
  function closeSheets() {
    SHEETS.forEach((s) => $(s).classList.add('hidden'));
  }

  function syncToolUI() {
    document.querySelectorAll('#speed-chips .chip').forEach((ch) => {
      ch.classList.toggle('active', parseFloat(ch.dataset.speed) === E.speed);
    });
    $('vol-clip').value = Math.round(E.volume * 100);
    $('vol-clip-val').textContent = Math.round(E.volume * 100) + '%';
    $('vol-bgm').value = Math.round(E.bgmVolume * 100);
    $('vol-bgm-val').textContent = Math.round(E.bgmVolume * 100) + '%';
    setBgm(null);
    $('tool-facecam').classList.remove('active');
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
    try {
      const vsrc = actx.createMediaElementSource(v);
      const vgain = actx.createGain();
      vgain.gain.value = E.volume;
      vsrc.connect(vgain).connect(dest);
    } catch (e) { /* no audio track */ }

    let bgmEl = null;
    if (E.bgmUrl) {
      bgmEl = new Audio(E.bgmUrl);
      bgmEl.loop = true;
      const bsrc = actx.createMediaElementSource(bgmEl);
      const bgain = actx.createGain();
      bgain.gain.value = E.bgmVolume;
      bsrc.connect(bgain).connect(dest);
    }

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
          onProgress((doneOut + (v.currentTime - seg.start) / E.speed) / totalOut);
          requestAnimationFrame(check);
        };
        check();
      });
      v.pause();
      doneOut += (seg.end - seg.start) / E.speed;
      onProgress(doneOut / totalOut);
    }

    if (bgmEl) bgmEl.pause();
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
  }

  /* ---------------- wiring ---------------- */
  let bound = false;
  function bind() {
    if (bound) return;
    bound = true;
    $('edit-back').addEventListener('click', closeEditor);
    $('edit-export').addEventListener('click', doExport);
    $('edit-play').addEventListener('click', togglePlay);
    $('edit-canvas').addEventListener('click', togglePlay);

    $('tool-split').addEventListener('click', split);
    $('tool-delete').addEventListener('click', deleteSel);
    $('tool-rotate').addEventListener('click', rotate);
    $('tool-facecam').addEventListener('click', toggleFacecam);
    $('tool-speed').addEventListener('click', () => toggleSheet('sheet-speed'));
    $('tool-volume').addEventListener('click', () => toggleSheet('sheet-volume'));
    $('tool-audio').addEventListener('click', () => toggleSheet('sheet-audio'));

    $('speed-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      E.speed = parseFloat(chip.dataset.speed);
      if (E.video) E.video.playbackRate = E.speed;
      document.querySelectorAll('#speed-chips .chip').forEach((c) => c.classList.toggle('active', c === chip));
      updateLabels();
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

    $('btn-bgm-pick').addEventListener('click', () => $('bgm-file').click());
    $('bgm-file').addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) setBgm(e.target.files[0]);
      e.target.value = '';
    });
    $('btn-bgm-remove').addEventListener('click', () => setBgm(null));

    $('export-cancel').addEventListener('click', () => {
      if (E.exporting) E.exporting.cancel = true;
    });

    bindTimeline();
    bindFacecam();
    window.addEventListener('resize', () => { layoutFacecam(); buildStripDebounced(); });
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
