export function test({
  container,
  assert,
}: {
  container: HTMLElement;
  assert(value: unknown, message?: string): void;
}) {
  const input = container.querySelector("input")!;
  input.value = "An isolated test task";
  container
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  assert(container.querySelectorAll("li").length === 2, "Submitting adds a task");
  assert(input.value === "", "Submitting clears the input");
}
