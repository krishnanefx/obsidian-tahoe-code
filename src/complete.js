/*
 * Suggestions in code blocks. Local ones come straight away: the language's
 * keywords and built-ins, names already used in the note's blocks of that
 * language, live templates, and postfix completions after a dot. Other
 * plugins add their own through the API (Tahoe Run's running sessions, the
 * language servers); their answers are merged in if they arrive quickly.
 * CodeMirror's matcher handles camel humps (gTN finds getTimeNow); names you
 * pick often move up.
 */

import { EditorView, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { autocompletion, snippet, pickedCompletion, completionStatus, selectedCompletion, selectedCompletionIndex, closeCompletion } from "@codemirror/autocomplete";
import { blockAt, splitLine, blockCode, indentUnitOf, blocksOfLang } from "./blocks";
import { lexCached } from "./lexer";
import { wordsFor } from "./langs";
import { templatesFor, postfixFor } from "./templates";

const PROVIDER_WAIT = 350;

// Where you're naming something new, any suggestion would be a guess at a
// name that doesn't exist yet (and Enter would take it): `import numpy as np`,
// `def area(`, `for x in`, `int count`. Ctrl-Space still asks.
const NAMING = {
  python: /\b(?:as|class|global|nonlocal)\s+[\w, ]*$|\bdef\s+\w*$|\bfor\s+(?:(?!\bin\b)[\w, ()])*$/,
  matlab: /\bfunction\s+(?:\[[^\]]*\]?|\w*)\s*=?\s*\w*$|\bfor\s+\w*$|\bglobal\s+[\w ]*$/,
  julia: /\b(?:function|struct|macro|module|const|local|global)\s+\w*$|\bfor\s+(?:(?!\bin\b)[\w, ()])*$/,
  javascript: /\b(?:const|let|var|function\*?|class|interface|type|enum|as)\s+[\w$, {}[\]]*$|\bcatch\s*\(\s*[\w$]*$/,
  cfamily: /\b(?:int|long|short|char|float|double|bool|boolean|void|auto|unsigned|signed|size_t|string|String|var|let|val|fn|func|struct|class|enum|union|typedef|interface|namespace)\s+[*&]*\s*\w*$|\bcatch\s*\(\s*[\w:<>]+\s*[&*]?\s*\w*$/,
};
// Parameter lists name things too, up to a default value or a type.
const PARAMS = {
  python: /\b(?:def\s+\w+\s*\(|lambda\b)([^)]*)$/,
  matlab: /\bfunction\s+(?:\[[^\]]*\]\s*=\s*|\w+\s*=\s*)?\w+\s*\(([^)]*)$/,
  javascript: /\bfunction\*?\s*[\w$]*\s*\(([^)]*)$/,
};
const C_LIKE = new Set(["c", "cpp", "objc", "csharp", "java", "kotlin", "go", "rust", "swift", "dart", "scala"]);
function naming(lang, before) {
  const id = lang === "typescript" ? "javascript" : lang === "octave" ? "matlab" : lang;
  const re = NAMING[id] || (C_LIKE.has(id) ? NAMING.cfamily : null);
  if (re && re.test(before)) return true;
  const params = PARAMS[id] && PARAMS[id].exec(before);
  if (!params || (id === "python" && /lambda\b[^:]*:/.test(params[0]))) return false;
  const current = params[1].split(",").pop();
  return !/[=:]/.test(current);
}

/* ---------- templates ---------- */

// A template body in the block's indent style (CodeMirror adds the line's own indent).
function prepare(state, block, from, body) {
  const unit = indentUnitOf(state, block);
  const line = state.doc.lineAt(from);
  const sp = splitLine(block, line.text);
  // CodeMirror copies the line's leading whitespace; a callout's "> " it can't see.
  const extra = block.quoted ? sp.prefix + sp.indent : "";
  return body
    .split("\n")
    .map((l, i) => {
      const tabs = /^\t*/.exec(l)[0].length;
      const rest = unit.repeat(tabs) + l.slice(tabs);
      return i === 0 ? rest : extra + rest;
    })
    .join("\n");
}

function applyTemplate(view, block, from, to, body) {
  snippet(prepare(view.state, block, from, body))(view, null, from, to);
}

// The expression goes into a snippet; a brace there would start a field.
function escapeExpr(expr) {
  return expr.replace(/[{}]/g, (c) => `\\${c}`);
}

// Where the expression before a dot starts: names, calls, indexing, strings.
function exprStart(text, end) {
  let i = end;
  let depth = 0;
  while (i > 0) {
    const c = text[i - 1];
    if (")]}".includes(c)) {
      depth++;
      i--;
      continue;
    }
    if ("([{".includes(c)) {
      if (!depth) break;
      depth--;
      i--;
      continue;
    }
    if (depth > 0 || /[\w$.'"@]/.test(c)) {
      i--;
      continue;
    }
    break;
  }
  return i;
}

// Docs beside the list: the first paragraph, a few lines at most.
function shortDoc(text) {
  const paras = String(text)
    .replace(/\r/g, "")
    .replace(/^\s*[*=~^#-]{4,}\s*$/gm, "") // reST underlines
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paras.length) return undefined;
  // A signature line first? Keep it with the paragraph after it.
  let out = paras[0];
  if (paras.length > 1 && out.length < 90 && /\(.*\)/.test(out)) out += `\n\n${paras[1]}`;
  const lines = out.split("\n");
  if (lines.length > 4) out = `${lines.slice(0, 4).join("\n")}…`;
  return out.length > 260 ? `${out.slice(0, 257).replace(/\s+\S*$/, "")}…` : out;
}

// Docs that appear only once you've rested on a suggestion for a moment.
function afterPause(text) {
  if (!text) return undefined;
  return () =>
    new Promise((resolve) =>
      window.setTimeout(() => {
        const dom = document.createElement("div");
        dom.textContent = text;
        resolve(dom);
      }, 900)
    );
}

/* ---------- words in the note ---------- */

const noteMemo = new WeakMap(); // doc -> Map(lang -> {names, members})
function noteWords(state, def) {
  let perDoc = noteMemo.get(state.doc);
  if (!perDoc) noteMemo.set(state.doc, (perDoc = new Map()));
  let hit = perDoc.get(def.id);
  if (hit) return hit;
  const counts = new Map();
  const members = new Map();
  for (const b of blocksOfLang(state, def.id)) {
    const lexed = lexCached(blockCode(state, b).text, def);
    for (const name of lexed.names()) if (name.length > 1) counts.set(name, (counts.get(name) || 0) + 1);
    for (const m of lexed.members()) members.set(m, (members.get(m) || 0) + 1);
  }
  hit = { counts, members };
  perDoc.set(def.id, hit);
  return hit;
}

/* ---------- the source ---------- */

function completionSource(plugin) {
  return async (context) => {
    const s = plugin.settings;
    if (!s.completion) return null;
    const { state, pos } = context;
    const block = blockAt(state, pos);
    if (!block) return null;
    const def = block.def;
    const line = state.doc.lineAt(pos);
    const sp = splitLine(block, line.text);
    const lineStart = line.from + sp.prefix.length;
    const before = state.sliceDoc(lineStart, pos);
    const code = blockCode(state, block);
    const offset = code.fromDoc(pos);
    const lexed = lexCached(code.text, def);
    if (lexed.at(offset) !== "code" && !context.explicit) return null;

    const m = /[A-Za-z_$][\w$]*$/.exec(before);
    const word = m ? m[0] : "";
    if (/\d$/.test(before) && !word) return null;
    const from = pos - word.length;
    const dot = before[before.length - word.length - 1] === ".";
    if (!word && !dot && !context.explicit) return null;
    if (!dot && !context.explicit && naming(def.id, before)) return null;

    const options = [];
    const seen = new Set();
    const add = (o) => {
      if (seen.has(o.label)) return;
      seen.add(o.label);
      options.push(o);
    };

    let memberOf = null;
    let exprFrom = 0;
    if (dot) {
      const end = before.length - word.length - 1;
      exprFrom = exprStart(before, end);
      memberOf = before.slice(exprFrom, end);
      if (!memberOf || /^\d+$/.test(memberOf)) return null;
    }

    // Other plugins first: they know types and live values.
    const extra = await fromProviders(plugin, {
      lang: def.id,
      sourcePath: plugin.app.workspace.getActiveFile() ? plugin.app.workspace.getActiveFile().path : "",
      code: code.text,
      offset,
      line: state.doc.lineAt(pos).number - block.firstLine,
      column: pos - lineStart,
      word,
      memberOf,
      explicit: context.explicit,
      blockIndex: blocksOfLang(state, def.id).findIndex((b) => b.fenceLine === block.fenceLine),
      earlier: blocksOfLang(state, def.id)
        .filter((b) => b.fenceLine < block.fenceLine)
        .map((b) => blockCode(state, b).text),
    });
    for (const o of extra) add(o);

    const { counts, members } = noteWords(state, def);
    if (dot) {
      if (s.postfix) {
        for (const p of postfixFor(def.id)) {
          add({
            label: p.name,
            detail: p.desc.replace(/expr/g, memberOf.length > 24 ? "…" : memberOf),
            type: "postfix",
            section: { name: "Postfix", rank: 9 },
            boost: -20,
            apply: (view, completion, f, to) => applyTemplate(view, block, lineStart + exprFrom, to, p.body.replace(/\$expr/g, escapeExpr(memberOf))),
          });
        }
      }
      // Members already used in the note (not just the one being typed here).
      for (const [name, n] of members) if (!(n === 1 && name === word)) add({ label: name, type: "property", boost: -1 });
    } else {
      if (s.templates) {
        for (const t of templatesFor(def.id, s.customTemplates)) {
          add({ label: t.abbr, detail: t.desc, type: "snippet", section: { name: "Templates", rank: 8 }, boost: -5, apply: (view, completion, f, to) => applyTemplate(view, block, f, to, t.body) });
        }
      }
      for (const [name, n] of counts) {
        if (n === 1 && name === word) continue; // just the word being typed
        add({ label: name, type: "variable", boost: Math.min(6, n) });
      }
      for (const w of wordsFor(def.id)) add({ label: w, type: "keyword", boost: -3 });
    }

    // Names you've picked before come first.
    for (const o of options) {
      const used = plugin.recent.get(`${def.id}:${o.label}`);
      if (used) o.boost = (o.boost || 0) + Math.min(20, 4 + used * 2);
      if (o.type === "keyword" || s.docs === "off") o.info = undefined;
      else if (typeof o.info === "string") o.info = s.docs === "pause" ? afterPause(shortDoc(o.info)) : shortDoc(o.info);
    }
    // A suggestion that's exactly what you typed would only swallow Enter.
    // Templates stay (Enter expands them), except ones named like a keyword
    // (def, for, if): those still expand with Tab, without a list popping up.
    const keywords = new Set(wordsFor(def.id));
    // (A language server's items have their own apply too, so templates are told apart by kind.)
    const expands = (o) => o.type === "postfix" || (o.type === "snippet" && !keywords.has(o.label));
    const quiet = (o) => !expands(o);
    const exact = new Set(options.filter(quiet).map((o) => o.label));
    // Like IntelliJ, the first letter has to match the start of a suggestion:
    // "np" finds numpy and np_array, not i-np-ut.
    const first = (word[0] || "").toLowerCase();
    const kept = options.filter((o) => !(quiet(o) && o.label === word) && (!first || context.explicit || o.label.replace(/^[_$@]+/, "")[0].toLowerCase() === first.replace(/^[_$@]/, "") || o.label[0].toLowerCase() === first));
    if (!kept.length) return null;
    // Typing up to one of those words asks again, so it drops out then too;
    // so does a first letter typed after a dot, so it can be matched.
    return { from, options: kept, validFor: (text) => /^[\w$]*$/.test(text) && !exact.has(text) && (first ? text[0] && text[0].toLowerCase() === first : !text) };
  };
}

async function fromProviders(plugin, ctx) {
  const providers = [...plugin.providers.values()].filter((p) => !p.langs || p.langs.includes(ctx.lang));
  if (!providers.length) return [];
  const timeout = new Promise((resolve) => window.setTimeout(() => resolve([]), PROVIDER_WAIT));
  const results = await Promise.all(
    providers.map((p) =>
      Promise.race([Promise.resolve().then(() => p.complete(ctx)), timeout])
        .then((items) => (Array.isArray(items) ? items : []).map((o) => Object.assign({ boost: 4 }, o)))
        .catch(() => [])
    )
  );
  return results.flat();
}

/* ---------- Tab on an abbreviation ---------- */

function templateExpander(plugin) {
  return {
    expand(view, block) {
      const { state } = view;
      const main = state.selection.main;
      if (!main.empty || state.selection.ranges.length > 1) return false;
      const line = state.doc.lineAt(main.head);
      const before = state.sliceDoc(line.from, main.head);
      const m = /([A-Za-z_][\w]*)$/.exec(before);
      if (!m) return false;
      if (before[before.length - m[1].length - 1] === ".") return this.expandPostfix(view, block, before, m[1]);
      if (!plugin.settings.templates) return false;
      const t = templatesFor(block.def.id, plugin.settings.customTemplates).find((x) => x.abbr === m[1]);
      if (!t) return false;
      const from = main.head - m[1].length;
      applyTemplate(view, block, from, main.head, t.body);
      return true;
    },
    // xs.for + Tab, without waiting for the suggestion list.
    expandPostfix(view, block, before, name) {
      if (!plugin.settings.postfix) return false;
      const p = postfixFor(block.def.id).find((x) => x.name === name);
      if (!p) return false;
      const dot = before.length - name.length - 1;
      const exprFrom = exprStart(before, dot);
      const expr = before.slice(exprFrom, dot);
      if (!expr || /^\d+$/.test(expr)) return false;
      const line = view.state.doc.lineAt(view.state.selection.main.head);
      applyTemplate(view, block, line.from + exprFrom, view.state.selection.main.head, p.body.replace(/\$expr/g, escapeExpr(expr)));
      return true;
    },
  };
}

/* ---------- the extension ---------- */

// Enter takes a suggestion only when it starts with what you typed, or you
// chose it with the arrow keys. Otherwise it's a new line, as you meant: the
// list may still be showing a near miss. Tab always takes it.
function smartEnter(view) {
  if (completionStatus(view.state) !== "active") return false;
  const picked = selectedCompletion(view.state);
  if (!picked || selectedCompletionIndex(view.state) > 0) return false;
  const head = view.state.selection.main.head;
  const typed = /[\w$]*$/.exec(view.state.sliceDoc(view.state.doc.lineAt(head).from, head))[0];
  if (!typed || picked.label.toLowerCase().startsWith(typed.toLowerCase())) return false;
  closeCompletion(view);
  return false; // and Enter carries on as a new line
}

function completionExtension(plugin) {
  return [
    Prec.highest(keymap.of([{ key: "Enter", run: smartEnter }])),
    autocompletion({
      override: [completionSource(plugin)],
      activateOnTyping: true,
      closeOnBlur: true,
      icons: true,
      maxRenderedOptions: 60,
      interactionDelay: 50,
      tooltipClass: () => "tahoe-code-completions",
    }),
    // Remember picks, for ranking.
    EditorView.updateListener.of((u) => {
      for (const tr of u.transactions) {
        const picked = tr.annotation(pickedCompletion);
        if (!picked) continue;
        const block = blockAt(u.startState, u.startState.selection.main.head);
        if (!block) continue;
        const key = `${block.def.id}:${picked.label}`;
        plugin.recent.set(key, (plugin.recent.get(key) || 0) + 1);
        plugin.saveRecentSoon();
      }
    }),
  ];
}

export { completionExtension, templateExpander, applyTemplate, exprStart, naming };
