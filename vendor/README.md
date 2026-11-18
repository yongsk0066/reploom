# Compiler dependency sources

The compiler's Oxc dependency family is pinned to upstream commit `d4c3cbe2245bf1c56b3e43ae8cd656437e63817c`. This revision includes the cover-grammar parser, token-handler lexer changes, and [#29518](https://github.com/oxc-project/oxc/pull/29518). Cargo resolves the family from that immutable Git revision, with the parser replaced by the local source below. The upstream crates still identify themselves as 0.159.0; the compiler engine version includes the commit to distinguish this combination from the published release.

## Parser

`oxc_parser/` contains the complete parser source from the pinned commit and its MIT license. Its standalone Cargo metadata comes from the published 0.159.0 archive with the pinned parser’s added `brands` feature; the corresponding workspace manifest is retained as `Cargo.toml.orig`. [oxc-parser.json](oxc-parser.json) identifies both origins and hashes the unpatched files.

Two local patches remain:

1. [Export index](patches/oxc-parser-export-index.patch) replaces repeated import scans during export resolution with a temporary name index. The first binding wins before semantic duplicate-name diagnostics. Apply it from the repository root.
2. [Compiler parser policy](patches/oxc-parser-policy.patch) adds per-parse speculation and type-recursion options. Reploom selects lookahead at depth 16 and an active type budget of 32. Resource exhaustion survives lexer and cover-grammar rewinds as a located diagnostic. Default options retain upstream behavior. Apply it from the repository root.

The type budget covers active type parsing, including speculative paths; JavaScript recursion and browser native calls have separate execution limits.

## Source-map writer

`oxc_sourcemap/` contains the published 10.0.0 crate. [oxc-sourcemap.json](oxc-sourcemap.json) records its original source hashes. The [generated-line-offset patch](patches/oxc-sourcemap-generated-offset.patch) adds one writer entry point: an unmapped generated prefix is emitted directly into the mappings stream. Tokens, original coordinates, chunk state, and the empty-map representation remain unchanged. Apply it from the repository root.

## Rebuilding and upgrading

`pnpm compiler:verify` reverses the recorded patches in a temporary directory and verifies the complete upstream source inventory. The artifact manifest hashes every vendored file and patch, plus the compiler source and Cargo lockfile. Changing an input requires rebuilding the WASM. Compiler notices resolve Git dependencies using the exact locked commit and registry dependencies using their recorded archive provenance.

When upgrading, replace the complete upstream source and reapply only patches still needed. Verify patch reproduction, module-record behavior, parser depth and cover grammar, source-map equivalence, binding semantics, and all three browser suites. Compare artifact size, first-edit startup, large-module throughput, and WASM capacity before choosing a new pin. Keep upstream formatting in vendored files so the local changes remain reviewable.
