// Shared dropdown-panel behaviour (settings panel, turf picker).
// Keyboard opens move focus into the panel's first/checked control; pointer
// opens focus the panel itself so no ring appears under a finger. Closes on
// Escape, outside tap, focus leaving, or tapping the trigger again.
export function popover(trigger, panel) {
  const focusTarget = () =>
    panel.querySelector("input:checked") || panel.querySelector("input, button, [tabindex='0']");

  const open = (viaKeyboard = true) => {
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    if (viaKeyboard && focusTarget()) focusTarget().focus();
    else panel.focus({ preventScroll: true });
  };
  const close = (returnFocus = true) => {
    if (panel.hidden) return;
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (returnFocus) trigger.focus();
  };

  trigger.addEventListener("click", e => (panel.hidden ? open(e.detail === 0) : close()));
  document.addEventListener("keydown", e => { if (e.key === "Escape" && !panel.hidden) close(); });
  document.addEventListener("pointerdown", e => {
    if (!panel.hidden && !panel.contains(e.target) && !trigger.contains(e.target)) close(false);
  });
  panel.addEventListener("focusout", e => {
    if (e.relatedTarget && !panel.contains(e.relatedTarget) && e.relatedTarget !== trigger) close(false);
  });
  return { open, close };
}
