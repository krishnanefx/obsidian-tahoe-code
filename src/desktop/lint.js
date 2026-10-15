/*
 * Check while you type (Mac): when you pause, each code block is checked
 * with the language's own tool and problems are underlined; hover one to
 * read it. Results are kept per block text, so only changed blocks are
 * checked again. A language with a running language server uses its
 * diagnostics instead (see lsp.js).
 */

import { linter, setDiagnostics } from "@codemirror/lint";
import { blocksOf, blockCode } from "../blocks";
import { pythonFixes, attachClangFixits, actionsFor } from "./quickfix";
import { fs, path } from "../node";

// Messages that are noise in a notebook: MATLAB's "add a semicolon to hide the
// output" (you usually want the output) and "might be unused" (a later block uses it).
const MATLAB_SKIP = new Set(["NOPTS", "NOPRT", "NASGU", "DEFNU", "INUSD", "INUSL", "NOANS", "SAGROW", "AGROW"]);

const PY_CHECK = String.raw`
import ast, builtins, difflib, json, sys
data = json.load(sys.stdin)
src, context = data["code"], data["context"]
out = []
try:
    tree = ast.parse(src)
except SyntaxError as e:
    line = (e.lineno or 1)
    col = max((e.offset or 1) - 1, 0)
    end_line = getattr(e, "end_lineno", None) or line
    end_col = getattr(e, "end_offset", None)
    end_col = max(end_col - 1, col + 1) if end_col else col + 1
    out.append({"line": line, "col": col, "endLine": end_line, "endCol": end_col, "msg": "SyntaxError: " + (e.msg or "invalid syntax"), "severity": "error"})
    print(json.dumps(out)); sys.exit(0)
bound = set(dir(builtins)) | {"__file__", "__name__", "display", "get_ipython", "In", "Out", "_"}
star = False
def bind_tree(t):
    global star
    for node in ast.walk(t):
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)): bound.add(node.id)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)): bound.add(node.name)
        elif isinstance(node, ast.arg): bound.add(node.arg)
        elif isinstance(node, ast.alias):
            if node.name == "*": star = True
            bound.add((node.asname or node.name).split(".")[0])
        elif isinstance(node, (ast.Global, ast.Nonlocal)): bound.update(node.names)
        elif isinstance(node, ast.ExceptHandler) and node.name: bound.add(node.name)
        elif type(node).__name__ in ("MatchAs", "MatchStar") and getattr(node, "name", None): bound.add(node.name)
        elif type(node).__name__ == "MatchMapping" and getattr(node, "rest", None): bound.add(node.rest)
for c in context:
    try: bind_tree(ast.parse(c))
    except SyntaxError: pass
bind_tree(tree)
if not star:
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id not in bound:
            near = [n for n in difflib.get_close_matches(node.id, [b for b in bound if b not in ("True", "False", "None") and not b.startswith("__")], n=3, cutoff=0.8)]
            out.append({"line": node.lineno, "col": node.col_offset, "endLine": node.end_lineno, "endCol": node.end_col_offset, "msg": "Undefined name '%s'" % node.id, "severity": "warning", "suggest": near})
print(json.dumps(out))
`;

const CPP_SHIM = "#include <algorithm>\n#include <array>\n#include <bitset>\n#include <cmath>\n#include <cstdio>\n#include <cstdlib>\n#include <cstring>\n#include <deque>\n#include <functional>\n#include <iomanip>\n#include <iostream>\n#include <list>\n#include <map>\n#include <numeric>\n#include <queue>\n#include <set>\n#include <sstream>\n#include <stack>\n#include <string>\n#include <tuple>\n#include <unordered_map>\n#include <unordered_set>\n#include <utility>\n#include <vector>\n";

// file:line:col: severity: message (clang, swiftc)
function parseColon(text, name) {
  const out = [];
  const re = new RegExp(`(?:^|/)${name.replace(/[.+]/g, "\\$&")}:(\\d+):(\\d+):\\s*(fatal error|error|warning):\\s*(.+)$`, "gm");
  let m;
  while ((m = re.exec(text))) out.push({ line: +m[1], col: +m[2] - 1, msg: m[4].trim(), severity: m[3].includes("error") ? "error" : "warning" });
  return out;
}

class Checker {
  constructor(tools) {
    this.tools = tools;
    this.cache = new Map(); // key -> Promise<diagnostics>
    fs.mkdirSync(path.join(tools.dir, "bits"), { recursive: true });
    fs.writeFileSync(path.join(tools.dir, "bits", "stdc++.h"), CPP_SHIM);
  }

