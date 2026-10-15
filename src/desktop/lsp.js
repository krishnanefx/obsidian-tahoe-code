/*
 * Language servers (Mac): the same engines IDEs use. Each code block is a
 * document the server sees (Python and MATLAB blocks also see the note's
 * earlier blocks of that language, so names defined above are known). They
 * give typed suggestions, docs on hover, parameter hints while you type a
 * call, and problems as you type.
 *
 * Ready on a Mac with Xcode: clangd (C, C++, Objective-C), sourcekit-lsp
 * (Swift). Picked up when installed: Pyright (or pylsp / jedi-language-
 * server), typescript-language-server, gopls, and MathWorks' MATLAB
 * language server.
 */

import { hoverTooltip, showTooltip, ViewPlugin, EditorView } from "@codemirror/view";
import { StateField, StateEffect } from "@codemirror/state";
import { snippet } from "@codemirror/autocomplete";
import { blockAt, blockCode, blocksOfLang, splitLine } from "../blocks";
import { matlabRoot } from "./tools";
import { toDiagnostics } from "./lint";
import { nameFixes } from "./quickfix";
import { lexCached } from "../lexer";
import { wordsFor } from "../langs";
import { fs, path, childProcess } from "../node";

// Pyright tuned for notes: undefined names stay errors, type quibbles are
// warnings, and what notebooks do all the time (redefining a name in a later
// block, a name set inside an if) isn't flagged at all.
const PYRIGHT_NOTEBOOK = {
  typeCheckingMode: "basic",
  autoImportCompletions: true,
  diagnosticSeverityOverrides: {
    reportAttributeAccessIssue: "warning",
    reportOptionalMemberAccess: "warning",
    reportOptionalSubscript: "warning",
    reportArgumentType: "warning",
    reportCallIssue: "warning",
    reportIndexIssue: "warning",
    reportOperatorIssue: "warning",
    reportAssignmentType: "warning",
    reportReturnType: "warning",
    reportPossiblyUnbound: "none",
    reportRedeclaration: "none",
    reportMissingModuleSource: "none",
  },
};

const SERVERS = [
  { id: "clangd", label: "clangd", langs: ["c", "cpp", "objc"], tools: ["clangd"], args: ["--log=error", "--header-insertion=never", "--completion-style=detailed", "--background-index=false", "--pch-storage=memory"], languageId: { c: "c", cpp: "cpp", objc: "objective-c" } },
  { id: "sourcekit", label: "sourcekit-lsp", langs: ["swift"], tools: ["sourcekit-lsp"], args: [], languageId: { swift: "swift" } },
  { id: "pyright", label: "Pyright", langs: ["python"], tools: ["pyright-langserver", "basedpyright-langserver"], args: ["--stdio"], languageId: { python: "python" }, context: true, settings: { "python.analysis": PYRIGHT_NOTEBOOK } },
  { id: "pylsp", label: "pylsp", langs: ["python"], tools: ["pylsp", "jedi-language-server"], args: [], languageId: { python: "python" }, context: true },
  { id: "tsserver", label: "TypeScript", langs: ["javascript", "typescript"], tools: ["typescript-language-server"], args: ["--stdio"], languageId: { javascript: "javascript", typescript: "typescript" } },
  { id: "gopls", label: "gopls", langs: ["go"], tools: ["gopls"], args: [], languageId: { go: "go" } },
  { id: "matlab", label: "MATLAB language server", langs: ["matlab"], tools: [], args: [], languageId: { matlab: "matlab" }, context: true, custom: true },
];

const KIND = { 1: "text", 2: "method", 3: "function", 4: "function", 5: "property", 6: "variable", 7: "class", 8: "interface", 9: "namespace", 10: "property", 11: "constant", 12: "constant", 13: "enum", 14: "keyword", 15: "snippet", 20: "constant", 21: "constant", 22: "class", 24: "keyword", 25: "type" };

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/* ---------- JSON-RPC over stdio ---------- */

