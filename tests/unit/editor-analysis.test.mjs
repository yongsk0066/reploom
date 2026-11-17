import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import {
  createTreeEncoder,
  createTreeReceiver,
  createTreePublisher,
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
const { ensureSyntaxTree, syntaxTreeAvailable } = await esm("@codemirror/language");

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
  const replies = [];
  const publisher = createTreePublisher((reply) => replies.push(reply));

  const worker = {
    postMessage(command) {
      if (command.type === "ack") publisher.acknowledge(command);
      else commands.push(command);
    },
    terminate() {},
  };

  const analysis = createLanguageAnalysis(
    { minCharacters: 1, createWorker: () => worker },
    (...args) => published.push(args),
  );

  analysis.activate("/a.js");
  const extensions = analysis.support("/a.js", "jsx", javascript({ jsx: true }));
  EditorState.create({ doc: "const before=1;", extensions });
  await new Promise((resolve) => setImmediate(resolve));
  const latest = EditorState.create({ doc: "const after=2;", extensions });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(commands.length, 2);
  for (const command of commands) publisher.publish(parser.parse(command.source), command);
  assert.equal(replies.length, 1);
  worker.onmessage({ data: replies[0] });
  assert.equal(published.length, 0);
  assert.equal(replies.length, 2);
  assert.equal(replies[1].base, 0);
  worker.onmessage({ data: replies[1] });
  assert.deepEqual(published, [["/a.js", latest.doc]]);
  const late = worker.onmessage;
  analysis.dispose();
  late({ data: replies[1] });
  assert.equal(published.length, 1);
});

test("syntax publication coalesces candidates against accepted roots and fences source resets", () => {
  const replies = [];

  const publisher = createTreePublisher((reply, transfer) =>
    replies.push(structuredClone(reply, { transfer })),
  );

  const receiver = createTreeReceiver();

  const publish = (revision) =>
    publisher.publish(parser.parse(`const value=${revision};`), {
      revision,
      path: "/a.js",
      kind: "jsx",
    });

  const accept = (index) => {
    const reply = replies[index];
    const tree = receiver.receive(reply, parser.nodeSet);
    publisher.acknowledge({ type: "ack", version: reply.version, accepted: true });
    return tree;
  };

  publish(1);
  accept(0);
  for (let revision = 2; revision <= 20; revision++) publish(revision);
  assert.equal(replies.length, 2);
  publisher.acknowledge({ type: "ack", version: 999, accepted: true });
  assert.equal(replies.length, 2);
  publisher.acknowledge({ type: "ack", version: replies[1].version, accepted: false });
  assert.equal(replies.length, 3);
  assert.equal(replies[2].revision, 20);
  assert.equal(replies[2].base, 1);
  assert.equal(accept(2).toString(), parser.parse("const value=20;").toString());
  publish(21);
  publisher.reset();
  publish(22);
  assert.equal(replies.length, 4);
  accept(3);
  assert.equal(replies.length, 5);
  assert.equal(replies[4].base, 0);
  accept(4);
  publish(23);
  assert.equal(replies[5].base, replies[4].version);
  accept(5);
});

test("discarded graph transactions leave the committed reference counts and identities intact", () => {
  const encoder = createTreeEncoder();
  const receiver = createTreeReceiver();
  const request = (revision) => ({ revision, path: "/a.js", kind: "jsx" });
  const leaf = parser.parse("x");
  const initial = new Tree(leaf.type, [leaf, leaf], [0, 1], 2);
  const first = encoder.encode(initial, request(1));
  const original = receiver.receive(first.reply, parser.nodeSet);
  const retained = encoder.retainedNodes;
  for (let revision = 2; revision < 50; revision++) {
    const staged = encoder.stage(parser.parse(`let value=${revision}`), request(revision));
    assert.equal(staged.reply.base, 1);
    assert.equal(encoder.retainedNodes, retained);
  }
  const reused = encoder.encode(initial, request(50));
  assert.deepEqual(reused.reply.records, []);
  assert.equal(receiver.receive(reused.reply, parser.nodeSet), original);
  const stale = encoder.stage(leaf, request(51));
  encoder.reset();
  assert.throws(() => stale.commit(), /Stale syntax/);
});

test("partial syntax remains visibly usable without claiming the unparsed tail or completing the wrong delivery", async () => {
  const commands = [];
  const replies = [];
  const publisher = createTreePublisher((reply) => replies.push(reply));

  const worker = {
    postMessage(command) {
      if (command.type === "ack") publisher.acknowledge(command);
      else commands.push(command);
    },
    terminate() {},
  };

  let state;

  const analysis = createLanguageAnalysis({ minCharacters: 1, createWorker: () => worker }, () =>
    ensureSyntaxTree(state, state.doc.length, 1),
  );

  try {
    analysis.activate("/a.js");
    const source = "const value = {item: 1};\n".repeat(5000);
    state = EditorState.create({
      doc: source,
      extensions: analysis.support("/a.js", "jsx", javascript()),
    });
    await new Promise((resolve) => setImmediate(resolve));
    const request = commands[0];
    const parse = parser.startParse(source);
    parse.stopAt(5100);
    let partial;
    while (!(partial = parse.advance())) {}
    publisher.publish(partial, request, 5100);
    worker.onmessage({ data: replies[0] });
    assert.equal(syntaxTreeAvailable(state, 5000), true);
    assert.equal(syntaxTreeAvailable(state, source.length), false);
    const full = parser.parse(source, TreeFragment.addTree(partial, [], true));
    assert.equal(full.toString(), parser.parse(source).toString());
    publisher.publish(full, request, source.length);
    publisher.acknowledge({ type: "ack", version: replies[0].version, accepted: true });
    assert.equal(replies[1].revision, replies[0].revision);
    assert.notEqual(replies[1].version, replies[0].version);
    worker.onmessage({ data: replies[1] });
    assert.equal(syntaxTreeAvailable(state, source.length), true);
  } finally {
    analysis.dispose();
  }
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

test("open prefix fragments preserve full grammar and source positions across languages", async () => {
  const { parser: css } = await esm("@lezer/css");
  const { parser: json } = await esm("@lezer/json");

  const cases = [
    [
      parser.configure({ dialect: "jsx ts" }),
      "function render(){return <>" + '<div title="한글😀">{1+2}</div>'.repeat(3000) + "</>}",
    ],
    [parser, "const entries=[" + "{value:`text ${1+2}`,pattern:/a[b]+/g},".repeat(2500) + "];"],
    [
      parser.configure({ dialect: "jsx" }),
      "function render(){ return <div>" + "<span>{items?.map(x=><b>{x}</b>)}</span>".repeat(2000),
    ],
    [
      css,
      "@media (min-width:1px){" +
        '.a:is(.b,.c){content:"한글😀";color:var(--x,red);}'.repeat(2000) +
        "}",
    ],
    [json, "[" + '{"text":"한글😀","items":[1,true,null]},'.repeat(2500) + "{}]"],
  ];

  const signature = (tree) => {
    const nodes = [];
    tree.iterate({
      enter(node) {
        nodes.push(node.type.id, node.from, node.to);
      },
    });
    return nodes;
  };

  for (const [grammar, source] of cases) {
    const expected = signature(grammar.parse(source));
    for (const frontier of [4096, 5101, 8192]) {
      const parsing = grammar.startParse(source);
      parsing.stopAt(frontier);
      let prefix;
      while (!(prefix = parsing.advance())) {}
      const full = grammar.parse(source, TreeFragment.addTree(prefix, [], true));
      assert.deepEqual(signature(full), expected);
    }
  }
});
