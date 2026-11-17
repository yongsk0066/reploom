import {
  createEditor,
  type EditorOptions,
  type LanguageAnalysisOptions,
} from "@yongsk0066/reploom-ui/codemirror";
import { ProjectSession, defineProject, type ScriptSource } from "@yongsk0066/reploom";
import { createBrowserPlatform, type BrowserPlatformOptions } from "@yongsk0066/reploom/browser";

const language: LanguageAnalysisOptions = { minCharacters: 1000, onError: console.error };
const editor: EditorOptions = { language };
const browser: BrowserPlatformOptions = { manifestUrl: "/assets/manifest.json" };

const project = defineProject({
  id: "types",
  title: "Consumer types",
  runtime: "dom",
  entry: "/main.ts",
  files: { "/main.ts": "export function mount() {}" },
});

export function mount(root: HTMLElement, vendor: ScriptSource) {
  const platform = createBrowserPlatform(browser);
  const session = new ProjectSession(project.id, platform.services);
  return {
    session,
    vendor,
    editor: createEditor(root, (...args) => session.change(...args), editor),
  };
}
