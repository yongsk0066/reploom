import { TraceMap, traceSegment, type EncodedSourceMap } from "@jridgewell/trace-mapping";

const digits = new Int8Array(128).fill(-1);
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
for (let i = 0; i < alphabet.length; i++) digits[alphabet.charCodeAt(i)] = i;

// MagicString only inserts/removes text in our linker, so its source positions
// advance monotonically. Read Oxc's encoded map with two reusable segments.
// Unusual/nonmonotonic maps keep the general library's lookup semantics.
function forwardTracer(encoded: string, map: TraceMap) {
  let at = 0;
  let line = 0;
  let column = 0;
  let source = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let name = 0;
  let pendingLine = Infinity;
  let foundLine = -1;
  let queryLine = -1;
  let queryColumn = -1;
  let fallback = false;

  const pending: number[] = [];
  const found: number[] = [];

  const separator = () => at === encoded.length || encoded[at] === "," || encoded[at] === ";";

  function value() {
    let bits = 0;
    let shift = 0;
    for (;;) {
      const digit = digits[encoded.charCodeAt(at++)];
      if (digit === undefined || digit < 0 || shift > 30)
        throw new Error("Invalid transform source map VLQ");
      bits |= (digit & 31) << shift;
      if (!(digit & 32)) return bits & 1 ? -(bits >>> 1) : bits >>> 1;
      shift += 5;
    }
  }

  function advance() {
    while (at < encoded.length) {
      if (encoded[at] === ";") {
        at++;
        line++;
        column = 0;
        continue;
      }
      if (encoded[at] === ",") {
        at++;
        continue;
      }

      const previousColumn = column;
      const previousLine = pendingLine;

      column += value();
      // Duplicate/unsorted generated positions need the library's tie-breaking.
      if (line === previousLine && column <= previousColumn) fallback = true;
      pendingLine = line;
      pending[0] = column;
      pending.length = 1;
      if (!separator()) {
        pending[1] = source += value();
        pending[2] = originalLine += value();
        pending[3] = originalColumn += value();
        if (!separator()) pending[4] = name += value();
        if (!separator()) throw new Error("Invalid transform source map segment");
      }
      return;
    }
    pendingLine = Infinity;
  }

  advance();
  return (targetLine: number, targetColumn: number): readonly number[] | null => {
    fallback ||= targetLine < queryLine || (targetLine === queryLine && targetColumn < queryColumn);
    queryLine = targetLine;
    queryColumn = targetColumn;
    while (
      !fallback &&
      (pendingLine < targetLine || (pendingLine === targetLine && pending[0] <= targetColumn))
    ) {
      if (pendingLine === targetLine) {
        foundLine = pendingLine;
        found.length = pending.length;
        for (let i = 0; i < pending.length; i++) found[i] = pending[i];
      }
      advance();
    }
    return fallback
      ? traceSegment(map, targetLine, targetColumn)
      : foundLine === targetLine
        ? found
        : null;
  };
}