class Rpc {
  constructor(command, args, { cwd, env, onNotify, onExit, settings = {} }) {
    this.settings = settings;
    this.child = childProcess.spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.next = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.onNotify = onNotify;
    this.child.stdout.on("data", (d) => this.read(d));
    this.child.stderr.on("data", () => {});
    this.child.on("error", (e) => this.fail(String(e.message || e)));
    this.child.on("exit", (code) => this.fail(`exited (${code})`, onExit));
  }

  read(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const head = this.buffer.indexOf("\r\n\r\n");
      if (head < 0) return;
      const m = /Content-Length: *(\d+)/i.exec(this.buffer.slice(0, head).toString());
      if (!m) {
        this.buffer = this.buffer.slice(head + 4);
        continue;
      }
      const len = +m[1];
      if (this.buffer.length < head + 4 + len) return;
      const body = this.buffer.slice(head + 4, head + 4 + len).toString();
      this.buffer = this.buffer.slice(head + 4 + len);
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      if (msg.id != null && (msg.result !== undefined || msg.error) && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        window.clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      } else if (msg.method && msg.id != null) {
        // Requests from the server: answer the ones we must.
        const result = msg.method === "workspace/configuration" ? (msg.params.items || []).map((item) => this.setting(item.section)) : null;
        this.write({ jsonrpc: "2.0", id: msg.id, result });
      } else if (msg.method && this.onNotify) this.onNotify(msg.method, msg.params);
    }
  }

  // A server's settings: "python.analysis" or a parent of it ("python" → { analysis: … }).
  setting(section) {
    if (!section) return {};
    if (this.settings[section]) return this.settings[section];
    const out = {};
    for (const [key, value] of Object.entries(this.settings)) {
      if (!key.startsWith(`${section}.`)) continue;
      out[key.slice(section.length + 1)] = value;
    }
    return out;
  }

  write(msg) {
    if (!this.child.stdin.writable) return;
    const body = Buffer.from(JSON.stringify(msg));
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  request(method, params, timeout = 4000) {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(new Error("server stopped"));
      const id = this.next++;
      const timer = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, params });
  }

  fail(reason, onExit) {
    if (this.dead) return;
    this.dead = true;
    for (const p of this.pending.values()) {
      window.clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    if (onExit) onExit(reason);
  }

  stop() {
    if (this.dead) return;
    this.request("shutdown", null, 1500)
      .catch(() => {})
      .then(() => {
        this.notify("exit");
        window.setTimeout(() => {
          try {
            this.child.kill("SIGKILL");
          } catch {
            // it has already exited
          }
        }, 500);
      });
  }
}

/* ---------- one running server ---------- */

class Server {
  constructor(manager, spec, command, args) {
    this.manager = manager;
    this.spec = spec;
    this.root = path.join(manager.tools.dir, `lsp-${spec.id}`);
    fs.mkdirSync(this.root, { recursive: true });
    // clangd reads compile flags from the folder each file is in.
    if (spec.id === "clangd") {
      for (const [lang, flags] of [["c", "-std=c17"], ["cpp", `-std=c++20\n-I${manager.tools.dir}`], ["objc", "-fobjc-arc"]]) {
        fs.mkdirSync(path.join(this.root, lang), { recursive: true });
        fs.writeFileSync(path.join(this.root, lang, "compile_flags.txt"), `${flags}\n`);
      }
    }
    this.docs = new Map(); // uri -> { version, text, prefixLines }
    this.diagnostics = new Map(); // uri -> LSP diagnostics
    this.rpc = new Rpc(command, args, {
      settings: spec.settings,
      cwd: this.root,
      env: manager.tools.env(),
      onNotify: (method, params) => {
        if (method === "textDocument/publishDiagnostics") {
          this.diagnostics.set(params.uri, params.diagnostics || []);
          manager.refreshLint();
        }
      },
      onExit: () => {
        this.dead = true;
        manager.serverDied(this);
      },
    });
    const rootUri = `file://${this.root}`;
    this.ready = this.rpc
      .request(
        "initialize",
        {
          processId: process.pid,
          rootUri,
          workspaceFolders: [{ uri: rootUri, name: "tahoe" }],
          capabilities: {
            textDocument: {
              synchronization: { didSave: false, dynamicRegistration: false },
              completion: { completionItem: { snippetSupport: true, documentationFormat: ["markdown", "plaintext"], labelDetailsSupport: true }, contextSupport: true },
              hover: { contentFormat: ["markdown", "plaintext"] },
              signatureHelp: { signatureInformation: { documentationFormat: ["markdown", "plaintext"], parameterInformation: { labelOffsetSupport: true }, activeParameterSupport: true } },
              publishDiagnostics: { relatedInformation: false, codeActionsInline: true },
            },
            workspace: { configuration: true, workspaceFolders: true },
          },
          initializationOptions: spec.id === "matlab" ? { matlabConnectionTiming: "onDemand" } : undefined,
        },
        30000
      )
      .then((result) => {
        this.capabilities = (result && result.capabilities) || {};
        this.rpc.notify("initialized", {});
        return true;
      });
  }

