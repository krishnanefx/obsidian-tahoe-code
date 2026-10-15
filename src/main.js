/*
 * Tahoe Code — an IDE's comforts inside Obsidian's code blocks.
 *
 *   Everywhere (Mac, iPhone, iPad): smart Enter and indentation, brackets,
 *   quotes and `end`, Tab/Shift-Tab, ⌘/ comments, line commands, rename in
 *   block, indent guides, bracket colours, suggestions, live templates and
 *   postfix completions.
 *   On the Mac: checking as you type, formatting, language servers and AI
 *   suggestions (see desktop/).
 *
 * Nothing changes outside code blocks.
 */

import { Plugin, PluginSettingTab, Setting, Platform, debounce } from "obsidian";
import { editingExtension, toggleComment, duplicateLine, inBlock } from "./editing";
import { visualsExtension } from "./visuals";
import { completionExtension, templateExpander } from "./complete";
import { formatBlock } from "./format";
import { navigationExtension, goToDefinition, identAt } from "./navigate";
import { stickyExtension } from "./sticky";
import { blockAt, blockCode, blocksOf, blocksOfLang, splitLine } from "./blocks";
import { LANGS } from "./langs";
import * as desktop from "./desktop";
import { loadNode } from "./node";
import { tooltips, EditorView, ViewPlugin, closeHoverTooltips, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";

// A click in the editor closes hover cards at once, so they never sit over
// where you're about to type.
const clickClosesHovers = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.target && event.target.closest && event.target.closest(".cm-tooltip")) return false;
    view.dispatch({ effects: closeHoverTooltips });
    return false;
  },
});

// Hover cards let clicks through to the code (see styles.css), except a card
// with buttons or links in it (a problem's quick fixes), which keeps the
// pointer so you can reach them. Marked as cards appear, since CSS can't tell
// without :has().
const markInteractiveTooltips = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.observer = new MutationObserver((records) => {
        for (const r of records) {
          for (const node of r.addedNodes) {
            if (node.nodeType === 1 && node.classList.contains("cm-tooltip")) node.classList.toggle("tahoe-code-interactive", !!node.querySelector("button, a, input, .cm-diagnosticAction"));
          }
        }
      });
      this.observer.observe(view.dom, { childList: true });
    }
    destroy() {
      this.observer.disconnect();
    }
  }
);

// Popups (suggestions, their docs, hover cards) fit inside the note's pane:
// past its edge they'd be cut off, so they flip to the other side instead.
const paneTooltips = tooltips({
  tooltipSpace: (view) => {
    const r = (view.dom.closest(".workspace-leaf-content") || view.dom).getBoundingClientRect();
    const m = 12; // clear of the pane's edges, shadows included
    return { left: r.left + m, top: r.top + m, right: r.right - m, bottom: r.bottom - m };
  },
});

const DEFAULT_SETTINGS = {
  // Typing
  smartEnter: true,
  autoPairs: true,
  autoEnd: true,
  smartTab: true,
  comments: true,
  lineOps: true,
  // Look
  guides: true,
  bracketColors: true,
  matchBrackets: true,
  currentLine: true,
  lineNumbers: false,
  // Suggestions
  completion: true,
  highlightUses: true, // every use of the name under the cursor
  goToDefinition: true, // ⌘-click / ⌘B on a name
  stickyScope: true, // the def/class/for lines you're inside stay at the top
  inlineEdit: true, // ⌘I: describe a change, a local model makes it
  equationToCode: true, // ⌘I in an equation: a local model writes it as a function
  editModel: "auto",
  docs: "off", // docs beside the suggestion list: off, after a pause, or always
  templates: true,
  postfix: true,
  customTemplates: [],
  // Mac
  check: true,
  lsp: true,
  format: true,
  ghost: true,
  ghostModel: "auto",
  serverPaths: {},
  formatStyle: "",
};

