/*
 * Equation to code. With the cursor in an equation ($$ … $$, $ … $, or a
 * selection holding some), ⌘I or "Turn equation into code" asks a local model
 * to write it as a function, in the note's language (Python with numpy,
 * MATLAB, Julia or C++). It names things from the heading and text around
 * it and from the note's code, so J(w,b) next to a compute_cost loop comes
 * back as a vectorised compute_cost. The block goes in under the equation
 * with a quick check, a small example worked out by hand, and runs.
 */

import { Modal, Notice, Setting, MarkdownRenderer, Component } from "obsidian";
import { blocksOf, blockAt, blockCode } from "../blocks";
import { clean } from "./inline";

const LANGS = [
  { id: "python", fence: "python", label: "Python" },
  { id: "matlab", fence: "matlab", label: "MATLAB" },
  { id: "julia", fence: "julia", label: "Julia" },
  { id: "cpp", fence: "cpp", label: "C++" },
];

// The equation at the cursor: { latex, from, to } or null. A selection counts
// when it's inside an equation or is one; with `loose` (the command and the
// menu), also when it merely holds some LaTeX. ⌘I isn't loose, so selecting a
// sentence with $x$ in it and pressing ⌘I still makes it italic.
function equationAt(state, loose = false) {
  const sel = state.selection.main;
  if (blockAt(state, sel.head)) return null; // in a code block: that's ⌘I's edit
  const around = mathAround(state, sel.head);
  if (sel.empty) return around;
  const text = state.sliceDoc(sel.from, sel.to);
  const latex = text.replace(/\$\$?/g, "").trim();
  if (around && around.from <= sel.from && around.to >= sel.to) return latex ? { latex, from: around.from, to: around.to } : around;
  const whole = /^\s*\$[\s\S]*[^$\s][\s\S]*\$\s*$/.test(text) && !/\n\s*\n/.test(text);
  if (latex && (whole || (loose && /\$|\\[a-zA-Z]+|[_^]\{/.test(text)))) return { latex, from: sel.from, to: sel.to };
  return null;
}

// The $$ … $$ block (on one line or several) or inline $ … $ holding `pos`.
function mathAround(state, pos) {
  const doc = state.doc;
  const here = doc.lineAt(pos).number;
  const code = blocksOf(doc);
  let open = null;
  for (let n = 1, b = 0; n <= doc.lines; n++) {
    // $$ inside code blocks (the shell's PID, say) doesn't count.
    while (b < code.length && code[b].closeLine < n) b++;
    if (b < code.length && n >= code[b].fenceLine) continue;
    const text = doc.line(n).text;
    const count = (text.match(/\$\$/g) || []).length;
    if (!count) continue;
    if (count >= 2 && n === here && !open) {
      const m = /\$\$([\s\S]*?)\$\$/.exec(text);
      const line = doc.line(n);
      if (m[1].trim()) return { latex: m[1].trim(), from: line.from + m.index, to: line.from + m.index + m[0].length };
    }
    if (count % 2 === 1) {
      if (!open) open = n;
      else {
        if (here >= open && here <= n) {
          const from = doc.line(open).from + doc.line(open).text.indexOf("$$");
          const to = doc.line(n).from + doc.line(n).text.lastIndexOf("$$") + 2;
          const latex = state.sliceDoc(from + 2, to - 2).replace(/^[ \t]*>[ \t]?/gm, "").trim();
          return latex ? { latex, from, to } : null;
        }
        open = null;
      }
    }
    if (n > here && !open) break;
  }
  const line = doc.lineAt(pos);
  const col = pos - line.from;
  const re = /(?<![$\\])\$(?!\$)([^$\n]+?)(?<!\\)\$(?!\$)/g;
  let m;
  while ((m = re.exec(line.text))) {
    if (col >= m.index && col <= m.index + m[0].length && m[1].trim()) return { latex: m[1].trim(), from: line.from + m.index, to: line.from + m.index + m[0].length };
  }
  return null;
}

// What's around it: the heading above, nearby text, and the note's code.
function contextOf(state, eq) {
  const doc = state.doc;
  const first = doc.lineAt(eq.from).number;
  const last = doc.lineAt(eq.to).number;
  let heading = "";
  for (let n = first; n >= 1; n--) {
    const h = /^#{1,6}\s+(.*)$/.exec(doc.line(n).text);
    if (h) {
      heading = h[1].trim();
      break;
    }
  }
  const near = [];
  for (let n = Math.max(1, first - 6); n <= Math.min(doc.lines, last + 3); n++) {
    if (n >= first && n <= last) continue;
    const t = doc.line(n).text.trim();
    if (t && !t.startsWith("```")) near.push(t);
  }
  const blocks = blocksOf(doc).filter((b) => b.def);
  const counts = {};
  for (const b of blocks) counts[b.def.id] = (counts[b.def.id] || 0) + 1;
  const lang = LANGS.find((l) => l.id === Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([id]) => id).find((id) => LANGS.some((x) => x.id === id))) || LANGS[0];
  // The code that comes before the equation, for names (compute_cost, x, y, w, b…).
  const code = blocks
    .filter((b) => b.def.id === lang.id && b.lastLine < first)
    .map((b) => state.sliceDoc(doc.line(b.firstLine).from, doc.line(b.lastLine).to))
    .join("\n\n")
    .slice(-3000);
  return { heading, near: near.join("\n").slice(-1200), lang, code };
}

