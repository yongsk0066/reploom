import { useEffect, useRef } from "react";
import { PreviewBridge } from "@yongsk0066/reploom/browser";
import type { ArtifactConnector } from "@yongsk0066/reploom/browser";
import type { PreviewEvent, Snapshot } from "@yongsk0066/reploom/browser";
import type { ProjectSession } from "@yongsk0066/reploom";

type Props = {
  session: ProjectSession;
  language?: string;
  compute: import("@yongsk0066/reploom/browser").ComputeLabels;
  snapshot: Snapshot;
  connectArtifacts: ArtifactConnector;
  title: string;
  onEvent: (event: PreviewEvent) => void;
};

export default function PreviewFrame({
  snapshot,
  title,
  onEvent,
  connectArtifacts,
  session,
  language,
  compute,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const bridge = useRef<PreviewBridge | null>(null);
  const notify = useRef(onEvent);
  notify.current = onEvent;
  useEffect(() => {
    const current = new PreviewBridge(
      host.current!,
      title,
      (event) => notify.current(event),
      connectArtifacts,
    );

    bridge.current = current;
    const unbind = session.bindPreview(current);
    return () => {
      unbind();
      void current.dispose(false);
      bridge.current = null;
    };
  }, [connectArtifacts, session]);
  useEffect(() => {
    bridge.current?.setPresentation({ language, compute });
    bridge.current?.update(snapshot, title);
  }, [snapshot, title, language, compute]);
  return <div ref={host} className="reploom-preview-mount" />;
}
