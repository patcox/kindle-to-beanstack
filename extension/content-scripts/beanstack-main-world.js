// Runs in the page's actual ("main") JS world — see amazon-main-world.js
// for why. Patches the real XMLHttpRequest (Beanstack's frontend uses XHR,
// not fetch, for book_autocomplete) to catch the Authorization header it
// sends, and relays it to beanstack.js (isolated world) via postMessage.
(function () {
  if (window.__kbBeanstackMainWorldPatched) return;
  window.__kbBeanstackMainWorldPatched = true;

  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__kbUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this.__kbUrl && String(this.__kbUrl).includes("book_autocomplete") && /authorization/i.test(name)) {
      window.postMessage({ source: "kb-beanstack-main-world", token: value }, "*");
    }
    return origSetHeader.call(this, name, value);
  };
})();
