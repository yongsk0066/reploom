import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { createEditor } from "../codemirror/editor.ts";
import type { EditorOptions } from "../codemirror/editor.ts";
import type { SourceFiles } from "@yongsk0066/reploom";
import { mountSourceView } from "../reader/source-view.ts";
import type { PlaygroundLabels } from "./labels.ts";

import { PreparedSourceView } from "./PreparedSourceView.tsx";
import type { PreparedSource } from "../reader/prepare.ts";

type Props = {
  preparedSource?: PreparedSource;
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

function SourcePreview({
  path,
  source,
  labelId,
  prepared,
}: {
  prepared?: PreparedSource;
  path: string;
  source: string;
  labelId: string;
}) {
  const pre = useRef<HTMLPreElement>(null);
  const exact = prepared?.path === path && prepared.text === source ? prepared : undefined;
  useLayoutEffect(() => {
    if (!exact) return mountSourceView(pre.current!, path, source);
  }, [exact, path, source]);
  if (exact) return <PreparedSourceView source={exact} labelId={labelId} />;
  return <pre ref={pre} className="reploom-source-preview" aria-labelledby={labelId} />;
}

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

  const [factory, setFactory] = useState<typeof createEditor>();
  const [composing, setComposing] = useState(false);
  const fallback = useRef<HTMLTextAreaElement>(null);
  const handoff = useRef<[number, number, number, number] | undefined>(undefined);
  const focusOnEdit = useRef(false);

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
        if (!cancelled) setFactory(() => createEditor);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [activated]);

  useLayoutEffect(() => {
    if (!factory || composing || !host.current) return;
    const text = fallback.current;
    if (text?.matches(":focus") && !latest.current.selection) {
      const backward = text.selectionDirection === "backward";
      handoff.current = [
        backward ? text.selectionEnd : text.selectionStart,
        backward ? text.selectionStart : text.selectionEnd,
        text.scrollTop,
        text.scrollLeft,
      ];
    }
    session.current = factory(
      host.current,
      (...args) => latest.current.onChange(...args),
      latest.current.options,
    );
    sync();
    setLoaded(true);
    return () => {
      session.current?.destroy();
      session.current = null;
    };
  }, [factory, composing]);

  useLayoutEffect(() => {
    if (loaded && handoff.current) {
      session.current?.focusSelection(...handoff.current);
      handoff.current = undefined;
    }
  }, [loaded]);

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
          <button
            type="button"
            onClick={() => {
              focusOnEdit.current = true;
              activate(true);
            }}
          >
            {props.labels.edit}
          </button>
          <SourcePreview
            prepared={props.preparedSource}
            path={props.active}
            source={props.files[props.active]?.toString() ?? ""}
            labelId={props.labelId}
          />
        </>
      ) : (
        !loaded && (
          <textarea
            value={props.files[props.active]?.toString() ?? ""}
            aria-labelledby={props.labelId}
            aria-describedby={props.describedBy}
            spellCheck={false}
            ref={fallback}
            autoFocus={focusOnEdit.current}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={(event) => {
              props.onChange(props.active, event.currentTarget.value, false);
              setComposing(false);
            }}
            onChange={(event) =>
              props.onChange(
                props.active,
                event.currentTarget.value,
                composing || (event.nativeEvent as InputEvent).isComposing,
              )
            }
          />
        )
      )}
      {failed && <p className="reploom-hint">{props.labels.editorFallback}</p>}
    </div>
  );
}
