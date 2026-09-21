// Self-contained so Playwright can evaluate it against a response element.
// Site-specific response selection stays in the provider adapter.
export function extractResponseText(root, { format = "text" } = {}) {
  const markdown = format === "markdown";
  const math = { source: 0, rendered: 0 };
  const mathSelector = '[data-math], [data-math-source], .math-inline, .math-block, .katex, .katex-display, math, mjx-container, [role="math"]';

  function hidden(element) {
    if (element.matches('[hidden], [aria-hidden="true"]')) return true;
    const style = getComputedStyle(element);
    return style.display === "none" || style.visibility === "hidden";
  }

  function escape(text) {
    return markdown ? text.replace(/([\\`*_[\]<>$#!~])/gu, "\\$1")
      .replace(/^(\s*)([-+])(?=\s)/u, "$1\\$2")
      .replace(/^(\s*)(\d+)([.)])(?=\s)/u, "$1$2\\$3")
      .replace(/^(\s*)(-{3,}|={3,})(\s*)$/u, "$1\\$2$3") : text;
  }

  function children(element) {
    const blocks = [];
    let inline = "";
    const flush = () => {
      if (inline.trim()) blocks.push(inline.trim());
      inline = "";
    };
    for (const child of element.childNodes) {
      const item = render(child);
      if (item.block) {
        flush();
        if (item.text) blocks.push(item.text);
      } else {
        inline += item.text;
      }
    }
    if (!blocks.length) return inline;
    flush();
    return blocks.join("\n\n");
  }

  function wrap(text, marker) {
    const [, leading, body, trailing] = text.match(/^(\s*)([\s\S]*?)(\s*)$/u);
    return body ? `${leading}${marker}${body}${marker}${trailing}` : text;
  }

  function formula(element) {
    const sourceElement = element.matches('[data-math], [data-math-source]')
      ? element : element.querySelector('[data-math], [data-math-source]');
    const annotation = element.querySelector('annotation[encoding="application/x-tex" i], annotation[encoding="application/x-latex" i]');
    let source = (sourceElement?.getAttribute("data-math") || sourceElement?.getAttribute("data-math-source") || annotation?.textContent || "").trim();
    let block = element.matches('.math-block, .katex-display, math[display="block"], mjx-container[display="true"]');
    if (!source) {
      math.rendered++;
      // KaTeX contains both accessible MathML and visible HTML; read only one.
      const visible = element.querySelector(".katex-html") || element;
      return { text: escape((visible.innerText || visible.textContent || "").trim()), block };
    }
    math.source++;
    if ((source.startsWith("$$") && source.endsWith("$$")) || (source.startsWith("\\[") && source.endsWith("\\]"))) {
      source = source.slice(2, -2);
      block = true;
    } else if (source.startsWith("\\(") && source.endsWith("\\)")) {
      source = source.slice(2, -2);
    } else if (source.startsWith("$") && source.endsWith("$")) {
      source = source.slice(1, -1);
    }
    if (format === "text") return { text: source, block };
    if (markdown) return { text: block ? `$$\n${source}\n$$` : `$${source}$`, block };
    return { text: block ? `\\[\n${source}\n\\]` : `\\(${source}\\)`, block };
  }

  function code(element, block) {
    const content = block ? element.querySelector("code") || element : element;
    const text = content.textContent || "";
    if (!markdown) return { text, block };
    const runs = text.match(/`+/gu) || [];
    const fence = "`".repeat(Math.max(block ? 3 : 1, ...runs.map((run) => run.length + 1)));
    if (!block) {
      const pad = /^`|`$/u.test(text) || (/^ .* $/su.test(text) && text.trim()) ? " " : "";
      return { text: `${fence}${pad}${text}${pad}${fence}`, block: false };
    }
    const language = content.getAttribute("data-language") || element.getAttribute("data-language") ||
      `${content.className} ${element.className}`.match(/(?:^|\s)language-([\w+-]+)/u)?.[1] || "";
    const info = /^[\w+-]+$/u.test(language) ? language : "";
    return { text: `${fence}${info}\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}`, block: true };
  }

  function list(element) {
    const items = [...element.children].filter((child) => child.tagName === "LI" && !hidden(child));
    const ordered = element.tagName === "OL";
    const reversed = element.hasAttribute("reversed");
    let index = element.hasAttribute("start") ? element.start : reversed ? items.length : 1;
    return items.map((item) => {
      if (item.hasAttribute("value")) index = item.value;
      const marker = ordered ? `${index}. ` : "- ";
      index += reversed ? -1 : 1;
      return marker + children(item).trim().replace(/\n/gu, `\n${" ".repeat(marker.length)}`);
    }).join("\n");
  }

  function table(element) {
    const rows = [...element.querySelectorAll("tr")].filter((row) => row.closest("table") === element && !hidden(row));
    const values = rows.map((row) => [...row.cells].map((cell) => children(cell).trim()));
    if (!values.length) return "";
    const caption = element.caption ? children(element.caption).trim() : "";
    let text;
    if (!markdown) {
      text = values.map((row) => row.join("\t")).join("\n");
    } else {
      const width = Math.max(...values.map((row) => row.length));
      const line = (row) => `| ${Array.from({ length: width }, (_, index) => (row[index] || "")
        .replace(/\|/gu, "\\|").replace(/\n/gu, "<br>")).join(" | ")} |`;
      const hasHeader = [...rows[0].cells].every((cell) => cell.tagName === "TH");
      const header = hasHeader ? values.shift() : [];
      text = [line(header), line(Array(width).fill("---")), ...values.map(line)].join("\n");
    }
    return caption ? `${caption}\n\n${text}` : text;
  }

  function render(node) {
    if (node.nodeType === Node.TEXT_NODE) return { text: escape(node.textContent.replace(/[\t\n\r\f ]+/gu, " ")) };
    if (node.nodeType !== Node.ELEMENT_NODE || hidden(node)) return { text: "" };
    if (node.matches('script, style, noscript, template, button, input, select, textarea, svg, canvas, [role="button"]')) return { text: "" };
    if (node.matches(mathSelector)) return formula(node);
    const tag = node.tagName.toLowerCase();
    if (tag === "pre") return code(node, true);
    // Gemini places language labels and copy controls beside the actual code.
    if (node.matches("code-block, .code-block") && node.querySelector("pre")) return code(node.querySelector("pre"), true);
    if (tag === "code") return code(node, false);
    if (tag === "br") return { text: markdown ? "  \n" : "\n" };
    if (tag === "img") return { text: escape(node.getAttribute("alt") || "") };
    if (tag === "ul" || tag === "ol") return { text: list(node), block: true };
    if (tag === "table") return { text: table(node), block: true };
    if (tag === "hr") return { text: markdown ? "---" : "", block: true };
    const text = children(node);
    if (/^h[1-6]$/u.test(tag)) return { text: (markdown ? `${"#".repeat(Number(tag[1]))} ` : "") + text.trim(), block: true };
    if (tag === "blockquote") return { text: markdown ? text.trim().split("\n").map((line) => `> ${line}`).join("\n") : text.trim(), block: true };
    if (markdown) {
      if (tag === "strong" || tag === "b") return { text: wrap(text, "**") };
      if (tag === "em" || tag === "i") return { text: wrap(text, "*") };
      if (tag === "s" || tag === "del") return { text: wrap(text, "~~") };
      if (tag === "a") {
        const href = node.getAttribute("href") || "";
        if (/^(?:https?:|mailto:|\/|#)/iu.test(href)) {
          return { text: `[${text}](<${href.replace(/[<>\s\\]/gu, (character) => encodeURIComponent(character))}>)` };
        }
      }
    }
    const block = /^(p|div|section|article|header|footer|figure|figcaption|dl|dt|dd)$/u.test(tag);
    return { text: block ? text.trim() : text, block };
  }

  return { text: children(root).trim(), extraction: { source: "response_dom", math } };
}
