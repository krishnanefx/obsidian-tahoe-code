/*
 * What Tahoe Code knows about each language: how code blocks name it, how it
 * indents, comments and quotes, which lines open and close blocks, and the
 * words it suggests before anything else is known.
 *
 *   unit         indent: spaces per level, or "tab"
 *   line, block  comment tokens
 *   quotes       characters that start strings; triple: Python's """ """
 *   transpose    ' after a value is MATLAB's transpose, not a string
 *   indentAfter  a line (before the cursor, comments removed) that opens a level
 *   dedentAfter  a line after which the next one steps back (Python's return)
 *   dedents      a line that steps back to its opener's level (else, end, })
 *   ends         [opener pattern, closer] pairs for adding `end`, `fi`, `done`…
 */

const BRACES = /[{([]\s*$/;
const CLOSERS = /^\s*[}\])]/;

const C_FAMILY = {
  line: "//",
  block: ["/*", "*/"],
  quotes: ['"', "'"],
  indentAfter: BRACES,
  dedents: CLOSERS,
};

const LANGS = [
  {
    id: "python",
    label: "Python",
    aliases: ["python", "py", "python3", "ipython"],
    ext: "py",
    unit: 4,
    line: "#",
    quotes: ['"', "'"],
    triple: true,
    indentAfter: /(:|[{([])\s*$/,
    dedentAfter: /^\s*(return\b|pass\b|break\b|continue\b|raise\b)/,
    dedents: /^\s*(else\s*:|elif\b.*:|except\b.*:|finally\s*:|case\b.*:)\s*$|^\s*[}\])]/,
  },
  { id: "javascript", label: "JavaScript", aliases: ["javascript", "js", "jsx", "node", "mjs", "cjs"], ext: "js", unit: 2, ...C_FAMILY, quotes: ['"', "'", "`"] },
  { id: "typescript", label: "TypeScript", aliases: ["typescript", "ts", "tsx"], ext: "ts", unit: 2, ...C_FAMILY, quotes: ['"', "'", "`"] },
  { id: "java", label: "Java", aliases: ["java"], ext: "java", unit: 4, ...C_FAMILY },
  { id: "kotlin", label: "Kotlin", aliases: ["kotlin", "kt", "kts"], ext: "kt", unit: 4, ...C_FAMILY },
  { id: "c", label: "C", aliases: ["c", "h"], ext: "c", unit: 4, ...C_FAMILY },
  { id: "cpp", label: "C++", aliases: ["cpp", "c++", "cc", "cxx", "hpp"], ext: "cpp", unit: 4, ...C_FAMILY },
  { id: "objc", label: "Objective-C", aliases: ["objc", "objective-c", "objectivec"], ext: "m", unit: 4, ...C_FAMILY },
  { id: "csharp", label: "C#", aliases: ["csharp", "cs", "c#"], ext: "cs", unit: 4, ...C_FAMILY },
  { id: "go", label: "Go", aliases: ["go", "golang"], ext: "go", unit: "tab", ...C_FAMILY, quotes: ['"', "'", "`"] },
  { id: "rust", label: "Rust", aliases: ["rust", "rs"], ext: "rs", unit: 4, ...C_FAMILY, quotes: ['"'] },
  { id: "swift", label: "Swift", aliases: ["swift"], ext: "swift", unit: 4, ...C_FAMILY, quotes: ['"'] },
  { id: "dart", label: "Dart", aliases: ["dart"], ext: "dart", unit: 2, ...C_FAMILY },
  { id: "scala", label: "Scala", aliases: ["scala"], ext: "scala", unit: 2, ...C_FAMILY },
  { id: "php", label: "PHP", aliases: ["php"], ext: "php", unit: 4, ...C_FAMILY },
  { id: "css", label: "CSS", aliases: ["css", "scss", "less"], ext: "css", unit: 2, line: null, block: ["/*", "*/"], quotes: ['"', "'"], indentAfter: BRACES, dedents: CLOSERS },
  { id: "json", label: "JSON", aliases: ["json", "jsonc", "json5"], ext: "json", unit: 2, line: null, quotes: ['"'], indentAfter: BRACES, dedents: CLOSERS },
  {
    id: "matlab",
    label: "MATLAB",
    aliases: ["matlab"],
    ext: "m",
    unit: 4,
    line: "%",
    block: ["%{", "%}"],
    quotes: ['"', "'"],
    transpose: true,
    indentAfter: /^\s*(for|parfor|while|if|elseif|else|switch|case|otherwise|try|catch|function|classdef|properties|methods|events|enumeration|spmd)\b(?!.*\bend\s*;?\s*$)|[{([]\s*$/,
    dedents: /^\s*(elseif|else|case|otherwise|catch|end)\b|^\s*[}\])]/,
    ends: [[/^(for|parfor|while|if|switch|try|function|classdef|properties|methods|events|enumeration|spmd)\b/, "end"]],
  },
  {
    id: "octave",
    label: "Octave",
    aliases: ["octave"],
    ext: "m",
    unit: 4,
    line: "%",
    block: ["%{", "%}"],
    quotes: ['"', "'"],
    transpose: true,
    indentAfter: /^\s*(for|parfor|while|if|elseif|else|switch|case|otherwise|try|catch|function|do|unwind_protect|unwind_protect_cleanup)\b(?!.*\bend\w*\s*;?\s*$)|[{([]\s*$/,
    dedents: /^\s*(elseif|else|case|otherwise|catch|end\w*|until|unwind_protect_cleanup)\b|^\s*[}\])]/,
    ends: [[/^(for|parfor|while|if|switch|try|function)\b/, "end"], [/^do\b/, "until "]],
  },
  {
    id: "julia",
    label: "Julia",
    aliases: ["julia", "jl"],
    ext: "jl",
    unit: 4,
    line: "#",
    block: ["#=", "=#"],
    quotes: ['"'],
    indentAfter: /^\s*(function|for|while|if|elseif|else|begin|let|struct|mutable\s+struct|module|try|catch|finally|macro|quote)\b(?!.*\bend\s*$)|\bdo(\s+[\w, ]+)?\s*$|[{([]\s*$/,
    dedents: /^\s*(elseif|else|catch|finally|end)\b|^\s*[}\])]/,
    ends: [[/^(function|for|while|if|begin|let|struct|mutable\s+struct|module|try|macro|quote)\b|\bdo(\s+[\w, ]+)?$/, "end"]],
  },
  {
    id: "ruby",
    label: "Ruby",
    aliases: ["ruby", "rb"],
    ext: "rb",
    unit: 2,
    line: "#",
    quotes: ['"', "'"],
    indentAfter: /^\s*(def|class|module|if|unless|while|until|case|when|else|elsif|begin|rescue|ensure|for)\b|\bdo(\s*\|[^|]*\|)?\s*$|[{([]\s*$/,
    dedents: /^\s*(else|elsif|when|rescue|ensure|end)\b|^\s*[}\])]/,
    ends: [[/^(def|class|module|if|unless|while|until|case|begin|for)\b|\bdo(\s*\|[^|]*\|)?$/, "end"]],
  },
  {
    id: "lua",
    label: "Lua",
    aliases: ["lua"],
    ext: "lua",
    unit: 4,
    line: "--",
    block: ["--[[", "]]"],
    quotes: ['"', "'"],
    indentAfter: /\b(then|do)\s*$|^\s*(local\s+)?function\b|\bfunction\s*\([^)]*\)\s*$|^\s*(else|repeat)\b|[{([]\s*$/,
    dedents: /^\s*(else|elseif|end|until)\b|^\s*[}\])]/,
    ends: [[/\b(then|do)$|^(local\s+)?function\b|\bfunction\s*\([^)]*\)$/, "end"], [/^repeat$/, "until "]],
  },
  {
    id: "shell",
    label: "Shell",
    aliases: ["sh", "bash", "shell", "zsh", "console", "shellscript"],
    ext: "sh",
    unit: 4,
    line: "#",
    quotes: ['"', "'", "`"],
    indentAfter: /(\bthen|\bdo|\belse|\{)\s*$|^\s*case\b.*\bin\s*$|^\s*[^#\s][^)]*\)\s*$/,
    dedents: /^\s*(else|elif|fi|done|esac)\b|^\s*\}|^\s*;;/,
    ends: [[/^if\b.*\bthen$|^elif\b/, "fi"], [/^(for|while|until|select)\b.*\bdo$/, "done"], [/^case\b.*\bin$/, "esac"]],
  },
  {
    id: "r",
    label: "R",
    aliases: ["r"],
    ext: "R",
    unit: 2,
    line: "#",
    quotes: ['"', "'"],
    indentAfter: BRACES,
    dedents: CLOSERS,
  },
  { id: "perl", label: "Perl", aliases: ["perl", "pl"], ext: "pl", unit: 4, line: "#", quotes: ['"', "'"], indentAfter: BRACES, dedents: CLOSERS },
  { id: "haskell", label: "Haskell", aliases: ["haskell", "hs"], ext: "hs", unit: 2, line: "--", block: ["{-", "-}"], quotes: ['"'], indentAfter: /(\bwhere|\bdo|\bof|\blet|=|->|[{([])\s*$/, dedents: CLOSERS },
  { id: "sql", label: "SQL", aliases: ["sql", "sqlite", "sqlite3", "mysql", "postgresql", "psql"], ext: "sql", unit: 2, line: "--", block: ["/*", "*/"], quotes: ["'", '"'], indentAfter: /\(\s*$/, dedents: /^\s*\)/ },
  {
    id: "applescript",
    label: "AppleScript",
    aliases: ["applescript", "osascript"],
    ext: "applescript",
    unit: 4,
    line: "--",
    block: ["(*", "*)"],
    quotes: ['"'],
    indentAfter: /^\s*(tell\b(?!.*\bto\b)|if\b.*\bthen\s*$|else\b|repeat\b|try\b|on\s+\w+|considering\b|ignoring\b|with\s+timeout\b|using\s+terms\s+from\b)/,
    dedents: /^\s*(else|end|on\s+error)\b/,
    ends: [[/^tell\b(?!.*\bto\b)/, "end tell"], [/^if\b.*\bthen$/, "end if"], [/^repeat\b/, "end repeat"], [/^try\b/, "end try"], [/^on\s+(\w+)/, (m) => `end ${m[1]}`]],
  },
  { id: "yaml", label: "YAML", aliases: ["yaml", "yml"], ext: "yaml", unit: 2, line: "#", quotes: ['"', "'"], indentAfter: /:\s*$|^\s*-\s*$/ },
  { id: "toml", label: "TOML", aliases: ["toml", "ini"], ext: "toml", unit: 2, line: "#", quotes: ['"', "'"] },
  { id: "html", label: "HTML", aliases: ["html", "xml", "svg", "vue"], ext: "html", unit: 2, line: null, block: ["<!--", "-->"], quotes: ['"', "'"], indentAfter: /<(?!\/|!|br\b|img\b|input\b|meta\b|link\b|hr\b)[^>]*[^/]>\s*$/, dedents: /^\s*<\// },
];

// Words to suggest before anything else is known about a block.
const WORDS = {
  python:
    "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case print len range enumerate zip map filter sorted reversed sum min max abs round int float str bool list dict set tuple frozenset bytes type isinstance issubclass hasattr getattr setattr open input super property staticmethod classmethod object iter next any all format repr divmod pow hash id dir vars help self __init__ __name__ __main__ append extend insert remove pop clear index count sort reverse keys values items get update split join strip replace startswith endswith lower upper format_map numpy pandas matplotlib pyplot np pd plt",
  javascript:
    "break case catch class const continue debugger default delete do else export extends false finally for function if import in instanceof let new null return super switch this throw true try typeof undefined var void while with yield async await of console log error warn info table Math floor ceil round random max min abs sqrt pow PI Array Object String Number Boolean Date JSON parse stringify Promise then catch finally resolve reject map filter reduce forEach find findIndex some every includes indexOf push pop shift unshift slice splice concat join sort keys values entries length setTimeout setInterval fetch require module exports document window",
  typescript:
    "break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null private protected public readonly return static super switch this throw true try type typeof undefined var void while yield async await of as keyof never unknown any string number boolean console log Math Array Object String Number Promise Record Partial Readonly map filter reduce forEach find includes push length",
  java:
    "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static super switch synchronized this throw throws transient try void volatile while true false null var record String System out println printf print Math Integer Double Long Boolean Character List ArrayList Map HashMap Set HashSet Arrays Collections Scanner Optional stream length size add get put contains equals hashCode toString main args",
  kotlin:
    "as break class continue do else false for fun if in interface is null object package return super this throw true try typealias val var when while by catch constructor finally get init set data sealed enum open override private public internal companion lateinit println print listOf mutableListOf mapOf setOf arrayOf String Int Double Boolean List Map let also apply run with",
  c: "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while NULL printf scanf malloc calloc free strlen strcpy strcmp memcpy memset fopen fclose fprintf include define main stdio stdlib string",
  cpp:
    "alignas alignof auto bool break case catch char class const constexpr const_cast continue decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept nullptr operator private protected public return short signed sizeof static static_cast struct switch template this throw true try typedef typename union unsigned using virtual void volatile while std cout cin cerr endl string vector map unordered_map set pair make_pair push_back emplace_back size begin end sort find printf include main iostream algorithm",
  objc: "if else for while do switch case break continue return void int float double char BOOL YES NO nil self super id NSString NSArray NSDictionary NSLog alloc init interface implementation end property strong weak nonatomic import autoreleasepool",
  csharp:
    "abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while async await Console WriteLine Write ReadLine List Dictionary Math",
  go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil iota append cap close copy delete len make new panic print println recover error string int float64 bool byte rune fmt Println Printf Sprintf Errorf main",
  rust: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while println print format vec Vec String Option Some None Result Ok Err Box Rc HashMap iter map collect unwrap expect clone len push main",
  swift:
    "associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private protocol public rethrows static struct subscript typealias var break case continue default defer do else fallthrough for guard if in repeat return switch where while as catch false is nil super self Self throw throws true try print String Int Double Bool Array Dictionary Set Optional map filter reduce forEach count append isEmpty",
  matlab:
    "break case catch classdef continue else elseif end for function global if otherwise parfor persistent return switch try while true false pi Inf NaN eps disp fprintf sprintf num2str str2num str2double plot figure hold on off xlabel ylabel zlabel title legend grid axis subplot tiledlayout nexttile scatter bar histogram surf mesh meshgrid linspace zeros ones eye rand randn randi size numel length ndims reshape repmat sum prod cumsum mean median std var min max abs sqrt exp log log10 sin cos tan atan2 floor ceil round mod rem find sort unique any all isempty isfield fieldnames struct cell cellfun arrayfun strcmp strcat strsplit strjoin regexp contains table readtable writetable load save clear clc close tic toc inv det eig transpose ode45 interp1 polyfit polyval fzero integral",
  octave:
    "break case catch continue do else elseif end endfor endfunction endif endwhile for function global if otherwise return switch try until unwind_protect while disp printf fprintf plot figure zeros ones linspace size numel sum mean max min abs sqrt",
  julia: "abstract baremodule begin break catch const continue do else elseif end export false finally for function global if import let local macro module mutable quote return struct true try using while println print push! length size zeros ones collect map filter reduce sum maximum minimum",
  ruby: "BEGIN END alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield puts print p require attr_accessor each map select reject reduce inject length size push include? empty? to_s to_i",
  lua: "and break do else elseif end false for function goto if in local nil not or repeat return then true until while print pairs ipairs table insert remove concat string format sub gsub find len math floor require",
  shell: "if then else elif fi for while until do done case esac in function return exit echo printf read local export source cd ls grep sed awk cat find xargs sort uniq head tail wc mkdir rm cp mv test true false",
  r: "if else repeat while function for in next break TRUE FALSE NULL Inf NaN NA library require print cat paste paste0 c list vector matrix data.frame length nrow ncol head tail summary mean median sd sum apply lapply sapply plot ggplot",
  sql: "SELECT FROM WHERE AND OR NOT INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE PRIMARY KEY FOREIGN REFERENCES DROP ALTER ADD JOIN LEFT RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT OFFSET AS DISTINCT COUNT SUM AVG MIN MAX NULL IS LIKE IN BETWEEN UNION CASE WHEN THEN ELSE END INTEGER TEXT REAL",
  haskell: "case class data default deriving do else if import in infix instance let module newtype of then type where main putStrLn print map filter foldr foldl length head tail show read return Maybe Just Nothing Either Left Right IO Int String",
  php: "abstract and array as break case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global if implements include instanceof interface isset list namespace new or print private protected public require return static switch throw trait try unset use var while yield true false null",
  perl: "my our local sub if elsif else unless while until for foreach last next redo return print printf say use strict warnings shift push pop keys values exists delete defined",
};

const byAlias = new Map();
for (const lang of LANGS) for (const a of lang.aliases) byAlias.set(a, lang);

function langFor(name) {
  return name ? byAlias.get(String(name).toLowerCase()) || null : null;
}

function wordsFor(id) {
  return (WORDS[id] || "").split(/\s+/).filter(Boolean);
}

export { LANGS, langFor, wordsFor };
