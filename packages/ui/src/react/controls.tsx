import { memo, useRef, type ReactNode } from "react";
import type { ProjectSession, ProjectView } from "@yongsk0066/reploom";
import type { PlaygroundLabels } from "./labels.ts";
import { useProject } from "./use-project.ts";

import type { PlaygroundView } from "@yongsk0066/reploom/share";

export type { PlaygroundView } from "@yongsk0066/reploom/share";

import { ControlIcon, DisplaySettings } from "./DisplaySettings.tsx";
import type { DisplayPreferences } from "./preferences.ts";
import { ShareProject } from "./ShareProject.tsx";

const initializedOf = (view: ProjectView) => view.initialized;

export const ResetSource = memo(function ResetSource({
  session,
  title,
  id,
  labels,
}: {
  session: ProjectSession;
  title: string;
  id: string;
  labels: PlaygroundLabels;
}) {
  const initialized = useProject(session, initializedOf);
  const dialog = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button
        type="button"
        aria-label={`${title} ${labels.reset}`}
        disabled={!initialized}
        onClick={() => dialog.current!.showModal()}
      >
        {labels.reset}
      </button>
      <dialog
        ref={dialog}
        className="reploom-reset-dialog"
        aria-labelledby={`${id}-reset-title`}
        aria-describedby={`${id}-reset-description`}
      >
        <h2 className="reploom-dialog-title" id={`${id}-reset-title`}>
          {labels.reset}
        </h2>
        <p id={`${id}-reset-description`}>{labels.resetDescription}</p>
        <form method="dialog">
          <button autoFocus type="submit">
            {labels.cancel}
          </button>
          <button type="submit" onClick={() => session.reset()}>
            {labels.confirmReset}
          </button>
        </form>
      </dialog>
    </>
  );
});

type ToolbarLayoutProps = {
  id?: string;
  labels: PlaygroundLabels;
  view?: PlaygroundView;
  setView?(view: PlaygroundView): void;
  expanded?: boolean;
  setExpanded?(expanded: boolean): void;
  children: ReactNode;
};

export function ToolbarLayout({
  id,
  labels,
  view,
  setView,
  expanded = false,
  setExpanded,
  children,
}: ToolbarLayoutProps) {
  const panes = id ? id + "-editor " + id + "-preview" : undefined;
  return (
    <div className="reploom-toolbar" inert={!id}>
      <div className="reploom-view-controls" role="group" aria-label={labels.view}>
        {(["code", "preview", "split"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={view === mode}
            aria-controls={panes}
            onClick={() => setView?.(mode)}
          >
            {labels[mode]}
          </button>
        ))}
      </div>
      <div className="reploom-actions">
        <button
          type="button"
          className="reploom-icon-button"
          title={expanded ? labels.collapse : labels.expand}
          aria-label={expanded ? labels.collapse : labels.expand}
          aria-expanded={expanded}
          aria-controls={panes}
          onClick={() => setExpanded?.(!expanded)}
        >
          <ControlIcon name={expanded ? "collapse" : "expand"} />
          <span className="reploom-wide-label">{expanded ? labels.collapse : labels.expand}</span>
        </button>
        {children}
      </div>
    </div>
  );
}

export function ViewControls({
  view,
  expanded,
  setView,
  setExpanded,
  session,
  id,
  preferences,
  onPreferences,
  labels,
  shareTarget,
}: {
  preferences: DisplayPreferences;
  onPreferences(value: DisplayPreferences): void;
  shareTarget?: string;
  view: PlaygroundView;
  expanded: boolean;
  setView(view: PlaygroundView): void;
  setExpanded(expanded: boolean): void;
  session: ProjectSession;
  id: string;
  labels: PlaygroundLabels;
}) {
  return (
    <ToolbarLayout {...{ id, labels, view, setView, expanded, setExpanded }}>
      {shareTarget && (
        <ShareProject session={session} view={view} target={shareTarget} labels={labels} />
      )}
      <DisplaySettings id={id} labels={labels} value={preferences} onChange={onPreferences} />
    </ToolbarLayout>
  );
}
