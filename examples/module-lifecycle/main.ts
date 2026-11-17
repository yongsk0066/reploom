import { subscribe, value } from "./ticker.ts";

export function mount(root: HTMLElement, { state }) {
  state.mounts ??= 0;
  state.mounts++;
  root.innerHTML = "<h1>Module lifecycle</h1><output></output>";
  const output = root.querySelector("output")!;

  const paint = () => {
    output.textContent = `Tick ${value}, mounts ${state.mounts}`;
  };

  paint();
  return subscribe(paint);
}
