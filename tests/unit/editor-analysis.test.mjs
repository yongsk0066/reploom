import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  createTreeEncoder,
  createTreeReceiver,
} from "../../packages/ui/src/codemirror/language/tree-channel.ts";
import { createLanguageAnalysis } from "../../packages/ui/src/codemirror/language/client.ts";
import { documentInput } from "../../packages/ui/src/codemirror/language/document-input.ts";
import { createUpdateAdmission } from "../../packages/runtime/src/project/update-admission.ts";

const uiRequire = createRequire(new URL("../../packages/ui/package.json", import.meta.url));

const esm = (name) => import(pathToFileURL(uiRequire.resolve(name).replace(/\.cjs$/, ".js")));
const { parser } = await esm("@lezer/javascript");
const { TreeFragment, Tree } = await esm("@lezer/common");
const { EditorState, Text, ChangeSet } = await esm("@codemirror/state");
const { javascript } = await esm("@codemirror/lang-javascript");

test("syntax root retirement handles shared nodes, reappearance and invalid transactions", () => {
  const encoder = createTreeEncoder();
  const receiver = createTreeReceiver();
  const leaf = parser.parse("x");
  const first = new Tree(leaf.type, [leaf, leaf], [0, 1], 2);
  const second = new Tree(leaf.type, [leaf], [0], 1);
  let revision = 0;

  const send = (tree) =>
    encoder.encode(tree, { revision: ++revision, base: revision - 1, path: "/a.js", kind: "jsx" })
      .reply;

  let original = receiver.receive(send(first), parser.nodeSet);
  assert.equal(original.children[0], original.children[1]);
  const stable = send(first);
  assert.deepEqual(stable.records, []);
  assert.deepEqual(stable.retired, []);
  assert.equal(receiver.receive(stable, parser.nodeSet), original);
  const replacing = send(second);
  const retained = receiver.retainedNodes;
  assert.throws(() => receiver.receive({ ...replacing, root: -1 }, parser.nodeSet), /root/);
  assert.throws(
    () =>
      receiver.receive(
        {
          ...replacing,
          records: [...replacing.records, { id: 1_000_000, length: 0, buffer: new Uint16Array() }],
        },
        parser.nodeSet,
      ),
    /Unreachable/,
  );
  assert.throws(
    () => receiver.receive({ ...replacing, retired: [...replacing.retired, -1] }, parser.nodeSet),
    /retired/,
  );
  assert.equal(receiver.retainedNodes, retained);
  receiver.receive(replacing, parser.nodeSet);
  assert.equal(receiver.retainedNodes, encoder.retainedNodes);
  const empty = new Tree(leaf.type, [], [], 0);
  receiver.receive(send(empty), parser.nodeSet);
  assert.equal(receiver.retainedNodes, 1);
  assert.equal(encoder.retainedNodes, 1);
  original = receiver.receive(send(first), parser.nodeSet);
  assert.equal(original.toString(), first.toString());
  assert.equal(original.children[0], original.children[1]);
  encoder.reset();
  receiver.reset();
  assert.equal(encoder.retainedNodes, 0);
  assert.equal(receiver.retainedNodes, 0);
});

test("Worker document source agrees with the installed editor across UTF-16 multi-span changes", async () => {
  const bundle = await build({
    entryPoints: ["packages/ui/vendor/codemirror-state/index.ts"],
    bundle: true,
    format: "esm",
    write: false,
  });

  const worker = await import(
    "data:text/javascript;base64," + Buffer.from(bundle.outputFiles[0].text).toString("base64")
  );

  let expected = "한글😀\n".repeat(1000);
  let local = Text.of(expected.split("\n"));
  let remote = worker.Text.of(expected.split("\n"));
  for (let n = 0; n < 500; n++) {
    const from = (n * 47) % (expected.length - 4);
    const to = from + 3;

    const edits = [
      { from, to, insert: n % 2 ? "😀\n" : "한글" },
      { from: expected.length, insert: "x" },
    ];

    const a = ChangeSet.of(edits, local.length);
    const b = worker.ChangeSet.of(edits, remote.length);
    local = a.apply(local);
    remote = b.apply(remote);
    expected = expected.slice(0, from) + edits[0].insert + expected.slice(to) + "x";
    assert.equal(remote.toString(), expected);
    assert.equal(local.toString(), expected);
    assert.equal(remote.lines, local.lines);
    assert.equal(
      remote.lineAt(Math.min(from, remote.length)).text,
      local.lineAt(Math.min(from, local.length)).text,
    );

    const ranges = (change) => {
      const result = [];
      change.iterChanges((fromA, toA, fromB, toB, inserted) =>
        result.push([fromA, toA, fromB, toB, inserted.toString()]),
      );
      return result;
    };

    assert.deepEqual(ranges(a), ranges(b));
  }
});

