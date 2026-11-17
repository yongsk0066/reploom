import type { Text } from "@codemirror/state";

function sharedLength(before: Text, after: Text, direction: 1 | -1, limit: number) {
  const left = before.iter(direction);
  const right = after.iter(direction);
  left.next();
  right.next();
  let leftOffset = 0;
  let rightOffset = 0;
  let matched = 0;

  while (!left.done && !right.done && matched < limit) {
    const count = Math.min(
      left.value.length - leftOffset,
      right.value.length - rightOffset,
      limit - matched,
    );

    if (leftOffset !== rightOffset || left.value !== right.value) {
      for (let i = 0; i < count; i++) {
        const a = direction === 1 ? leftOffset + i : left.value.length - leftOffset - i - 1;
        const b = direction === 1 ? rightOffset + i : right.value.length - rightOffset - i - 1;
        if (left.value.charCodeAt(a) !== right.value.charCodeAt(b)) return matched + i;
      }
    }
    matched += count;
    leftOffset += count;
    rightOffset += count;
    if (leftOffset === left.value.length) {
      left.next();
      leftOffset = 0;
    }
    if (rightOffset === right.value.length) {
      right.next();
      rightOffset = 0;
    }
  }
  return matched;
}

function lowSurrogateAt(text: Text, offset: number) {
  const code = text.sliceString(offset, offset + 1).charCodeAt(0);
  return code >= 0xdc00 && code <= 0xdfff;
}

function singleLineRange(before: Text, after: Text) {
  const a = before.sliceString(0, before.length);
  const b = after.sliceString(0, after.length);
  let from = 0;
  let oldEnd = a.length;
  let newEnd = b.length;
  while (from < oldEnd && from < newEnd && a.charCodeAt(from) === b.charCodeAt(from)) from++;
  while (oldEnd > from && newEnd > from && a.charCodeAt(oldEnd - 1) === b.charCodeAt(newEnd - 1)) {
    oldEnd--;
    newEnd--;
  }
  return { from, oldEnd, newEnd };
}

/** Preserve shared text trees and undo history without flattening either document. */
export function documentChange(before: Text, after: Text) {
  const limit = Math.min(before.length, after.length);

  const single =
    before.lines === 1 && after.lines === 1 ? singleLineRange(before, after) : undefined;

  let from = single?.from ?? sharedLength(before, after, 1, limit);

  const suffix = single
    ? before.length - single.oldEnd
    : sharedLength(before, after, -1, limit - from);

  let oldEnd = single?.oldEnd ?? before.length - suffix;
  let newEnd = single?.newEnd ?? after.length - suffix;

  if (from > 0 && (lowSurrogateAt(before, from) || lowSurrogateAt(after, from))) from--;
  if (suffix > 0 && lowSurrogateAt(before, oldEnd)) {
    oldEnd++;
    newEnd++;
  }
  return { from, to: oldEnd, insert: after.slice(from, newEnd) };
}
