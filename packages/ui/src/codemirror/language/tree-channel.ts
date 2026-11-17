import { NodeProp, Tree, TreeBuffer, type NodeSet } from "@lezer/common";

export type LanguageKind = "jsx" | "tsx" | "css" | "json";

export type ParseRequest = {
  revision: number;
  base: number;
  path: string;
  kind: LanguageKind;
  source?: string;
  edits?: { from: number; to: number; insert: string }[];
};

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

/** The producer owns reachability; consumers apply ordered node additions and retirements. */
export function createTreeEncoder() {
  let ids = new WeakMap<Tree | TreeBuffer, number>();
  const live = new Map<number, { node: Tree | TreeBuffer; references: number }>();
  let serial = 0;
  let revision = 0;
  let root: number | undefined;

  function release(id: number, retired: number[]) {
    const pending = [id];
    while (pending.length) {
      const id = pending.pop()!;
      const entry = live.get(id)!;
      if (--entry.references) continue;
      live.delete(id);
      retired.push(id);
      if (entry.node instanceof Tree)
        for (const child of entry.node.children) pending.push(ids.get(child)!);
    }
  }

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
    },
    encode(tree: Tree, request: ParseRequest) {
      const visited = new Set<number>();
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
        live.set(id, { node, references: 0 });
        if (node instanceof TreeBuffer) {
          const buffer = node.buffer.slice();
          transfer.push(buffer.buffer);
          records.push({ id, length: node.length, buffer });
        } else {
          for (const child of node.children) live.get(ids.get(child)!)!.references++;
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
      live.get(nextRoot)!.references++;
      const retired: number[] = [];
      if (root !== undefined) release(root, retired);
      root = nextRoot;

      const reply: TreeReply = {
        type: "tree",
        revision: request.revision,
        base: revision,
        path: request.path,
        kind: request.kind,
        root,
        retired,
        records,
      };

      revision = request.revision;
      return { reply, transfer };
    },
  };
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
      if (reply.base !== 0 && reply.base !== revision) throw Error("Missing syntax graph base");
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
      revision = reply.revision;
      return tree;
    },
  };
}
