import type { Text } from "@codemirror/state";
import type { Input } from "@lezer/common";

/** A parse owns one cursor over its immutable document, including backward lookahead. */
export function documentInput(doc: Text): Input {
  const cursor = doc.iter();
  let end = 0;
  let text = "";
  return {
    length: doc.length,
    lineChunks: true,
    chunk(from) {
      const start = end - text.length;
      if (from >= start && from < end) return text.slice(from - start);
      text = cursor.next(from - end).value;
      end = from + text.length;
      return text;
    },
    read(from, to) {
      const start = end - text.length;
      return from >= start && to <= end
        ? text.slice(from - start, to - start)
        : doc.sliceString(from, to);
    },
  };
}
