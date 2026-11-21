import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserPlatform } from "@yongsk0066/reploom/browser";
import { Playground } from "@yongsk0066/reploom-ui/react";
import "./style.css";

const platform = createBrowserPlatform({ manifestUrl: "/reploom/manifest.json" });
const manifest = await platform.loadManifest();
const entries = Object.entries(manifest.projects);
const requested = location.hash.slice(1);

const instructions: Record<string, string> = {
  "react-counter":
    "Enter your name, increment the counter, then edit the button text. Your name and count stay in the preview.",
  "effect-events":
    "Change the room and theme. Edit the heading and watch which changes reconnect the room.",
  "react-lazy": "Open the panel, increment its count, then edit Panel.tsx while it is visible.",
  "dom-todos": "Add a task, then run the tests. The tests exercise a separate task list.",
  "dom-canvas":
    "Change the circle radius while the animation is running and watch the frame counter.",
  "dom-assets":
    "Edit the description next to the SVG. Both resources come from the prepared project.",
  "module-lifecycle":
    "Change the interval in ticker.ts and watch the counter continue with the new timing.",
  "compute-statistics": "Change a value in data.json and compare the totals and run count.",
  "compute-fractal":
    "Open the editor and change the iteration limit to redraw the fractal in a Worker.",
};

function Gallery() {
  const [selected, setSelected] = useState(
    Object.hasOwn(manifest.projects, requested) ? requested : entries[0][0],
  );

  return (
    <main className="gallery">
      <header className="gallery-heading">
        <h1>Reploom</h1>
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
        <p>{instructions[selected]}</p>
      </header>
      <Playground
        key={selected}
        project={selected}
        title={manifest.projects[selected].title}
        platform={platform}
        editorActivation={selected === "compute-fractal" ? "interaction" : "eager"}
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