  // Make sure the server has this block's current text; returns where it lives.
  sync(state, block, sourcePath) {
    const lang = block.def.id;
    const blocks = blocksOfLang(state, lang);
    const index = blocks.findIndex((b) => b.fenceLine === block.fenceLine);
    const code = blockCode(state, block);
    let prefix = "";
    if (this.spec.context) prefix = blocks.slice(0, Math.max(0, index)).map((b) => blockCode(state, b).text).join("\n") + (index > 0 ? "\n" : "");
    const text = prefix + code.text;
    const prefixLines = prefix ? prefix.split("\n").length - 1 : 0;
    const ext = block.def.ext || "txt";
    const folder = this.spec.id === "clangd" ? path.join(this.root, lang, hash(sourcePath || "note")) : path.join(this.root, hash(sourcePath || "note"));
    const file = path.join(folder, `block${index}.${ext}`);
    const uri = `file://${file}`;
    let doc = this.docs.get(uri);
    if (!doc || doc.text !== text) {
      fs.mkdirSync(folder, { recursive: true });
      try {
        fs.writeFileSync(file, text);
      } catch {
        // the server reads the text from the message anyway
      }
      if (!doc) {
        doc = { version: 1, text, prefixLines, uri, code };
        this.docs.set(uri, doc);
        this.rpc.notify("textDocument/didOpen", { textDocument: { uri, languageId: this.spec.languageId[lang] || lang, version: 1, text } });
      } else {
        doc.version++;
        doc.text = text;
        this.rpc.notify("textDocument/didChange", { textDocument: { uri, version: doc.version }, contentChanges: [{ text }] });
      }
    }
    doc.prefixLines = prefixLines;
    doc.code = code;
    return doc;
  }

  stop() {
    this.rpc.stop();
  }
}

/* ---------- the manager ---------- */

class LspManager {
  constructor(plugin, tools) {
    this.plugin = plugin;
    this.tools = tools;
    this.servers = new Map(); // lang -> Server (or a promise while starting)
    this.status = new Map(); // lang -> "starting" | "ready" | "none" | "failed: …"
    this.failures = new Map();
  }

  enabled() {
    return this.plugin.settings.lsp;
  }

  // Is a server ready for this language? (Starts one in the background if not.)
  active(lang) {
    if (!this.enabled()) return false;
    const s = this.servers.get(lang);
    if (s && s.capabilities && !s.dead) return true;
    if (!this.status.has(lang)) this.start(lang);
    return false;
  }

  server(lang) {
    const s = this.servers.get(lang);
    return s && s.capabilities && !s.dead ? s : null;
  }

  async find(spec) {
    if (spec.custom) {
      // MathWorks' server is a Node app; its folder is set in settings.
      const dir = (this.plugin.settings.serverPaths || {}).matlab;
      const node = await this.tools.which("node");
      const root = matlabRoot();
      if (!dir || !node || !root) return null;
      const entry = [path.join(dir, "out", "index.js"), path.join(dir, "index.js")].find((p) => fs.existsSync(p));
      return entry ? { command: node, args: [entry, "--stdio", `--matlabInstallPath=${root}`, "--matlabConnectionTiming=onDemand"] } : null;
    }
    const override = (this.plugin.settings.serverPaths || {})[spec.id];
    if (override && fs.existsSync(override)) return { command: override, args: spec.args };
    for (const t of spec.tools) {
      const where = await this.tools.which(t);
      if (where) return { command: where, args: t === "jedi-language-server" ? [] : spec.args };
    }
    return null;
  }

