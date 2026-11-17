import type { ProjectArchive } from "@yongsk0066/reploom";

export function downloadArchive(archive: ProjectArchive) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" }),
  );

  const link = document.createElement("a");
  link.href = url;
  link.download = `${archive.project}.reploom.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
