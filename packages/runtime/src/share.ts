import { readArchive, type ProjectArchive } from "./project/snapshot.ts";

export type PlaygroundView = "code" | "preview" | "split";

export type SharedProject = { view: PlaygroundView; archive: ProjectArchive };

const prefix = "#reploom=1.";
const maxFragment = 64 * 1024;
const maxBytes = 5 * 1024 * 1024;

async function readBytes(stream: ReadableStream<Uint8Array>, limit: number, signal?: AbortSignal) {
  const reader = stream.getReader();

  const abort = () => {
    void reader.cancel(signal?.reason);
  };

  signal?.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.length;
      if (size > limit) throw new RangeError("Shared project exceeds the link size limit");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export async function encodeProjectFragment(
  { view, archive }: SharedProject,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const blob = new Blob([JSON.stringify(archive)]);
  if (blob.size > maxBytes) throw new RangeError("Shared project exceeds the archive size limit");
  const header = prefix + view + ".";
  const limit = Math.floor(((maxFragment - header.length) * 3) / 4);

  const bytes = await readBytes(
    blob.stream().pipeThrough(new CompressionStream("gzip")),
    limit,
    signal,
  );

  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return header + btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function decodeProjectFragment(
  hash: string,
  signal?: AbortSignal,
): Promise<SharedProject> {
  signal?.throwIfAborted();
  if (hash.length > maxFragment) throw new RangeError("Shared project exceeds the link size limit");
  const match = /^#reploom=1\.(code|preview|split)\.([A-Za-z0-9_-]+)$/.exec(hash);
  if (!match) throw new Error("Invalid project link");
  const binary = atob(match[2].replaceAll("-", "+").replaceAll("_", "/"));
  const compressed = Uint8Array.from(binary, (c) => c.charCodeAt(0));

  const bytes = await readBytes(
    new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip")),
    maxBytes,
    signal,
  );

  const archive: ProjectArchive = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );

  // The session separately checks this portable archive against the installed project.
  if (
    archive?.schema !== 1 ||
    typeof archive.project !== "string" ||
    typeof archive.projectKey !== "string" ||
    !archive.projectKey ||
    typeof archive.active !== "string" ||
    !/^[\w-]+$/.test(archive.project)
  )
    throw new Error("Invalid shared project");
  return {
    view: match[1] as PlaygroundView,
    archive: readArchive(archive, archive.project, archive.projectKey, archive.active),
  };
}
