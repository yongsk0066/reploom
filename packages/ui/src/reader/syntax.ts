import { moduleLanguage } from "@yongsk0066/reploom/internal/project/module-language";
import { classHighlighter, highlightTree } from "@lezer/highlight";
import type { Tree } from "@lezer/common";
import palette from "./palette.css";

const paintedClasses = new Set(palette.match(/\btok-[\w-]+/g));
const resolved = new Map<string, string>();

export function highlightSource(
  tree: Tree,
  from: number,
  to: number,
  write: (start: number, end: number, style: string) => void,
) {
  highlightTree(
    tree,
    classHighlighter,
    (start, end, style) => {
      let painted = resolved.get(style);
      if (painted === undefined) {
        painted = style
          .split(" ")
          .filter((token) => paintedClasses.has(token))
          .join(" ");
        resolved.set(style, painted);
      }
      if (painted) write(start, end, painted);
    },
    from,
    to,
  );
}

export async function language(path: string) {
  const kind = moduleLanguage(path);
  if (kind === "css") return (await import("@lezer/css")).parser;
  if (kind === "json") return (await import("@lezer/json")).parser;
  const { parser } = await import("@lezer/javascript");
  return kind === "js"
    ? parser
    : parser.configure({ dialect: kind === "ts" ? "ts" : kind === "tsx" ? "jsx ts" : "jsx" });
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
  highlightSource(tree, from, to, (start, end, style) => {
    if (start > cursor) content.append(source.slice(cursor, start));
    const span = doc.createElement("span");
    span.className = style;
    span.textContent = source.slice(start, end);
    content.append(span);
    cursor = end;
  });
  if (cursor < to) content.append(source.slice(cursor, to));
  block.replaceChildren(content);
}
