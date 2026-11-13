// The page of a fixture's text, for the many fixtures written in Markdown that say nothing of a page: a small renderer of the Markdown
// they use, the same words in the shapes the forum's pages have. A test of the page gives its own `html`.

const escaped = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const emphasis = (text: string): string => escaped(text)
  .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*\s][^*]*)\*/g, "<em>$1</em>").replace(/~~([^~]+)~~/g, "<s>$1</s>");

/** An image, a footnote marker, a link, an autolink, a bare address or a code span. */
const TOKEN = /!\[([^\]]*)\]\(([^)\s]*)\)|\[\^([^\]\s]+)\]|\[([^\]]*)\]\(([^)\s]*)\)|<(https?:[^>\s]+)>|(https?:\/\/[^\s)<]+)|`([^`]+)`/g;

function inline(text: string): string {
  let out = "";
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    out += emphasis(text.slice(at, m.index));
    at = m.index + m[0].length;
    const [, alt, src, note, label, href, auto, bare, code] = m;
    if (src !== undefined) out += `<img alt="${escaped(alt ?? "")}" src="${src}">`;
    else if (note !== undefined) out += `<span class="footnote-reference" data-footnote-id="${note}" role="doc-noteref"><sup><a href="#fn${note}">[1]</a></sup></span>`;
    else if (href !== undefined) out += `<a href="${href}">${inline(label ?? "")}</a>`;
    else if (auto ?? bare) out += `<a href="${auto ?? bare}">${escaped((auto ?? bare)!)}</a>`;
    else out += `<code>${escaped(code ?? "")}</code>`;
  }
  return out + emphasis(text.slice(at));
}

const items = (block: string, marker: RegExp): string => block.split("\n").map((line) => `<li>${inline(line.replace(marker, ""))}</li>`).join("");

function blockOf(block: string): string {
  const lines = block.split("\n");
  const heading = /^(#{1,6})\s+(.*)$/.exec(block);
  if (heading && lines.length === 1) return `<h${heading[1]!.length}>${inline(heading[2]!)}</h${heading[1]!.length}>`;
  if (lines.length === 2 && /^=+$/.test(lines[1]!)) return `<h1>${inline(lines[0]!)}</h1>`;
  if (lines.length === 2 && /^-+$/.test(lines[1]!)) return `<h2>${inline(lines[0]!)}</h2>`;
  if (/^([-*_])\1{2,}$/.test(block)) return "<hr>";
  if (lines.every((line) => line.startsWith(">"))) return `<blockquote>${pageOf(lines.map((line) => line.replace(/^> ?/, "")).join("\n"))}</blockquote>`;
  if (lines.every((line) => /^[-*] /.test(line))) return `<ul>${items(block, /^[-*] /)}</ul>`;
  if (lines.every((line) => /^\d+\. /.test(line))) return `<ol>${items(block, /^\d+\. /)}</ol>`;
  const definition = /^\[\^([^\]\s]+)\]:\s*(.*)$/s.exec(block);
  if (definition) {
    return `<ol class="footnotes" role="doc-endnotes"><li class="footnote-item" data-footnote-id="${definition[1]}" role="doc-endnote"><div class="footnote-content"><p>${inline(definition[2]!)}</p></div></li></ol>`;
  }
  return `<p>${inline(block.replaceAll("\n", " "))}</p>`;
}

export function pageOf(markdown: string): string {
  const out: string[] = [];
  const parts = markdown.split(/(^```[^\n]*\n[\s\S]*?^```\s*$)/m);
  for (const part of parts) {
    if (part.startsWith("```widget[")) out.push('<div class="iframe-widget" data-iframe-widget-id="w"></div>');
    else if (part.startsWith("```")) out.push(`<pre><code>${escaped(part.replace(/^```[^\n]*\n/, "").replace(/\n?```\s*$/, ""))}</code></pre>`);
    else for (const block of part.split(/\n\s*\n/)) if (block.trim() !== "") out.push(blockOf(block.trim()));
  }
  return out.join("");
}
