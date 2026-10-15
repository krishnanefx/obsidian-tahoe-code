/*
 * Live templates (type an abbreviation, press Tab) and postfix completions
 * (`items.for` → a loop over items), like IntelliJ's. Bodies use CodeMirror's
 * snippet fields: ${1:name} is a field you Tab to, the same number twice is
 * the same field (typed once, filled in both places), ${} is where the
 * cursor ends up. A leading \t is one indent level in the block's own style.
 */

const T = (abbr, desc, body) => ({ abbr, desc, body });

const TEMPLATES = {
  python: [
    T("main", "if __name__ == \"__main__\"", 'if __name__ == "__main__":\n\t${}'),
    T("fori", "for i in range(…)", "for ${1:i} in range(${2:n}):\n\t${}"),
    T("for", "for … in …", "for ${1:item} in ${2:items}:\n\t${}"),
    T("enum", "for i, x in enumerate(…)", "for ${1:i}, ${2:item} in enumerate(${3:items}):\n\t${}"),
    T("def", "function", "def ${1:name}(${2}):\n\t${pass}"),
    T("cls", "class", "class ${1:Name}:\n\tdef __init__(self${2}):\n\t\t${pass}"),
    T("try", "try / except", "try:\n\t${}\nexcept ${1:Exception} as ${2:e}:\n\t${raise}"),
    T("with", "with open(…)", 'with open(${1:"path"}) as ${2:f}:\n\t${}'),
    T("lc", "list comprehension", "[${1:x} for ${1:x} in ${2:items}${}]"),
    T("pr", "print(…)", "print(${})"),
    T("prf", "print(f\"…\")", 'print(f"${}")'),
    T("ifn", "if not …", "if not ${1:cond}:\n\t${}"),
    T("while", "while …", "while ${1:cond}:\n\t${}"),
    T("plt", "matplotlib plot", "import matplotlib.pyplot as plt\n\nplt.plot(${1:x}, ${2:y})\nplt.xlabel(${3:\"x\"})\nplt.ylabel(${4:\"y\"})\nplt.title(${5:\"\"})\nplt.show()"),
  ],
  java: [
    T("psvm", "public static void main", "public static void main(String[] args) {\n\t${}\n}"),
    T("main", "class with main", "public class ${1:Main} {\n\tpublic static void main(String[] args) {\n\t\t${}\n\t}\n}"),
    T("sout", "System.out.println", "System.out.println(${});"),
    T("souf", "System.out.printf", 'System.out.printf("${1}%n"${2});'),
    T("soutv", "print a variable", 'System.out.println("${1:x} = " + ${1:x});'),
    T("fori", "for (int i …)", "for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t${}\n}"),
    T("iter", "for (var x : …)", "for (var ${1:item} : ${2:items}) {\n\t${}\n}"),
    T("ifn", "if (… == null)", "if (${1:x} == null) {\n\t${}\n}"),
    T("inn", "if (… != null)", "if (${1:x} != null) {\n\t${}\n}"),
    T("try", "try / catch", "try {\n\t${}\n} catch (${1:Exception} ${2:e}) {\n\t${2:e}.printStackTrace();\n}"),
    T("thr", "throw new …", "throw new ${1:IllegalArgumentException}(${2});"),
  ],
  kotlin: [
    T("main", "fun main()", "fun main() {\n\t${}\n}"),
    T("sout", "println", "println(${})"),
    T("fun", "function", "fun ${1:name}(${2}): ${3:Unit} {\n\t${}\n}"),
    T("fori", "for (i in 0 until n)", "for (${1:i} in 0 until ${2:n}) {\n\t${}\n}"),
    T("for", "for (x in …)", "for (${1:item} in ${2:items}) {\n\t${}\n}"),
  ],
  javascript: [
    T("log", "console.log", "console.log(${});"),
    T("fori", "for (let i …)", "for (let ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t${}\n}"),
    T("forof", "for (const x of …)", "for (const ${1:item} of ${2:items}) {\n\t${}\n}"),
    T("forin", "for (const k in …)", "for (const ${1:key} in ${2:object}) {\n\t${}\n}"),
    T("fn", "function", "function ${1:name}(${2}) {\n\t${}\n}"),
    T("afn", "arrow function", "const ${1:name} = (${2}) => {\n\t${}\n};"),
    T("asfn", "async function", "async function ${1:name}(${2}) {\n\t${}\n}"),
    T("if", "if (…)", "if (${1:cond}) {\n\t${}\n}"),
    T("ife", "if / else", "if (${1:cond}) {\n\t${}\n} else {\n\t\n}"),
    T("try", "try / catch", "try {\n\t${}\n} catch (${1:error}) {\n\tconsole.error(${1:error});\n}"),
    T("cls", "class", "class ${1:Name} {\n\tconstructor(${2}) {\n\t\t${}\n\t}\n}"),
    T("iife", "async IIFE", "(async () => {\n\t${}\n})();"),
  ],
  c: [
    T("main", "int main()", "#include <stdio.h>\n\nint main(void) {\n\t${}\n\treturn 0;\n}"),
    T("fori", "for (int i …)", "for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t${}\n}"),
    T("pf", "printf", 'printf("${1}\\n"${2});'),
    T("inc", "#include", "#include <${1:stdio.h}>"),
    T("if", "if (…)", "if (${1:cond}) {\n\t${}\n}"),
    T("while", "while (…)", "while (${1:cond}) {\n\t${}\n}"),
    T("st", "struct", "typedef struct {\n\t${}\n} ${1:Name};"),
  ],
  cpp: [
    T("main", "int main()", "#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n\t${}\n\treturn 0;\n}"),
    T("fori", "for (int i …)", "for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n\t${}\n}"),
    T("forr", "for (auto& x : …)", "for (auto& ${1:x} : ${2:items}) {\n\t${}\n}"),
    T("cout", "cout << … << endl", "cout << ${} << endl;"),
    T("cin", "cin >> …", "cin >> ${};"),
    T("inc", "#include", "#include <${1:iostream}>"),
    T("vec", "vector<…>", "vector<${1:int}> ${2:v}${};"),
    T("if", "if (…)", "if (${1:cond}) {\n\t${}\n}"),
    T("cls", "class", "class ${1:Name} {\npublic:\n\t${1:Name}(${2}) {}\n\t${}\n};"),
    T("st", "struct", "struct ${1:Name} {\n\t${}\n};"),
  ],
  csharp: [
    T("cw", "Console.WriteLine", "Console.WriteLine(${});"),
    T("main", "static void Main", "static void Main(string[] args)\n{\n\t${}\n}"),
    T("fori", "for (int i …)", "for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++)\n{\n\t${}\n}"),
    T("foreach", "foreach (var x in …)", "foreach (var ${1:item} in ${2:items})\n{\n\t${}\n}"),
  ],
  go: [
    T("main", "package main + func main", "package main\n\nimport \"fmt\"\n\nfunc main() {\n\t${}\n}"),
    T("pr", "fmt.Println", "fmt.Println(${})"),
    T("fori", "for i := 0; …", "for ${1:i} := 0; ${1:i} < ${2:n}; ${1:i}++ {\n\t${}\n}"),
    T("forr", "for _, x := range …", "for ${1:_}, ${2:v} := range ${3:items} {\n\t${}\n}"),
    T("fn", "func", "func ${1:name}(${2}) ${3}{\n\t${}\n}"),
    T("iferr", "if err != nil", "if err != nil {\n\treturn ${err}\n}"),
  ],
  rust: [
    T("main", "fn main()", "fn main() {\n\t${}\n}"),
    T("fn", "fn", "fn ${1:name}(${2}) ${3}{\n\t${}\n}"),
    T("pl", "println!", 'println!("${1}"${2});'),
    T("fori", "for i in 0..n", "for ${1:i} in 0..${2:n} {\n\t${}\n}"),
    T("for", "for x in …", "for ${1:item} in ${2:items} {\n\t${}\n}"),
    T("st", "struct", "struct ${1:Name} {\n\t${}\n}"),
    T("impl", "impl", "impl ${1:Name} {\n\t${}\n}"),
  ],
  swift: [
    T("func", "func", "func ${1:name}(${2}) ${3}{\n\t${}\n}"),
    T("pr", "print", "print(${})"),
    T("fori", "for i in 0..<n", "for ${1:i} in 0..<${2:n} {\n\t${}\n}"),
    T("for", "for x in …", "for ${1:item} in ${2:items} {\n\t${}\n}"),
    T("guard", "guard let", "guard let ${1:value} = ${2:optional} else {\n\t${return}\n}"),
    T("iflet", "if let", "if let ${1:value} = ${2:optional} {\n\t${}\n}"),
    T("st", "struct", "struct ${1:Name} {\n\t${}\n}"),
  ],
  matlab: [
    T("fori", "for i = 1:n … end", "for ${1:i} = 1:${2:n}\n\t${}\nend"),
    T("for", "for x = … end", "for ${1:x} = ${2:values}\n\t${}\nend"),
    T("if", "if … end", "if ${1:cond}\n\t${}\nend"),
    T("ife", "if … else … end", "if ${1:cond}\n\t${}\nelse\n\t\nend"),
    T("while", "while … end", "while ${1:cond}\n\t${}\nend"),
    T("func", "function", "function ${1:out} = ${2:name}(${3:in})\n\t${}\nend"),
    T("sw", "switch … end", "switch ${1:value}\n\tcase ${2:1}\n\t\t${}\n\totherwise\n\t\t\nend"),
    T("try", "try … catch … end", "try\n\t${}\ncatch ${1:err}\n\tdisp(${1:err}.message)\nend"),
    T("fp", "fprintf", "fprintf('${1}\\n'${2});"),
    T("plt", "figure + plot", "figure;\nplot(${1:x}, ${2:y});\nxlabel('${3:x}'); ylabel('${4:y}'); title('${5}');\ngrid on"),
  ],
  octave: [
    T("fori", "for i = 1:n … end", "for ${1:i} = 1:${2:n}\n\t${}\nend"),
    T("if", "if … end", "if ${1:cond}\n\t${}\nend"),
    T("func", "function", "function ${1:out} = ${2:name}(${3:in})\n\t${}\nend"),
  ],
  julia: [
    T("fn", "function", "function ${1:name}(${2})\n\t${}\nend"),
    T("fori", "for i in 1:n", "for ${1:i} in 1:${2:n}\n\t${}\nend"),
    T("pl", "println", "println(${})"),
  ],
  ruby: [
    T("def", "def … end", "def ${1:name}(${2})\n\t${}\nend"),
    T("each", ".each do |x|", "${1:items}.each do |${2:item}|\n\t${}\nend"),
    T("cls", "class", "class ${1:Name}\n\tdef initialize(${2})\n\t\t${}\n\tend\nend"),
    T("if", "if … end", "if ${1:cond}\n\t${}\nend"),
  ],
  lua: [
    T("fn", "function", "function ${1:name}(${2})\n\t${}\nend"),
    T("fori", "for i = 1, n", "for ${1:i} = 1, ${2:n} do\n\t${}\nend"),
    T("forp", "for k, v in pairs", "for ${1:k}, ${2:v} in pairs(${3:t}) do\n\t${}\nend"),
    T("if", "if … then", "if ${1:cond} then\n\t${}\nend"),
  ],
  shell: [
    T("if", "if … then … fi", "if [[ ${1:cond} ]]; then\n\t${}\nfi"),
    T("for", "for x in … do", "for ${1:x} in ${2:items}; do\n\t${}\ndone"),
    T("while", "while … do", "while ${1:cond}; do\n\t${}\ndone"),
    T("fn", "function", "${1:name}() {\n\t${}\n}"),
    T("case", "case … esac", "case ${1:\"$x\"} in\n\t${2:pattern})\n\t\t${}\n\t\t;;\nesac"),
  ],
  r: [
    T("fn", "function", "${1:name} <- function(${2}) {\n\t${}\n}"),
    T("for", "for (x in …)", "for (${1:x} in ${2:items}) {\n\t${}\n}"),
    T("if", "if (…)", "if (${1:cond}) {\n\t${}\n}"),
    T("lib", "library", "library(${})"),
  ],
  sql: [
    T("sel", "SELECT … FROM …", "SELECT ${1:*}\nFROM ${2:table}\nWHERE ${};"),
    T("ins", "INSERT INTO", "INSERT INTO ${1:table} (${2:columns})\nVALUES (${});"),
    T("ct", "CREATE TABLE", "CREATE TABLE ${1:name} (\n\tid INTEGER PRIMARY KEY,\n\t${}\n);"),
  ],
  haskell: [T("main", "main = do", "main :: IO ()\nmain = do\n\t${}")],
};
TEMPLATES.typescript = TEMPLATES.javascript;
TEMPLATES.objc = TEMPLATES.c;

