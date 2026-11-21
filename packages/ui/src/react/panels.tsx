import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ProjectSession, ProjectView } from "@yongsk0066/reploom";
import type { BrowserPlatform } from "@yongsk0066/reploom/browser";
import type { EditorOptions } from "../codemirror/editor.ts";
import type { PlaygroundLabels } from "./labels.ts";
import CodeEditor from "./CodeEditor.tsx";
import PreviewFrame from "./PreviewFrame.tsx";
import { shallow, useProject } from "./use-project.ts";

import type { PreparedSource } from "../reader/prepare.ts";
import type { DisplayPreferences } from "./preferences.ts";
import { FileMenu } from "./FileMenu.tsx";
import { ControlIcon } from "./DisplaySettings.tsx";
import { PreviewLoading, type SourceLines } from "./workspace-layout.tsx";
import { PreparedSourceView } from "./PreparedSourceView.tsx";

type PanelProps = {
  session: ProjectSession;
  id: string;
  labels: PlaygroundLabels;
};

const editorOf = (view: ProjectView) => ({
  files: view.files,
  active: view.active,
  reset: view.editorReset,
  selection: view.selection,
  initialized: view.initialized,
  invalid:
    view.state.phase === "error" &&
    view.state.diagnostics.some((e) => e.file?.endsWith(view.active)),
  errors: view.state.phase === "error",
  diagnostics: view.state.phase === "error" ? view.state.diagnostics : undefined,
  checks: view.checks,
  revision: view.revision,
});

const lastWorkingOf = (view: ProjectView) =>
  view.state.phase === "error" && view.state.stage === "compile" && !!view.snapshot;

const snapshotOf = (view: ProjectView) => view.snapshot;

function FileTabs({
  paths,
  active,
  id,
  label,
  select,
}: {
  paths: string[];
  active: string;
  id: string;
  label: string;
  select(path: string): void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const activeIndex = paths.indexOf(active);

  useEffect(() => {
    const list = host.current!;
    const tab = list.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!tab) return;
    const start = tab.offsetLeft;
    if (start < list.scrollLeft) list.scrollLeft = start;
    else if (start + tab.offsetWidth > list.scrollLeft + list.clientWidth)
      list.scrollLeft = start + tab.offsetWidth - list.clientWidth;
  }, [active, paths.length]);

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? paths.length - 1
          : event.key === "ArrowLeft"
            ? (activeIndex - 1 + paths.length) % paths.length
            : event.key === "ArrowRight"
              ? (activeIndex + 1) % paths.length
              : undefined;

    if (next === undefined || !paths.length) return;
    event.preventDefault();
    select(paths[next]);
    host
      .current!.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      [next].focus({ preventScroll: true });
  }

  return (
    <div
      ref={host}
      className="reploom-file-tabs"
      role="tablist"
      aria-label={label}
      dir="ltr"
      onKeyDown={navigate}
    >
      {paths.map((path, index) => {
        const name = path.slice(path.lastIndexOf("/") + 1);
        const duplicate = paths.some((other) => other !== path && other.endsWith(`/${name}`));
        return (
          <button
            key={path}
            id={`${id}-tab-${index}`}
            type="button"
            role="tab"
            aria-label={path}
            title={path}
            aria-selected={path === active}
            aria-controls={`${id}-source`}
            tabIndex={path === active ? 0 : -1}
            onClick={() => select(path)}
          >
            {duplicate ? path : name}
          </button>
        );
      })}
    </div>
  );
}

