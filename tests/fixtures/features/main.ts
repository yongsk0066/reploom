import { ProjectSession } from "@yongsk0066/reploom";
import { createBrowserPlatform, attachPreview } from "@yongsk0066/reploom/browser";
import { createEditor } from "@yongsk0066/reploom-ui/codemirror";

const parameters = new URLSearchParams(location.search);
const workers: Array<Worker & { name: string; retired: boolean }> = [];
const NativeWorker = globalThis.Worker;
globalThis.Worker = class extends NativeWorker {
  retired = false;
  name: string;
  replies: Array<{ memoryBytes: number }> = [];
  languageReplies: Array<{ revision: number; records: number; bytes: number }> = [];
  languageRequests: Array<{ base: number; source: number; edits: number }> = [];

  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    this.name = options?.name ?? "";
    workers.push(this);
    this.addEventListener("message", ({ data }) => {
      if (data?.memoryBytes) this.replies.push({ memoryBytes: data.memoryBytes });
      if (this.name === "reploom-language" && data?.type === "tree")
        this.languageReplies.push({
          revision: data.revision,
          records: data.records.length,
          bytes: data.records.reduce((n, record) => n + (record.buffer?.byteLength ?? 0), 0),
        });
    });
  }

  override terminate() {
    this.retired = true;
    super.terminate();
  }

  override postMessage(message: any, options: Transferable[] | StructuredSerializeOptions = []) {
    if (this.name === "reploom-language") {
      this.languageRequests.push({
        base: message.base,
        source: message.source?.length ?? 0,
        edits: message.edits?.reduce((n, edit) => n + edit.insert.length, 0) ?? 0,
      });
      if (message.base && (globalThis as any).faultLanguage) {
        (globalThis as any).faultLanguage = false;
        message = { ...message, base: 999999 };
      }
    }
    if (
      message?.type === "compile" &&
      message.baseRevision !== null &&
      (globalThis as any).faultSource
    ) {
      (globalThis as any).faultSource = false;
      message = { ...message, baseRevision: 999999 };
    }
    if (
      this.name === "reploom-typecheck" &&
      message?.type === "check" &&
      (globalThis as any).holdTypes
    )
      return;
    super.postMessage(message, options);
  }
};

const platform = createBrowserPlatform({
  manifestUrl: "/features/assets/manifest.json",
  typecheck: parameters.has("typeIdle")
    ? { idleMs: Number(parameters.get("typeIdle")) }
    : undefined,
  compilerLifetime: parameters.has("recycle") ? { maxMemoryBytes: 1, minLifetimeMs: 0 } : undefined,
});

const session = new ProjectSession(parameters.get("project") ?? "dom", platform.services);

const preview = attachPreview(
  session,
  document.getElementById("preview")!,
  "Feature preview",
  platform,
);

const editor = createEditor(
  document.getElementById("editor")!,
  (...args) => session.change(...args),
  {
    language: parameters.has("language")
      ? { minCharacters: 1, idleMs: Number(parameters.get("languageIdle") ?? 30000) }
      : undefined,
  },
);

let selection: string | undefined;
let reset = 0;
session.subscribe(() => {
  const view = session.getSnapshot();
  document.body.dataset.phase = view.state.phase;
  if (!view.initialized) return;
  editor.sync(
    view.files,
    view.active,
    { "aria-label": "Feature editor" },
    reset !== view.editorReset,
  );
  reset = view.editorReset;
  if (view.selection && selection !== view.selection.id) {
    selection = view.selection.id;
    editor.reveal(view.selection.line, view.selection.column);
  }
});
Object.assign(window, {
  session,
  editor,
  platform,
  ProjectSession,
  compilerWorkers: () => workers.filter((worker) => worker.name === "reploom-compiler"),
});
Object.assign(window, { ownedWorkers: workers });
await session.start();
addEventListener(
  "pagehide",
  () => {
    void preview.dispose(false);
    editor.destroy();
    session.dispose();
    platform.dispose();
  },
  { once: true },
);
