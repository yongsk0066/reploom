import { NotFoundError } from "@tsrs/wasm/core";

const normalize = (path) => {
  const parts = [];
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  return "/" + parts.join("/");
};

function createIndex(sources) {
  const encoder = new TextEncoder();
  const files = new Map();
  const directories = new Map([["/", new Map()]]);

  function put(path, bytes) {
    files.set(path, bytes);
    const parts = path.slice(1).split("/");
    let parent = "/";
    for (let i = 0; i < parts.length; i++) {
      const leaf = i === parts.length - 1;
      directories.get(parent).set(parts[i], leaf ? "f" : "d");
      parent = parent === "/" ? parent + parts[i] : parent + "/" + parts[i];
      if (!leaf && !directories.has(parent)) directories.set(parent, new Map());
    }
  }

  for (const [path, value] of Object.entries(sources))
    put(normalize(path), typeof value === "string" ? encoder.encode(value) : value);
  return { files, directories, put };
}

/** Shared declarations and per-invocation writes are independently indexed file-system layers. */
export function createTypecheckFiles(declarations) {
  const shared = createIndex(declarations);
  return (sources) => {
    let overlay = createIndex(sources);
    const decoder = new TextDecoder();
    const written = new Map();

    return {
      written,
      readFile(path) {
        const key = normalize(path);
        const bytes = overlay.files.get(key) ?? shared.files.get(key);
        if (!bytes) throw new NotFoundError(path);
        return bytes;
      },
      stat(path) {
        const key = normalize(path);
        for (const layer of [overlay, shared]) {
          const bytes = layer.files.get(key);
          if (bytes) return { kind: "f", size: bytes.length, mtimeNs: 0n };
          if (layer.directories.has(key)) return { kind: "d", size: 0, mtimeNs: 0n };
        }
        throw new NotFoundError(path);
      },
      readDir(path) {
        const key = normalize(path);
        if (!overlay.directories.has(key) && !shared.directories.has(key))
          throw new NotFoundError(path);
        const entries = new Map(shared.directories.get(key));
        for (const [name, kind] of overlay.directories.get(key) ?? []) entries.set(name, kind);
        return [...entries].map(([name, kind]) => [kind, name]);
      },
      realpath: normalize,
      writeFile(path, data, append) {
        const key = normalize(path);
        const previous = append ? overlay.files.get(key) : undefined;
        const bytes = new Uint8Array((previous?.length ?? 0) + data.length);
        if (previous) bytes.set(previous);
        bytes.set(data, previous?.length ?? 0);
        overlay.put(key, bytes);
        written.set(key, decoder.decode(bytes));
      },
      remove(path) {
        const key = normalize(path);
        for (const file of overlay.files.keys())
          if (file === key || file.startsWith(key + "/")) {
            overlay.files.delete(file);
            written.delete(file);
          }
        overlay = createIndex(Object.fromEntries(overlay.files));
      },
      chtimes() {},
    };
  };
}
