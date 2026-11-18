import { memo, type ReactNode } from "react";
import type { PreparedSource } from "../reader/prepare.ts";

export const PreparedSourceView = memo(function PreparedSourceView({
  source,
  labelId,
}: {
  source: PreparedSource;
  labelId?: string;
}) {
  const { text, spans, classes } = source;
  const content: ReactNode[] = [];
  let cursor = 0;
  for (let i = 0; i < spans.length; i += 3) {
    const start = cursor + spans[i];
    if (start > cursor) content.push(text.slice(cursor, start));
    cursor = start + spans[i + 1];
    content.push(
      <span key={start} className={classes[spans[i + 2]]}>
        {text.slice(start, cursor)}
      </span>,
    );
  }
  if (cursor < text.length) content.push(text.slice(cursor));
  return (
    <pre
      className="reploom-source-preview"
      aria-labelledby={labelId}
      aria-label={labelId ? undefined : source.path}
    >
      {content}
    </pre>
  );
});
