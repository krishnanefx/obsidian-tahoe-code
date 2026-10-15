/*
 * Finding your way around a note's code, like Xcode:
 *   • every use of the name under the cursor is highlighted, across the note's
 *     blocks of that language;
 *   • ⌘-click a name (or ⌘B on it) to go to where it's defined — through the
 *     language server when one is running, else by recognising definitions:
 *     def, class, function, assignments, imports, declarations. On the
 *     definition itself, it goes to the next use instead.
 *   • holding ⌘ over a name underlines it, like a link.
 */

import { Notice, Platform } from "obsidian";
import { StateField, StateEffect } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import { blockAt, blockCode, blocksOfLang } from "./blocks";
import { lexCached } from "./lexer";

const RESERVED = new Set(
  "if else elif for while do return def class function end endfunction endif endwhile endfor import from as in not and or is None True False null nil true false var let const new this self super int void float double char bool boolean string str public private protected static final try catch except finally raise throw with lambda yield async await break continue pass switch case default struct enum interface package include using namespace template typename auto unsigned long short signed extern sizeof typeof instanceof delete then fi done elseif global persistent func fn fun val mut impl trait pub use mod match where print".split(" ")
);

// The identifier at pos in a code block, with its block.
function identAt(state, pos) {
  const block = blockAt(state, pos);
  if (!block) return null;
  const code = blockCode(state, block);
  const off = code.fromDoc(pos);
  if (off == null) return null;
  const tok = lexCached(code.text, block.def).tokens.find((t) => t.type === "ident" && t.from <= off && off <= t.to);
  if (!tok || RESERVED.has(tok.value) || /^\d/.test(tok.value)) return null;
  return { block, code, name: tok.value, from: code.toDoc(tok.from), to: code.toDoc(tok.to) };
}

// Every use of name in the note's blocks of this language (not in strings or comments).
function occurrences(state, def, name) {
  const out = [];
  for (const b of blocksOfLang(state, def.id)) {
    const code = blockCode(state, b);
    if (!code.text.includes(name)) continue;
    for (const t of lexCached(code.text, b.def).tokens) if (t.type === "ident" && t.value === name) out.push({ from: code.toDoc(t.from), to: code.toDoc(t.to) });
  }
  return out;
}

/* ---------- uses of the name under the cursor ---------- */

const useMark = Decoration.mark({ class: "tc-use" });
const useHere = Decoration.mark({ class: "tc-use tc-use-here" });

function usesExtension(plugin) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        this.decorations = this.compute(view);
      }
      update(u) {
        if (u.docChanged || u.viewportChanged || u.focusChanged) this.decorations = this.compute(u.view);
        else if (u.selectionSet && (this.decorations !== Decoration.none || blockAt(u.state, u.state.selection.main.head))) this.decorations = this.compute(u.view);
      }
      compute(view) {
        if (!plugin.settings.highlightUses) return Decoration.none;
        const sel = view.state.selection.main;
        if (!sel.empty || view.state.selection.ranges.length > 1) return Decoration.none;
        const hit = identAt(view.state, sel.head);
        if (!hit) return Decoration.none;
        const all = occurrences(view.state, hit.block.def, hit.name);
        if (all.length < 2) return Decoration.none;
        const visible = view.visibleRanges;
        const ranges = all.filter((o) => visible.some((v) => o.to >= v.from && o.from <= v.to)).map((o) => (o.from === hit.from ? useHere : useMark).range(o.from, o.to));
        return Decoration.set(ranges, true);
      }
    },
    { decorations: (v) => v.decorations }
  );
}

/* ---------- go to definition ---------- */

const esc = (s) => s.replace(/[$]/g, "\\$&");

