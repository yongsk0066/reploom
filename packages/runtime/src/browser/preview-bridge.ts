import {
  PROTOCOL,
  isProgramReference,
  diffProgram,
  type Diagnostic,
  type PreviewCommand,
  type PreviewReply,
  type PreviewEvent,
  type Snapshot,
  type Inspection,
  type InspectionResult,
} from "../shared/protocol.ts";
import type { ManagedState } from "../project/snapshot.ts";
import type { ArtifactConnection } from "./preview-destinations.ts";

export type ArtifactConnector = (
  projectId: string,
  generation: string,
  open: () => MessagePort,
  signal: AbortSignal,
) => Promise<ArtifactConnection | undefined>;

type Connection = {
  frame: HTMLIFrameElement;
  generation: string;
  port?: MessagePort;
  ready: boolean;
  initialized: boolean;
  acknowledged?: Snapshot;
  artifacts?: ArtifactConnection;
  lifetime: AbortController;
  inFlight?: Snapshot;
  timer?: ReturnType<typeof setTimeout>;
  disposing?: Promise<Diagnostic[]>;
  finishDispose?: (diagnostics: Diagnostic[]) => void;
  loaded: boolean;
  blocked: boolean;
};

// Owns the iframe, transport and teardown independently of the host UI.
export class PreviewBridge {
  private inspections = new Map<
    string,
    { revision: number; finish(result?: InspectionResult, error?: unknown): void }
  >();
  private connection?: Connection;
  private latest?: Snapshot;
  private replacing = false;
  private closed = false;
  private title: string;
  private presentation: import("../shared/presentation.ts").PreviewPresentation = {};

  private language() {
    const requested =
      this.presentation.language || this.host.ownerDocument.documentElement.lang || "en";

    try {
      return Intl.getCanonicalLocales(requested)[0] || "en";
    } catch {
      return "en";
    }
  }

  private present(c: Connection) {
    this.post(c, {
      protocol: PROTOCOL,
      generation: c.generation,
      type: "presentation",
      language: this.language(),
      title: this.title,
      compute: this.presentation.compute,
    });
  }

  setPresentation(presentation: import("../shared/presentation.ts").PreviewPresentation) {
    if (
      this.presentation.language === presentation.language &&
      this.presentation.compute === presentation.compute
    )
      return;
    this.presentation = presentation;
    if (this.connection?.ready) this.present(this.connection);
  }

  private readonly host: HTMLElement;
  private readonly onEvent: (event: PreviewEvent) => void;
  private readonly connectArtifacts?: ArtifactConnector;

  constructor(
    host: HTMLElement,
    title: string,
    onEvent: (event: PreviewEvent) => void,
    connectArtifacts?: ArtifactConnector,
  ) {
    this.host = host;
    this.title = title;
    this.onEvent = onEvent;
    this.connectArtifacts = connectArtifacts;
  }

  update(snapshot: Snapshot, title = this.title) {
    if (this.closed) return;
    if (
      snapshot.revision !== this.latest?.revision ||
      snapshot.generation !== this.latest?.generation
    )
      this.cancelInspections();
    this.latest = snapshot;
    const renamed = this.title !== title;
    this.title = title;
    if (this.connection) {
      this.connection.frame.title = title;
      if (renamed && this.connection.ready) this.present(this.connection);
    }
    if (this.connection?.generation !== snapshot.generation) void this.replace();
    else {
      const c = this.connection;
      if (
        c?.inFlight &&
        c.inFlight.revision < snapshot.revision &&
        snapshot.program.runtime === "compute"
      )
        this.post(c, {
          protocol: PROTOCOL,
          generation: c.generation,
          type: "cancel",
          revision: c.inFlight.revision,
        });
      this.flush();
    }
  }

  private post(connection: Connection, command: PreviewCommand) {
    connection.port?.postMessage(command);
  }

  private requireRestart(
    connection: Connection,
    revision: number,
    state?: import("../project/snapshot.ts").ManagedState,
  ) {
    connection.blocked = true;
    this.onEvent({
      type: "restart-required",
      generation: connection.generation,
      revision,
      state,
    });
  }

  private arm(connection: Connection) {
    clearTimeout(connection.timer);
    connection.timer = setTimeout(() => {
      if (this.closed || connection !== this.connection || connection.disposing) return;
      this.requireRestart(connection, connection.inFlight?.revision ?? this.latest!.revision);
      this.onEvent({
        type: "runtime-error",
        revision: connection.inFlight?.revision ?? this.latest!.revision,
        diagnostics: [{ text: "The preview timed out. Run the project again." }],
        requiresRestart: true,
      });
    }, 15_000);
  }