export default class TahoeCodePlugin extends Plugin {
  async onload() {
    await loadNode(); // Node's modules, on the desktop app (see node.js)
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || data);
    delete this.settings.recent;
    this.recent = new Map(Object.entries(data.recent || {}));
    this.saveRecentSoon = debounce(() => this.saveAll(), 4000, true);
    this.providers = new Map();
    this.templates = templateExpander(this);

    // For Tahoe Run and other plugins: add suggestions, hovers and checks.
    this.api = {
      version: 1,
      registerCompletionProvider: (provider) => {
        this.providers.set(provider.id, provider);
        return () => this.providers.delete(provider.id);
      },
      blockAt,
      blockCode,
      blocksOf,
      blocksOfLang,
      splitLine,
      languages: LANGS,
    };
    // Other plugins (Tahoe Run) add their suggestions when they hear this.
    this.app.workspace.trigger("tahoe-code:ready", this.api);

    // ⇧⌥F formats the block (an editor key, so it's only taken inside code blocks).
    const formatKey = Prec.high(keymap.of([{ key: "Shift-Alt-f", run: (view) => !!(this.settings.format && inBlock(view.state, view.state.selection.main.head) && (formatBlock(this, view), true)) }]));
    const extensions = [paneTooltips, clickClosesHovers, markInteractiveTooltips, formatKey, editingExtension(this), visualsExtension(this), completionExtension(this), navigationExtension(this), stickyExtension(this)];
    if (Platform.isDesktop) {
      try {
        this.desktop = desktop.start(this);
        extensions.push(...this.desktop.extensions);
      } catch (e) {
        console.warn("Tahoe Code: Mac tools unavailable", e);
      }
    }
    this.registerEditorExtension(extensions);

    // ⌘/ and ⌘D are Obsidian's own hotkeys, which run before the editor's;
    // in a code block they comment in the block's language and duplicate the line.
    this.patchCommand("editor:toggle-comments", (cm) => this.settings.comments && toggleComment(cm));
    this.patchCommand("editor:delete-paragraph", (cm) => this.settings.lineOps && duplicateLine(cm));
    // ⌘B is bold, which means nothing in code: there it goes to the definition, like IntelliJ.
    this.patchCommand("editor:toggle-bold", (cm) => {
      if (!this.settings.goToDefinition || !identAt(cm.state, cm.state.selection.main.head)) return false;
      goToDefinition(this, cm, cm.state.selection.main.head);
      return true;
    });
    // ⌘I (italic) in code: edit with AI; in an equation: write it as code.
    // ⌘↩ (open link) keeps the suggested edit.
    if (this.desktop) {
      const inCode = (cm) => inBlock(cm.state, cm.state.selection.main.head);
      const inMath = (cm) => this.settings.equationToCode && this.desktop.inMath(cm);
      this.patchCommand("editor:toggle-italics", (cm) => (inCode(cm) ? this.settings.inlineEdit && this.desktop.inlineEdit(cm) : this.desktop.equationToCode(cm)), (cm) => inCode(cm) || inMath(cm));
      this.patchCommand("editor:open-link-in-new-leaf", (cm) => this.desktop.acceptEdit(cm));
      this.addCommand({
        id: "equation-to-code",
        name: "Turn equation into code…",
        icon: "sigma",
        editorCheckCallback: (checking, editor) => {
          const cm = editor.cm;
          if (!cm || !this.desktop.inMath(cm, true)) return false;
          if (!checking) this.desktop.equationToCode(cm, true);
          return true;
        },
      });
      this.registerEvent(
        this.app.workspace.on("editor-menu", (menu, editor) => {
          const cm = editor.cm;
          if (!this.settings.equationToCode || !cm || !this.desktop.inMath(cm, true)) return;
          menu.addItem((item) => item.setTitle("Turn equation into code…").setIcon("sigma").setSection("selection").onClick(() => this.desktop.equationToCode(cm, true)));
        })
      );
    }
    // ⌥Enter is Obsidian's "follow link"; in code it lists quick fixes, like IntelliJ.
    if (this.desktop) this.patchCommand("editor:follow-link", (cm) => this.settings.check && this.desktop.quickFix(cm));

