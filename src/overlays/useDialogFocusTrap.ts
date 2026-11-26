import type { RefObject } from "preact";
import { useEffect } from "preact/hooks";

const FOCUSABLE_SELECTOR =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function useDialogFocusTrap(
  isOpen: boolean,
  containerRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = containerRef.current;
    if (el) (el.querySelector<HTMLElement>(FOCUSABLE_SELECTOR) ?? el).focus();

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "Tab" || !containerRef.current) return;
      const items = Array.from(
        containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((n) => n.tabIndex !== -1 && n.getAttribute("aria-hidden") !== "true");
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (!containerRef.current.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      if (prev && prev.isConnected) prev.focus();
    };
  }, [isOpen, containerRef]);
}
