import {
  diffProgram,
  type VersionedProgram,
  type ArtifactRequest,
  type ArtifactReply,
  type ProgramPatch,
} from "./protocol.ts";

/** Data stays in the compiler realm; the UI authorizes only a revision. */
export function createArtifactPublisher(read: (projectId: string) => VersionedProgram | undefined) {
  const connections = new Map<string, { generation: string; port: MessagePort }>();

  const disconnect = (projectId: string, generation?: string) => {
    const connection = connections.get(projectId);
    if (!connection || (generation && connection.generation !== generation)) return;
    connection.port.onmessage = null;
    connection.port.close();
    connections.delete(projectId);
  };

  return {
    connect(projectId: string, generation: string, port: MessagePort) {
      disconnect(projectId);
      const connection = { generation, port };
      connections.set(projectId, connection);
      let delivered: VersionedProgram | undefined;
      port.onmessage = ({ data }: MessageEvent<ArtifactRequest>) => {
        if (
          connections.get(projectId) !== connection ||
          data?.type !== "get" ||
          !Number.isSafeInteger(data.revision) ||
          data.revision < 0
        )
          return;
        const next = read(projectId);
        let reply: ArtifactReply;
        if (!next || next.revision < data.revision)
          reply = { type: "missing", revision: data.revision };
        else if (next.revision > data.revision)
          reply = { type: "superseded", revision: data.revision };
        else {
          reply = {
            type: "artifact",
            patch: diffProgram(
              delivered?.revision === data.baseRevision && delivered.revision < next.revision
                ? delivered
                : undefined,
              next,
            ),
          };
          delivered = next;
        }
        port.postMessage(reply);
      };
    },
    disconnect,
    dispose() {
      for (const id of connections.keys()) disconnect(id);
    },
  };
}

export class ArtifactUnavailable extends Error {
  readonly reason: "missing" | "superseded";

  constructor(reason: "missing" | "superseded") {
    super(reason);
    this.reason = reason;
  }
}

export function createArtifactReceiver() {
  let port: MessagePort | undefined;
  let closed = false;
  let pending:
    | {
        request: ArtifactRequest;
        resolve(patch: ProgramPatch): void;
        reject(error: Error): void;
      }
    | undefined;

  const send = () => {
    if (port && pending) port.postMessage(pending.request);
  };

  return {
    connect(next: MessagePort) {
      if (closed) {
        next.close();
        return;
      }
      if (port) {
        port.onmessage = null;
        port.close();
      }
      port = next;
      next.onmessage = ({ data }: MessageEvent<ArtifactReply>) => {
        if (port !== next || !pending) return;
        const revision = data?.type === "artifact" ? data.patch.revision : data?.revision;
        if (revision !== pending.request.revision) return;
        const request = pending;
        pending = undefined;
        if (data.type === "artifact") request.resolve(data.patch);
        else request.reject(new ArtifactUnavailable(data.type));
      };
      send();
    },
    get(revision: number, baseRevision: number | null) {
      if (closed) return Promise.reject(new Error("Artifact connection disposed"));
      if (pending) return Promise.reject(new Error("An artifact request is already in flight"));
      return new Promise<ProgramPatch>((resolve, reject) => {
        pending = {
          request: { type: "get", revision, baseRevision },
          resolve,
          reject,
        };
        send();
      });
    },
    dispose() {
      closed = true;
      pending?.reject(new Error("Artifact connection disposed"));
      pending = undefined;
      if (port) {
        port.onmessage = null;
        port.close();
      }
      port = undefined;
    },
  };
}