    this.addCommand({
      id: "format-block",
      name: "Format code block",
      icon: "wand-2",
      editorCheckCallback: (checking, editor) => {
        const cm = editor.cm;
        if (!cm || !inBlock(cm.state, cm.state.selection.main.head)) return false;
        if (!checking) formatBlock(this, cm);
        return true;
      },
    });
    this.addCommand({
      id: "duplicate-line",
      name: "Duplicate line (in a code block)",
      editorCheckCallback: (checking, editor) => {
        const cm = editor.cm;
        if (!cm || !inBlock(cm.state, cm.state.selection.main.head)) return false;
        if (!checking) duplicateLine(cm);
        return true;
      },
    });
    this.addCommand({
      id: "toggle-line-numbers",
      name: "Show or hide line numbers in code blocks",
      callback: async () => {
        this.settings.lineNumbers = !this.settings.lineNumbers;
        await this.saveAll();
      },
    });

    this.addSettingTab(new TahoeCodeSettingTab(this.app, this));
  }

  onunload() {
    if (this.desktop) this.desktop.stop();
  }

  // Run `inCode` instead of the command where `applies` (by default: in a code block).
  patchCommand(id, inCode, applies = (cm) => inBlock(cm.state, cm.state.selection.main.head)) {
    const cmd = this.app.commands && this.app.commands.commands && this.app.commands.commands[id];
    if (!cmd) return;
    const original = { editorCallback: cmd.editorCallback, editorCheckCallback: cmd.editorCheckCallback };
    const here = (editor) => {
      const cm = editor && editor.cm;
      return cm && applies(cm) ? cm : null;
    };
    if (original.editorCheckCallback) {
      cmd.editorCheckCallback = (checking, editor, ctx) => {
        const cm = here(editor);
        if (cm) {
          if (checking) return true;
          if (inCode(cm)) return true;
        }
        return original.editorCheckCallback.call(cmd, checking, editor, ctx);
      };
    } else if (original.editorCallback) {
      cmd.editorCallback = (editor, ctx) => {
        const cm = here(editor);
        if (cm && inCode(cm)) return;
        return original.editorCallback.call(cmd, editor, ctx);
      };
    }
    this.register(() => Object.assign(cmd, original));
  }

  async saveAll() {
    const recent = Object.fromEntries([...this.recent.entries()].sort((a, b) => b[1] - a[1]).slice(0, 600));
    await this.saveData({ settings: this.settings, recent });
    this.app.workspace.updateOptions();
  }
};

/* ------------------------------------------------------------------------ */
/* Settings                                                                  */
/* ------------------------------------------------------------------------ */

class TahoeCodeSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this.icon = "code-2";
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => this.plugin.saveAll();
    containerEl.empty();
    const toggle = (key, name, desc) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addToggle((t) => t.setValue(!!s[key]).onChange(async (v) => ((s[key] = v), save())));

    containerEl.createEl("p", { cls: "setting-item-description", text: "Everything here applies inside code blocks only. The rest of your notes work as before." });

    new Setting(containerEl).setName("Typing").setHeading();
    toggle("smartEnter", "Smart Enter", "Keep the indent, add a level after : { ( and block keywords, and step back for else, end and }.");
    toggle("autoPairs", "Close brackets and quotes", "Typing ( [ { or a quote adds its partner; typing the partner steps over it; Backspace removes both.");
    toggle("autoEnd", "Add end, fi, done", "After a line that opens a block in MATLAB, Ruby, Lua, Julia, the shell or AppleScript, Enter adds its end.");
    toggle("smartTab", "Tab and Shift-Tab indent", "Indent and outdent lines in the language's style (4 spaces in Python, the block's own style otherwise). Backspace removes a whole level.");
    toggle("comments", "⌘/ comments in the language", "Comment lines out with #, //, %, -- … instead of Obsidian's %% %%.");
    toggle("lineOps", "Line commands", "⌥↑ ⌥↓ move lines, ⌘D duplicates, ⌃G selects the next match, ⇧F6 renames in the block.");

    new Setting(containerEl).setName("Look").setHeading();
    toggle("guides", "Indent guides", "Faint lines at each indent level.");
    toggle("bracketColors", "Coloured bracket pairs", "Brackets take a colour by nesting depth.");
    toggle("matchBrackets", "Highlight the matching bracket", "The bracket next to the cursor and its partner are marked; a stray one is shown in red.");
    toggle("currentLine", "Highlight the current line", "");
    toggle("lineNumbers", "Line numbers", "Number the lines of each code block.");
    toggle("stickyScope", "Sticky headers", "Scrolling through a long block, the lines that opened where you are (def …:, class …:, for … {) stay at the top, like Xcode. Click one to go there.");
    toggle("highlightUses", "Highlight uses of a name", "With the cursor on a name, every place it's used in the note's blocks of that language is highlighted.");
    toggle("goToDefinition", "⌘-click to go to a definition", "⌘-click a name, or press ⌘B on it, to jump to where it's defined (on the definition itself: to its next use). Hold ⌘ over a name to see it underlined.");

    new Setting(containerEl).setName("Suggestions").setHeading();
    toggle("completion", "Suggest as you type", "Keywords, built-ins and names from the note's blocks, matched like IntelliJ (gTN finds getTimeNow). Names you pick often come first.");
    new Setting(containerEl)
      .setName("Docs beside suggestions")
      .setDesc("Each suggestion already shows its signature. This adds a panel with its documentation.")
      .addDropdown((d) =>
        d
          .addOption("off", "Off")
          .addOption("pause", "After a pause on a suggestion")
          .addOption("always", "Always")
          .setValue(s.docs || "off")
          .onChange(async (v) => ((s.docs = v), save()))
      );
    toggle("templates", "Live templates", "Type an abbreviation such as fori, main, sout or plt and press Tab.");
    toggle("postfix", "Postfix completions", "After a dot: items.for, x.print, cond.if, value.not …");

    new Setting(containerEl).setName("Your templates").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Type the abbreviation and press Tab. In the body, ${1:name} is a field you Tab through (the same number twice is typed once), ${} is where the cursor ends, and a tab at the start of a line is one indent level.",
    });
    const list = containerEl.createDiv({ cls: "tahoe-code-templates" });
    const render = () => {
      list.empty();
      s.customTemplates.forEach((t, i) => {
        const row = list.createDiv({ cls: "tahoe-code-template" });
        const head = new Setting(row);
        head.addText((x) => x.setPlaceholder("Abbreviation").setValue(t.abbr || "").onChange(async (v) => ((t.abbr = v.trim()), save())));
        head.addDropdown((d) => {
          d.addOption("*", "All languages");
          for (const l of LANGS) d.addOption(l.id, l.label);
          d.setValue(t.lang || "*").onChange(async (v) => ((t.lang = v), save()));
        });
        head.addText((x) => x.setPlaceholder("Description").setValue(t.desc || "").onChange(async (v) => ((t.desc = v), save())));
        head.addExtraButton((b) =>
          b
            .setIcon("trash-2")
            .setTooltip("Remove")
            .onClick(async () => {
              s.customTemplates.splice(i, 1);
              await save();
              render();
            })
        );
        const body = row.createEl("textarea", { cls: "tahoe-code-template-body", attr: { rows: 4, spellcheck: "false", placeholder: "for ${1:i} in range(${2:n}):\n\t${}" } });
        body.value = t.body || "";
        body.addEventListener("input", () => {
          t.body = body.value;
          save();
        });
      });
      new Setting(list).addButton((b) =>
        b.setButtonText("Add template").onClick(async () => {
          s.customTemplates.push({ abbr: "", lang: "*", desc: "", body: "" });
          await save();
          render();
        })
      );
    };
    render();

    if (this.plugin.desktop && this.plugin.desktop.settings) this.plugin.desktop.settings(containerEl, toggle, save);
  }
}
