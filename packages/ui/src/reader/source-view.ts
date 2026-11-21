import { moduleLanguage } from "@yongsk0066/reploom/internal/project/module-language";
import type { Tree } from "@lezer/common";
import type { paintSource } from "./syntax.ts";

import { sourceRows, inRange, type SourceRun } from "./lines.ts";

const blockSize = 4096;

export function mountSourceView(
  pre: HTMLElement,
  path: string,
  source: string,
  numbered = false,
  emphasis?: readonly [number, number],
) {
  if (numbered || emphasis) return mountLines(pre, path, source, emphasis);
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

function mountLines(
  pre: HTMLElement,
  path: string,
  source: string,
  emphasis?: readonly [number, number],
) {
  const doc = pre.ownerDocument;
  const controller = new AbortController();
  const blocks = new Map<Element, { from: number; to: number; line: number }>();
  const visible = new Set<Element>();

  type Syntax = typeof import("./syntax.ts");

  let parsing: Promise<{ tree: Tree; syntax: Syntax }> | undefined;

  function render(block: Element, runs: SourceRun[]) {
    const { from, to, line } = blocks.get(block)!;
    const fragment = doc.createDocumentFragment();
    for (const [i, row] of sourceRows(source, from, to, runs).entries()) {
      const el = doc.createElement("span");
      el.className = "reploom-source-line";
      el.dataset.line = String(line + i);
      if (inRange(line + i, emphasis)) el.dataset.emphasis = "true";
      for (const run of row) {
        const text = source.slice(run.from, run.to);
        if (run.style) {
          const token = doc.createElement("span");
          token.className = run.style;
          token.textContent = text;
          el.append(token);
        } else el.append(text);
      }
      fragment.append(el);
    }
    block.replaceChildren(fragment);
  }

  const observer = new IntersectionObserver(
    (entries) => {
      for (const { target, isIntersecting } of entries) {
        const { from, to } = blocks.get(target)!;
        if (!isIntersecting) {
          if (visible.delete(target)) target.textContent = source.slice(from, to);
          continue;
        }
        visible.add(target);
        render(target, []);
        if (moduleLanguage(path) === "text") continue;
        parsing ??= import("./syntax.ts").then(async (syntax) => ({
          syntax,
          tree: await syntax.parseSource(path, source, controller.signal),
        }));
        void parsing
          .then(({ tree, syntax }) => {
            if (controller.signal.aborted || !visible.has(target)) return;
            const runs: SourceRun[] = [];
            syntax.highlightSource(tree, from, to, (from, to, style) =>
              runs.push({ from, to, style }),
            );
            render(target, runs);
          })
          .catch(() => {});
      }
    },
    { root: pre, rootMargin: "96px" },
  );

  const content = doc.createDocumentFragment();
  let from = 0;
  let line = 1;
  do {
    const boundary = source.indexOf("\n", from + blockSize);
    const to = boundary < 0 ? source.length : boundary + 1;
    const block = doc.createElement("span");
    block.textContent = source.slice(from, to);
    blocks.set(block, { from, to, line });
    content.append(block);
    observer.observe(block);
    for (let n = source.indexOf("\n", from); n >= 0 && n < to; n = source.indexOf("\n", n + 1))
      line++;
    from = to;
  } while (from < source.length);
  pre.replaceChildren(content);
  return () => {
    controller.abort();
    observer.disconnect();
    visible.clear();
  };
}
