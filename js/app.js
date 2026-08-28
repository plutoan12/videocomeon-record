/* App wiring: views, settings, record flow, library, preview. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /* ---------------- settings ---------------- */
  const SETTINGS_KEY = 'vcr-settings';
  const settings = Object.assign(
    { quality: '1080', fps: 30, countdown: 3, mic: true },
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
    $('btn-mic').classList.toggle('mic-on', settings.mic);
  }

  /* ---------------- views ---------------- */
  const views = ['view-home', 'view-videos', 'view-preview'];
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
  function waitEvent(target, name) {
    return new Promise((res) => target.addEventListener(name, res, { once: true }));
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

  function downloadItem(item) {
    const url = URL.createObjectURL(item.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${item.name}.${extFor(item.mimeType)}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('다운로드를 시작했습니다.');
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

  /* ---------------- library ---------------- */
  const ICONS = {
    save: '<svg viewBox="0 0 24 24"><path d="M11 4h2v9.2l3.6-3.6L18 11l-6 6-6-6 1.4-1.4L11 13.2zM5 19h14v2H5z"/></svg>',
    rename: '<svg viewBox="0 0 24 24"><path d="M3 17.2V21h3.8L17.9 9.9l-3.8-3.8L3 17.2zM20.7 7.1a1 1 0 0 0 0-1.4l-2.4-2.4a1 1 0 0 0-1.4 0l-1.9 1.9 3.8 3.8 1.9-1.9z"/></svg>',
    del: '<svg viewBox="0 0 24 24"><path d="M9 3v1H4v2h16V4h-5V3H9zM6 8v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8H6zm3 2h2v9H9v-9zm4 0h2v9h-2v-9z"/></svg>',
  };

  async function renderLibrary() {
    const list = $('lib-list');
    const items = await VideoDB.all();
    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = '<div class="lib-empty">아직 녹화된 영상이 없습니다.<br>홈에서 빨간 버튼을 눌러 녹화를 시작해 보세요.</div>';
      return;
    }
    for (const item of items) {
      const el = document.createElement('div');
      el.className = 'lib-item';

      const thumb = document.createElement('button');
      thumb.className = 'lib-thumb';
      thumb.setAttribute('aria-label', 'Play ' + item.name);
      if (item.thumb) thumb.style.backgroundImage = `url("${item.thumb}")`;
      thumb.addEventListener('click', () => openPreview(item));

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
      actions.append(
        libAction(ICONS.save, 'Save', () => downloadItem(item)),
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
  $('lib-back').addEventListener('click', () => show('view-home'));

  // preview
  $('pv-back').addEventListener('click', () => { renderLibrary(); show('view-videos'); });
  $('pv-home').addEventListener('click', () => show('view-home'));
  $('pv-save').addEventListener('click', () => { if (previewItem) downloadItem(previewItem); });
  $('pv-share').addEventListener('click', () => { if (previewItem) shareItem(previewItem); });
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
})();
