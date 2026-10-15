/*
 * AI ghost text (Mac): when you pause in a code block, a local model's
 * suggestion appears in grey after the cursor. Tab takes it, Esc or typing
 * something else drops it. Free and on this Mac:
 *   • Ollama with a coding model (qwen2.5-coder, deepseek-coder, starcoder2,
 *     codegemma, codellama) fills in the middle using the code after the cursor;
 *   • any other Ollama model, asked to continue the code;
 *   • Apple Intelligence through Tahoe Intelligence, if there's no Ollama.
 */

import { requestUrl } from "obsidian";
import { StateField, StateEffect } from "@codemirror/state";
import { Decoration, WidgetType, EditorView, ViewPlugin } from "@codemirror/view";
import { completionStatus } from "@codemirror/autocomplete";
import { blockAt, blockCode, blocksOfLang } from "../blocks";

const OLLAMA = "http://127.0.0.1:11434";
const PAUSE = 650;
const CODER = /coder|starcoder|codegemma|codellama|codestral|deepseek-coder|codeqwen/i;

const setGhost = StateEffect.define();

class GhostWidget extends WidgetType {
  constructor(text) {
    super();
    this.text = text;
  }
  eq(other) {
    return other.text === this.text;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "tahoe-code-ghost";
    el.textContent = this.text;
    el.setAttribute("aria-hidden", "true");
    return el;
  }
  ignoreEvent() {
    return false; // a click on the suggestion places the cursor, like anywhere else
  }
}

const ghostField = StateField.define({
  create: () => null, // { pos, text }
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setGhost)) return e.value;
    if (!value) return null;
    if (tr.docChanged) {
      // Typing the ghost's own next characters keeps the rest of it.
      let kept = null;
      tr.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
        const ins = inserted.toString();
        if (fromA === value.pos && toA === fromA && ins && value.text.startsWith(ins) && ins.length < value.text.length) kept = { pos: toB, text: value.text.slice(ins.length) };
      });
      return kept;
    }
    if (tr.selection && tr.state.selection.main.head !== value.pos) return null;
    return value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => (v ? Decoration.set([Decoration.widget({ widget: new GhostWidget(v.text), side: 1 }).range(v.pos)]) : Decoration.none)),
});

class Ghost {
  constructor(plugin) {
    this.plugin = plugin;
    this.timer = 0;
    this.seq = 0;
    this.models = null;
    this.modelsAt = 0;
  }

  enabled() {
    return this.plugin.settings.ghost && this.plugin.settings.ghostModel !== "off";
  }

  // For Tab (see editing.js): take the suggestion if one is showing.
  accept(view) {
    const g = view.state.field(ghostField, false);
    if (!g) return false;
    view.dispatch({ changes: { from: g.pos, insert: g.text }, selection: { anchor: g.pos + g.text.length }, effects: setGhost.of(null), userEvent: "input.complete" });
    return true;
  }

  dismiss(view) {
    if (!view.state.field(ghostField, false)) return false;
    view.dispatch({ effects: setGhost.of(null) });
    return true;
  }

  schedule(view) {
    window.clearTimeout(this.timer);
    const seq = ++this.seq;
    if (!this.enabled()) return;
    this.timer = window.setTimeout(() => this.suggest(view, seq), PAUSE);
  }

  async availableModels() {
    if (this.models && Date.now() - this.modelsAt < 60000) return this.models;
    try {
      const r = await requestUrl({ url: `${OLLAMA}/api/tags`, throw: false });
      this.models = r.status === 200 ? (r.json.models || []).map((m) => ({ name: m.name, size: m.size || 0 })) : [];
    } catch {
      this.models = [];
    }
    this.modelsAt = Date.now();
    return this.models;
  }

  // Which model to ask: the one chosen in settings, else a coding model, else a modest general one.
  async pick() {
    const choice = this.plugin.settings.ghostModel || "auto";
    if (choice === "apple") return { kind: "apple" };
    const models = await this.availableModels();
    if (choice.startsWith("ollama:")) {
      const name = choice.slice(7);
      return models.some((m) => m.name === name) ? { kind: "ollama", name, fim: CODER.test(name) } : null;
    }
    const coder = models.filter((m) => CODER.test(m.name)).sort((a, b) => a.size - b.size)[0];
    if (coder) return { kind: "ollama", name: coder.name, fim: true };
    // Big models are too slow to keep up with typing.
    const general = models.filter((m) => m.size && m.size < 10e9 && !/embed/i.test(m.name)).sort((a, b) => b.size - a.size)[0];
    if (general) return { kind: "ollama", name: general.name, fim: false };
    const ai = this.plugin.app.plugins.plugins["tahoe-intelligence"];
    if (ai && ai.engine) return { kind: "apple" };
    return null;
  }

