import icon from "./icon.svg";

export function mount(root: HTMLElement) {
  const title = document.createElement("h1");
  title.textContent = "Declared local asset";
  const image = document.createElement("img");
  image.src = icon;
  image.alt = "Blue geometric mark";
  image.width = 96;
  root.append(title, image);
}
