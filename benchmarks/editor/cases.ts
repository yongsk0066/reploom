import { EditorSelection, StateEffect, Text } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import { matchBrackets, ParseContext, syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { undo, redo, isolateHistory } from "@codemirror/commands";
import { createEditor } from "../../packages/ui/src/codemirror/editor.ts";

type Meter = {
  parseMs: number;
  parseCalls: number;
  largestParseMs: number;
  flattenCalls: number;
  flattenCharacters: number;
  timerGapMs: number;
};

let meter: Meter | undefined;

// Observe the installed parser's private scheduling primitive only in this
// benchmark. Public integration code uses CodeMirror's supported extensions.
const parsePrototype = ParseContext.prototype as unknown as {
  work(until: number | (() => boolean), upto?: number): boolean;
};

const originalWork = parsePrototype.work;
parsePrototype.work = function (...args) {
  const start = performance.now();
  try {
    return originalWork.apply(this, args);
  } finally {
    if (meter) {
      const elapsed = performance.now() - start;
      meter.parseMs += elapsed;
      meter.parseCalls++;
      meter.largestParseMs = Math.max(meter.largestParseMs, elapsed);
    }
  }
};
const originalString = Text.prototype.toString;
Text.prototype.toString = function () {
  if (meter) {
    meter.flattenCalls++;
    meter.flattenCharacters += this.length;
  }
  return originalString.call(this);
};

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const task = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const emptyMeter = (): Meter => ({
  parseMs: 0,
  parseCalls: 0,
  largestParseMs: 0,
  flattenCalls: 0,
  flattenCharacters: 0,
  timerGapMs: 0,
});

async function sample(run: () => void) {
  meter = emptyMeter();
  let previous = performance.now();

  const heartbeat = setInterval(() => {
    const now = performance.now();
    if (meter) meter.timerGapMs = Math.max(meter.timerGapMs, now - previous);
    previous = now;
  }, 1);

  const start = performance.now();
  run();
  const syncMs = performance.now() - start;
  const sync = { ...meter };
  await frame();
  await frame();
  const toFrameMs = performance.now() - start;
  const element = document.querySelector("#editor .cm-editor");
  const view = element && EditorView.findFromDOM(element as HTMLElement);
  const syntaxAtTwoFrames = view ? syntaxTreeAvailable(view.state, view.state.doc.length) : true;
  const viewportSyntaxAtTwoFrames = view ? syntaxTreeAvailable(view.state, view.viewport.to) : true;
  if (view) await waitForSyntax(view, view.viewport.to);
  const toViewportSyntaxMs = performance.now() - start;
  if (view) await waitForSyntax(view);
  const toSyntaxMs = performance.now() - start;
  clearInterval(heartbeat);
  const total = meter;
  meter = undefined;
  return {
    syncMs,
    toFrameMs,
    toSyntaxMs,
    syntaxAtTwoFrames,
    viewportSyntaxAtTwoFrames,
    toViewportSyntaxMs,
    sync,
    total,
  };
}

function verify(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}

async function waitForSyntax(view: EditorView, upto = view.state.doc.length) {
  const deadline = performance.now() + 10000;
  while (!syntaxTreeAvailable(view.state, upto)) {
    verify(performance.now() < deadline, "Parser did not finish");
    await task(5);
  }
}

async function treeIdentity(view: EditorView) {
  await waitForSyntax(view);
  const tree = syntaxTree(view.state);
  let nodes = 0;
  let checksum = 2166136261;
  tree.iterate({
    enter(node) {
      nodes++;
      for (const value of [node.type.id, node.from, node.to])
        checksum = Math.imul(checksum ^ value, 16777619);
    },
  });
  return { length: tree.length, nodes, checksum: checksum >>> 0 };
}

function navigationIdentity(view: EditorView) {
  const tree = syntaxTree(view.state);
  let parents = 0;
  const pending = [tree.topNode];

  const identify = (node: { type: { id: number }; from: number; to: number }) =>
    `${node.type.id}:${node.from}:${node.to}`;

  while (pending.length) {
    const parent = pending.pop()!;
    const forward = [];
    for (let node = parent.firstChild; node; node = node.nextSibling) {
      forward.push(identify(node));
      if (node.firstChild) pending.push(node);
    }
    if (!forward.length) continue;
    parents++;
    const backward = [];
    for (let node = parent.lastChild; node; node = node.prevSibling) backward.push(identify(node));
    verify(
      JSON.stringify(forward) === JSON.stringify(backward.reverse()),
      "SyntaxNode backward traversal differs",
    );
    const cursor = parent.cursor();
    const traversed = [];
    if (cursor.lastChild())
      do {
        traversed.push(identify(cursor));
      } while (cursor.prevSibling());
    verify(
      JSON.stringify(forward) === JSON.stringify(traversed.reverse()),
      "TreeCursor backward traversal differs",
    );
  }
  const text = view.state.doc.toString();
  const matches = [];
  const positions = new Set([0, 1, Math.floor(text.length / 2), text.length - 1, text.length]);
  for (let i = 0; i < text.length && positions.size < 200; i++) {
    if ("()[]{}<>".includes(text[i])) {
      positions.add(i);
      positions.add(i + 1);
    }
  }
  for (const position of positions)
    for (const direction of [-1, 1]) matches.push(matchBrackets(view.state, position, direction));
  return { parents, matches };
}

function treeDepth(view: EditorView) {
  const pending = [{ tree: syntaxTree(view.state), depth: 0 }];
  let max = 0;
  while (pending.length) {
    const { tree, depth } = pending.pop()!;
    max = Math.max(max, depth);
    for (const child of tree.children)
      if ("children" in child) pending.push({ tree: child, depth: depth + 1 });
  }
  return max;
}

async function runEditor(test: { name: string; source: string; path: string }) {
  const parent = document.getElementById("editor")!;
  let files: Record<string, string | Text> = {
    [test.path]: test.source,
    "/other.js": "export const value = 1;",
  };
  const edits: Array<{ bytes: number; spans: number }> = [];
  let editor!: ReturnType<typeof createEditor>;
  const results: Record<string, unknown> = {};
  try {
    results.mount = await sample(() => {
      editor = createEditor(
        parent,
        (path, source, _composing, changes) => {
          files = { ...files, [path]: source as Text };
          edits.push({
            bytes: changes?.reduce((n, c) => n + c.insert.length, 0) ?? -1,
            spans: changes?.length ?? -1,
          });
        },
        (globalThis as typeof globalThis & { forceLanguageWorker?: boolean }).forceLanguageWorker
          ? { language: { minCharacters: 1 } }
          : {},
      );
      editor.sync(files, test.path, {}, false);
    });
    const view = EditorView.findFromDOM(parent.querySelector(".cm-editor")!)!;
    verify(view, "No editor view");
    const initialTree = await treeIdentity(view);
    view.focus();
    await frame();
    await frame();
    const offset = Math.max(0, test.source.indexOf("12345"));
    const native = [];
    for (let index = 0; index < 12; index++) {
      native.push(
        await sample(() => {
          view.dispatch({
            changes: { from: offset, to: offset + 1, insert: index % 2 ? "1" : "2" },
            selection: EditorSelection.cursor(offset + 1),
            userEvent: "input.type",
          });
          editor.sync(files, test.path, {}, false);
        }),
      );
    }
    verify(view.state.doc.toString() === test.source, "Native edits changed the final document");
    results.native = native;
    results.nativeEdits = edits.slice();
    if (test.name === "repeated-edits") {
      const depths = [treeDepth(view)];
      for (let i = 0; i < 400; i++) {
        view.dispatch({ changes: { from: offset, to: offset + 1, insert: i % 2 ? "1" : "2" } });
        editor.sync(files, test.path, {}, false);
        await treeIdentity(view);
        if (i % 40 === 39) {
          depths.push(treeDepth(view));
          navigationIdentity(view);
        }
      }
      results.repeatDepths = depths;
    }
    const lifecycle = { created: 0, destroyed: 0 };
    view.dispatch({
      effects: StateEffect.appendConfig.of(
        ViewPlugin.define(() => {
          lifecycle.created++;
          return {
            destroy() {
              lifecycle.destroyed++;
            },
          };
        }),
      ),
    });
    const external = [];
    const beforeExternal = { ...lifecycle };
    const callbackCount = edits.length;
    for (let index = 0; index < 6; index++) {
      await treeIdentity(view);

      const next =
        test.source.slice(0, offset) + (index % 2 ? "1" : "2") + test.source.slice(offset + 1);

      files = { ...files, [test.path]: next };
      external.push(await sample(() => editor.sync(files, test.path, {}, false)));
      verify(view.state.doc.toString() === next, "External sync corrupted the document");
    }
    verify(edits.length === callbackCount, "External synchronization echoed an editor change");
    results.externalLifecycle = {
      created: lifecycle.created - beforeExternal.created,
      destroyed: lifecycle.destroyed - beforeExternal.destroyed,
      selection: view.state.selection.main.head,
    };
    results.external = external;
    const paste = [];
    for (let index = 0; index < 3; index++) {
      await treeIdentity(view);
      view.dispatch({
        selection: EditorSelection.single(0, view.state.doc.length),
        annotations: isolateHistory.of("full"),
      });
      const next = test.source.slice(0, offset) + "2" + test.source.slice(offset + 1);
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: { types: ["text/plain"], getData: () => next },
      });
      paste.push(
        await sample(() => {
          view.contentDOM.dispatchEvent(event);
          editor.sync(files, test.path, {}, false);
        }),
      );
      verify(view.state.doc.toString() === next, "Paste did not apply");
      verify(undo(view) && view.state.doc.toString() === test.source, "Paste undo failed");
      verify(redo(view) && view.state.doc.toString() === next, "Paste redo failed");
      verify(undo(view), "Final undo failed");
      editor.sync(files, test.path, {}, false);
    }
    results.paste = paste;
    const switching = [];
    for (let index = 0; index < 6; index++) {
      switching.push(
        await sample(() => editor.sync(files, index % 2 ? test.path : "/other.js", {}, false)),
      );
    }
    results.switching = switching;
    const finalTree = await treeIdentity(view);
    verify(
      JSON.stringify(initialTree) === JSON.stringify(finalTree),
      "Syntax tree changed after reversible edits",
    );
    results.syntax = finalTree;
    results.indexBeforeNavigation = structuredClone(
      (globalThis as any).editorSiblingIndexStats ?? null,
    );
    results.navigation = navigationIdentity(view);
    results.indexAfterNavigation = structuredClone(
      (globalThis as any).editorSiblingIndexStats ?? null,
    );
    results.sourceCharacters = test.source.length;
    results.renderedLines = parent.querySelectorAll(".cm-line").length;
    results.visibleRanges = view.visibleRanges;
    results.capabilities = {
      requestIdleCallback: typeof requestIdleCallback === "function",
      isInputPending:
        typeof (navigator as Navigator & { scheduling?: { isInputPending?: () => boolean } })
          .scheduling?.isInputPending === "function",
    };
    return results;
  } finally {
    meter = undefined;
    editor?.destroy();
    await task();
    verify(parent.childElementCount === 0, "Editor DOM survived disposal");
  }
}

Object.assign(globalThis, { runEditor });