  async start(lang) {
    this.status.set(lang, "starting");
    for (const spec of SERVERS.filter((x) => x.langs.includes(lang))) {
      // One server process serves all its languages (clangd: C, C++, Obj-C).
      const shared = [...this.servers.values()].find((s) => s.spec === spec && !s.dead);
      if (shared) {
        this.servers.set(lang, shared);
        await shared.ready.catch(() => {});
        this.status.set(lang, shared.capabilities ? "ready" : "failed");
        this.refreshLint();
        return;
      }
      const found = await this.find(spec);
      if (!found) continue;
      try {
        const server = new Server(this, spec, found.command, found.args);
        for (const l of spec.langs) if (!this.servers.get(l) || this.servers.get(l).dead) this.servers.set(l, server);
        await server.ready;
        for (const l of spec.langs) if (this.servers.get(l) === server) this.status.set(l, "ready");
        this.refreshLint();
        return;
      } catch (e) {
        this.status.set(lang, `failed: ${String(e.message || e)}`);
        return;
      }
    }
    this.status.set(lang, "none");
  }

  serverDied(server) {
    for (const [lang, s] of this.servers) {
      if (s !== server) continue;
      this.servers.delete(lang);
      const n = (this.failures.get(lang) || 0) + 1;
      this.failures.set(lang, n);
      // Try again later, but not forever.
      if (n < 3) this.status.delete(lang);
      else this.status.set(lang, "failed: stopped repeatedly");
    }
  }

  refreshLint() {
    window.clearTimeout(this.lintTimer);
    this.lintTimer = window.setTimeout(() => {
      if (!this.onRefresh) return;
      this.plugin.app.workspace.iterateAllLeaves((leaf) => {
        const cm = leaf.view && leaf.view.editor && leaf.view.editor.cm;
        if (cm) this.onRefresh(cm);
      });
    }, 150);
  }

  sourcePath() {
    const f = this.plugin.app.workspace.getActiveFile();
    return f ? f.path : "note";
  }

  /* ----- problems ----- */

  diagnostics(state, block, code) {
    const server = this.server(block.def.id);
    if (!server) return [];
    const doc = server.sync(state, block, this.sourcePath());
    const list = server.diagnostics.get(doc.uri) || [];
    const problems = list
      .filter((d) => d.range.start.line >= doc.prefixLines)
      .map((d) => ({
        line: d.range.start.line - doc.prefixLines + 1,
        col: d.range.start.character,
        endLine: d.range.end.line - doc.prefixLines + 1,
        endCol: d.range.end.character,
        msg: d.message,
        severity: d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info",
        // clangd's fixes, sent along with the problem
        fixes: (d.codeActions || [])
          .map((a) => {
            const changes = (a.edit && a.edit.changes && a.edit.changes[doc.uri]) || [];
            const edits = changes
              .filter((e) => e.range.start.line >= doc.prefixLines)
              .map((e) => ({ line: e.range.start.line - doc.prefixLines + 1, col: e.range.start.character, endLine: e.range.end.line - doc.prefixLines + 1, endCol: e.range.end.character, text: e.newText }));
            return edits.length ? { title: a.title, edits } : null;
          })
          .filter(Boolean),
      }));
    // Python: "x" is not defined gets the import / did-you-mean fixes too.
    if (block.def.id === "python") {
      let names = null;
      for (const p of problems) {
        const m = /^"(\w+)" is not defined/.exec(p.msg);
        if (!m || (p.fixes && p.fixes.length)) continue;
        if (!names) names = blocksOfLang(state, "python").flatMap((b) => lexCached(blockCode(state, b).text, b.def).names()).concat(wordsFor("python"));
        p.fixes = nameFixes(p, m[1], names);
      }
    }
    return toDiagnostics(state, block, code, problems, server.spec.label);
  }

