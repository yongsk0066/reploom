import type { ReactNode } from "react";
import { ToolbarLayout, type PlaygroundView } from "./controls.tsx";
import { SettingsButton } from "./DisplaySettings.tsx";
import type { PlaygroundLabels } from "./labels.ts";
import { defaultLabels } from "./labels.ts";
import { PreparedSourceView } from "./PreparedSourceView.tsx";
import type { PreparedSource } from "../reader/prepare.ts";

export type Theme = "auto" | "light" | "dark";

export type MobileView = "code" | "preview";

export type SourceLines = readonly [first: number, last: number];

type LayoutProps = {
  title: string;
  project: string;
  showTitle?: boolean;
  showTools?: boolean;
  shareTarget?: string;
  defaultView?: PlaygroundView;
  mobileView?: MobileView;
  theme?: Theme;
  locale?: string;
  preparedSource?: PreparedSource;
  highlightLines?: SourceLines;
};

export function WorkspaceLayout({
  title,
  showTitle = true,
  toolbar,
  editor,
  preview,
  children,
}: {
  title: string;
  showTitle?: boolean;
  toolbar: ReactNode;
  editor: ReactNode;
  preview: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      {showTitle && (
        <div className="reploom-heading">
          <h2>{title}</h2>
        </div>
      )}
      {toolbar}
      <div className="reploom-panes">
        {editor}
        {preview}
      </div>
      {children}
    </>
  );
}

export function FeedbackBar({ status, children }: { status: string; children: ReactNode }) {
  return (
    <div className="reploom-feedback">
      <p className="reploom-status">{status}</p>
      {children}
    </div>
  );
}

export function PreviewLoading({ text }: { text: string }) {
  return <div className="reploom-preview-loading">{text}</div>;
}

export function LoadingSurface({
  title,
  project,
  defaultView,
  mobileView = "code",
  theme = "auto",
  locale,
  preparedSource,
  highlightLines,
  showTitle,
  showTools = true,
  shareTarget,
  labels: overrides,
}: LayoutProps & { labels?: Partial<PlaygroundLabels> }) {
  const labels = overrides ? { ...defaultLabels, ...overrides } : defaultLabels;
  return (
    <section
      className="reploom reploom-loading"
      aria-label={title}
      data-project={project}
      lang={locale}
      data-phase="loading"
      data-view={defaultView ?? "auto"}
      data-mobile-view={mobileView}
      data-theme={theme}
    >
      <WorkspaceLayout
        title={title}
        showTitle={showTitle}
        toolbar={
          <ToolbarLayout labels={labels} view={defaultView}>
            {shareTarget && <button type="button">{labels.share}</button>}
            <SettingsButton label={labels.settings} />
          </ToolbarLayout>
        }
        editor={
          <div className="reploom-editor">
            <div className="reploom-file-bar">{preparedSource?.path.split("/").pop()}</div>
            <div className="reploom-code-editor">
              {preparedSource && (
                <PreparedSourceView source={preparedSource} highlightLines={highlightLines} />
              )}
            </div>
          </div>
        }
        preview={
          <div className="reploom-preview">
            <div className="reploom-preview-bar">{labels.preview}</div>
            <PreviewLoading text={labels.loading} />
          </div>
        }
      >
        <FeedbackBar status={labels.loading}>
          <details className="reploom-help" inert>
            <summary>{labels.help}</summary>
          </details>
          <button type="button" disabled>
            {labels.reset}
          </button>
        </FeedbackBar>
        {showTools && (
          <div className="reploom-tools">
            <span>{labels.tools}</span>
          </div>
        )}
      </WorkspaceLayout>
    </section>
  );
}

/** Import the package stylesheet in the host page for the pre-hydration surface. */
export function PlaygroundPlaceholder(props: LayoutProps & { labels?: Partial<PlaygroundLabels> }) {
  return (
    <div className="reploom-host">
      <LoadingSurface {...props} />
    </div>
  );
}
