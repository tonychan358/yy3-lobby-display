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

  function partitionItems(items) {
    var list = Array.isArray(items) ? items : [];
    var slides = [];
    var activities = [];
    var countdown = null;
    var dailyList = [];
    var notices = [];

    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || !item.type) {
        continue;
      }
      if (item.type === '獎項' || item.type === '活動' || item.type === '日程') {
        slides.push(item);
      }
      if (item.type === '活動' && activities.length < 3) {
        activities.push(item);
      }
      if (item.type === '倒數' && !countdown) {
        countdown = item;
      }
      if (item.type === '每日一題') {
        dailyList.push(item);
      }
      if (item.type === '通告') {
        notices.push(item);
      }
    }

    var hasAny = slides.length > 0 || activities.length > 0 || Boolean(countdown) ||
      dailyList.length > 0 || notices.length > 0;

    return {
      slides: slides,
      activities: activities,
      countdown: countdown,
      dailyList: dailyList,
      notices: notices,
      hasAny: hasAny
    };
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
  var DEFAULT_ACTIONS = { '獎項': 'thumb', '活動': 'point', '日程': 'idea' };

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
    partitionItems: partitionItems,
    parseFixedPage: parseFixedPage,
    extractStationTemp: extractStationTemp,
    shouldDailyReload: shouldDailyReload,
    isSafeImageMime: isSafeImageMime,
    pickAction: pickAction
  };
}));
