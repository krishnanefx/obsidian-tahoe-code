/*
 * ⌘I in a code block: describe a change ("add error handling", "vectorise
 * this loop") and a local model rewrites the selected lines, or the whole
 * block. The change shows as a diff in place: removed lines in red, new ones
 * in green. ⌘↩ keeps it, Esc throws it away (and ⌘Z undoes a kept one).
 *
 * Models, all on this Mac: an Ollama instruct model (a coder ≥ 7B if there
 * is one, else a general one under 10 GB), else a small coder model, else
 * Apple Intelligence through Tahoe Intelligence.
 */

import {  } from "obsidian";
import { StateField, StateEffect } from "@codemirror/state";
import { Decoration, WidgetType, EditorView, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { blockAt, blockCode, blocksOfLang, splitLine } from "../blocks";
import { http } from "../node";

const setEdit = StateEffect.define(); // { from, to, phase, prompt?, newText?, error? } | null

/* ---------- line diff ---------- */

function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push({ op: "same", a: i++, b: j++ });
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push({ op: "del", a: i++ });
    else ops.push({ op: "add", b: j++ });
  }
  while (i < n) ops.push({ op: "del", a: i++ });
  while (j < m) ops.push({ op: "add", b: j++ });
  return ops;
}

/* ---------- widgets ---------- */

class PromptWidget extends WidgetType {
  constructor(edit, inline) {
    super();
    this.edit = edit;
    this.inline = inline;
  }
  eq(o) {
    return o.edit.phase === this.edit.phase && o.edit.error === this.edit.error && o.edit.from === this.edit.from;
  }
  toDOM(view) {
    const wrap = document.createElement("div");
    wrap.className = `tc-ai-prompt is-${this.edit.phase}`;
    const icon = wrap.appendChild(document.createElement("span"));
    icon.className = "tc-ai-icon";
    icon.textContent = "✦";
    if (this.edit.phase === "working") {
      const t = wrap.appendChild(document.createElement("span"));
      t.className = "tc-ai-status";
      t.textContent = `Rewriting… “${this.edit.prompt}”`;
      const stop = wrap.appendChild(document.createElement("button"));
      stop.textContent = "Stop";
      stop.addEventListener("mousedown", (e) => (e.preventDefault(), this.inline.cancel(view)));
      return wrap;
    }
    const input = wrap.appendChild(document.createElement("input"));
    input.type = "text";
    input.placeholder = this.edit.region === "selection" ? "Describe a change to the selected lines…" : "Describe a change to this block…";
    input.value = this.edit.prompt || "";
    input.spellcheck = false;
    if (this.edit.error) {
      const err = wrap.appendChild(document.createElement("span"));
      err.className = "tc-ai-error";
      err.textContent = this.edit.error;
    }
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.trim()) {
        e.preventDefault();
        this.inline.run(view, input.value.trim());
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.inline.cancel(view);
      }
      e.stopPropagation();
    });
    window.setTimeout(() => input.focus(), 0);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

