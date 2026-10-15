/*
 * Typing in code blocks: Enter, brackets and quotes, `end`, Tab and
 * Backspace, comments, and the IDE line commands. Every command first checks
 * that the cursor is in a code block of a known language and otherwise
 * returns false, so the rest of the note behaves exactly as before.
 */

import { EditorSelection, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { completionStatus, acceptCompletion, closeCompletion, hasNextSnippetField, nextSnippetField, hasPrevSnippetField, prevSnippetField } from "@codemirror/autocomplete";
import { moveLineUp, moveLineDown, copyLineDown } from "@codemirror/commands";
import { blockAt, splitLine, blockCode, indentUnitOf } from "./blocks";
import { lexCached } from "./lexer";

const PAIRS = { "(": ")", "[": "]", "{": "}" };
const CLOSING = new Set([")", "]", "}"]);

/* ---------- helpers ---------- */

const width = (ws, tabSize = 4) => [...ws].reduce((w, ch) => (ch === "\t" ? w + tabSize - (w % tabSize) : w + 1), 0);

function unitWidth(unit) {
  return unit === "\t" ? 4 : unit.length;
}

// Indentation `levels` deep in the block's own style.
function makeIndent(unit, columns) {
  if (unit === "\t") return "\t".repeat(Math.round(columns / 4));
  return " ".repeat(Math.max(0, columns));
}

// The code part of a line: comments removed (so `x:  # note` still opens a level).
function codeOf(def, text) {
  const lexed = lexCached(text, def);
  let end = text.length;
  for (const t of lexed.tokens) if (t.type === "comment") end = Math.min(end, t.from);
  return text.slice(0, end).replace(/\s+$/, "");
}

function opensLevel(def, codeBefore) {
  return !!(def.indentAfter && codeBefore && def.indentAfter.test(codeBefore));
}

// Where a line should sit, from the line above it: one level in after an
// opener, one out for else/end/}. (What most editors do; it handles nesting.)
function targetIndent(state, block, lineNo, unit) {
  const def = block.def;
  const u = unitWidth(unit);
  const own = splitLine(block, state.doc.line(lineNo).text);
  let prev = null;
  for (let n = lineNo - 1; n >= block.firstLine; n--) {
    const s = splitLine(block, state.doc.line(n).text);
    if (s.body.trim()) {
      prev = s;
      break;
    }
  }
  if (!prev) return 0;
  let col = width(prev.indent);
  const prevCode = codeOf(def, prev.body);
  const prevOpens = opensLevel(def, prevCode);
  if (prevOpens) col += u;
  else if (def.dedentAfter && def.dedentAfter.test(prev.body)) col = Math.max(0, col - u);
  if (def.dedents && def.dedents.test(own.body)) {
    // The first `case` under a `switch`/`match` stays indented.
    const firstCase = prevOpens && /^\s*(case|otherwise|when)\b/.test(own.body) && /^\s*(switch|match|case)\b/.test(prev.body);
    if (!firstCase) col = Math.max(0, col - u);
  }
  return col;
}

function reindentLine(state, block, lineNo, unit) {
  const line = state.doc.line(lineNo);
  const s = splitLine(block, line.text);
  const want = makeIndent(unit, targetIndent(state, block, lineNo, unit));
  if (want === s.indent) return null;
  const from = line.from + s.prefix.length;
  return { from, to: from + s.indent.length, insert: want };
}

// Has the opener on `lineNo` already got its `end` (or else/elseif…) below it?
function hasCloser(state, block, lineNo, indentCols) {
  for (let n = lineNo + 1; n <= block.lastLine; n++) {
    const s = splitLine(block, state.doc.line(n).text);
    if (!s.body.trim()) continue;
    const col = width(s.indent);
    if (col > indentCols) continue;
    return col === indentCols && block.def.dedents && block.def.dedents.test(s.body);
  }
  return false;
}

function closerFor(def, code) {
  if (!def.ends) return null;
  const trimmed = code.trim();
  for (const [re, closer] of def.ends) {
    const m = re.exec(trimmed);
    if (m) {
      // One-liners already close themselves: `if x, y = 1; end`.
      const word = typeof closer === "function" ? closer(m) : closer.trim();
      if (new RegExp(`\\b${word.split(" ")[0]}\\b`).test(trimmed.slice(m.index + m[0].length))) return null;
      return typeof closer === "function" ? closer(m) : closer;
    }
  }
  return null;
}

function inBlock(state, pos) {
  const block = blockAt(state, pos);
  return block && block.def ? block : null;
}

/* ---------- Enter ---------- */

function smartEnter(plugin) {
  return (view) => {
    const s = plugin.settings;
    const { state } = view;
    if (!s.smartEnter || completionStatus(state) === "active") return false;
    const block = inBlock(state, state.selection.main.head);
    if (!block) return false;
    const def = block.def;
    const unit = indentUnitOf(state, block);
    const u = unitWidth(unit);
    const tr = state.changeByRange((range) => {
      const line = state.doc.lineAt(range.from);
      const sp = splitLine(block, line.text);
      const indentFrom = line.from + sp.prefix.length;
      const changes = [];
      // A line like `else`, `end` or `}` first moves to its proper place.
      let indent = sp.indent;
      if (def.dedents && def.dedents.test(sp.body) && range.from >= indentFrom + sp.indent.length) {
        const fix = reindentLine(state, block, line.number, unit);
        if (fix) {
          changes.push(fix);
          indent = fix.insert;
        }
      }
      const shift = indent.length - sp.indent.length;
      const before = state.sliceDoc(indentFrom + sp.indent.length, range.from);
      const after = state.sliceDoc(range.to, line.to);
      const code = codeOf(def, before);
      const col = width(indent);
      let next = col;
      if (opensLevel(def, code)) next = col + u;
      else if (def.dedentAfter && def.dedentAfter.test(before)) next = Math.max(0, col - u);
      const nl = "\n" + sp.prefix;
      const lastCh = code.slice(-1);
      const nextCh = after.trimStart()[0];
      // Remove spaces left at the end of the line we're leaving.
      const trailing = /[ \t]*$/.exec(before)[0].length;
      const cut = range.from - (after.trim() ? 0 : trailing);
      let insert;
      let cursor;
      if (PAIRS[lastCh] && nextCh === PAIRS[lastCh]) {
        // Between brackets: open a line inside, put the closer on its own line.
        const inner = nl + makeIndent(unit, col + u);
        insert = inner + nl + indent;
        cursor = inner.length;
      } else if (s.autoEnd && !after.trim() && closerFor(def, code) && !hasCloser(state, block, line.number, col)) {
        const inner = nl + makeIndent(unit, col + u);
        insert = inner + nl + indent + closerFor(def, code);
        cursor = inner.length;
      } else {
        insert = nl + makeIndent(unit, next);
        cursor = insert.length;
      }
      const afterTrim = after.length - after.trimStart().length;
      changes.push({ from: cut, to: range.to + (afterTrim && !PAIRS[lastCh] ? afterTrim : 0), insert });
      return { changes, range: EditorSelection.cursor(cut + shift + cursor) };
    });
    view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input" }));
    return true;
  };
}

/* ---------- brackets, quotes and electric characters ---------- */

function inputHandler(plugin) {
  return EditorView.inputHandler.of((view, from, to, text) => {
    const s = plugin.settings;
    if (text.length !== 1 || view.composing) return false;
    const { state } = view;
    const block = inBlock(state, from);
    if (!block) return false;
    const def = block.def;
    const quotes = def.quotes || [];
    const isOpen = PAIRS[text] !== undefined;
    const isQuote = quotes.includes(text);
    const isClose = CLOSING.has(text);
    const electric = (isClose || text === ":") && s.smartEnter;
    if (!(s.autoPairs && (isOpen || isQuote || isClose)) && !electric) return false;

    const code = blockCode(state, block);
    const lexed = lexCached(code.text, def);
    const unit = indentUnitOf(state, block);
    const inTemplate = hasNextSnippetField(state) || hasPrevSnippetField(state);
    let handled = false;
    const tr = state.changeByRange((range) => {
      const line = state.doc.lineAt(range.from);
      const prevCh = state.sliceDoc(range.from - 1, range.from);
      const nextCh = state.sliceDoc(range.to, range.to + 1);
      const where = lexed.at(code.fromDoc(range.from));
      const free = !nextCh || /[\s)\]},;:.]/.test(nextCh);

      if (s.autoPairs && range.empty) {
        // Step over a closer that's already there.
        if ((isClose || isQuote) && nextCh === text && (isClose || where === "string")) {
          handled = true;
          return { range: EditorSelection.cursor(range.from + 1) };
        }
        if (isOpen && where === "code" && free) {
          handled = true;
          return { changes: { from: range.from, insert: text + PAIRS[text] }, range: EditorSelection.cursor(range.from + 1) };
        }
        if (isQuote && where === "code") {
          const sp = splitLine(block, line.text);
          const typingFence = text === "`" && /^`*$/.test(state.sliceDoc(line.from + sp.prefix.length, range.from).trim());
          const transpose = def.transpose && text === "'" && /[\w)\]}'.]/.test(prevCh);
          const apostrophe = /[\w]/.test(prevCh);
          // Python: "" then a third quote makes a docstring pair.
          if (def.triple && state.sliceDoc(range.from - 2, range.from) === text + text && !nextCh.trim()) {
            handled = true;
            return { changes: { from: range.from, insert: text + text.repeat(3) }, range: EditorSelection.cursor(range.from + 1) };
          }
          if (!typingFence && !transpose && !apostrophe && free) {
            handled = true;
            return { changes: { from: range.from, insert: text + text }, range: EditorSelection.cursor(range.from + 1) };
          }
        }
      }
      if (s.autoPairs && !range.empty && (isOpen || isQuote) && !inTemplate) {
        // Wrap the selection (but typing over a template field replaces it).
        handled = true;
        const close = isOpen ? PAIRS[text] : text;
        return {
          changes: [
            { from: range.from, insert: text },
            { from: range.to, insert: close },
          ],
          range: EditorSelection.range(range.from + 1, range.to + 1),
        };
      }
      // `}` or Python's `else:` typed on a line of its own steps back.
      if (electric && range.empty && where === "code") {
        const sp = splitLine(block, line.text);
        const typed = state.sliceDoc(line.from + sp.prefix.length + sp.indent.length, range.from) + text;
        const restOfLine = state.sliceDoc(range.to, line.to);
        if (def.dedents && def.dedents.test(typed + restOfLine) && (isClose ? typed.trim() === text : true)) {
          // Work out the new indent as if the character were already there.
          const probe = state.update({ changes: { from: range.from, insert: text } }).state;
          const fix = reindentLine(probe, block, line.number, unit);
          if (fix) {
            handled = true;
            const delta = fix.insert.length - (fix.to - fix.from);
            return {
              changes: [
                { from: fix.from, to: fix.to, insert: fix.insert },
                { from: range.from, insert: text },
              ],
              range: EditorSelection.cursor(range.from + 1 + delta),
            };
          }
        }
      }
      return { range };
    });
    if (!handled) return false;
    view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.type" }));
    return true;
  });
}

/* ---------- Backspace ---------- */

function smartBackspace(plugin) {
  return (view) => {
    const s = plugin.settings;
    const { state } = view;
    const main = state.selection.main;
    if (!main.empty) return false;
    const block = inBlock(state, main.head);
    if (!block) return false;
    const def = block.def;
    const pos = main.head;
    const prevCh = state.sliceDoc(pos - 1, pos);
    const nextCh = state.sliceDoc(pos, pos + 1);
    // Delete an empty pair together.
    if (s.autoPairs && ((PAIRS[prevCh] && PAIRS[prevCh] === nextCh) || ((def.quotes || []).includes(prevCh) && prevCh === nextCh))) {
      view.dispatch({ changes: { from: pos - 1, to: pos + 1 }, selection: { anchor: pos - 1 }, userEvent: "delete.backward" });
      return true;
    }
    // In the indentation: back to the previous level.
    if (s.smartTab) {
      const line = state.doc.lineAt(pos);
      const sp = splitLine(block, line.text);
      const start = line.from + sp.prefix.length;
      const ws = state.sliceDoc(start, pos);
      if (pos > start && /^ +$/.test(ws)) {
        const unit = indentUnitOf(state, block);
        const u = unitWidth(unit);
        const col = ws.length;
        const to = col % u === 0 ? col - u : col - (col % u);
        view.dispatch({ changes: { from: start + Math.max(0, to), to: pos }, userEvent: "delete.backward" });
        return true;
      }
    }
    return false;
  };
}

/* ---------- Tab and Shift-Tab ---------- */

function selectedLines(state, block) {
  const lines = new Set();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    let b = state.doc.lineAt(r.to).number;
    if (b > a && state.doc.line(b).from === r.to) b--; // selection ending at a line start
    for (let n = Math.max(a, block.firstLine); n <= Math.min(b, block.lastLine); n++) lines.add(n);
  }
  return [...lines].sort((x, y) => x - y);
}

function indentLines(state, block, unit, dir) {
  const u = unitWidth(unit);
  const changes = [];
  for (const n of selectedLines(state, block)) {
    const line = state.doc.line(n);
    const sp = splitLine(block, line.text);
    if (!sp.body.trim() && dir > 0) continue;
    const from = line.from + sp.prefix.length;
    if (dir > 0) changes.push({ from, insert: unit });
    else {
      const col = width(sp.indent);
      if (!col) continue;
      const want = makeIndent(unit, Math.max(0, col - (col % u || u)));
      changes.push({ from, to: from + sp.indent.length, insert: want });
    }
  }
  return changes;
}

function smartTab(plugin) {
  return (view) => {
    const { state } = view;
    // In a template, Tab moves to the next field (Enter takes a suggestion), like IntelliJ.
    if (hasNextSnippetField(state)) {
      if (completionStatus(state)) closeCompletion(view);
      return nextSnippetField(view);
    }
    if (completionStatus(state) === "active") return acceptCompletion(view);
    if (plugin.ghost && plugin.ghost.accept(view)) return true;
    const block = inBlock(state, state.selection.main.head);
    if (!block) return false;
    if (plugin.templates && (plugin.settings.templates || plugin.settings.postfix) && plugin.templates.expand(view, block)) return true;
    if (!plugin.settings.smartTab) return false;
    const unit = indentUnitOf(state, block);
    const main = state.selection.main;
    const multiLine = state.selection.ranges.some((r) => state.doc.lineAt(r.from).number !== state.doc.lineAt(r.to).number);
    if (multiLine || (!main.empty && state.sliceDoc(main.from, main.to).length === state.doc.lineAt(main.from).length)) {
      view.dispatch({ changes: indentLines(state, block, unit, 1), userEvent: "input.indent" });
      return true;
    }
    // Insert spaces to the next indent stop.
    const tr = state.changeByRange((range) => {
      const line = state.doc.lineAt(range.from);
      const sp = splitLine(block, line.text);
      const col = width(state.sliceDoc(line.from + sp.prefix.length, range.from));
      const u = unitWidth(unit);
      const insert = unit === "\t" ? "\t" : " ".repeat(u - (col % u));
      return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(range.from + insert.length) };
    });
    view.dispatch(state.update(tr, { userEvent: "input.indent" }));
    return true;
  };
}

function smartShiftTab(plugin) {
  return (view) => {
    const { state } = view;
    if (hasPrevSnippetField(state)) return prevSnippetField(view);
    const block = inBlock(state, state.selection.main.head);
    if (!block || !plugin.settings.smartTab) return false;
    const changes = indentLines(state, block, indentUnitOf(state, block), -1);
    if (changes.length) view.dispatch({ changes, userEvent: "delete.dedent" });
    return true;
  };
}

/* ---------- comments ---------- */

function toggleComment(view) {
  const { state } = view;
  const block = inBlock(state, state.selection.main.head);
  if (!block) return false;
  const def = block.def;
  const lines = selectedLines(state, block);
  if (!lines.length) return false;
  if (!def.line && def.block) {
    // Languages without line comments (CSS, HTML): wrap the lines.
    const first = state.doc.line(lines[0]);
    const last = state.doc.line(lines[lines.length - 1]);
    const from = first.from + splitLine(block, first.text).prefix.length + splitLine(block, first.text).indent.length;
    const text = state.sliceDoc(from, last.to);
    const [a, b] = def.block;
    if (text.startsWith(a) && text.endsWith(b)) view.dispatch({ changes: { from, to: last.to, insert: text.slice(a.length, -b.length).trim() } });
    else view.dispatch({ changes: { from, to: last.to, insert: `${a} ${text} ${b}` } });
    return true;
  }
  const token = def.line;
  const parts = lines.map((n) => ({ n, line: state.doc.line(n), sp: splitLine(block, state.doc.line(n).text) })).filter((x) => x.sp.body.trim());
  if (!parts.length) return true;
  const allCommented = parts.every((x) => x.sp.body.startsWith(token));
  const minCol = Math.min(...parts.map((x) => x.sp.indent.length));
  const changes = parts.map(({ line, sp }) => {
    const at = line.from + sp.prefix.length;
    if (allCommented) {
      const from = at + sp.indent.length;
      const len = token.length + (sp.body[token.length] === " " ? 1 : 0);
      return { from, to: from + len };
    }
    return { from: at + minCol, insert: token + " " };
  });
  view.dispatch({ changes, userEvent: "input.comment" });
  return true;
}

/* ---------- lines ---------- */

function withinBlock(cmd, edge) {
  return (view) => {
    const { state } = view;
    const block = inBlock(state, state.selection.main.head);
    if (!block) return false;
    const lines = selectedLines(state, block);
    if (edge === "up" && lines[0] <= block.firstLine) return true;
    if (edge === "down" && lines[lines.length - 1] >= block.lastLine) return true;
    return cmd(view);
  };
}

function duplicateLine(view) {
  const block = inBlock(view.state, view.state.selection.main.head);
  if (!block) return false;
  return copyLineDown(view);
}

// ⌃G: add the next occurrence of the selection (or the word) to the selection, within the block.
function selectNext(view) {
  const { state } = view;
  const block = inBlock(state, state.selection.main.head);
  if (!block) return false;
  const main = state.selection.main;
  if (main.empty) {
    const word = state.wordAt(main.head);
    if (word) view.dispatch({ selection: EditorSelection.range(word.from, word.to) });
    return true;
  }
  const needle = state.sliceDoc(main.from, main.to);
  const text = state.sliceDoc(block.from, block.to);
  const last = state.selection.ranges.reduce((m, r) => Math.max(m, r.to), 0);
  let at = text.indexOf(needle, last - block.from);
  if (at < 0) at = text.indexOf(needle);
  const taken = (from) => state.selection.ranges.some((r) => r.from === from);
  if (at < 0 || taken(block.from + at)) return true;
  const range = EditorSelection.range(block.from + at, block.from + at + needle.length);
  view.dispatch({ selection: state.selection.addRange(range), scrollIntoView: true });
  return true;
}

// ⇧F6: every use of the name under the cursor in this block, as cursors.
function renameInBlock(view) {
  const { state } = view;
  const block = inBlock(state, state.selection.main.head);
  if (!block) return false;
  const code = blockCode(state, block);
  const lexed = lexCached(code.text, block.def);
  const here = lexed.identAt(code.fromDoc(state.selection.main.head));
  if (!here) return true;
  const ranges = lexed.tokens
    .filter((t) => t.type === "ident" && t.value === here.value)
    .map((t) => EditorSelection.range(code.toDoc(t.from), code.toDoc(t.to)));
  const main = ranges.findIndex((r) => r.from <= state.selection.main.head && r.to >= state.selection.main.head);
  view.dispatch({ selection: EditorSelection.create(ranges, Math.max(0, main)), userEvent: "select" });
  return true;
}

/* ---------- the extension ---------- */

function editingExtension(plugin) {
  const s = () => plugin.settings;
  const guard = (key, fn) => (view) => (s()[key] ? fn(view) : false);
  return [
    inputHandler(plugin),
    Prec.highest(
      keymap.of([
        { key: "Enter", run: smartEnter(plugin) },
        { key: "Tab", run: smartTab(plugin), shift: smartShiftTab(plugin) },
        { key: "Backspace", run: smartBackspace(plugin) },
        { key: "Alt-ArrowUp", run: guard("lineOps", withinBlock(moveLineUp, "up")) },
        { key: "Alt-ArrowDown", run: guard("lineOps", withinBlock(moveLineDown, "down")) },
        { key: "Shift-Alt-ArrowUp", run: guard("lineOps", withinBlock(moveLineUp, "up")) },
        { key: "Shift-Alt-ArrowDown", run: guard("lineOps", withinBlock(moveLineDown, "down")) },
        { key: "Ctrl-g", run: guard("lineOps", selectNext) },
        { key: "Shift-F6", run: guard("lineOps", renameInBlock) },
        { key: "Escape", run: (view) => !!(plugin.ghost && plugin.ghost.dismiss(view)) },
      ])
    ),
  ];
}

export { editingExtension, toggleComment, duplicateLine, inBlock, targetIndent, makeIndent, unitWidth, width, codeOf, opensLevel };
