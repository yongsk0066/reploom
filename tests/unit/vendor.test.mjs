import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { createVendorBuilder } from "../../packages/build/src/vendor.mjs";

test("dependency packs share the runtime's React for ESM, named, JSX and CommonJS imports", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "playground-peer-"));
  const peer = path.join(directory, "peer.mjs");
  const sources = new Map();
  const channels = [];

  class OwnedMessageChannel extends MessageChannel {
    constructor() {
      super();
      channels.push(this);
    }
  }

  const builder = createVendorBuilder({
    root: fileURLToPath(new URL("../../", import.meta.url)),
    asset: async (name, source) => {
      const asset = { url: `${name}-${sources.size}` };
      sources.set(asset.url, source);
      return asset;
    },
    reactModules: [
      ["react", "19.3.1"],
      ["react-dom", "19.3.1"],
      ["react-dom/client", "19.3.1"],
      ["react/jsx-runtime", "19.3.1"],
      ["react/jsx-dev-runtime", "19.3.1"],
    ],
  });

  try {
    await writeFile(
      peer,
      `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { jsx } from 'react/jsx-runtime';
      export { React, useState, createRoot, jsx };
      export const common = require('react');
    `,
    );
    const { vendor: first } = await builder.prepare("react", [[peer, "1.0.0"]]);
    const { vendor: second } = await builder.prepare("react", [["clsx", "2.1.1"]]);
    assert.equal(first[0], second[0]);
    assert.notEqual(first[1], second[1]);
    assert.ok(sources.get(first[1].url).length < 4000, "React is not bundled into peer code");

    const realm = createContext({
      console,
      setTimeout,
      clearTimeout,
      MessageChannel: OwnedMessageChannel,
    });

    for (const asset of first) runInContext(sources.get(asset.url), realm);
    const deps = realm.__PLAYGROUND_VENDOR__.dependencies;
    assert.equal(deps[peer].React, deps.react.default);
    assert.equal(deps[peer].common, deps.react.default);
    assert.equal(deps[peer].useState, deps.react.useState);
    assert.equal(deps[peer].createRoot, deps["react-dom/client"].createRoot);
    assert.equal(deps[peer].jsx, deps["react/jsx-runtime"].jsx);
    assert.equal(deps.clsx, undefined, "a sibling project's dependencies are not installed");
    assert.equal(realm.__PLAYGROUND_VENDOR__.kind, "react");

    const { vendor: dom } = await builder.prepare("dom", []);
    const domRealm = createContext({ console });
    runInContext(sources.get(dom[0].url), domRealm);
    assert.equal(dom.length, 1);
    assert.equal(domRealm.__PLAYGROUND_VENDOR__.kind, "dom");
    assert.deepEqual(Object.keys(domRealm.__PLAYGROUND_VENDOR__.dependencies), []);
    assert.equal(domRealm.__REACT_DEVTOOLS_GLOBAL_HOOK__, undefined);
  } finally {
    for (const channel of channels) {
      channel.port1.close();
      channel.port2.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
});
