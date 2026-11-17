# Worker document data structures

`src/text.ts`, `src/change.ts`, and `LICENSE` are unmodified files from CodeMirror state 6.7.6, commit `651084c8a322b3a19b2bb3e00eee7d4a61d641af` in [the upstream repository](https://code.haverbeke.berlin/codemirror/state). `manifest.json` records their byte hashes. `index.ts` selects the two exports used by the language Worker.

The published state package flattens all modules into one file. Its top-level class-property assignments retain editor state, selection, and facet initialization even when a bundle imports only `Text` and `ChangeSet`. The Worker build aliases that import to this source entry, allowing the normal bundler to omit the unrelated modules. The Window editor continues using the full installed package, and Text objects never cross the Worker boundary.

The UI build verifies the original bytes and requires the vendored version to match its declared `@codemirror/state` dependency. Update these three files and hashes together when upgrading, then run the document-patch differential tests, syntax conformance benchmark, and browser suite. Keep upstream source outside automatic formatting; changes require a recorded patch and equivalent tests. The distributed UI and Worker include CodeMirror's MIT license notice.
