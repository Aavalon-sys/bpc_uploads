// Safari diagnostics page for the Safari build of Bypass Paywalls Clean.
// Opened from the extension popup (safari-popup.js passes the current tab).
(function () {
  'use strict';

  var api = (typeof browser === 'object' && browser) || chrome;
  var params = new URLSearchParams(location.search);
  var tabId = params.has('tab') ? Number(params.get('tab')) : null;
  var siteUrl = params.get('url') || '';

  var GRANT_HELP = 'macOS：Safari 设置 → 扩展 → Bypass Paywalls Clean → 编辑网站… → 「访问其他网站时」选「允许」（或在工具栏点扩展图标 → 在每个网站上始终允许）。' +
    'iPhone/iPad：设置 → App → Safari → 扩展 → Bypass Paywalls Clean → 「其他网站」选「允许」。改完后刷新新闻页面。';

  function errorText(e) {
    return 'ERROR: ' + ((e && e.message) || String(e));
  }

  function safe(fn) {
    try {
      return Promise.resolve(fn()).catch(errorText);
    } catch (e) {
      return Promise.resolve(errorText(e));
    }
  }

  function isError(v) {
    return typeof v === 'string' && v.indexOf('ERROR:') === 0;
  }

  function host(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (e) {
      return '';
    }
  }

  function run() {
    var report = [];
    var verdict = [];
    function add(key, value) {
      report.push(key + ': ' + (typeof value === 'string' ? value : JSON.stringify(value)));
    }
    function say(level, text) {
      verdict.push({ level: level, text: text });
    }

    var manifest = api.runtime.getManifest();
    var siteHost = /^https?:/.test(siteUrl) ? host(siteUrl) : '';
    add('time', new Date().toISOString());
    add('userAgent', navigator.userAgent);
    add('extension', manifest.name + ' ' + manifest.version);
    add('manifest has update_url / key', [!!manifest.update_url, !!manifest.key]);
    add('current site', siteUrl || '(not opened from the popup)');

    return Promise.all([
      safe(function () { return api.permissions.getAll(); }),
      siteHost ? safe(function () { return api.permissions.contains({ origins: [new URL(siteUrl).origin + '/*'] }); }) : Promise.resolve(null),
      safe(function () { return api.storage.local.get(['sites', 'optIn', 'optInFetch', 'optInUpdate', 'bpc_safari_report']); }),
      safe(function () { return api.runtime.sendMessage({ request: 'bpcSafariDiag', url: siteUrl }); }),
      safe(function () { return api.declarativeNetRequest.getSessionRules(); }),
      tabId !== null ? safe(function () { return api.declarativeNetRequest.getMatchedRules({ tabId: tabId }); }) : Promise.resolve(null),
      tabId !== null ? safe(function () {
        return api.scripting.executeScript({
          target: { tabId: tabId },
          func: function () {
            /* global ext_chromium */
            return { contentScript: typeof ext_chromium !== 'undefined', href: location.href };
          },
        });
      }) : Promise.resolve(null),
    ]).then(function (r) {
      var perms = r[0], siteAccess = r[1], store = r[2], bg = r[3], rules = r[4], matched = r[5], probe = r[6];

      // Permissions
      var origins = perms && perms.origins;
      var allSites = Array.isArray(origins) && origins.some(function (o) { return o === '<all_urls>' || o === '*://*/*' || o === '*://*/'; });
      add('permissions', perms && perms.permissions ? perms.permissions : perms);
      add('granted origins', Array.isArray(origins) ? origins.length + (allSites ? ' (all websites)' : '') : origins);
      if (siteHost) add('access to current site', siteAccess);
      if (siteHost && siteAccess === false) say('bad', '没有访问当前网站的权限，扩展无法在这个网站上工作。' + GRANT_HELP);
      else if (!siteHost && Array.isArray(origins) && !allSites && origins.length < 50) say('warn', '只授予了 ' + origins.length + ' 个网站的访问权限，未授权的网站上扩展不会生效。' + GRANT_HELP);

      // Options
      var siteCount = store && store.sites ? Object.keys(store.sites).length : 0;
      add('enabled sites in options', isError(store) ? store : siteCount);
      add('opt-in', isError(store) ? store : { optIn: store.optIn, optInFetch: store.optInFetch, optInUpdate: store.optInUpdate });
      if (!isError(store) && !siteCount) say('bad', '选项里一个站点都没有启用：打开扩展的 Options，勾选要用的站点后保存。');

      // Background page
      add('background', bg);
      if (!bg || isError(bg)) {
        say('bad', '后台页没有响应（扩展的后台脚本可能没有运行）：' + (bg || 'no response'));
        if (store && store.bpc_safari_report) add('last stored background report', store.bpc_safari_report);
      } else {
        if (bg.backgroundLoaded === false) say('bad', '后台脚本没有完整加载（background.js 未运行）。');
        if (bg.errors && bg.errors.length) say('warn', '后台页有 ' + bg.errors.length + ' 个报错，见下方 background.errors。');
        if (siteHost && bg.siteEnabled === false) say('warn', '当前网站不在已启用的站点里（不受支持，或在 Options 里没有勾选）。');
        if (bg.lastAddCall && bg.lastAddCall.batchRejected) say('warn', 'Safari 拒绝了部分规则：' + JSON.stringify(bg.lastAddCall.dropped));
      }

      // Rules
      if (Array.isArray(rules)) {
        // Without the marker rule the Safari build adds to verify its updates.
        rules = rules.filter(function (rule) { return rule.id !== 9000000; });
        var byType = {};
        rules.forEach(function (rule) {
          byType[rule.action.type] = (byType[rule.action.type] || 0) + 1;
        });
        add('session rules', { total: rules.length, byType: byType });
        if (siteHost) {
          var forSite = rules.filter(function (rule) { return JSON.stringify(rule.condition).indexOf(siteHost) >= 0; });
          add('session rules mentioning ' + siteHost, forSite.map(function (rule) { return rule.id + ':' + rule.action.type; }));
        }
        if (!rules.length) say('bad', '没有加载任何拦截规则。');
      } else {
        add('session rules', rules);
        say('bad', '读取拦截规则失败：' + rules);
      }
      if (tabId !== null) add('matched rules on this tab', matched && matched.rulesInfo ? matched.rulesInfo.length : matched);

      // Content script
      if (tabId !== null) {
        var result = Array.isArray(probe) && probe[0] ? probe[0].result : probe;
        add('content script probe', result);
        if (isError(result)) say(/access/i.test(result) ? 'bad' : 'warn', '无法检测当前页面：' + result + (/access/i.test(result) ? ' ' + GRANT_HELP : ''));
        else if (result && result.contentScript === false) say('bad', '扩展的脚本没有注入到当前页面。授予网站权限后请刷新页面再试；如果仍然没有，请把本报告发给开发者。');
        else if (result && result.contentScript) say('ok', '扩展的脚本已注入到当前页面。');
      }

      if (!verdict.some(function (v) { return v.level === 'bad' || v.level === 'warn'; }))
        say('ok', '没有发现明显问题。如果文章仍被付费墙挡住，可能是该网站的规则在 Safari 上不起作用，请把下面的报告发给开发者。');
      return { report: report, verdict: verdict };
    });
  }

  function render(res) {
    var ul = document.getElementById('verdict');
    ul.textContent = '';
    res.verdict.forEach(function (v) {
      var li = document.createElement('li');
      li.className = v.level;
      li.textContent = (v.level === 'ok' ? '✓ ' : v.level === 'bad' ? '✗ ' : '! ') + v.text;
      ul.appendChild(li);
    });
    document.getElementById('report').value = res.report.join('\n');
  }

  function start() {
    run().then(render, function (e) {
      render({ report: [errorText(e)], verdict: [{ level: 'bad', text: '诊断失败：' + errorText(e) }] });
    });
  }

  document.getElementById('copy').addEventListener('click', function () {
    var area = document.getElementById('report');
    var done = function () { document.getElementById('copy').textContent = '已复制'; };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(area.value).then(done, function () { area.select(); document.execCommand('copy'); done(); });
    } else {
      area.select();
      document.execCommand('copy');
      done();
    }
  });
  document.getElementById('reload').addEventListener('click', start);
  start();
})();
