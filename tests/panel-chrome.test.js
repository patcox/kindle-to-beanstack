import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { wirePanelChrome } from "../extension/lib/panel-chrome.js";

let dom;
let originalWindow;
let originalDocument;

beforeEach(() => {
  dom = new JSDOM("<!doctype html><html><body></body></html>");
  originalWindow = globalThis.window;
  originalDocument = globalThis.document;
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
});

afterEach(() => {
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
});

function buildPanel() {
  const panel = document.createElement("div");
  panel.id = "kb-test-panel";
  panel.innerHTML = `
    <div data-kb-role="header">
      <span>Title</span>
      <button type="button" data-kb-role="minimize">–</button>
      <button type="button" data-kb-role="close">×</button>
    </div>
    <div data-kb-role="body">content</div>
  `;
  document.body.appendChild(panel);
  return panel;
}

test("wirePanelChrome creates a hidden reopen button", () => {
  const panel = buildPanel();
  wirePanelChrome(panel, { reopenLabel: "Reopen" });
  const reopenBtn = document.getElementById(`${panel.id}-reopen`);
  assert.ok(reopenBtn);
  assert.equal(reopenBtn.style.display, "none");
  assert.equal(reopenBtn.textContent, "Reopen");
});

test("close hides the panel and reveals the reopen button; reopen restores it", () => {
  const panel = buildPanel();
  wirePanelChrome(panel);
  const closeBtn = panel.querySelector('[data-kb-role="close"]');
  const reopenBtn = document.getElementById(`${panel.id}-reopen`);

  closeBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(panel.style.display, "none");
  assert.equal(reopenBtn.style.display, "block");

  reopenBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(panel.style.display, "");
  assert.equal(reopenBtn.style.display, "none");
});

test("minimize hides the body and toggles back on a second click", () => {
  const panel = buildPanel();
  wirePanelChrome(panel);
  const minimizeBtn = panel.querySelector('[data-kb-role="minimize"]');
  const body = panel.querySelector('[data-kb-role="body"]');

  minimizeBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(body.style.display, "none");
  assert.equal(minimizeBtn.textContent, "+");

  minimizeBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  assert.equal(body.style.display, "");
  assert.equal(minimizeBtn.textContent, "–");
});

test("dragging the header by its handle moves the panel and switches off right-anchoring", () => {
  const panel = buildPanel();
  panel.style.position = "fixed";
  panel.style.top = "16px";
  panel.style.right = "16px";
  wirePanelChrome(panel);
  const header = panel.querySelector('[data-kb-role="header"]');

  panel.getBoundingClientRect = () => ({ left: 100, top: 20, right: 200, bottom: 60, width: 100, height: 40 });

  header.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, clientX: 110, clientY: 30 }));
  window.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 150, clientY: 80 }));

  assert.equal(panel.style.right, "auto");
  assert.equal(panel.style.left, "140px"); // 150 - (110 - 100)
  assert.equal(panel.style.top, "70px"); // 80 - (30 - 20)

  window.dispatchEvent(new window.MouseEvent("mouseup", { bubbles: true }));
  window.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 999, clientY: 999 }));
  assert.equal(panel.style.left, "140px"); // unchanged after mouseup
});

test("clicking a button inside the header does not start a drag", () => {
  const panel = buildPanel();
  wirePanelChrome(panel);
  const closeBtn = panel.querySelector('[data-kb-role="close"]');

  panel.getBoundingClientRect = () => ({ left: 100, top: 20, right: 200, bottom: 60, width: 100, height: 40 });

  closeBtn.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true, clientX: 110, clientY: 30 }));
  window.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 150, clientY: 80 }));

  assert.notEqual(panel.style.left, "140px");
});
