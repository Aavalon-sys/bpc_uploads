// Adds the "Safari 诊断" link to the extension popup (Safari build only).
// It opens safari-diagnostics.html for the tab the popup was opened on.
(function () {
  'use strict';
  var api = (typeof browser === 'object' && browser) || chrome;
  var link = document.getElementById('bpc_safari_diag');
  if (!link) return;
  link.addEventListener('click', function (event) {
    event.preventDefault();
    var page = api.runtime.getURL('safari-diagnostics.html');
    api.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
      var tab = tabs && tabs[0];
      var url = tab ? page + '?tab=' + tab.id + '&url=' + encodeURIComponent(tab.url || '') : page;
      return api.tabs.create({ url: url });
    }, function () {
      return api.tabs.create({ url: page });
    }).then(function () {
      window.close();
    }, function () {
      window.close();
    });
  });
})();
