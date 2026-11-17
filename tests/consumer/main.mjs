import { ProjectSession } from "@yongsk0066/reploom";
import { createBrowserPlatform, attachPreview } from "@yongsk0066/reploom/browser";

for (const name of ["one", "two"]) {
  const platform = createBrowserPlatform({ manifestUrl: `/headless/${name}/assets/manifest.json` });
  const session = new ProjectSession("same-id", platform.services);
  const preview = attachPreview(session, document.getElementById(name), name, platform);
  await session.start();
  const original = session.getSnapshot().files["/main.js"].toString();
  document.getElementById(`edit-${name}`).onclick = () =>
    session.change("/main.js", original.replace("Original", `Updated ${name}`));
  document.getElementById(`dispose-${name}`)?.addEventListener("click", async () => {
    await preview.dispose();
    session.dispose();
    platform.dispose();
    document.getElementById(name).dataset.disposed = "true";
  });
}
