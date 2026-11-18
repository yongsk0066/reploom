// The only host for the small Rust/WASM ABI. Instance ownership never escapes.
export const compilerVersion = "oxc-d4c3cbe2-reploom-abi3-rust6";

export const hostABI = 3;

function sourceMapURL(bytes) {
  // Keep the ASCII output in the engine's one-byte string representation.
  // TextDecoder returns UTF-16-backed DOM strings in Firefox, even for ASCII.
  let encoded;
  if (typeof bytes.toBase64 === "function") encoded = bytes.toBase64();
  else {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    encoded = btoa(binary);
  }
  // Joining gives SpiderMonkey an exactly sized flat string. A concatenation
  // rope is flattened by structured clone into a power-of-two capacity buffer.
  return ["data:application/json;base64,", encoded].join("");
}

export function createEngine(
  module,
  { yieldTask, now = () => performance.now(), onCheckpoint } = {},
) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });

  let busy = false;
  let cooperative = false;
  let cancelled = () => false;
  let deadline = 0;
  let hostFailure;
  let poisoned = false;

  const supportsJSPI =
    typeof WebAssembly.Suspending === "function" && typeof WebAssembly.promising === "function";

  function checkpoint(phase) {
    // A rejected host Promise must return through Rust normally so its arena is
    // dropped. Throwing across a suspended Rust frame would skip those destructors.
    try {
      onCheckpoint?.(phase);
      if (cancelled()) return 1;
      if (!cooperative || now() < deadline) return 0;
      return yieldTask().then(
        () => {
          try {
            deadline = now() + 4;
            return cancelled() ? 1 : 0;
          } catch (error) {
            hostFailure = error;
            return 1;
          }
        },
        (error) => {
          hostFailure = error;
          return 1;
        },
      );
    } catch (error) {
      hostFailure = error;
      return 1;
    }
  }

  let wasm;

  const imports = {
    playground: {
      checkpoint: supportsJSPI ? new WebAssembly.Suspending(checkpoint) : () => 0,
    },
  };

  // Oxc's transitive browserslist dependency retains wasm-bindgen's throw host
  // hook. Bind only that documented operation; no filesystem, timer or JS bridge.
  for (const item of WebAssembly.Module.imports(module)) {
    if (
      item.module === "./playground_compiler_bg.js" &&
      item.kind === "function" &&
      item.name.startsWith("__wbg___wbindgen_throw_")
    )
      (imports[item.module] ??= {})[item.name] = (ptr, len) => {
        throw Error(decoder.decode(new Uint8Array(wasm.memory.buffer, ptr, len)));
      };
    else if (item.module !== "playground" || item.name !== "checkpoint")
      throw Error("Unexpected compiler import: " + item.module + "." + item.name);
  }
  const instance = new WebAssembly.Instance(module, imports);
  wasm = instance.exports;
  if (wasm.abi_version() !== hostABI) throw Error("Unsupported compiler host ABI");
  const asyncCompile = supportsJSPI ? WebAssembly.promising(wasm.compile_module) : undefined;

  function allocate(text) {
    const bytes = encoder.encode(text);
    let pointer;
    try {
      pointer = wasm.alloc(bytes.length);
    } catch (error) {
      throw failed(error);
    }
    new Uint8Array(wasm.memory.buffer, pointer, bytes.length).set(bytes);
    return { pointer, length: bytes.length };
  }

  function release(input) {
    // A trap can leave Rust frames/allocator state incomplete. Retire the whole
    // Instance; do not call back into it even to free individual host buffers.
    if (input && !poisoned) {
      try {
        wasm.dealloc(input.pointer, input.length);
      } catch (error) {
        throw failed(error);
      }
    }
  }

  function finish(file, input) {
    try {
      release(file);
      release(input);
    } finally {
      end();
    }
  }

  function readResult(pointer, id) {
    // ABI 3 owns code UTF-8, raw map JSON bytes and small metadata UTF-8.
    // Encode the map directly from its live WASM slice; never decode it to a
    // temporary UTF-16 string or allocate a base64 buffer in linear memory.
    let status;
    let flags;
    let code;
    let sourceMap;
    let metadata;
    try {
      pointer >>>= 0;
      const memory = wasm.memory.buffer;
      if (!pointer || pointer % 4 || pointer + 32 > memory.byteLength)
        throw Error("Invalid result handle");
      const header = new DataView(memory, pointer, 32);
      status = header.getUint32(0, true);
      flags = header.getUint32(4, true);
      if (status > 2 || flags > 1 || (status !== 0 && flags)) throw Error("Invalid result status");

      const slice = (offset) => {
        const start = header.getUint32(offset, true);
        const length = header.getUint32(offset + 4, true);
        if (start + length > memory.byteLength) throw Error("Invalid result slice");
        return new Uint8Array(memory, start, length);
      };

      code = decoder.decode(slice(8));
      const map = slice(16);
      sourceMap = map.length ? sourceMapURL(map) : "";
      const text = decoder.decode(slice(24));
      if (status !== 0 && (code || sourceMap)) throw Error("Invalid error payload");
      if (status === 2) {
        if (text) throw Error("Invalid cancellation payload");
      } else {
        metadata = JSON.parse(text);

        const strings = (value) =>
          Array.isArray(value) && value.every((s) => typeof s === "string");

        if (status === 0) {
          if (!metadata || !strings(metadata.specifiers) || !strings(metadata.dynamic))
            throw Error("Invalid artifact metadata");
        } else if (
          !Array.isArray(metadata) ||
          !metadata.length ||
          metadata.some(
            (d) =>
              !d ||
              typeof d.text !== "string" ||
              typeof d.file !== "string" ||
              (d.line !== undefined && (!Number.isSafeInteger(d.line) || d.line < 1)) ||
              (d.column !== undefined && (!Number.isSafeInteger(d.column) || d.column < 0)),
          )
        )
          throw Error("Invalid diagnostics");
      }
    } catch (error) {
      // An invalid pointer/header is an engine failure, never a source error.
      // Do not pass an unvalidated owner back into the Rust allocator.
      throw failed(error);
    }
    // Validation has copied every result into JS-owned values. Release the Rust
    // handle before interpreting status, so allocator failures are reported
    // directly instead of overwriting a source error from a finally block.
    if (!poisoned) {
      try {
        wasm.free_result(pointer);
      } catch (error) {
        throw failed(error);
      }
    }
    if (status === 2) throw hostFailure ?? new DOMException("Aborted", "AbortError");
    if (status === 1) {
      const error = new Error(metadata[0].text);
      error.diagnostics = metadata;
      throw error;
    }
    return {
      id,
      kind: "js",
      code,
      sourceMap,
      specifiers: metadata.specifiers,
      dynamic: metadata.dynamic,
      forceReset: !!(flags & 1),
    };
  }

  function begin(id, source, runtime, shouldCancel, async) {
    if (poisoned)
      throw Object.assign(new Error("Compiler Instance requires restart"), {
        fatal: true,
      });
    if (busy) throw Error("Compiler Instance cannot be reentered");
    busy = true;
    cooperative = async;
    cancelled = shouldCancel;
    deadline = now() + 4;
    hostFailure = undefined;
    let file;
    let input;
    try {
      file = allocate(id);
      input = allocate(source);
      return {
        file,
        input,
        args: [
          file.pointer,
          file.length,
          input.pointer,
          input.length,
          { react: 0, dom: 1, compute: 2 }[runtime],
          async ? 1 : 0,
        ],
      };
    } catch (error) {
      finish(file, input);
      throw error;
    }
  }

  function end() {
    busy = false;
    cooperative = false;
    cancelled = () => false;
    hostFailure = undefined;
  }

  function failed(error) {
    poisoned = true;
    return Object.assign(new Error("Compiler Instance failed", { cause: error }), { fatal: true });
  }

  return {
    module,
    compilerVersion,
    supportsJSPI,
    memoryBytes: () => wasm.memory.buffer.byteLength,
    compileModule(id, source, runtime) {
      const { file, input, args } = begin(id, source, runtime, () => false, false);
      try {
        let result;
        try {
          result = wasm.compile_module(...args);
        } catch (error) {
          throw failed(error);
        }
        return readResult(result, id);
      } finally {
        finish(file, input);
      }
    },
    async compileModuleAsync(id, source, runtime, shouldCancel) {
      if (!supportsJSPI || !yieldTask) {
        if (shouldCancel()) throw new DOMException("Aborted", "AbortError");
        return this.compileModule(id, source, runtime);
      }
      const { file, input, args } = begin(id, source, runtime, shouldCancel, true);
      try {
        let result;
        try {
          result = await asyncCompile(...args);
        } catch (error) {
          throw failed(error);
        }
        return readResult(result, id);
      } finally {
        finish(file, input);
      }
    },
  };
}