  private flush(full = false) {
    const c = this.connection;
    const next = this.latest;

    if (
      !c ||
      !next ||
      c.disposing ||
      c.blocked ||
      !c.ready ||
      c.inFlight ||
      next.generation !== c.generation
    )
      return;
    if (!full && c.acknowledged && c.acknowledged.revision >= next.revision) return;
    if (isProgramReference(next.program)) {
      if (!c.artifacts) return;
      c.artifacts.ensure();
      c.inFlight = next;
      this.arm(c);
      this.post(c, {
        protocol: PROTOCOL,
        generation: c.generation,
        type: "apply-reference",
        revision: next.revision,
        reference: next.program,
        ...(!c.initialized
          ? {
              initialize: {
                vendor: next.vendor,
                worker: next.worker,
                assets: next.assets,
                state: next.state,
              },
            }
          : {}),
      });
      c.initialized = true;
      return;
    }

    const acknowledged =
      !full && c.acknowledged && !isProgramReference(c.acknowledged.program)
        ? { revision: c.acknowledged.revision, program: c.acknowledged.program }
        : undefined;

    const patch = diffProgram(acknowledged, {
      revision: next.revision,
      program: next.program,
    });

    c.inFlight = next;
    this.arm(c);
    const envelope = { protocol: PROTOCOL, generation: c.generation };
    if (!c.initialized) {
      c.initialized = true;
      this.post(c, {
        ...envelope,
        type: "initialize",
        vendor: next.vendor,
        worker: next.worker,
        assets: next.assets,
        state: next.state,
        patch,
      });
    } else this.post(c, { ...envelope, type: "apply", patch });
  }

