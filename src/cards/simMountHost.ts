import { h, render } from "preact";
import { useEffect } from "preact/hooks";
import type { RefObject } from "preact";
import { VisualSimBlock } from "./VisualSimBlock";
import { parseVisualSimSpec } from "./visualSimEngine";

/**
 * Lazily hydrates DOMPurify-validated `.axiom-sim-mount[data-sim]` placeholders inside a
 * Markdown container using Preact subtrees, and unmounts them cleanly on HTML change or unmount.
 */
export function useSimHydration(
  containerRef: RefObject<HTMLDivElement>,
  renderedHtml: string,
  enabled = true,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) {
      return;
    }

    const mounted: HTMLElement[] = [];
    const targets = container.querySelectorAll<HTMLElement>(".axiom-sim-mount[data-sim]");
    for (const el of targets) {
      const encoded = el.getAttribute("data-sim");
      if (!encoded) {
        continue;
      }
      const spec = parseVisualSimSpec(encoded);
      if (!spec) {
        continue;
      }
      el.textContent = "";
      render(h(VisualSimBlock, { spec }), el);
      mounted.push(el);
    }

    return () => {
      for (const el of mounted) {
        render(null, el);
      }
    };
  }, [containerRef, renderedHtml, enabled]);
}