// The linker emits generated positions in order. Stream both decoding and
// output encoding: no output segment arrays or second encoding traversal.
// The maintained tracer owns source resolution and arbitrary original lookups.
export function composeModuleMap(outer: EncodedSourceMap, inner: EncodedSourceMap) {
  if (outer.sources.length > 1) throw new Error("Linker source maps require exactly one source.");
  const original = new TraceMap(inner, "");
  const trace = forwardTracer(inner.mappings, original);

  const sources: string[] = [];
  const sourcesContent: (string | null)[] = [];
  const names: string[] = [];
  const ignoreList: number[] = [];

  const sourceIds = new Map<string, number>();
  const nameIds = new Map<string, number>();

  const bytes = new Uint8Array(8192);
  const decoder = new TextDecoder();
  const chunks: string[] = [];

  let used = 0;

  const write = (byte: number) => {
    bytes[used++] = byte;
    if (used === bytes.length) {
      chunks.push(decoder.decode(bytes));
      used = 0;
    }
  };

  const encode = (value: number) => {
    let number = value < 0 ? ((-value << 1) | 1) >>> 0 : (value << 1) >>> 0;
    do {
      const digit = number & 31;
      number >>>= 5;
      write(alphabet.charCodeAt(digit | (number ? 32 : 0)));
    } while (number);
  };

  const intern = (ids: Map<string, number>, list: string[], value: string) => {
    const existing = ids.get(value);
    if (existing !== undefined) return existing;
    const index = list.length;
    ids.set(value, index);
    list.push(value);
    return index;
  };

  let outputLine = 0;
  let outputColumn = 0;
  let outputSource = 0;
  let outputOriginalLine = 0;
  let outputOriginalColumn = 0;
  let outputName = 0;
  let lastLine = -1;
  let lastSource = -1;
  let lastOriginalLine = -1;
  let lastOriginalColumn = -1;
  let lastName = -1;

  function emit(sourceIndex = -1, originalLine = 0, originalColumn = 0, nameIndex = -1) {
    const sameLine = lastLine === generatedLine;
    // Match maybeAddSegment's duplicate/gap semantics. Leading unmapped spans
    // need no segment; a mapping must be explicitly ended by an unmapped span.
    if (
      sourceIndex < 0
        ? !sameLine || lastSource < 0
        : sameLine &&
          lastSource === sourceIndex &&
          lastOriginalLine === originalLine &&
          lastOriginalColumn === originalColumn &&
          lastName === nameIndex
    )
      return;
    while (outputLine < generatedLine) {
      write(59);
      outputLine++;
      outputColumn = 0;
    }
    if (sameLine) write(44);
    encode(generatedColumn - outputColumn);
    outputColumn = generatedColumn;
    if (sourceIndex >= 0) {
      encode(sourceIndex - outputSource);
      encode(originalLine - outputOriginalLine);
      encode(originalColumn - outputOriginalColumn);
      outputSource = sourceIndex;
      outputOriginalLine = originalLine;
      outputOriginalColumn = originalColumn;
      if (nameIndex >= 0) {
        encode(nameIndex - outputName);
        outputName = nameIndex;
      }
    }
    lastLine = generatedLine;
    lastSource = sourceIndex;
    lastOriginalLine = originalLine;
    lastOriginalColumn = originalColumn;
    lastName = nameIndex;
  }

  const content = new Set<number>();
  const mappings = outer.mappings;
  let at = 0;
  let generatedLine = 0;
  let generatedColumn = 0;
  let source = 0;
  let line = 0;
  let column = 0;
  let name = 0;

  const separator = () =>
    at === mappings.length || mappings.charCodeAt(at) === 44 || mappings.charCodeAt(at) === 59;

  function value() {
    let bits = 0;
    let shift = 0;
    for (;;) {
      const digit = digits[mappings.charCodeAt(at++)];
      if (digit === undefined || digit < 0 || shift > 30)
        throw new Error("Invalid linker source map VLQ");
      bits |= (digit & 31) << shift;
      if (!(digit & 32)) return bits & 1 ? -(bits >>> 1) : bits >>> 1;
      shift += 5;
    }
  }

  while (at < mappings.length) {
    const character = mappings.charCodeAt(at);
    if (character === 59) {
      at++;
      generatedLine++;
      generatedColumn = 0;
      continue;
    }
    if (character === 44) {
      at++;
      continue;
    }
    generatedColumn += value();
    if (separator()) {
      emit();
      continue;
    }
    source += value();
    line += value();
    column += value();
    if (source !== 0) throw new Error("Invalid linker source map source");
    const named = !separator();
    if (named) name += value();
    if (!separator()) throw new Error("Invalid linker source map segment");
    const traced = trace(line, column);
    if (!traced) continue;
    if (traced.length === 1) {
      emit();
      continue;
    }

    const index = traced[1];
    const filename = original.resolvedSources[index] || "";

    const symbol =
      traced.length === 5 ? original.names[traced[4]] : named ? outer.names[name] : undefined;

    const sourceIndex = filename ? intern(sourceIds, sources, filename) : -1;
    if (sourceIndex === sourcesContent.length) sourcesContent.push(null);
    emit(
      sourceIndex,
      traced[2],
      traced[3],
      filename && symbol ? intern(nameIds, names, symbol) : -1,
    );
    if (!content.has(index)) {
      content.add(index);
      const text = original.sourcesContent?.[index];
      if (filename && text != null) sourcesContent[sourceIndex] = text;
      if (original.ignoreList?.includes(index)) {
        const ignored = intern(sourceIds, sources, filename);
        if (ignored === sourcesContent.length) sourcesContent.push(null);
        if (!ignoreList.includes(ignored)) ignoreList.push(ignored);
      }
    }
  }
  if (used) chunks.push(decoder.decode(bytes.subarray(0, used)));
  // Preserve the existing artifact's serialized field order, too. Equivalent
  // debug metadata must not produce a different patch solely due to this pass.
  return {
    version: 3,
    file: outer.file || undefined,
    mappings: chunks.join(""),
    names,
    ignoreList,
    sourceRoot: undefined,
    sources,
    sourcesContent,
  };
}