// Patterns for where a name is defined, most telling first. Group 1 is the name.
function patternsFor(id, n) {
  const N = `(${esc(n)})`;
  const B = "(?![\\w$])";
  const py = [
    `^\\s*(?:async\\s+)?def\\s+${N}${B}`,
    `^\\s*class\\s+${N}${B}`,
    `^\\s*(?:from\\s+\\S+\\s+)?import\\s+(?:.*,\\s*)?(?:[\\w.]+\\s+as\\s+)?${N}${B}`,
    `^\\s*(?:[\\w.\\[\\]]+\\s*,\\s*)*${N}\\s*(?:,\\s*[\\w.\\[\\]]+\\s*)*(?::[^=\\n]+)?=(?!=)`,
    `\\bfor\\s+(?:[\\w\\s,()]*?[\\s,(])?${N}${B}[\\w\\s,()]*\\bin\\b`,
    `\\bas\\s+${N}${B}`,
    `\\b(?:self|cls)\\.${N}\\s*(?::[^=\\n]+)?=(?!=)`,
    `\\bdef\\s+\\w+\\s*\\([^)]*?\\b${N}${B}`,
  ];
  const matlab = [
    `^\\s*function\\s+(?:(?:\\[[^\\]]*\\]|\\w+)\\s*=\\s*)?${N}${B}`,
    `^\\s*\\[[^\\]]*\\b${N}${B}[^\\]]*\\]\\s*=(?!=)`,
    `^\\s*${N}\\s*(?:\\([^)]*\\)|\\.[\\w.]+)?\\s*=(?!=)`,
    `\\bfor\\s+${N}\\s*=`,
    `^\\s*(?:global|persistent)\\s+.*\\b${N}${B}`,
  ];
  const js = [
    `\\bfunction\\*?\\s+${N}${B}`,
    `\\bclass\\s+${N}${B}`,
    `\\b(?:const|let|var)\\s+(?:\\{[^}]*\\b|\\[[^\\]]*\\b)?${N}${B}`,
    `\\bimport\\s+.*\\b${N}${B}.*\\bfrom\\b`,
    `^\\s*(?:async\\s+)?${N}\\s*\\([^)]*\\)\\s*\\{`,
    `^\\s*${N}\\s*=(?!=)`,
  ];
  const cfam = [
    `\\b(?:class|struct|enum|union|interface|trait|protocol|record|object|type)\\s+${N}${B}`,
    `\\b(?:func|fn|fun|def)\\s+${N}${B}`,
    `#define\\s+${N}${B}`,
    `^[\\w:<>,*&\\s\\[\\]]*?\\b[\\w:<>\\]*&]+\\s+[*&]?${N}\\s*\\([^;]*$`,
    `\\b(?:let|var|val|const|auto)\\s+(?:mut\\s+)?${N}${B}`,
    `\\b[\\w:<>\\]]+[*&\\s]+${N}\\s*(?:=(?!=)|;|\\[|,|\\{)`,
    `\\b${N}\\s*:=`,
  ];
  const generic = [`\\b(?:def|function|func|fn|sub|proc)\\s+${N}${B}`, `^\\s*(?:local\\s+)?${N}\\s*=(?!=)`];
  const table = { python: py, matlab, octave: matlab, julia: matlab, javascript: js, typescript: js, c: cfam, cpp: cfam, objc: cfam, java: cfam, csharp: cfam, kotlin: cfam, swift: cfam, go: cfam, rust: cfam, dart: cfam, scala: cfam };
  return (table[id] || generic).map((p) => new RegExp(p, "m"));
}

// Where name is defined in the note's blocks of this language (earliest block first).
function findDefinition(state, def, name) {
  const blocks = blocksOfLang(state, def.id).map((b) => ({ b, code: blockCode(state, b) }));
  for (const re of patternsFor(def.id, name)) {
    for (const { b, code } of blocks) {
      const lexed = lexCached(code.text, b.def);
      const g = new RegExp(re.source, "gmd");
      let m;
      while ((m = g.exec(code.text))) {
        const at = m.indices[1][0];
        // Not inside a string or a comment.
        if (lexed.tokens.some((t) => (t.type === "string" || t.type === "comment") && t.from <= at && at < t.to)) continue;
        return { from: code.toDoc(at), to: code.toDoc(at + name.length) };
      }
    }
  }
  return null;
}

