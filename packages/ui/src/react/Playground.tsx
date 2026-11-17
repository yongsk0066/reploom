import { memo, useEffect, useId, useMemo, useRef, useSyncExternalStore, useState } from "react";
import { ProjectSession, type ProjectView } from "@yongsk0066/reploom";
import type { BrowserPlatform } from "@yongsk0066/reploom/browser";
import PreviewFrame from "./PreviewFrame.tsx";
import CodeEditor from "./CodeEditor.tsx";
import type { EditorOptions } from "../codemirror/editor.ts";
import { ProjectTools } from "./ProjectTools.tsx";
import { defaultLabels, type PlaygroundLabels } from "./labels.ts";

type UIProps = {
  editorOptions?: EditorOptions;
  session: ProjectSession;
  platform: BrowserPlatform;
  title: string;
  id: string;
  activation: "eager" | "interaction";
  compilerActivation: "edit" | "interaction";
  labels: PlaygroundLabels;
};

function useProject<T>(
  session: ProjectSession,
  select: (view: ProjectView) => T,
  equal?: (a: T, b: T) => boolean,
) {
  const store = useMemo(() => session.observe(select, equal), [session, select, equal]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
}

const phaseOf = (v: ProjectView) => v.state.phase;
const stateOf = (v: ProjectView) => v.state;
const snapshotOf = (v: ProjectView) => v.snapshot;
const initializedOf = (v: ProjectView) => v.initialized;
const logsOf = (v: ProjectView) => v.logs;

const editorOf = (v: ProjectView) => ({
  files: v.files,
  active: v.active,
  reset: v.editorReset,
  selection: v.selection,
  initialized: v.initialized,
  invalid: v.state.phase === "error" && v.state.diagnostics.some((e) => e.file?.endsWith(v.active)),
  errors: v.state.phase === "error",
});

const shallow = <T extends Record<string, unknown>>(a: T, b: T) =>
  Object.keys(a).every((k) => a[k] === b[k]);

const Actions = memo(function Actions({
  session,
  title,
  labels,
}: Pick<UIProps, "session" | "title" | "labels">) {
  const initialized = useProject(session, initializedOf);
  return (
    <div className="reploom-actions">
      <button
        type="button"
        aria-label={`${title} ${labels.rerun}`}
        disabled={!initialized}
        onClick={() => session.rerun()}
      >
        {labels.rerun}
      </button>
      <button
        type="button"
        aria-label={`${title} ${labels.reset}`}
        disabled={!initialized}
        onClick={() => session.reset()}
      >
        {labels.reset}
      </button>
    </div>
  );
});

const EditorPane = memo(function EditorPane({
  session,
  id,
  activation,
  compilerActivation,
  labels,
  editorOptions,
}: Pick<
  UIProps,
  "session" | "id" | "activation" | "compilerActivation" | "labels" | "editorOptions"
>) {
  const view = useProject(session, editorOf, shallow);
  return (
    <div className="reploom-editor">
      <div className="reploom-file-picker">
        <label htmlFor={`${id}-file`}>{labels.file}</label>
        <select
          id={`${id}-file`}
          value={view.active}
          disabled={!view.initialized}
          onChange={(e) => session.select(e.target.value)}
        >
          {Object.keys(view.files).map((path) => (
            <option key={path} value={path}>
              {path}
            </option>
          ))}
        </select>
      </div>
      <div className="reploom-source-label" id={`${id}-source-label`}>
        {labels.source(view.active)}
      </div>
      {view.initialized && (
        <CodeEditor
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
  );
});

const PreviewPane = memo(function PreviewPane({
  session,
  title,
  id,
  platform,
  labels,
}: Pick<UIProps, "session" | "title" | "id" | "platform" | "labels">) {
  const snapshot = useProject(session, snapshotOf);
  return (
    <div className="reploom-preview">
      <p className="reploom-preview-label">{labels.preview}</p>
      <p className="reploom-hint" id={`${id}-hint`}>
        {labels.hint(snapshot?.program.runtime ?? "react")}
      </p>
      {snapshot ? (
        <PreviewFrame
          session={session}
          snapshot={snapshot}
          title={`${title} ${labels.preview}`}
          onEvent={session.onEvent}
          connectArtifacts={platform.connectCompilerPreview}
        />
      ) : (
        <p className="reploom-loading">{labels.loading}</p>
      )}
    </div>
  );
});

const Status = memo(function Status({
  session,
  id,
  labels,
}: Pick<UIProps, "session" | "id" | "labels">) {
  const state = useProject(session, stateOf);

  const text =
    state.phase === "error"
      ? state.diagnostics
          .map(
            (e) => `${e.file || ""}${e.line ? `:${e.line}:${(e.column || 0) + 1}` : ""} ${e.text}`,
          )
          .join("\n")
      : "";

  return (
    <>
      <p className="reploom-status">{labels.status(state)}</p>
      <pre
        className="reploom-errors"
        id={`${id}-errors`}
        aria-live="polite"
        aria-atomic="true"
        hidden={!text}
      >
        {state.phase === "error" &&
          state.diagnostics.map((error, index) => (
            <span key={index}>
              {error.file && (
                <button type="button" onClick={() => session.reveal(error)}>
                  {error.file}:{error.line ?? 1}:{(error.column ?? 0) + 1}
                </button>
              )}{" "}
              {error.text}
              {"\n"}
            </span>
          ))}
      </pre>
    </>
  );
});

const Console = memo(function Console({ session, labels }: Pick<UIProps, "session" | "labels">) {
  const logs = useProject(session, logsOf);
  return logs.length ? (
    <details className="reploom-console">
      <summary>{labels.console(logs.length)}</summary>
      <pre>{logs.join("\n")}</pre>
    </details>
  ) : null;
});

export type PlaygroundProps = {
  editorOptions?: EditorOptions;
  project: string;
  platform: BrowserPlatform;
  title: string;
  editorActivation?: "eager" | "interaction";
  compilerActivation?: "edit" | "interaction";
  labels?: Partial<PlaygroundLabels>;
};

// Effects own resources, including React's development setup/cleanup/setup cycle.
// Rendering never starts a session or retains a discarded render's resources.
export default function Playground(props: PlaygroundProps) {
  const { project, platform } = props;
  const labels = useMemo(() => ({ ...defaultLabels, ...props.labels }), [props.labels]);

  const [owner, setOwner] = useState<{
    project: string;
    platform: BrowserPlatform;
    session: ProjectSession;
  } | null>(null);

  useEffect(() => {
    const session = new ProjectSession(project, platform.services);
    setOwner({ project, platform, session });
    void session.start();
    return () => session.dispose();
  }, [project, platform]);
  return owner?.project === project && owner.platform === platform ? (
    <ProjectUI {...props} labels={labels} session={owner.session} />
  ) : (
    <article className="reploom" data-project={project} data-phase="loading">
      {labels.loading}
    </article>
  );
}

function ProjectUI({
  project,
  title,
  platform,
  session,
  editorActivation = "eager",
  compilerActivation = "edit",
  editorOptions,
  labels,
}: PlaygroundProps & { session: ProjectSession; labels: PlaygroundLabels }) {
  const id = useId();
  const host = useRef<HTMLElement>(null);

  const phase = useProject(session, phaseOf);
  useEffect(() => {
    const element = host.current!;
    let visible = true;

    const priority = () =>
      session.setPriority(
        document.hidden || !visible
          ? "background"
          : element.contains(document.activeElement)
            ? "focused"
            : "visible",
      );

    const observer = new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting;
      priority();
    });

    observer.observe(element);
    document.addEventListener("visibilitychange", priority);
    element.addEventListener("focusin", priority);
    element.addEventListener("focusout", priority);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", priority);
      element.removeEventListener("focusin", priority);
      element.removeEventListener("focusout", priority);
    };
  }, [session]);
  return (
    <article ref={host} className="reploom" data-project={project} data-phase={phase}>
      <header className="reploom-heading">
        <h2>{title}</h2>
        <Actions session={session} title={title} labels={labels} />
      </header>
      <div className="reploom-panes">
        <EditorPane
          session={session}
          id={id}
          activation={editorActivation}
          compilerActivation={compilerActivation}
          editorOptions={editorOptions}
          labels={labels}
        />
        <PreviewPane session={session} title={title} id={id} platform={platform} labels={labels} />
      </div>
      <Status session={session} id={id} labels={labels} />
      <ProjectTools session={session} labels={labels} />
      <Console session={session} labels={labels} />
    </article>
  );
}