  /* ----- suggestions ----- */

  provider() {
    return {
      id: "tahoe-code-lsp",
      langs: null,
      complete: async (ctx) => {
        if (!this.enabled() || !this.active(ctx.lang)) return [];
        const server = this.server(ctx.lang);
        const view = this.viewNow();
        if (!server || !view) return [];
        const block = blockAt(view.state, view.state.selection.main.head);
        if (!block || block.def.id !== ctx.lang) return [];
        const doc = server.sync(view.state, block, this.sourcePath());
        const res = await server.rpc.request(
          "textDocument/completion",
          {
            textDocument: { uri: doc.uri },
            position: { line: ctx.line + doc.prefixLines, character: ctx.column },
            context: ctx.memberOf ? { triggerKind: 2, triggerCharacter: "." } : { triggerKind: ctx.explicit ? 1 : 3 },
          },
          1500
        );
        const items = Array.isArray(res) ? res : (res && res.items) || [];
        return items.slice(0, 200).map((item, i) => this.toCompletion(item, i));
      },
    };
  }

  toCompletion(item, i) {
    const insert = (item.textEdit && item.textEdit.newText) || item.insertText || item.label;
    const label = (item.filterText || item.label || "").trim().replace(/^[•◦·]\s*/, "");
    const doc = item.documentation ? (typeof item.documentation === "string" ? item.documentation : item.documentation.value) : "";
    const detail = (item.labelDetails && (item.labelDetails.detail || item.labelDetails.description)) || item.detail || "";
    return {
      label: label.split("(")[0] || label,
      displayLabel: (item.label || label).trim().replace(/^[•◦·]\s*/, ""),
      detail: detail.length > 60 ? `${detail.slice(0, 57)}…` : detail,
      info: doc || (detail.length > 60 ? detail : undefined),
      type: KIND[item.kind] || "text",
      boost: 8 - Math.min(8, i / 25),
      apply: (view, completion, from, to) => {
        if (item.insertTextFormat === 2) snippet(lspSnippet(insert))(view, completion, from, to);
        else view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length } });
      },
    };
  }

  viewNow() {
    const leaf = this.plugin.app.workspace.activeLeaf;
    return leaf && leaf.view && leaf.view.editor ? leaf.view.editor.cm : null;
  }

  /* ----- hover ----- */

  // Where the language server says the name at pos is defined, if it's in the same block.
  async definition(view, pos) {
    const block = blockAt(view.state, pos);
    if (!block || !this.active(block.def.id)) return null;
    const server = this.server(block.def.id);
    if (!server || !server.capabilities.definitionProvider) return null;
    const doc = server.sync(view.state, block, this.sourcePath());
    const line = view.state.doc.lineAt(pos);
    const sp = splitLine(block, line.text);
    const res = await server.rpc.request("textDocument/definition", { textDocument: { uri: doc.uri }, position: { line: line.number - block.firstLine + doc.prefixLines, character: pos - line.from - sp.prefix.length } }, 2500);
    const loc = Array.isArray(res) ? res[0] : res;
    if (!loc) return null;
    const uri = loc.uri || loc.targetUri;
    const range = loc.targetSelectionRange || loc.range || loc.targetRange;
    if (uri !== doc.uri || !range || range.start.line < doc.prefixLines) return null;
    const n = block.firstLine + range.start.line - doc.prefixLines;
    if (n > block.lastLine) return null;
    const target = view.state.doc.line(n);
    return target.from + splitLine(block, target.text).prefix.length + range.start.character;
  }

  hoverExtension() {
    return hoverTooltip(
      async (view, pos) => {
        if (!this.enabled()) return null;
        const block = blockAt(view.state, pos);
        if (!block || !this.active(block.def.id)) return null;
        const server = this.server(block.def.id);
        if (!server || !server.capabilities.hoverProvider) return null;
        const word = view.state.wordAt(pos);
        if (!word) return null;
        const doc = server.sync(view.state, block, this.sourcePath());
        const line = view.state.doc.lineAt(pos);
        const sp = splitLine(block, line.text);
        let res;
        try {
          res = await server.rpc.request("textDocument/hover", { textDocument: { uri: doc.uri }, position: { line: line.number - block.firstLine + doc.prefixLines, character: pos - line.from - sp.prefix.length } }, 2500);
        } catch {
          return null;
        }
        const md = hoverText(res);
        if (!md) return null;
        return {
          pos: word.from,
          end: word.to,
          above: true,
          create: () => {
            const dom = document.createElement("div");
            dom.className = "tahoe-code-hover";
            renderMarkdown(dom, md);
            return { dom, mount: () => markTooltip(dom, "tahoe-code-hover-tooltip") };
          },
        };
      },
      { hoverTime: 700, hideOnChange: true }
    );
  }

  /* ----- parameter hints ----- */

  signatureExtension() {
    const set = StateEffect.define();
    const field = StateField.define({
      create: () => null,
      update(value, tr) {
        for (const e of tr.effects) if (e.is(set)) return e.value;
        if (value && (tr.docChanged || tr.selection)) {
          const head = tr.state.selection.main.head;
          if (tr.state.doc.lineAt(head).number !== tr.state.doc.lineAt(Math.min(value.pos, tr.state.doc.length)).number) return null;
          return Object.assign({}, value, { pos: tr.changes.mapPos(value.pos) });
        }
        return value;
      },
      provide: (f) => showTooltip.from(f),
    });
    // `this` as a parameter, for the classes below that can't see it
    return ((manager) => {
      const plugin = ViewPlugin.fromClass(
        class {
          update(u) {
            if (!u.docChanged || !manager.enabled()) return;
            const head = u.state.selection.main.head;
            const typed = u.state.sliceDoc(head - 1, head);
            if (typed === ")") {
              if (u.state.field(field)) window.setTimeout(() => u.view.dispatch({ effects: set.of(null) }), 0);
              return;
            }
            if (typed !== "(" && typed !== ",") return;
            const block = blockAt(u.state, head);
            if (!block || !manager.active(block.def.id)) return;
            const server = manager.server(block.def.id);
            if (!server || !server.capabilities.signatureHelpProvider) return;
            const view = u.view;
            window.setTimeout(async () => {
              const state = view.state;
              const doc = server.sync(state, block, manager.sourcePath());
              const line = state.doc.lineAt(head);
              const sp = splitLine(block, line.text);
              let res;
              try {
                res = await server.rpc.request("textDocument/signatureHelp", { textDocument: { uri: doc.uri }, position: { line: line.number - block.firstLine + doc.prefixLines, character: head - line.from - sp.prefix.length } }, 2000);
              } catch {
                return;
              }
              const sig = res && res.signatures && res.signatures[res.activeSignature || 0];
              view.dispatch({ effects: set.of(sig ? { pos: head, above: true, create: () => {
                const dom = signatureDom(sig, res.activeParameter != null ? res.activeParameter : sig.activeParameter);
                return { dom, mount: () => markTooltip(dom, "tahoe-code-signature-tooltip") };
              } } : null) });
            }, 0);
          }
        }
      );
      return [field, plugin, EditorView.domEventHandlers({ keydown: (e, view) => e.key === "Escape" && view.state.field(field, false) && (view.dispatch({ effects: set.of(null) }), false) })];
    })(this);
  }

  extensions() {
    return [this.hoverExtension(), this.signatureExtension()];
  }

  describe() {
    const out = [];
    for (const spec of SERVERS) {
      const lang = spec.langs[0];
      out.push({ spec, status: this.status.get(lang) || "not started" });
    }
    return out;
  }

  stop() {
    for (const s of new Set(this.servers.values())) if (s && s.stop) s.stop();
    this.servers.clear();
  }
}

