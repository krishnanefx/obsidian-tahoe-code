/*
 * Fenced code blocks in a note: where they are and what language they're in.
 * Every feature asks "is the cursor in a code block, and which?" first;
 * outside one, Tahoe Code stays out of the way. Blocks inside callouts (> )
 * and lists keep their prefix, which the editing features step around.
 */

import { langFor } from "./langs";

const FENCE = /^((?:[ \t]*>[ \t]?)*[ \t]*)(`{3,}|~{3,})[ \t]*\{?([^\s`{}]*)\}?(.*)$/;
const QUOTES = /^(?:[ \t]*>[ \t]?)*/;

const cache = new WeakMap(); // doc -> blocks

function blocksOf(doc) {
  let blocks = cache.get(doc);
  if (blocks) return blocks;
  blocks = [];
  let open = null;
  for (let n = 1; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    if (!open) {
      const m = FENCE.exec(text);
      if (m && !(m[2][0] === "`" && m[4].includes("`"))) {
        open = { fenceLine: n, prefix: m[1], quoted: m[1].includes(">"), fence: m[2], lang: (m[3] || "").toLowerCase() };
      }
      continue;
    }
    const body = open.quoted ? text.replace(QUOTES, "") : text.startsWith(open.prefix) ? text.slice(open.prefix.length) : text.trimStart();
    const t = body.trim();
    if (t.length >= open.fence.length && t[0] === open.fence[0] && /^(`{3,}|~{3,})$/.test(t)) {
      blocks.push(finish(open, n, doc));
      open = null;
    }
  }
  if (open) blocks.push(finish(open, doc.lines + 1, doc));
  cache.set(doc, blocks);
  return blocks;
}

function finish(open, closeLine, doc) {
  const firstLine = open.fenceLine + 1;
  const lastLine = closeLine - 1;
  return {
    fenceLine: open.fenceLine,
    closeLine,
    firstLine,
    lastLine,
    lang: open.lang,
    def: langFor(open.lang),
    prefix: open.prefix,
    quoted: open.quoted,
    from: firstLine <= lastLine ? doc.line(firstLine).from : doc.line(open.fenceLine).to,
    to: firstLine <= lastLine ? doc.line(lastLine).to : doc.line(open.fenceLine).to,
  };
}

// The block whose content holds `pos` (the fence lines themselves don't count).
function blockAt(state, pos) {
  const n = state.doc.lineAt(pos).number;
  for (const b of blocksOf(state.doc)) {
    if (n > b.fenceLine && n < b.closeLine) return b.def ? b : null;
    if (b.fenceLine > n) break;
  }
  return null;
}

// The part of a content line that belongs to the note (callout > or list indent).
function prefixOf(block, text) {
  if (block.quoted) return QUOTES.exec(text)[0];
  return block.prefix && text.startsWith(block.prefix) ? block.prefix : "";
}

// A line split into prefix, indent and the rest.
function splitLine(block, text) {
  const prefix = prefixOf(block, text);
  const rest = text.slice(prefix.length);
  const indent = /^[ \t]*/.exec(rest)[0];
  return { prefix, indent, body: rest.slice(indent.length) };
}

// The block's code with prefixes removed, and a map back to the document.
function blockCode(state, block) {
  const lines = [];
  const starts = [];
  let offset = 0;
  for (let n = block.firstLine; n <= block.lastLine; n++) {
    const line = state.doc.line(n);
    const p = prefixOf(block, line.text).length;
    starts.push({ from: line.from + p, offset });
    lines.push(line.text.slice(p));
    offset += line.text.length - p + 1;
  }
  const text = lines.join("\n");
  const toDoc = (off) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid].offset <= off) lo = mid;
      else hi = mid - 1;
    }
    const s = starts[lo];
    return s ? s.from + (off - s.offset) : block.from;
  };
  const fromDoc = (pos) => {
    const n = state.doc.lineAt(pos).number - block.firstLine;
    const s = starts[Math.max(0, Math.min(n, starts.length - 1))];
    return s ? s.offset + Math.max(0, pos - s.from) : 0;
  };
  return { text, lines, toDoc, fromDoc };
}

// Indent unit for a block: what its lines already use, else the language's habit.
function indentUnitOf(state, block, fallbackTab) {
  const counts = new Map();
  let tabs = 0;
  let spaces = 0;
  for (let n = block.firstLine; n <= block.lastLine; n++) {
    const { indent, body } = splitLine(block, state.doc.line(n).text);
    if (!body) continue;
    if (indent.startsWith("\t")) tabs++;
    else if (indent.length) {
      spaces++;
      counts.set(indent.length, (counts.get(indent.length) || 0) + 1);
    }
  }
  if (tabs > spaces) return "\t";
  if (spaces) {
    const widths = [...counts.keys()];
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    const g = widths.reduce(gcd);
    // A lone line indented 8 is two levels of 4, not one level of 8.
    if (g === 2 || g === 3 || g === 4) return " ".repeat(g);
  }
  const unit = block.def.unit;
  if (unit === "tab") return "\t";
  return " ".repeat(unit || 4);
}

// Every block of a language in the note (for words and context).
function blocksOfLang(state, langId) {
  return blocksOf(state.doc).filter((b) => b.def && b.def.id === langId);
}

export { blocksOf, blockAt, prefixOf, splitLine, blockCode, indentUnitOf, blocksOfLang };