const flash = StateEffect.define();
const flashField = StateField.define({
  create: () => Decoration.none,
  update(d, tr) {
    d = d.map(tr.changes);
    for (const e of tr.effects) if (e.is(flash)) d = e.value ? Decoration.set([Decoration.mark({ class: "tc-flash" }).range(e.value.from, e.value.to)]) : Decoration.none;
    return d;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function jump(view, range) {
  view.dispatch({ selection: { anchor: range.from, head: range.to }, effects: [EditorView.scrollIntoView(range.from, { y: "center" }), flash.of(range)], userEvent: "select.definition" });
  view.focus();
  window.setTimeout(() => view.dispatch({ effects: flash.of(null) }), 900);
}

async function goToDefinition(plugin, view, pos) {
  const hit = identAt(view.state, pos);
  if (!hit) return false;
  let target = null;
  const lsp = plugin.desktop && plugin.desktop.lsp;
  if (lsp && lsp.active(hit.block.def.id)) {
    try {
      const at = await lsp.definition(view, pos);
      if (at != null) target = { from: at, to: at + hit.name.length };
    } catch {
      // no language server answer: use our own search below
    }
  }
  if (!target) target = findDefinition(view.state, hit.block.def, hit.name);
  if (!target) {
    new Notice(`Couldn't find where ${hit.name} is defined in this note`);
    return true;
  }
  if (target.from === hit.from) {
    // Already on the definition: go to the next use instead.
    const uses = occurrences(view.state, hit.block.def, hit.name);
    const next = uses.find((u) => u.from > hit.from) || uses.find((u) => u.from !== hit.from);
    if (!next) {
      new Notice(`${hit.name} isn't used anywhere else in this note`);
      return true;
    }
    target = next;
  }
  jump(view, target);
  return true;
}

/* ---------- ⌘ held over a name: an underline, like a link ---------- */

const setLink = StateEffect.define();
const linkField = StateField.define({
  create: () => Decoration.none,
  update(d, tr) {
    if (tr.docChanged) d = Decoration.none;
    for (const e of tr.effects) if (e.is(setLink)) d = e.value ? Decoration.set([Decoration.mark({ class: "tc-def-link" }).range(e.value.from, e.value.to)]) : Decoration.none;
    return d;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const modKey = (e) => (Platform.isMacOS ? e.metaKey : e.ctrlKey);

function navigationExtension(plugin) {
  let shown = null;
  const show = (view, range) => {
    const key = range ? `${range.from}:${range.to}` : null;
    if (key === shown) return;
    shown = key;
    view.dispatch({ effects: setLink.of(range) });
  };
  return [
    usesExtension(plugin),
    flashField,
    linkField,
    EditorView.domEventHandlers({
      mousedown(e, view) {
        if (!plugin.settings.goToDefinition || e.button !== 0 || !modKey(e) || e.altKey || e.shiftKey) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null || !identAt(view.state, pos)) return false;
        e.preventDefault();
        show(view, null);
        goToDefinition(plugin, view, pos);
        return true;
      },
      mousemove(e, view) {
        if (!plugin.settings.goToDefinition) return false;
        if (!modKey(e)) {
          if (shown) show(view, null);
          return false;
        }
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        const hit = pos != null && identAt(view.state, pos);
        show(view, hit ? { from: hit.from, to: hit.to } : null);
        return false;
      },
      keyup(e, view) {
        if (shown && !modKey(e)) show(view, null);
        return false;
      },
      mouseleave(e, view) {
        if (shown) show(view, null);
        return false;
      },
    }),
  ];
}

export { navigationExtension, goToDefinition, findDefinition, occurrences, identAt };
