/*
 * ⇧⌥F: format the code block. On the Mac a real formatter runs when one is
 * installed (clang-format, swift-format, Black or Ruff, gofmt, rustfmt…, see
 * desktop/tools.js). Otherwise, and on iPhone, Tahoe tidies: trailing spaces
 * go, tabs and spaces settle on the block's style, and languages whose
 * indentation is only for show (MATLAB, Ruby, Lua, Julia, the shell, braces)
 * are re-indented. Python and YAML keep their indentation — it's meaning.
 */

import { Notice } from "obsidian";
import { blockAt, splitLine, indentUnitOf } from "./blocks";
import { codeOf, opensLevel, makeIndent, unitWidth, width } from "./editing";

const MEANINGFUL_INDENT = new Set(["python", "yaml", "haskell"]);

function reindent(lines, def, unit) {
  const u = unitWidth(unit);
  let prevCol = 0;
  let prevBody = null;
  return lines.map((text) => {
    const body = text.trimStart();
    if (!body) return "";
    let col = 0;
    if (prevBody != null) {
      col = prevCol;
      const prevOpens = opensLevel(def, codeOf(def, prevBody));
      if (prevOpens) col += u;
      else if (def.dedentAfter && def.dedentAfter.test(prevBody)) col -= u;
      if (def.dedents && def.dedents.test(body)) {
        const firstCase = prevOpens && /^(case|otherwise|when)\b/.test(body) && /^(switch|match|case)\b/.test(prevBody);
        if (!firstCase) col -= u;
      }
    }
    col = Math.max(0, col);
    prevCol = col;
    prevBody = body;
    return makeIndent(unit, col) + body;
  });
}

function tidy(lines, def, unit) {
  const trimmed = lines.map((l) => l.replace(/[ \t]+$/, ""));
  if (MEANINGFUL_INDENT.has(def.id)) {
    // Keep each line's depth, but in one style.
    return trimmed.map((l) => {
      const ws = /^[ \t]*/.exec(l)[0];
      return ws ? makeIndent(unit, width(ws)) + l.slice(ws.length) : l;
    });
  }
  return reindent(trimmed, def, unit);
}

async function formatBlock(plugin, view) {
  const state = view.state;
  const block = blockAt(state, state.selection.main.head);
  if (!block || block.firstLine > block.lastLine) return;
  const def = block.def;
  const unit = indentUnitOf(state, block);
  const rows = [];
  for (let n = block.firstLine; n <= block.lastLine; n++) {
    const line = state.doc.line(n);
    const sp = splitLine(block, line.text);
    rows.push({ prefix: sp.prefix, text: line.text.slice(sp.prefix.length) });
  }
  const source = rows.map((r) => r.text).join("\n");
  let formatted = null;
  let how = "Tidied";
  if (plugin.desktop && plugin.settings.format) {
    try {
      const r = await plugin.desktop.format(def, source, unit);
      if (r && typeof r.text === "string") {
        formatted = r.text.replace(/\n+$/, "");
        how = `Formatted with ${r.tool}`;
      }
    } catch (e) {
      new Notice(`Couldn't format: ${String(e.message || e).split("\n")[0]}`, 6000);
      return;
    }
  }
  if (formatted == null) formatted = tidy(source.split("\n"), def, unit).join("\n");
  if (formatted === source) {
    new Notice(`${how.replace(/^Formatted/, "Already formatted")} — nothing to change`, 2500);
    return;
  }
  // Put each line's callout prefix back.
  const prefix = rows[0] ? rows[0].prefix : "";
  const out = formatted
    .split("\n")
    .map((l) => (block.quoted ? (prefix || "> ") + l : prefix + l))
    .join("\n");
  const from = state.doc.line(block.firstLine).from;
  const to = state.doc.line(block.lastLine).to;
  // Keep the cursor on the same line (and near the same text).
  const head = state.selection.main.head;
  const curLine = state.doc.lineAt(head).number - block.firstLine;
  const outLines = out.split("\n");
  let pos = from;
  for (let i = 0; i < Math.min(curLine, outLines.length - 1); i++) pos += outLines[i].length + 1;
  const col = Math.min(head - state.doc.lineAt(head).from, (outLines[Math.min(curLine, outLines.length - 1)] || "").length);
  view.dispatch({ changes: { from, to, insert: out }, selection: { anchor: pos + col }, userEvent: "input.format" });
  new Notice(how, 2000);
}

export { formatBlock, tidy, reindent };
