import { useState } from "react";
import clsx from "clsx";
import settings from "./settings.json";
import "./style.css";

export default function App() {
  const [count, setCount] = useState(0);
  const [name, setName] = useState("Ada");
  return (
    <main>
      <h1>{settings.title}</h1>
      <label>
        Your name <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <p>Hello, {name}.</p>
      <button
        className={clsx("counter", count > 4 && "milestone")}
        onClick={() => setCount(count + settings.step)}
      >
        Count {count}
      </button>
    </main>
  );
}