/* ---------- helpers ---------- */

// LSP snippets ($1, ${1:x}, $0, ${1|a,b|}) → CodeMirror's (${1}, ${1:x}, ${}, ${1:a}).
function lspSnippet(text) {
  return text
    .replace(/\$\{(\d+)\|([^,|}]*)[^}]*\|\}/g, "${$1:$2}")
    .replace(/\$0/g, "${}")
    .replace(/\$(\d+)/g, "${$1}")
    .replace(/\$\{0\}/g, "${}")
    .replace(/\$\{0:([^}]*)\}/g, "${$1}");
}

function hoverText(res) {
  if (!res || !res.contents) return "";
  const c = res.contents;
  let md;
  if (typeof c === "string") md = c;
  else if (Array.isArray(c)) md = c.map((x) => (typeof x === "string" ? x : "```" + (x.language || "") + "\n" + x.value + "\n```")).join("\n\n");
  else md = c.value || "";
  return shortDocs(decodeEntities(md));
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

// Hover docs, short: the signature, then the first paragraph of the docs
// (numpy's full docstrings run to pages).
function shortDocs(md) {
  const fence = /```\w*\n[\s\S]*?```/.exec(md);
  const sig = fence ? fence[0] : "";
  const rest = (fence ? md.slice(fence.index + fence[0].length) : md).replace(/^\s*-{3,}\s*$/m, "").trim();
  let para = rest.split(/\n\s*\n/)[0] || "";
  if (/^[A-Z][\w ]+\n[-=]{3,}/.test(para)) para = ""; // a section heading (Parameters, Returns…)
  para = para.replace(/\s+/g, " ").trim();
  if (para.length > 280) para = `${para.slice(0, 277).replace(/\s+\S*$/, "")}…`;
  return [sig, para].filter(Boolean).join("\n\n");
}

// A small Markdown renderer for docs: code fences, inline code, paragraphs, rules.
function renderMarkdown(dom, md) {
  const parts = md.trim().split(/```(\w*)\n([\s\S]*?)```/g);
  for (let i = 0; i < parts.length; i += 3) {
    const text = parts[i].trim();
    if (text) {
      for (const para of text.split(/\n{2,}|^---$/m)) {
        if (!para.trim() || /^-{3,}$/.test(para.trim())) continue;
        const heading = /^#{1,6}\s+(.*)$/.exec(para.trim());
        if (heading) {
          dom.appendChild(document.createElement("p")).appendChild(document.createElement("b")).textContent = heading[1];
          continue;
        }
        const p = dom.appendChild(document.createElement("p"));
        for (const [k, bit] of para.split(/`([^`]+)`/g).entries()) {
          if (k % 2) p.appendChild(document.createElement("code")).textContent = bit;
          else p.appendChild(document.createTextNode(bit.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\\([_*`])/g, "$1")));
        }
      }
    }
    if (parts[i + 2] != null) {
      const pre = dom.appendChild(document.createElement("pre"));
      pre.appendChild(document.createElement("code")).textContent = parts[i + 2].replace(/\n$/, "");
    }
  }
}

