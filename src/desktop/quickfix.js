/*
 * Quick fixes, like IntelliJ's ⌥Enter. Problems found while you type can
 * carry fixes; each shows as a button in the problem's hover card, and
 * ⌥Enter on the line lists them:
 *   • Python: "Change to 'total'" for a misspelt name, "Add import numpy as np"
 *     for np, pd, plt, Path, defaultdict…
 *   • C, C++, Objective-C: clang's own fix-its (a missing ';', '==' for '=',
 *     std:: names…); with clangd running, its fixes too.
 *   • Java: insert a missing ';'.
 */

import { Menu, Notice } from "obsidian";
import { forEachDiagnostic, setDiagnostics } from "@codemirror/lint";
import { blockAt, splitLine } from "../blocks";

// Usual short names → the import that defines them.
const PY_IMPORTS = {
  np: "import numpy as np",
  pd: "import pandas as pd",
  plt: "import matplotlib.pyplot as plt",
  mpl: "import matplotlib as mpl",
  sns: "import seaborn as sns",
  sp: "import scipy as sp",
  tf: "import tensorflow as tf",
  torch: "import torch",
  nn: "import torch.nn as nn",
  F: "import torch.nn.functional as F",
  optim: "import torch.optim as optim",
  cv2: "import cv2",
  sym: "import sympy as sym",
  sympy: "import sympy",
  st: "import streamlit as st",
  go: "import plotly.graph_objects as go",
  px: "import plotly.express as px",
  Path: "from pathlib import Path",
  defaultdict: "from collections import defaultdict",
  Counter: "from collections import Counter",
  deque: "from collections import deque",
  namedtuple: "from collections import namedtuple",
  OrderedDict: "from collections import OrderedDict",
  dataclass: "from dataclasses import dataclass",
  field: "from dataclasses import field",
  partial: "from functools import partial",
  reduce: "from functools import reduce",
  lru_cache: "from functools import lru_cache",
  cache: "from functools import cache",
  combinations: "from itertools import combinations",
  permutations: "from itertools import permutations",
  product: "from itertools import product",
  chain: "from itertools import chain",
  List: "from typing import List",
  Dict: "from typing import Dict",
  Tuple: "from typing import Tuple",
  Optional: "from typing import Optional",
  Union: "from typing import Union",
  Any: "from typing import Any",
  Callable: "from typing import Callable",
  tqdm: "from tqdm import tqdm",
  FuncAnimation: "from matplotlib.animation import FuncAnimation",
  datetime: "from datetime import datetime",
  timedelta: "from datetime import timedelta",
  sqrt: "from math import sqrt",
  pi: "from math import pi",
  inf: "from math import inf",
  pprint: "from pprint import pprint",
  sleep: "from time import sleep",
  randint: "from random import randint",
  choice: "from random import choice",
  shuffle: "from random import shuffle",
  heappush: "from heapq import heappush",
  heappop: "from heapq import heappop",
  bisect_left: "from bisect import bisect_left",
};
const STDLIB = "abc argparse array ast asyncio base64 bisect calendar collections colorsys contextlib copy csv ctypes dataclasses datetime decimal difflib enum fractions functools gc glob gzip hashlib heapq hmac html http inspect io ipaddress itertools json logging math multiprocessing operator os pathlib pickle platform pprint queue random re secrets select shlex shutil signal socket sqlite3 statistics string struct subprocess sys tempfile textwrap threading time timeit tkinter traceback types typing unittest urllib uuid warnings weakref xml zipfile zlib".split(" ");
for (const m of STDLIB) if (!PY_IMPORTS[m]) PY_IMPORTS[m] = `import ${m}`;

// Fixes for one Python problem from the checker.
function pythonFixes(problem) {
  const m = /^Undefined name '([\w]+)'/.exec(problem.msg || "");
  if (!m) return [];
  const name = m[1];
  const fixes = [];
  if (PY_IMPORTS[name]) fixes.push({ title: `Add ${PY_IMPORTS[name]}`, import: PY_IMPORTS[name] });
  for (const s of problem.suggest || []) if (s !== name) fixes.push({ title: `Change to '${s}'`, edits: [{ line: problem.line, col: problem.col, endLine: problem.endLine || problem.line, endCol: problem.endCol, text: s }] });
  return fixes;
}

// Names a language server says aren't defined ("x" is not defined): the same
// fixes, with near names from the note's code as the candidates.
function nameFixes(problem, name, candidates) {
  const near = closest(name, candidates);
  return pythonFixes(Object.assign({}, problem, { msg: `Undefined name '${name}'`, suggest: near }));
}

function closest(name, candidates) {
  const scored = [];
  for (const c of new Set(candidates)) {
    if (c === name || c.startsWith("__") || c.length < 2) continue;
    const d = distance(name.toLowerCase(), c.toLowerCase());
    const limit = name.length <= 4 ? 1 : 2;
    if (d <= limit) scored.push({ c, d });
  }
  return scored.sort((a, b) => a.d - b.d || a.c.length - b.c.length).slice(0, 3).map((s) => s.c);
}

