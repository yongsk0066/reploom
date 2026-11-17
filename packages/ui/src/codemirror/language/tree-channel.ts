import { NodeProp, Tree, TreeBuffer, type NodeSet } from "@lezer/common";

export type LanguageKind = "jsx" | "tsx" | "css" | "json";

export type ParseRequest = {
  type?: "parse";
  revision: number;
  base: number;
  path: string;
  kind: LanguageKind;
  upto?: number;
  source?: string;
  edits?: { from: number; to: number; insert: string }[];
};

export type TreeAcknowledgement = { type: "ack"; version: number; accepted: boolean };

export type ParseCommand = ParseRequest | TreeAcknowledgement;

type TreeRecord =
  | {
      id: number;
      length: number;
      type: number;
      children: number[];
      positions: readonly number[];
      context?: number;
      lookAhead?: number;
    }
  | { id: number; length: number; buffer: Uint16Array };

export type TreeReply = {
  type: "tree";
  revision: number;
  version: number;
  parsed: number;
  base: number;
  path: string;
  kind: LanguageKind;
  root: number;
  retired: number[];
  records: TreeRecord[];
};

export type ParseReply =
  | TreeReply
  | { type: "resync"; revision: number }
  | { type: "error"; message: string };

function materialize(record: TreeRecord, set: NodeSet, child: (id: number) => Tree | TreeBuffer) {
  if ("buffer" in record) return new TreeBuffer(record.buffer, record.length, set);
  const props: [NodeProp<number>, number][] = [];
  if (record.context !== undefined) props.push([NodeProp.contextHash, record.context]);
  if (record.lookAhead !== undefined) props.push([NodeProp.lookAhead, record.lookAhead]);
  const type = set.types[record.type];
  if (!type) throw Error("Unknown syntax node type");
  return new Tree(type, record.children.map(child), record.positions, record.length, props);
}

/** Staged graphs retain their acknowledged base until the consumer accepts a replacement. */
export function createTreeEncoder() {
  let ids = new WeakMap<Tree | TreeBuffer, number>();
  const live = new Map<number, { node: Tree | TreeBuffer; references: number }>();
  let serial = 0;
  let serialVersion = 0;
  let revision = 0;
  let root: number | undefined;
  let generation = 0;

  return {
    get retainedNodes() {
      return live.size;
    },
    reset() {
      ids = new WeakMap();
      live.clear();
      revision = 0;
      serial = 0;
      root = undefined;
      generation++;
    },
    encode(tree: Tree, request: ParseRequest, parsed = tree.length) {
      const staged = this.stage(tree, request, parsed);
      staged.commit();
      return { reply: staged.reply, transfer: staged.transfer };
    },
    stage(tree: Tree, request: ParseRequest, parsed = tree.length) {
      const baseGeneration = generation;
      const visited = new Set<number>();
      const added = new Map<number, { node: Tree | TreeBuffer; references: number }>();
      const references = new Map<number, number>();

      const reference = (id: number, change: number) =>
        references.set(id, (references.get(id) ?? 0) + change);

      const records: TreeRecord[] = [];
      const transfer: ArrayBuffer[] = [];
      const pending: { node: Tree | TreeBuffer; exit: boolean }[] = [{ node: tree, exit: false }];
      while (pending.length) {
        const { node, exit } = pending.pop()!;
        let id = ids.get(node);
        if (id === undefined) {
          id = ++serial;
          ids.set(node, id);
        }
        if (!exit) {
          if (live.has(id) || visited.has(id)) continue;
          visited.add(id);
          pending.push({ node, exit: true });
          if (node instanceof Tree)
            for (const child of node.children) pending.push({ node: child, exit: false });
          continue;
        }
        added.set(id, { node, references: 0 });
        if (node instanceof TreeBuffer) {
          const buffer = node.buffer.slice();
          transfer.push(buffer.buffer);
          records.push({ id, length: node.length, buffer });
        } else {
          for (const child of node.children) reference(ids.get(child)!, 1);
          records.push({
            id,
            length: node.length,
            type: node.type.id,
            children: node.children.map((child) => ids.get(child)!),
            positions: node.positions,
            context: node.prop(NodeProp.contextHash),
            lookAhead: node.prop(NodeProp.lookAhead),
          });
        }
      }

      const nextRoot = ids.get(tree)!;
      reference(nextRoot, 1);
      const retired: number[] = [];
      const releasing = root === undefined ? [] : [root];
      while (releasing.length) {
        const id = releasing.pop()!;
        const entry = live.get(id)!;
        reference(id, -1);
        if (entry.references + references.get(id)!) continue;
        retired.push(id);
        if (entry.node instanceof Tree)
          for (const child of entry.node.children) releasing.push(ids.get(child)!);
      }

      const reply: TreeReply = {
        type: "tree",
        revision: request.revision,
        version: ++serialVersion,
        parsed,
        base: revision,
        path: request.path,
        kind: request.kind,
        root: nextRoot,
        retired,
        records,
      };

      return {
        reply,
        transfer,
        commit() {
          if (generation !== baseGeneration) throw Error("Stale syntax graph transaction");
          for (const [id, entry] of added) live.set(id, entry);
          for (const [id, change] of references) live.get(id)!.references += change;
          for (const id of retired) live.delete(id);
          root = nextRoot;
          revision = reply.version;
          generation++;
        },
      };
    },
  };
}

