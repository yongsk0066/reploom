import { createEditor } from "@yongsk0066/reploom-ui/codemirror";

const NativeWorker = Worker;
const workers = [];
globalThis.Worker = class extends NativeWorker {
  constructor(url, options) {
    super(url, options);
    const observation = { name: options?.name, replies: 0, terminated: false };
    workers.push(observation);
    this.addEventListener("message", ({ data }) => {
      if (data.type === "tree") observation.replies++;
    });
    const terminate = this.terminate.bind(this);
    this.terminate = () => {
      observation.terminated = true;
      terminate();
    };
  }
};

const path = "/main.tsx";
let files = { [path]: 'export const example = <div title="한글😀">12345</div>;' };
let changes = 0;

const editor = createEditor(
  document.getElementById("editor"),
  (path, source) => {
    changes++;
    files = { ...files, [path]: source };
    editor.sync(files, path, {}, false);
  },
  { language: { minCharacters: 1 } },
);

editor.sync(files, path, {}, false);
Object.assign(globalThis, {
  inspectEditor: () => ({ workers, changes, source: files[path].toString() }),
  disposeEditor: () => editor.destroy(),
});