  async suggest(view, seq) {
    const state = view.state;
    if (!this.enabled() || completionStatus(state) || state.selection.ranges.length > 1 || !state.selection.main.empty) return;
    if (view.state.field(ghostField, false)) return;
    const head = state.selection.main.head;
    const block = blockAt(state, head);
    if (!block) return;
    const line = state.doc.lineAt(head);
    const after = state.sliceDoc(head, line.to);
    if (after.trim() && !/^[)\]}"'`;,]*$/.test(after.trim())) return; // only at the end of a line (or before closers)
    const before = state.sliceDoc(line.from, head);
    if (!before.trim() && head === line.from && line.number === block.firstLine && !state.sliceDoc(block.from, block.to).trim()) return;
    const code = blockCode(state, block);
    const offset = code.fromDoc(head);
    const earlier = blocksOfLang(state, block.def.id)
      .filter((b) => b.fenceLine < block.fenceLine)
      .map((b) => blockCode(state, b).text)
      .join("\n\n");
    const prefix = (earlier ? `${earlier}\n\n` : "").slice(-2500) + code.text.slice(0, offset);
    const suffix = code.text.slice(offset).slice(0, 1200);
    const model = await this.pick();
    if (!model || seq !== this.seq) return;
    let text = "";
    try {
      text = await this.ask(model, block.def, prefix, suffix);
    } catch {
      return;
    }
    if (seq !== this.seq || view.state.doc !== state.doc || view.state.selection.main.head !== head) return;
    text = clean(text, before, suffix);
    if (!text) return;
    view.dispatch({ effects: setGhost.of({ pos: head, text }) });
  }

  async ask(model, def, prefix, suffix) {
    const stop = ["```", "\n\n\n"];
    if (model.kind === "ollama") {
      // Ollama only fills in the middle when there's something after the
      // cursor; with nothing, it chats ("Certainly! Below is…"). A newline is enough.
      const body = model.fim
        ? { model: model.name, prompt: prefix, suffix: suffix || "\n", stream: false, options: { temperature: 0.1, num_predict: 96, stop }, keep_alive: "10m" }
        : {
            model: model.name,
            stream: false,
            system: "You are a code completion engine. Reply with only the code that belongs at <CURSOR> — no explanation, no Markdown, no repeating the code before it. If nothing is needed, reply with nothing.",
            prompt: `Language: ${def.label}\n\n${prefix}<CURSOR>${suffix}`,
            options: { temperature: 0.1, num_predict: 80, stop },
            keep_alive: "10m",
          };
      const r = await requestUrl({ url: `${OLLAMA}/api/generate`, method: "POST", contentType: "application/json", body: JSON.stringify(body), throw: false });
      if (r.status !== 200) throw new Error(`Ollama ${r.status}`);
      return r.json.response || "";
    }
    const ai = this.plugin.app.plugins.plugins["tahoe-intelligence"];
    if (!ai || !ai.engine) return "";
    const r = await ai.engine.generate({
      instructions: "You complete code. Reply with only the code that belongs at <CURSOR>, at most a few lines, no explanation, no Markdown.",
      prompt: `Language: ${def.label}\n\n${prefix.slice(-1500)}<CURSOR>${suffix.slice(0, 400)}`,
      temperature: 0.1,
      maxTokens: 80,
    });
    return typeof r === "string" ? r : (r && (r.text || r.response)) || "";
  }

  extension() {
    // `this` as a parameter, for the classes below that can't see it
    return ((ghost) => {
      return [
        ghostField,
        ViewPlugin.fromClass(
          class {
            update(u) {
              if (!ghost.enabled()) return;
              const typed = u.transactions.some((tr) => tr.isUserEvent("input.type") || tr.isUserEvent("input") || tr.isUserEvent("delete"));
              if (u.docChanged && typed && !u.state.field(ghostField, false)) ghost.schedule(u.view);
              else if (u.selectionSet && !u.docChanged) window.clearTimeout(ghost.timer);
            }
          }
        ),
      ];
    })(this);
  }
}

// Chat instead of code: "It looks like you're…", "Certainly! Below…", Markdown.
function looksLikeProse(text) {
  if (/\*\*|^\s*\d+\.\s+\*\*|^\s*(?:certainly|sure|here(?:'s| is)|it (?:looks|seems)|this (?:code|function|is)|the (?:following|code)|below|i (?:have|will|can)|you can|note:)\b/im.test(text)) return true;
  const first = text.split("\n").find((l) => l.trim()) || "";
  const words = first.trim().split(/\s+/);
  return words.length >= 6 && !/[=()[\]{}:;<>+*/%#"'`]/.test(first) && /^[A-Z][a-z]/.test(first.trim());
}

// Model output → the text to show: no fences, no echo of the line, and short.
// Finishing a line suggests just the rest of it; a line that opens a block
// (ends in : { ( [ or =) may get the block's body, up to a blank line.
function clean(text, before, suffix) {
  let t = String(text || "").replace(/^```[\w+-]*\n?/, "").replace(/\n?```[\s\S]*$/, "");
  t = t.replace(/\s+$/, "");
  const lineSoFar = before.trimStart();
  // The cursor is already indented: the model's own indent for this line would double it.
  if (!lineSoFar) t = t.replace(/^[ \t]+/, "");
  else if (t.trimStart().startsWith(lineSoFar)) t = t.trimStart().slice(lineSoFar.length);
  // Don't repeat what's already after the cursor.
  const next = suffix.split("\n")[0].trim();
  if (next && t.endsWith(next)) t = t.slice(0, -next.length);
  if (looksLikeProse(t)) return "";
  t = t.split(/\n[ \t]*\n/)[0];
  const opens = /[:{([=]\s*$|\b(?:do|then|else)\s*$/.test(before);
  if (lineSoFar && !opens) t = t.split("\n")[0];
  const lines = t.split("\n");
  if (lines.length > 6) t = lines.slice(0, 6).join("\n");
  if (!t.trim()) return "";
  return t;
}

export { Ghost, clean, looksLikeProse };
