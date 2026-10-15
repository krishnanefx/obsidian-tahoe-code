/*
 * What you see in a code block: indent guides, bracket pairs in colour with
 * the pair at the cursor marked, the current line, and line numbers.
 * Only lines on screen are decorated. Guides are drawn as a background on
 * the line itself (no extra elements), so the cursor and selection behave
 * exactly as before.
 */

import { ViewPlugin, Decoration } from "@codemirror/view";
import { blocksOf, blockAt, splitLine, blockCode, indentUnitOf } from "./blocks";
import { lexCached } from "./lexer";

const TAB = 4;
const cols = (ws) => [...ws].reduce((w, ch) => (ch === "\t" ? w + TAB - (w % TAB) : w + 1), 0);
const lineDecos = new Map(); // memo: "class|style|n" -> Decoration
function lineDeco(cls, style, n) {
  const key = `${cls}|${style}|${n}`;
  let d = lineDecos.get(key);
  if (!d) {
    const attributes = {};
    if (style) attributes.style = style;
    if (n) attributes["data-tc-ln"] = String(n);
    d = Decoration.line({ class: cls, attributes });
    if (lineDecos.size > 4000) lineDecos.clear();
    lineDecos.set(key, d);
  }
  return d;
}
const bracketMarks = [0, 1, 2].map((k) => Decoration.mark({ class: `tc-br tc-br-${k}` }));
const matchMark = Decoration.mark({ class: "tc-br-match" });
const badMark = Decoration.mark({ class: "tc-br-bad" });

function build(view, plugin) {
  const s = plugin.settings;
  if (!s.guides && !s.bracketColors && !s.matchBrackets && !s.currentLine && !s.lineNumbers) return Decoration.none;
  const { state } = view;
  const head = state.selection.main.head;
  const headLine = state.doc.lineAt(head).number;
  const out = [];
  for (const vr of view.visibleRanges) {
    const firstVisible = state.doc.lineAt(vr.from).number;
    const lastVisible = state.doc.lineAt(vr.to).number;
    for (const b of blocksOf(state.doc)) {
      if (!b.def || b.lastLine < firstVisible || b.firstLine > lastVisible || b.firstLine > b.lastLine) continue;
      const first = Math.max(b.firstLine, firstVisible);
      const last = Math.min(b.lastLine, lastVisible);
      decorateBlock(state, plugin, b, first, last, headLine, head, out);
    }
  }
  return Decoration.set(out, true);
}

function decorateBlock(state, plugin, b, first, last, headLine, head, out) {
  const s = plugin.settings;
  const unit = indentUnitOf(state, b);
  const u = unit === "\t" ? TAB : unit.length;
  // Indent columns per line; blank lines take the smaller of their neighbours.
  const n0 = b.firstLine;
  const indents = [];
  for (let n = n0; n <= b.lastLine; n++) {
    const sp = splitLine(b, state.doc.line(n).text);
    indents.push(sp.body.trim() ? cols(sp.indent) : null);
  }
  const guideAt = (i) => {
    if (indents[i] != null) return indents[i];
    let up = null;
    let down = null;
    for (let k = i - 1; k >= 0; k--) if (indents[k] != null) { up = indents[k]; break; }
    for (let k = i + 1; k < indents.length; k++) if (indents[k] != null) { down = indents[k]; break; }
    return up == null || down == null ? 0 : Math.min(up, down);
  };
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    const classes = ["tc-code"];
    let style = "";
    if (s.guides && !b.quoted && !b.prefix) {
      const w = guideAt(n - n0);
      if (w >= u) {
        classes.push("tc-guides");
        style = `--tc-w:${w}ch;--tc-u:${u}ch`;
      }
    }
    if (s.currentLine && n === headLine && state.selection.main.empty) classes.push("tc-active");
    if (s.lineNumbers) classes.push("tc-ln");
    out.push(lineDeco(classes.join(" "), style, s.lineNumbers ? n - n0 + 1 : 0).range(line.from));
  }
  if (!s.bracketColors && !s.matchBrackets) return;
  const code = blockCode(state, b);
  const lexed = lexCached(code.text, b.def);
  const from = state.doc.line(first).from;
  const to = state.doc.line(last).to;
  if (s.bracketColors) {
    for (const t of lexed.tokens) {
      if (t.type !== "open" && t.type !== "close") continue;
      const at = code.toDoc(t.from);
      if (at < from || at > to) continue;
      out.push(bracketMarks[(t.depth || 0) % 3].range(at, at + 1));
    }
  }
  if (s.matchBrackets && head >= b.from && head <= b.to && head >= from && head <= to) {
    const t = lexed.bracketNear(code.fromDoc(head));
    if (t) {
      const partner = t.partner != null ? lexed.tokens[t.partner] : null;
      const a = code.toDoc(t.from);
      out.push((partner ? matchMark : badMark).range(a, a + 1));
      if (partner) {
        const p = code.toDoc(partner.from);
        out.push(matchMark.range(p, p + 1));
      }
    }
  }
}

function visualsExtension(plugin) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = build(view, plugin);
      }
      update(u) {
        // The cursor only matters to the current line and bracket pair, so a
        // click that neither leaves nor lands in a code block changes nothing.
        const inCode = (state) => !!blockAt(state, state.selection.main.head);
        if (u.docChanged || u.viewportChanged || u.transactions.some((tr) => tr.reconfigured) || (u.selectionSet && (inCode(u.startState) || inCode(u.state)))) this.decorations = build(u.view, plugin);
      }
    },
    { decorations: (v) => v.decorations }
  );
}

export { visualsExtension };
