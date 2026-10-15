/*
 * A small tokenizer for any of the languages in langs.js: strings, comments,
 * brackets (with their nesting and partner), names and numbers. It's not a
 * parser, but it's enough to tell code from strings and comments, pair and
 * colour brackets, rename a variable, and collect words to suggest.
 */

const OPEN = "([{";
const CLOSE = ")]}";

function lex(text, def) {
  const tokens = [];
  const n = text.length;
  const line = def.line;
  const block = def.block;
  const quotes = def.quotes || ['"', "'"];
  const hashToo = def.id === "octave"; // Octave also comments with #
  let i = 0;
  let prev = ""; // last significant character, for MATLAB's transpose
  const atLineStart = (k) => {
    for (let j = k - 1; j >= 0; j--) {
      if (text[j] === "\n") return true;
      if (text[j] !== " " && text[j] !== "\t") return false;
    }
    return true;
  };
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    // Block comments (MATLAB's %{ … %} only count on lines of their own).
    if (block && text.startsWith(block[0], i) && (!def.transpose || (atLineStart(i) && /^\s*$/.test(text.slice(i + 2, (text.indexOf("\n", i) + 1 || n + 1) - 1))))) {
      const end = text.indexOf(block[1], i + block[0].length);
      const to = end < 0 ? n : end + block[1].length;
      tokens.push({ type: "comment", from: i, to });
      i = to;
      continue;
    }
    if ((line && text.startsWith(line, i)) || (hashToo && c === "#")) {
      const end = text.indexOf("\n", i);
      const to = end < 0 ? n : end;
      tokens.push({ type: "comment", from: i, to });
      i = to;
      continue;
    }
    if (quotes.includes(c)) {
      if (def.transpose && c === "'" && /[\w)\]}'.]/.test(prev) && text[i - 1] !== " ") {
        tokens.push({ type: "punct", from: i, to: i + 1 });
        prev = c;
        i++;
        continue;
      }
      if (def.triple && text.startsWith(c + c + c, i)) {
        const end = text.indexOf(c + c + c, i + 3);
        const to = end < 0 ? n : end + 3;
        tokens.push({ type: "string", from: i, to, closed: end >= 0 });
        prev = c;
        i = to;
        continue;
      }
      // MATLAB and SQL write a quote inside a string by doubling it: 'it''s'.
      const doubled = def.transpose || def.id === "sql";
      let j = i + 1;
      while (j < n && (c === "`" || text[j] !== "\n")) {
        if (text[j] === c) {
          if (doubled && text[j + 1] === c) {
            j += 2;
            continue;
          }
          break;
        }
        if (text[j] === "\\" && !doubled) j++;
        j++;
      }
      const closed = j < n && text[j] === c;
      const to = closed ? j + 1 : j;
      tokens.push({ type: "string", from: i, to, closed });
      prev = c;
      i = to;
      continue;
    }
    if (OPEN.includes(c)) {
      tokens.push({ type: "open", from: i, to: i + 1, ch: c });
      prev = c;
      i++;
      continue;
    }
    if (CLOSE.includes(c)) {
      tokens.push({ type: "close", from: i, to: i + 1, ch: c });
      prev = c;
      i++;
      continue;
    }
    if (/[A-Za-z_$@À-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$À-￿!?]/.test(text[j])) {
        // Ruby's ? and !, Julia's !, Rust's macro! — only at the end of a name.
        if ((text[j] === "?" || text[j] === "!") && /[\w$]/.test(text[j + 1] || "")) break;
        if ((text[j] === "?" || text[j] === "!") && !["ruby", "julia", "rust"].includes(def.id)) break;
        j++;
      }
      tokens.push({ type: "ident", from: i, to: j, value: text.slice(i, j) });
      prev = text[j - 1];
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(text[j])) j++;
      tokens.push({ type: "number", from: i, to: j });
      prev = text[j - 1];
      i = j;
      continue;
    }
    tokens.push({ type: "punct", from: i, to: i + 1 });
    prev = c;
    i++;
  }

  // Pair the brackets.
  const stack = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === "open") {
      t.depth = stack.length;
      stack.push(k);
    } else if (t.type === "close") {
      const want = OPEN[CLOSE.indexOf(t.ch)];
      let s = stack.length - 1;
      while (s >= 0 && tokens[stack[s]].ch !== want) s--;
      if (s >= 0) {
        const o = tokens[stack[s]];
        o.partner = k;
        t.partner = stack[s];
        t.depth = o.depth;
        stack.length = s;
      } else t.depth = 0;
    }
  }
  return new Lexed(text, tokens);
}

class Lexed {
  constructor(text, tokens) {
    this.text = text;
    this.tokens = tokens;
  }

  // "string", "comment" or "code" at an offset (a cursor between characters).
  at(offset) {
    const t = this.tokenAt(offset);
    if (!t || (t.type !== "string" && t.type !== "comment")) return "code";
    if (offset <= t.from) return "code";
    if (offset < t.to) return t.type;
    if (offset === t.to && (t.type === "comment" || !t.closed)) return t.type; // end of line comment / open string
    return "code";
  }

  // The last token starting before `offset`.
  tokenAt(offset) {
    let lo = 0;
    let hi = this.tokens.length - 1;
    let found = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.tokens[mid].from < offset) {
        found = this.tokens[mid];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  }

  // The bracket token touching `offset` (just before or just after it).
  bracketNear(offset) {
    let before = null;
    for (const t of this.tokens) {
      if (t.from > offset) break;
      if (t.type !== "open" && t.type !== "close") continue;
      if (t.from === offset) return t; // the bracket after the cursor wins
      if (t.to === offset) before = t;
    }
    return before;
  }

  identAt(offset) {
    return this.tokens.find((t) => t.type === "ident" && t.from <= offset && t.to >= offset) || null;
  }

  names() {
    return this.tokens.filter((t) => t.type === "ident").map((t) => t.value);
  }

  // Names that follow a dot (object.member), to suggest after typing "."
  members() {
    const out = [];
    for (let k = 1; k < this.tokens.length; k++) {
      const t = this.tokens[k];
      const p = this.tokens[k - 1];
      if (t.type === "ident" && p.type === "punct" && this.text[p.from] === "." && p.to === t.from) out.push(t.value);
    }
    return out;
  }
}

// Lexing is cheap, but every keystroke asks; keep the last few results.
const memo = new Map();
function lexCached(text, def) {
  const key = `${def.id}\u0000${text}`;
  let hit = memo.get(key);
  if (hit) {
    memo.delete(key);
    memo.set(key, hit);
    return hit;
  }
  hit = lex(text, def);
  memo.set(key, hit);
  if (memo.size > 24) memo.delete(memo.keys().next().value);
  return hit;
}

export { lex, lexCached, OPEN, CLOSE };
