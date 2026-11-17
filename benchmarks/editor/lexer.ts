import { parser as javascript } from "@lezer/javascript";
import { parser as json } from "@lezer/json";
import { parser as css } from "@lezer/css";
import { TreeFragment, NodeProp, type Tree, type Input } from "@lezer/common";

const parsers = { js: javascript, tsx: javascript.configure({ dialect: "ts jsx" }), json, css };

function input(source: string, chunkSize: number): Input {
  return {
    length: source.length,
    chunk: (from) => source.slice(from, from + chunkSize),
    read: (from, to) => source.slice(from, to),
  };
}

function identity(tree: Tree) {
  let nodes = 0;
  let hash = 2166136261;
  const shape: number[][] = [];
  tree.iterate({
    enter(node) {
      nodes++;
      shape.push([node.type.id, node.from, node.to]);
      for (const n of [node.type.id, node.from, node.to]) hash = Math.imul(hash ^ n, 16777619);
    },
  });
  const properties: number[][] = [];

  function visit(tree: Tree, start: number) {
    for (const [id, prop] of [NodeProp.lookAhead, NodeProp.contextHash].entries()) {
      const value = tree.prop(prop);
      if (value !== undefined) properties.push([id, start, tree.length, value]);
    }
    tree.children.forEach((child, i) => {
      if ("children" in child) visit(child, start + tree.positions[i]);
    });
  }

  visit(tree, 0);
  return { length: tree.length, nodes, hash: hash >>> 0, shape, properties };
}

export function parseCase(
  kind: keyof typeof parsers,
  source: string,
  chunkSize = source.length || 1,
  ranges?: { from: number; to: number }[],
) {
  return identity(parsers[kind].parse(input(source, chunkSize), [], ranges));
}

export function editCase(
  kind: keyof typeof parsers,
  source: string,
  edits: { from: number; to: number; insert: string }[],
  chunkSize: number,
) {
  const parser = parsers[kind];
  let tree = parser.parse(input(source, chunkSize));
  const result = [identity(tree)];
  let fragments = TreeFragment.addTree(tree);
  for (const edit of edits) {
    fragments = TreeFragment.applyChanges(fragments, [
      {
        fromA: edit.from,
        toA: edit.to,
        fromB: edit.from,
        toB: edit.from + edit.insert.length,
      },
    ]);
    source = source.slice(0, edit.from) + edit.insert + source.slice(edit.to);
    tree = parser.parse(input(source, chunkSize), fragments);
    result.push(identity(tree));
    fragments = TreeFragment.addTree(tree, fragments);
  }
  return result;
}

export function measure(kind: keyof typeof parsers, source: string, iterations = 20) {
  for (let i = 0; i < 3; i++) parsers[kind].parse(source);
  const samples = [];
  const batchStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const tree = parsers[kind].parse(source);
    samples.push({ ms: performance.now() - start, length: tree.length });
  }
  return { samples, perParseMs: (performance.now() - batchStart) / iterations };
}
