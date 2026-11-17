import { ChangeSet, type Text } from "@codemirror/state";
import { Language, LanguageSupport, ParseContext } from "@codemirror/language";
import {
  Parser,
  type Input,
  type NodeSet,
  type PartialParse,
  type Tree,
  type TreeFragment,
} from "@lezer/common";
import type { LRParser } from "@lezer/lr";
import type { ViewUpdate } from "@codemirror/view";
import {
  createTreeReceiver,
  type LanguageKind,
  type ParseReply,
  type ParseRequest,
} from "./tree-channel.ts";

export type LanguageAnalysisOptions = {
  minCharacters?: number;
  idleMs?: number;
  createWorker?(signal: AbortSignal): Worker | Promise<Worker>;
  onError?(error: unknown): void;
};

type Desired = {
  path: string;
  kind: LanguageKind;
  doc: Text;
  revision: number;
  ready: Promise<void>;
  resolve(): void;
};

async function defaultWorker(signal: AbortSignal) {
  signal.throwIfAborted();
  const { source } = await import("@yongsk0066/reploom-ui/language-worker");
  signal.throwIfAborted();
  const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
  try {
    return new Worker(url, { name: "reploom-language" });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** One active document graph, with incremental source and tree channels in both directions. */
export function createLanguageAnalysis(
  options: LanguageAnalysisOptions = {},
  publish?: (path: string, document: Text) => void,
) {
  options = { ...options };
  const threshold = options.minCharacters ?? 64_000;
  const idleMs = options.idleMs ?? 30_000;
  if (!Number.isFinite(threshold) || threshold < 0 || !Number.isFinite(idleMs) || idleMs < 0)
    throw Error("Invalid language analysis limits");
  const lifetime = new AbortController();
  const receiver = createTreeReceiver();
  const nodeSets = new Map<LanguageKind, NodeSet>();
  let desired: Desired | undefined;
  let result: { path: string; doc: Text; tree: Tree } | undefined;
  let sent: Desired | undefined;
  let patch: { from: Text; to: Text; changes: ChangeSet } | undefined;
  let revision = 0;
  let worker: Worker | undefined;
  let opening: Promise<Worker | undefined> | undefined;
  let boot: AbortController | undefined;
  let active = "";
  let queued = false;
  let disabled = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  function retire() {
    boot?.abort();
    boot = undefined;
    opening = undefined;
    clearTimeout(timer);
    clearTimeout(watchdog);
    timer = watchdog = undefined;
    if (worker) {
      worker.onmessage = worker.onerror = null;
      worker.terminate();
    }
    worker = undefined;
    sent = patch = undefined;
    receiver.reset();
  }

  function fail(error: unknown) {
    retire();
    if (!lifetime.signal.aborted && failures++ === 0) {
      enqueue();
      return;
    }
    disabled = true;
    desired?.resolve();
    options.onError?.(error);
  }

  function receive(message: ParseReply) {
    if (message.type === "error") {
      fail(Error(message.message));
      return;
    }
    if (message.type === "resync") {
      sent = patch = undefined;
      enqueue();
      return;
    }
    try {
      const set = nodeSets.get(message.kind);
      if (!set) throw Error("Unexpected syntax language");
      const tree = receiver.receive(message, set);
      if (desired?.revision !== message.revision || desired.path !== message.path) return;
      clearTimeout(watchdog);
      result = { path: desired.path, doc: desired.doc, tree };
      failures = 0;
      desired.resolve();
      clearTimeout(timer);
      timer = setTimeout(retire, idleMs);
    } catch (error) {
      fail(error);
      return;
    }
    if (result) publish?.(result.path, result.doc);
  }

  async function acquire() {
    if (worker) return worker;
    if (!opening) {
      const controller = new AbortController();
      boot = controller;

      const task = Promise.resolve()
        .then(() => (options.createWorker ?? defaultWorker)(controller.signal))
        .then((created) => {
          if (controller.signal.aborted || lifetime.signal.aborted) {
            created.terminate();
            return undefined;
          }
          worker = created;
          created.onmessage = ({ data }: MessageEvent<ParseReply>) => {
            if (worker === created) receive(data);
          };
          created.onerror = () => {
            if (worker === created) fail(Error("Language Worker stopped"));
          };
          return created;
        })
        .catch((error) => {
          if (controller.signal.aborted || lifetime.signal.aborted) return undefined;
          throw error;
        })
        .finally(() => {
          if (opening === task) opening = undefined;
          if (boot === controller) boot = undefined;
        });

      opening = task;
    }
    return opening;
  }

  async function flush() {
    try {
      const target = await acquire();
      if (
        !target ||
        worker !== target ||
        disabled ||
        lifetime.signal.aborted ||
        !desired ||
        sent?.revision === desired.revision
      )
        return;
      const next = desired;

      const incremental =
        sent &&
        sent.path === next.path &&
        sent.kind === next.kind &&
        patch?.from === sent.doc &&
        patch.to === next.doc;

      const edits: NonNullable<ParseRequest["edits"]> = [];
      if (incremental)
        patch!.changes.iterChanges((from, to, _from, _to, insert) =>
          edits.push({ from, to, insert: insert.toString() }),
        );

      const command: ParseRequest = {
        revision: next.revision,
        path: next.path,
        kind: next.kind,
        base: incremental ? sent!.revision : 0,
        ...(incremental ? { edits } : { source: next.doc.toString() }),
      };

      sent = next;
      patch = undefined;
      clearTimeout(watchdog);
      watchdog = setTimeout(() => fail(Error("Language analysis timed out")), 10_000);
      target.postMessage(command);
    } catch (error) {
      if (
        !lifetime.signal.aborted &&
        !(error instanceof DOMException && error.name === "AbortError")
      )
        fail(error);
    }
  }

  function enqueue() {
    if (queued || disabled || lifetime.signal.aborted) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!disabled && !lifetime.signal.aborted) void flush();
    });
  }

  function request(path: string, kind: LanguageKind, doc: Text) {
    clearTimeout(timer);
    if (desired?.path === path && desired.doc === doc) return desired;
    desired?.resolve();
    let resolve!: () => void;

    const ready = new Promise<void>((done) => {
      resolve = done;
    });

    desired = { path, kind, doc, revision: ++revision, ready, resolve };
    enqueue();
    return desired;
  }

  function read(path: string, kind: LanguageKind, doc: Text) {
    if (disabled || lifetime.signal.aborted || doc.length < threshold) return undefined;
    if (result?.path === path && result.doc === doc) return result.tree;
    return request(path, kind, doc).ready;
  }

  return {
    activate(path: string) {
      if (active === path) return;
      active = path;
      desired?.resolve();
      retire();
      desired = result = undefined;
    },
    support(path: string, kind: LanguageKind, standard: LanguageSupport) {
      const base = standard.language.parser as LRParser;
      nodeSets.set(kind, base.nodeSet);

      const parser = new (class extends Parser {
        createParse(
          input: Input,
          fragments: readonly TreeFragment[],
          ranges: readonly { from: number; to: number }[],
        ): PartialParse {
          const context = ParseContext.get();
          const value = context && read(path, kind, context.state.doc);
          if (!value) return base.createParse(input, fragments, ranges);
          if (value instanceof Promise)
            return ParseContext.getSkippingParser(value).createParse(input, fragments, ranges);
          return { parsedPos: input.length, stoppedAt: null, stopAt() {}, advance: () => value };
        }
      })();

      return new LanguageSupport(
        new Language(standard.language.data, parser, [], standard.language.name),
        standard.support,
      );
    },
    update(path: string, kind: LanguageKind, update: ViewUpdate) {
      if (!update.docChanged || disabled || lifetime.signal.aborted) return;
      if (update.state.doc.length < threshold) {
        if (desired || worker || opening) {
          desired?.resolve();
          retire();
          desired = result = undefined;
        }
        return;
      }
      const before = update.startState.doc;
      const after = update.state.doc;
      if (sent?.path === path && sent.doc === before)
        patch = { from: before, to: after, changes: update.changes };
      else if (patch?.to === before)
        patch = { from: patch.from, to: after, changes: patch.changes.compose(update.changes) };
      else patch = undefined;
      request(path, kind, after);
    },
    dispose() {
      if (lifetime.signal.aborted) return;
      lifetime.abort();
      desired?.resolve();
      retire();
      desired = result = undefined;
      nodeSets.clear();
    },
  };
}
