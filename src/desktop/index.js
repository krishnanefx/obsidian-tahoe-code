/*
 * Mac-only tools, loaded only on the desktop app: checking as you type,
 * formatting with real formatters, language servers and AI ghost text.
 */

import { Setting } from "obsidian";
import { Tools } from "./tools";
import { lintExtension } from "./lint";
import { format, formatterFor } from "./formatters";
import { LspManager, SERVERS } from "./lsp";
import { Ghost } from "./ghost";
import { showQuickFixes } from "./quickfix";
import { InlineEdit } from "./inline";
import { EquationToCode } from "./equation";
import { keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";

function start(plugin) {
  const tools = new Tools();
  const lsp = new LspManager(plugin, tools);
  const lint = lintExtension(plugin, tools, lsp);
  lsp.onRefresh = (view) => lint.refresh(view);
  const ghost = new Ghost(plugin);
  plugin.ghost = ghost;
  const inline = new InlineEdit(plugin, ghost);
  const equations = new EquationToCode(plugin, inline);
  const unregister = plugin.api.registerCompletionProvider(lsp.provider());

  return {
    extensions: [lint.extension, ...lsp.extensions(), ghost.extension(), inline.extension(), Prec.high(keymap.of([{ key: "Alt-Enter", run: (view) => (plugin.settings.check ? showQuickFixes(view) : false) }]))],
    tools,
    lsp,
    quickFix: (view) => showQuickFixes(view),
    inlineEdit: (view) => inline.open(view),
    acceptEdit: (view) => inline.accept(view),
    equations,
    inMath: (view, loose) => equations.has(view, loose),
    equationToCode: (view, loose) => equations.open(view, loose),
    format: (def, text, unit) => format(tools, def, text, unit, plugin.settings.formatStyle),
    settings: (containerEl, toggle, save) => settings(plugin, tools, lsp, ghost, containerEl, toggle, save),
    stop() {
      unregister();
      lsp.stop();
      tools.stop();
    },
  };
}

function settings(plugin, tools, lsp, ghost, containerEl, toggle, save) {
  const s = plugin.settings;

  new Setting(containerEl).setName("Checking and formatting").setHeading();
  toggle("check", "Check while you type", "When you pause, problems are underlined; hover one to read it. MATLAB uses its own checker, Python, C, C++, Swift, JavaScript, Java, Ruby, Perl and the shell their compilers. Notebook noise (MATLAB's “add a semicolon”) is left out.");
  toggle("format", "Format with ⇧⌥F", "Uses the language's formatter when it's installed, and tidies the indentation otherwise.");
  const fmt = new Setting(containerEl).setName("Formatters found").setDesc("Checking…");
  Promise.all(["cpp", "javascript", "java", "swift", "python", "go"].map(async (id) => [id, await formatterFor(tools, id)])).then((rows) => {
    const names = { cpp: "C/C++", javascript: "JS/TS", java: "Java", swift: "Swift", python: "Python", go: "Go" };
    fmt.setDesc(rows.map(([id, tool]) => `${names[id]}: ${tool || "tidy only"}`).join(" · "));
  });
  new Setting(containerEl)
    .setName("clang-format style")
    .setDesc("Optional, e.g. {BasedOnStyle: Google}. Empty uses LLVM style with the block's indent.")
    .addText((t) => t.setPlaceholder("{BasedOnStyle: LLVM}").setValue(s.formatStyle || "").onChange(async (v) => ((s.formatStyle = v.trim()), save())));

  new Setting(containerEl).setName("Language servers").setHeading();
  toggle("lsp", "Use language servers", "Typed suggestions, docs on hover, parameter hints and problems from the same engines IDEs use. Each starts the first time you edit a block in its language.");
  const list = containerEl.createDiv({ cls: "tahoe-code-servers" });
  const render = async () => {
    list.empty();
    for (const spec of SERVERS) {
      const found = await lsp.find(spec);
      const status = lsp.status.get(spec.langs[0]);
      const langs = spec.langs.map((l) => plugin.api.languages.find((x) => x.id === l).label).join(", ");
      const row = new Setting(list).setName(`${spec.label} — ${langs}`);
      row.setDesc(found ? (status === "ready" ? "Running" : status && status.startsWith("failed") ? status : "Found — starts when needed") : spec.custom ? "Not set up. Install MathWorks' MATLAB language server and choose its folder below." : `Not installed (${spec.tools.join(" or ")})`);
      row.descEl.prepend(createSpan({ cls: `tahoe-code-dot ${found ? (status === "ready" ? "is-on" : "is-found") : "is-off"}` }));
    }
    new Setting(list)
      .setName("MATLAB language server folder")
      .setDesc("The folder of github.com/mathworks/MATLAB-language-server after building it (it has out/index.js).")
      .addText((t) =>
        t
          .setPlaceholder("/Users/you/MATLAB-language-server")
          .setValue((s.serverPaths || {}).matlab || "")
          .onChange(async (v) => {
            s.serverPaths = Object.assign({}, s.serverPaths, { matlab: v.trim() });
            await save();
          })
      );
  };
  render();

  new Setting(containerEl).setName("AI suggestions").setHeading();
  toggle("inlineEdit", "⌘I to edit with AI", "In a code block, ⌘I asks a local model to change the selected lines (or the block) the way you describe. The change shows as a diff; ⌘↩ keeps it, Esc throws it away.");
  toggle("equationToCode", "⌘I on an equation writes it as code", "With the cursor in a $$ … $$ or $ … $ equation, ⌘I (or right-click › Turn equation into code) has the same model write it as a Python, MATLAB, Julia or C++ function, named after your notes, with a quick check that runs straight away.");
  new Setting(containerEl)
    .setName("Model for ⌘I")
    .setDesc("Automatic prefers an Ollama coding model of 3–12 GB, then a general Ollama model of 2–10 GB, then a smaller coding model, then Apple Intelligence.")
    .addDropdown(async (d) => {
      d.addOption("auto", "Automatic");
      d.addOption("apple", "Apple Intelligence");
      for (const m of await ghost.availableModels()) d.addOption(`ollama:${m.name}`, `${m.name} (${(m.size / 1e9).toFixed(1)} GB)`);
      d.setValue(s.editModel || "auto").onChange(async (v) => ((s.editModel = v), save()));
    });
  toggle("ghost", "Suggest code as you type", "When you pause at the end of a line, a local model's suggestion appears in grey. Tab takes it, Esc drops it. Free, and nothing leaves this Mac.");
  const model = new Setting(containerEl).setName("Model").setDesc("Automatic prefers an Ollama coding model, then a general Ollama model under 10 GB, then Apple Intelligence (through Tahoe Intelligence).");
  model.addDropdown(async (d) => {
    d.addOption("auto", "Automatic");
    d.addOption("apple", "Apple Intelligence");
    const models = await ghost.availableModels();
    for (const m of models) d.addOption(`ollama:${m.name}`, `${m.name} (${(m.size / 1e9).toFixed(1)} GB)`);
    d.addOption("off", "Off");
    d.setValue(s.ghostModel || "auto").onChange(async (v) => ((s.ghostModel = v), save()));
    if (!models.some((m) => /coder|starcoder|codegemma|codellama/i.test(m.name))) {
      model.descEl.appendText(" Tip: a coding model is much better at this — for example `ollama pull qwen2.5-coder:1.5b` (about 1 GB).");
    }
  });
}

export { start };