test("syntax graph deltas preserve reused identities, properties, ownership and full resynchronization", () => {
  const encode = createTreeEncoder();
  const decode = createTreeReceiver();
  let source = Array.from(
    { length: 1000 },
    (_, i) => `const a${i} = { value: ${i}, text: "한글😀" };`,
  ).join("\n");
  let tree = parser.parse(source);
  const first = encode.encode(tree, { revision: 1, path: "/a.js", kind: "jsx" });

  const before = decode.receive(
    structuredClone(first.reply, { transfer: first.transfer }),
    parser.nodeSet,
  );

  assert.equal(before.toString(), tree.toString());

  const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), [
    { fromA: 20, toA: 21, fromB: 20, toB: 21 },
  ]);

  source = source.slice(0, 20) + "9" + source.slice(21);
  tree = parser.parse(source, fragments);
  const second = encode.encode(tree, { revision: 2, path: "/a.js", kind: "jsx" });
  assert.equal(second.reply.base, 1);
  assert.ok(second.reply.records.length < first.reply.records.length / 2);

  const after = decode.receive(
    structuredClone(second.reply, { transfer: second.transfer }),
    parser.nodeSet,
  );

  assert.equal(after.toString(), tree.toString());

  const nodes = (root) => {
    const found = new Set();
    const pending = [root];
    while (pending.length) {
      const node = pending.pop();
      found.add(node);
      if (node.children) pending.push(...node.children);
    }
    return found;
  };

  const previousNodes = nodes(before);
  assert.ok(
    [...nodes(after)].filter((node) => previousNodes.has(node)).length > previousNodes.size / 2,
  );
  assert.throws(() => decode.receive({ ...second.reply, base: 999 }, parser.nodeSet), /base/);
  decode.reset();
  assert.throws(() => decode.receive(second.reply, parser.nodeSet), /base/);
  encode.reset();
  const full = encode.encode(tree, { revision: 3, path: "/a.js", kind: "jsx" });
  assert.equal(full.reply.base, 0);
  assert.equal(decode.receive(full.reply, parser.nodeSet).toString(), tree.toString());
});

