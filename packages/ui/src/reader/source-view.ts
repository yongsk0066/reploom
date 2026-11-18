import { moduleLanguage } from "@yongsk0066/reploom/internal/project/module-language";
import type { Tree } from "@lezer/common";
import type { paintSource } from "./syntax.ts";

const blockSize = 4096;

export function mountSourceView(pre: HTMLElement, path: string, source: string) {
  if (moduleLanguage(path) === "text") {
    pre.textContent = source;
    return () => {};
  }
  const controller = new AbortController();
  const { signal } = controller;
  const ranges = new Map<Element, { from: number; to: number }>();
  const visible = new Set<HTMLElement>();
  let syntax: Promise<{ tree: Tree; paint: typeof paintSource }> | undefined;

  function show(block: HTMLElement) {
    syntax ??= import("./syntax.ts").then(async ({ parseSource, paintSource }) => ({
      tree: await parseSource(path, source, signal),
      paint: paintSource,
    }));
    void syntax
      .then(({ tree, paint }) => {
        if (!signal.aborted && visible.has(block)) {
          const { from, to } = ranges.get(block)!;
          paint(block, tree, source, from, to);
        }
      })
      .catch(() => {});
  }

  const observer = new IntersectionObserver(
    (entries) => {
      if (signal.aborted) return;
      for (const entry of entries) {
        const block = entry.target as HTMLElement;
        if (entry.isIntersecting && !visible.has(block)) {
          visible.add(block);
          show(block);
        } else if (!entry.isIntersecting && visible.delete(block)) {
          const { from, to } = ranges.get(block)!;
          block.textContent = source.slice(from, to);
        }
      }
    },
    { rootMargin: "96px" },
  );

  const content = pre.ownerDocument.createDocumentFragment();
  for (let from = 0; from < source.length;) {
    let to = Math.min(source.length, from + blockSize);
    const next = source.charCodeAt(to);
    if ((next >= 0xdc00 && next <= 0xdfff) || (next === 10 && source.charCodeAt(to - 1) === 13))
      to++;
    const block = pre.ownerDocument.createElement("span");
    block.textContent = source.slice(from, to);
    ranges.set(block, { from, to });
    content.append(block);
    observer.observe(block);
    from = to;
  }
  pre.replaceChildren(content);
  return () => {
    controller.abort();
    observer.disconnect();
  };
}
