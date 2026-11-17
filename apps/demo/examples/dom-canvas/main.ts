export function mount(root: HTMLElement, { state, signal }) {
  state.frames ??= 0;
  root.innerHTML =
    '<h1>Canvas animation</h1><canvas width="320" height="160" aria-label="Moving circle"></canvas><output></output>';

  const canvas = root.querySelector("canvas")!;
  const context = canvas.getContext("2d")!;

  const output = root.querySelector("output")!;
  let frame = 0;

  const draw = () => {
    if (signal.aborted) return;
    state.frames++;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#2563eb";
    context.beginPath();
    context.arc(160 + Math.sin(state.frames / 30) * 120, 80, 18, 0, Math.PI * 2);
    context.fill();
    output.textContent = `Frames: ${state.frames}`;
    frame = requestAnimationFrame(draw);
  };

  draw();
  return () => cancelAnimationFrame(frame);
}
