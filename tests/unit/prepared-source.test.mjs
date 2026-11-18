import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prepareSource } from "@yongsk0066/reploom-ui/prepare-reader";
import { PreparedSourceView } from "@yongsk0066/reploom-ui/react";

test("prepared readers keep exact UTF-16 source and escape markup when rendered to HTML", async () => {
  for (const [path, text] of [
    ["/App.tsx", 'const emoji = "😀";\nexport const App = () => <b>{emoji}</b>;\n'],
    ["/style.css", 'button::after { content: "<img>"; }\n'],
    ["/data.json", '{"label":"</pre><img>","emoji":"😀"}'],
    ["/draft.js", "export const stillTyping = ("],
  ]) {
    const source = await prepareSource(path, text);
    assert.equal(source.text, text);
    assert.equal(source.path, path);
    assert.ok(source.spans.length > 0);
    let position = 0;
    for (let i = 0; i < source.spans.length; i += 3) {
      const [gap, length, token] = source.spans.slice(i, i + 3);
      assert.ok(gap >= 0 && length > 0 && source.classes[token].startsWith("tok-"));
      position += gap + length;
      assert.ok(position <= text.length);
    }
    const html = renderToStaticMarkup(createElement(PreparedSourceView, { source }));
    assert.ok(html.includes('<span class="tok-'));
    assert.doesNotMatch(html, /<img>|<b>/);
  }
});

test("large or dense initial files use the viewport reader", async () => {
  assert.equal(await prepareSource("/a.js", ""), undefined);
  assert.equal(await prepareSource("/a.js", " ".repeat(8193)), undefined);
  assert.equal(await prepareSource("/a.js", "a+1;".repeat(500)), undefined);
});

test("unstyled tokens remain selectable plain text between colored ranges", async () => {
  const source = await prepareSource("/math.js", "const total = count + 1;");
  const markup = renderToStaticMarkup(createElement(PreparedSourceView, { source }));
  assert.match(markup, /class="tok-keyword">const</);
  assert.match(markup, /class="tok-definition">total</);
  assert.match(markup, />1<\/span>;<\/pre>/);
  assert.match(markup, /<\/span> count <span/);
  assert.doesNotMatch(markup, /tok-punctuation|tok-variableName/);
});