class AddedWidget extends WidgetType {
  constructor(lines) {
    super();
    this.lines = lines;
  }
  eq(o) {
    return o.lines.join("\n") === this.lines.join("\n");
  }
  toDOM(view) {
    const wrap = document.createElement("div");
    wrap.className = "tc-ai-added";
    // Line up with the code: same left padding as a code line (line numbers or not).
    const line = view.contentDOM.querySelector(".HyperMD-codeblock:not(.HyperMD-codeblock-begin)");
    if (line) wrap.style.paddingLeft = getComputedStyle(line).paddingLeft;
    for (const l of this.lines) wrap.appendChild(document.createElement("div")).textContent = l || " ";
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

class ReviewWidget extends WidgetType {
  constructor(inline, summary) {
    super();
    this.inline = inline;
    this.summary = summary;
  }
  eq(o) {
    return o.summary === this.summary;
  }
  toDOM(view) {
    const bar = document.createElement("div");
    bar.className = "tc-ai-review";
    bar.appendChild(document.createElement("span")).textContent = this.summary;
    const btn = (label, cls, fn) => {
      const b = bar.appendChild(document.createElement("button"));
      b.textContent = label;
      b.className = cls;
      b.addEventListener("mousedown", (e) => (e.preventDefault(), fn()));
    };
    btn("Keep  ⌘↩", "tc-ai-keep", () => this.inline.accept(view));
    btn("Discard  ⎋", "tc-ai-discard", () => this.inline.cancel(view));
    btn("Try again", "tc-ai-again", () => this.inline.again(view));
    return bar;
  }
  ignoreEvent() {
    return true;
  }
}

/* ---------- the edit ---------- */

class InlineEdit {
  constructor(plugin, ghost) {
    this.plugin = plugin;
    this.ghost = ghost;
    this.request = null;
    // `this` as a parameter, for the classes below that can't see it
    ((inline) => {
      this.field = StateField.define({
        create: () => null,
        update(edit, tr) {
          for (const e of tr.effects) if (e.is(setEdit)) return e.value;
          if (!edit) return null;
          if (tr.docChanged) {
            // Typing inside the lines being rewritten cancels the suggestion.
            let touched = false;
            tr.changes.iterChangedRanges((fa, ta) => {
              if (ta >= edit.from && fa <= edit.to) touched = true;
            });
            if (touched && edit.phase !== "prompt") return null;
            return Object.assign({}, edit, { from: tr.changes.mapPos(edit.from, -1), to: tr.changes.mapPos(edit.to, 1) });
          }
          return edit;
        },
      });
      this.decos = EditorView.decorations.compute([this.field], (state) => {
        const edit = state.field(this.field, false);
        return edit ? inline.decorations(state, edit) : Decoration.none;
      });
    })(this);
  }

  decorations(state, edit) {
    const doc = state.doc;
    const first = doc.lineAt(edit.from);
    const ranges = [];
    if (edit.phase === "prompt" || edit.phase === "working") {
      ranges.push(Decoration.widget({ widget: new PromptWidget(edit, this), block: true, side: -1 }).range(first.from));
      if (edit.phase === "working") for (let n = first.number; n <= doc.lineAt(edit.to).number; n++) ranges.push(Decoration.line({ class: "tc-ai-working" }).range(doc.line(n).from));
      return Decoration.set(ranges, true);
    }
    if (edit.phase !== "review") return Decoration.none;
    const oldLines = edit.oldLines;
    const ops = diffLines(oldLines, edit.newLines);
    let pending = [];
    let lastLineEnd = null;
    const flush = (at, side) => {
      if (!pending.length) return;
      ranges.push(Decoration.widget({ widget: new AddedWidget(pending), block: true, side }).range(at));
      pending = [];
    };
    for (const op of ops) {
      if (op.op === "add") {
        pending.push(edit.prefix + edit.newLines[op.b]);
        continue;
      }
      const line = doc.line(first.number + op.a);
      flush(line.from, -1);
      if (op.op === "del") ranges.push(Decoration.line({ class: "tc-ai-del" }).range(line.from));
      lastLineEnd = line.to;
    }
    flush(lastLineEnd != null ? lastLineEnd : first.from, lastLineEnd != null ? 1 : -1);
    const added = ops.filter((o) => o.op === "add").length;
    const removed = ops.filter((o) => o.op === "del").length;
    const summary = added || removed ? `+${added} −${removed}` : "No changes";
    ranges.push(Decoration.widget({ widget: new ReviewWidget(this, summary), block: true, side: 1 }).range(doc.lineAt(edit.to).to));
    return Decoration.set(ranges, true);
  }

  // ⌘I: start, on the selected lines or the whole block.
  open(view) {
    this.view = view;
    const state = view.state;
    const sel = state.selection.main;
    const block = blockAt(state, sel.head);
    if (!block) return false;
    let from;
    let to;
    let region = "block";
    if (!sel.empty && blockAt(state, sel.from) === block && blockAt(state, sel.to) === block) {
      from = state.doc.lineAt(sel.from).from;
      to = state.doc.lineAt(sel.to).to;
      region = "selection";
    } else {
      from = state.doc.line(block.firstLine).from;
      to = state.doc.line(block.lastLine).to;
    }
    view.dispatch({ effects: setEdit.of({ from, to, phase: "prompt", region }) });
    return true;
  }

  cancel(view) {
    if (this.request) this.request.destroy();
    this.request = null;
    view.dispatch({ effects: setEdit.of(null) });
    view.focus();
  }

  again(view) {
    const edit = view.state.field(this.field, false);
    if (!edit) return;
    view.dispatch({ effects: setEdit.of(Object.assign({}, edit, { phase: "prompt", error: "" })) });
  }

  accept(view) {
    const edit = view.state.field(this.field, false);
    if (!edit || edit.phase !== "review") return false;
    const text = edit.newLines.map((l) => edit.prefix + l).join("\n");
    view.dispatch({ changes: { from: edit.from, to: edit.to, insert: text }, effects: setEdit.of(null), userEvent: "input.ai" });
    view.focus();
    return true;
  }

  async run(view, prompt) {
    const edit = view.state.field(this.field, false);
    if (!edit) return;
    const state = view.state;
    const block = blockAt(state, edit.from);
    if (!block) return this.cancel(view);
    const lines = state.sliceDoc(edit.from, edit.to).split("\n");
    const prefix = splitLine(block, lines[0]).prefix;
    const oldLines = lines.map((l) => l.slice(splitLine(block, l).prefix.length));
    const code = blockCode(state, block);
    const before = blocksOfLang(state, block.def.id)
      .filter((b) => b.fenceLine < block.fenceLine)
      .map((b) => blockCode(state, b).text)
      .join("\n\n")
      .slice(-2500);
    view.dispatch({ effects: setEdit.of(Object.assign({}, edit, { phase: "working", prompt })) });
    let out = "";
    try {
      out = await this.ask(block.def, prompt, oldLines.join("\n"), edit.region === "selection" ? code.text : "", before);
    } catch (e) {
      const now = view.state.field(this.field, false);
      if (now && now.phase === "working") view.dispatch({ effects: setEdit.of(Object.assign({}, now, { phase: "prompt", prompt, error: e.message })) });
      return;
    }
    const now = view.state.field(this.field, false);
    if (!now || now.phase !== "working") return; // cancelled meanwhile
    const newLines = clean(out).split("\n");
    view.dispatch({ effects: setEdit.of(Object.assign({}, now, { phase: "review", prompt, oldLines, newLines, prefix })) });
  }

  // The model to use: the setting, else the best local instruct model.
  async pick() {
    const choice = this.plugin.settings.editModel || "auto";
    if (choice === "apple") return { kind: "apple" };
    const models = await this.ghost.availableModels();
    if (choice.startsWith("ollama:")) return { kind: "ollama", name: choice.slice(7) };
    const size = (m) => m.size || 0;
    const coderBig = models.filter((m) => /coder/i.test(m.name) && size(m) > 3e9 && size(m) < 12e9).sort((a, b) => size(b) - size(a))[0];
    const general = models.filter((m) => !/coder|embed/i.test(m.name) && size(m) > 2e9 && size(m) < 10e9).sort((a, b) => size(b) - size(a))[0];
    const small = models.filter((m) => /coder/i.test(m.name)).sort((a, b) => size(b) - size(a))[0];
    const m = coderBig || general || small;
    if (m) return { kind: "ollama", name: m.name };
    const ai = this.plugin.app.plugins.plugins["tahoe-intelligence"];
    if (ai && ai.engine) return { kind: "apple" };
    throw new Error("No local model: install Ollama with a model, or turn on Apple Intelligence");
  }

  // Any one-off question for the local model (⌘I, equation to code…).
  async generate(system, user, maxTokens = 1500) {
    const model = await this.pick();
    if (model.kind === "apple") {
      const ai = this.plugin.app.plugins.plugins["tahoe-intelligence"];
      const r = await ai.engine.generate({ instructions: system, prompt: user, temperature: 0.2, maxTokens });
      return typeof r === "string" ? r : (r && (r.text || r.response)) || "";
    }
    return this.ollama(model.name, system, user);
  }

  async ask(def, prompt, region, wholeBlock, before) {
    const model = await this.pick();
    const system = "You edit code. Reply with only the complete rewritten code for the region you're given: no explanation, no Markdown fences, and keep the region's indentation and style. Change only what the instruction asks for.";
    const parts = [`Language: ${def.label}`, `Instruction: ${prompt}`];
    if (before) parts.push(`Code that runs before (context only, don't repeat it):\n${before}`);
    if (wholeBlock) parts.push(`The whole block (context only):\n${wholeBlock}`);
    parts.push(`Region to rewrite:\n${region}`);
    const user = parts.join("\n\n");
    if (model.kind === "apple") {
      const ai = this.plugin.app.plugins.plugins["tahoe-intelligence"];
      const r = await ai.engine.generate({ instructions: system, prompt: user, temperature: 0.2, maxTokens: 1500 });
      return typeof r === "string" ? r : (r && (r.text || r.response)) || "";
    }
    return this.ollama(model.name, system, user);
  }

  ollama(name, system, user) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ model: name, stream: false, keep_alive: "10m", options: { temperature: 0.2, num_predict: 2000 }, messages: [{ role: "system", content: system }, { role: "user", content: user }] });
      const req = http.request({ host: "127.0.0.1", port: 11434, path: "/api/chat", method: "POST", headers: { "Content-Type": "application/json" } }, (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          this.request = null;
          try {
            const j = JSON.parse(data);
            if (j.error) return reject(new Error(j.error));
            resolve((j.message && j.message.content) || "");
          } catch {
            reject(new Error("Ollama sent something unexpected"));
          }
        });
      });
      req.on("error", (e) => {
        this.request = null;
        reject(new Error(/ECONNREFUSED/.test(e.message) ? "Ollama isn't running" : e.message));
      });
      this.request = req;
      req.end(body);
    });
  }

  extension() {
    // `this` as a parameter, for the classes below that can't see it
    return ((inline) => {
      return [
        this.field,
        this.decos,
        EditorView.updateListener.of((u) => {
          inline.view = u.view;
        }),
        Prec.highest(
          keymap.of([
            { key: "Mod-Enter", run: (view) => inline.accept(view) },
            {
              key: "Escape",
              run: (view) => {
                const edit = view.state.field(inline.field, false);
                if (!edit) return false;
                inline.cancel(view);
                return true;
              },
            },
          ])
        ),
      ];
    })(this);
  }
}

// Model output → code: no fences, no chatter before or after.
function clean(text) {
  let t = String(text || "").replace(/\r/g, "");
  const fenced = /```[\w+-]*\n([\s\S]*?)```/.exec(t);
  if (fenced) t = fenced[1];
  return t.replace(/^\n+/, "").replace(/\s+$/, "");
}

export { InlineEdit, diffLines, clean };
