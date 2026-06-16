// ═══════════════════════════════════════════════════════════════════
// LINEAR TV — Shared Player Engine v3
// Supports: direct .m3u8/.mp4 URLs  →  <video> + hls.js
//           web player iframe URLs  →  <iframe> embed
// ═══════════════════════════════════════════════════════════════════

const CHANNEL_EPOCH   = new Date('2024-01-01T00:00:00Z').getTime();
const PLAYLIST_URL    = './playlist.json';

const POLL_MS         = 5000;   // playlist change check interval
const WATCHDOG_MS     = 1000;   // sync ticker
const RESYNC_DRIFT    = 3;      // seconds drift before snap (video mode)
const IFRAME_RESYNC   = 8;      // seconds drift before iframe reload

// ── URL type detection ────────────────────────────────────────────
// Returns 'iframe' if URL is a web player page, 'hls' or 'mp4' otherwise.
function detectType(item) {
  if (item.type === 'iframe') return 'iframe';
  const url = item.url || '';
  // Direct stream indicators
  if (url.includes('.m3u8')) return 'hls';
  if (url.includes('.mp4'))  return 'mp4';
  // Web player page indicators — anything that looks like an HTML page URL
  // with query params, player paths, or known player domains
  if (
    url.includes('/player')   ||
    url.includes('?url=')     ||
    url.includes('?src=')     ||
    url.includes('?stream=')  ||
    url.includes('?file=')    ||
    url.includes('?link=')    ||
    url.includes('?v=')       ||
    url.includes('embed')     ||
    url.includes('iframe')    ||
    item.type === 'embed'
  ) return 'iframe';
  // Fallback: if no .m3u8 / .mp4 extension → treat as iframe
  return url.match(/\.(m3u8|mp4|webm|ogg|mkv)(\?|$)/i) ? 'mp4' : 'iframe';
}

// ── Seek URL builder ──────────────────────────────────────────────
// For iframe sources that support a time/start param, we inject the
// seek offset so the embed starts at the right position.
// Add more patterns here as needed for other player domains.
function buildIframeSrc(url, seekSec) {
  const t = Math.floor(seekSec);
  try {
    const u = new URL(url);
    // Common seek params used by various players
    // Try appending #t= first (most universal), then ?t= as fallback
    // For players that use &t= or &start=
    if (u.searchParams.has('url') || u.searchParams.has('src') || u.searchParams.has('file')) {
      // These are wrapper players — pass #t= as a fragment so the inner player may pick it up
      u.hash = `t=${t}`;
    } else if (u.searchParams.has('t')) {
      u.searchParams.set('t', t);
    } else if (u.searchParams.has('start')) {
      u.searchParams.set('start', t);
    } else {
      // Append #t= fragment — harmless if ignored, helpful if supported
      u.hash = `t=${t}`;
    }
    return u.toString();
  } catch {
    // Malformed URL — just append fragment
    return url + '#t=' + t;
  }
}