export const EditorPane = memo(function EditorPane({
  session,
  id,
  labels,
  activation,
  compilerActivation,
  editorOptions,
  preparedSource,
  preferences,
  narrow,
  highlightLines,
  showTools,
}: PanelProps & {
  activation: "eager" | "interaction";
  compilerActivation: "edit" | "interaction";
  editorOptions?: EditorOptions;
  preparedSource?: PreparedSource;
  preferences: DisplayPreferences;
  narrow: boolean;
  showTools: boolean;
  highlightLines?: SourceLines;
}) {
  const view = useProject(session, editorOf, shallow);
  const paths = Object.keys(view.files);
  const [editing, setEditing] = useState(activation !== "interaction");
  const [copyResult, setCopyResult] = useState("");

  const initial = useRef<{ file: string; text: (typeof view.files)[string] } | undefined>(
    undefined,
  );

  if (view.initialized && !initial.current)
    initial.current = { file: view.active, text: view.files[view.active] };

  const emphasis =
    initial.current?.file === view.active && initial.current.text === view.files[view.active]
      ? highlightLines
      : undefined;

  const diagnostics = useMemo(() => {
    const notes = [...(view.diagnostics ?? [])];
    for (const check of Object.values(view.checks ?? {}))
      if (check?.revision === view.revision) notes.push(...check.diagnostics);

    const current = notes.filter(
      (d) => d.file === view.active && (d.revision === undefined || d.revision === view.revision),
    );

    return current.length ? current : undefined;
  }, [view.diagnostics, view.checks, view.revision, view.active]);

  const numbers = preferences.numbers !== "off";
  const wrap = preferences.wrap === "on" || (preferences.wrap === "auto" && narrow);

  const display = useMemo(
    () => ({ numbers, wrap, themed: true, diagnostics, emphasis }),
    [numbers, wrap, diagnostics, emphasis],
  );

  useEffect(() => {
    if (view.selection) setEditing(true);
  }, [view.selection]);
  const activated = editing || !!view.selection;

  const prepare =
    compilerActivation === "interaction"
      ? () => {
          void session.prepare();
        }
      : undefined;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(view.files[view.active].toString());
      setCopyResult(labels.copied);
    } catch {
      setCopyResult(labels.copyFailed);
    }
  };

  return (
    <div className="reploom-editor" part="editor" id={`${id}-editor`}>
      <div className="reploom-file-bar">
        <div className="reploom-file-actions">
          {showTools && view.initialized && (
            <FileMenu session={session} active={view.active} labels={labels} id={id} />
          )}
          {!activated && view.initialized && (
            <button
              type="button"
              className="reploom-edit"
              onFocus={prepare}
              onPointerDown={prepare}
              onClick={() => setEditing(true)}
            >
              <ControlIcon name="edit" />
              <span>{labels.edit}</span>
            </button>
          )}
          <button
            type="button"
            disabled={!view.initialized}
            className="reploom-icon-button"
            aria-label={labels.copySource}
            title={labels.copySource}
            onClick={() => void copy()}
          >
            <ControlIcon name="copy" />
          </button>
          <span role="status" className="reploom-sr-only">
            {copyResult}
          </span>
        </div>
        <FileTabs
          paths={paths}
          active={view.active}
          id={id}
          label={labels.files}
          select={(path) => session.select(path)}
        />
      </div>
      <div
        id={`${id}-source`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-${paths.indexOf(view.active)}`}
      >
        <span className="reploom-sr-only" id={`${id}-source-label`}>
          {labels.source(view.active)}
        </span>
        {!view.initialized && (
          <div className="reploom-code-editor">
            {preparedSource && (
              <PreparedSourceView
                source={preparedSource}
                numbered={preferences.numbers === "always"}
                highlightLines={highlightLines}
              />
            )}
          </div>
        )}
        {view.initialized && (
          <CodeEditor
            preparedSource={preparedSource}
            options={editorOptions}
            files={view.files}
            active={view.active}
            resetKey={view.reset}
            selection={view.selection}
            labelId={`${id}-source-label`}
            invalid={view.invalid}
            activated={activated}
            focusOnEdit={editing && activation === "interaction"}
            display={display}
            numbered={preferences.numbers === "always"}
            labels={labels}
            describedBy={`${id}-hint${view.errors ? ` ${id}-errors` : ""}`}
            onIntent={prepare}
            onChange={(...args) => session.change(...args)}
          />
        )}
      </div>
    </div>
  );
});

export const PreviewPane = memo(function PreviewPane({
  session,
  title,
  id,
  platform,
  labels,
  language,
}: PanelProps & { title: string; platform: BrowserPlatform; language?: string }) {
  const snapshot = useProject(session, snapshotOf);
  const stale = useProject(session, lastWorkingOf);

  return (
    <div className="reploom-preview" part="preview" id={`${id}-preview`}>
      <div className="reploom-preview-bar">
        <span className="reploom-preview-label">{stale ? labels.lastWorking : labels.preview}</span>
        <button
          type="button"
          className="reploom-reload"
          title={labels.rerunHint}
          aria-label={`${title} ${labels.rerun}`}
          disabled={!snapshot}
          onClick={() => session.rerun()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 7v5h-5M19.5 12a7.5 7.5 0 1 0-2 5.1M20 12l-2.5-5" />
          </svg>
          <span>{labels.rerun}</span>
        </button>
      </div>
      {snapshot ? (
        <PreviewFrame
          session={session}
          snapshot={snapshot}
          title={`${title} ${labels.preview}`}
          onEvent={session.onEvent}
          language={language}
          compute={labels.compute}
          connectArtifacts={platform.connectCompilerPreview}
        />
      ) : (
        <PreviewLoading text={labels.loading} />
      )}
    </div>
  );
});
