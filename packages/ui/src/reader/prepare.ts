import { language, highlightSource } from "./syntax.ts";

export type PreparedSource = Readonly<{
  path: string;
  text: string;
  classes: readonly string[];
  spans: Uint16Array | readonly number[];
}>;

/** Build-time presentation data for short, immutable initial examples. */
export async function prepareSource(
  path: string,
  text: string,
): Promise<PreparedSource | undefined> {
  if (!text || text.length > 8192) return;
  const parser = await language(path);
  const classes: string[] = [];
  const spans: number[] = [];
  let cursor = 0;
  highlightSource(parser.parse(text), 0, text.length, (from, to, style) => {
    let id = classes.indexOf(style);
    if (id < 0) id = classes.push(style) - 1;
    spans.push(from - cursor, to - from, id);
    cursor = to;
  });
  if (spans.length <= 768 * 3) return { path, text, classes, spans: Uint16Array.from(spans) };
}
