/*
 * Whole-block commands: select, copy. The line logic is plain functions on text
 * (no editor), so it can be tested; the commands apply it to the code block
 * around the cursor and leave a callout's > or a list's indent alone.
 */

import { blockCode } from "./blocks";

/* ---------- commands ---------- */

function selectBlock(view, block) {
  if (block.lastLine < block.firstLine) return false;
  view.dispatch({ selection: { anchor: block.from, head: block.to }, scrollIntoView: true });
  return true;
}

function blockText(view, block) {
  return blockCode(view.state, block).text;
}

export { selectBlock, blockText };
