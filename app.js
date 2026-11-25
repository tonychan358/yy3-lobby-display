(function () {
  var cfg = window.LOBBY_CONFIG || {};
  var L = window.LobbyLogic;
  var FEED_CACHE_KEY = 'lobby_feed_cache_v1';
  var PHOTO_CACHE_NAME = 'lobby-photos-v1';
  var RELOAD_FLAG_KEY = 'lobby_last_reload_date';

  var BUG_LABELS = {
    '獎項': '校園焦點',
    '活動': '活動速遞',
    '日程': '校園日程'
  };

  var state = {
    rawItems: [],
    view: L.partitionItems([]),
    slideIndex: 0,
    dailyIndex: 0,
    dailyShowAnswer: false,
    tickerIndex: 0,
    fixedPage: L.parseFixedPage(window.location.search),
    currentSlide: null,
    activePhotoIds: {},
    displayedPhotoId: '',
    photoRenderSeq: 0,
    photoUrls: {},
    feedSeq: 0,
    feedInFlight: false,
    slideTimer: null,
    dailyTimer: null,
    tickerTimer: null
  };

  function el(id) {
    return document.getElementById(id);
  }

  function clearNode(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function toggleHidden(node, hidden) {
    if (!node) {
      return;
    }
    if (hidden) {
      node.classList.add('is-hidden');
    } else {
      node.classList.remove('is-hidden');
    }
  }

  function updateClockAndDate() {
    var now = new Date();
    el('dateTxt').textContent = L.formatDisplayDate(now);
    el('clockTxt').textContent = L.formatClock(now);
    var isOnline = typeof navigator.onLine === 'boolean' ? navigator.onLine : true;
    var lastReload = '';
    try {
      lastReload = window.sessionStorage.getItem(RELOAD_FLAG_KEY) || '';
    } catch (e) {}
    if (L.shouldDailyReload(now, lastReload, isOnline)) {
      try {
        window.sessionStorage.setItem(RELOAD_FLAG_KEY, L.formatDeviceDate(now));
      } catch (e2) {}
      window.location.reload();
    }
  }

  function fetchWeather() {
    var station = cfg.WEATHER_STATION || '將軍澳';
    var url = 'https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=tc';
    fetch(url).then(function (res) {
      if (!res || !res.ok) {
        throw new Error('weather http');
      }
      return res.json();
    }).then(function (data) {
      var temp = L.extractStationTemp(data, station);
      if (temp === null) {
        toggleHidden(el('weatherRow'), true);
        return;
      }
      el('weatherTemp').textContent = temp + '°C';
      toggleHidden(el('weatherRow'), false);
    }).catch(function () {
      toggleHidden(el('weatherRow'), true);
    });
  }

  function readCachedFeed() {
    try {
      var raw = window.localStorage.getItem(FEED_CACHE_KEY);
      if (!raw) {
        return null;
      }
      var parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.items)) {
        return parsed.items;
      }
    } catch (e) {}
    return null;
  }

  function writeCachedFeed(items) {
    try {
      window.localStorage.setItem(FEED_CACHE_KEY, JSON.stringify({
        savedAt: Date.now(),
        items: items
      }));
    } catch (e) {}
  }

  function buildPhotoRequestUrl(photoId) {
    return cfg.FEED_URL + (cfg.FEED_URL.indexOf('?') === -1 ? '?' : '&') +
      'img=' + encodeURIComponent(photoId);
  }

  function withCacheBust(url) {
    var sep = url.indexOf('?') === -1 ? '?' : '&';
    return url + sep + '_=' + Date.now();
  }

  function clearSlidePhoto() {
    var imgEl = el('slidePhotoImg');
    if (imgEl) {
      imgEl.onload = null;
      imgEl.onerror = null;
      imgEl.removeAttribute('src');
    }
    state.displayedPhotoId = '';
  }

  function deletePhotoCache(photoId) {
    delete state.photoUrls[photoId];
    if (!cfg.FEED_URL || !window.caches) {
      return;
    }
    var reqUrl = buildPhotoRequestUrl(photoId);
    try {
      window.caches.open(PHOTO_CACHE_NAME).then(function (cache) {
        return cache.delete(reqUrl);
      }).catch(function () {});
    } catch (e) {}
  }

  function resolvePhotoUrl(photoId, callback) {
    if (!photoId || !cfg.FEED_URL || !state.activePhotoIds[photoId]) {
      callback(null);
      return;
    }
    if (state.photoUrls[photoId]) {
      callback(state.photoUrls[photoId]);
      return;
    }
    var reqUrl = buildPhotoRequestUrl(photoId);

    function fetchFromNetworkAndCache() {
      return fetch(reqUrl).then(function (res) {
        if (!res || !res.ok) {
          throw new Error('img http');
        }
        return res.json();
      }).then(function (json) {
        if (!json || !json.ok || !L.isSafeImageMime(json.mime) || !json.data) {
          throw new Error('img invalid');
        }
        if (!state.activePhotoIds[photoId]) {
          return null;
        }
        var dataUrl = 'data:' + json.mime + ';base64,' + json.data;
        state.photoUrls[photoId] = dataUrl;
        if (window.caches) {
          try {
            window.caches.open(PHOTO_CACHE_NAME).then(function (cache) {
              if (!state.activePhotoIds[photoId]) {
                return;
              }
              return cache.put(reqUrl, new Response(JSON.stringify({ mime: json.mime, data: json.data }), {
                headers: { 'Content-Type': 'application/json' }
              }));
            }).catch(function () {});
          } catch (e) {}
        }
        return dataUrl;
      });
    }

    function tryReadCache() {
      if (!window.caches) {
        return Promise.resolve(null);
      }
      try {
        return window.caches.open(PHOTO_CACHE_NAME).then(function (cache) {
          return cache.match(reqUrl);
        }).then(function (cachedRes) {
          if (!cachedRes) {
            return null;
          }
          return cachedRes.json().then(function (json) {
            if (json && L.isSafeImageMime(json.mime) && json.data && state.activePhotoIds[photoId]) {
              var dataUrl = 'data:' + json.mime + ';base64,' + json.data;
              state.photoUrls[photoId] = dataUrl;
              return dataUrl;
            }
            return null;
          });
        }).catch(function () {
          return null;
        });
      } catch (e) {
        return Promise.resolve(null);
      }
    }

    tryReadCache().then(function (cachedUrl) {
      if (cachedUrl) {
        return cachedUrl;
      }
      return fetchFromNetworkAndCache();
    }).then(function (url) {
      callback(url);
    }).catch(function () {
      callback(null);
    });
  }

  function renderMainScreen() {
    var slides = state.view.slides;
    var metaRow = el('slideMetaRow');
    var headline = el('slideHeadline');
    var photoFrame = el('slidePhotoFrame');
    var textPanel = el('slideTextPanel');
    var welcomePanel = el('welcomePanel');
    var dotsBar = el('dotsBar');
    state.photoRenderSeq += 1;
    var renderSeq = state.photoRenderSeq;

    if (slides.length === 0) {
      state.currentSlide = null;
      clearSlidePhoto();
      toggleHidden(metaRow, true);
      toggleHidden(headline, true);
      toggleHidden(photoFrame, true);
      toggleHidden(textPanel, true);
      toggleHidden(dotsBar, true);
      toggleHidden(welcomePanel, false);
      el('welcomeSchool').textContent = cfg.SCHOOL_NAME || '圓玄學院第三中學';
      setAction('wave');
      return;
    }

    toggleHidden(welcomePanel, true);
    toggleHidden(metaRow, false);
    toggleHidden(headline, false);
    toggleHidden(dotsBar, slides.length <= 1);

    var idx = state.fixedPage !== null
      ? Math.min(state.fixedPage, slides.length - 1)
      : (state.slideIndex % slides.length);
    var slide = slides[idx];
    state.currentSlide = slide;
    setAction(L.pickAction(slide));

    el('slideTypeTag').textContent = slide.time ? (slide.type + ' · ' + slide.time) : slide.type;
    el('slideBugText').textContent = BUG_LABELS[slide.type] || '校園資訊';
    headline.textContent = slide.title || '';

    clearNode(dotsBar);
    for (var i = 0; i < slides.length; i++) {
      var dot = document.createElement('div');
      dot.className = i === idx ? 'dot-active' : 'dot';
      dotsBar.appendChild(dot);
    }

    // Periodic re-renders must not flash the text panel over a photo already on screen.
    if (slide.photoId && state.displayedPhotoId === slide.photoId && state.displayedSlideId === slide.id) {
      var shownCap = el('slidePhotoCaption');
      shownCap.textContent = slide.body || '';
      toggleHidden(shownCap, !slide.body);
      return;
    }
    if (!slide.photoId || !state.photoUrls[slide.photoId]) {
      showSlideTextMode(slide);
    }
    if (slide.photoId) {
      resolvePhotoUrl(slide.photoId, function (dataUrl) {
        if (renderSeq !== state.photoRenderSeq || state.currentSlide !== slide || !state.activePhotoIds[slide.photoId]) {
          return;
        }
        if (!dataUrl) {
          showSlideTextMode(slide);
          return;
        }
        var imgEl = el('slidePhotoImg');
        imgEl.onload = function () {
          if (renderSeq !== state.photoRenderSeq || state.currentSlide !== slide || !state.activePhotoIds[slide.photoId]) {
            return;
          }
          var cap = el('slidePhotoCaption');
          if (slide.body) {
            cap.textContent = slide.body;
            toggleHidden(cap, false);
          } else {
            cap.textContent = '';
            toggleHidden(cap, true);
          }
          state.displayedPhotoId = slide.photoId;
          state.displayedSlideId = slide.id;
          toggleHidden(textPanel, true);
          toggleHidden(photoFrame, false);
        };
        imgEl.onerror = function () {
          deletePhotoCache(slide.photoId);
          if (renderSeq === state.photoRenderSeq && state.currentSlide === slide) {
            showSlideTextMode(slide);
          }
        };
        imgEl.src = dataUrl;
      });
    }
  }

  function showSlideTextMode(slide) {
    clearSlidePhoto();
    toggleHidden(el('slidePhotoFrame'), true);
    toggleHidden(el('slideTextPanel'), false);
    el('slideBodyText').textContent = slide.body || slide.title || '';
    var timeTag = el('slideTimeTag');
    if (slide.time) {
      timeTag.textContent = '時間：' + slide.time;
      toggleHidden(timeTag, false);
    } else {
      timeTag.textContent = '';
      toggleHidden(timeTag, true);
    }
  }

  function renderActivities(maxCount) {
    var card = el('cardAct');
    var listEl = el('actList');
    var activities = state.view.activities;
    var limit = typeof maxCount === 'number' ? maxCount : activities.length;
    var visible = activities.slice(0, Math.max(0, limit));
    if (!visible.length) {
      toggleHidden(card, true);
      clearNode(listEl);
      return;
    }
    toggleHidden(card, false);
    clearNode(listEl);
    for (var i = 0; i < visible.length; i++) {
      var act = visible[i];
      var row = document.createElement('div');
      row.className = 'act-row';

      var timeEl = document.createElement('div');
      timeEl.className = 'act-time';
      timeEl.textContent = act.time || '今日';

      var nameEl = document.createElement('div');
      nameEl.className = 'act-name';
      nameEl.textContent = act.title || '';

      row.appendChild(timeEl);
      row.appendChild(nameEl);
      listEl.appendChild(row);
    }
  }

  function renderCountdown() {
    var card = el('cardCd');
    var cd = state.view.countdown;
    if (!cd) {
      toggleHidden(card, true);
      return;
    }
    var todayStr = L.formatDeviceDate(new Date());
    var days = L.calcCountdownDays(todayStr, cd.end);
    if (days === null) {
      toggleHidden(card, true);
      return;
    }
    el('cdTitle').textContent = cd.title || '倒數';
    el('cdNum').textContent = String(days);
    toggleHidden(card, false);
  }

  function renderDailyQuestion() {
    var card = el('cardDaily');
    var list = state.view.dailyList;
    if (!list.length) {
      toggleHidden(card, true);
      return;
    }
    toggleHidden(card, false);
    var item = list[state.dailyIndex % list.length];
    var phaseEl = el('dailyPhase');
    var qEl = el('dailyQuestion');
    var hintEl = el('dailyHint');
    var ansEl = el('dailyAnswer');

    qEl.textContent = item.title || '';
    if (item.body) {
      hintEl.textContent = item.body;
      toggleHidden(hintEl, false);
    } else {
      hintEl.textContent = '';
      toggleHidden(hintEl, true);
    }

    if (state.dailyShowAnswer && item.answer) {
      phaseEl.textContent = '參考答案';
      phaseEl.className = 'daily-phase is-answer';
      ansEl.textContent = '答案：' + item.answer;
      toggleHidden(ansEl, false);
    } else {
      phaseEl.textContent = '思考時間';
      phaseEl.className = 'daily-phase';
      ansEl.textContent = '';
      toggleHidden(ansEl, true);
    }
  }

  function fitLowerColumn() {
    var col = el('lowerCol');
    if (!col) {
      return;
    }
    var plans = [
      { tier: '', acts: 3 },
      { tier: 'is-compact', acts: 3 },
      { tier: 'is-compact', acts: 2 },
      { tier: 'is-tight', acts: 2 },
      { tier: 'is-tight', acts: 1 },
      { tier: 'is-tight', acts: 0 }
    ];
    for (var i = 0; i < plans.length; i++) {
      col.classList.remove('is-compact', 'is-tight');
      if (plans[i].tier) {
        col.classList.add(plans[i].tier);
      }
      renderActivities(plans[i].acts);
      var topY = typeof col.offsetTop === 'number' && col.offsetTop > 0 ? col.offsetTop : 1056;
      var h = Math.max(col.scrollHeight || 0, col.offsetHeight || 0);
      if (h === 0 || topY + h <= 1780) {
        return;
      }
    }
  }

  function renderTicker() {
    var bar = el('tickerBar');
    // The bar hides the anchor's cut-off legs, so it must stay even without notices.
    var notices = state.view.notices.length ? state.view.notices : [{ title: '歡迎來到' + (cfg.SCHOOL_NAME || '校園資訊台'), body: '' }];
    var textEl = el('tickerText');
    var viewport = el('tickerViewport');
    var current = notices[state.tickerIndex % notices.length];
    var nextText = current.body ? (current.title + ' — ' + current.body) : current.title;
    if (textEl.textContent === nextText && !bar.classList.contains('is-hidden')) {
      return;
    }
    state.tickerHoldMs = cfg.TICKER_INTERVAL_MS || 8000;
    textEl.classList.remove('is-marquee');
    textEl.style.webkitAnimationDuration = '';
    textEl.style.animationDuration = '';
    toggleHidden(bar, false);
    textEl.textContent = nextText;
    if (viewport && viewport.clientWidth > 0 && textEl.scrollWidth > viewport.clientWidth) {
      var sec = Math.max(8, Math.round((textEl.scrollWidth + viewport.clientWidth) / 130));
      state.tickerHoldMs = sec * 1000;
      textEl.style.webkitAnimationDuration = sec + 's';
      textEl.style.animationDuration = sec + 's';
      textEl.classList.add('is-marquee');
    }
  }

  // Expired photos may show students: drop them from memory and disk.
  function prunePhotos(active) {
    var keep = {};
    active.forEach(function (item) {
      if (item.photoId) {
        keep[item.photoId] = true;
      }
    });
    state.activePhotoIds = keep;
    if (state.displayedPhotoId && !keep[state.displayedPhotoId]) {
      clearSlidePhoto();
      toggleHidden(el('slidePhotoFrame'), true);
    }
    Object.keys(state.photoUrls).forEach(function (id) {
      if (!keep[id]) {
        delete state.photoUrls[id];
      }
    });
    if (!cfg.FEED_URL || !window.caches) {
      return;
    }
    try {
      window.caches.open(PHOTO_CACHE_NAME).then(function (cache) {
        return cache.keys().then(function (reqs) {
          reqs.forEach(function (req) {
            var m = /[?&]img=([^&]+)/.exec(req.url);
            if (!m || !keep[decodeURIComponent(m[1])]) {
              cache.delete(req);
            }
          });
        });
      }).catch(function () {});
    } catch (e) {}
  }

  function applyItems(items) {
    state.rawItems = Array.isArray(items) ? items : [];
    var todayStr = L.formatDeviceDate(new Date());
    var active = L.filterActiveByDeviceDate(state.rawItems, todayStr);
    state.view = L.partitionItems(active);
    if (state.view.slides.length > 0) {
      state.slideIndex = state.slideIndex % state.view.slides.length;
    } else {
      state.slideIndex = 0;
    }
    if (state.view.dailyList.length > 0) {
      state.dailyIndex = state.dailyIndex % state.view.dailyList.length;
    } else {
      state.dailyIndex = 0;
    }
    if (state.view.notices.length > 0) {
      state.tickerIndex = state.tickerIndex % state.view.notices.length;
    } else {
      state.tickerIndex = 0;
    }
    prunePhotos(active);
    renderMainScreen();
    renderCountdown();
    renderDailyQuestion();
    fitLowerColumn();
    renderTicker();
  }

  function fetchFeed() {
    if (state.feedInFlight) {
      return;
    }
    var baseUrl = cfg.FEED_URL ? cfg.FEED_URL : './sample.json';
    var url = withCacheBust(baseUrl);
    state.feedSeq += 1;
    var seq = state.feedSeq;
    state.feedInFlight = true;
    var timedOut = false;
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timeoutMs = cfg.FEED_TIMEOUT_MS || 30000;
    var timer = setTimeout(function () {
      timedOut = true;
      if (seq === state.feedSeq) {
        state.feedInFlight = false;
        state.feedSeq += 1;
      }
      if (controller && typeof controller.abort === 'function') {
        try { controller.abort(); } catch (e) {}
      }
      var cached = readCachedFeed();
      if (cached) {
        applyItems(cached);
      }
    }, timeoutMs);

    var fetchOpts = { cache: 'no-store' };
    if (controller) {
      fetchOpts.signal = controller.signal;
    }
    fetch(url, fetchOpts).then(function (res) {
      if (!res || !res.ok) {
        throw new Error('feed http');
      }
      return res.json();
    }).then(function (json) {
      clearTimeout(timer);
      if (timedOut || seq !== state.feedSeq) {
        return;
      }
      state.feedInFlight = false;
      if (!json || !json.ok || !Array.isArray(json.items)) {
        throw new Error('feed payload');
      }
      writeCachedFeed(json.items);
      applyItems(json.items);
    }).catch(function () {
      clearTimeout(timer);
      if (timedOut || seq !== state.feedSeq) {
        return;
      }
      state.feedInFlight = false;
      var cached = readCachedFeed();
      if (cached) {
        applyItems(cached);
      }
    });
  }

  // Long notices stay until their marquee finishes one full pass.
  function scheduleTicker() {
    state.tickerTimer = setTimeout(function () {
      if (state.view.notices.length > 1) {
        state.tickerIndex = (state.tickerIndex + 1) % state.view.notices.length;
        renderTicker();
      }
      scheduleTicker();
    }, state.tickerHoldMs || cfg.TICKER_INTERVAL_MS || 8000);
  }

  function scheduleDailyCycle() {
    if (state.dailyTimer) {
      clearTimeout(state.dailyTimer);
    }
    var qMs = cfg.DAILY_QUESTION_MS || 20000;
    var aMs = cfg.DAILY_ANSWER_MS || 8000;
    var delay = state.dailyShowAnswer ? aMs : qMs;
    state.dailyTimer = setTimeout(function () {
      var list = state.view.dailyList;
      if (list.length > 0) {
        if (!state.dailyShowAnswer && list[state.dailyIndex % list.length].answer) {
          state.dailyShowAnswer = true;
        } else {
          state.dailyShowAnswer = false;
          state.dailyIndex = (state.dailyIndex + 1) % list.length;
        }
        renderDailyQuestion();
        fitLowerColumn();
      }
      scheduleDailyCycle();
    }, delay);
  }

  // Two stacked videos: the next action plays before the old one hides, so the character never blinks out.
  function setAction(action) {
    if (state.action === action) {
      return;
    }
    state.action = action;
    var seq = (state.actionSeq = (state.actionSeq || 0) + 1);
    var cur = state.anchorCurrent;
    var next = cur === el('anchorVideo') ? el('anchorVideo2') : el('anchorVideo');
    if (!next) {
      return;
    }
    function stale() {
      return seq !== state.actionSeq;
    }
    function fail() {
      if (stale()) {
        return;
      }
      // Keep whatever is on screen; allow a retry on the next slide.
      state.action = '';
      if (!state.anchorCurrent) {
        toggleHidden(el('anchorImg'), false);
      }
    }
    function show() {
      if (stale()) {
        return;
      }
      state.anchorCurrent = next;
      toggleHidden(next, false);
      toggleHidden(el('anchorImg'), true);
      if (cur && cur !== next) {
        toggleHidden(cur, true);
        cur.pause();
        cur.removeAttribute('src');
        cur.load();
      }
    }
    next.onerror = fail;
    next.oncanplay = function () {
      next.oncanplay = null;
      if (stale()) {
        return;
      }
      var playing = null;
      try {
        playing = next.play();
      } catch (e) {
        fail();
        return;
      }
      if (playing && typeof playing.then === 'function') {
        playing.then(show).catch(fail);
      } else {
        show();
      }
    };
    next.src = './assets/boy-' + action + '.mp4';
    try {
      next.load();
    } catch (e) {
      fail();
    }
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) {
      return;
    }
    var proto = window.location.protocol;
    if (proto !== 'https:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      return;
    }
    navigator.serviceWorker.register('./sw.js').catch(function () {});
  }

  // Admin page embeds this page as its preview, so both always look the same.
  function isPreviewOrigin(origin) {
    var local = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
    return local || /^https:\/\/[a-z0-9-]+\.googleusercontent\.com$/.test(origin);
  }

  function indexOfId(list, id) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        return i;
      }
    }
    return -1;
  }

  function handlePreviewMessage(e) {
    var d = e.data;
    if (e.source !== window.parent || !isPreviewOrigin(e.origin) || !d || d.type !== 'lobby-preview' || !Array.isArray(d.items)) {
      return;
    }
    if (d.photoId && /^data:image\/(jpeg|png);base64,/.test(d.photoData)) {
      state.photoUrls[d.photoId] = d.photoData;
    }
    var view = L.partitionItems(L.filterActiveByDeviceDate(d.items, L.formatDeviceDate(new Date())));
    var slide = indexOfId(view.slides, d.focusId);
    var daily = indexOfId(view.dailyList, d.focusId);
    var notice = indexOfId(view.notices, d.focusId);
    state.fixedPage = slide === -1 ? null : slide;
    if (daily !== -1) {
      state.dailyIndex = daily;
    }
    if (notice !== -1) {
      state.tickerIndex = notice;
    }
    applyItems(d.items);
  }

  function initPreview() {
    window.addEventListener('message', handlePreviewMessage);
    applyItems([]);
    window.parent.postMessage({ type: 'lobby-preview-ready' }, '*');
  }

  function init() {
    el('schoolName').textContent = cfg.SCHOOL_NAME || '圓玄學院第三中學';
    el('stationTag').textContent = cfg.STATION_TAG || '校園資訊台';
    updateClockAndDate();
    fetchWeather();

    var preview = /[?&]preview=1(&|$)/.test(window.location.search) && window.parent !== window;
    if (preview) {
      initPreview();
    } else {
      applyItems(readCachedFeed() || []);
      fetchFeed();
      registerServiceWorker();
      setInterval(fetchFeed, cfg.REFRESH_INTERVAL_MS || 300000);
    }

    setInterval(updateClockAndDate, 15000);
    setInterval(function () {
      applyItems(state.rawItems);
    }, 60000);
    setInterval(fetchWeather, 900000);

    if (state.fixedPage === null) {
      state.slideTimer = setInterval(function () {
        if (state.view.slides.length > 1) {
          state.slideIndex = (state.slideIndex + 1) % state.view.slides.length;
          renderMainScreen();
        }
      }, cfg.SLIDE_INTERVAL_MS || 10000);
    }

    scheduleTicker();

    scheduleDailyCycle();
  }

  init();
})();
