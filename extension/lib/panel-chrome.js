// Shared chrome for the floating panels injected on Amazon and Beanstack:
// drag-to-move, minimize, and close/reopen. Added after live testing showed
// the fixed top-right panel can sit directly over page UI the user still
// needs (e.g. Beanstack's own reader-switcher dropdown) with no way to get
// it out of the way.
//
// Expects the panel to already contain elements marked with
// data-kb-role="header" / "body" / "minimize" / "close" — each content
// script builds its own markup, this just wires up the shared behavior.
export function wirePanelChrome(panel, { reopenLabel = "K→B" } = {}) {
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
