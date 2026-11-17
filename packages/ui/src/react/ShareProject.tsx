import { useEffect, useRef, useState } from "react";
import type { ProjectArchive, ProjectSession, ProjectView } from "@yongsk0066/reploom";
import type { PlaygroundView } from "@yongsk0066/reploom/share";
import type { PlaygroundLabels } from "./labels.ts";
import { downloadArchive } from "./archive-download.ts";

import { useProject } from "./use-project.ts";

const initializedOf = (view: ProjectView) => view.initialized;

type Props = {
  session: ProjectSession;
  view: PlaygroundView;
  target: string;
  labels: PlaygroundLabels;
};

export function ShareProject(props: Props) {
  const [open, setOpen] = useState(false);
  const initialized = useProject(props.session, initializedOf);
  return (
    <>
      <button
        type="button"
        disabled={!initialized}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        {props.labels.share}
      </button>
      {open && <ShareDialog {...props} close={() => setOpen(false)} />}
    </>
  );
}

function ShareDialog({ session, view, target, labels, close }: Props & { close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);

  const [includeState, setIncludeState] = useState(
    () => session.getSnapshot().state.phase === "ready",
  );

  const [link, setLink] = useState("");
  const [archive, setArchive] = useState<ProjectArchive>();
  const [message, setMessage] = useState("");
  useEffect(() => {
    dialog.current!.showModal();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setLink("");
    setMessage("");
    setArchive(undefined);

    async function makeLink() {
      const value = await session.save({ state: includeState, signal });
      signal.throwIfAborted();
      setArchive(value);
      const { encodeProjectFragment } = await import("@yongsk0066/reploom/share");
      const url = new URL(target, document.baseURI);
      url.hash = await encodeProjectFragment({ archive: value, view }, signal);
      if (!signal.aborted) setLink(url.href);
    }

    void makeLink().catch((error) => {
      if (!signal.aborted)
        setMessage(error instanceof RangeError ? labels.shareTooLarge : labels.shareFailed);
    });
    return () => controller.abort();
  }, [session, target, view, includeState, labels]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setMessage(labels.linkCopied);
    } catch {
      field.current?.focus();
      field.current?.select();
      setMessage(labels.copyManually);
    }
  }

  return (
    <dialog ref={dialog} className="reploom-share-dialog" aria-label={labels.share} onClose={close}>
      <h2 className="reploom-dialog-title">{labels.share}</h2>
      <label>
        <input
          type="checkbox"
          checked={includeState}
          onChange={(e) => setIncludeState(e.target.checked)}
        />{" "}
        {labels.includeState}
      </label>
      {link && (
        <>
          <input
            aria-label={labels.shareLink}
            ref={field}
            value={link}
            readOnly
            onFocus={(e) => e.currentTarget.select()}
          />
          <button type="button" onClick={copy}>
            {labels.copyLink}
          </button>
          <a href={link} target="_blank" rel="noopener noreferrer">
            {labels.openLink}
          </a>
        </>
      )}
      <p role="status">{message || (!link ? labels.loading : "")}</p>
      {!link && message && archive && (
        <button type="button" onClick={() => downloadArchive(archive)}>
          {labels.saveProject}
        </button>
      )}
      <form method="dialog">
        <button type="submit">{labels.close}</button>
      </form>
    </dialog>
  );
}