// A class saying what kind of card a tooltip is, for the styles (instead of a
// :has() selector).
function markTooltip(dom, kind) {
  const tip = dom.closest(".cm-tooltip");
  if (tip) tip.classList.add(kind);
}

function signatureDom(sig, active) {
  const dom = document.createElement("div");
  dom.className = "tahoe-code-signature";
  const label = sig.label;
  const params = sig.parameters || [];
  const p = params[active || 0];
  let range = null;
  if (p) {
    if (Array.isArray(p.label)) range = p.label;
    else {
      const at = label.indexOf(p.label);
      if (at >= 0) range = [at, at + p.label.length];
    }
  }
  const code = dom.appendChild(document.createElement("code"));
  if (range) {
    code.appendChild(document.createTextNode(label.slice(0, range[0])));
    code.appendChild(document.createElement("b")).textContent = label.slice(range[0], range[1]);
    code.appendChild(document.createTextNode(label.slice(range[1])));
  } else code.textContent = label;
  // Just the signature, like Xcode; a parameter's own one-line note if it has one.
  const pdoc = p && p.documentation && decodeEntities(typeof p.documentation === "string" ? p.documentation : p.documentation.value).trim().split("\n")[0];
  if (pdoc && pdoc.length <= 120) dom.appendChild(document.createElement("div")).textContent = pdoc;
  return dom;
}

export { LspManager, SERVERS };
