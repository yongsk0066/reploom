const corpus = [
  ["js", 'const key="' + "a".repeat(2000) + '"; //' + "b".repeat(2000)],
  ["js", "/*" + "*x".repeat(1000) + "*/ const value=/a[b\\/]+/gui;"],
  ["js", "const " + "long".repeat(500) + "=1234567890;"],
  ["js", '"' + "a".repeat(2000)],
  ["js", '"' + "a".repeat(1000) + "\\\n" + "b".repeat(1000) + '"'],
  [
    "tsx",
    'export function C<T extends string>({s}:{s:T}) { return <div a="' +
      "a".repeat(2000) +
      '">{`a${s}😀`}</div> }',
  ],
  [
    "tsx",
    'const a = <T,>(v:T)=>v satisfies T; const b=<div title="😀"><span>{a("x")}</span></div>',
  ],
  ["json", '["' + "한😀\\u2028".repeat(200) + '",' + "7".repeat(2000) + ",false,null]"],
  [
    "css",
    '.a::before { content:"' + "z".repeat(2000) + '"; --' + "long".repeat(500) + ":var(--a)}",
  ],
  ["css", "/*" + "abc".repeat(600) + "*/ @media screen { .a\\31 {color: rgb(1 2 3)} }"],
];

export function boundaryCases() {
  const cases = [];
  for (const [kind, source] of corpus)
    for (const size of [1, 2, 7, 31, 1024, source.length]) {
      for (const ranges of [
        undefined,
        [
          { from: 0, to: Math.floor(source.length / 3) },
          { from: Math.floor(source.length / 2), to: source.length },
        ],
      ]) {
        cases.push({ method: "parseCase", args: [kind, source, size, ranges] });
      }
    }
  return cases;
}

export function incrementalCases() {
  const cases = [];
  let seed = 9173;

  const random = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };

  const inserts = [
    '"',
    "'",
    "\\",
    "\n",
    "\r",
    "\u2028",
    "\u2029",
    "😀",
    "한",
    "\ud800",
    "\udfff",
    "/*",
    "*/",
    "<",
    "}",
    "$",
    "`",
    "0",
    "",
    "abc",
  ];

  for (const [kind, source] of corpus) {
    const edits = [];
    let length = source.length;
    for (let i = 0; i < 80; i++) {
      const from = random(length + 1);
      const to = Math.min(length, from + random(4));
      const insert = inserts[random(inserts.length)];
      edits.push({ from, to, insert });
      length += insert.length - (to - from);
    }
    for (const chunk of [7, 1024, 10000])
      cases.push({ method: "editCase", args: [kind, source, edits, chunk] });
  }
  return cases;
}

export function recoveryCases() {
  const cases = [];
  let seed = 4277;

  const random = (n) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % n;
  };

  const tokens = [
    "identifier",
    "\u{10000}",
    "\udfff",
    "const",
    "return",
    '"abc',
    "\\",
    "\n",
    "0.123e4",
    "//",
    "/*",
    "*/",
    "<div>",
    "</div>",
    "=>",
    ";",
    ",",
    "[",
    "]",
    "{",
    "}",
    ":",
    "(",
    ")",
    " ",
    "'",
    "`",
    "${",
    "?",
    "++",
    "\\u1234",
  ];

  for (const kind of ["js", "tsx", "json", "css"])
    for (let i = 0; i < 150; i++) {
      const source = Array.from(
        { length: 20 + random(50) },
        () => tokens[random(tokens.length)],
      ).join("");

      cases.push({ method: "parseCase", args: [kind, source, 13] });
    }
  return cases;
}
