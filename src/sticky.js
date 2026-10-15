/*
 * Sticky scope headers, like Xcode: scrolling through a long block, the
 * lines that opened where you are (def …:, class …:, for … {, function …)
 * stay pinned at the top of the note, up to three deep. Click one to go there.
 */

import { ViewPlugin, EditorView } from "@codemirror/view";
import { blockAt, splitLine } from "./blocks";

const MAX_ROWS = 3;

function indentOf(text) {
  let w = 0;
  for (const c of text) {
    if (c === " ") w++;
    else if (c === "\t") w += 4;
    else break;
  }
  return w;
}

// Does this line open a scope that the lines below sit inside?
function opensScope(lang, text) {
  const t = text.trim();
  if (!t || /^(#|\/\/|%|--|\*)/.test(t)) return false;
  if (lang === "python") return /^(async\s+def|def|class|if|elif|else|for|async\s+for|while|try|except|finally|with|async\s+with|match|case)\b.*:\s*(#.*)?$/.test(t);
  if (["matlab", "octave", "julia", "ruby", "lua"].includes(lang)) return /^(function|classdef|methods|properties|events|if|elseif|else|for|parfor|while|switch|case|otherwise|try|catch|def|class|module|begin|local\s+function)\b/.test(t) || /\bdo\s*(\|[^|]*\|)?$/.test(t);
  if (lang === "shell") return /^(if|elif|else|for|while|until|case|function)\b|\(\)\s*\{\s*$/.test(t);
  if (lang === "yaml") return /:\s*$/.test(t);
  return /\{\s*(\/\/.*|\/\*.*\*\/)?$/.test(t);
}

// The lines that opened the scope around `lineNo`, outermost first.
function scopeChain(state, block, lineNo) {
  const doc = state.doc;
  const lang = block.def.id;
  const body = (n) => {
    const text = doc.line(n).text;
    return text.slice(splitLine(block, text).prefix.length);
  };
  // Blank lines take the indent of the next line with code.
  let n = lineNo;
  while (n <= block.lastLine && !body(n).trim()) n++;
  if (n > block.lastLine) return [];
  let indent = indentOf(body(n));
  const chain = [];
  for (let k = n - 1; k >= block.firstLine && indent > 0; k--) {
    const text = body(k);
    if (!text.trim()) continue;
    const ind = indentOf(text);
    if (ind >= indent) continue;
    if (opensScope(lang, text)) chain.unshift(k);
    indent = ind;
  }
  return chain.slice(-MAX_ROWS);
}

function stickyExtension(plugin) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.view = view;
        this.el = null;
        this.key = "";
        this.onScroll = () => this.schedule();
        view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
        this.schedule();
      }

      update(u) {
        if (u.docChanged || u.viewportChanged || u.geometryChanged) this.schedule();
      }

      schedule() {
        this.view.requestMeasure({ key: this, read: (view) => this.read(view), write: (m) => this.write(m) });
      }

      read(view) {
        if (!plugin.settings.stickyScope) return null;
        const scroller = view.scrollDOM.getBoundingClientRect();
        // Tahoe's toolbar floats over the note: start below it.
        const header = view.dom.closest(".workspace-leaf-content") && view.dom.closest(".workspace-leaf-content").querySelector(".view-header");
        const headerBottom = header ? header.getBoundingClientRect().bottom : scroller.top;
        const topY = Math.max(scroller.top, headerBottom);
        const lineBlock = view.lineBlockAtHeight(topY - view.documentTop + 2);
        const line = view.state.doc.lineAt(lineBlock.from);
        const block = blockAt(view.state, line.from);
        if (!block || line.number <= block.firstLine) return null;
        const chain = scopeChain(view.state, block, line.number).filter((n) => view.lineBlockAt(view.state.doc.line(n).from).top < topY - view.documentTop);
        if (!chain.length) return null;
        const lineEl = view.domAtPos(line.from).node;
        const cmLine = (lineEl.nodeType === 1 ? lineEl : lineEl.parentElement).closest(".cm-line");
        if (!cmLine) return null;
        const lr = cmLine.getBoundingClientRect();
        const editor = view.dom.getBoundingClientRect();
        // Each row: a copy of the real line when it's drawn (keeps colours and its number).
        const rows = chain.map((n) => {
          const l = view.state.doc.line(n);
          let dom = null;
          try {
            const at = view.domAtPos(l.from).node;
            const el = (at.nodeType === 1 ? at : at.parentElement).closest(".cm-line");
            if (el && el !== cmLine) dom = el;
          } catch {
            // not a line of this editor
          }
          return { n, from: l.from, text: l.text, dom };
        });
        return {
          key: `${block.fenceLine}:${chain.join(",")}`,
          rows,
          top: topY - editor.top,
          left: lr.left - editor.left,
          width: lr.width,
          bg: getComputedStyle(cmLine).backgroundColor,
          lineClass: cmLine.className,
        };
      }

      write(m) {
        if (!m) return this.hide();
        if (!this.el) {
          this.el = this.view.dom.appendChild(document.createElement("div"));
          this.el.className = "tc-sticky";
          this.el.addEventListener("mousedown", (e) => {
            const row = e.target.closest(".tc-sticky-row");
            if (!row) return;
            e.preventDefault();
            const from = +row.dataset.from;
            this.view.dispatch({ selection: { anchor: from }, effects: EditorView.scrollIntoView(from, { y: "start", yMargin: 120 }) });
            this.view.focus();
          });
        }
        Object.assign(this.el.style, { top: `${m.top}px`, left: `${m.left}px`, width: `${m.width}px`, display: "" });
        this.el.style.setProperty("--tc-sticky-bg", m.bg && m.bg !== "rgba(0, 0, 0, 0)" ? m.bg : "var(--code-background)");
        if (m.key === this.key) return;
        this.key = m.key;
        this.el.empty();
        for (const r of m.rows) {
          let row;
          if (r.dom) {
            row = r.dom.cloneNode(true);
            row.querySelectorAll(".cm-fold-indicator, .cm-widgetBuffer, img").forEach((x) => x.remove());
            row.classList.remove("tc-active", "cm-active");
          } else {
            row = document.createElement("div");
            row.className = m.lineClass.replace(/\btc-active\b|\bcm-active\b/g, "");
            row.textContent = r.text;
          }
          row.classList.add("tc-sticky-row");
          row.dataset.from = String(r.from);
          row.removeAttribute("contenteditable");
          this.el.appendChild(row);
        }
      }

      hide() {
        if (this.el) this.el.hide();
        this.key = "";
      }

      destroy() {
        this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
        if (this.el) this.el.remove();
      }
    }
  );
}

export { stickyExtension, scopeChain, opensScope };
