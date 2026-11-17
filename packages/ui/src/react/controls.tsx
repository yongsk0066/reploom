import { memo, useRef } from "react";
import type { ProjectSession, ProjectView } from "@yongsk0066/reploom";
import type { PlaygroundLabels } from "./labels.ts";
import { useProject } from "./use-project.ts";

export type PlaygroundView = "split" | "code" | "preview";

const initializedOf = (view: ProjectView) => view.initialized;

const ResetSource = memo(function ResetSource({
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

export function ViewControls({
  view,
  expanded,
  setView,
  setExpanded,
  session,
  id,
  title,
  labels,
}: {
  view: PlaygroundView;
  expanded: boolean;
  setView(view: PlaygroundView): void;
  setExpanded(expanded: boolean): void;
  session: ProjectSession;
  id: string;
  title: string;
  labels: PlaygroundLabels;
}) {
  return (
    <div className="reploom-toolbar">
      <div className="reploom-view-controls" role="group" aria-label={labels.view}>
        {(["code", "preview", "split"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={view === mode}
            aria-controls={`${id}-editor ${id}-preview`}
            onClick={() => setView(mode)}
          >
            {labels[mode]}
          </button>
        ))}
      </div>
      <div className="reploom-actions">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={`${id}-panes`}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? labels.collapse : labels.expand}
        </button>
        <ResetSource session={session} title={title} id={id} labels={labels} />
      </div>
    </div>
  );
}
