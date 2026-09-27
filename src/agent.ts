// Исходник агента, внедряемого в renderer клиента ЯМ. Определяет window.__brsc
// с методами управления плеером. Вся «магия» (поиск MAIN-плеера в fiber-дереве,
// mobx-стор состояния, рецепт injectNext) инкапсулирована здесь.
//
// Экспортируется строкой, чтобы выполнить через CDP Runtime.evaluate. Код внутри —
// браузерный JS (исполняется в клиенте ЯМ), поэтому не типизируется TypeScript'ом.

export const AGENT_SOURCE: string = `(() => {
  const S = (window.__brsc = window.__brsc || {});

  // --- поиск менеджера плееров через BFS по fiber-дереву ---
  function reactRoot() {
    let el = document.querySelector('[data-test-id="PLAY_BUTTON"]') || document.querySelector('#__next') || document.body;
    const fk = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    if (!fk) return null;
    let f = el[fk];
    while (f.return) f = f.return;
    return f;
  }
  function findManager() {
    const root = reactRoot();
    if (!root) return null;
    const isMgr = (o) => { try { return o && typeof o === 'object' && (o.playbacks instanceof Map) && ('activePlayback' in o); } catch { return false; } };
    const seen = new WeakSet();
    let mgr = null;
    const check = (o, d) => {
      if (mgr || !o || (typeof o !== 'object' && typeof o !== 'function') || seen.has(o)) return;
      try { seen.add(o); } catch { return; }
      if (isMgr(o)) { mgr = o; return; }
      if (d > 0) for (const k of Object.keys(o)) { let v; try { v = o[k]; } catch { continue; } check(v, d - 1); if (mgr) return; }
    };
    let visited = 0; const stack = [root];
    while (stack.length && visited < 20000 && !mgr) {
      const f = stack.pop(); if (!f) continue; visited++;
      if (f.memoizedProps && f.memoizedProps.value) check(f.memoizedProps.value, 2);
      let h = f.memoizedState, hc = 0; while (h && hc < 25) { if (h.memoizedState) check(h.memoizedState, 1); h = h.next; hc++; }
      if (f.child) stack.push(f.child); if (f.sibling) stack.push(f.sibling);
    }
    return mgr;
  }
  function main() {
    // валиден ли кэш
    try { if (S._main && S._main.queueController) return S._main; } catch {}
    const mgr = findManager();
    if (!mgr) throw new Error('player manager not found');
    S._mgr = mgr;
    const m = mgr.playbacks.get('MAIN');
    if (!m) throw new Error('MAIN playback not found');
    S._main = m;
    return m;
  }

  // --- keystone root store (для sonataState) ---
  function rootModel() {
    try { if (S._root && S._root.sonataState) return S._root; } catch {}
    const start = document.querySelector('[data-test-id="PLAY_BUTTON"]') || document.body;
    const fk = Object.keys(start).find(k => k.startsWith('__reactFiber$'));
    if (!fk) return null;
    const seen = new WeakSet();
    let node = null;
    const isKNode = (o) => { try { if (!o || typeof o !== 'object' || !('storedValue' in o) || !('_parent' in o)) return false; const p = Object.getPrototypeOf(o); const d = p && Object.getOwnPropertyDescriptor(p, 'root'); return !!(d && d.get); } catch { return false; } };
    const find = (o, d) => { if (node || !o || typeof o !== 'object' || d > 8 || seen.has(o)) return; seen.add(o); if (isKNode(o)) { node = o; return; } for (const k of Object.keys(o)) { let v; try { v = o[k]; } catch { continue; } if (v && typeof v === 'object') find(v, d + 1); if (node) return; } };
    let f = start[fk], up = 0;
    while (f && up < 30 && !node) { if (f.memoizedProps) find(f.memoizedProps, 0); let h = f.memoizedState, hc = 0; while (h && hc < 30 && !node) { if (h.memoizedState) find(h.memoizedState, 0); h = h.next; hc++; } f = f.return; up++; }
    if (!node) return null;
    let cur = node, g = 0; while (cur && cur._parent && g < 100) { cur = cur._parent; g++; }
    S._root = cur && cur.storedValue;
    return S._root;
  }

  // --- утилиты ---
  const entArr = () => main().queueController.playerQueue.queueState.entityList.observableValue.v;
  const curIndex = () => { try { return main().playbackState.queueState.index.value; } catch { return undefined; } };
  function digId(e) {
    let found; const seen = new Set();
    const scan = (o, d) => { if (found || !o || typeof o !== 'object' || d > 3 || seen.has(o)) return; seen.add(o); if (('id' in o) && (typeof o.id === 'string' || typeof o.id === 'number')) { found = String(o.id); return; } for (const k of Object.keys(o)) { let v; try { v = o[k]; } catch { continue; } if (v && typeof v === 'object') scan(v, d + 1); if (found) return; } };
    try { scan(e && e.entity ? e.entity : e, 0); } catch {}
    return found;
  }
  function digTitle(e) {
    let t; const seen = new Set();
    const scan = (o, d) => { if (t || !o || typeof o !== 'object' || d > 3 || seen.has(o)) return; seen.add(o); if (typeof o.title === 'string') { t = o.title; return; } for (const k of Object.keys(o)) { let v; try { v = o[k]; } catch { continue; } if (v && typeof v === 'object') scan(v, d + 1); if (t) return; } };
    try { scan(e && e.entity ? e.entity : e, 0); } catch {}
    return t;
  }
  function digArtist(e) {
    let a; const seen = new Set();
    const scan = (o, d) => { if (a || !o || typeof o !== 'object' || d > 4 || seen.has(o)) return; seen.add(o); if (Array.isArray(o.artists) && o.artists[0] && typeof o.artists[0].name === 'string') { a = o.artists.map(function (x) { return x && x.name; }).filter(Boolean).join(', '); return; } for (const k of Object.keys(o)) { let v; try { v = o[k]; } catch { continue; } if (v && typeof v === 'object') scan(v, d + 1); if (a) return; } };
    try { scan(e && e.entity ? e.entity : e, 0); } catch {}
    return a;
  }
  function digColor(e) {
    let c; const seen = new Set();
    const scan = (o, d) => { if (c || !o || typeof o !== 'object' || d > 4 || seen.has(o)) return; seen.add(o); if (o.derivedColors && typeof o.derivedColors === 'object') { c = o.derivedColors.average || o.derivedColors.accent || null; return; } for (const k of Object.keys(o)) { let v; try { v = o[k]; } catch { continue; } if (v && typeof v === 'object') scan(v, d + 1); if (c) return; } };
    try { scan(e && e.entity ? e.entity : e, 0); } catch {}
    return c;
  }

  // --- видеошот (короткий mp4-луп) через supplement API, кэш по текущему треку ---
  var _shot = { id: null, url: null, loading: false };
  function _oauthToken() {
    try { var o = JSON.parse(localStorage.getItem('oauth') || '{}'); return (typeof o.value === 'string' ? o.value : (o.value && o.value.access_token)) || o.access_token || null; } catch (e) { return null; }
  }
  function _loadShot(id) {
    if (!id || _shot.loading || _shot.id === id) return;
    _shot.loading = true;
    var tok = _oauthToken();
    var headers = tok ? { Authorization: 'OAuth ' + tok } : {};
    fetch('https://api.music.yandex.net/tracks/' + id + '/supplement', { headers: headers })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var sup = (j && j.result) || j || {};
        var url = null;
        try { if (Array.isArray(sup.clips) && sup.clips[0] && sup.clips[0].previewUrl) url = sup.clips[0].previewUrl; } catch (e) {}
        _shot = { id: id, url: url, loading: false };
      })
      .catch(function () { _shot = { id: id, url: null, loading: false }; });
  }

  // --- публичное состояние ---
  S.state = function () {
    const md = navigator.mediaSession.metadata;
    let cover = null;
    try { if (md && md.artwork && md.artwork.length) cover = md.artwork[md.artwork.length - 1].src; } catch (e) {}
    const out = {
      title: md ? md.title : null,
      artist: md ? md.artist : null,
      cover: cover,
      playbackState: navigator.mediaSession.playbackState,
    };
    try { const ss = rootModel().sonataState; if (ss) { out.position = ss.position; out.duration = ss.duration; out.status = ss.status; out.contextType = ss.contextType; out.contextId = ss.contextId; out.volume = ss.volume; } } catch {}
    try { const arr = entArr(); const idx = curIndex(); out.queueLen = arr.length; out.index = idx; if (typeof idx === 'number' && arr[idx]) { out.currentId = digId(arr[idx]); out.color = digColor(arr[idx]); _loadShot(out.currentId); out.videoShot = (_shot.id === out.currentId) ? _shot.url : null; } } catch {}
    // лайкнут ли текущий трек — по кнопке плеера ЯМ (aria-pressed); null = кнопки нет (ничего не играет)
    try { const lb = likeButton(); out.liked = lb ? (lb.getAttribute('aria-pressed') === 'true') : null; } catch (e) { out.liked = null; }
    return out;
  };

  // Кнопка лайка ИМЕННО текущего трека. На экране бывает много LIKE_BUTTON (списки/карусели),
  // поэтому ищем кнопку внутри плеер-бара — он относится к играющему треку. Плеер-бар зависит
  // от экрана: обычный (PLAYERBAR_DESKTOP) или «Моя Волна»/Vibe (VIBE_PLAYERBAR).
  function likeButton() {
    const bars = ['PLAYERBAR_DESKTOP', 'VIBE_PLAYERBAR'];
    for (let i = 0; i < bars.length; i++) {
      const c = document.querySelector('[data-test-id="' + bars[i] + '"]');
      if (c) { const b = c.querySelector('[data-test-id="LIKE_BUTTON"]'); if (b) return b; }
    }
    // запасной вариант (напр. полноэкранный плеер): если на экране РОВНО одна кнопка лайка —
    // она и есть про текущий трек (при видимом плеер-баре кнопок было бы ≥2, сюда бы не дошли).
    const all = document.querySelectorAll('[data-test-id="LIKE_BUTTON"]');
    return all.length === 1 ? all[0] : null;
  }

  // Лайк/снять лайк текущего трека — клик по родной кнопке ЯМ (тригерит её обработчик,
  // работает и когда окно ЯМ в фоне). aria-pressed отражает состояние.
  S.toggleLike = function () {
    const lb = likeButton();
    if (!lb) throw new Error('кнопка лайка не найдена (ничего не играет?)');
    const was = lb.getAttribute('aria-pressed') === 'true';
    lb.click();
    return { ok: true, liked: !was };
  };

  S.queue = function (limit) {
    const arr = entArr(); const idx = curIndex(); limit = limit || 20;
    const res = [];
    const from = Math.max(0, (idx || 0));
    for (let i = from; i < arr.length && res.length < limit; i++) {
      res.push({ pos: i, id: digId(arr[i]), title: digTitle(arr[i]), artist: digArtist(arr[i]), isCurrent: i === idx });
    }
    return { index: idx, total: arr.length, items: res };
  };

  // --- резолв запроса в трек (с метаданными для фильтров) ---
  function mapTrack(t) {
    return {
      id: String(t.id),
      title: t.title || null,
      artist: (t.artists && t.artists[0] && t.artists[0].name) || null,
      durationSec: (typeof t.durationMs === 'number') ? Math.round(t.durationMs / 1000) : null,
      explicit: !!t.explicit,
      available: t.available !== false,
      artistIds: (t.artists || []).map(function (a) { return String(a.id); }),
    };
  }
  S.search = async function (query) {
    const url = 'https://api.music.yandex.net/search?text=' + encodeURIComponent(query) + '&type=track&page=0&nocorrect=false';
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    const j = await r.json();
    const t = j && j.result && j.result.tracks && j.result.tracks.results && j.result.tracks.results[0];
    if (!t) return null;
    return mapTrack(t);
  };
  S.trackInfo = async function (id) {
    try {
      const r = await fetch('https://api.music.yandex.net/tracks/' + encodeURIComponent(id), { headers: { Accept: 'application/json' } });
      const j = await r.json();
      const t = j && j.result && j.result[0];
      return t ? mapTrack(t) : null;
    } catch (e) { return null; }
  };
  S.resolve = async function (query) {
    query = String(query).trim();
    let id = null, source = null;
    if (/^\\d+$/.test(query)) { id = query; source = 'id'; }
    else { const m = query.match(/track\\/(\\d+)/); if (m) { id = m[1]; source = 'url'; } }
    if (id) {
      const info = await S.trackInfo(id);
      if (info) { info.source = source; return info; }
      return { id: id, title: null, artist: null, source: source };
    }
    const found = await S.search(query);
    if (found) found.source = 'search';
    return found;
  };

  // --- управление очередью (рецепт проверен вживую) ---
  S.playNext = function (trackId) {
    const m = main();
    m.injectNext({ entitiesData: [{ type: 'unloaded', meta: { id: String(trackId) } }] });
    return { ok: true, position: (curIndex() || 0) + 1 };
  };
  // Вставить трек на конкретную позицию очереди (для FIFO — после уже стоящих заказов).
  S.injectAt = function (trackId, position) {
    main().inject({ entitiesData: [{ type: 'unloaded', meta: { id: String(trackId) } }], position: position });
    return { ok: true, position: position };
  };
  S.playLast = function (trackId) {
    main().injectLast({ entitiesData: [{ type: 'unloaded', meta: { id: String(trackId) } }] });
    return { ok: true };
  };
  S.remove = function (trackId) {
    main().removeByEntityIds([String(trackId)]);
    return { ok: true };
  };

  // --- транспорт ---
  // setExponentVolume — перцептивная шкала, совпадает с ползунком ЯМ и с чтением sonataState.volume.
  S.setVolume = (v) => { const vol = Math.max(0, Math.min(1, Number(v))); const m = main(); (m.setExponentVolume ? m.setExponentVolume(vol) : m.setVolume(vol)); return { ok: true, volume: vol }; };
  S.play = () => { main().resume(); return { ok: true }; };
  S.pause = () => { main().pause(); return { ok: true }; };
  S.toggle = () => { main().togglePause(); return { ok: true }; };
  S.next = () => { main().moveForward(); return { ok: true }; };
  S.prev = () => { main().moveBackward(); return { ok: true }; };

  // --- диагностика: версия клиента + проверка всех точек, на которые опирается обёртка ---
  // window.VERSION в новых сборках ЯМ убрали (5.120+), поэтому фолбэк — из User-Agent
  // ("… YandexMusic/5.120.0 Chrome/…"), который ставит Electron-оболочка клиента.
  S.version = function () {
    try {
      if (window.VERSION) return String(window.VERSION);
      const m = String(navigator.userAgent || '').match(/YandexMusic\\/([\\d.]+)/i);
      return m ? m[1] : null;
    } catch (e) { return null; }
  };
  S.diagnostics = async function () {
    const checks = [];
    const add = (name, ok, detail) => checks.push({ name: name, ok: !!ok, detail: detail || '' });
    let version = null; try { version = S.version(); } catch (e) {}

    const anchor = document.querySelector('[data-test-id="PLAY_BUTTON"]');
    add('Якорь поиска плеера (кнопка PLAY)', !!anchor, anchor ? 'на месте' : 'нет [data-test-id="PLAY_BUTTON"]');

    let m = null; try { m = main(); } catch (e) {}
    add('Плеер MAIN найден', !!m, m ? ('id ' + (m.id || '?')) : 'НЕ найден — управление плеером не работает');

    let root = null; try { root = rootModel(); } catch (e) {}
    const ss = root && root.sonataState;
    add('Состояние плеера (sonataState)', !!ss, ss ? ('громкость ' + Math.round((ss.volume || 0) * 100) + '%, позиция ' + Math.round(ss.position || 0) + 'с') : 'недоступно');

    const md = navigator.mediaSession && navigator.mediaSession.metadata;
    add('Текущий трек (mediaSession)', !!md, md ? (md.title + ' — ' + md.artist) : 'нет данных');

    let qOk = false, qDetail = '';
    try { const arr = entArr(); qOk = Array.isArray(arr); qDetail = 'элементов: ' + arr.length; } catch (e) { qDetail = 'ошибка чтения очереди'; }
    add('Очередь читается', qOk, qDetail);

    const need = (list) => !!m && list.every((k) => typeof m[k] === 'function');
    add('Вставка заказов (injectNext / remove)', need(['injectNext', 'inject', 'removeByEntityIds']), m ? '' : 'MAIN не найден');
    add('Запуск и переключение треков', need(['playContext', 'setEntityByIndex', 'moveForward', 'moveBackward']), m ? '' : 'MAIN не найден');
    add('Пауза и громкость', need(['resume', 'pause', 'setExponentVolume']), m ? '' : 'MAIN не найден');

    try {
      const r = await fetch('https://api.music.yandex.net/search?text=test&type=track&page=0&nocorrect=false', { headers: { Accept: 'application/json' } });
      let hasResults = false; try { const j = await r.json(); hasResults = !!(j && j.result && j.result.tracks); } catch (e) {}
      add('Поиск треков (API ЯМ)', r.ok && hasResults, r.ok ? 'работает' : ('HTTP ' + r.status));
    } catch (e) { add('Поиск треков (API ЯМ)', false, 'нет ответа от API'); }

    const passed = checks.filter((c) => c.ok).length;
    return { version: version, checks: checks, passed: passed, total: checks.length };
  };

  S._ready = true;
  return { ready: true };
})()`;
