(function () {
  var cfg = window.LOBBY_CONFIG || {};
  var L = window.LobbyLogic;
  var FEED_CACHE_KEY = 'lobby_feed_cache_v1';
  var PHOTO_CACHE_NAME = 'lobby-photos-v1';
  var RELOAD_FLAG_KEY = 'lobby_last_reload_date';

  var BUG_LABELS = {
    '獎項': '校園焦點',
    '活動': '活動速遞',
    '分享': '校園分享',
    '榮譽榜': '榮譽榜',
    '歡迎': '歡迎'
  };

  var state = {
    rawItems: [],
    view: L.partitionItems([]),
    slideIndex: 0,
    actPage: 0,
    actPerPage: 3,
    cdIndex: 0,
    tickerIndex: 0,
    fixedPage: L.parseFixedPage(window.location.search),
    accessKey: L.parseAccessKey(window.location.search),
    preview: false,
    previewWelcome: false,
    focusActId: '',
    focusReminderId: '',
    currentSlide: null,
    activePhotoIds: {},
    displayedPhotoId: '',
    displayedSlideId: '',
    photoRenderSeq: 0,
    photoUrls: {},
    feedSeq: 0,
    feedInFlight: false,
    slideTimer: null,
    lowerTimer: null,
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

  function appendAccessKey(url) {
    if (!state.accessKey) {
      return url;
    }
    var sep = url.indexOf('?') === -1 ? '?' : '&';
    return url + sep + 'k=' + encodeURIComponent(state.accessKey);
  }

  function buildPhotoCacheKey(photoId) {
    return cfg.FEED_URL + (cfg.FEED_URL.indexOf('?') === -1 ? '?' : '&') +
      'img=' + encodeURIComponent(photoId);
  }

  function buildPhotoRequestUrl(photoId) {
    return appendAccessKey(buildPhotoCacheKey(photoId));
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
    state.displayedSlideId = '';
  }

  function deletePhotoCache(photoId) {
    delete state.photoUrls[photoId];
    if (!cfg.FEED_URL || !window.caches) {
      return;
    }
    var cacheKey = buildPhotoCacheKey(photoId);
    try {
      window.caches.open(PHOTO_CACHE_NAME).then(function (cache) {
        return cache.delete(cacheKey);
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
    if (state.preview) {
      callback(null);
      return;
    }
    var cacheKey = buildPhotoCacheKey(photoId);
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
              return cache.put(cacheKey, new Response(JSON.stringify({ mime: json.mime, data: json.data }), {
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
          return cache.match(cacheKey);
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

  function renderAwardPeople(lines, hasBody) {
    var ap = el('awardPeople');
    if (!lines.length) {
      toggleHidden(ap, true);
      clearNode(ap);
      return;
    }
    toggleHidden(ap, false);
    clearNode(ap);
    ap.className = 'award-people ' + (lines.length <= 3 ? 'is-one-col' : 'is-two-col');
    var maxLen = 0;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].length > maxLen) {
        maxLen = lines[i].length;
      }
      var item = document.createElement('div');
      item.className = 'award-person';
      item.textContent = lines[i];
      ap.appendChild(item);
    }
    if ((lines.length <= 3 && maxLen > 15) || (lines.length > 3 && maxLen > 11)) {
      ap.classList.add('is-long');
    }
    if (hasBody) {
      ap.classList.add('has-body');
    }
  }

  function renderBoardRows(slide) {
    var listEl = el('boardList');
    clearNode(listEl);
    var rows = slide.rows || [];
    var isRanked = slide.tag === '排名';
    var startRank = ((slide.page || 1) - 1) * 8;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var rowEl = document.createElement('div');
      rowEl.className = 'board-row';
      if (isRanked) {
        var rank = startRank + i + 1;
        var rankEl = document.createElement('div');
        var rankCls = rank === 1 ? 'is-gold' : (rank === 2 ? 'is-silver' : (rank === 3 ? 'is-bronze' : 'is-num'));
        rankEl.className = 'board-rank ' + rankCls;
        rankEl.textContent = String(rank);
        rowEl.appendChild(rankEl);
      }
      var nameEl = document.createElement('div');
      nameEl.className = 'board-name';
      nameEl.textContent = r.name || '';
      rowEl.appendChild(nameEl);
      if (r.note) {
        var noteEl = document.createElement('div');
        noteEl.className = 'board-note';
        noteEl.textContent = r.note;
        rowEl.appendChild(noteEl);
      }
      listEl.appendChild(rowEl);
    }
  }

  function applyPhotoShownLayout(slide, shareAuthor, hasAwardPeople) {
    el('ledScreen').classList.remove('is-headline-only');
    toggleHidden(el('slideTextPanel'), true);
    var frame = el('slidePhotoFrame');
    var cap = el('slidePhotoCaption');
    var shareSide = el('slideShareSide');
    if (hasAwardPeople) {
      el('awardPeople').classList.add('has-photo');
      el('awardPeople').classList.remove('has-body');
    }
    if (slide.type === '分享') {
      frame.classList.add('is-share-split');
      cap.textContent = '';
      toggleHidden(cap, true);
      if (slide.body || shareAuthor) {
        el('slideShareSideBody').textContent = slide.body || '';
        toggleHidden(el('slideShareSideBody'), !slide.body);
        el('slideShareSideAuthor').textContent = shareAuthor ? ('分享：' + shareAuthor) : '';
        toggleHidden(el('slideShareSideAuthor'), !shareAuthor);
        toggleHidden(shareSide, false);
      } else {
        toggleHidden(shareSide, true);
      }
    } else {
      frame.classList.remove('is-share-split');
      toggleHidden(shareSide, true);
      if (slide.body) {
        cap.textContent = slide.body;
        toggleHidden(cap, false);
      } else {
        cap.textContent = '';
        toggleHidden(cap, true);
      }
    }
    toggleHidden(frame, false);
  }

  function showSlideTextMode(slide, shareAuthor, hasAwardPeople) {
    clearSlidePhoto();
    var frame = el('slidePhotoFrame');
    frame.classList.remove('is-share-split');
    toggleHidden(frame, true);
    var ap = el('awardPeople');
    ap.classList.remove('has-photo');
    var hasBody = Boolean(slide.body);
    var hasTime = Boolean(slide.time);
    var hasAuthor = Boolean(shareAuthor);
    // Time alone is already in the top-left tag.
    if (hasBody || hasAuthor) {
      el('ledScreen').classList.remove('is-headline-only');
      el('slideBodyText').textContent = slide.body || '';
      toggleHidden(el('slideBodyText'), !hasBody);
      el('slideAuthorTag').textContent = hasAuthor ? ('分享：' + shareAuthor) : '';
      toggleHidden(el('slideAuthorTag'), !hasAuthor);
      el('slideTimeTag').textContent = hasTime ? ('時間：' + slide.time) : '';
      toggleHidden(el('slideTimeTag'), !hasTime);
      toggleHidden(el('slideTextPanel'), false);
      if (hasAwardPeople && hasBody) {
        ap.classList.add('has-body');
      }
    } else {
      toggleHidden(el('slideTextPanel'), true);
      ap.classList.remove('has-body');
      if (!hasAwardPeople) {
        el('ledScreen').classList.add('is-headline-only');
      } else {
        el('ledScreen').classList.remove('is-headline-only');
      }
    }
  }

  function renderMainScreen() {
    var slides = state.view.slides;
    var ledScreen = el('ledScreen');
    var metaRow = el('slideMetaRow');
    var headlineRow = el('slideHeadlineRow');
    var headline = el('slideHeadline');
    var pageBadge = el('slidePageBadge');
    var awardPeople = el('awardPeople');
    var photoFrame = el('slidePhotoFrame');
    var textPanel = el('slideTextPanel');
    var boardPanel = el('boardPanel');
    var welcomePanel = el('welcomePanel');
    var dotsBar = el('dotsBar');
    state.photoRenderSeq += 1;
    var renderSeq = state.photoRenderSeq;

    var slide = null;
    var idx = 0;
    var isFallbackWelcome = false;
    if (state.previewWelcome && state.view.welcome) {
      slide = state.view.welcome;
      isFallbackWelcome = true;
    } else if (slides.length === 0 && state.view.welcome) {
      slide = state.view.welcome;
      isFallbackWelcome = true;
    } else if (slides.length > 0) {
      idx = state.fixedPage !== null
        ? Math.min(state.fixedPage, slides.length - 1)
        : (state.slideIndex % slides.length);
      slide = slides[idx];
    }

    if (!slide) {
      state.currentSlide = null;
      clearSlidePhoto();
      ledScreen.classList.remove('is-headline-only');
      toggleHidden(metaRow, true);
      toggleHidden(headlineRow, true);
      toggleHidden(awardPeople, true);
      toggleHidden(photoFrame, true);
      toggleHidden(textPanel, true);
      toggleHidden(boardPanel, true);
      toggleHidden(dotsBar, true);
      toggleHidden(welcomePanel, false);
      el('welcomeSchool').textContent = cfg.SCHOOL_NAME || '圓玄學院第三中學';
      setAction('wave');
      return;
    }

    toggleHidden(welcomePanel, true);
    toggleHidden(metaRow, false);
    toggleHidden(headlineRow, false);
    toggleHidden(dotsBar, isFallbackWelcome || slides.length <= 1);

    state.currentSlide = slide;
    setAction(L.pickAction(slide));

    if (slide.type === '分享') {
      el('slideTypeTag').textContent = slide.tag || '分享';
    } else if (slide.type === '歡迎') {
      el('slideTypeTag').textContent = '歡迎';
    } else if (slide.type === '活動') {
      el('slideTypeTag').textContent = slide.time ? ('活動 · ' + slide.time) : '活動';
    } else {
      el('slideTypeTag').textContent = slide.type;
    }
    el('slideBugText').textContent = BUG_LABELS[slide.type] || '校園資訊';
    headline.textContent = slide.title || '';
    // Long titles drop to one line when the rest of the panel needs the space.
    ledScreen.classList.toggle('is-dense', (slide.title || '').length > 11 &&
      (slide.type === '榮譽榜' || slide.type === '分享' || (slide.type === '獎項' && Boolean(slide.people))));

    if (slide.type === '榮譽榜' && slide.pageCount > 1) {
      pageBadge.textContent = slide.page + '/' + slide.pageCount;
      toggleHidden(pageBadge, false);
    } else {
      pageBadge.textContent = '';
      toggleHidden(pageBadge, true);
    }

    clearNode(dotsBar);
    if (!isFallbackWelcome && slides.length > 1) {
      for (var i = 0; i < slides.length; i++) {
        var dot = document.createElement('div');
        dot.className = i === idx ? 'dot-active' : 'dot';
        dotsBar.appendChild(dot);
      }
    }

    if (slide.type === '榮譽榜') {
      clearSlidePhoto();
      toggleHidden(photoFrame, true);
      toggleHidden(textPanel, true);
      toggleHidden(awardPeople, true);
      if (!slide.rows || slide.rows.length === 0) {
        toggleHidden(boardPanel, true);
        ledScreen.classList.add('is-headline-only');
      } else {
        ledScreen.classList.remove('is-headline-only');
        renderBoardRows(slide);
        toggleHidden(boardPanel, false);
      }
      return;
    }

    toggleHidden(boardPanel, true);
    var peopleLines = slide.type === '獎項' ? L.parsePeopleLines(slide.people) : [];
    renderAwardPeople(peopleLines, Boolean(slide.body));
    var shareAuthor = slide.type === '分享' ? L.parseShareAuthor(slide.people) : '';
    var hasAwardPeople = peopleLines.length > 0;

    // Periodic re-renders must not flash the text panel over a photo already on screen.
    if (slide.photoId && state.displayedPhotoId === slide.photoId && state.displayedSlideId === slide.id) {
      applyPhotoShownLayout(slide, shareAuthor, hasAwardPeople);
      return;
    }
    if (!slide.photoId || !state.photoUrls[slide.photoId]) {
      showSlideTextMode(slide, shareAuthor, hasAwardPeople);
    }
    if (slide.photoId) {
      resolvePhotoUrl(slide.photoId, function (dataUrl) {
        if (renderSeq !== state.photoRenderSeq || state.currentSlide !== slide || !state.activePhotoIds[slide.photoId]) {
          return;
        }
        if (!dataUrl) {
          showSlideTextMode(slide, shareAuthor, hasAwardPeople);
          return;
        }
        var imgEl = el('slidePhotoImg');
        imgEl.onload = function () {
          if (renderSeq !== state.photoRenderSeq || state.currentSlide !== slide || !state.activePhotoIds[slide.photoId]) {
            return;
          }
          state.displayedPhotoId = slide.photoId;
          state.displayedSlideId = slide.id;
          applyPhotoShownLayout(slide, shareAuthor, hasAwardPeople);
        };
        imgEl.onerror = function () {
          deletePhotoCache(slide.photoId);
          if (renderSeq === state.photoRenderSeq && state.currentSlide === slide) {
            showSlideTextMode(slide, shareAuthor, hasAwardPeople);
          }
        };
        imgEl.src = dataUrl;
      });
    }
  }

  function renderDots(container, count, activeIdx) {
    if (!container) {
      return;
    }
    clearNode(container);
    if (count <= 1) {
      toggleHidden(container, true);
      return;
    }
    toggleHidden(container, false);
    for (var i = 0; i < count; i++) {
      var dot = document.createElement('span');
      dot.className = i === activeIdx ? 'card-dot is-active' : 'card-dot';
      container.appendChild(dot);
    }
  }

  function renderReminders() {
    var card = el('cardReminder');
    var listEl = el('reminderList');
    var list = state.view.reminders || [];
    if (!list.length) {
      toggleHidden(card, true);
      clearNode(listEl);
      return;
    }
    var visible = list.slice(0, 2);
    if (state.focusReminderId) {
      var fIdx = indexOfId(list, state.focusReminderId);
      if (fIdx >= 2) {
        visible = [list[fIdx], list[0]];
      }
    }
    toggleHidden(card, false);
    clearNode(listEl);
    for (var i = 0; i < visible.length; i++) {
      var item = visible[i];
      var row = document.createElement('div');
      row.className = 'reminder-row';
      var titleEl = document.createElement('div');
      titleEl.className = 'reminder-title';
      titleEl.textContent = item.title || '';
      row.appendChild(titleEl);
      if (item.body) {
        var bodyEl = document.createElement('div');
        bodyEl.className = 'reminder-body';
        bodyEl.textContent = item.body;
        row.appendChild(bodyEl);
      }
      listEl.appendChild(row);
    }
  }

  function renderActivities(maxCount) {
    var card = el('cardAct');
    var listEl = el('actList');
    var dotsEl = el('actDots');
    var activities = state.view.activities || [];
    var perPage = typeof maxCount === 'number' ? Math.max(0, maxCount) : Math.min(3, activities.length);
    if (!activities.length || perPage === 0) {
      toggleHidden(card, true);
      clearNode(listEl);
      renderDots(dotsEl, 0, 0);
      return;
    }
    var pageCount = Math.ceil(activities.length / perPage);
    if (state.focusActId) {
      var fIdx = indexOfId(activities, state.focusActId);
      if (fIdx !== -1) {
        state.actPage = Math.floor(fIdx / perPage);
      }
    }
    var pageIdx = state.actPage % pageCount;
    var visible = activities.slice(pageIdx * perPage, (pageIdx + 1) * perPage);
    toggleHidden(card, false);
    renderDots(dotsEl, pageCount, pageIdx);
    clearNode(listEl);
    for (var i = 0; i < visible.length; i++) {
      var act = visible[i];
      var row = document.createElement('div');
      row.className = act.time && act.time.length > 6 ? 'act-row is-stacked' : 'act-row';

      if (act.time) {
        var timeEl = document.createElement('div');
        timeEl.className = 'act-time';
        timeEl.textContent = act.time;
        row.appendChild(timeEl);
      }

      var nameEl = document.createElement('div');
      nameEl.className = 'act-name';
      nameEl.textContent = act.title || '';

      row.appendChild(nameEl);
      listEl.appendChild(row);
    }
  }

  function renderCountdown() {
    var card = el('cardCd');
    var dotsEl = el('cdDots');
    var list = state.view.countdowns || [];
    if (!list.length) {
      toggleHidden(card, true);
      renderDots(dotsEl, 0, 0);
      return;
    }
    var todayStr = L.formatDeviceDate(new Date());
    var valid = [];
    for (var i = 0; i < list.length; i++) {
      var days = L.calcCountdownDays(todayStr, list[i].end);
      if (days !== null) {
        valid.push({ item: list[i], days: days });
      }
    }
    if (!valid.length) {
      toggleHidden(card, true);
      renderDots(dotsEl, 0, 0);
      return;
    }
    var idx = state.cdIndex % valid.length;
    var current = valid[idx];
    el('cdTitle').textContent = current.item.title || '倒數';
    el('cdNum').textContent = String(current.days);
    renderDots(dotsEl, valid.length, idx);
    toggleHidden(card, false);
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
      state.actPerPage = plans[i].acts;
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
      // The admin page sends each preview photo only once.
      if (!keep[id] && (!state.preview || id.indexOf('draft-') === 0)) {
        delete state.photoUrls[id];
      }
    });
    if (state.preview || !cfg.FEED_URL || !window.caches) {
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

  function currentSlideKey() {
    var s = state.currentSlide;
    return s ? (String(s.id || '') + ':' + String(s.page || 0) + ':' + String(s.type || '')) : '';
  }

  function applyItems(items) {
    var prevKey = currentSlideKey();
    state.rawItems = Array.isArray(items) ? items : [];
    var todayStr = L.formatDeviceDate(new Date());
    var active = L.filterActiveByDeviceDate(state.rawItems, todayStr);
    state.view = L.partitionItems(active);
    if (state.view.slides.length > 0) {
      state.slideIndex = state.slideIndex % state.view.slides.length;
    } else {
      state.slideIndex = 0;
    }
    if (state.view.countdowns.length > 0) {
      state.cdIndex = state.cdIndex % state.view.countdowns.length;
    } else {
      state.cdIndex = 0;
    }
    if (state.view.notices.length > 0) {
      state.tickerIndex = state.tickerIndex % state.view.notices.length;
    } else {
      state.tickerIndex = 0;
    }
    prunePhotos(active);
    renderMainScreen();
    renderReminders();
    renderCountdown();
    fitLowerColumn();
    renderTicker();
    if (state.fixedPage !== null || state.previewWelcome || !state.slideTimer || currentSlideKey() !== prevKey) {
      scheduleSlideCycle();
    }
  }

  function fetchFeed() {
    if (state.feedInFlight) {
      return;
    }
    var baseUrl = cfg.FEED_URL ? cfg.FEED_URL : './sample.json';
    var url = withCacheBust(appendAccessKey(baseUrl));
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

  function scheduleSlideCycle() {
    if (state.slideTimer) {
      clearTimeout(state.slideTimer);
      state.slideTimer = null;
    }
    if (state.fixedPage !== null || state.previewWelcome) {
      return;
    }
    var slide = state.currentSlide;
    var delay = (slide && slide.type === '榮譽榜')
      ? (cfg.BOARD_INTERVAL_MS || 15000)
      : (cfg.SLIDE_INTERVAL_MS || 10000);
    state.slideTimer = setTimeout(function () {
      state.slideTimer = null;
      if (state.view.slides.length > 1) {
        state.slideIndex = (state.slideIndex + 1) % state.view.slides.length;
        renderMainScreen();
      }
      scheduleSlideCycle();
    }, delay);
  }

  function scheduleLowerCycle() {
    if (state.lowerTimer) {
      clearTimeout(state.lowerTimer);
    }
    var delay = cfg.LOWER_INTERVAL_MS || 8000;
    state.lowerTimer = setTimeout(function () {
      var changed = false;
      var acts = state.view.activities || [];
      if (!state.focusActId && state.actPerPage > 0 && acts.length > state.actPerPage) {
        var actPageCount = Math.ceil(acts.length / state.actPerPage);
        if (actPageCount > 1) {
          state.actPage = (state.actPage + 1) % actPageCount;
          changed = true;
        }
      }
      var cds = state.view.countdowns || [];
      if (!state.focusCdId && cds.length > 1) {
        state.cdIndex = (state.cdIndex + 1) % cds.length;
        renderCountdown();
        changed = true;
      }
      if (changed) {
        fitLowerColumn();
      }
      scheduleLowerCycle();
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
    if (e.source !== window.parent || !isPreviewOrigin(e.origin) || !d) {
      return;
    }
    if (d.type === 'lobby-preview-photo') {
      if (d.photoId && /^data:image\/(jpeg|png);base64,/.test(d.photoData)) {
        state.photoUrls[d.photoId] = d.photoData;
        applyItems(state.rawItems);
      }
      return;
    }
    if (d.type !== 'lobby-preview' || !Array.isArray(d.items)) {
      return;
    }
    if (d.photoId && /^data:image\/(jpeg|png);base64,/.test(d.photoData)) {
      state.photoUrls[d.photoId] = d.photoData;
    }
    var view = L.partitionItems(L.filterActiveByDeviceDate(d.items, L.formatDeviceDate(new Date())));
    var focusId = d.focusId || '';
    var slide = indexOfId(view.slides, focusId);
    var actIdx = indexOfId(view.activities, focusId);
    var cdIdx = indexOfId(view.countdowns, focusId);
    var remIdx = indexOfId(view.reminders, focusId);
    var notice = indexOfId(view.notices, focusId);

    state.fixedPage = slide === -1 ? null : slide;
    state.previewWelcome = Boolean(focusId && view.welcome && view.welcome.id === focusId && slide === -1);
    state.focusActId = actIdx !== -1 ? focusId : '';
    state.focusReminderId = remIdx !== -1 ? focusId : '';
    state.focusCdId = cdIdx !== -1 ? focusId : '';
    if (cdIdx !== -1) {
      state.cdIndex = cdIdx;
    }
    if (notice !== -1) {
      state.tickerIndex = notice;
    }
    applyItems(d.items);
  }

  function initPreview() {
    state.preview = true;
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

    if (!state.slideTimer) {
      scheduleSlideCycle();
    }
    scheduleTicker();
    scheduleLowerCycle();
  }

  init();
})();