/** One in-flight graph and one latest candidate; rejected results never become delta bases. */
export function createTreePublisher(send: (reply: TreeReply, transfer: ArrayBuffer[]) => void) {
  const encoder = createTreeEncoder();
  let generation = 0;
  let pending: { tree: Tree; request: ParseRequest; parsed: number } | undefined;
  let flight: { version: number; generation: number; commit(): void } | undefined;

  function flush() {
    if (flight || !pending) return;
    const { tree, request, parsed } = pending;
    pending = undefined;
    const staged = encoder.stage(tree, request, parsed);
    flight = { version: staged.reply.version, generation, commit: staged.commit };
    send(staged.reply, staged.transfer);
  }

  return {
    publish(tree: Tree, request: ParseRequest, parsed = tree.length) {
      pending = { tree, request, parsed };
      flush();
    },
    acknowledge(message: TreeAcknowledgement) {
      if (!flight || flight.version !== message.version) return;
      if (message.accepted && flight.generation === generation) flight.commit();
      flight = undefined;
      flush();
    },
    reset() {
      generation++;
      pending = undefined;
      encoder.reset();
    },
  };
}

function validateTreeVersion(reply: TreeReply, current: number) {
  if (reply.base !== 0 && reply.base !== current) throw Error("Missing syntax graph base");
  if (!Number.isSafeInteger(reply.version) || reply.version <= reply.base)
    throw Error("Invalid syntax graph version");
}

export function createTreeReceiver() {
  let nodes = new Map<number, Tree | TreeBuffer>();
  let revision = 0;
  return {
    get retainedNodes() {
      return nodes.size;
    },
    reset() {
      nodes.clear();
      revision = 0;
    },
    receive(reply: TreeReply, set: NodeSet) {
      validateTreeVersion(reply, revision);
      const previous = reply.base === 0 ? undefined : nodes;
      const added = new Map<number, Tree | TreeBuffer>();
      const retired = new Set(reply.retired);
      const roots = new Set<number>();

      const child = (id: number) => {
        const node = added.get(id) ?? previous?.get(id);
        if (!node || retired.has(id)) throw Error("Missing syntax child");
        roots.delete(id);
        return node;
      };

      for (const record of reply.records) {
        if (added.has(record.id) || previous?.has(record.id) || retired.has(record.id))
          throw Error("Duplicate syntax identity");
        added.set(record.id, materialize(record, set, child));
        roots.add(record.id);
      }
      const tree = added.get(reply.root) ?? previous?.get(reply.root);
      if (!(tree instanceof Tree) || retired.has(reply.root)) throw Error("Invalid syntax root");
      roots.delete(reply.root);
      if (roots.size) throw Error("Unreachable syntax records");
      for (const id of retired) if (!previous?.has(id)) throw Error("Missing retired syntax node");
      if (!previous) nodes = new Map();
      for (const id of retired) nodes.delete(id);
      for (const [id, node] of added) nodes.set(id, node);
      revision = reply.version;
      return tree;
    },
  };
}
