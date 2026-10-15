/*
 * Real formatters on the Mac, used by ⇧⌥F when they're installed. Each gets
 * the block's indent width, so the result matches the block's style.
 * Returns { text, tool } or null (then Tahoe's own tidy-up runs).
 */

import { fs, path } from "../node";

const CLANG = { c: "c", cpp: "cpp", objc: "m", java: "java", javascript: "js", typescript: "ts", csharp: "cs", json: "json" };

async function format(tools, def, text, unit, style) {
  const width = unit === "\t" ? 4 : unit.length;
  const useTab = unit === "\t" ? "Always" : "Never";
  if (CLANG[def.id]) {
    const tool = await tools.which("clang-format");
    if (!tool) return null;
    const base = style && style.trim() ? style.trim() : `{BasedOnStyle: LLVM, IndentWidth: ${width}, TabWidth: ${width}, UseTab: ${useTab}, ColumnLimit: 100, AllowShortFunctionsOnASingleLine: Empty, SortIncludes: Never}`;
    const r = await tools.run(tool, [`--assume-filename=block.${CLANG[def.id]}`, `--style=${base}`], { input: text, timeout: 8000 });
    if (r.code !== 0) throw new Error(r.stderr || "clang-format failed");
    return { text: r.stdout, tool: "clang-format" };
  }
  if (def.id === "swift") {
    const tool = await tools.which("swift-format");
    if (!tool) return null;
    const config = path.join(tools.dir, "swift-format.json");
    const indentation = unit === "\t" ? { tabs: 1 } : { spaces: width };
    fs.writeFileSync(config, JSON.stringify({ version: 1, indentation, lineLength: 100 }));
    const r = await tools.run(tool, ["format", "--configuration", config], { input: text, timeout: 10000 });
    if (r.code !== 0) throw new Error(r.stderr || "swift-format failed");
    return { text: r.stdout, tool: "swift-format" };
  }
  if (def.id === "python") {
    const ruff = await tools.which("ruff");
    if (ruff) {
      const r = await tools.run(ruff, ["format", "--stdin-filename", "block.py", "-"], { input: text, timeout: 8000 });
      if (r.code !== 0) throw new Error(r.stderr || "ruff failed");
      return { text: r.stdout, tool: "Ruff" };
    }
    const black = await tools.which("black");
    if (black) {
      const r = await tools.run(black, ["-q", "-"], { input: text, timeout: 10000 });
      if (r.code !== 0) throw new Error(r.stderr || "black failed");
      return { text: r.stdout, tool: "Black" };
    }
    return null;
  }
  const simple = {
    go: ["gofmt", []],
    rust: ["rustfmt", ["--emit", "stdout", "--quiet"]],
    shell: ["shfmt", unit === "\t" ? [] : ["-i", String(width)]],
    lua: ["stylua", ["-"]],
  }[def.id];
  if (simple) {
    const tool = await tools.which(simple[0]);
    if (!tool) return null;
    const r = await tools.run(tool, simple[1], { input: text, timeout: 8000 });
    if (r.code !== 0) throw new Error(r.stderr || `${simple[0]} failed`);
    return { text: r.stdout, tool: simple[0] };
  }
  return null;
}

// Which formatter would run for a language (for settings).
async function formatterFor(tools, id) {
  if (CLANG[id]) return (await tools.which("clang-format")) ? "clang-format" : null;
  if (id === "swift") return (await tools.which("swift-format")) ? "swift-format" : null;
  if (id === "python") return (await tools.which("ruff")) ? "Ruff" : (await tools.which("black")) ? "Black" : null;
  const simple = { go: "gofmt", rust: "rustfmt", shell: "shfmt", lua: "stylua" }[id];
  return simple && (await tools.which(simple)) ? simple : null;
}

export { format, formatterFor };