  private async replace() {
    if (this.replacing || this.closed) return;
    this.replacing = true;
    try {
      if (this.connection) {
        const diagnostics = await this.close(this.connection, true);
        if (!this.closed && this.latest && diagnostics.length)
          this.onEvent({
            type: "console",
            revision: this.latest.revision,
            text: `[Disposal notice] ${diagnostics
              .map((item) => item.text)
              .join("\n")
              .slice(0, 3900)}`,
          });
      }
      if (this.closed || !this.latest) return;

      const snapshot = this.latest;
      const frame = document.createElement("iframe");

      const c: Connection = {
        frame,
        generation: snapshot.generation,
        lifetime: new AbortController(),
        ready: false,
        initialized: false,
        loaded: false,
        blocked: false,
      };

      this.connection = c;
      frame.title = this.title;
      // Local submit handlers need form semantics; CSP form-action still denies navigation.
      frame.setAttribute("sandbox", "allow-scripts allow-forms");
      frame.referrerPolicy = "no-referrer";
      const compute = snapshot.program.runtime === "compute";
      const nested = !!snapshot.program.resources?.workers;
      const csp = `default-src 'none'; script-src 'nonce-${c.generation}'${compute || nested ? " blob:" : ""}; worker-src ${compute || nested ? "blob:" : "'none'"}; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src blob:; base-uri 'none'; form-action 'none';`;
      frame.srcdoc = `<!doctype html><html lang="${this.language()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>Code preview</title></head><body><div id="root"></div><script nonce="${c.generation}">${snapshot.bootstrap.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
      const projectId = snapshot.projectId;
      frame.onload = () => {
        if (this.closed || c.disposing || this.connection !== c) return;
        if (c.loaded) {
          this.requireRestart(c, this.latest!.revision);
          this.onEvent({
            type: "runtime-error",
            revision: this.latest!.revision,
            diagnostics: [{ text: "The preview navigated away. Run the project again." }],
            requiresRestart: true,
          });
          void this.close(c, false);
          return;
        }
        c.loaded = true;
        const channel = new MessageChannel();
        c.port = channel.port1;
        channel.port1.onmessage = ({ data }: MessageEvent<PreviewReply>) =>
          this.receive(c, data, projectId);
        this.arm(c);
        frame.contentWindow?.postMessage(
          {
            type: "playground:init",
            protocol: PROTOCOL,
            generation: c.generation,
          },
          "*",
          [channel.port2],
        );
      };
      this.host.append(frame);
      this.arm(c);
    } finally {
      this.replacing = false;
    }
  }

  private connectArtifactPort(c: Connection, projectId: string | undefined) {
    if (this.connectArtifacts && projectId) {
      void this.connectArtifacts(
        projectId,
        c.generation,
        () => {
          const channel = new MessageChannel();
          c.port!.postMessage(
            {
              protocol: PROTOCOL,
              generation: c.generation,
              type: "connect-artifacts",
            } satisfies PreviewCommand,
            [channel.port2],
          );
          return channel.port1;
        },
        c.lifetime.signal,
      )
        .then((connection) => {
          if (c.lifetime.signal.aborted) connection?.close();
          else {
            c.artifacts = connection;
            this.flush();
          }
        })
        .catch((error) => {
          if (!c.lifetime.signal.aborted)
            this.onEvent({
              type: "runtime-error",
              revision: this.latest!.revision,
              requiresRestart: true,
              diagnostics: [{ text: String(error) }],
            });
        });
    }
  }

  private receive(c: Connection, data: PreviewReply, projectId: string | undefined) {
    if (data?.protocol !== PROTOCOL || data.generation !== c.generation || this.connection !== c)
      return;
    if (data.type === "disposed") {
      c.finishDispose?.(data.diagnostics);
      return;
    }
    if (c.disposing || this.closed) return;
    if (data.type === "inspection") {
      const pending = this.inspections.get(data.id);
      if (pending?.revision === data.revision) pending.finish(data.result);
      return;
    }
    if (data.type === "ready") {
      c.ready = true;
      this.present(c);
      this.connectArtifactPort(c, projectId);
      this.flush();
    } else if (data.type === "request-program") {
      if (data.revision !== c.inFlight?.revision) return;
      c.inFlight = undefined;
      c.initialized = false;
      clearTimeout(c.timer);
      this.onEvent({ ...data });
    } else if (data.type === "resync") {
      c.inFlight = undefined;
      c.acknowledged = undefined;
      this.flush(true);
    } else {
      this.receiveRuntime(c, data);
    }
  }

  private receiveRuntime(c: Connection, data: import("../shared/protocol.ts").RuntimeEvent) {
    if (data.type === "settled") {
      if (data.revision !== c.inFlight?.revision) return;
      c.acknowledged = c.inFlight;
      c.artifacts?.acknowledge?.(data.revision);
      c.inFlight = undefined;
      clearTimeout(c.timer);
    }
    if ("requiresRestart" in data && data.requiresRestart)
      this.requireRestart(c, data.revision, data.state);
    if (data.revision === this.latest?.revision) this.onEvent(data);
    if (data.type === "runtime-error" && data.requiresRestart) void this.close(c, false);
    if (data.type === "settled") this.flush();
  }

  private close(c: Connection, graceful: boolean): Promise<Diagnostic[]> {
    if (c.disposing) return c.disposing;
    c.lifetime.abort();
    this.cancelInspections();
    c.artifacts?.close();
    clearTimeout(c.timer);
    c.disposing = new Promise((resolve) => {
      let completed = false;
      c.finishDispose = (diagnostics) => {
        if (completed) return;
        completed = true;
        clearTimeout(c.timer);
        c.port?.close();
        c.frame.onload = null;
        c.frame.remove();
        if (this.connection === c) this.connection = undefined;
        resolve(diagnostics);
      };
      if (graceful && c.port && c.frame.isConnected) {
        c.timer = setTimeout(
          () =>
            c.finishDispose?.([
              {
                text: "The preview did not acknowledge disposal; its document was removed.",
                phase: "cleanup",
              },
            ]),
          500,
        );
        this.post(c, {
          protocol: PROTOCOL,
          type: "dispose",
          generation: c.generation,
        });
      } else c.finishDispose([]);
    });
    return c.disposing;
  }

  async dispose(graceful = true): Promise<Diagnostic[]> {
    this.closed = true;
    this.latest = undefined;
    return this.connection ? this.close(this.connection, graceful) : [];
  }

  private cancelInspections() {
    for (const pending of this.inspections.values())
      pending.finish(undefined, new DOMException("Preview changed", "AbortError"));
  }

  inspect(request: Inspection, signal: AbortSignal): Promise<InspectionResult> {
    const c = this.connection;
    if (
      this.closed ||
      signal.aborted ||
      !c?.acknowledged ||
      c.inFlight ||
      c.blocked ||
      c.disposing ||
      c.acknowledged.revision !== this.latest?.revision
    )
      return Promise.reject(new Error("Inspection requires a settled preview"));
    if (this.inspections.size) return Promise.reject(new Error("An inspection is already running"));
    const revision = c.acknowledged.revision;
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => finish(undefined, signal.reason);

      const timer = setTimeout(
        () => finish(undefined, new Error("Preview inspection timed out")),
        5000,
      );

      const finish = (result?: InspectionResult, error?: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.inspections.delete(id);
        if (error) reject(error);
        else if (result?.diagnostics.length)
          reject(new Error(result.diagnostics.map((item) => item.text).join("\n")));
        else resolve(result!);
      };

      this.inspections.set(id, { revision, finish });
      signal.addEventListener("abort", abort, { once: true });
      this.post(c, {
        protocol: PROTOCOL,
        generation: c.generation,
        type: "inspect",
        id,
        revision,
        request,
      });
    });
  }

  async captureState(signal: AbortSignal): Promise<ManagedState> {
    return (await this.inspect({ operation: "state" }, signal)).state!;
  }
}
