// Reading the shipped page's own code, so checks run what ships rather than a copy
// (HOSTD-83). Used by test-evidence.mjs's sibling checks: test-claims.mjs, claims.mjs
// and url-sweep.mjs.
import vm from "node:vm";

// A top-level `function NAME(…) { … }` (brace-matched; strings and line comments
// skipped) or a `const NAME = …;` (up to the first `;` at bracket depth 0).
export function cut(source, name) {
  const fn = new RegExp(`^(async )?function ${name}\\(`, "m").exec(source);
  const konst = new RegExp(`^const ${name} = `, "m").exec(source);
  const start = fn ? fn.index : konst ? konst.index : -1;
  if (start < 0) throw new Error(`definition of ${name} not found`);
  let depth = 0;
  let quote = null;
  let seenBrace = false;
  for (let i = start; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    // Line comments ("dashboard's") are not strings.
    if (c === "/" && source[i + 1] === "/") { i = source.indexOf("\n", i); if (i < 0) break; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "{" || c === "(" || c === "[") { depth += 1; if (c === "{") seenBrace = true; continue; }
    if (c === "}" || c === ")" || c === "]") {
      depth -= 1;
      if (fn && depth === 0 && c === "}" && seenBrace) return source.slice(start, i + 1);
      continue;
    }
    if (!fn && depth === 0 && c === ";") return source.slice(start, i + 1);
  }
  throw new Error(`end of ${name} not found`);
}

// The code between `// <name>` and `// </name>` markers.
export function marked(html, name) {
  const found = html.match(new RegExp(`// <${name}>\\n([\\s\\S]*?)// </${name}>`));
  if (!found) throw new Error(`// <${name}> markers not found`);
  return found[1];
}

// The page's STRINGS declaration, its source text and its value.
export function stringsOf(html) {
  const found = html.match(/const STRINGS = (\{[\s\S]*?\n\});/);
  if (!found) throw new Error("STRINGS not found");
  return { source: found[0], value: vm.runInNewContext(`(${found[1]})`) };
}
