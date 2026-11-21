// Browser ownership is explicit: callers own the Session and its attached views.
import type { ProjectSession } from "./project/session.ts";
import { PreviewBridge } from "./browser/preview-bridge.ts";
import type { BrowserPlatform } from "./browser/platform.ts";

export { createBrowserPlatform } from "./browser/platform.ts";

export type { BrowserPlatform, BrowserPlatformOptions } from "./browser/platform.ts";

export type { ArtifactConnector } from "./browser/preview-bridge.ts";

export type { PreviewEvent, Snapshot } from "./shared/protocol.ts";

export type { Manifest } from "./shared/assets.ts";

export { PreviewBridge };

export function attachPreview(
  session: ProjectSession,
  host: HTMLElement,
  title: string,
  platform: Pick<BrowserPlatform, "connectCompilerPreview">,
  presentation?: import("./shared/presentation.ts").PreviewPresentation,
) {
  const bridge = new PreviewBridge(host, title, session.onEvent, platform.connectCompilerPreview);
  if (presentation) bridge.setPresentation(presentation);
  const unbind = session.bindPreview(bridge);
  const store = session.observe((view) => view.snapshot);

  const update = () => {
    const snapshot = store.getSnapshot();
    if (snapshot) bridge.update(snapshot);
  };

  const unsubscribe = store.subscribe(update);
  update();
  let disposed = false;
  return {
    async dispose(graceful = true) {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      unbind();
      await bridge.dispose(graceful);
    },
  };
}

export type { ComputeLabels, PreviewPresentation } from "./shared/presentation.ts";
