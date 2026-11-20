/*
 * Whole-block commands: select, copy, duplicate, sort, tidy. The line logic is plain functions on text
 * (no editor), so it can be tested; the commands apply it to the code block
 * around the cursor and leave a callout's > or a list's indent alone.
 */

import { splitLine, blockCode } from "./blocks";
import { selectedLines } from "./editing";

/* ---------- pure line logic ---------- */

// Natural order, ignoring case: item2 before item10, "b" after "A".
function sortLines(lines, descending = false) {
  const sorted = lines.slice().sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
  return descending ? sorted.reverse() : sorted;
}

const trimEnd = (line) => line.replace(/[ \t]+$/, "");

/* ---------- commands ---------- */

// Replace the body of each line in `numbers` (keeping its prefix) with fn(body, index).
function rewriteLines(view, block, numbers, fn) {
  const { state } = view;
  const changes = [];
  numbers.forEach((n, i) => {
    const line = state.doc.line(n);
    const sp = splitLine(block, line.text);
    const rest = line.text.slice(sp.prefix.length);
    const next = fn(rest, i);
    if (next !== rest) changes.push({ from: line.from + sp.prefix.length, to: line.to, insert: next });
  });
  if (!changes.length) return false;
  view.dispatch({ changes, userEvent: "input.tidy" });
  return true;
}

const allLines = (block) => Array.from({ length: block.lastLine - block.firstLine + 1 }, (_, i) => block.firstLine + i);

function selectBlock(view, block) {
  if (block.lastLine < block.firstLine) return false;
  view.dispatch({ selection: { anchor: block.from, head: block.to }, scrollIntoView: true });
  return true;
}

function blockText(view, block) {
  return blockCode(view.state, block).text;
}

function duplicateBlock(view, block) {
  const { doc } = view.state;
  if (block.closeLine > doc.lines) return false; // no closing fence yet
  const text = doc.sliceString(doc.line(block.fenceLine).from, doc.line(block.closeLine).to);
  const at = doc.line(block.closeLine).to;
  view.dispatch({ changes: { from: at, insert: "\n\n" + text }, userEvent: "input.duplicate" });
  return true;
}

// Sort the selected lines, or the whole block with nothing selected.
function sortSelected(view, block, descending) {
  const sel = view.state.selection.main;
  const numbers = sel.empty ? allLines(block) : selectedLines(view.state, block);
  const bodies = numbers.map((n) => view.state.doc.line(n).text.slice(splitLine(block, view.state.doc.line(n).text).prefix.length));
  const sorted = sortLines(bodies, descending);
  return rewriteLines(view, block, numbers, (_, i) => sorted[i]);
}

function trimBlock(view, block) {
  return rewriteLines(view, block, allLines(block), trimEnd);
}

export { sortLines, trimEnd, selectBlock, blockText, duplicateBlock, sortSelected, trimBlock };