// One worked example of the shape wanted: small models copy an example far
// more reliably than they follow a rule (left alone, they write "expected"
// values worked out in their heads, and get them wrong).
const EXAMPLES = {
  python: `import numpy as np

# Kinetic energy of particles: one half times the sum of m_i times v_i squared
def kinetic_energy(m, v):
    """m: 1-D array of masses, v: 1-D array of speeds."""
    return 0.5 * np.sum(m * v ** 2)

# Quick check: against the formula written out with loops
def kinetic_energy_loops(m, v):
    total = 0.0
    for i in range(len(m)):
        total += m[i] * v[i] ** 2
    return total / 2

m_check = np.array([1.0, 2.0, 4.0])
v_check = np.array([3.0, 0.5, 1.0])
got, want = kinetic_energy(m_check, v_check), kinetic_energy_loops(m_check, v_check)
print(f"kinetic_energy = {got}, with loops = {want}, match: {np.isclose(got, want)}")`,
  matlab: `% Quick check: against the formula written out with loops
m_check = [1 2 4];
v_check = [3 0.5 1];
got = kinetic_energy(m_check, v_check);
want = 0;
for i = 1:numel(m_check)
    want = want + m_check(i) * v_check(i)^2;
end
want = want / 2;
fprintf('kinetic_energy = %g, with loops = %g, match: %d\\n', got, want, abs(got - want) < 1e-9);

% Kinetic energy of particles: one half times the sum of m_i times v_i squared
function E = kinetic_energy(m, v)
    % m: vector of masses, v: vector of speeds
    E = 0.5 * sum(m .* v.^2);
end`,
};

