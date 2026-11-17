/** Checker coordinates are authoritative; fallback indexes live only for this diagnostic batch. */
export function mapTypeDiagnostics(items, readSource) {
  const locations = new Map();

  function locate(item) {
    const position = item.startPosition;
    if (
      Number.isSafeInteger(position?.line) &&
      position.line >= 0 &&
      Number.isSafeInteger(position?.character) &&
      position.character >= 0
    )
      return { line: position.line + 1, column: position.character };

    let location = locations.get(item.fileName);
    if (!location) {
      let source = "";
      try {
        if (item.fileName) source = readSource(item.fileName) ?? "";
      } catch {
        // A diagnostic can refer to an unresolved or removed file.
      }
      const starts = [0];
      for (let at = source.indexOf("\n"); at !== -1; at = source.indexOf("\n", at + 1))
        starts.push(at + 1);
      location = { length: source.length, starts };
      locations.set(item.fileName, location);
    }
    const offset = Math.min(location.length, Math.max(0, item.pos || 0));
    const starts = location.starts;
    let low = 0;
    let high = starts.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (starts[middle] <= offset) low = middle;
      else high = middle;
    }
    return { line: low + 1, column: offset - starts[low] };
  }

  return items.slice(0, 100).map((item) => ({
    text: `TS${item.code}: ${item.text}`,
    file: item.fileName,
    ...locate(item),
  }));
}