  supports(id) {
    return ["python", "matlab", "octave", "c", "cpp", "objc", "swift", "javascript", "java", "ruby", "perl", "shell"].includes(id);
  }

  check(def, code, context) {
    const key = `${def.id}\u0000${code}\u0000${def.id === "python" ? context.join("\u0001") : ""}`;
    let hit = this.cache.get(key);
    if (!hit) {
      hit = this.run(def, code, context).catch(() => []);
      this.cache.set(key, hit);
      if (this.cache.size > 80) this.cache.delete(this.cache.keys().next().value);
    }
    return hit;
  }

  async run(def, code, context) {
    const t = this.tools;
    switch (def.id) {
      case "python": {
        const py = (await t.which("python3")) || "/usr/bin/python3";
        const r = await t.run(py, ["-c", PY_CHECK], { input: JSON.stringify({ code, context }), timeout: 6000 });
        try {
          return JSON.parse(r.stdout || "[]").map((p) => Object.assign(p, { fixes: pythonFixes(p) }));
        } catch {
          return [];
        }
      }
      case "matlab":
      case "octave": {
        const mlint = await t.which("mlint");
        if (!mlint) return [];
        const file = t.scratch("tahoe_block.m", code);
        const r = await t.run(mlint, ["-id", "-severity", file], { timeout: 6000 });
        const out = [];
        for (const m of `${r.stdout}\n${r.stderr}`.matchAll(/^L (\d+) \(C (\d+)(?:-(\d+))?\): (\w+): ML(\d): (.+)$/gm)) {
          if (MATLAB_SKIP.has(m[4]) || m[5] === "0") continue;
          out.push({ line: +m[1], col: +m[2] - 1, endCol: m[3] ? +m[3] : +m[2], msg: m[6].trim(), severity: m[5] === "3" ? "error" : "warning" });
        }
        return out;
      }
      case "c":
      case "cpp":
      case "objc": {
        const cxx = def.id === "cpp";
        const tool = await t.which(cxx ? "clang++" : "clang");
        if (!tool) return [];
        const name = `main.${def.id === "objc" ? "m" : cxx ? "cpp" : "c"}`;
        const file = t.scratch(name, code);
        const args = ["-fsyntax-only", "-fno-color-diagnostics", "-fdiagnostics-parseable-fixits", "-ferror-limit=20", cxx ? "-std=c++20" : def.id === "c" ? "-std=c17" : "-fobjc-arc", "-I", t.dir, file];
        const r = await t.run(tool, args, { timeout: 8000 });
        return attachClangFixits(r.stderr, parseColon(r.stderr, name), name);
      }
      case "swift": {
        const swiftc = await t.which("swiftc");
        if (!swiftc) return [];
        const file = t.scratch("main.swift", code);
        const r = await t.run(swiftc, ["-typecheck", file], { timeout: 12000 });
        return parseColon(r.stderr, "main.swift");
      }
      case "javascript": {
        const node = await t.which("node");
        if (!node) return [];
        const esm = /^\s*(import|export)\s/m.test(code);
        const file = t.scratch(esm ? "main.mjs" : "main.cjs", code);
        const r = await t.run(node, ["--check", file], { timeout: 6000 });
        const m = /:(\d+)\n([^\n]*)\n(\s*)\^[\s\S]*?\n(SyntaxError: [^\n]+)/.exec(r.stderr) || /:(\d+)\n[\s\S]*?(SyntaxError: [^\n]+)/.exec(r.stderr);
        if (!m) return [];
        const caret = m[3] != null ? m[3].length : 0;
        return [{ line: +m[1], col: caret, msg: (m[4] || m[2]).trim(), severity: "error" }];
      }
      case "java": {
        const javac = await t.which("javac");
        if (!javac) return [];
        const cls = (/public\s+(?:final\s+)?class\s+(\w+)/.exec(code) || [null, "Main"])[1];
        const file = t.scratch(`${cls}.java`, code);
        const out = path.join(t.dir, "javac-out");
        fs.mkdirSync(out, { recursive: true });
        const r = await t.run(javac, ["-d", out, "-Xlint:none", "-proc:none", file], { timeout: 15000 });
        const res = [];
        const re = new RegExp(`${cls}\\.java:(\\d+): (error|warning): (.+)\\n(.*)\\n(\\s*)\\^`, "g");
        let m;
        while ((m = re.exec(r.stderr))) {
          const fixes = /^';' expected$/.test(m[3]) ? [{ title: "Insert ';'", edits: [{ line: +m[1], col: m[5].length, endLine: +m[1], endCol: m[5].length, text: ";" }] }] : [];
          res.push({ line: +m[1], col: m[5].length, msg: m[3], severity: m[2], fixes });
        }
        return res;
      }
      case "ruby": {
        const ruby = await t.which("ruby");
        if (!ruby) return [];
        const r = await t.run(ruby, ["-wc"], { input: code, timeout: 6000 });
        return [...r.stderr.matchAll(/^-:(\d+): (?:(warning): )?(.+)$/gm)].map((m) => ({ line: +m[1], col: 0, msg: m[3], severity: m[2] ? "warning" : "error" }));
      }
      case "perl": {
        const perl = await t.which("perl");
        if (!perl) return [];
        const r = await t.run(perl, ["-c"], { input: code, timeout: 6000 });
        return [...r.stderr.matchAll(/^(.+?) at - line (\d+)/gm)].filter((m) => !/syntax OK/.test(m[1])).map((m) => ({ line: +m[2], col: 0, msg: m[1], severity: "error" }));
      }
      case "shell": {
        const sh = (await t.which("bash")) || "/bin/bash";
        const r = await t.run(sh, ["-n"], { input: code, timeout: 6000 });
        return [...r.stderr.matchAll(/line (\d+): (.+)$/gm)].map((m) => ({ line: +m[1], col: 0, msg: m[2], severity: "error" }));
      }
      default:
        return [];
    }
  }
}

