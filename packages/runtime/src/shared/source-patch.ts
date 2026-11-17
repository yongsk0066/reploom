import type { Files } from "../project/definition.ts";

export type SourceText = string | { readonly length: number; toString(): string };

export type SourceFiles = Readonly<Record<string, SourceText>>;

export type TextEdit = { from: number; to: number; insert: string };

export type TextPatch = { baseLength: number; edits: readonly TextEdit[] };

/** Offsets are UTF-16 code units, including lone surrogates, like editor APIs. */
export type SourceChange =
  | string
  | null
  | TextPatch
  | {
      from: number;
      to: number;
      insert: string;
      baseLength: number;
    };

export function sourceChange(before: string | undefined, after: string | undefined): SourceChange {
  if (after === undefined) return null;
  if (before === undefined || after.length < 256) return after;
  let from = 0;
  let end = 0;
  while (
    from < before.length &&
    from < after.length &&
    before.charCodeAt(from) === after.charCodeAt(from)
  )
    from++;
  while (
    end < before.length - from &&
    end < after.length - from &&
    before.charCodeAt(before.length - end - 1) === after.charCodeAt(after.length - end - 1)
  )
    end++;
  if (from + end < 128) return after;
  return {
    from,
    to: before.length - end,
    insert: after.slice(from, after.length - end),
    baseLength: before.length,
  };
}

export function applySourceChanges(
  files: Files,
  changes: Record<string, SourceChange>,
): Record<string, string> {
  const next = Object.assign(Object.create(null), files) as Record<string, string>;
  for (const [path, change] of Object.entries(changes)) {
    if (change === null) delete next[path];
    else if (typeof change === "string") next[path] = change;
    else if ("edits" in change) {
      const previous = next[path];
      if (typeof previous !== "string" || previous.length !== change.baseLength)
        throw new Error(`Source patch base mismatch: ${path}`);
      validateEdits(change.baseLength, change.edits);
      let at = 0;
      const parts: string[] = [];
      for (const edit of change.edits) {
        parts.push(previous.slice(at, edit.from), edit.insert);
        at = edit.to;
      }
      parts.push(previous.slice(at));
      next[path] = parts.join("");
    } else {
      const previous = next[path];
      if (
        typeof previous !== "string" ||
        previous.length !== change.baseLength ||
        !Number.isSafeInteger(change.from) ||
        !Number.isSafeInteger(change.to) ||
        change.from < 0 ||
        change.to < change.from ||
        change.to > previous.length ||
        typeof change.insert !== "string"
      )
        throw new Error(`Source patch base mismatch: ${path}`);
      next[path] = previous.slice(0, change.from) + change.insert + previous.slice(change.to);
    }
  }
  return next;
}

function validateEdits(length: number, edits: readonly TextEdit[]) {
  if (!Number.isSafeInteger(length) || length < 0) throw new Error("Invalid source base length");
  let at = 0;
  for (const edit of edits) {
    if (
      !Number.isSafeInteger(edit.from) ||
      !Number.isSafeInteger(edit.to) ||
      edit.from < at ||
      edit.to < edit.from ||
      edit.to > length ||
      typeof edit.insert !== "string"
    )
      throw new Error("Invalid source edit range");
    at = edit.to;
  }
}

/** Compose ranges using pieces of the base, without reading its text. */
export function composeTextPatch(previous: TextPatch, edits: readonly TextEdit[]): TextPatch {
  type Piece = { from: number; to: number } | { text: string };

  validateEdits(previous.baseLength, previous.edits);
  const pieces: Piece[] = [];
  let at = 0;
  for (const edit of previous.edits) {
    if (at < edit.from) pieces.push({ from: at, to: edit.from });
    if (edit.insert) pieces.push({ text: edit.insert });
    at = edit.to;
  }
  if (at < previous.baseLength) pieces.push({ from: at, to: previous.baseLength });
  const length = (piece: Piece) => ("text" in piece ? piece.text.length : piece.to - piece.from);
  validateEdits(
    pieces.reduce((n, p) => n + length(p), 0),
    edits,
  );
  const output: Piece[] = [];
  let cursor = 0;
  let offset = 0;

  const copy = (from: number, to: number) => {
    while (cursor < pieces.length && offset < to) {
      const piece = pieces[cursor];

      const end = offset + length(piece);
      const start = Math.max(offset, from);
      const stop = Math.min(end, to);

      if (stop > start)
        output.push(
          "text" in piece
            ? { text: piece.text.slice(start - offset, stop - offset) }
            : {
                from: piece.from + start - offset,
                to: piece.from + stop - offset,
              },
        );
      if (end > to) break;
      offset = end;
      cursor++;
    }
  };

  at = 0;
  for (const edit of edits) {
    copy(at, edit.from);
    if (edit.insert) output.push({ text: edit.insert });
    at = edit.to;
  }
  copy(at, Infinity);
  const result: TextEdit[] = [];
  at = 0;
  let inserted = "";
  for (const piece of output) {
    if ("text" in piece) inserted += piece.text;
    else {
      if (piece.from !== at || inserted)
        result.push({ from: at, to: piece.from, insert: inserted });
      at = piece.to;
      inserted = "";
    }
  }
  if (at !== previous.baseLength || inserted)
    result.push({ from: at, to: previous.baseLength, insert: inserted });
  return { baseLength: previous.baseLength, edits: result };
}
