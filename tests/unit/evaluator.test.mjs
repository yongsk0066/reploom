import test from "node:test";
import assert from "node:assert/strict";
import { runInThisContext } from "node:vm";
import { createFactoryEvaluator } from "../../packages/runtime/src/execution/factory-evaluator.ts";

function inlineEvaluator() {
  const scripts = [];

  const evaluator = createFactoryEvaluator(
    {
      createElement: () => ({ textContent: "", remove() {} }),
      head: {
        append(script) {
          scripts.push(script.textContent);
          runInThisContext(script.textContent);
        },
      },
    },
    "test",
  );

  scripts.length = 0;
  return { evaluator, scripts };
}

test("vendor decoding overlaps while evaluation preserves declaration order", async (t) => {
  const { evaluator, scripts } = inlineEvaluator();
  t.after(() => evaluator.dispose());
  const started = [];
  const gates = [Promise.withResolvers(), Promise.withResolvers()];

  const sources = gates.map((gate, index) => {
    const blob = new Blob();
    blob.text = () => {
      started.push(index);
      return gate.promise;
    };
    return blob;
  });

  const completion = evaluator.runAll(sources);
  assert.deepEqual(started, [0, 1]);
  gates[1].resolve('"second";');
  await Promise.resolve();
  assert.deepEqual(scripts, []);
  gates[0].resolve('"first";');
  await completion;
  assert.deepEqual(scripts, ['"first";', '"second";']);
});

test("disposing during vendor decoding prevents late script evaluation", async () => {
  const { evaluator, scripts } = inlineEvaluator();
  const gate = Promise.withResolvers();
  const blob = new Blob();
  blob.text = () => gate.promise;
  const completion = evaluator.runAll([blob]);
  evaluator.dispose();
  gate.resolve('"retired";');
  await assert.rejects(completion, /disposed/);
  assert.deepEqual(scripts, []);
});
