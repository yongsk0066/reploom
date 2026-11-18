import icon from "./icon.svg";
import description from "./description.txt";

export function mount(root: HTMLElement) {
  const title = document.createElement("h1");
  title.textContent = "Declared local asset";
  const image = document.createElement("img");
  image.src = icon;
  image.alt = description.trim();
  image.width = 96;
  root.append(title, image);
}
