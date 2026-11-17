const previousSiblingIndexes = new WeakMap();

const siblingIndexStats = (globalThis.editorSiblingIndexStats = { buffers: 0, bytes: 0 });

export function previousSiblingIndex(buffer, parentStart, index) {
  const data = buffer.buffer;
  if (data.length < 256 || data.length > 65535)
    return buffer.findChild(parentStart, index, -1, 0, 4);
  let previous = previousSiblingIndexes.get(buffer);
  if (!previous) {
    previous = new Uint16Array(data.length / 4).fill(65535);
    siblingIndexStats.buffers++;
    siblingIndexStats.bytes += previous.byteLength;
    for (let offset = 0; offset < data.length; offset += 4) {
      const next = data[offset + 3];
      // Preorder visits the sibling root before its descendants. Several nodes
      // can end at the same slot; the first owner is the sibling to retain.
      if (next < data.length && previous[next / 4] === 65535) previous[next / 4] = offset;
    }
    previousSiblingIndexes.set(buffer, previous);
  }
  const found = previous[index / 4];
  if (found < parentStart || found >= index) throw Error("Invalid previous-sibling index");
  return found;
}
