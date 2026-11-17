import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Fixture paths and measurement outputs share the repository root across commands.
const [entry, ...args] = process.argv.slice(2);
try {
  execFileSync(process.execPath, [fileURLToPath(new URL(entry, import.meta.url)), ...args], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: "inherit",
  });
} catch (error) {
  process.exitCode = error.status ?? 1;
}
