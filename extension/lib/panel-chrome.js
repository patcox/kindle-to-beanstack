// Shared chrome for the floating panels injected on Amazon and Beanstack:
// drag-to-move, minimize, and close/reopen. Added after live testing showed
// the fixed top-right panel can sit directly over page UI the user still
// needs (e.g. Beanstack's own reader-switcher dropdown) with no way to get
// it out of the way.
//
// Expects the panel to already contain elements marked with
// data-kb-role="header" / "body" / "minimize" / "close" — each content
// script builds its own markup, this just wires up the shared behavior.

const STYLE_TAG_ID = "kb-panel-base-styles";

/**
 * Native form controls (input/select/button/textarea) don't inherit
 * font-family/size from ancestors the way ordinary text does — combined
 * with sitting directly under document.body on someone else's page (whose
 * own root font-size may be much larger, e.g. Beanstack's chunky
 * kid-friendly type), that's what produced the mismatched, oversized text
 * boxes seen in live testing. This pins every control in the panel to one
 * explicit, compact scale instead of leaving it to inherit whatever the
 * host page happens to set. Injected once per page (idempotent — content
 * scripts only run once per page load anyway, but this guards against
 * re-running the panel setup twice for any reason).
 */
function injectBaseStyles() {
  if (document.getElementById(STYLE_TAG_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_TAG_ID;
  // `!important` throughout: the panel is appended straight onto the host
  // page's document.body, so it's exposed to whatever that page's own CSS
  // does to bare `input`/`select`/`div` selectors (seen live — Beanstack's
  // own big, bold, kid-friendly form styling was bleeding through despite
  // matching class selectors here, and its `select` reset was forcing our
  // reader-pairing dropdowns to full block width). `!important` is the only
  // way to guarantee this panel looks the same regardless of host page.
  style.textContent = `
    .kb-panel, .kb-panel * {
      box-sizing: border-box !important;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif !important;
      font-weight: 400 !important;
      line-height: 1.4 !important;
    }
    .kb-panel { font-size: 13px !important; color: #111 !important; }
    .kb-panel .kb-bold { font-weight: 600 !important; }
    .kb-panel input,
    .kb-panel select,
    .kb-panel button,
    .kb-panel textarea {
      font-size: 12px !important;
      padding: 3px 6px !important;
      border: 1px solid #ccc !important;
      border-radius: 4px !important;
      background: #fff !important;
      color: inherit !important;
      height: auto !important;
      vertical-align: middle !important;
    }
    /* Beanstack's own reset forces bare <select> elements to block/100%
       width — without this, the reader-pairing dropdown stretched across
       the whole panel and dropped to its own line below the kid's name
       instead of sitting beside it. Width here is deliberately NOT
       !important-ed for input/button/textarea above, since some of those
       (the manual title/author fields) intentionally use inline width:100%
       to fill their table cell — only <select> needed forcing back down. */
    .kb-panel select {
      display: inline-block !important;
      width: auto !important;
      max-width: 220px !important;
    }
    .kb-panel input[type="date"] { padding: 2px 4px !important; }
    .kb-panel input[type="number"] { width: 56px !important; }
    .kb-panel button {
      cursor: pointer !important;
      background: #f5f5f5 !important;
      font-weight: 600 !important;
    }
    .kb-panel button:hover { background: #ececec !important; }
    .kb-panel table, .kb-panel table * { font-size: 11px !important; }
    .kb-panel th { font-weight: 600 !important; }
  `;
  document.head.appendChild(style);
}

export function wirePanelChrome(panel, { reopenLabel = "K→B" } = {}) {
  injectBaseStyles();
  panel.classList.add("kb-panel");
  const header = panel.querySelector('[data-kb-role="header"]');
  const body = panel.querySelector('[data-kb-role="body"]');
  const minimizeBtn = panel.querySelector('[data-kb-role="minimize"]');
  const closeBtn = panel.querySelector('[data-kb-role="close"]');

  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;
  header.addEventListener("mousedown", (e) => {
    if (e.target.closest("button")) return;
    dragging = true;
    const rect = panel.getBoundingClientRect();
    offsetX = e.clientX - rect.left;
    offsetY = e.clientY - rect.top;
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = "auto";
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    panel.style.left = `${e.clientX - offsetX}px`;
    panel.style.top = `${e.clientY - offsetY}px`;
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
  });

  minimizeBtn.addEventListener("click", () => {
    const minimized = body.style.display === "none";
    body.style.display = minimized ? "" : "none";
    minimizeBtn.textContent = minimized ? "–" : "+";
    minimizeBtn.title = minimized ? "Minimize" : "Expand";
  });

  const reopenBtn = document.createElement("button");
  reopenBtn.id = `${panel.id}-reopen`;
  reopenBtn.type = "button";
  reopenBtn.textContent = reopenLabel;
  reopenBtn.title = "Reopen panel";
  reopenBtn.style.cssText = `
    position: fixed; top: 16px; right: 16px; z-index: 999999;
    display: none; padding: 6px 10px; border-radius: 6px;
    border: 1px solid #ccc; background: #fff; color: #111;
    font: 13px -apple-system, sans-serif; cursor: pointer;
    box-shadow: 0 2px 8px rgba(0,0,0,0.2);
  `;
  reopenBtn.addEventListener("click", () => {
    panel.style.display = "";
    reopenBtn.style.display = "none";
  });
  document.body.appendChild(reopenBtn);

  closeBtn.addEventListener("click", () => {
    panel.style.display = "none";
    reopenBtn.style.display = "block";
  });

  return { reopenBtn };
}