// Block-relative problems → editor diagnostics.
function toDiagnostics(state, block, code, problems, source) {
  const lines = code.lines;
  const offsetOf = (line, col) => {
    let off = 0;
    const n = Math.max(1, Math.min(line, lines.length));
    for (let i = 0; i < n - 1; i++) off += lines[i].length + 1;
    return off + Math.max(0, Math.min(col, (lines[n - 1] || "").length));
  };
  return problems
    .filter((p) => p && p.line >= 1 && p.line <= lines.length)
    .map((p) => {
      const lineText = lines[p.line - 1] || "";
      let from = offsetOf(p.line, p.col || 0);
      let to;
      if (p.endLine && p.endCol != null) to = offsetOf(p.endLine, p.endCol);
      else if (p.endCol != null) to = offsetOf(p.line, p.endCol);
      else {
        // Underline the word at the column (or the whole line's code).
        const rest = lineText.slice(p.col || 0);
        const word = /^[\w$.]+/.exec(rest);
        to = word ? from + word[0].length : offsetOf(p.line, lineText.length);
        if (!p.col && !word) from = offsetOf(p.line, lineText.length - lineText.trimStart().length);
      }
      const lineEnd = offsetOf(p.line, lineText.length);
      if (from >= lineEnd && lineText.length) from = lineEnd - 1;
      if (to <= from) to = Math.min(from + 1, lineEnd > from ? lineEnd : from + 1);
      const d = { from: code.toDoc(from), to: Math.max(code.toDoc(to), code.toDoc(from) + 1), severity: p.severity === "error" ? "error" : p.severity === "info" ? "info" : "warning", message: p.msg, source };
      if (p.fixes && p.fixes.length) d.actions = actionsFor(p.fixes, code, d.from, offsetOf);
      return d;
    });
}

function lintExtension(plugin, tools, lsp) {
  const checker = new Checker(tools);
  const source = async (view) => {
    if (!plugin.settings.check) return [];
    const state = view.state;
    const out = [];
    const blocks = blocksOf(state.doc).filter((b) => b.def && b.firstLine <= b.lastLine);
    const earlier = new Map(); // lang -> code of earlier blocks
    for (const b of blocks) {
      const code = blockCode(state, b);
      const ctx = earlier.get(b.def.id) || [];
      if (lsp && lsp.active(b.def.id)) {
        out.push(...lsp.diagnostics(state, b, code));
      } else if (checker.supports(b.def.id) && code.text.trim()) {
        const problems = await checker.check(b.def, code.text, ctx);
        if (view.state.doc !== state.doc) return []; // edited meanwhile; the next run will catch up
        out.push(...toDiagnostics(state, b, code, problems, b.def.label));
      }
      earlier.set(b.def.id, [...ctx, code.text]);
    }
    return out;
  };
  // A server's new problems: re-run the (cached, so instant) check and show the result now.
  const refresh = async (view) => {
    try {
      const list = await source(view);
      view.dispatch(setDiagnostics(view.state, list));
    } catch {
      // a check that failed shows nothing rather than an error
    }
  };
  return { extension: linter(source, { delay: 900 }), checker, refresh };
}

export { lintExtension, toDiagnostics };
