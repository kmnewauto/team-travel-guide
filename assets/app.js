/* ===================================================
   同行 · 团队旅游指南 —— 核心逻辑（通用版）
   · 初始空白，组团人用向导逐天录入城市/酒店/景点/出发时间
   · 美食、购物、避坑由 App 自动获取（地理编码 + 百科 + 规则库，可选 AI）
   · 首页 / 今天 / 游程 三页 + 密码登录 + 链接与短信推送
   =================================================== */
(function () {
  'use strict';

  var LS_PLAN = 'tgt.plan.v3';
  var LS_UNLOCK = 'tgt.unlocked.v3';
  var LS_WX = 'tgt.wx.v1';
  var LS_AI = 'tgt.ai.v1';
  var LS_WIKI = 'tgt.wiki.v1';     // 简介缓存（避免重复抓取）
  var GEN_CONC = 2;                // 生成指南的并行城市数
  var T_NET = 5000;                // 通用网络请求超时（毫秒）
  var T_AI = 12000;                // AI 请求超时（毫秒）

  var state = { plan: null, route: 'home', admin: false, sharedView: false };
  var wz = null;                                  // 创建向导的临时状态

  /* ================= 工具 ================= */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function toDate(s) { var p = String(s || '').split('-'); return new Date(+p[0], (+p[1] || 1) - 1, +p[2] || 1); }
  function iso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function fmtMD(s) { var p = String(s || '').split('-'); return p.length < 3 ? s : (+p[1]) + '月' + (+p[2]) + '日'; }
  function weekday(s) { return '周' + '日一二三四五六'.charAt(toDate(s).getDay()); }
  function daysBetween(a, b) { return Math.round((toDate(b) - toDate(a)) / 86400000); }
  function greeting() {
    var h = new Date().getHours();
    if (h < 6) return '夜深了';
    if (h < 11) return '早上好';
    if (h < 14) return '中午好';
    if (h < 18) return '下午好';
    if (h < 23) return '晚上好';
    return '夜深了';
  }
  var toastTimer = null;
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg; el.hidden = false;
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2200);
  }

  /* ---------- base64 / 压缩 ---------- */
  function bytesToB64Url(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64UrlToBytes(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    var bin = atob(s), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  function b64e(str) { return bytesToB64Url(new TextEncoder().encode(str)); }
  function b64d(s) { return new TextDecoder().decode(b64UrlToBytes(s)); }
  function deflateB64(str) {
    if (typeof CompressionStream !== 'function') return Promise.resolve(null);
    try {
      var blob = new Blob([new TextEncoder().encode(str)]);
      return new Response(blob.stream().pipeThrough(new CompressionStream('deflate-raw')))
        .arrayBuffer().then(function (ab) { return bytesToB64Url(new Uint8Array(ab)); })
        .catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }
  function inflateB64(s) {
    if (typeof DecompressionStream !== 'function') return Promise.resolve(null);
    try {
      var blob = new Blob([b64UrlToBytes(s)]);
      return new Response(blob.stream().pipeThrough(new DecompressionStream('deflate-raw')))
        .arrayBuffer().then(function (ab) { return new TextDecoder().decode(new Uint8Array(ab)); })
        .catch(function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  /* ================= 数据存取 ================= */
  function ssget(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssset(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { } }
  function ssdel(k) { try { sessionStorage.removeItem(k); } catch (e) { } }
  function lsdel(k) { try { localStorage.removeItem(k); } catch (e) { } }

  function savePlan(p) { p.updatedAt = Date.now(); try { localStorage.setItem(LS_PLAN, JSON.stringify(p)); } catch (e) { } }
  function loadPlan() { try { var s = localStorage.getItem(LS_PLAN); return s ? JSON.parse(s) : null; } catch (e) { return null; } }

  function blankPlan() {
    var d = new Date();
    var e = new Date(d.getTime() + 5 * 86400000);
    return {
      id: 'p' + Date.now(),
      title: '', organizer: { name: '', phone: '' },
      passcode: DEMO.DEFAULT_PASSCODE,
      startDate: iso(d), endDate: iso(e),
      note: '', members: [], days: []
    };
  }

  /* ================= 行程定位 ================= */
  function locate(plan) {
    var t = todayStr(), n = plan.days.length;
    var diff = daysBetween(plan.startDate, t);
    if (!n) return { status: 'none', total: 0 };
    if (diff < 0) return { status: 'before', daysLeft: -diff, day: plan.days[0], idx: 0, total: n };
    if (diff >= n) return { status: 'after', day: plan.days[n - 1], idx: n, total: n };
    return { status: 'in', day: plan.days[diff], idx: diff + 1, total: n };
  }

  /* ================= 天气 ================= */
  var WMO = {
    0: ['晴', '☀️'], 1: ['晴间多云', '🌤️'], 2: ['多云', '⛅'], 3: ['阴', '☁️'],
    45: ['雾', '🌫️'], 48: ['雾凇', '🌫️'], 51: ['毛毛雨', '🌦️'], 53: ['小雨', '🌦️'],
    55: ['中雨', '🌧️'], 56: ['冻雨', '🌧️'], 57: ['冻雨', '🌧️'],
    61: ['小雨', '🌦️'], 63: ['中雨', '🌧️'], 65: ['大雨', '🌧️'], 66: ['冻雨', '🌧️'], 67: ['冻雨', '🌧️'],
    71: ['小雪', '🌨️'], 73: ['中雪', '🌨️'], 75: ['大雪', '❄️'], 77: ['米雪', '🌨️'],
    80: ['阵雨', '🌦️'], 81: ['阵雨', '🌧️'], 82: ['强阵雨', '⛈️'], 85: ['阵雪', '🌨️'], 86: ['强阵雪', '❄️'],
    95: ['雷阵雨', '⛈️'], 96: ['雷阵雨伴冰雹', '⛈️'], 99: ['强雷暴', '⛈️']
  };
  function wmo(c) { return WMO[c] || ['—', '🌡️']; }
  function wxKey(d) { return d.city + '|' + d.date; }
  function readWxCache(d) {
    try { var all = JSON.parse(localStorage.getItem(LS_WX) || '{}'), c = all[wxKey(d)]; if (c && c.t === todayStr()) return c.d; } catch (e) { }
    return null;
  }
  function writeWxCache(d, data) {
    try { var all = JSON.parse(localStorage.getItem(LS_WX) || '{}'); all[wxKey(d)] = { t: todayStr(), d: data }; localStorage.setItem(LS_WX, JSON.stringify(all)); } catch (e) { }
  }
  function estimateWeather(d) {
    var lat = d.lat != null ? d.lat : 35, dt = toDate(d.date);
    var doy = Math.floor((dt - new Date(dt.getFullYear(), 0, 0)) / 86400000);
    var season = Math.cos((doy - (lat >= 0 ? 202 : 20)) / 365 * 2 * Math.PI);
    var avg = (32 - Math.abs(lat) * 0.42) + season * 12;
    var seed = 0, s = d.city + d.date;
    for (var i = 0; i < s.length; i++) seed = (seed * 31 + s.charCodeAt(i)) % 997;
    var code = [0, 1, 2, 3, 61, 80][seed % 6], w = wmo(code);
    return {
      code: code, text: w[0], icon: w[1], temp: Math.round(avg), feels: Math.round(avg - 1),
      max: Math.round(avg + 4), min: Math.round(avg - 4),
      pop: code >= 61 ? 60 : (code === 3 ? 20 : 10), wind: 12, humidity: 62, estimated: true
    };
  }
  function fetchWeather(d) {
    var c = readWxCache(d);
    if (c) return Promise.resolve(c);
    if (d.lat == null || typeof fetch !== 'function' || navigator.onLine === false) return Promise.resolve(estimateWeather(d));
    var url = 'https://api.open-meteo.com/v1/forecast'
      + '?latitude=' + encodeURIComponent(d.lat) + '&longitude=' + encodeURIComponent(d.lon)
      + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m'
      + '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max'
      + '&timezone=auto&forecast_days=1';
    return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      var cu = j.current || {}, dd = j.daily || {}, code = cu.weather_code != null ? cu.weather_code : 0, w = wmo(code);
      var data = {
        code: code, text: w[0], icon: w[1], temp: Math.round(cu.temperature_2m),
        feels: Math.round(cu.apparent_temperature != null ? cu.apparent_temperature : cu.temperature_2m),
        max: Math.round((dd.temperature_2m_max || [])[0]), min: Math.round((dd.temperature_2m_min || [])[0]),
        pop: Math.round((dd.precipitation_probability_max || [0])[0]),
        wind: Math.round(cu.wind_speed_10m || 0), humidity: Math.round(cu.relative_humidity_2m || 0), estimated: false
      };
      if (isNaN(data.temp)) return estimateWeather(d);
      writeWxCache(d, data); return data;
    }).catch(function () { return estimateWeather(d); });
  }
  function dressAdvice(w) {
    var t = w.temp, a = [];
    if (t >= 30) a.push('短袖短裤为主，选速干透气面料');
    else if (t >= 26) a.push('短袖 + 薄长裤/长裙，注意防晒');
    else if (t >= 21) a.push('短袖 + 薄外套，早晚有温差');
    else if (t >= 16) a.push('长袖 + 薄夹克或针织开衫');
    else if (t >= 11) a.push('风衣/厚外套 + 长袖打底');
    else if (t >= 5) a.push('毛衣 + 厚外套，注意保暖');
    else a.push('羽绒服 + 保暖内衣，帽子手套必备');
    if (w.pop >= 60) a.push('降雨概率高，雨具必带，最好防水鞋');
    else if (w.pop >= 30) a.push('折叠伞备用，以防阵雨');
    if (w.wind >= 30) a.push('风力较大，帽子需防风，避免长裙');
    if (t >= 26) a.push('墨镜 + 高倍防晒霜 + 便携水杯');
    return a;
  }

  /* ================= 自动资料获取 ================= */
  function netOK() { return typeof fetch === 'function' && navigator.onLine !== false; }

  /* 带超时的 fetch：超时按失败处理（网络被墙/慢时不再无限挂起） */
  function fetchT(url, opts, ms) {
    if (typeof AbortController === 'undefined') return fetch(url, opts);
    var c = new AbortController();
    var timer = setTimeout(function () { try { c.abort(); } catch (e) { } }, ms || T_NET);
    var o = Object.assign({}, opts || {}, { signal: c.signal });
    return fetch(url, o).then(function (r) {
      clearTimeout(timer); return r;
    }, function (e) {
      clearTimeout(timer); throw e;
    });
  }

  /* 简介缓存：按 词条 缓存拉取结果 */
  function readWikiCache(k) {
    try { var all = JSON.parse(localStorage.getItem(LS_WIKI) || '{}'); return all[k] || null; } catch (e) { return null; }
  }
  function writeWikiCache(k, v) {
    try {
      var all = JSON.parse(localStorage.getItem(LS_WIKI) || '{}');
      if (Object.keys(all).length > 500) all = {};          // 防膨胀
      all[k] = v; localStorage.setItem(LS_WIKI, JSON.stringify(all));
    } catch (e) { }
  }

  function geocode(city) {
    var local = DEMO.lookupCity(city);          // 内置库优先（中文地名更准）
    if (local) {
      return Promise.resolve({ lat: local.lat, lon: local.lon, country: local.c, code: '' });
    }
    if (!city || !netOK()) return Promise.resolve(null);
    return fetchT('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(city)
      + '&count=1&language=zh&format=json', null, T_NET)
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var r0 = j.results && j.results[0];
        if (!r0) return null;
        return {
          lat: r0.latitude, lon: r0.longitude,
          country: DEMO.COUNTRY_CN[r0.country_code] || r0.country || '',
          code: r0.country_code || ''
        };
      }).catch(function () { return null; });
  }

  var wikiDead = false;                 // 本会话内维基百科不可达（被墙/超时）→ 不再逐城空等

  function wikiSummary(title) {
    if (!title || !netOK() || wikiDead) return Promise.resolve('');
    var hit = readWikiCache(title);
    if (hit != null) return Promise.resolve(hit);
    var url = 'https://zh.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1'
      + '&format=json&origin=*&redirects=1&titles=' + encodeURIComponent(title);
    return fetchT(url, null, T_NET).then(function (r) { return r.json(); }).then(function (j) {
      var pages = (j.query && j.query.pages) || {};
      for (var k in pages) { var p = pages[k]; if (p && p.extract) { var t = clip(p.extract, 150); writeWikiCache(title, t); return t; } }
      writeWikiCache(title, ''); return '';
    }).catch(function (e) {
      /* 连不上（如大陆访问维基被墙）→ 本会话剩余城市直接跳过，避免每城空等 5s */
      wikiDead = true;
      return '';
    });
  }
  function clip(t, n) {
    t = String(t).replace(/\s+/g, ' ').trim();
    if (t.length <= n) return t;
    var cut = t.slice(0, n);
    var m = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('，'));
    return (m > 40 ? cut.slice(0, m) : cut) + '…';
  }

  function emojiFor(name) {
    var n = name || '';
    var map = [
      ['🏛️', ['博物', '美术馆', '遗址', '遗迹', '古城', '广场']],
      ['⛩️', ['寺', '庙', '神社', '观', '庵']],
      ['🏰', ['宫', '堡', '城', '王宫']],
      ['⛰️', ['山', '峰', '岳', '岭']],
      ['🏖️', ['海', '湾', '滩', '岛', '滨']],
      ['🗼', ['塔']],
      ['🌳', ['公园', '森林', '植物园', '园']],
      ['⛪', ['教堂', '大教堂', '修道院']],
      ['🌉', ['桥', '渡']],
      ['🏟️', ['竞技场', '体育场', '剧场']]
    ];
    for (var i = 0; i < map.length; i++) {
      for (var j = 0; j < map[i][1].length; j++) if (n.indexOf(map[i][1][j]) >= 0) return map[i][0];
    }
    return '📍';
  }

  function pair(s) {
    var m = /^([^：:]+)[：:]\s*(.*)$/.exec(String(s || ''));
    return m ? { name: m[1].trim(), desc: m[2].trim() } : { name: String(s || '').trim(), desc: '' };
  }

  function rulesFor(country, city, intro) {
    var r = DEMO.RULES[country] || DEMO.fallbackRules(country, city);
    var food = r.food.slice(), shop = r.shop.slice(), pit = r.pit.slice();

    /* 城市级特色优先（比国别规则更贴地） */
    var t = DEMO.cityTips(city);
    if (t) {
      food = t.f.map(pair).concat(food);
      shop = t.s.map(pair).concat(shop);
      pit = pit.concat(t.p);
    }

    /* 依据城市 / 景点简介的关键词增强 */
    var blob = (city || '') + ' ' + (intro || '');
    DEMO.KEY_HINTS.forEach(function (h) {
      var hit = h.k.some(function (k) { return blob.indexOf(k) >= 0; });
      if (hit) { food.unshift(h.food); pit.push(h.pit); }
    });

    return {
      food: food.slice(0, 4),
      shop: shop.slice(0, 3),
      pitfalls: pit.slice(0, 5).map(function (x) {
        return typeof x === 'string' ? { name: x, desc: '' } : x;
      })
    };
  }

  function getAI() { try { return JSON.parse(localStorage.getItem(LS_AI) || '{}'); } catch (e) { return {}; } }
  function setAI(c) { try { localStorage.setItem(LS_AI, JSON.stringify(c)); } catch (e) { } }
  function aiGuide(day) {
    var c = getAI();
    if (!c.key || !c.model || !netOK()) return Promise.resolve(null);
    var prompt = '你是资深旅游攻略编辑。请为下面的行程生成实用的中文攻略，严格只返回一个 JSON 对象，不要任何解释文字。\n'
      + 'JSON 结构：{"food":[{"name":"","desc":""}],"shop":[{"name":"","desc":""}],"pitfalls":[""]}\n'
      + '要求：food 3 条（当地真正值得吃的，写清怎么点或去哪吃），shop 2 条（值得买与避坑），pitfalls 4 条（真实常见的坑与应对办法），每条不超过 40 字。\n'
      + '城市：' + day.city + '（' + (day.country || '') + '），日期：' + day.date + '\n'
      + '主要景点：' + ((day.spots || []).map(function (s) { return s.name; }).join('、') || '无');
    var base = c.baseUrl || 'https://api.openai.com/v1';
    return fetchT(base.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.key },
      body: JSON.stringify({ model: c.model, messages: [{ role: 'user', content: prompt }], temperature: 0.7 })
    }, T_AI).then(function (r) { return r.json(); }).then(function (j) {
      var t = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content || '';
      var m = /\{[\s\S]*\}/.exec(t);
      if (!m) return null;
      var o = JSON.parse(m[0]);
      function norm(a) {
        return (a || []).map(function (x) {
          return typeof x === 'string' ? { name: x, desc: '' } : { name: x.name || '', desc: x.desc || '' };
        }).filter(function (x) { return x.name; });
      }
      var res = {
        food: norm(o.food),
        shop: norm(o.shop),
        pitfalls: (o.pitfalls || []).map(function (x) { return typeof x === 'string' ? { name: x, desc: '' } : x; })
      };
      if (!res.food.length && !res.pitfalls.length) return null;
      return res;
    }).catch(function () { return null; });
  }

  function autoFillDay(day, onStep) {
    var intro = '';
    function note(m) { onStep && onStep(m); }
    var jobs = [];

    /* 1) 定位坐标：仅当未知时才请求（内置库优先，未收录走网络，5s 超时降级） */
    if (day.lat == null) {
      note('定位 ' + day.city + ' …');
      jobs.push(geocode(day.city).then(function (g) {
        if (g) { day.lat = g.lat; day.lon = g.lon; day.country = g.country || day.country; }
      }));
    }

    /* 2) 城市简介 + 3) 各景点简介：彼此无依赖，全部并行（缓存命中则瞬时） */
    note('查询 ' + day.city + ' 资料…');
    jobs.push(wikiSummary(day.city).then(function (ci) { intro = ci; day.cityIntro = ci; }));
    (day.spots || []).forEach(function (s) {
      if (s.name && (!s.desc || s.desc.indexOf('本地重点游览项目') >= 0)) {
        jobs.push(wikiSummary(s.name).then(function (t) { if (t) s.desc = t; }));
      }
    });

    /* 4) 并行资料到位后，统一生成 emoji / 兜底简介 / tip / 美食购物避坑 */
    return Promise.all(jobs).then(function () {
      (day.spots || []).forEach(function (s) {
        if (!s.emoji || s.emoji === '📍') s.emoji = emojiFor(s.name);
        if (!s.desc) s.desc = day.city + ' · ' + s.name + '：本地重点游览项目，建议预留 2 小时以上';
        if (!s.tip) s.tip = '出发前确认开放时间与预约要求，避开 10:00–15:00 高峰';
      });
      note('生成 ' + day.city + ' 美食与避坑…');
      return aiGuide(day).then(function (ai) {
        var g = ai || rulesFor(day.country, day.city, intro);
        var base = rulesFor(day.country, day.city, intro);
        day.food = (g.food && g.food.length) ? g.food : base.food;
        day.shop = (g.shop && g.shop.length) ? g.shop : base.shop;
        day.pitfalls = (g.pitfalls && g.pitfalls.length) ? g.pitfalls : base.pitfalls;
        day.auto = ai ? 'ai' : 'rule';
        return day;
      });
    });
  }

  /* ================= 公共片段 ================= */
  function weatherCard(day, w) {
    return '<div class="card weather" id="wxCard">'
      + '<div class="wx-icon">' + w.icon + '</div>'
      + '<div class="wx-main">'
      + '<div class="wx-temp">' + w.temp + '<small>°C</small></div>'
      + '<div class="wx-desc">' + esc(w.text) + '　体感 ' + w.feels + '°C　' + w.min + '° / ' + w.max + '°</div>'
      + '<div class="wx-src">' + (w.estimated ? '离线估算值 · 联网后自动刷新为实时天气' : '实时数据 · Open-Meteo') + '</div>'
      + '</div>'
      + '<div class="wx-side"><div><b>' + w.pop + '%</b><br>降水概率</div>'
      + '<div style="margin-top:6px"><b>' + w.wind + '</b> km/h<br>风速</div>'
      + '<div style="margin-top:6px"><b>' + w.humidity + '</b>%<br>湿度</div></div></div>';
  }
  function sosCard() {
    return '<div class="card"><div class="sec-title"><i></i>公共应急电话<span class="more">点击即可拨打</span></div>'
      + '<div class="sos-grid">' + DEMO.SOS.map(function (s) {
        return '<a class="sos-item" href="tel:' + s.v.replace(/[^\d]/g, '') + '"><div class="n">' + esc(s.n)
          + '</div><div class="v' + (/\D/.test(s.v) ? ' neutral' : '') + '">' + esc(s.v) + '</div></a>';
      }).join('') + '</div></div>';
  }
  function organizerCard(plan) {
    var o = plan.organizer || {}, tel = String(o.phone || '').replace(/[^\d+]/g, '');
    return '<div class="card"><div class="sec-title"><i></i>组团人联系信息</div><div class="rows">'
      + '<div class="row"><span class="rk">组团人</span><span class="rv">' + esc(o.name || '—') + '</span>'
      + (tel ? '<span class="ra"><a class="call-btn" href="tel:' + tel + '">📞 拨号</a></span>' : '') + '</div>'
      + '<div class="row"><span class="rk">联系电话</span><span class="rv">' + esc(o.phone || '—') + '</span>'
      + (tel ? '<span class="ra"><a class="chip orange" href="sms:' + tel + '">发短信</a></span>' : '') + '</div>'
      + (plan.title ? '<div class="row"><span class="rk">团队</span><span class="rv muted">' + esc(plan.title) + '</span></div>' : '')
      + '</div></div>';
  }
  function spotMini(s) {
    return '<div class="spot-mini"><div class="emoji">' + (s.emoji || '📍') + '</div>'
      + '<div class="txt"><div class="t">' + esc(s.name) + '</div>'
      + '<div class="s">' + esc(s.time || '全天') + ' · 今日重点</div></div></div>';
  }

  /* ================= 空态 ================= */
  function emptyView() {
    return '<div class="card empty">'
      + '<div class="e-emoji">🧭</div>'
      + '<div class="e-t">还没有行程计划</div>'
      + '<div class="e-s">组团人点击下面按钮，按向导逐天录入城市、酒店与景点，<br>美食、购物、避坑指南由 App 自动获取</div>'
      + '<button class="btn btn-primary" id="btnCreate" style="margin-top:16px">＋ 创建行程计划</button>'
      + '<button class="btn btn-ghost" id="btnCreate2" style="margin-top:10px">我是随团人员，已有分享链接</button>'
      + '</div>';
  }

  /* ================= 首页 ================= */
  function renderHome() {
    var el = $('#view-home');
    if (!state.plan || !state.plan.days.length) { el.innerHTML = emptyView(); bindEmpty(el); return; }
    var plan = state.plan, loc = locate(plan), day = loc.day;
    var name = (plan.organizer && plan.organizer.name) ? plan.organizer.name : '旅途伙伴';
    var html = '<div class="hero">'
      + '<div class="hero-hello">' + greeting() + '，' + esc(name) + ' 团的伙伴们</div>'
      + '<div class="hero-city">' + esc(day.city) + '</div>'
      + '<div class="hero-meta">' + fmtMD(day.date) + ' ' + weekday(day.date)
      + (day.tag ? ' · ' + esc(day.tag) : (day.country ? ' · ' + esc(day.country) : '')) + '</div>';
    if (loc.status === 'before') {
      html += '<div class="hero-day"><b>' + loc.daysLeft + '</b><span>天后出发 · 共 ' + loc.total + ' 天</span></div><div class="hero-progress"><i style="width:0%"></i></div>';
    } else if (loc.status === 'after') {
      html += '<div class="hero-day"><b>' + loc.total + '</b><span>天行程已圆满结束</span></div><div class="hero-progress"><i style="width:100%"></i></div>';
    } else {
      html += '<div class="hero-day"><b>第 ' + loc.idx + '</b><span>天 / 全程 ' + loc.total + ' 天</span></div>'
        + '<div class="hero-progress"><i style="width:' + (loc.idx / loc.total * 100).toFixed(1) + '%"></i></div>';
    }
    html += '</div>';

    var w = readWxCache(day) || estimateWeather(day);
    html += weatherCard(day, w);

    html += '<div class="card"><div class="sec-title"><i></i>今日出行</div><div class="rows">'
      + '<div class="row"><span class="rk">出发时间</span><span class="rv">' + esc(day.depart || '待定') + '</span>'
      + '<span class="ra"><span class="chip orange">⏰ 请提前 15 分钟集合</span></span></div>'
      + '<div class="row"><span class="rk">穿着指南</span><span class="rv muted dress" style="font-weight:500;line-height:1.65">👕 ' + dressAdvice(w).map(esc).join('　/　') + '</span></div>'
      + '<div class="row"><span class="rk">下榻酒店</span><span class="rv muted">' + esc((day.hotel && day.hotel.name) || '—') + '</span></div>'
      + '</div></div>';

    html += '<div class="card"><div class="sec-title"><i></i>今日主要景点<span class="more">共 ' + (day.spots || []).length + ' 个重点</span></div>'
      + (day.spots || []).slice(0, 2).map(spotMini).join('') + '</div>';

    html += organizerCard(plan) + sosCard();
    el.innerHTML = html;

    fetchWeather(day).then(function (fresh) {
      if (state.route !== 'home') return;
      var card = $('#wxCard', el); if (card) card.outerHTML = weatherCard(day, fresh);
      var dcell = $('.dress', el);
      if (dcell) dcell.innerHTML = '👕 ' + dressAdvice(fresh).map(esc).join('　/　');
    });
  }

  /* ================= 今天 ================= */
  function renderToday() {
    var el = $('#view-today');
    if (!state.plan || !state.plan.days.length) { el.innerHTML = emptyView(); bindEmpty(el); return; }
    var plan = state.plan, loc = locate(plan), day = loc.day, head = '';
    if (loc.status === 'before') {
      head = '<div class="card day-head"><div class="d1">行程尚未开始</div><div class="d2">' + loc.daysLeft + ' 天后出发 · '
        + esc(day.city) + '</div><div class="d3">以下为首日（' + fmtMD(day.date) + '）的攻略，可提前熟悉</div></div>';
    } else if (loc.status === 'after') {
      head = '<div class="card day-head"><div class="d1">行程已结束</div><div class="d2">回顾 · ' + esc(day.city)
        + '</div><div class="d3">以下为末日（' + fmtMD(day.date) + '）的攻略存档</div></div>';
    } else {
      head = '<div class="card day-head"><div class="d1">DAY ' + loc.idx + ' / ' + loc.total + '</div><div class="d2">'
        + esc(day.city) + ' · ' + fmtMD(day.date) + ' ' + weekday(day.date) + '</div><div class="d3">'
        + esc(day.country || '') + '　出发时间 ' + esc(day.depart || '待定') + '　|　'
        + esc((day.hotel && day.hotel.name) || '') + '</div></div>';
    }
    var spots = (day.spots || []).map(function (s) {
      return '<div class="tl-item"><div class="tl-time">' + esc(s.time || '全天') + '</div>'
        + '<div class="tl-name">' + (s.emoji || '📍') + ' ' + esc(s.name) + '</div>'
        + '<div class="tl-desc">' + esc(s.desc || '暂无简介，可在「编辑行程计划」中补充') + '</div>'
        + (s.tip ? '<div class="tl-tip">💡 ' + esc(s.tip) + '</div>' : '') + '</div>';
    }).join('');
    function list(arr, cls, empty) {
      return (arr && arr.length)
        ? '<ul class="list-plain ' + (cls || '') + '">' + arr.map(function (f) {
          return '<li><b>' + esc(f.name) + '</b>' + (f.desc ? '<p>' + esc(f.desc) + '</p>' : '') + '</li>';
        }).join('') + '</ul>'
        : '<div class="hint" style="color:var(--c-ink-3);font-size:12.5px">' + empty + '</div>';
    }
    var html = head
      + '<div class="card"><div class="sec-title"><i></i>今日游玩顺序</div><div class="tl">'
      + (spots || '<div class="tl-desc">暂无景点安排</div>') + '</div></div>'
      + '<div class="two-col">'
      + '<div class="card card-tight"><div class="sec-title"><i></i>🍽 美食推荐</div>'
      + list(day.food, '', '暂无，可在编辑中点「自动获取资料」') + '</div>'
      + '<div class="card card-tight"><div class="sec-title"><i></i>🛍 购物推荐</div>'
      + list(day.shop, '', '暂无，可在编辑中点「自动获取资料」') + '</div></div>'
      + '<div class="card"><div class="sec-title"><i></i>⚠️ 避坑指南</div>'
      + list(day.pitfalls, 'pit', '暂无，可在编辑中点「自动获取资料」') + '</div>';
    if (plan.note) html += '<div class="card card-tight"><div class="sec-title"><i></i>📌 团队须知</div>'
      + '<div style="font-size:13.5px;color:var(--c-ink-2)">' + esc(plan.note) + '</div></div>';
    el.innerHTML = html;
  }

  /* ================= 游程 ================= */
  function renderTrip() {
    var el = $('#view-trip');
    if (!state.plan || !state.plan.days.length) { el.innerHTML = emptyView(); bindEmpty(el); return; }
    var plan = state.plan, loc = locate(plan), cities = [];
    plan.days.forEach(function (d) { if (cities[cities.length - 1] !== d.city) cities.push(d.city); });
    var html = '<div class="trip-summary">'
      + '<div><div class="big">' + plan.days.length + '</div><div class="lab">天 / ' + cities.length + ' 城</div></div>'
      + '<div class="div"></div><div style="flex:1;min-width:0">'
      + '<div class="lab">出行日期</div><div style="font-weight:700;font-size:14.5px">'
      + fmtMD(plan.startDate) + ' — ' + fmtMD(plan.endDate) + '</div>'
      + '<div class="lab" style="margin-top:6px">' + esc(cities.join(' · ')) + '</div></div></div>';
    html += plan.days.map(function (d, i) {
      var n = i + 1, isToday = loc.status === 'in' && loc.idx === n;
      var isPast = (loc.status === 'in' && n < loc.idx) || loc.status === 'after';
      return '<div class="card day-card ' + (isToday ? 'is-today' : '') + ' ' + (isPast ? 'badge-past' : '') + '">'
        + (isToday ? '<div class="badge-today">今天</div>' : '')
        + '<div class="dh"><div class="no ' + (isToday ? 'today' : (isPast ? 'past' : '')) + '">' + n + '</div>'
        + '<div><div class="dt">' + fmtMD(d.date) + ' ' + weekday(d.date) + '</div>'
        + '<div class="dc">' + esc(d.city)
        + (d.country ? '<span style="font-size:12px;font-weight:500;color:var(--c-ink-3)"> ' + esc(d.country) + '</span>' : '')
        + '</div></div></div>'
        + '<dl class="kv"><dt>🕗 出发</dt><dd>' + esc(d.depart || '待定') + '</dd>'
        + '<dt>🏨 酒店</dt><dd>' + esc((d.hotel && d.hotel.name) || '—') + '</dd>'
        + '<dt>📍 地址</dt><dd>' + esc((d.hotel && d.hotel.addr) || '—') + '</dd>'
        + '<dt>☎️ 电话</dt><dd>' + esc((d.hotel && d.hotel.phone) || '—') + '</dd></dl>'
        + '<div class="spotline">' + (d.spots || []).slice(0, 2).map(function (s) {
          return '<span class="spot-pill">' + (s.emoji || '📍') + ' ' + esc(s.name) + '</span>';
        }).join('') + '</div></div>';
    }).join('');
    el.innerHTML = html;
  }

  function bindEmpty(el) {
    var a = $('#btnCreate', el), b = $('#btnCreate2', el);
    if (a) a.onclick = function () { openWizard(); };
    if (b) b.onclick = function () { toast('请打开组团人分享的链接，或让组团人把二维码发给你'); };
  }

  /* ================= 路由 ================= */
  function updateTopActions() {
    // 随团人员视角（B-link）：隐藏「分享 / 设定行程」入口
    var el = document.querySelector('.topbar-right');
    if (el) el.style.display = state.sharedView ? 'none' : '';
  }
  function render() {
    updateTopActions();
    ['home', 'today', 'trip'].forEach(function (r) { $('#view-' + r).hidden = r !== state.route; });
    $$('.tab').forEach(function (t) { t.classList.toggle('active', t.dataset.route === state.route); });
    if (state.route === 'home') renderHome();
    if (state.route === 'today') renderToday();
    if (state.route === 'trip') renderTrip();
    try { window.scrollTo(0, 0); } catch (e) { }
  }
  function go(route) {
    if (location.hash !== '#/' + route) location.hash = '#/' + route;
    else { state.route = route; render(); }
  }
  window.addEventListener('hashchange', function () {
    var r = (location.hash || '').replace('#/', '');
    state.route = (r === 'today' || r === 'trip') ? r : 'home';
    render();
  });

  /* ================= 弹层 ================= */
  function openSheet(title, bodyHTML, onMount) {
    $('#sheetTitle').textContent = title;
    $('#sheetBody').innerHTML = bodyHTML;
    $('#sheetRoot').hidden = false;
    document.body.style.overflow = 'hidden';
    $('#sheetBody').scrollTop = 0;
    if (onMount) onMount($('#sheetBody'));
  }
  function closeSheet() { $('#sheetRoot').hidden = true; document.body.style.overflow = ''; }
  $('#sheetMask').addEventListener('click', closeSheet);
  $('#sheetClose').addEventListener('click', closeSheet);

  /* ================= 创建向导 ================= */
  function openWizard() {
    wz = { step: 1, idx: 0, plan: blankPlan() };
    renderWizard();
  }

  function stepBar(step) {
    var names = ['基础信息', '逐天录入', '生成指南'];
    return '<div class="stepbar">' + names.map(function (n, i) {
      var k = i + 1;
      return '<div class="step ' + (k === step ? 'on' : (k < step ? 'done' : '')) + '">'
        + '<span class="sn">' + (k < step ? '✓' : k) + '</span><span>' + n + '</span></div>';
    }).join('') + '</div>';
  }

  function renderWizard() {
    var p = wz.plan;

    /* ---- 第 1 步：基础信息 ---- */
    if (wz.step === 1) {
      openSheet('创建行程计划 · 第 1 步', stepBar(1) + ''
        + '<div class="field"><label>行程标题</label><input class="inp" id="wTitle" placeholder="例如：云南 8 日深度游" value="' + esc(p.title) + '"></div>'
        + '<div class="grid2">'
        + '<div class="field"><label>组团人姓名</label><input class="inp" id="wName" placeholder="姓名" value="' + esc(p.organizer.name) + '"></div>'
        + '<div class="field"><label>组团人电话</label><input class="inp" id="wPhone" placeholder="手机号" value="' + esc(p.organizer.phone) + '"></div></div>'
        + '<div class="grid2">'
        + '<div class="field"><label>出发日期</label><input class="inp" id="wStart" type="date" value="' + esc(p.startDate) + '"></div>'
        + '<div class="field"><label>返程日期</label><input class="inp" id="wEnd" type="date" value="' + esc(p.endDate) + '"></div></div>'
        + '<div class="field"><label>团队须知（可选）</label><textarea class="inp" id="wNote" placeholder="集合地点、注意事项等">' + esc(p.note) + '</textarea></div>'
        + '<div class="field"><label>管理密码（4–8 位）</label><input class="inp" id="wPass" value="' + esc(p.passcode) + '">'
        + '<div class="hint">默认 650101，用于后续修改行程与成员</div></div>'
        + '<button class="btn btn-primary" id="wNext">下一步：逐天录入</button>'
        + '<div class="hint" style="text-align:center;margin-top:10px">下一步会根据往返日期自动生成每一天的录入表</div>',
        function (root) {
          $('#wNext', root).onclick = function () {
            p.title = $('#wTitle', root).value.trim();
            p.organizer = { name: $('#wName', root).value.trim(), phone: $('#wPhone', root).value.trim() };
            p.startDate = $('#wStart', root).value;
            p.endDate = $('#wEnd', root).value;
            p.note = $('#wNote', root).value.trim();
            var ps = $('#wPass', root).value.trim();
            if (!p.title) { toast('请填写行程标题'); return; }
            if (!p.organizer.name) { toast('请填写组团人姓名'); return; }
            if (!p.organizer.phone) { toast('请填写组团人电话'); return; }
            if (!p.startDate || !p.endDate) { toast('请选择往返日期'); return; }
            var n = daysBetween(p.startDate, p.endDate) + 1;
            if (n < 1) { toast('返程日期不能早于出发日期'); return; }
            if (n > 60) { toast('单次行程请控制在 60 天以内'); return; }
            p.passcode = ps || DEMO.DEFAULT_PASSCODE;
            var old = p.days || [];
            p.days = [];
            for (var i = 0; i < n; i++) {
              var d = new Date(toDate(p.startDate).getTime()); d.setDate(d.getDate() + i);
              var prev = old[i] || {};
              p.days.push({
                date: iso(d), city: prev.city || '', country: prev.country || '',
                lat: prev.lat == null ? null : prev.lat, lon: prev.lon == null ? null : prev.lon,
                depart: prev.depart || '09:00', tag: prev.tag || '',
                hotel: prev.hotel || { name: '', addr: '', phone: '' },
                spots: (prev.spots && prev.spots.length) ? prev.spots : [
                  { name: '', time: '10:00', emoji: '📍', desc: '', tip: '' },
                  { name: '', time: '15:00', emoji: '📍', desc: '', tip: '' }
                ],
                food: prev.food || [], shop: prev.shop || [], pitfalls: prev.pitfalls || []
              });
            }
            wz.step = 2; wz.idx = 0;
            renderWizard();
          };
        });
      return;
    }

    /* ---- 第 2 步：逐天录入 ---- */
    if (wz.step === 2) {
      var d = p.days[wz.idx], n = p.days.length;
      var nav = p.days.map(function (x, i) {
        return '<button class="dn' + (i === wz.idx ? ' active' : (x.city ? ' done' : '')) + '" data-i="' + i + '">' + (i + 1) + '</button>';
      }).join('');
      openSheet('创建行程计划 · 第 2 步', stepBar(2) + ''
        + '<div class="daynav">' + nav + '</div>'
        + '<div class="wz-head"><div class="wz-no">第 ' + (wz.idx + 1) + ' 天 <span>/ 共 ' + n + ' 天</span></div>'
        + '<div class="wz-date">' + fmtMD(d.date) + ' ' + weekday(d.date) + '</div></div>'
        + '<div class="field"><label>城市 / 地区名</label><input class="inp" id="dCity" placeholder="例如：大理" value="' + esc(d.city) + '"></div>'
        + '<div class="field"><label>酒店名称</label><input class="inp" id="dHotel" placeholder="例如：大理古城某酒店" value="' + esc(d.hotel.name) + '"></div>'
        + '<div class="field"><label>主要景点 ①</label><input class="inp" id="dSpot1" placeholder="例如：崇圣寺三塔" value="' + esc((d.spots[0] || {}).name) + '"></div>'
        + '<div class="field"><label>主要景点 ②</label><input class="inp" id="dSpot2" placeholder="例如：洱海生态廊道" value="' + esc((d.spots[1] || {}).name) + '"></div>'
        + '<div class="field"><label>出发时间</label><input class="inp" id="dDep" type="time" value="' + esc(d.depart) + '"></div>'
        + '<div class="hint" style="margin:-6px 0 14px">美食、购物、避坑指南会在下一步由 App 自动获取，无需填写</div>'
        + '<div class="btn-row">'
        + (wz.idx > 0 ? '<button class="btn btn-ghost" id="dPrev">← 上一天</button>' : '<button class="btn btn-ghost" id="dBack1">← 基础信息</button>')
        + (wz.idx < n - 1 ? '<button class="btn btn-primary" id="dNext">下一天 →</button>'
          : '<button class="btn btn-primary" id="dFinish">完成，生成指南</button>')
        + '</div>', function (root) {
          function collect() {
            d.city = $('#dCity', root).value.trim();
            d.hotel.name = $('#dHotel', root).value.trim();
            d.spots[0].name = $('#dSpot1', root).value.trim();
            d.spots[1].name = $('#dSpot2', root).value.trim();
            d.depart = $('#dDep', root).value || '09:00';
          }
          $$('.dn', root).forEach(function (b) {
            b.onclick = function () { collect(); wz.idx = +b.dataset.i; renderWizard(); };
          });
          var prev = $('#dPrev', root), back = $('#dBack1', root);
          if (prev) prev.onclick = function () { collect(); wz.idx--; renderWizard(); };
          if (back) back.onclick = function () { collect(); wz.step = 1; renderWizard(); };
          var nx = $('#dNext', root), fin = $('#dFinish', root);
          if (nx) nx.onclick = function () {
            if (!$('#dCity', root).value.trim()) { toast('请填写城市名'); return; }
            collect(); wz.idx++; renderWizard();
          };
          if (fin) fin.onclick = function () {
            if (!$('#dCity', root).value.trim()) { toast('请填写城市名'); return; }
            collect(); wz.step = 3; renderWizard();
          };
          setTimeout(function () { var c = $('#dCity', root); if (c && !c.value) c.focus(); }, 150);
        });
      return;
    }

    /* ---- 第 3 步：自动生成 ---- */
    var todo = p.days.filter(function (x) { return x.city; });
    openSheet('创建行程计划 · 第 3 步', stepBar(3) + ''
      + '<div class="gen-box"><div class="gen-title" id="genTitle">正在自动获取资料…</div>'
      + '<div class="gen-bar"><i id="genBar"></i></div>'
      + '<ul class="gen-log" id="genLog"></ul></div>'
      + '<button class="btn btn-primary" id="genDone" hidden>查看我的行程指南</button>',
      function (root) {
        var log = $('#genLog', root), bar = $('#genBar', root), title = $('#genTitle', root);
        var next = 0, done = 0, active = 0, total = todo.length;
        if (!netOK()) {
          var w = document.createElement('li');
          w.innerHTML = '<b>提示</b><span>当前离线，将使用内置模板生成攻略，联网后可在编辑中重新获取</span>';
          w.className = 'warn'; log.appendChild(w);
        }
        function finish() {
          title.textContent = '全部完成！共 ' + total + ' 个城市的资料已获取';
          bar.style.width = '100%';
          state.plan = p; state.admin = true;
          ssset(LS_UNLOCK, '1');
          savePlan(p);
          $('#brandName').textContent = p.organizer.name ? (p.organizer.name + '的团') : '同行';
          var btn = $('#genDone', root); btn.hidden = false;
          btn.onclick = function () { closeSheet(); wz = null; render(); };
        }
        /* 并发调度：同时最多跑 GEN_CONC 个城市，各自独立更新进度 */
        function pump() {
          while (active < GEN_CONC && next < total) {
            var day = todo[next++], li = document.createElement('li');
            li.innerHTML = '<b>' + esc(day.city) + '</b><span>排队…</span>';
            log.appendChild(li);
            active++;
            autoFillDay(day, function (msg) { li.querySelector('span').textContent = msg; })
              .then(function () {
                li.querySelector('span').textContent = '✓ 天气坐标 · 景点简介 · 美食购物避坑';
                li.className = 'ok';
              })
              .catch(function () {
                li.querySelector('span').textContent = '△ 网络受限，已用基础模板';
                li.className = 'warn';
              })
              .then(function () {
                active--; done++;
                bar.style.width = Math.round(done / Math.max(total, 1) * 100) + '%';
                title.textContent = '正在自动获取资料…（' + done + '/' + total + '）';
                pump();
                if (done >= total) finish();
              });
          }
        }
        pump();
      });
  }

  /* ================= 组团人登录 / 管理 ================= */
  function askPasscode(onOk) {
    var has = !!(state.plan && state.plan.passcode);
    openSheet(has ? '组团人登录' : '设置管理密码', ''
      + '<p style="margin:0 0 14px;font-size:13.5px;color:var(--c-ink-2)">'
      + (has ? '请输入管理密码以修改行程与成员。' : '请设置 4–8 位管理密码。') + '</p>'
      + '<div class="field"><input class="inp" id="p1" type="password" inputmode="numeric" placeholder="管理密码" autocomplete="off"></div>'
      + '<div id="passErr" style="min-height:18px;color:var(--c-warn);font-size:12.5px;text-align:center"></div>'
      + '<button class="btn btn-primary" id="passOk">确认</button>', function (root) {
        function submit() {
          var v = $('#p1', root).value.trim();
          if (!v) { $('#passErr', root).textContent = '请输入密码'; return; }
          if (!has) {
            state.plan.passcode = v; savePlan(state.plan);
            state.admin = true; ssset(LS_UNLOCK, '1');
            closeSheet(); toast('密码已设置'); onOk && onOk(); return;
          }
          if (v !== state.plan.passcode) { $('#passErr', root).textContent = '密码不正确'; return; }
          state.admin = true; ssset(LS_UNLOCK, '1');
          closeSheet(); toast('已进入组团人模式'); onOk && onOk();
        }
        $('#passOk', root).onclick = submit;
        $('#p1', root).addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
        setTimeout(function () { $('#p1', root).focus(); }, 150);
      });
  }
  function needAdmin(then) {
    if (!state.plan) { openWizard(); return; }
    if (state.admin) { then(); return; }
    if (ssget(LS_UNLOCK) === '1') { state.admin = true; then(); return; }
    askPasscode(then);
  }

  function openAdmin() {
    if (!state.plan) { openWizard(); return; }
    needAdmin(function () {
      openSheet('组团人管理', ''
        + '<button class="btn btn-primary" id="mEdit" style="margin-bottom:10px">📝 编辑行程计划</button>'
        + '<button class="btn btn-danger" id="mNew" style="margin-bottom:10px">🆕 清空并创建新行程</button>'
        + '<button class="btn btn-danger" id="mExit">退出组团人模式</button>', function (root) {
          $('#mEdit', root).onclick = function () { closeSheet(); openEditor(); };
          $('#mNew', root).onclick = function () {
            if (!confirm('确定清空当前行程并重新创建？')) return;
            closeSheet(); state.plan = null; state.admin = false;
            lsdel(LS_PLAN); ssdel(LS_UNLOCK);
            render(); openWizard();
          };
          $('#mExit', root).onclick = function () {
            state.admin = false; ssdel(LS_UNLOCK); closeSheet(); toast('已退出');
          };
        });
    });
  }

  function openAICfg() {
    var c = getAI();
    openSheet('AI 自动资料（可选）', ''
      + '<p style="margin:0 0 14px;font-size:13px;color:var(--c-ink-2);line-height:1.7">'
      + '不填也能正常使用：App 会用内置规则库生成美食、购物与避坑。<br>'
      + '填入任意 OpenAI 兼容接口后，攻略会由 AI 按城市实时生成，更贴合当地。</p>'
      + '<div class="field"><label>接口地址</label><input class="inp" id="aUrl" placeholder="https://api.openai.com/v1" value="' + esc(c.baseUrl || '') + '"></div>'
      + '<div class="field"><label>模型名</label><input class="inp" id="aModel" placeholder="gpt-4o-mini" value="' + esc(c.model || '') + '"></div>'
      + '<div class="field"><label>API Key</label><input class="inp" id="aKey" type="password" placeholder="sk-…" value="' + esc(c.key || '') + '"></div>'
      + '<div class="btn-row"><button class="btn btn-ghost" id="aClear">清空</button>'
      + '<button class="btn btn-primary" id="aSave">保存</button></div>', function (root) {
        $('#aSave', root).onclick = function () {
          setAI({
            baseUrl: $('#aUrl', root).value.trim(),
            model: $('#aModel', root).value.trim(),
            key: $('#aKey', root).value.trim()
          });
          closeSheet(); toast('已保存，下次自动获取时生效');
        };
        $('#aClear', root).onclick = function () { setAI({}); closeSheet(); toast('已清空，将使用内置规则库'); };
      });
  }

  function refetchAll() {
    openSheet('重新获取攻略', '<div class="gen-box"><div class="gen-title" id="genTitle">正在重新获取…</div>'
      + '<div class="gen-bar"><i id="genBar"></i></div><ul class="gen-log" id="genLog"></ul></div>'
      + '<button class="btn btn-primary" id="genDone" hidden>完成</button>', function (root) {
        var log = $('#genLog', root), bar = $('#genBar', root), title = $('#genTitle', root);
        var todo = state.plan.days.filter(function (x) { return x.city; });
        var next = 0, done = 0, active = 0, total = todo.length;
        function finish() {
          title.textContent = '已更新 ' + total + ' 个城市的攻略';
          savePlan(state.plan);
          var b = $('#genDone', root); b.hidden = false;
          b.onclick = function () { closeSheet(); render(); };
        }
        (function pump() {
          while (active < GEN_CONC && next < total) {
            var day = todo[next++], li = document.createElement('li');
            li.innerHTML = '<b>' + esc(day.city) + '</b><span>获取中…</span>';
            log.appendChild(li);
            active++;
            autoFillDay(day, function (m) { li.querySelector('span').textContent = m; })
              .then(function () { li.querySelector('span').textContent = '✓ 已更新'; li.className = 'ok'; })
              .catch(function () { li.querySelector('span').textContent = '△ 网络受限'; li.className = 'warn'; })
              .then(function () {
                active--; done++;
                bar.style.width = Math.round(done / Math.max(total, 1) * 100) + '%';
                pump();
                if (done >= total) finish();
              });
          }
        })();
      });
  }

  /* ================= 完整编辑器 ================= */
  function openEditor() {
    var p = state.plan;
    var html = ''
      + '<div class="field"><label>行程标题</label><input class="inp" id="fTitle" value="' + esc(p.title) + '"></div>'
      + '<div class="grid2"><div class="field"><label>组团人姓名</label><input class="inp" id="fName" value="' + esc(p.organizer.name) + '"></div>'
      + '<div class="field"><label>联系电话</label><input class="inp" id="fPhone" value="' + esc(p.organizer.phone) + '"></div></div>'
      + '<div class="grid2"><div class="field"><label>出发日期</label><input class="inp" id="fStart" type="date" value="' + esc(p.startDate) + '"></div>'
      + '<div class="field"><label>返程日期</label><input class="inp" id="fEnd" type="date" value="' + esc(p.endDate) + '"></div></div>'
      + '<div class="field"><label>团队须知</label><textarea class="inp" id="fNote">' + esc(p.note) + '</textarea></div>'
      + '<div class="sec-title" style="margin-top:6px"><i></i>每日行程<span class="more" id="dayCount">' + p.days.length + ' 天</span></div>'
      + '<div id="dayList">' + p.days.map(dayEditorHTML).join('') + '</div>'
      + '<button class="btn btn-ghost" id="addDay" style="margin-bottom:14px">＋ 增加一天</button>'
      + '<div class="btn-row"><button class="btn btn-ghost" id="cancelEdit">取消</button>'
      + '<button class="btn btn-primary" id="saveEdit">保存计划</button></div>'
      + '<div class="hint" style="text-align:center;margin-top:10px">美食 / 购物 / 避坑：每行一条，用「名称：说明」格式</div>';
    openSheet('编辑行程计划', html, function (root) {
      function rebind() {
        $$('.de-del', root).forEach(function (b) {
          b.onclick = function () {
            if (root.querySelectorAll('.day-editor').length <= 1) { toast('至少保留一天'); return; }
            b.closest('.day-editor').remove(); sync();
          };
        });
        $$('.de-auto', root).forEach(function (b) {
          b.onclick = function () {
            var de = b.closest('.day-editor');
            var cur = {
              city: $('.de-city', de).value.trim(), date: de.dataset.date,
              country: $('.de-country', de).value.trim(),
              lat: parseFloat($('.de-lat', de).value) || null,
              lon: parseFloat($('.de-lon', de).value) || null,
              hotel: { name: $('.de-hotel', de).value.trim() },
              spots: [
                { name: $('.de-sn0', de).value.trim(), time: $('.de-st0', de).value, emoji: '', desc: '', tip: '' },
                { name: $('.de-sn1', de).value.trim(), time: $('.de-st1', de).value, emoji: '', desc: '', tip: '' }
              ]
            };
            if (!cur.city) { toast('请先填写城市名'); return; }
            b.textContent = '获取中…'; b.disabled = true;
            autoFillDay(cur, function () { }).then(function (x) {
              $('.de-country', de).value = x.country || '';
              $('.de-lat', de).value = x.lat == null ? '' : x.lat;
              $('.de-lon', de).value = x.lon == null ? '' : x.lon;
              $('.de-sd0', de).value = (x.spots[0] || {}).desc || '';
              $('.de-sd1', de).value = (x.spots[1] || {}).desc || '';
              $('.de-sp0', de).value = (x.spots[0] || {}).tip || '';
              $('.de-sp1', de).value = (x.spots[1] || {}).tip || '';
              $('.de-se0', de).value = (x.spots[0] || {}).emoji || '📍';
              $('.de-se1', de).value = (x.spots[1] || {}).emoji || '📍';
              $('.de-food', de).value = (x.food || []).map(function (f) { return f.name + (f.desc ? '：' + f.desc : ''); }).join('\n');
              $('.de-shop', de).value = (x.shop || []).map(function (f) { return f.name + (f.desc ? '：' + f.desc : ''); }).join('\n');
              $('.de-pit', de).value = (x.pitfalls || []).map(function (f) { return f.name + (f.desc ? '：' + f.desc : ''); }).join('\n');
              b.textContent = '🔍 自动获取资料'; b.disabled = false; toast('已获取 ' + x.city + ' 的资料');
            }).catch(function () { b.textContent = '🔍 自动获取资料'; b.disabled = false; toast('网络受限，请稍后重试'); });
          };
        });
        $('#dayCount', root).textContent = root.querySelectorAll('.day-editor').length + ' 天';
      }
      function sync() {
        var start = $('#fStart', root).value;
        $$('.day-editor', root).forEach(function (de, i) {
          var d = new Date(toDate(start).getTime()); d.setDate(d.getDate() + i);
          de.dataset.date = iso(d);
          de.querySelector('.de-date').textContent = fmtMD(iso(d)) + ' ' + weekday(iso(d));
          de.querySelector('.de-no').textContent = '第 ' + (i + 1) + ' 天';
        });
        rebind();
      }
      $('#addDay', root).onclick = function () {
        var blank = {
          date: '', city: '', country: '', lat: null, lon: null,
          hotel: { name: '', addr: '', phone: '' }, depart: '09:00',
          spots: [{ name: '', time: '10:00', emoji: '📍', desc: '', tip: '' },
                  { name: '', time: '15:00', emoji: '📍', desc: '', tip: '' }],
          food: [], shop: [], pitfalls: []
        };
        $('#dayList', root).insertAdjacentHTML('beforeend', dayEditorHTML(blank, root.querySelectorAll('.day-editor').length));
        sync();
      };
      $('#fStart', root).addEventListener('change', sync);
      $('#cancelEdit', root).onclick = closeSheet;
      $('#saveEdit', root).onclick = function () {
        var start = $('#fStart', root).value;
        if (!start) { toast('请填写出发日期'); return; }
        var days = $$('.day-editor', root).map(function (de, i) {
          var d = toDate(start); d.setDate(d.getDate() + i);
          function parseTA(sel) {
            return $(sel, de).value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean)
              .map(function (l) {
                var m = /^([^：:|]+)[：:|]\s*(.*)$/.exec(l);
                return m ? { name: m[1].trim(), desc: m[2].trim() } : { name: l, desc: '' };
              });
          }
          return {
            date: iso(d), city: $('.de-city', de).value.trim() || '待定',
            country: $('.de-country', de).value.trim(),
            lat: parseFloat($('.de-lat', de).value) || null, lon: parseFloat($('.de-lon', de).value) || null,
            hotel: { name: $('.de-hotel', de).value.trim(), addr: $('.de-haddr', de).value.trim(), phone: $('.de-hphone', de).value.trim() },
            depart: $('.de-depart', de).value.trim(), tag: $('.de-tag', de).value.trim(),
            spots: [0, 1].map(function (k) {
              return {
                name: $('.de-sn' + k, de).value.trim() || '待定', time: $('.de-st' + k, de).value.trim(),
                emoji: $('.de-se' + k, de).value.trim() || '📍',
                desc: $('.de-sd' + k, de).value.trim(), tip: $('.de-sp' + k, de).value.trim()
              };
            }),
            food: parseTA('.de-food'), shop: parseTA('.de-shop'), pitfalls: parseTA('.de-pit')
          };
        });
        state.plan.title = $('#fTitle', root).value.trim();
        state.plan.organizer = { name: $('#fName', root).value.trim(), phone: $('#fPhone', root).value.trim() };
        state.plan.startDate = start;
        state.plan.endDate = $('#fEnd', root).value || days[days.length - 1].date;
        state.plan.note = $('#fNote', root).value.trim();
        state.plan.days = days;
        savePlan(state.plan);
        closeSheet(); render(); toast('计划已保存');
      };
      rebind();
    });
  }

  function dayEditorHTML(d, i) {
    var ta = function (cls, arr, ph) {
      return '<textarea class="inp ' + cls + '" placeholder="' + ph + '">' +
        esc((arr || []).map(function (x) { return x.name + (x.desc ? '：' + x.desc : ''); }).join('\n')) + '</textarea>';
    };
    var s0 = (d.spots && d.spots[0]) || {}, s1 = (d.spots && d.spots[1]) || {};
    return '<div class="day-editor" data-date="' + esc(d.date) + '">'
      + '<div class="de-head"><span><span class="de-no">第 ' + (i + 1) + ' 天</span> '
      + '<span class="de-date" style="font-size:12px;color:var(--c-ink-3)">' + (d.date ? fmtMD(d.date) + ' ' + weekday(d.date) : '') + '</span></span>'
      + '<button class="del de-del">删除</button></div>'
      + '<div class="grid2"><div class="field"><label>城市</label><input class="inp de-city" value="' + esc(d.city) + '"></div>'
      + '<div class="field"><label>国家 / 地区</label><input class="inp de-country" value="' + esc(d.country) + '"></div></div>'
      + '<div class="grid3"><div class="field"><label>纬度</label><input class="inp de-lat" value="' + (d.lat == null ? '' : esc(d.lat)) + '"></div>'
      + '<div class="field"><label>经度</label><input class="inp de-lon" value="' + (d.lon == null ? '' : esc(d.lon)) + '"></div>'
      + '<div class="field"><label>出发</label><input class="inp de-depart" value="' + esc(d.depart) + '"></div></div>'
      + '<div class="field"><label>行程标签</label><input class="inp de-tag" value="' + esc(d.tag) + '"></div>'
      + '<button class="btn btn-ghost btn-sm de-auto" style="margin-bottom:12px">🔍 自动获取资料（简介 / 美食 / 购物 / 避坑）</button>'
      + '<div class="field"><label>酒店名称</label><input class="inp de-hotel" value="' + esc(d.hotel && d.hotel.name) + '"></div>'
      + '<div class="grid2"><div class="field"><label>酒店地址</label><input class="inp de-haddr" value="' + esc(d.hotel && d.hotel.addr) + '"></div>'
      + '<div class="field"><label>酒店电话</label><input class="inp de-hphone" value="' + esc(d.hotel && d.hotel.phone) + '"></div></div>'
      + '<div class="field"><label>景点 ①</label><div class="grid3" style="margin-bottom:8px">'
      + '<input class="inp de-se0" value="' + esc(s0.emoji || '📍') + '" placeholder="图标">'
      + '<input class="inp de-st0" value="' + esc(s0.time) + '" placeholder="时间">'
      + '<input class="inp de-sn0" value="' + esc(s0.name) + '" placeholder="名称"></div>'
      + '<input class="inp de-sd0" style="margin-bottom:8px" value="' + esc(s0.desc) + '" placeholder="景点简介">'
      + '<input class="inp de-sp0" value="' + esc(s0.tip) + '" placeholder="游玩提示"></div>'
      + '<div class="field"><label>景点 ②</label><div class="grid3" style="margin-bottom:8px">'
      + '<input class="inp de-se1" value="' + esc(s1.emoji || '📍') + '" placeholder="图标">'
      + '<input class="inp de-st1" value="' + esc(s1.time) + '" placeholder="时间">'
      + '<input class="inp de-sn1" value="' + esc(s1.name) + '" placeholder="名称"></div>'
      + '<input class="inp de-sd1" style="margin-bottom:8px" value="' + esc(s1.desc) + '" placeholder="景点简介">'
      + '<input class="inp de-sp1" value="' + esc(s1.tip) + '" placeholder="游玩提示"></div>'
      + '<div class="field"><label>美食推荐</label>' + ta('de-food', d.food, '烤鸭：皮酥肉嫩') + '</div>'
      + '<div class="field"><label>购物推荐</label>' + ta('de-shop', d.shop, '老字号：伴手礼') + '</div>'
      + '<div class="field" style="margin-bottom:0"><label>避坑指南</label>' + ta('de-pit', d.pitfalls, '景区黄牛票：一律拒绝') + '</div></div>';
  }

  /* ================= 分享 / 推送 ================= */
  function compactEncode(p) {
    var o = (p.organizer && p.organizer.name) ? p.organizer : { name: '', phone: '' };
    return {
      t: p.title || '', o: [o.name || '', o.phone || ''], s: p.startDate, e: p.endDate,
      d: (p.days || []).map(function (d) {
        return [
          String(d.date || '').slice(5), d.city || '',
          d.lat == null ? null : +(+d.lat).toFixed(2), d.lon == null ? null : +(+d.lon).toFixed(2),
          d.depart || '', (d.hotel && d.hotel.name) || '',
          (d.spots || []).map(function (s) { return [s.name, s.time || '', s.emoji || '']; }),
          (d.food || []).map(function (x) { return x.name; }),
          (d.shop || []).map(function (x) { return x.name; }),
          (d.pitfalls || []).map(function (x) { return x.name; })
        ];
      })
    };
  }
  function compactDecode(c) {
    var year = String(c.s || '').slice(0, 4);
    function names(a) { return (a || []).map(function (x) { return { name: x, desc: '' }; }); }
    return {
      id: 'shared', title: c.t || '团队旅游指南',
      organizer: { name: (c.o && c.o[0]) || '', phone: (c.o && c.o[1]) || '' },
      startDate: c.s, endDate: c.e, note: '', members: [], lite: true,
      days: (c.d || []).map(function (a) {
        return {
          date: a[0] ? (year + '-' + a[0]) : '', city: a[1], country: '', lat: a[2], lon: a[3],
          depart: a[4], tag: '', hotel: { name: a[5], addr: '', phone: '' },
          spots: (a[6] || []).map(function (s) { return { name: s[0], time: s[1], emoji: s[2] || '📍', desc: '', tip: '' }; }),
          food: names(a[7]), shop: names(a[8]), pitfalls: names(a[9])
        };
      })
    };
  }
  function readSharedPlan() {
    if (window.SHARED_PLAN && window.SHARED_PLAN.days) return Promise.resolve(window.SHARED_PLAN);
    var m = /[?&]plan=([^&]+)/.exec(location.search);
    if (!m) return Promise.resolve(null);
    var v = m[1], tag = v.charAt(0), body = v.slice(1);
    return Promise.resolve().then(function () {
      return (tag === 'z' || tag === 'c') ? inflateB64(body) : null;
    }).then(function (txt) {
      if (txt == null) txt = b64d(decodeURIComponent(v));
      try { var j = JSON.parse(txt); return (tag === 'c' || j.d) ? compactDecode(j) : j; } catch (e) { return null; }
    });
  }
  /* 分享基准地址：优先用组团人手动设置的公网地址，否则用当前页面地址 */
  function isLocalHostname(h) {
    return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0'
      || /^192\.168\./.test(h) || /^10\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  }
  /* 当前页面地址是否只有本机/局域网能访问 */
  function isLocalHost() {
    return location.protocol === 'file:' ? true : isLocalHostname(location.hostname);
  }
  /* 最终分享出去的地址是否只有本机/局域网能访问 */
  function isLocalBase(b) {
    try { return isLocalHostname(new URL(b, location.href).hostname); } catch (e) { return false; }
  }
  function shareBase() {
    var b = String((state.plan && state.plan.shareBase) || '').trim().replace(/\/+$/, '');
    if (b) {
      if (!/\.(html?|php|aspx)$/i.test(b) && !/:\d+$/.test(b)) b += '/index.html';
      return b;
    }
    if (location.protocol === 'file:') return '';
    return location.origin + location.pathname;
  }
  /* 本地生成二维码（data:image/gif），不依赖任何外部服务 */
  function qrDataURL(text, cell) {
    try {
      if (typeof qrcode === 'undefined') return null;
      var qr = qrcode(0, 'M');
      qr.addData(text, 'Byte');
      qr.make();
      var n = qr.getModuleCount();
      var c = cell || Math.max(3, Math.min(8, Math.floor(560 / n)));
      var tag = qr.createImgTag(c, 2);
      var m = /src="([^"]+)"/.exec(tag);
      return m ? m[1] : null;
    } catch (e) { return null; }
  }
  function shareURL(p, lite) {
    var base = shareBase();
    if (!base) return Promise.resolve('');
    if (lite) {
      return deflateB64(JSON.stringify(compactEncode(p))).then(function (z) { return z ? base + '?plan=c' + z : ''; });
    }
    var o = JSON.parse(JSON.stringify(p)); delete o.passcode;
    var json = JSON.stringify(o);
    return deflateB64(json).then(function (z) {
      return z ? base + '?plan=z' + z : base + '?plan=' + encodeURIComponent(b64e(json));
    });
  }
  function buildShareText(p, url) {
    var loc = locate(p), cities = [];
    p.days.forEach(function (d) { if (cities[cities.length - 1] !== d.city) cities.push(d.city); });
    var o = p.organizer || {};
    return '【' + (p.title || '团队旅游指南') + '】\n'
      + '出行：' + fmtMD(p.startDate) + ' — ' + fmtMD(p.endDate) + '（共 ' + p.days.length + ' 天）\n'
      + '路线：' + cities.join(' → ') + '\n'
      + '组团人：' + (o.name || '') + ' ' + (o.phone || '') + '\n'
      + (loc.status === 'in' ? '今天是全程第 ' + loc.idx + ' 天，当前城市：' + loc.day.city + '\n' : '')
      + '—— 完整攻略（天气 / 景点 / 美食 / 避坑）点开即看 ——\n' + url;
  }
  /* 设置分享入口地址（公网地址，团员才能打开） */
  function openShareBase() {
    openSheet('设置分享入口地址', ''
      + '<p style="margin:0 0 12px;font-size:13px;color:var(--c-ink-2);line-height:1.75">'
      + '分享链接必须以一个<strong>所有人都能访问的网址</strong>开头。<br>'
      + '如果你是用本地文件（file://）或本机地址打开的，团员点开链接会打不开。</p>'
      + '<div class="field"><label>分享入口地址</label>'
      + '<input class="inp" id="sbUrl" placeholder="https://你的域名/index.html" value="' + esc((state.plan && state.plan.shareBase) || (location.protocol === 'file:' ? '' : location.origin + location.pathname)) + '"></div>'
      + '<div class="hint" style="margin:-6px 0 12px">留空则使用当前页面地址</div>'
      + '<div class="btn-row"><button class="btn btn-ghost" id="sbClear">清除</button>'
      + '<button class="btn btn-primary" id="sbSave">保存并生成</button></div>', function (root) {
        $('#sbSave', root).onclick = function () {
          var v = $('#sbUrl', root).value.trim();
          if (v && !/^https?:\/\//i.test(v)) { toast('请以 http:// 或 https:// 开头'); return; }
          state.plan.shareBase = v; savePlan(state.plan); closeSheet(); openPush();
        };
        $('#sbClear', root).onclick = function () {
          state.plan.shareBase = ''; savePlan(state.plan); closeSheet(); openPush();
        };
      });
  }

  /* 导出「团员版单文件」：把页面 + 样式 + 脚本 + 行程全部内联进一个 HTML，
     不依赖任何服务器，微信/邮件发文件即可，点开就能看 */
  function exportMemberFile() {
    var p = state.plan;
    var files = ['index.html', 'assets/styles.css', 'assets/qrcode.js', 'assets/data.js', 'assets/app.js'];
    return Promise.all(files.map(function (f) {
      return fetch(f).then(function (r) { return r.text(); });
    })).then(function (t) {
      var h = t[0], css = t[1], qr = t[2], data = t[3], app = t[4];
      var plan = JSON.parse(JSON.stringify(p));
      delete plan.passcode; delete plan.shareBase;
      var inject = '<script>window.SHARED_PLAN=' + JSON.stringify(plan).replace(/</g, '\\u003c') + ';<\/script>';
      // 注意：必须用函数形式替换，否则源码里的 $& / $' 会被当成替换模式
      h = h.replace(/<link rel="stylesheet"[^>]*>/i, function () { return '<style>\n' + css + '\n</style>'; });
      h = h.replace(/<script src="assets\/qrcode\.js"><\/script>/i, function () { return '<script>\n' + qr + '\n<\/script>'; });
      h = h.replace(/<script src="assets\/data\.js"><\/script>/i, function () { return '<script>\n' + data + '\n<\/script>'; });
      h = h.replace(/<script src="assets\/app\.js"><\/script>/i, function () { return inject + '\n<script>\n' + app + '\n<\/script>'; });
      h = h.replace(/<title>[^<]*<\/title>/i, function () { return '<title>' + esc(p.title || '团队旅游指南') + '（团员版）</title>'; });
      var name = (p.title || '团队旅游指南').replace(/[\\/:*?"<>|]/g, '') + '-团员版.html';
      var blob = new Blob([h], { type: 'text/html;charset=utf-8' });
      var url = null;
      try { url = URL.createObjectURL(blob); } catch (e) { }
      // 手机上优先调起系统分享面板（可直接发到微信 / 邮件），不支持再退回下载
      try {
        var file = new File([blob], name, { type: 'text/html;charset=utf-8' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          return navigator.share({
            files: [file],
            title: p.title || '团队旅游指南',
            text: '点开即可查看完整行程攻略（离线也能看）'
          }).then(function () { return { r: 'shared', url: url, name: name, size: h.length }; }, function (err) {
            if (err && err.name === 'AbortError') return { r: 'cancel', url: url, name: name, size: h.length };
            return { r: downloadHTML(url, name) ? 'downloaded' : 'fail', url: url, name: name, size: h.length };
          });
        }
      } catch (e) { }
      return Promise.resolve({ r: downloadHTML(url, name) ? 'downloaded' : 'fail', url: url, name: name, size: h.length });
    }, function () {
      return { r: location.protocol === 'file:' ? 'file-blocked' : 'fail', url: null, name: '', size: 0 };
    });
  }
  function downloadHTML(url, name) {
    try {
      var a = document.createElement('a');
      a.href = url; a.download = name; a.rel = 'noopener';
      document.body.appendChild(a); a.click();
      setTimeout(function () { document.body.removeChild(a); }, 1000);
      return true;
    } catch (e) { return false; }
  }

  function openPush() {
    if (!state.plan || !state.plan.days.length) { toast('请先创建行程计划'); return; }
    var base = shareBase();
    if (!base) { openShareBase(); return; }
    openSheet('分享给团员', '<div class="empty"><div class="e-emoji">⏳</div><div class="e-t">正在生成 B-link…</div></div>');
    shareURL(state.plan, true).then(function (liteURL) {
      if (!liteURL) return shareURL(state.plan, false);
      return liteURL;
    }).then(function (liteURL) {
      var local = isLocalBase(base);
      var warn = local
        ? '<div class="notice" style="margin-bottom:14px">⚠️ 当前地址 ' + esc(base) + ' 是本机/局域网地址，团员在外面打不开。<br>请改用公网版：https://kmnewauto.github.io/team-travel-guide/（登录后可重新生成）</div>' : '';
      var html = warn
        + '<div class="hint" style="text-align:center;margin:4px 0 14px">把链接发给团员，点开即看<b>只读行程攻略</b>，无需安装任何应用</div>'
        + '<textarea class="share-link" id="bLink" readonly>' + esc(liteURL) + '</textarea>'
        + '<div class="btn-row" style="margin-top:10px">'
        + '<button class="btn btn-primary" id="btnCopyB" style="flex:1">复制 B-link</button></div>'
        + '<div class="hint" style="text-align:center;margin-top:10px">行程修改后链接会随之更新，请重新复制再发送</div>';
      openSheet('分享给团员（B-link）', html, function (root) {
        function doCopy() {
          var ta = $('#bLink', root); ta.select(); ta.setSelectionRange(0, 99999);
          var ok = false;
          try { ok = document.execCommand('copy'); } catch (e) { }
          if (!ok && navigator.clipboard) {
            navigator.clipboard.writeText(ta.value).then(function () { toast('B-link 已复制，粘贴到微信群即可'); }, function () { toast('复制失败，请长按链接手动复制'); });
            return;
          }
          toast(ok ? 'B-link 已复制，粘贴到微信群即可' : '复制失败，请长按链接手动复制');
        }
        $('#btnCopyB', root).onclick = doCopy;
        $('#bLink', root).addEventListener('click', function () { this.select(); this.setSelectionRange(0, 99999); });
      });
    });
  }

  /* 本机已有计划时，询问是否切换到分享进来的行程 */
  function askSwitchPlan(shared, local) {
    openSheet('检测到分享的行程', ''
      + '<p style="margin:0 0 14px;font-size:13.5px;color:var(--c-ink-2);line-height:1.8">'
      + '你手机上已有一份行程：<b>' + esc(local.title || '未命名') + '</b>（' + local.days.length + ' 天）。<br>'
      + '当前链接分享的是：<b>' + esc(shared.title || '未命名') + '</b>（' + shared.days.length + ' 天）。<br>'
      + '要切换到这份分享的行程吗？</p>'
      + '<button class="btn btn-primary" id="swYes" style="margin-bottom:10px">切换到分享的行程</button>'
      + '<button class="btn btn-ghost" id="swNo">保留我自己的行程</button>', function (root) {
        $('#swYes', root).onclick = function () {
          state.plan = shared; savePlan(shared);
          state.sharedView = true;
          $('#topbarSub').textContent = shared.lite ? '随团人员视角 · 精简版' : '随团人员视角';
          closeSheet(); render(); toast('已切换到分享的行程');
        };
        $('#swNo', root).onclick = function () { closeSheet(); };
      });
  }

  /* ================= 启动 ================= */
  function boot() {
    try { localStorage.removeItem('tgt.plan.v1'); localStorage.removeItem('tgt.plan.v2'); } catch (e) { }
    readSharedPlan().then(function (shared) {
      var local = loadPlan();
      state.sharedView = false;
      if (shared && shared.days && shared.days.length) {
        if (local && local.days && local.days.length) {
          // 本机已有计划（例如团长自己点了分享链接）：先保留，再询问是否切换
          state.plan = local;
          setTimeout(function () { askSwitchPlan(shared, local); }, 260);
        } else {
          state.plan = shared; savePlan(shared);
          state.sharedView = true;
          $('#topbarSub').textContent = shared.lite ? '随团人员视角 · 精简版' : '随团人员视角';
        }
      } else if (local && local.days && local.days.length) {
        state.plan = local;
      } else {
        state.plan = null;
      }
      var r = (location.hash || '').replace('#/', '');
      state.route = (r === 'today' || r === 'trip') ? r : 'home';
      if (ssget(LS_UNLOCK) === '1') state.admin = true;
      $('#brandName').textContent =
        (state.plan && state.plan.organizer && state.plan.organizer.name) ? (state.plan.organizer.name + '的团') : '同行';
      render();
      $$('.tab').forEach(function (t) { t.addEventListener('click', function () { go(t.dataset.route); }); });
      $('#btnAdmin').addEventListener('click', openAdmin);
      $('#btnShare').addEventListener('click', openPush);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
