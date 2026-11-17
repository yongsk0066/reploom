import { EditorView } from "@codemirror/view";
import { forceParsing, syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import { createEditor } from "../../packages/ui/src/codemirror/editor.ts";
import { source } from "@yongsk0066/reploom-ui/language-worker";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let editor: ReturnType<typeof createEditor> | undefined;
let view: EditorView | undefined;
let created = 0;
let retired = 0;
let edits = 0;
const position = "const value_0=".length;
const tracking = new URLSearchParams(location.search).has("gc");
const references: { kind: string; at: number; value: WeakRef<object> }[] = [];

function track() {
  if (!tracking || !view) return;
  for (const [kind, value] of Object.entries({
    view,
    doc: view.state.doc,
    tree: syntaxTree(view.state),
  }))
    references.push({ kind, at: edits, value: new WeakRef(value) });
}

async function parsed() {
  const deadline = performance.now() + 10000;
  while (view && !syntaxTreeAvailable(view.state, view.state.doc.length)) {
    forceParsing(view, view.state.doc.length, 2);
    if (performance.now() > deadline) throw Error("Syntax timeout");
    await pause(5);
  }
}

const memoryCase = {
  async mount() {
    editor = createEditor(document.querySelector("#editor")!, () => {}, {
      language: {
        idleMs: 1500,
        createWorker() {
          const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
          const worker = new Worker(url, { name: "reploom-language" });
          URL.revokeObjectURL(url);
          created++;
          const terminate = worker.terminate.bind(worker);
          worker.terminate = () => {
            retired++;
            terminate();
          };
          return worker;
        },
        onError(error) {
          throw error;
        },
      },
    });
    const text = Array.from({ length: 38000 }, (_, i) => `const value_${i}=12345;`).join("\n");
    editor.sync({ "/main.js": text }, "/main.js", {}, false);
    view = EditorView.findFromDOM(document.querySelector(".cm-editor")!);
    await parsed();
    track();
    return { characters: view!.state.doc.length, created, retired };
  },
  async batch() {
    const start = performance.now();
    const sync: number[] = [];
    for (let i = 0; i < 100; i++) {
      const mark = performance.now();
      const insert = ++edits % 2 ? "2" : "1";
      view!.dispatch({
        changes: { from: position, to: position + 1, insert },
        userEvent: "input.type",
      });
      sync.push(performance.now() - mark);
      await parsed();
      if (view!.state.doc.sliceString(position, position + 1) !== insert) throw Error("Text drift");
    }
    track();
    return { edits, ms: performance.now() - start, sync, created, retired };
  },
  async idle() {
    const deadline = performance.now() + 5000;
    while (created !== retired) {
      if (performance.now() > deadline) throw Error("Worker did not retire");
      await pause(25);
    }
    return { created, retired };
  },
  destroy() {
    editor?.destroy();
    editor = view = undefined;
    return { created, retired, views: document.querySelectorAll(".cm-editor").length };
  },
  retained() {
    return references.map(({ kind, at, value }) => ({ kind, at, alive: !!value.deref() }));
  },
};

Object.assign(globalThis, { memoryCase });
