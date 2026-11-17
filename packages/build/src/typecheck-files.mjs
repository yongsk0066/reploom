import { memoryFileSystem, NotFoundError } from "@tsrs/wasm/core";

const normalize = (path) => {
  const parts = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return "/" + parts.join("/");
};

/** Prepared declarations are encoded/indexed once; each request owns its writable overlay. */
export function createTypecheckFiles(declarations) {
  const encoder = new TextEncoder();
  const files = new Map();
  const directories = new Map([["/", new Map()]]);
  for (const [name, source] of Object.entries(declarations)) {
    const path = normalize(name);
    files.set(path, encoder.encode(source));
    const parts = path.slice(1).split("/");
    let parent = "/";
    for (let i = 0; i < parts.length; i++) {
      const leaf = i === parts.length - 1;
      directories.get(parent).set(parts[i], leaf ? "f" : "d");
      parent = parent === "/" ? parent + parts[i] : parent + "/" + parts[i];
      if (!leaf && !directories.has(parent)) directories.set(parent, new Map());
    }
  }
  return (sources) => {
    const overlay = memoryFileSystem(sources);

    const fallback = (operation, path, read) => {
      try {
        return overlay[operation](path);
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
        return read(normalize(path));
      }
    };

    return {
      ...overlay,
      readFile: (path) =>
        fallback("readFile", path, (path) => {
          const bytes = files.get(path);
          if (!bytes) throw new NotFoundError(path);
          return bytes;
        }),
      stat: (path) =>
        fallback("stat", path, (path) => {
          if (files.has(path)) return { kind: "f", size: files.get(path).length, mtimeNs: 0n };
          if (directories.has(path)) return { kind: "d", size: 0, mtimeNs: 0n };
          throw new NotFoundError(path);
        }),
      readDir(path) {
        const entries = new Map(directories.get(normalize(path)));
        try {
          for (const [kind, name] of overlay.readDir(path)) entries.set(name, kind);
        } catch (error) {
          if (!(error instanceof NotFoundError) || !directories.has(normalize(path))) throw error;
        }
        return [...entries].map(([name, kind]) => [kind, name]);
      },
    };
  };
}
