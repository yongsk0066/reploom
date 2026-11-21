import { useState } from "react";
import type { ProjectArchive, ProjectSession, ProjectView } from "@yongsk0066/reploom";
import type { PlaygroundLabels } from "./labels.ts";

import { downloadArchive } from "./archive-download.ts";

import { useProject, shallow } from "./use-project.ts";

const toolsOf = (v: ProjectView) => ({
  initialized: v.initialized,
  capabilities: v.capabilities,
  checks: v.checks,
});

export function ProjectTools({
  session,
  labels,
  reveal,
}: {
  session: ProjectSession;
  labels: PlaygroundLabels;
  reveal: ProjectSession["reveal"];
}) {
  const view = useProject(session, toolsOf, shallow);
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

      downloadArchive(value);
      setMessage("");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setSaving(false);
    }
  }

  async function restore(file: File) {
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error(labels.archiveTooLarge);
      session.restore(JSON.parse(await file.text()));
      setMessage("");
    } catch (error) {
      setMessage(String(error));
    }
  }

  return (
    <div className="reploom-tools">
      <details>
        <summary>{labels.tools}</summary>
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
      </details>
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
            <output>
              {view.checks?.[kind] &&
                {
                  running: labels.runningCheck,
                  passed: labels.passedCheck,
                  failed: labels.failedCheck,
                }[view.checks[kind]!.phase]}
            </output>
            {view.checks?.[kind]?.diagnostics.map((diagnostic, index) => (
              <p key={index}>
                {diagnostic.file && (
                  <>
                    <button type="button" onClick={() => reveal(diagnostic)}>
                      {diagnostic.file}
                      {diagnostic.line && ":" + diagnostic.line}
                    </button>{" "}
                  </>
                )}
                {diagnostic.text}
              </p>
            ))}
          </div>
        ))}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
