import { lazy, Suspense, useState } from "react";

const Panel = lazy(() => import("./Panel.tsx"));

export default function App() {
  const [visible, setVisible] = useState(false);
  return (
    <main style={{ font: "16px system-ui", padding: 24 }}>
      <h1>Lazy modules</h1>
      <button onClick={() => setVisible((value) => !value)}>Toggle panel</button>
      <Suspense fallback={<p>Loading module…</p>}>{visible && <Panel />}</Suspense>
    </main>
  );
}
