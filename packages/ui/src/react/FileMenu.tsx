import { useRef, useState } from "react";
import type { ProjectSession, ProjectView } from "@yongsk0066/reploom";
import { useProject } from "./use-project.ts";
import type { PlaygroundLabels } from "./labels.ts";

const requiredOf = (view: ProjectView) => view.requiredFiles;

export function FileMenu({
  session,
  active,
  labels,
  id,
}: {
  session: ProjectSession;
  active: string;
  labels: PlaygroundLabels;
  id: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [input, setPath] = useState("");
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const required = useProject(session, requiredOf)?.includes(active);

  const name = input.trim();
  const path = name.startsWith("/") ? name : "/" + name;

  function perform(operation: "write" | "move" | "remove") {
    try {
      if (operation !== "remove" && Object.hasOwn(session.getSnapshot().files, path)) {
        setError(labels.fileExists);
        return;
      }
      if (operation === "write") {
        session.transaction([{ type: "write", path, source: path.endsWith(".json") ? "{}" : "" }]);
        session.select(path);
      } else if (operation === "move")
        session.transaction([{ type: "move", from: active, to: path }]);
      else session.transaction([{ type: "remove", path: active }]);
      dialog.current?.close();
    } catch {
      setError(labels.fileRejected);
    }
  }

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => {
          setPath("");
          setRemoving(false);
          setError("");
          dialog.current?.showModal();
        }}
      >
        {labels.files}
      </button>
      <dialog
        ref={dialog}
        className="reploom-reset-dialog reploom-files"
        aria-labelledby={id + "-files-title"}
      >
        <h2 id={id + "-files-title"} className="reploom-dialog-title">
          {removing ? labels.removeNamed(active) : labels.files}
        </h2>
        {!removing && (
          <>
            <p>
              <code>{active}</code>
            </p>
            <label>
              {labels.path}
              <input
                value={input}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/helper.ts"
              />
            </label>
            <div>
              <button type="button" disabled={!name} onClick={() => perform("write")}>
                {labels.addFile}
              </button>
              <button type="button" disabled={required || !name} onClick={() => perform("move")}>
                {labels.moveFile}
              </button>
            </div>
          </>
        )}
        <p role="status">{error}</p>
        <form method="dialog">
          <button autoFocus ref={cancel}>
            {removing ? labels.cancel : labels.close}
          </button>
          <button
            type="button"
            disabled={required}
            onClick={() => {
              if (removing) perform("remove");
              else {
                setRemoving(true);
                cancel.current?.focus();
              }
            }}
          >
            {labels.removeNamed(active)}
          </button>
        </form>
      </dialog>
    </>
  );
}