function prompt(eq, ctx, lang, extra) {
  const system = [
    `You turn a math equation from someone's study notes into ${lang.label} code.`,
    "Reply with only code: no Markdown fences, no explanation outside comments.",
    lang.id === "python" ? "Use numpy and vectorise (no Python loops over the data) unless the equation is inherently iterative." : "",
    lang.id === "matlab" ? "Write it as a MATLAB script: the quick check first, then the function at the END (local functions must come last in a script). Use element-wise operators. No imports in MATLAB." : "",
    "Keep every constant and factor exactly as written (1/(2m) is not the mean). The function must return its result.",
    "Name the function and its arguments after the notes (the heading, the text, and any code already in the note). If the note's code already has a function for this, give yours a different name and compare the two in the check.",
    "Start with the imports it needs, then a one-line comment giving the equation in words, then the function, with a short docstring or comment saying what each argument is.",
    "Finish with a quick check under a comment line 'Quick check'. Never write expected numbers you worked out yourself: compare the function against the formula written out literally with plain loops, on small inputs. Give those inputs their own names ending in _check, so the note's own variables aren't overwritten. Compare with a tolerance and print both results and whether they match.",
    EXAMPLES[lang.id] ? `For example, for the mean squared value, this is the shape wanted:\n\n${EXAMPLES[lang.id]}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const user = [
    ctx.heading ? `Section: ${ctx.heading}` : "",
    ctx.near ? `Notes around the equation:\n${ctx.near}` : "",
    ctx.code ? `Code already in the note (context; don't repeat it):\n${ctx.code}` : "",
    `Equation (LaTeX):\n${eq.latex}`,
    extra ? `Also: ${extra}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system, user };
}

class EquationModal extends Modal {
  constructor(plugin, view, eq, ctx, ai) {
    super(plugin.app);
    this.plugin = plugin;
    this.view = view;
    this.eq = eq;
    this.ctx = ctx;
    this.ai = ai;
    this.lang = ctx.lang;
    this.extra = "";
  }

  onOpen() {
    this.modalEl.addClass("tahoe-code-eq-modal");
    this.titleEl.setText("Turn equation into code");
    const { contentEl } = this;
    const preview = contentEl.createDiv({ cls: "tahoe-code-eq-preview" });
    this.component = new Component();
    this.component.load();
    MarkdownRenderer.render(this.app, `$$${this.eq.latex}$$`, preview, "", this.component);
    new Setting(contentEl).setName("Language").addDropdown((d) => {
      for (const l of LANGS) d.addOption(l.id, l.label);
      d.setValue(this.lang.id).onChange((v) => (this.lang = LANGS.find((l) => l.id === v)));
    });
    new Setting(contentEl)
      .setName("Anything else")
      .setDesc("Optional, e.g. “take the input as a matrix of features” or “use degrees”.")
      .addText((t) => t.setPlaceholder("").onChange((v) => (this.extra = v.trim())));
    this.status = contentEl.createDiv({ cls: "tahoe-code-eq-status" });
    const row = contentEl.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    this.go = row.createEl("button", { text: "Write it", cls: "mod-cta" });
    this.go.addEventListener("click", () => this.write());
  }

  async write() {
    this.go.disabled = true;
    this.status.setText(`Writing ${this.lang.label}…`);
    this.status.addClass("is-working");
    let code = "";
    try {
      const { system, user } = prompt(this.eq, this.ctx, this.lang, this.extra);
      code = clean(await this.ai.generate(system, user, 1200));
    } catch (e) {
      this.status.removeClass("is-working");
      this.status.setText(`Couldn't: ${e.message}`);
      this.go.disabled = false;
      return;
    }
    if (!code.trim()) {
      this.status.removeClass("is-working");
      this.status.setText("The model didn't write anything. Try again?");
      this.go.disabled = false;
      return;
    }
    this.close();
    insertBlock(this.view, this.eq, this.lang, code);
    runAndRepair(this.plugin, this.view, this.ai, prompt(this.eq, this.ctx, this.lang, this.extra), this.lang, code);
  }

  onClose() {
    if (this.component) this.component.unload();
    this.contentEl.empty();
  }
}

