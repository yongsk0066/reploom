import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserPlatform } from "@yongsk0066/reploom/browser";
import { Playground } from "@yongsk0066/reploom-ui/react";
import "@yongsk0066/reploom-ui/styles.css";
import "./style.css";

const platform = createBrowserPlatform({ manifestUrl: "/reploom/manifest.json" });
const manifest = await platform.loadManifest();
const entries = Object.entries(manifest.projects);
const requested = location.hash.slice(1);

function Gallery() {
  const [selected, setSelected] = useState(
    Object.hasOwn(manifest.projects, requested) ? requested : entries[0][0],
  );

  return (
    <main className="gallery">
      <header className="gallery-heading">
        <h1>Reploom</h1>
        <p>Editable examples, running in your browser.</p>
        <label htmlFor="example">Choose an example</label>
        <select
          id="example"
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value);
            history.replaceState(null, "", "#" + event.target.value);
          }}
        >
          {entries.map(([id, project]) => (
            <option key={id} value={id}>
              {project.title}
            </option>
          ))}
        </select>
      </header>
      <Playground
        key={selected}
        project={selected}
        title={manifest.projects[selected].title}
        platform={platform}
      />
    </main>
  );
}

const root = createRoot(document.getElementById("app")!);
root.render(<Gallery />);
addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  root.unmount();
  platform.dispose();
});
