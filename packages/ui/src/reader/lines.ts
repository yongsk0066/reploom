export type SourceRun = { from: number; to: number; style?: string };

/** Runs use absolute UTF-16 offsets. Newlines stay in the text for selection and copying. */
export function sourceRows(text: string, from: number, to: number, runs: readonly SourceRun[]) {
  const rows: SourceRun[][] = [];
  let i = 0;
  let pos = from;
  while (pos < to) {
    const newline = text.indexOf("\n", pos);
    const end = newline < 0 ? to : Math.min(to, newline + 1);
    const row: SourceRun[] = [];
    while (pos < end) {
      while (i < runs.length && runs[i].to <= pos) i++;
      const run = runs[i];
      const next = Math.min(end, run ? (run.from > pos ? run.from : run.to) : end);
      row.push({ from: pos, to: next, style: run && run.from <= pos ? run.style : undefined });
      pos = next;
    }
    rows.push(row);
  }
  if (to === text.length && (to === 0 || text[to - 1] === "\n")) rows.push([]);
  return rows;
}

export function inRange(line: number, range?: readonly [number, number]) {
  return !!range && line >= range[0] && line <= range[1];
}
