import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserPlatform } from "@yongsk0066/reploom/browser";
import { Playground } from "@yongsk0066/reploom-ui/react";
import "@yongsk0066/reploom-ui/styles.css";

const platform = createBrowserPlatform({ manifestUrl: "/regression/assets/manifest.json" });
const manifest = await platform.loadManifest();

const editorActivation =
  new URLSearchParams(location.search).get("editor") === "interaction" ? "interaction" : "eager";

const root = createRoot(document.getElementById("app")!);
root.render(
  <StrictMode>
    <main>
      <h1>Runtime lifecycle fixtures</h1>
      {Object.entries(manifest.projects).map(([id, project]) => (
        <Playground
          key={id}
          project={id}
          title={project.title}
          platform={platform}
          editorActivation={editorActivation}
        />
      ))}
    </main>
  </StrictMode>,
);
// A full document teardown has no future consumer. BFCache restores keep owners alive.
addEventListener(
  "pagehide",
  (event) => {
    if (event.persisted) return;
    root.unmount();
    platform.dispose();
  },
  { once: true },
);
