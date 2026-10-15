/*
 * Finding and running the Mac's own tools: the login shell's PATH (so
 * Homebrew tools are found), Xcode's toolchain (clangd, sourcekit-lsp,
 * clang-format, swift-format) and MATLAB's checker inside its app.
 */

import { fs, path, os, childProcess } from "../node";

class Tools {
  constructor() {
    const home = os.homedir();
    const extra = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", `${home}/.local/bin`, `${home}/.cargo/bin`, `${home}/go/bin`, `${home}/.npm-global/bin`];
    this.path = [...new Set([...(process.env.PATH || "").split(":"), ...extra].filter(Boolean))].join(":");
    this.found = new Map(); // name -> path or null
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), "tahoe-code-"));
    this.ready = new Promise((resolve) => {
      const shell = process.env.SHELL || "/bin/zsh";
      childProcess.execFile(shell, ["-l", "-c", 'printf "%s" "$PATH"'], { timeout: 6000 }, (error, stdout) => {
        if (!error && stdout) this.path = [...new Set([...stdout.trim().split(":"), ...this.path.split(":")])].join(":");
        resolve();
      });
    });
  }

  env(extra = {}) {
    return Object.assign({}, process.env, { PATH: this.path, NO_COLOR: "1", TERM: "dumb" }, extra);
  }

  // A tool's full path, or null: PATH first, then Xcode, then known app folders.
  async which(name) {
    if (this.found.has(name)) return this.found.get(name);
    await this.ready;
    let where = null;
    for (const dir of this.path.split(":")) {
      const p = path.join(dir, name);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        where = p;
        break;
      } catch {
        // not there; try the next place
      }
    }
    if (!where && process.platform === "darwin" && ["clangd", "sourcekit-lsp", "clang-format", "swift-format", "clang", "clang++", "swiftc"].includes(name)) {
      where = await new Promise((resolve) => childProcess.execFile("/usr/bin/xcrun", ["--find", name], { timeout: 8000 }, (e, out) => resolve(!e && out.trim() ? out.trim() : null)));
    }
    if (!where && name === "mlint") where = matlabTool("mlint");
    this.found.set(name, where);
    return where;
  }

  // Run a tool with optional stdin; resolves { code, stdout, stderr, timedOut }.
  run(file, args, { input, cwd, timeout = 8000, env } = {}) {
    return new Promise((resolve) => {
      let child;
      try {
        child = childProcess.spawn(file, args, { cwd: cwd || this.dir, env: env || this.env(), stdio: ["pipe", "pipe", "pipe"] });
      } catch (e) {
        resolve({ code: -1, stdout: "", stderr: String(e.message || e) });
        return;
      }
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = window.setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // it has already exited
        }
      }, timeout);
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (e) => {
        window.clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: stderr + String(e.message || e) });
      });
      child.on("close", (code) => {
        window.clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      });
      if (input != null) child.stdin.end(input);
      else child.stdin.end();
    });
  }

  // A scratch file for a tool that only reads files.
  scratch(name, text) {
    const file = path.join(this.dir, name);
    fs.writeFileSync(file, text);
    return file;
  }

  stop() {
    fs.promises.rm(this.dir, { recursive: true, force: true }).catch(() => {});
  }
}

// MATLAB keeps its tools inside the app; the newest one wins.
function matlabTool(name) {
  for (const root of ["/Applications", path.join(os.homedir(), "Applications")]) {
    let apps = [];
    try {
      apps = fs.readdirSync(root).filter((n) => /^MATLAB_R\d{4}[ab]\.app$/.test(n)).sort().reverse();
    } catch {
      // no Applications folder here
    }
    for (const app of apps) {
      const p = path.join(root, app, "bin", process.arch === "arm64" ? "maca64" : "maci64", name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function matlabRoot() {
  const mlint = matlabTool("mlint");
  return mlint ? path.resolve(path.dirname(mlint), "..", "..") : null;
}

export { Tools, matlabTool, matlabRoot };
