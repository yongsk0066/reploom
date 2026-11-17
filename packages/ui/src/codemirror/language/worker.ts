import { Text, ChangeSet } from "@codemirror/state";
import { TreeFragment } from "@lezer/common";
import { parser as javascript } from "@lezer/javascript";
import { parser as css } from "@lezer/css";
import { parser as json } from "@lezer/json";
import {
  createTreePublisher,
  type ParseCommand,
  type ParseRequest,
  type ParseReply,
} from "./tree-channel.ts";
import { documentInput } from "./document-input.ts";

const host = self as unknown as {
  onmessage: ((event: MessageEvent<ParseCommand>) => void) | null;
  postMessage(reply: ParseReply, transfer?: Transferable[]): void;
};

const parsers = {
  jsx: javascript.configure({ dialect: "jsx" }),
  tsx: javascript.configure({ dialect: "jsx ts" }),
  css,
  json,
};

const publisher = createTreePublisher((reply, transfer) => host.postMessage(reply, transfer));
let document = Text.empty;
let fragments: readonly TreeFragment[] = [];
let current: ParseRequest | undefined;
let running = false;
let partialRevision: number | undefined;
const channel = new MessageChannel();
let resume: (() => void) | undefined;
channel.port1.onmessage = () => {
  const resolve = resume;
  resume = undefined;
  resolve?.();
};

function yieldTask() {
  return new Promise<void>((resolve) => {
    resume = resolve;
    channel.port2.postMessage(null);
  });
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (current) {
      const request = current;
      const parse = parsers[request.kind].startParse(documentInput(document), fragments);
      const frontier = Math.min(document.length, Math.max(4096, (request.upto ?? 4096) + 1024));

      const partial =
        fragments.length === 0 &&
        document.length > 64_000 &&
        frontier < document.length &&
        partialRevision !== request.revision;

      if (partial) parse.stopAt(frontier);
      let deadline = performance.now() + 4;
      let tree;
      while (!(tree = parse.advance())) {
        if (performance.now() >= deadline) {
          await yieldTask();
          if (current !== request) break;
          deadline = performance.now() + 4;
        }
      }
      if (current !== request) continue;
      if (!tree) continue;
      fragments = TreeFragment.addTree(tree, fragments, partial);
      publisher.publish(tree, request, partial ? frontier : document.length);
      if (partial) {
        partialRevision = request.revision;
        await yieldTask();
        continue;
      }
      return;
    }
  } catch (error) {
    host.postMessage({ type: "error", message: String(error) });
  } finally {
    running = false;
  }
}

host.onmessage = ({ data }) => {
  try {
    if (data.type === "ack") {
      publisher.acknowledge(data);
      return;
    }
    if (data.source !== undefined) {
      document = Text.of(data.source.split("\n"));
      fragments = [];
      publisher.reset();
    } else {
      if (
        !current ||
        data.base !== current.revision ||
        data.path !== current.path ||
        data.kind !== current.kind
      ) {
        host.postMessage({ type: "resync", revision: data.revision });
        return;
      }
      const changes = ChangeSet.of(data.edits ?? [], document.length);
      const ranges: { fromA: number; toA: number; fromB: number; toB: number }[] = [];
      changes.iterChangedRanges((fromA, toA, fromB, toB) =>
        ranges.push({ fromA, toA, fromB, toB }),
      );
      fragments = TreeFragment.applyChanges(fragments, ranges);
      document = changes.apply(document);
    }
    current = {
      revision: data.revision,
      base: data.base,
      path: data.path,
      kind: data.kind,
      upto: data.upto,
    };
    void drain();
  } catch (error) {
    host.postMessage({ type: "error", message: String(error) });
  }
};
