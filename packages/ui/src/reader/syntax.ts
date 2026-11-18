import { classHighlighter, highlightTree } from "@lezer/highlight";
import type { Tree } from "@lezer/common";

async function language(path: string) {
  if (path.endsWith(".css")) return (await import("@lezer/css")).parser;
  if (path.endsWith(".json")) return (await import("@lezer/json")).parser;
  const { parser } = await import("@lezer/javascript");
  return parser.configure({ dialect: /\.tsx?$/.test(path) ? "jsx ts" : "jsx" });
}

export async function parseSource(path: string, source: string, signal: AbortSignal) {
  const parser = await language(path);
  signal.throwIfAborted();
  const parse = parser.startParse(source);
  let deadline = performance.now() + 4;
  for (;;) {
    const tree = parse.advance();
    if (tree) return tree;
    if (performance.now() >= deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
      deadline = performance.now() + 4;
    }
  }
}

export function paintSource(
  block: HTMLElement,
  tree: Tree,
  source: string,
  from: number,
  to: number,
) {
  const doc = block.ownerDocument;
  const content = doc.createDocumentFragment();
  let cursor = from;
  highlightTree(
    tree,
    classHighlighter,
    (start, end, style) => {
      if (start > cursor) content.append(source.slice(cursor, start));
      const span = doc.createElement("span");
      span.className = style;
      span.textContent = source.slice(start, end);
      content.append(span);
      cursor = end;
    },
    from,
    to,
  );
  if (cursor < to) content.append(source.slice(cursor, to));
  block.replaceChildren(content);
}
