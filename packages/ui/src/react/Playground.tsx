import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ProjectSession, type ProjectView } from "@yongsk0066/reploom";
import type { BrowserPlatform } from "@yongsk0066/reploom/browser";
import { EditorPane, PreviewPane } from "./panels.tsx";
import { ViewControls, type PlaygroundView } from "./controls.tsx";
import { useProject } from "./use-project.ts";
import { ShadowSurface } from "./ShadowSurface.tsx";
import type { EditorOptions } from "../codemirror/editor.ts";
import { ProjectTools } from "./ProjectTools.tsx";
import { defaultLabels, type PlaygroundLabels } from "./labels.ts";

type UIProps = {
  session: ProjectSession;
  id: string;
  labels: PlaygroundLabels;
};

const phaseOf = (v: ProjectView) => v.state.phase;
const stateOf = (v: ProjectView) => v.state;
const runtimeOf = (v: ProjectView) => v.snapshot?.program.runtime ?? "react";
const logsOf = (v: ProjectView) => v.logs;

const Status = memo(function Status({ session, id, labels, reveal }: UIProps & { reveal(): void }) {
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
      <div className="reploom-feedback">
        <p className="reploom-status">{labels.status(state)}</p>
        <UsageHelp session={session} id={id} labels={labels} />
      </div>
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
                <button
                  type="button"
                  onClick={() => {
                    reveal();
                    session.reveal(error);
                  }}
                >
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

const UsageHelp = memo(function UsageHelp({ session, id, labels }: UIProps) {
  const runtime = useProject(session, runtimeOf);
  return (
    <details className="reploom-help">
      <summary>{labels.help}</summary>
      <p className="reploom-hint" id={`${id}-hint`}>
        {labels.hint(runtime)}
      </p>
    </details>
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
  showTitle?: boolean;
  showTools?: boolean;
  defaultView?: PlaygroundView;
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

  const loading = (
    <section
      className="reploom reploom-loading"
      aria-label={props.title}
      data-project={project}
      data-phase="loading"
    >
      {labels.loading}
    </section>
  );

  return (
    <ShadowSurface fallback={loading}>
      {owner?.project === project && owner.platform === platform ? (
        <ProjectUI {...props} labels={labels} session={owner.session} />
      ) : (
        loading
      )}
    </ShadowSurface>
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
  showTitle = true,
  showTools = true,
  defaultView = "split",
}: PlaygroundProps & { session: ProjectSession; labels: PlaygroundLabels }) {
  const id = useId();
  const host = useRef<HTMLElement>(null);

  const phase = useProject(session, phaseOf);
  const [view, setView] = useState<PlaygroundView>(defaultView);
  const [expanded, setExpanded] = useState(false);
  const reveal = useCallback(() => setView("code"), []);
  useEffect(() => {
    const element = host.current!;
    const document = element.ownerDocument;
    const root = element.getRootNode() as Document | ShadowRoot;
    let visible = true;

    const priority = () =>
      session.setPriority(
        document.hidden || !visible
          ? "background"
          : element.contains(root.activeElement)
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
    <section
      ref={host}
      className="reploom"
      part="surface"
      aria-label={title}
      data-project={project}
      data-phase={phase}
      data-view={view}
      data-expanded={expanded}
    >
      {showTitle && (
        <div className="reploom-heading">
          <h2>{title}</h2>
        </div>
      )}
      <div className="reploom-panes" id={`${id}-panes`}>
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
      <ViewControls
        session={session}
        id={id}
        title={title}
        labels={labels}
        view={view}
        setView={setView}
        expanded={expanded}
        setExpanded={setExpanded}
      />
      <Status session={session} id={id} labels={labels} reveal={reveal} />
      {showTools && <ProjectTools session={session} labels={labels} />}
      <Console session={session} labels={labels} />
    </section>
  );
}