// Edit distance with swaps (Damerau–Levenshtein, optimal string alignment).
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// clang -fdiagnostics-parseable-fixits: fix-it:"file":{3:14-3:14}:";"
function attachClangFixits(stderr, problems, fileName) {
  const lines = stderr.split("\n");
  let current = null;
  const head = new RegExp(`(?:^|/)${fileName.replace(/[.+]/g, "\\$&")}:(\\d+):(\\d+):\\s*(?:fatal error|error|warning):`);
  for (const line of lines) {
    const h = head.exec(line);
    if (h) {
      current = problems.find((p) => p.line === +h[1] && p.col === +h[2] - 1 && !p._claimed) || null;
      if (current) current._claimed = true;
      continue;
    }
    const f = /^fix-it:"[^"]*":\{(\d+):(\d+)-(\d+):(\d+)\}:"((?:[^"\\]|\\.)*)"$/.exec(line);
    if (!f || !current) continue;
    const text = f[5].replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    const edit = { line: +f[1], col: +f[2] - 1, endLine: +f[3], endCol: +f[4] - 1, text };
    current.fixes = current.fixes || [];
    if (!current.fixes.length) current.fixes.push({ title: describeEdit(edit), edits: [] });
    current.fixes[0].edits.push(edit);
    if (current.fixes[0].edits.length > 1) current.fixes[0].title = "Apply the compiler's fix";
  }
  for (const p of problems) delete p._claimed;
  return problems;
}

function describeEdit(e) {
  const del = e.line !== e.endLine || e.col !== e.endCol;
  const show = e.text.length > 24 ? `${e.text.slice(0, 22)}…` : e.text;
  if (!del) return `Insert '${show}'`;
  if (!e.text) return "Remove it";
  return `Change to '${show}'`;
}

// Problems → CodeMirror actions. Edits are kept relative to the problem's
// start, so they still land right if the text above has changed since.
function actionsFor(fixes, code, diagFrom, offsetOf) {
  return fixes.map((fix) => {
    if (fix.import) return { name: fix.title, apply: (view, from) => addImport(view, from, fix.import) };
    const edits = (fix.edits || []).map((e) => {
      const a = code.toDoc(offsetOf(e.line, e.col));
      const b = code.toDoc(offsetOf(e.endLine || e.line, e.endCol != null ? e.endCol : e.col));
      return { da: a - diagFrom, db: b - diagFrom, text: e.text };
    });
    return {
      name: fix.title,
      apply: (view, from) => {
        const changes = edits.map((e) => ({ from: from + e.da, to: from + e.db, insert: e.text })).sort((x, y) => x.from - y.from);
        const tr = view.state.update({ changes, userEvent: "input.fix" });
        view.dispatch(tr);
        const touched = [];
        tr.changes.iterChangedRanges((fa, ta, fb, tb) => touched.push([fb, tb]));
        dropProblems(view, (f, t) => touched.some(([a, b]) => f <= b && t >= a));
      },
    };
  });
}

// The import goes after the block's opening imports (or first, if it has none).
function addImport(view, pos, statement) {
  const state = view.state;
  const block = blockAt(state, pos);
  if (!block) return;
  let at = state.doc.line(block.firstLine).from;
  let prefix = "";
  for (let n = block.firstLine; n <= block.lastLine; n++) {
    const line = state.doc.line(n);
    const sp = splitLine(block, line.text);
    const body = line.text.slice(sp.prefix.length);
    if (n === block.firstLine) prefix = sp.prefix;
    if (/^(import|from)\s+\S/.test(body)) at = line.to + 1;
    else if (body.trim() && !/^\s*#/.test(body)) break;
  }
  if (at > state.doc.length) at = state.doc.length;
  if (state.doc.toString().includes(statement)) return new Notice(`${statement} is already in this note`);
  view.dispatch({ changes: { from: at, insert: `${prefix}${statement}\n` }, userEvent: "input.fix" });
  const name = (statement.match(/(\w+)$/) || [])[1];
  dropProblems(view, (f, t) => view.state.sliceDoc(f, t) === name);
}

// A fixed problem's underline goes at once, not at the next check.
function dropProblems(view, fixed) {
  const keep = [];
  forEachDiagnostic(view.state, (d, from, to) => {
    if (!fixed(from, to)) keep.push({ ...d, from, to });
  });
  view.dispatch(setDiagnostics(view.state, keep));
}

// ⌥Enter: the fixes for problems on this line, nearest first.
function showQuickFixes(view) {
  const head = view.state.selection.main.head;
  if (!blockAt(view.state, head)) return false;
  const doc = view.state.doc;
  const line = doc.lineAt(head);
  // This line's problems; else the nearest within two lines (a missing ';' is
  // reported where the next statement starts).
  const near = { from: doc.line(Math.max(1, line.number - 2)).from, to: doc.line(Math.min(doc.lines, line.number + 2)).to };
  let found = [];
  forEachDiagnostic(view.state, (d, from, to) => {
    if (to < near.from || from > near.to || !d.actions || !d.actions.length) return;
    const onLine = !(to < line.from || from > line.to);
    const distance = (onLine ? 0 : 1e6) + (head < from ? from - head : head > to ? head - to : 0);
    for (const a of d.actions) found.push({ a, from, to, distance, onLine, message: d.message });
  });
  if (found.some((f) => f.onLine)) found = found.filter((f) => f.onLine);
  else if (found.length) found = found.filter((f) => f.from === found.reduce((m, x) => (x.distance < m.distance ? x : m)).from);
  if (!found.length) {
    new Notice("No quick fixes on this line");
    return true;
  }
  found.sort((x, y) => x.distance - y.distance);
  const menu = new Menu();
  const title = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  for (const f of found.slice(0, 12)) menu.addItem((i) => i.setTitle(title(f.a.name)).setIcon("wand-2").onClick(() => f.a.apply(view, f.from, f.to)));
  const c = view.coordsAtPos(head) || { left: 0, bottom: 0 };
  menu.showAtPosition({ x: c.left, y: c.bottom + 4 });
  return true;
}

export { pythonFixes, nameFixes, closest, attachClangFixits, actionsFor, showQuickFixes, PY_IMPORTS };
