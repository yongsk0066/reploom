export function run({ state, report }) {
  state.runs = (state.runs ?? 0) + 1;
  const rows: string[] = [];
  for (let y = 0; y < 18; y++) {
    let row = "";
    for (let x = 0; x < 48; x++) {
      const cx = x / 16 - 2.2;
      const cy = y / 8 - 1.1;

      let a = 0;
      let b = 0;
      let steps = 0;
      while (a * a + b * b < 4 && steps < 80) {
        const next = a * a - b * b + cx;
        b = 2 * a * b + cy;
        a = next;
        steps++;
      }
      row += steps === 80 ? "#" : " .:-=+*"[Math.min(6, Math.floor(steps / 3))];
    }
    rows.push(row);
    report({ row: y + 1, total: 18 });
  }
  return { runs: state.runs, image: rows };
}
