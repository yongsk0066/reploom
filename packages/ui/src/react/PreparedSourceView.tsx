import { memo, type ReactNode } from "react";
import type { PreparedSource } from "../reader/prepare.ts";
import { inRange, sourceRows, type SourceRun } from "../reader/lines.ts";

export const PreparedSourceView = memo(function PreparedSourceView({
  source,
  labelId,
  numbered = false,
  highlightLines,
}: {
  source: PreparedSource;
  labelId?: string;
  numbered?: boolean;
  highlightLines?: readonly [number, number];
}) {
  const { text, spans, classes } = source;
  const runs: SourceRun[] = [];
  let cursor = 0;
  for (let i = 0; i < spans.length; i += 3) {
    const from = cursor + spans[i];
    if (from > cursor) runs.push({ from: cursor, to: from });
    cursor = from + spans[i + 1];
    runs.push({ from, to: cursor, style: classes[spans[i + 2]] });
  }
  if (cursor < text.length) runs.push({ from: cursor, to: text.length });

  const render = (run: SourceRun): ReactNode =>
    run.style ? (
      <span key={run.from} className={run.style}>
        {text.slice(run.from, run.to)}
      </span>
    ) : (
      text.slice(run.from, run.to)
    );

  return (
    <pre
      className="reploom-source-preview"
      aria-labelledby={labelId}
      aria-label={labelId ? undefined : source.path}
      data-numbered={numbered}
    >
      {numbered || highlightLines
        ? sourceRows(text, 0, text.length, runs).map((row, i) => (
            <span
              className="reploom-source-line"
              key={i}
              data-line={i + 1}
              data-emphasis={inRange(i + 1, highlightLines) || undefined}
            >
              {row.map(render)}
            </span>
          ))
        : runs.map(render)}
    </pre>
  );
});