test("disposing language analysis cancels creation and terminates a late Worker exactly once", async () => {
  let finish;
  let signal;
  let terminated = 0;

  const analysis = createLanguageAnalysis({
    minCharacters: 1,
    createWorker(value) {
      signal = value;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });

  analysis.activate("/a.js");
  EditorState.create({
    doc: "let value = 1;",
    extensions: analysis.support("/a.js", "jsx", javascript({ jsx: true })),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(finish);
  analysis.dispose();
  analysis.dispose();
  assert.equal(signal.aborted, true);
  finish({
    terminate() {
      terminated++;
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(terminated, 1);
});

test("language publication follows only the desired document revision and active lifetime", async () => {
  const commands = [];
  const published = [];
  const worker = { postMessage: (command) => commands.push(command), terminate() {} };

  const analysis = createLanguageAnalysis(
    { minCharacters: 1, createWorker: () => worker },
    (...args) => published.push(args),
  );

  const encoder = createTreeEncoder();
  analysis.activate("/a.js");
  const extensions = analysis.support("/a.js", "jsx", javascript({ jsx: true }));
  EditorState.create({ doc: "const before=1;", extensions });
  await new Promise((resolve) => setImmediate(resolve));
  const latest = EditorState.create({ doc: "const after=2;", extensions });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(commands.length, 2);
  const reply = (command) => encoder.encode(parser.parse(command.source), command).reply;
  worker.onmessage({ data: reply(commands[0]) });
  assert.equal(published.length, 0);
  worker.onmessage({ data: reply(commands[1]) });
  assert.deepEqual(published, [["/a.js", latest.doc]]);
  const late = worker.onmessage;
  analysis.dispose();
  late({ data: reply(commands[1]) });
  assert.equal(published.length, 1);
});

test("a retired language Worker factory cannot fail a different active document", async () => {
  let rejectOld;
  let first = true;
  let terminated = 0;
  let commands = 0;
  const failures = [];

  const analysis = createLanguageAnalysis({
    minCharacters: 1,
    onError: (error) => failures.push(error),
    createWorker() {
      if (first) {
        first = false;
        return new Promise((_, reject) => {
          rejectOld = reject;
        });
      }
      return {
        postMessage() {
          commands++;
        },
        terminate() {
          terminated++;
        },
      };
    },
  });

  const open = (path) => {
    analysis.activate(path);
    EditorState.create({
      doc: "let value = 1;",
      extensions: analysis.support(path, "jsx", javascript({ jsx: true })),
    });
  };

  open("/a.js");
  await new Promise((resolve) => setImmediate(resolve));
  open("/b.js");
  await new Promise((resolve) => setImmediate(resolve));
  rejectOld(Error("Cancelled old loader"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(commands, 1);
  assert.equal(terminated, 0);
  assert.deepEqual(failures, []);
  analysis.dispose();
  assert.equal(terminated, 1);
});

test("document cursors preserve random UTF-16 reads, backward chunks and incremental parse fragments", () => {
  const source = Array.from({ length: 2500 }, (_, i) => `const value${i} = "한글😀\\n";`).join(
    "\n",
  );

  const doc = Text.of(source.split("\n"));
  const input = documentInput(doc);
  for (let i = 0; i < 5000; i++) {
    const from = i % 5 === 0 ? doc.length : (i * 7919) % doc.length;
    const chunk = input.chunk(from);
    assert.equal(chunk, doc.iterRange(from).next().value);
    const begin = Math.max(0, from - (i % 17));
    const end = Math.min(doc.length, from + (i % 91));
    assert.equal(input.read(begin, end), source.slice(begin, end));
  }
  let tree = parser.parse(input);
  assert.equal(tree.toString(), parser.parse(source).toString());
  let text = doc;
  for (let i = 0; i < 30; i++) {
    const from = (i * 277) % (text.length - 2);
    const changes = ChangeSet.of({ from, to: from + 2, insert: i % 2 ? "'" : "😀" }, text.length);
    const ranges = [];
    changes.iterChangedRanges((fromA, toA, fromB, toB) => ranges.push({ fromA, toA, fromB, toB }));
    const fragments = TreeFragment.applyChanges(TreeFragment.addTree(tree), ranges);
    text = changes.apply(text);
    tree = parser.parse(documentInput(text), fragments);
    assert.equal(tree.toString(), parser.parse(text.toString(), fragments).toString());
  }
});

test("admission starts idle input immediately and coalesces the rest of a bounded burst", () => {
  const policy = createUpdateAdmission();
  assert.equal(policy.input(0, false), 0);
  policy.started(1, 0);
  policy.settled(1, 4);
  for (let now = 30; now < 270; now += 30) {
    const delay = policy.input(now, false);
    assert.ok(delay > 0 && now + delay <= 270);
  }
  assert.equal(policy.input(270, false), 0);
  policy.started(2, 270);
  policy.settled(2, 275);
  assert.equal(policy.input(1000, false), 0);
  policy.reset();
  assert.equal(policy.input(1001, false), 0);
  const fixed = createUpdateAdmission(120);
  assert.equal(fixed.input(0, false), 120);
  assert.equal(fixed.input(1000, false), 120);
  assert.equal(fixed.input(1010, true), 0);
});

test("settlement retains input cadence without letting stale acknowledgements change admission", () => {
  const policies = [createUpdateAdmission(), createUpdateAdmission()];
  for (const policy of policies) {
    policy.input(0, false);
    policy.started(1, 0);
    assert.ok(policy.input(30, false) > 0);
    policy.settled(1, 50);
    assert.ok(policy.input(60, false) > 0);
    policy.started(2, 100);
  }
  policies[0].settled(1, 1000);
  assert.equal(policies[0].input(120, false), policies[1].input(120, false));
  for (const policy of policies) {
    policy.settled(2, 140);
    policy.input(150, false);
    policy.input(200, false);
    policy.started(3, 210);
    policy.settled(3, 215);
    assert.ok(
      policy.input(220, false) > 0,
      "fast completion does not turn typing into idle bursts",
    );
    policy.reset();
    assert.equal(policy.input(221, false), 0);
  }
});