// Postfix: expr.<name> → body, with $expr standing for the expression.
const P = (name, desc, body) => ({ name, desc, body });
const C_POSTFIX = [
  P("if", "if (expr)", "if ($expr) {\n\t${}\n}"),
  P("not", "!expr", "!$expr"),
  P("ret", "return expr", "return $expr;"),
  P("par", "(expr)", "($expr)"),
];
const POSTFIX = {
  python: [
    P("print", "print(expr)", "print($expr)"),
    P("len", "len(expr)", "len($expr)"),
    P("if", "if expr:", "if $expr:\n\t${}"),
    P("ifn", "if not expr:", "if not $expr:\n\t${}"),
    P("not", "not expr", "not $expr"),
    P("for", "for x in expr:", "for ${1:item} in $expr:\n\t${}"),
    P("enum", "for i, x in enumerate(expr):", "for ${1:i}, ${2:item} in enumerate($expr):\n\t${}"),
    P("ret", "return expr", "return $expr"),
    P("var", "name = expr", "${1:name} = $expr"),
    P("str", "str(expr)", "str($expr)"),
    P("list", "list(expr)", "list($expr)"),
    P("sorted", "sorted(expr)", "sorted($expr)"),
    P("type", "type(expr)", "type($expr)"),
    P("par", "(expr)", "($expr)"),
  ],
  javascript: [P("log", "console.log(expr)", "console.log($expr);"), ...C_POSTFIX, P("for", "for (const x of expr)", "for (const ${1:item} of $expr) {\n\t${}\n}"), P("const", "const name = expr", "const ${1:name} = $expr;"), P("let", "let name = expr", "let ${1:name} = $expr;"), P("await", "await expr", "await $expr"), P("json", "JSON.stringify(expr)", "JSON.stringify($expr)")],
  java: [P("sout", "System.out.println(expr)", "System.out.println($expr);"), ...C_POSTFIX, P("for", "for (var x : expr)", "for (var ${1:item} : $expr) {\n\t${}\n}"), P("var", "var name = expr", "var ${1:name} = $expr;"), P("nn", "if (expr != null)", "if ($expr != null) {\n\t${}\n}"), P("null", "if (expr == null)", "if ($expr == null) {\n\t${}\n}")],
  kotlin: [P("print", "println(expr)", "println($expr)"), P("if", "if (expr)", "if ($expr) {\n\t${}\n}"), P("for", "for (x in expr)", "for (${1:item} in $expr) {\n\t${}\n}"), P("val", "val name = expr", "val ${1:name} = $expr")],
  c: [P("pf", "printf(…, expr)", 'printf("${1:%d}\\n", $expr);'), ...C_POSTFIX],
  cpp: [P("cout", "cout << expr", "cout << $expr << endl;"), ...C_POSTFIX, P("for", "for (auto& x : expr)", "for (auto& ${1:x} : $expr) {\n\t${}\n}"), P("var", "auto name = expr", "auto ${1:name} = $expr;"), P("size", "expr.size()", "$expr.size()")],
  csharp: [P("cw", "Console.WriteLine(expr)", "Console.WriteLine($expr);"), ...C_POSTFIX, P("for", "foreach (var x in expr)", "foreach (var ${1:item} in $expr)\n{\n\t${}\n}"), P("var", "var name = expr", "var ${1:name} = $expr;")],
  go: [P("print", "fmt.Println(expr)", "fmt.Println($expr)"), P("if", "if expr", "if $expr {\n\t${}\n}"), P("not", "!expr", "!$expr"), P("for", "for _, x := range expr", "for _, ${1:v} := range $expr {\n\t${}\n}"), P("var", "name := expr", "${1:name} := $expr"), P("ret", "return expr", "return $expr")],
  rust: [P("println", "println!(\"{:?}\", expr)", 'println!("{:?}", $expr);'), P("dbg", "dbg!(expr)", "dbg!($expr)"), P("if", "if expr", "if $expr {\n\t${}\n}"), P("not", "!expr", "!$expr"), P("for", "for x in expr", "for ${1:x} in $expr {\n\t${}\n}"), P("let", "let name = expr", "let ${1:name} = $expr;"), P("ret", "return expr", "return $expr;")],
  swift: [P("print", "print(expr)", "print($expr)"), P("if", "if expr", "if $expr {\n\t${}\n}"), P("not", "!expr", "!$expr"), P("for", "for x in expr", "for ${1:item} in $expr {\n\t${}\n}"), P("let", "let name = expr", "let ${1:name} = $expr"), P("ret", "return expr", "return $expr")],
  matlab: [P("disp", "disp(expr)", "disp($expr)"), P("if", "if expr … end", "if $expr\n\t${}\nend"), P("not", "~expr", "~$expr"), P("for", "for x = expr … end", "for ${1:x} = $expr\n\t${}\nend"), P("size", "size(expr)", "size($expr)"), P("numel", "numel(expr)", "numel($expr)"), P("plot", "plot(expr)", "plot($expr)"), P("var", "name = expr", "${1:name} = $expr;")],
  ruby: [P("puts", "puts expr", "puts $expr"), P("if", "if expr … end", "if $expr\n\t${}\nend"), P("unless", "unless expr … end", "unless $expr\n\t${}\nend"), P("each", "expr.each do |x|", "$expr.each do |${1:item}|\n\t${}\nend")],
  r: [P("print", "print(expr)", "print($expr)"), P("if", "if (expr)", "if ($expr) {\n\t${}\n}"), P("for", "for (x in expr)", "for (${1:x} in $expr) {\n\t${}\n}"), P("len", "length(expr)", "length($expr)")],
  lua: [P("print", "print(expr)", "print($expr)"), P("if", "if expr then", "if $expr then\n\t${}\nend"), P("for", "for _, x in ipairs(expr)", "for _, ${1:x} in ipairs($expr) do\n\t${}\nend"), P("len", "#expr", "#$expr")],
  julia: [P("println", "println(expr)", "println($expr)"), P("for", "for x in expr", "for ${1:x} in $expr\n\t${}\nend")],
};
POSTFIX.typescript = POSTFIX.javascript;
POSTFIX.objc = POSTFIX.c;
POSTFIX.octave = POSTFIX.matlab;

function templatesFor(langId, custom = []) {
  const own = (custom || []).filter((t) => t && t.abbr && t.body && (!t.lang || t.lang === langId || t.lang === "*"));
  const builtIn = TEMPLATES[langId] || [];
  // A custom template replaces a built-in one with the same abbreviation.
  const names = new Set(own.map((t) => t.abbr));
  return [...own.map((t) => ({ abbr: t.abbr, desc: t.desc || "Your template", body: t.body, custom: true })), ...builtIn.filter((t) => !names.has(t.abbr))];
}

function postfixFor(langId) {
  return POSTFIX[langId] || [];
}

export { templatesFor, postfixFor, TEMPLATES };
