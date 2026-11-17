import { useState, useRef } from "react";
import clsx from "clsx";
import { increment } from "./counter.ts";
import settings from "./settings.json";
import "./dashboard.css";

export default function Dashboard() {
  const [count, setCount] = useState(0);
  const marker = useRef(Math.random().toString(36).slice(2));
  return (
    <main className={clsx("dashboard", { active: count > 0 })}>
      <h1>{settings.title}</h1>
      <button onClick={() => setCount(increment)}>count {count}</button>
      <label>
        Note <input defaultValue="" />
      </label>
      <output aria-label="Stable reference">{marker.current}</output>
    </main>
  );
}
