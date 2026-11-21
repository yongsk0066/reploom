import { memo, useCallback, useEffect, useId, useRef, useState } from "react";
import { ProjectSession, type ProjectView, type ProjectArchive } from "@yongsk0066/reploom";
import type { BrowserPlatform } from "@yongsk0066/reploom/browser";
import { EditorPane, PreviewPane } from "./panels.tsx";
import { ViewControls, ResetSource, type PlaygroundView } from "./controls.tsx";
import { useProject } from "./use-project.ts";
import { ShadowSurface } from "./ShadowSurface.tsx";
import type { EditorOptions } from "../codemirror/editor.ts";
import { ProjectTools } from "./ProjectTools.tsx";
import { useLabels } from "./use-labels.ts";
import { type PlaygroundLabels } from "./labels.ts";

import type { PreparedSource } from "../reader/prepare.ts";
import {
  FeedbackBar,
  LoadingSurface,
  WorkspaceLayout,
  type Theme,
  type MobileView,
  type SourceLines,
} from "./workspace-layout.tsx";
import { useDisplayPreferences, useNarrowLayout } from "./preferences.ts";

type UIProps = {
  session: ProjectSession;
  id: string;
  labels: PlaygroundLabels;
};

const phaseOf = (v: ProjectView) => v.state.phase;
const stateOf = (v: ProjectView) => v.state;
const runtimeOf = (v: ProjectView) => v.snapshot?.program.runtime ?? "react";
const omittedOf = (v: ProjectView) => v.omittedLogs;
const logsOf = (v: ProjectView) => v.logs;

const Status = memo(function Status({
  session,
  id,
  labels,
  reveal,
  title,
}: UIProps & { title: string; reveal: ProjectSession["reveal"] }) {
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
      <FeedbackBar status={labels.status(state)}>
        <UsageHelp session={session} id={id} labels={labels} />
        <ResetSource session={session} title={title} id={id} labels={labels} />
      </FeedbackBar>
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
                <button type="button" onClick={() => reveal(error)}>
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
  const omitted = useProject(session, omittedOf);
  return logs.length || omitted ? (
    <details className="reploom-console">
      <summary>{labels.console(logs.length)}</summary>
      {omitted > 0 && <p>{labels.omitted(omitted)}</p>}
      <pre>{logs.join("\n")}</pre>
      <button type="button" onClick={() => session.clearLogs()}>
        {labels.clearConsole}
      </button>
    </details>
  ) : null;
});

export type PlaygroundProps = {
  preparedSource?: PreparedSource;
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
  mobileView?: MobileView;
  theme?: Theme;
  locale?: string;
  previewLanguage?: string;
  highlightLines?: SourceLines;
  defaultFile?: string;
  initialArchive?: ProjectArchive;
  shareTarget?: string;
};

// Effects own resources, including React's development setup/cleanup/setup cycle.
// Rendering never starts a session or retains a discarded render's resources.
export default function Playground(props: PlaygroundProps) {
  const { project, platform } = props;
  const opening = useRef({ active: props.defaultFile, archive: props.initialArchive });
  opening.current = { active: props.defaultFile, archive: props.initialArchive };
  const labels = useLabels(props.locale, props.labels);

  const [owner, setOwner] = useState<{
    project: string;
    platform: BrowserPlatform;
    session: ProjectSession;
  } | null>(null);

  useEffect(() => {
    const session = new ProjectSession(project, platform.services);
    setOwner({ project, platform, session });
    void session.start(opening.current);
    return () => session.dispose();
  }, [project, platform]);

  const loading = (
    <LoadingSurface
      {...props}
      labels={labels}
      preparedSource={props.initialArchive ? undefined : props.preparedSource}
    />
  );

  return (
    <ShadowSurface fallback={loading}>
      {owner?.project === project && owner.platform === platform ? (
        <ProjectUI
          key={owner.session.projectId}
          {...props}
          labels={labels}
          session={owner.session}
        />
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
  defaultView,
  mobileView = "code",
  theme = "auto",
  locale,
  previewLanguage,
  highlightLines,
  shareTarget,
  preparedSource,
  initialArchive,
}: PlaygroundProps & { session: ProjectSession; labels: PlaygroundLabels }) {
  const id = useId();
  const host = useRef<HTMLElement>(null);

  const phase = useProject(session, phaseOf);
  const [chosenView, setView] = useState(defaultView);
  const narrow = useNarrowLayout(host);
  const view = chosenView ?? (narrow ? mobileView : "split");
  const [preferences, setPreferences] = useDisplayPreferences();
  const [expanded, setExpanded] = useState(false);

  const reveal = useCallback<ProjectSession["reveal"]>(
    (diagnostic) => {
      if (!session.reveal(diagnostic)) return false;
      if (view === "preview") setView("code");
      return true;
    },
    [session, view],
  );

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
      data-view={chosenView ?? "auto"}
      data-mobile-view={mobileView}
      lang={locale}
      data-theme={preferences.theme === "site" ? theme : preferences.theme}
      data-size={preferences.fontSize}
      data-wrap={preferences.wrap}
      data-expanded={expanded}
    >
      <WorkspaceLayout
        title={title}
        showTitle={showTitle}
        toolbar={
          <ViewControls
            session={session}
            id={id}
            labels={labels}
            view={view}
            setView={setView}
            expanded={expanded}
            setExpanded={setExpanded}
            shareTarget={shareTarget}
            preferences={preferences}
            onPreferences={setPreferences}
          />
        }
        editor={
          <EditorPane
            session={session}
            id={id}
            activation={editorActivation}
            compilerActivation={compilerActivation}
            preparedSource={initialArchive ? undefined : preparedSource}
            editorOptions={editorOptions}
            showTools={showTools}
            preferences={preferences}
            narrow={narrow}
            highlightLines={highlightLines}
            labels={labels}
          />
        }
        preview={
          <PreviewPane
            session={session}
            title={title}
            id={id}
            platform={platform}
            language={previewLanguage ?? locale}
            labels={labels}
          />
        }
      >
        <Status session={session} id={id} labels={labels} reveal={reveal} title={title} />
        {showTools && <ProjectTools session={session} labels={labels} reveal={reveal} />}
        <Console session={session} labels={labels} />
      </WorkspaceLayout>
    </section>
  );
}
