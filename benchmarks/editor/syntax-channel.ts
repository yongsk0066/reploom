import { parser as javascript } from "@lezer/javascript";
import { parser as json } from "@lezer/json";
import { TreeFragment } from "@lezer/common";
import * as codec from "../../packages/ui/src/codemirror/language/tree-channel.ts";

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const countNodes = (tree: any) => {
  const seen = new Set();
  const pending = [tree];
  while (pending.length) {
    const next = pending.pop();
    if (seen.has(next)) continue;
    seen.add(next);
    if (next.children) pending.push(...next.children);
  }
  return seen.size;
};

async function runSyntaxChannel() {
  const cases = [
    {
      name: "declarations-689k",
      parser: javascript,
      source: Array.from({ length: 35000 }, (_, i) => `const v${i}=12345;`).join("\n"),
    },
    { name: "json-500k", parser: json, source: "[\n" + " 12345,\n".repeat(62000) + "0\n]" },
    {
      name: "string-900k",
      parser: javascript,
      source: 'export const text="12345' + "a".repeat(899950) + '";',
    },
  ];

  const observations = [];
  for (const test of cases) {
    const pos = test.source.indexOf("12345");
    const first = test.parser.parse(test.source);

    const second = test.parser.parse(
      test.source.slice(0, pos) + "2" + test.source.slice(pos + 1),
      TreeFragment.applyChanges(TreeFragment.addTree(first), [
        { fromA: pos, toA: pos + 1, fromB: pos, toB: pos + 1 },
      ]),
    );

    const expected = second.toString();
    for (let round = 0; round < 7; round++) {
      for (const variant of ["current"]) {
        const encoder = codec.createTreeEncoder();
        const receiver = codec.createTreeReceiver();
        const initial = encoder.encode(first, { revision: 1, base: 0, path: "/test", kind: "jsx" });
        receiver.receive(
          structuredClone(initial.reply, { transfer: initial.transfer }),
          test.parser.nodeSet,
        );
        let encode = 0;
        let clone = 0;
        let decode = 0;
        let tree: any;
        let payload: any;
        for (let i = 0; i < 250; i++) {
          const start = performance.now();

          const result = encoder.encode(i % 2 ? first : second, {
            revision: i + 2,
            base: i + 1,
            path: "/test",
            kind: "jsx",
          });

          const encoded = performance.now();
          const message = structuredClone(result.reply, { transfer: result.transfer });
          const cloned = performance.now();
          tree = receiver.receive(message, test.parser.nodeSet);
          const decoded = performance.now();
          encode += encoded - start;
          clone += cloned - encoded;
          decode += decoded - cloned;
          if (i === 0)
            payload = {
              records: message.records.length,
              indexEntries: ("live" in message ? message.live : message.retired).length,
              bufferBytes: message.records.reduce(
                (n, r) => n + ("buffer" in r ? r.buffer.byteLength : 0),
                0,
              ),
              metadataBytes: JSON.stringify(message, (_key, v) =>
                v instanceof Uint16Array ? { bytes: v.byteLength } : v,
              ).length,
            };
          if (i === 0 && tree.toString() !== expected) throw Error("Syntax mismatch");
        }
        const logical = countNodes(first);
        if (tree.toString() !== first.toString()) throw Error("Final syntax mismatch");
        if (encoder.retainedNodes !== logical || receiver.retainedNodes !== logical)
          throw Error("Retained graph differs from current root");
        observations.push({
          name: test.name,
          variant,
          round,
          characters: test.source.length,
          nodes: logical,
          encodeMs: encode / 250,
          cloneMs: clone / 250,
          decodeMs: decode / 250,
          payload,
        });
        encoder.reset();
        receiver.reset();
        if (encoder.retainedNodes || receiver.retainedNodes) throw Error("Graph survived disposal");
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
  }
  return {
    observations,
    summary: cases.map((test) => ({
      name: test.name,
      ...Object.fromEntries(
        ["current"].map((variant) => {
          const rows = observations.filter((r) => r.name === test.name && r.variant === variant);
          return [
            variant,
            {
              encodeMs: median(rows.map((r) => r.encodeMs)),
              cloneMs: median(rows.map((r) => r.cloneMs)),
              decodeMs: median(rows.map((r) => r.decodeMs)),
              payload: rows[0].payload,
              nodes: rows[0].nodes,
            },
          ];
        }),
      ),
    })),
  };
}

Object.assign(globalThis, { runSyntaxChannel });
