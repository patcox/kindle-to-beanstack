// Background service worker. Content scripts can't fetch cross-origin
// without hitting the hosting page's own CORS policy, no matter what
// host_permissions grants — that bypass only applies to the extension's
// own privileged contexts (this one, or the popup), not to a script
// running inside a page. So the household-children lookup (which lives on
// parents.amazon.com, a different origin than the Parent Dashboard content
// script runs on) happens here instead, reached via chrome.runtime.sendMessage
// from amazon.js.
//
// Unlike content scripts (whose manifest entry has no way to declare
// itself an ES module), a background service worker genuinely can — via
// "type": "module" on the "background" key — and here that's not just an
// option but a requirement: dynamic import() is disallowed inside a
// ServiceWorkerGlobalScope by the HTML spec (confirmed live: "import() is
// disallowed on ServiceWorkerGlobalScope"), so the lazy-dynamic-import
// pattern used elsewhere in this project can't work here. A static
// top-level import, evaluated as part of module loading rather than at
// runtime, is the only option — hence "type": "module" in the manifest.

import { fetchHouseholdChildren } from "./lib/amazon-client.js";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "kb-fetch-household-children") {
    fetchHouseholdChildren()
      .then((children) => sendResponse({ ok: true, children }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // keep the message channel open for the async sendResponse
  }
});
