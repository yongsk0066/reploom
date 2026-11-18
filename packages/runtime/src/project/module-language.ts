export const textModuleExtensions: readonly string[] = Object.freeze([
  "txt",
  "md",
  "html",
  "svg",
  "csv",
  "glsl",
  "wgsl",
]);

export function moduleLanguage(path: string) {
  const extension = path.slice(path.lastIndexOf(".") + 1);
  switch (extension) {
    case "ts":
    case "mts":
      return "ts";
    case "tsx":
      return "tsx";
    case "js":
    case "jsx":
      return "jsx";
    case "mjs":
      return "js";
    case "css":
      return "css";
    case "json":
      return "json";
    default:
      return textModuleExtensions.includes(extension) ? "text" : undefined;
  }
}

export function isScriptFile(path: string) {
  const kind = moduleLanguage(path);
  return kind === "js" || kind === "jsx" || kind === "ts" || kind === "tsx";
}
