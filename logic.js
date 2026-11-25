(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LobbyLogic = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  var WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

  function pad2(n) {
    return n < 10 ? ('0' + n) : String(n);
  }

  function isValidDateStr(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      return false;
    }
    var parts = s.split('-');
    var y = Number(parts[0]);
    var m = Number(parts[1]);
    var d = Number(parts[2]);
    var dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && (dt.getUTCMonth() + 1) === m && dt.getUTCDate() === d;
  }

  function formatDeviceDate(dateObj) {
    var d = dateObj || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function formatDisplayDate(dateObj) {
    var d = dateObj || new Date();
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEKDAYS[d.getDay()];
  }

  function formatClock(dateObj) {
    var d = dateObj || new Date();
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function calcCountdownDays(todayStr, endStr) {
    if (!isValidDateStr(todayStr) || !isValidDateStr(endStr)) {
      return null;
    }
    var a = todayStr.split('-');
    var b = endStr.split('-');
    var t1 = Date.UTC(Number(a[0]), Number(a[1]) - 1, Number(a[2]));
    var t2 = Date.UTC(Number(b[0]), Number(b[1]) - 1, Number(b[2]));
    var diff = Math.round((t2 - t1) / 86400000);
    return diff < 0 ? 0 : diff;
  }

  function filterActiveByDeviceDate(items, todayStr) {
    if (!Array.isArray(items) || !isValidDateStr(todayStr)) {
      return [];
    }
    var kept = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item || !isValidDateStr(item.end)) {
        continue;
      }
      if (todayStr <= item.end) {
        kept.push(item);
      }
    }
    kept.sort(function (a, b) {
      var oa = Number(a.order);
      var ob = Number(b.order);
      if (!isFinite(oa)) { oa = 0; }
      if (!isFinite(ob)) { ob = 0; }
      return oa - ob;
    });
    return kept;
  }

  function cloneObj(obj) {
    var copy = {};
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) {
        copy[k] = obj[k];
      }
    }
    return copy;
  }

  function parsePeopleLines(peopleStr) {
    if (typeof peopleStr !== 'string' || !peopleStr) {
      return [];
    }
    var raw = peopleStr.replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var line = raw[i].trim();
      if (line) {
        out.push(line);
      }
    }
    return out;
  }

  function parseBoardRows(peopleStr) {
    var lines = parsePeopleLines(peopleStr);
    var rows = [];
    for (var i = 0; i < lines.length; i++) {
      var parts = lines[i].split('\t');
      var name = String(parts[0] || '').trim();
      var note = String(parts[1] || '').trim();
      if (name) {
        rows.push({ name: name, note: note });
      }
    }
    return rows;
  }

  function parseShareAuthor(peopleStr) {
    var lines = parsePeopleLines(peopleStr);
    return lines.length > 0 ? lines[0] : '';
  }

  function partitionItems(items) {
    var list = Array.isArray(items) ? items : [];
    var slides = [];
    var activities = [];
    var reminders = [];
    var countdowns = [];
    var notices = [];
    var welcome = null;

    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || !item.type) {
        continue;
      }
      var type = item.type === '日程' ? '重要提醒' : item.type;
      if (type === '獎項' || type === '分享') {
        slides.push(item);
      } else if (type === '活動') {
        slides.push(item);
        activities.push(item);
      } else if (type === '榮譽榜') {
        var allRows = parseBoardRows(item.people);
        var pageCount = Math.max(1, Math.ceil(allRows.length / 8));
        for (var p = 0; p < pageCount; p++) {
          var pageSlide = cloneObj(item);
          pageSlide.page = p + 1;
          pageSlide.pageCount = pageCount;
          pageSlide.rows = allRows.slice(p * 8, (p + 1) * 8);
          slides.push(pageSlide);
        }
      } else if (type === '歡迎') {
        if (!welcome) {
          welcome = item;
          if (item.tag === '輪播') {
            slides.push(item);
          }
        }
      } else if (type === '重要提醒') {
        if (item.type === '日程') {
          var rem = cloneObj(item);
          rem.type = '重要提醒';
          reminders.push(rem);
        } else {
          reminders.push(item);
        }
      } else if (type === '倒數') {
        countdowns.push(item);
      } else if (type === '通告') {
        notices.push(item);
      }
    }

    var hasAny = slides.length > 0 || activities.length > 0 || reminders.length > 0 ||
      countdowns.length > 0 || notices.length > 0 || Boolean(welcome);

    return {
      slides: slides,
      activities: activities,
      reminders: reminders,
      countdowns: countdowns,
      notices: notices,
      welcome: welcome,
      hasAny: hasAny
    };
  }

  function parseAccessKey(searchStr) {
    if (typeof searchStr !== 'string' || !searchStr) {
      return '';
    }
    var match = /(?:^\?|&)k=([^&]*)(?:&|$)/.exec(searchStr);
    if (!match) {
      return '';
    }
    var val = match[1];
    return /^[A-Za-z0-9_-]{16,64}$/.test(val) ? val : '';
  }

  function parseFixedPage(searchStr) {
    if (typeof searchStr !== 'string' || !searchStr) {
      return null;
    }
    var match = /(?:^\?|&)p=(\d+)(?:&|$)/.exec(searchStr);
    if (!match) {
      return null;
    }
    var num = parseInt(match[1], 10);
    if (!isFinite(num) || num < 1) {
      return null;
    }
    return num - 1;
  }

  function extractStationTemp(rhrreadJson, stationName) {
    if (!rhrreadJson || !rhrreadJson.temperature || !Array.isArray(rhrreadJson.temperature.data)) {
      return null;
    }
    var data = rhrreadJson.temperature.data;
    for (var i = 0; i < data.length; i++) {
      if (data[i] && data[i].place === stationName && typeof data[i].value === 'number') {
        return data[i].value;
      }
    }
    return null;
  }

  function shouldDailyReload(dateObj, lastReloadDateStr, isOnline) {
    if (!isOnline) {
      return false;
    }
    var d = dateObj || new Date();
    if (d.getHours() !== 3 || d.getMinutes() !== 0) {
      return false;
    }
    return formatDeviceDate(d) !== String(lastReloadDateStr || '');
  }

  var ACTIONS = ['wave', 'thumb', 'point', 'idea'];
  var DEFAULT_ACTIONS = {
    '獎項': 'thumb',
    '榮譽榜': 'thumb',
    '活動': 'point',
    '分享': 'point'
  };

  function pickAction(slide) {
    if (!slide) {
      return 'wave';
    }
    if (ACTIONS.indexOf(slide.action) !== -1) {
      return slide.action;
    }
    return DEFAULT_ACTIONS[slide.type] || 'wave';
  }

  function isSafeImageMime(mime) {
    return mime === 'image/jpeg' || mime === 'image/png';
  }

  return {
    pad2: pad2,
    isValidDateStr: isValidDateStr,
    formatDeviceDate: formatDeviceDate,
    formatDisplayDate: formatDisplayDate,
    formatClock: formatClock,
    calcCountdownDays: calcCountdownDays,
    filterActiveByDeviceDate: filterActiveByDeviceDate,
    parsePeopleLines: parsePeopleLines,
    parseBoardRows: parseBoardRows,
    parseShareAuthor: parseShareAuthor,
    partitionItems: partitionItems,
    parseFixedPage: parseFixedPage,
    parseAccessKey: parseAccessKey,
    extractStationTemp: extractStationTemp,
    shouldDailyReload: shouldDailyReload,
    isSafeImageMime: isSafeImageMime,
    pickAction: pickAction
  };
}));
