import { useMemo, useState, useSyncExternalStore } from "react";
import type { ProjectArchive, ProjectSession } from "@yongsk0066/reploom";
import type { PlaygroundLabels } from "./labels.ts";

export function ProjectTools({
  session,
  labels,
}: {
  session: ProjectSession;
  labels: PlaygroundLabels;
}) {
  const store = useMemo(
    () =>
      session.observe(
        (view) => ({
          capabilities: view.capabilities,
          checks: view.checks,
          initialized: view.initialized,
        }),
        (a, b) =>
          a.capabilities === b.capabilities &&
          a.checks === b.checks &&
          a.initialized === b.initialized,
      ),
    [session],
  );

  const view = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const [path, setPath] = useState("");
  const [state, setState] = useState(false);
  const [archive, setArchive] = useState<ProjectArchive>();
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  function perform(action: () => unknown) {
    try {
      action();
      setMessage("");
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function save() {
    setSaving(true);
    try {
      const value = await session.save({ state });
      setArchive(value);

      const url = URL.createObjectURL(
        new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
      );

      const link = document.createElement("a");
      link.href = url;
      link.download = `${session.example}.reploom.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setMessage("");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setSaving(false);
    }
  }

  async function restore(file: File) {
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("Project archive exceeds 5 MiB");
      session.restore(JSON.parse(await file.text()));
      setMessage("");
    } catch (error) {
      setMessage(String(error));
    }
  }

  return (
    <details className="reploom-tools">
      <summary>{labels.tools}</summary>
      <fieldset disabled={!view.initialized}>
        <legend>{labels.files}</legend>
        <label>
          {labels.path}
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/helper.ts"
          />
        </label>
        <button
          type="button"
          onClick={() =>
            perform(() => {
              if (Object.hasOwn(session.getSnapshot().files, path))
                throw new Error("File already exists");
              session.transaction([
                { type: "write", path, source: path.endsWith(".json") ? "{}" : "" },
              ]);
              session.select(path);
            })
          }
        >
          {labels.addFile}
        </button>
        <button
          type="button"
          onClick={() =>
            perform(() =>
              session.transaction([{ type: "move", from: session.getSnapshot().active, to: path }]),
            )
          }
        >
          {labels.moveFile}
        </button>
        <button
          type="button"
          onClick={() =>
            perform(() =>
              session.transaction([{ type: "remove", path: session.getSnapshot().active }]),
            )
          }
        >
          {labels.removeFile}
        </button>
      </fieldset>
      <fieldset disabled={!view.initialized || saving}>
        <legend>{labels.projectSnapshot}</legend>
        <label>
          <input
            type="checkbox"
            checked={state}
            onChange={(event) => setState(event.target.checked)}
          />
          {labels.includeState}
        </label>
        <button type="button" onClick={() => void save()}>
          {labels.saveProject}
        </button>
        <button
          type="button"
          disabled={!archive}
          onClick={() => perform(() => session.restore(archive))}
        >
          {labels.restoreSaved}
        </button>
        <label>
          {labels.openProject}
          <input
            type="file"
            accept=".json,application/json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void restore(file);
            }}
          />
        </label>
      </fieldset>
      {(["tests", "types"] as const)
        .filter((kind) => view.capabilities?.[kind])
        .map((kind) => (
          <div key={kind}>
            <button
              type="button"
              disabled={view.checks?.[kind]?.phase === "running"}
              onClick={() => {
                void session.check(kind).catch((error) => {
                  if (error?.name !== "AbortError") setMessage(String(error));
                });
              }}
            >
              {kind === "tests" ? labels.runTests : labels.checkTypes}
            </button>
            <output>{view.checks?.[kind]?.phase}</output>
            {view.checks?.[kind]?.diagnostics.map((diagnostic, index) => (
              <p key={index}>
                <button type="button" onClick={() => session.reveal(diagnostic)}>
                  {diagnostic.file}:{diagnostic.line}
                </button>{" "}
                {diagnostic.text}
              </p>
            ))}
          </div>
        ))}
      <p role="status">{message}</p>
    </details>
  );
}
