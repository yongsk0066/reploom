function scrollParents(element: HTMLElement, axis: "x" | "y") {
  const document = element.ownerDocument;
  const parents: HTMLElement[] = [];
  let parent =
    element.parentElement ??
    ((element.getRootNode() as ShadowRoot).host as HTMLElement | undefined);

  while (parent) {
    const overflow =
      document.defaultView!.getComputedStyle(parent)[axis === "x" ? "overflowX" : "overflowY"];

    if (overflow === "auto" || overflow === "scroll") parents.push(parent);
    parent =
      parent.parentElement ??
      ((parent.getRootNode() as ShadowRoot).host as HTMLElement | undefined);
  }
  const page = document.scrollingElement as HTMLElement | null;
  if (page && !parents.includes(page)) parents.push(page);
  return parents;
}

function canScroll(element: HTMLElement, axis: "x" | "y", delta: number) {
  const position = axis === "x" ? element.scrollLeft : element.scrollTop;

  const maximum =
    axis === "x"
      ? element.scrollWidth - element.clientWidth
      : element.scrollHeight - element.clientHeight;

  return delta < 0 ? position > 0 : position < maximum - 1;
}

function wheelUnit(event: WheelEvent, element: HTMLElement, axis: "x" | "y") {
  if (event.deltaMode === 2) return axis === "x" ? element.clientWidth : element.clientHeight;
  if (event.deltaMode === 1)
    return (
      parseFloat(element.ownerDocument.defaultView!.getComputedStyle(element).lineHeight) || 16
    );
  return 1;
}

function wheelDeltas(event: WheelEvent) {
  return {
    x: event.deltaX || (event.shiftKey ? event.deltaY : 0),
    y: event.shiftKey && !event.deltaX ? 0 : event.deltaY,
  };
}

// Wheel events expose both deltas, unlike a native touch pan's axis latch.
// Leave single-axis input and zoom native; handle only cross-axis drift locally.
export function lockScrollAxis(element: HTMLElement) {
  let axis: "x" | "y" | undefined;
  let last = 0;
  let parents: HTMLElement[] | undefined;

  function wheel(event: WheelEvent) {
    if (event.ctrlKey || event.metaKey || event.defaultPrevented || !event.cancelable) return;
    const { x, y } = wheelDeltas(event);
    if (!x && !y) return;
    const now = performance.now();
    if (!axis || now - last > 160) {
      axis = Math.abs(x) > Math.abs(y) ? "x" : "y";
      parents = undefined;
    }
    last = now;
    if (axis === "x" ? !y : !x) return;

    const delta = (axis === "x" ? x : y) * wheelUnit(event, element, axis);
    event.preventDefault();
    if (!delta) return;

    const target = canScroll(element, axis, delta)
      ? element
      : (parents ??= scrollParents(element, axis)).find((parent) =>
          canScroll(parent, axis!, delta),
        );

    if (target) {
      if (axis === "x") target.scrollLeft += delta;
      else target.scrollTop += delta;
    }
  }

  element.addEventListener("wheel", wheel, { passive: false });
  return () => element.removeEventListener("wheel", wheel);
}
