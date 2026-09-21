import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { chromium } from "playwright-core";
import { extractResponseText } from "../../src/providers/extract-response.mjs";

let browser;
before(async () => { browser = await chromium.launch({ channel: "chrome", headless: true }); });
after(async () => { await browser?.close(); });

async function extract(t, html, format = "markdown") {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setContent(`<!doctype html><div id="response">${html}</div>`);
  return page.locator("#response").evaluate(extractResponseText, { format });
}

test("Markdown preserves headings, inline styling, links, breaks, quotes and nested lists", async (t) => {
  const { text } = await extract(t, `
    <h2>Notes</h2>
    <p>A <strong>bold</strong> and <em>gentle</em> <a href="https://example.com/a_(b)">link</a>.<br>Next <del>old</del>.</p>
    <blockquote><p>Quoted</p><p>Again</p></blockquote>
    <ol start="3"><li>First<ul><li>Nested</li></ul></li><li value="7">Last</li></ol>
    <hr>
  `);
  assert.equal(text, [
    "## Notes",
    "A **bold** and *gentle* [link](<https://example.com/a_(b)>).  \nNext ~~old~~.",
    "> Quoted\n> \n> Again",
    "3. First\n   \n   - Nested\n7. Last",
    "---",
  ].join("\n\n"));
});

test("code preserves backslashes, whitespace and embedded fences without copy-toolbar text", async (t) => {
  const source = "const value = `x`;\n\n\n  // ``` and \\frac{a}{b}  \n";
  const { text } = await extract(t, `
    <p>Use <code>a\`b</code>.</p>
    <code-block><div>JavaScript <button>Copy code</button></div><pre><code class="language-js">${source}</code></pre></code-block>
  `);
  assert.equal(text, `Use \`\`a\`b\`\`.\n\n\`\`\`\`js\n${source}\`\`\`\``);
});

test("tables retain headers, inline content, escaped pipes and line breaks", async (t) => {
  const { text } = await extract(t, `
    <table><caption>Data</caption><thead><tr><th>Name</th><th>Value</th></tr></thead>
    <tbody><tr><td><strong>A</strong> | B</td><td>one<br>two</td></tr></tbody></table>
    <table><tr><td>No header</td><td>2</td></tr></table>
  `);
  assert.equal(text, "Data\n\n| Name | Value |\n| --- | --- |\n| **A** \\| B | one  <br>two |\n\n|  |  |\n| --- | --- |\n| No header | 2 |");
});

const formulas = String.raw`
  <p>Inline <span class="math-inline" data-math="x^2 + \alpha"><span aria-hidden="true">visual x squared</span><math><annotation encoding="application/x-tex">duplicate</annotation></math></span>.</p>
  <div class="math-block" data-math="\begin{aligned}a&amp;=b\\c&amp;=d\end{aligned}"><span>rendered block</span></div>
  <p>Annotation <span class="katex"><span class="katex-mathml"><math><semantics><mi>x</mi><annotation encoding="application/x-tex">\frac{a}{b}</annotation></semantics></math></span><span class="katex-html" aria-hidden="true">rendered fraction</span></span>.</p>
`;

test("Markdown math uses provider source once and preserves TeX commands", async (t) => {
  const result = await extract(t, formulas);
  assert.equal(result.text, String.raw`Inline $x^2 + \alpha$.

$$
\begin{aligned}a&=b\\c&=d\end{aligned}
$$

Annotation $\frac{a}{b}$.`);
  assert.deepEqual(result.extraction, { source: "response_dom", math: { source: 3, rendered: 0 } });
});

test("LaTeX extraction keeps prose unchanged and adds only formula delimiters", async (t) => {
  const result = await extract(t, `<h1>Costs: 50% &amp; $5_0 #1</h1>${formulas}<pre><code>\\raw{code}\n\nvalue</code></pre>`, "latex");
  assert.equal(result.text, String.raw`Costs: 50% & $5_0 #1

Inline \(x^2 + \alpha\).

\[
\begin{aligned}a&=b\\c&=d\end{aligned}
\]

Annotation \(\frac{a}{b}\).

\raw{code}

value`);
  assert.doesNotMatch(result.text, /\\(?:documentclass|section|begin\{document\})/u);
});

test("plain text keeps source formulas without Markdown or LaTeX wrappers", async (t) => {
  const result = await extract(t, `<h1>Answer</h1><p><strong>Text</strong> <span data-math="x^2">duplicate</span>.</p>`, "text");
  assert.equal(result.text, "Answer\n\nText x^2.");
});

test("display wrappers and already-delimited source do not duplicate formulas", async (t) => {
  const result = await extract(t, String.raw`
    <div class="katex-display"><span class="katex"><math><annotation encoding="application/x-tex">\sum_i x_i</annotation></math><span class="katex-html">duplicate</span></span></div>
    <p><span data-math-source="\(y=2\)">duplicate</span></p>
    <span data-math="$$z=3$$">duplicate</span>
  `);
  assert.equal(result.text, "$$\n\\sum_i x_i\n$$\n\n$y=2$\n\n$$\nz=3\n$$");
  assert.deepEqual(result.extraction.math, { source: 3, rendered: 0 });
});

test("missing formula source retains visible text and reports it without inventing TeX", async (t) => {
  const result = await extract(t, `
    <p>Fallback <span class="katex"><span class="katex-mathml">duplicate</span><span class="katex-html" aria-hidden="true">x²</span></span>.</p>
  `, "latex");
  assert.equal(result.text, "Fallback x².");
  assert.deepEqual(result.extraction.math, { source: 0, rendered: 1 });
});

test("extraction excludes hidden content and controls, and never emits image downloads or executable links", async (t) => {
  const result = await extract(t, `
    <p>Visible <span hidden>secret</span><span style="display:none">hidden</span><span aria-hidden="true">duplicate</span><button>Copy</button></p>
    <p><a href="javascript:alert(1)">label</a> <img alt="Diagram" src="data:image/png;base64," /></p>
    <p>Literal *stars*, [brackets], #hash, $5 and &lt;tag&gt;.</p>
    <script>doNotRun()</script>
  `);
  assert.equal(result.text, "Visible\n\nlabel Diagram\n\nLiteral \\*stars\\*, \\[brackets\\], \\#hash, \\$5 and \\<tag\\>.");
});

test("literal list-like text and separators retain their meaning in Markdown", async (t) => {
  const result = await extract(t, "<p>12. Literal number</p><p>3) Another</p><p>- Plain dash</p><p>---</p><p>~~Not struck~~</p>");
  assert.equal(result.text, "12\\. Literal number\n\n3\\) Another\n\n\\- Plain dash\n\n\\---\n\n\\~\\~Not struck\\~\\~");
});