// ═══════════════════════════════════════════════════════════════════
function initPlayer(cfg) {

  // ── DOM refs ──────────────────────────────────────────────────────
  const vid          = document.getElementById(cfg.videoId);
  const iframeEl     = document.getElementById(cfg.iframeId);
  const loader       = document.getElementById(cfg.loaderId);
  const errorMsg     = document.getElementById(cfg.errorId);
  const btnPlay      = document.getElementById(cfg.btnPlayId);
  const volSlider    = document.getElementById(cfg.volSliderId);
  const progressFill = document.getElementById(cfg.progressFillId);
  const scheduleList = cfg.scheduleListId ? document.getElementById(cfg.scheduleListId) : null;
  const syncToast    = document.getElementById(cfg.syncToastId);
  const updateToast  = cfg.updateToastId  ? document.getElementById(cfg.updateToastId)  : null;
  const statusText   = cfg.statusTextId   ? document.getElementById(cfg.statusTextId)   : null;
  const statusOffset = cfg.statusOffsetId ? document.getElementById(cfg.statusOffsetId) : null;
  const nowTitle     = document.getElementById(cfg.nowTitleId);
  const volOverlay   = cfg.volOverlayId   ? document.getElementById(cfg.volOverlayId)   : null;

  // ── State ─────────────────────────────────────────────────────────
  let playlist         = [];
  let totalDur         = 0;
  let currentIndex     = -1;
  let currentMode      = null;   // 'video' | 'iframe'
  let currentUrl       = '';
  let hls              = null;
  let paused           = false;
  let lastPlaylistHash = '';
  let iframeLoadTime   = 0;      // wallclock ms when iframe was last loaded

  // ── Clock ─────────────────────────────────────────────────────────
  if (cfg.showClock && cfg.clockId) {
    const clockEl     = document.getElementById(cfg.clockId);
    const clockDateEl = document.getElementById(cfg.clockDateId);
    function updateClock() {
      const now = new Date();
      if (clockEl)     clockEl.textContent     = now.toLocaleTimeString('en-GB', { hour12: false });
      if (clockDateEl) clockDateEl.textContent = now.toLocaleDateString('en-GB', {
        weekday:'short', day:'numeric', month:'short', year:'numeric'
      }).toUpperCase();
    }
    updateClock();
    setInterval(updateClock, 1000);
  }

  // ── Helpers ───────────────────────────────────────────────────────
  function fmt(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }
  function pad(n) { return String(n).padStart(2,'0'); }
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function computePos(nowMs) {
    if (!playlist.length) return null;
    const elapsed = ((nowMs - CHANNEL_EPOCH) / 1000 % totalDur + totalDur) % totalDur;
    let acc = 0;
    for (let i = 0; i < playlist.length; i++) {
      if (elapsed < acc + playlist[i].duration)
        return { index: i, offset: elapsed - acc, globalOffset: elapsed };
      acc += playlist[i].duration;
    }
    return { index: 0, offset: 0, globalOffset: 0 };
  }

  // ── Toasts ────────────────────────────────────────────────────────
  let syncTimer, updateTimer;
  function showSyncToast() {
    if (!syncToast) return;
    syncToast.classList.add('show');
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncToast.classList.remove('show'), 2500);
  }
  function showUpdateToast() {
    if (!updateToast) return;
    updateToast.classList.add('show');
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => updateToast.classList.remove('show'), 3000);
  }

  // ── Schedule ──────────────────────────────────────────────────────
  function renderSchedule(activeIdx, globalOffset) {
    if (!scheduleList) return;
    scheduleList.innerHTML = '';
    let acc = 0;
    playlist.forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'schedule-item' +
        (i === activeIdx ? ' active' : acc + item.duration < globalOffset ? ' past' : '');
      el.innerHTML = `
        <div class="s-time">${fmt(acc)}</div>
        <div class="s-title">${esc(item.title)}</div>
        <div class="s-duration">${fmt(item.duration)} runtime</div>
        ${i === activeIdx ? '<div class="s-active-tag">▶ On now</div>' : ''}`;
      scheduleList.appendChild(el);
      if (i === activeIdx)
        setTimeout(() => el.scrollIntoView({ block:'nearest', behavior:'smooth' }), 100);
      acc += item.duration;
    });
  }

  // ── Mode switching ────────────────────────────────────────────────
  function showVideo() {
    if (vid)      vid.style.display      = 'block';
    if (iframeEl) iframeEl.style.display = 'none';
    if (volSlider) volSlider.closest && volSlider.closest('.vol-wrap') &&
      (volSlider.closest('.vol-wrap').style.opacity = '1');
    if (volOverlay) volOverlay.style.display = 'none';
    currentMode = 'video';
  }

  function showIframe() {
    if (vid)      { vid.pause(); vid.src = ''; vid.style.display = 'none'; }
    if (iframeEl) iframeEl.style.display = 'block';
    if (hls)      { hls.destroy(); hls = null; }
    // Volume slider can't control iframe audio — show a note
    if (volSlider) volSlider.closest && volSlider.closest('.vol-wrap') &&
      (volSlider.closest('.vol-wrap').style.opacity = '0.3');
    if (volOverlay) volOverlay.style.display = 'flex';
    currentMode = 'iframe';
  }

  // ── Load item ─────────────────────────────────────────────────────
  function loadItem(index, seekTo) {
    const item   = playlist[index];
    const type   = detectType(item);
    const isIframe = type === 'iframe';

    currentIndex = index;
    currentUrl   = item.url;
    if (nowTitle) nowTitle.textContent = item.title;
    loader.classList.remove('hidden');
    errorMsg.classList.remove('show');

    if (isIframe) {
      loadIframe(item, seekTo);
    } else {
      loadVideo(item, type, seekTo);
    }
  }

  // ── iframe mode ───────────────────────────────────────────────────
  function loadIframe(item, seekTo) {
    if (!iframeEl) {
      // No iframe element in DOM — fallback error
      loader.classList.add('hidden');
      errorMsg.classList.add('show');
      return;
    }
    showIframe();
    const src = buildIframeSrc(item.url, seekTo);
    iframeEl.src = src;
    iframeLoadTime = Date.now();
    iframeEl.onload = () => loader.classList.add('hidden');
    // Fallback: hide loader after 4s even if onload doesn't fire
    setTimeout(() => loader.classList.add('hidden'), 4000);
  }

  // ── video mode ────────────────────────────────────────────────────
  function loadVideo(item, type, seekTo) {
    showVideo();
    if (hls) { hls.destroy(); hls = null; }

    const onReady = () => { vid.currentTime = seekTo; doPlay(); };

    if (type === 'hls' && typeof Hls !== 'undefined' && Hls.isSupported()) {
      hls = new Hls({ startPosition: seekTo });
      hls.loadSource(item.url);
      hls.attachMedia(vid);
      hls.on(Hls.Events.MANIFEST_PARSED, onReady);
      hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) handleError(); });
    } else if (vid.canPlayType('application/vnd.apple.mpegurl') && type === 'hls') {
      vid.src = item.url;
      vid.addEventListener('loadedmetadata', onReady, { once: true });
    } else {
      vid.src = item.url;
      vid.addEventListener('loadedmetadata', onReady, { once: true });
    }
    vid.onerror = handleError;
  }

  function doPlay() {
    loader.classList.add('hidden');
    errorMsg.classList.remove('show');
    vid.volume = parseFloat(volSlider ? volSlider.value : 0.8);
    vid.play().catch(() => { if (btnPlay) btnPlay.textContent = '▶'; });
    paused = false;
    if (btnPlay) btnPlay.textContent = '⏸';
  }

  function handleError() {
    loader.classList.add('hidden');
    errorMsg.classList.add('show');
    setTimeout(() => {
      const pos = computePos(Date.now());
      if (pos) loadItem(pos.index, pos.offset);
    }, 5000);
  }

  // ── Play/Pause button ─────────────────────────────────────────────
  if (btnPlay) {
    btnPlay.addEventListener('click', () => {
      if (currentMode === 'iframe') {
        // Iframe: pause = mute iframe by reloading at current position
        // (can't truly pause cross-origin iframe — best we can do)
        if (!paused) {
          // "Pause" — reload iframe at t=0 of current item to freeze
          // Actually just stop by blanking src
          iframeEl.src = 'about:blank';
          paused = true;
          btnPlay.textContent = '▶';
        } else {
          // Resume — reload at current live position
          const pos = computePos(Date.now());
          if (!pos) return;
          if (pos.index !== currentIndex) {
            loadItem(pos.index, pos.offset);
          } else {
            loadIframe(playlist[pos.index], pos.offset);
          }
          paused = false;
          btnPlay.textContent = '⏸';
          showSyncToast();
        }
      } else {
        // Video mode
        if (vid.paused) {
          const pos = computePos(Date.now());
          if (!pos) return;
          if (pos.index !== currentIndex) {
            loadItem(pos.index, pos.offset);
          } else {
            vid.currentTime = pos.offset;
            vid.play();
          }
          paused = false;
          btnPlay.textContent = '⏸';
          showSyncToast();
        } else {
          vid.pause();
          paused = true;
          btnPlay.textContent = '▶';
        }
      }
    });
  }

  if (volSlider && vid) {
    volSlider.addEventListener('input', () => { vid.volume = parseFloat(volSlider.value); });
  }

  if (vid) vid.addEventListener('contextmenu', e => e.preventDefault());

  // ── Sync watchdog ─────────────────────────────────────────────────
  setInterval(() => {
    if (paused || !playlist.length) return;
    const pos = computePos(Date.now());
    if (!pos) return;

    // Progress bar — for iframe mode use wall-clock elapsed
    if (progressFill) {
      if (currentMode === 'iframe') {
        const elapsed = (Date.now() - iframeLoadTime) / 1000;
        const pct = Math.min(elapsed / playlist[pos.index].duration * 100, 100);
        progressFill.style.width = pct + '%';
      } else if (vid && !vid.paused) {
        progressFill.style.width =
          Math.min((vid.currentTime / playlist[pos.index].duration) * 100, 100) + '%';
      }
    }

    // Status bar
    if (statusText && playlist[pos.index]) {
      const elapsed = currentMode === 'iframe'
        ? (Date.now() - iframeLoadTime) / 1000
        : (vid ? vid.currentTime : 0);
      const rem = playlist[pos.index].duration - elapsed;
      statusText.textContent = `Up next in ${fmt(Math.max(0, rem))}`;
    }
    if (statusOffset) statusOffset.textContent = `OFFSET ${fmt(Math.floor(pos.globalOffset))}`;

    // ── Item switch check ─────────────────────────────────────────
    if (pos.index !== currentIndex) {
      loadItem(pos.index, pos.offset);
      renderSchedule(pos.index, pos.globalOffset);
      return;
    }

    // ── Drift correction (video mode only) ────────────────────────
    if (currentMode === 'video' && vid && !vid.paused && !vid.seeking) {
      const drift = Math.abs(vid.currentTime - pos.offset);
      if (drift > RESYNC_DRIFT) {
        vid.currentTime = pos.offset;
        showSyncToast();
      }
    }

    // ── Iframe drift correction ───────────────────────────────────
    // If iframe has been running too long vs expected, reload it
    if (currentMode === 'iframe' && iframeEl && !paused) {
      const iframeElapsed = (Date.now() - iframeLoadTime) / 1000;
      const drift = Math.abs(iframeElapsed - pos.offset);
      if (drift > IFRAME_RESYNC) {
        loadIframe(playlist[pos.index], pos.offset);
        showSyncToast();
      }
    }

    renderSchedule(pos.index, pos.globalOffset);
  }, WATCHDOG_MS);

  // ── Live playlist polling ─────────────────────────────────────────
  async function pollPlaylist() {
    try {
      const res = await fetch(PLAYLIST_URL + '?_=' + Date.now(), { cache: 'no-store' });
      if (!res.ok) return;
      const text = await res.text();
      if (text === lastPlaylistHash) return;
      lastPlaylistHash = text;

      let newList;
      try { newList = JSON.parse(text); } catch { return; }
      if (!Array.isArray(newList) || !newList.length) return;

      playlist = newList;
      totalDur = playlist.reduce((s, v) => s + v.duration, 0);

      const pos = computePos(Date.now());
      if (!pos) return;

      showUpdateToast();

      // Same URL still playing? Just update schedule, no interruption.
      const sameUrl = pos.index === currentIndex &&
        playlist[pos.index] &&
        playlist[pos.index].url === currentUrl;

      if (sameUrl) {
        renderSchedule(pos.index, pos.globalOffset);
      } else {
        loadItem(pos.index, pos.offset);
        renderSchedule(pos.index, pos.globalOffset);
      }
    } catch { /* network blip */ }
  }

  // ── Init ──────────────────────────────────────────────────────────
  async function init() {
    try {
      const res  = await fetch(PLAYLIST_URL + '?_=' + Date.now(), { cache: 'no-store' });
      const text = await res.text();
      lastPlaylistHash = text;
      playlist = JSON.parse(text);
      totalDur = playlist.reduce((s, v) => s + v.duration, 0);

      const pos = computePos(Date.now());
      if (!pos) throw new Error('Empty playlist');

      renderSchedule(pos.index, pos.globalOffset);
      loadItem(pos.index, pos.offset);
      setInterval(pollPlaylist, POLL_MS);
    } catch (e) {
      loader.classList.add('hidden');
      errorMsg.classList.add('show');
      console.error('Channel init failed:', e);
    }
  }

  init();
    }
