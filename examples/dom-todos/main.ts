import "./style.css";

type Task = { title: string; done: boolean };

const saved = import.meta.state<Task[]>("tasks", [{ title: "Edit this example", done: false }]);

export function mount(root: HTMLElement, { signal }) {
  const tasks = saved.value;
  root.innerHTML =
    "<h1>Task list</h1><form><label>New task <input required></label><button>Add</button></form><ul></ul>";

  const list = root.querySelector("ul")!;
  const input = root.querySelector("input")!;

  const render = () => {
    list.replaceChildren(
      ...tasks.map((task) => {
        const item = document.createElement("li");
        const check = document.createElement("input");

        check.type = "checkbox";
        check.checked = task.done;
        check.onchange = () => {
          task.done = check.checked;
        };
        item.append(check, document.createTextNode(task.title));
        return item;
      }),
    );
  };

  root.querySelector("form")!.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      tasks.push({ title: input.value, done: false });
      input.value = "";
      render();
    },
    { signal },
  );
  render();
}
