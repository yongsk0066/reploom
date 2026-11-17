import rows from "./data.json";

export function run({ state, report }) {
  state.runs = (state.runs ?? 0) + 1;
  const groups: Record<string, { total: number; count: number }> = {};
  for (const row of rows) {
    const group = (groups[row.region] ??= { total: 0, count: 0 });
    group.total += row.value;
    group.count++;
  }
  report({ phase: "Aggregated", rows: rows.length });
  return { runs: state.runs, groups };
}
