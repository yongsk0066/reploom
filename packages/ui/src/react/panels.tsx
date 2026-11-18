import { memo, useEffect, useRef, type KeyboardEvent } from "react";
import type { ProjectSession, ProjectView } from "@yongsk0066/reploom";
import type { BrowserPlatform } from "@yongsk0066/reploom/browser";
import type { EditorOptions } from "../codemirror/editor.ts";
import type { PlaygroundLabels } from "./labels.ts";
import CodeEditor from "./CodeEditor.tsx";
import PreviewFrame from "./PreviewFrame.tsx";
import { shallow, useProject } from "./use-project.ts";

import type { PreparedSource } from "../reader/prepare.ts";
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
});

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
}: PanelProps & {
  activation: "eager" | "interaction";
  compilerActivation: "edit" | "interaction";
  editorOptions?: EditorOptions;
  preparedSource?: PreparedSource;
}) {
  const view = useProject(session, editorOf, shallow);
  const paths = Object.keys(view.files);

  return (
    <div className="reploom-editor" part="editor" id={`${id}-editor`}>
      <FileTabs
        paths={paths}
        active={view.active}
        id={id}
        label={labels.files}
        select={(path) => session.select(path)}
      />
      <div
        id={`${id}-source`}
        role="tabpanel"
        aria-labelledby={`${id}-tab-${paths.indexOf(view.active)}`}
      >
        <span className="reploom-sr-only" id={`${id}-source-label`}>
          {labels.source(view.active)}
        </span>
        {!view.initialized && preparedSource && <PreparedSourceView source={preparedSource} />}
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
            activation={activation}
            labels={labels}
            describedBy={`${id}-hint${view.errors ? ` ${id}-errors` : ""}`}
            onIntent={
              compilerActivation === "interaction"
                ? () => {
                    void session.prepare();
                  }
                : undefined
            }
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
}: PanelProps & { title: string; platform: BrowserPlatform }) {
  const snapshot = useProject(session, snapshotOf);

  return (
    <div className="reploom-preview" part="preview" id={`${id}-preview`}>
      <div className="reploom-preview-bar">
        <span className="reploom-preview-label">{labels.preview}</span>
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
          connectArtifacts={platform.connectCompilerPreview}
        />
      ) : (
        <p className="reploom-preview-loading">{labels.loading}</p>
      )}
    </div>
  );
});
