import { documentChange } from "./document-change.ts";
import { Compartment, EditorSelection, EditorState, Text, Transaction } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  bracketMatching,
  indentOnInput,
  forceParsing,
  LanguageSupport,
} from "@codemirror/language";
import { autoCloseTags, jsxLanguage, tsxLanguage } from "@codemirror/lang-javascript";
import { cssLanguage } from "@codemirror/lang-css";
import { json } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";
import type { SourceFiles, SourceText } from "@yongsk0066/reploom";
import { createLanguageAnalysis, type LanguageAnalysisOptions } from "./language/client.ts";

export type EditorOptions = { language?: LanguageAnalysisOptions | false };

type Document = {
  state: EditorState;
  text: SourceText;
  top: number;
  left: number;
};

const editorText = (source: SourceText) => (source instanceof Text ? source : source.toString());

function replaceText(state: EditorState, source: SourceText) {
  const text = editorText(source);
  return state.update({
    changes: documentChange(state.doc, typeof text === "string" ? state.toText(text) : text),
    annotations: Transaction.addToHistory.of(false),
  });
}

function sameAttributes(a: Record<string, string>, b: Record<string, string>) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

// A whole-document paste often changes just a few tokens. Keep the unchanged
// prefix/suffix in CodeMirror's persistent text tree so its parser and undo
// history can reuse them. This is still one ordinary, undoable paste action.
function pasteDocument(event: ClipboardEvent, view: EditorView) {
  const { state } = view;
  const selection = state.selection;

  if (
    view.composing ||
    selection.ranges.length !== 1 ||
    selection.main.empty ||
    selection.main.from !== 0 ||
    selection.main.to !== state.doc.length ||
    !event.clipboardData?.types.includes("text/plain")
  )
    return false;
  if (state.readOnly) return true;
  let input = event.clipboardData.getData("text/plain");
  for (const filter of state.facet(EditorView.clipboardInputFilter)) input = filter(input, state);

  const inserted = state.toText(input);
  view.dispatch({
    changes: documentChange(state.doc, inserted),
    selection: EditorSelection.cursor(inserted.length, -1),
    userEvent: "input.paste",
    scrollIntoView: true,
  });
  return true;
}

export function createEditor(
  parent: HTMLElement,
  changed: (
    path: string,
    text: SourceText,
    composing: boolean,
    edits?: readonly import("@yongsk0066/reploom").TextEdit[],
  ) => void,
  options: EditorOptions = {},
) {
  const analysis =
    options.language === false
      ? undefined
      : createLanguageAnalysis(options.language, (path, document) => {
          if (view && current === path && view.state.doc === document)
            forceParsing(view, document.length, 1);
        });

  const documents = new Map<string, Document>();
  const attributes = new Compartment();
  let current = "";
  let currentText: SourceText = "";
  let lastAttributes: Record<string, string> = {};
  let applying = false;
  let destroyed = false;

  const kind = (path: string) =>
    path.endsWith(".css")
      ? "css"
      : path.endsWith(".json")
        ? "json"
        : /\.tsx?$/.test(path)
          ? "tsx"
          : "jsx";

  const language = (path: string) => {
    const standard = path.endsWith(".css")
      ? new LanguageSupport(cssLanguage)
      : path.endsWith(".json")
        ? json()
        : new LanguageSupport(/\.tsx?$/.test(path) ? tsxLanguage : jsxLanguage, autoCloseTags);

    return analysis?.support(path, kind(path), standard) ?? standard;
  };

  const extension = (path: string) => [
    lineNumbers(),
    highlightActiveLineGutter(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    oneDark,
    language(path),
    attributes.of(
      EditorView.contentAttributes.of({
        "aria-label": `${path} code`,
        spellcheck: "false",
      }),
    ),
    EditorView.updateListener.of((update) => {
      analysis?.update(path, kind(path), update);
      if (!applying && update.docChanged) {
        currentText = update.state.doc;
        const edits: import("@yongsk0066/reploom").TextEdit[] = [];
        update.changes.iterChanges((from, to, _from, _to, insert) =>
          edits.push({ from, to, insert: insert.toString() }),
        );
        changed(current, currentText, update.view.composing, edits);
      }
    }),
    EditorView.domEventHandlers({
      paste: pasteDocument,
      compositionend(_event, _view) {
        queueMicrotask(() => {
          if (!destroyed) changed(current, currentText, false);
        });
      },
    }),
  ];

  let view: EditorView | undefined = new EditorView({ parent });
  return {
    sync(files: SourceFiles, active: string, attrs: Record<string, string>, reset: boolean) {
      if (!view) return;
      applying = true;
      try {
        analysis?.activate(active);
        const activeText = files[active] ?? "";
        for (const path of documents.keys())
          if (!Object.hasOwn(files, path)) documents.delete(path);
        const switching = current !== active;
        if (switching && current && Object.hasOwn(files, current) && !reset)
          documents.set(current, {
            state: view.state,
            text: currentText,
            top: view.scrollDOM.scrollTop,
            left: view.scrollDOM.scrollLeft,
          });
        if (reset) {
          documents.clear();
        }
        if (switching || reset) {
          const doc = documents.get(active) ?? {
            state: EditorState.create({
              doc: editorText(activeText),
              extensions: extension(active),
            }),
            text: activeText,
            top: 0,
            left: 0,
          };

          if (doc.text !== activeText) doc.state = replaceText(doc.state, activeText).state;
          view.setState(doc.state);
          view.scrollDOM.scrollTop = doc.top;
          view.scrollDOM.scrollLeft = doc.left;
          documents.delete(active);
        } else if (currentText !== activeText) {
          view.update([replaceText(view.state, activeText)]);
        }
        current = active;
        currentText = activeText;

        const nextAttributes = {
          "aria-label": `${active} code`,
          spellcheck: "false",
          autocapitalize: "off",
          ...attrs,
        };

        if (switching || reset || !sameAttributes(nextAttributes, lastAttributes)) {
          view.dispatch({
            effects: attributes.reconfigure(EditorView.contentAttributes.of(nextAttributes)),
          });
          lastAttributes = nextAttributes;
        }
      } finally {
        applying = false;
      }
    },
    reveal(line: number, column: number) {
      if (!view) return;
      const target = view.state.doc.line(Math.min(view.state.doc.lines, Math.max(1, line)));
      const position = Math.min(target.to, target.from + Math.max(0, column));
      view.dispatch({ selection: EditorSelection.cursor(position), scrollIntoView: true });
      view.focus();
    },
    destroy() {
      destroyed = true;
      analysis?.dispose();
      documents.clear();
      current = currentText = "";
      lastAttributes = {};
      if (view) {
        // A browser may retain a retired View in compiled code. Drop its document,
        // history and syntax payload through the public state API before teardown.
        try {
          view.setState(EditorState.create());
        } finally {
          view.destroy();
          view = undefined;
        }
      }
    },
  };
}