// The new block goes after the paragraph the equation is in (inside the same
// callout, if it's in one).
function insertBlock(view, eq, lang, code) {
  const doc = view.state.doc;
  let n = doc.lineAt(eq.to).number;
  const prefix = /^(?:[ \t]*>[ \t]?)*/.exec(doc.line(n).text)[0];
  const body = (k) => doc.line(k).text.slice(prefix.length);
  while (n < doc.lines && doc.line(n + 1).text.startsWith(prefix) && body(n + 1).trim() && !/^\s*(#|```|~~~|\$\$)/.test(body(n + 1))) n++;
  const at = doc.line(n).to;
  const p = prefix.replace(/[ \t]+$/, "");
  const lines = ["", "```" + lang.fence, ...code.split("\n"), "```"].map((l) => (l ? prefix + l : p));
  // A blank line after it too, when something follows straight on.
  const next = n < doc.lines ? doc.line(n + 1).text : "";
  const after = next.replace(/^(?:[ \t]*>[ \t]?)*/, "").trim() ? "\n" + (prefix && next.startsWith(prefix) ? p : "") : "";
  const insert = "\n" + lines.join("\n") + after;
  const inside = at + 1 + lines[0].length + 1 + lines[1].length + 1 + prefix.length;
  view.dispatch({ changes: { from: at, insert }, selection: { anchor: inside }, scrollIntoView: true, userEvent: "input.ai" });
  view.focus();
}

// Run it, so the quick check shows straight away. Small models slip (a missing
// return, a wrong import), so if it fails, the error goes back to the model
// once and the fixed code replaces the block.
async function runAndRepair(plugin, view, ai, ask, lang, code) {
  const run = plugin.app.plugins.plugins["tahoe-run"];
  const md = viewOf(plugin.app, view);
  if (!run || !run.resolve || !run.resolve(lang.fence) || !md) return void new Notice(`Added a ${lang.label} block`);
  for (let attempt = 0; ; attempt++) {
    await new Promise((r) => window.setTimeout(r, 100));
    const hit = run.blockAtCursor(md.editor, md);
    if (!hit) return;
    await run.run(hit);
    const out = run.outputFor(hit.key);
    if (out.status !== "error" || attempt >= 1) return;
    const notice = new Notice("The quick check failed. Asking the model to fix it…", 0);
    let fixed = "";
    try {
      fixed = clean(await ai.generate(ask.system, `${ask.user}\n\nYour code:\n${code}\n\nRunning it gave:\n${out.text().slice(-1500)}\n\nReply with the whole corrected code. If the check's expected value is what's wrong, fix the check, not the function.`, 1200));
    } catch (e) {
      console.warn("Tahoe Code: couldn't fix the equation's code", e); // the error stays in its output
    }
    notice.hide();
    if (!fixed.trim() || fixed === code) return void console.debug("Tahoe Code: the model had no fix", { fixed });
    if (!replaceBlock(view, code, fixed)) return void console.debug("Tahoe Code: the block changed meanwhile; not replacing it");
    code = fixed;
  }
}

// The open note's MarkdownView for this editor.
function viewOf(app, cm) {
  let found = null;
  app.workspace.iterateAllLeaves((leaf) => {
    if (leaf.view && leaf.view.editor && leaf.view.editor.cm === cm) found = leaf.view;
  });
  return found;
}

// Swap the code of the block holding `code` (found by its text, in case the
// note changed meanwhile), keeping any callout prefix; the cursor goes inside.
function replaceBlock(view, code, fixed) {
  const state = view.state;
  const block = blocksOf(state.doc).find((b) => b.firstLine <= b.lastLine && blockCode(state, b).text.trimEnd() === code.trimEnd());
  if (!block) return false;
  const prefix = /^(?:[ \t]*>[ \t]?)*/.exec(state.doc.line(block.firstLine).text)[0];
  const p = prefix.replace(/[ \t]+$/, "");
  const from = state.doc.line(block.firstLine).from;
  const insert = fixed.split("\n").map((l) => (l ? prefix + l : p)).join("\n");
  view.dispatch({ changes: { from, to: state.doc.line(block.lastLine).to, insert }, selection: { anchor: from + prefix.length }, userEvent: "input.ai" });
  return true;
}

class EquationToCode {
  constructor(plugin, ai) {
    this.plugin = plugin;
    this.ai = ai;
  }

  // ⌘I or the command: true if there was an equation to work on.
  open(view, loose = false) {
    const eq = equationAt(view.state, loose);
    if (!eq) return false;
    new EquationModal(this.plugin, view, eq, contextOf(view.state, eq), this.ai).open();
    return true;
  }

  // Run the block holding `code` (cursor in it), fixing it once if it fails.
  runAndRepair(view, ask, lang, code) {
    return runAndRepair(this.plugin, view, this.ai, ask, lang, code);
  }

  has(view, loose = false) {
    return !!equationAt(view.state, loose);
  }
}

export { EquationToCode, equationAt, contextOf, prompt };
