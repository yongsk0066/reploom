import { useEffect, useRef, useState } from "react";
import type { createEditor } from "../codemirror/editor.ts";
import type { EditorOptions } from "../codemirror/editor.ts";
import type { SourceFiles } from "@yongsk0066/reploom";
import type { PlaygroundLabels } from "./labels.ts";

type Props = {
  options?: EditorOptions;
  selection?: { id: string; file: string; line: number; column: number };
  files: SourceFiles;
  active: string;
  resetKey: number;
  labelId: string;
  describedBy: string;
  invalid: boolean;
  activation?: "eager" | "interaction";
  labels: Pick<PlaygroundLabels, "edit" | "editorFallback">;
  onIntent?(): void;
  onChange: Parameters<typeof createEditor>[1];
};

export default function CodeEditor(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const session = useRef<ReturnType<typeof createEditor> | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const previousReset = useRef(props.resetKey);
  const previousSelection = useRef<string | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [activated, activate] = useState(props.activation !== "interaction");

  function sync() {
    const p = latest.current;
    session.current?.sync(
      p.files,
      p.active,
      {
        "aria-labelledby": p.labelId,
        "aria-describedby": p.describedBy,
        "aria-invalid": String(p.invalid),
      },
      previousReset.current !== p.resetKey,
    );
    previousReset.current = p.resetKey;
    if (
      session.current &&
      p.selection?.file === p.active &&
      previousSelection.current !== p.selection.id
    ) {
      session.current.reveal(p.selection.line, p.selection.column);
      previousSelection.current = p.selection.id;
    }
  }

  useEffect(() => {
    if (!activated) return;
    let cancelled = false;
    import("../codemirror/editor.ts")
      .then(({ createEditor }) => {
        if (cancelled || !host.current) return;
        session.current = createEditor(
          host.current,
          (...args) => latest.current.onChange(...args),
          latest.current.options,
        );
        sync();
        setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      session.current?.destroy();
      session.current = null;
    };
  }, [activated]);
  useEffect(sync, [
    props.files,
    props.active,
    props.resetKey,
    props.invalid,
    props.describedBy,
    props.selection,
  ]);
  useEffect(() => {
    if (props.selection) activate(true);
  }, [props.selection]);
  return (
    <div
      className="reploom-code-editor"
      data-editor-ready={loaded}
      onFocusCapture={props.onIntent}
      onPointerDown={props.onIntent}
    >
      <div ref={host} hidden={!loaded} />
      {!activated ? (
        <>
          <button type="button" onClick={() => activate(true)}>
            {props.labels.edit}
          </button>
          <pre className="reploom-source-preview" aria-labelledby={props.labelId}>
            {props.files[props.active]?.toString() ?? ""}
          </pre>
        </>
      ) : (
        !loaded && (
          <textarea
            value={props.files[props.active]?.toString() ?? ""}
            aria-labelledby={props.labelId}
            aria-describedby={props.describedBy}
            spellCheck={false}
            disabled={!failed}
            onChange={(e) => props.onChange(props.active, e.target.value, false)}
          />
        )
      )}
      {failed && <p className="reploom-hint">{props.labels.editorFallback}</p>}
    </div>
  );
}
