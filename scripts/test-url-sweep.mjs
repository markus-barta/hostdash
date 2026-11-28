#!/usr/bin/env node
// The URL sweep after the merge (HOSTD-83 gate r4). url-sweep.mjs used to read
// origin/main and require the pre-rewrite page's functions in it; once this branch is
// main, every later run would have failed before comparing a single URL. It now
// compares against a frozen copy of 7e4896d's resolution logic. Checked here:
//
//   1. post-merge: this tree, copied into a git repo of its own whose main AND
//      origin/main are this very tree (main == this branch): the sweep runs and passes;
//   2. no history: the same copy without .git (what a shallow checkout lacks: any other
//      ref): the sweep runs and passes;
//   3. both say exactly what the sweep says in the working tree;
//   4. fixture fidelity: every definition in scripts/fixtures/url-baseline-7e4896d.js is
//      byte-identical to the one in 7e4896d:public/index.html, and the decision lines
//      appear there in order. Needs that commit object: CI fetches it by SHA (an
//      immutable ref); a local run without it says so and skips, a CI run fails.
//
// Every check runs; failures are listed together and the exit code is 1.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cut } from "./page-source.mjs";

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const BASE_COMMIT = "7e4896dcedbe083db8aa96e82587e4da28c2c8cd";
const FIXTURE = "scripts/fixtures/url-baseline-7e4896d.js";

const results = [];
const failures = [];
const check = (name, condition, detail) => {
  if (condition) results.push(name);
  else failures.push(`${name}: ${JSON.stringify(detail)}`.slice(0, 1200));
};

// The sweep as CI runs it, in a given tree.
const sweep = cwd => {
  const run = spawnSync(process.execPath, ["scripts/url-sweep.mjs", "--json"], { cwd, encoding: "utf8", maxBuffer: 1 << 26 });
  let json = null;
  try { json = JSON.parse(run.stdout); } catch { /* reported below */ }
  return { status: run.status, json, error: (run.stderr || "").split("\n").filter(line => /Error|fatal/.test(line)).slice(0, 2) };
};
const summary = out => out.json && JSON.stringify({ services: out.json.services, compared: out.json.compared, diffs: out.json.diffs, unexpected: out.json.unexpected });

// This tree's files, without its .git: what the sweep reads, and nothing else to lean on.
const copyTree = () => {
  const dir = mkdtempSync(join(tmpdir(), "hostdash-sweep-"));
  for (const part of ["public", "hosts", "scripts"]) cpSync(join(repoRoot, part), join(dir, part), { recursive: true });
  return dir;
};
// Plumbing only (no commit hooks, no signing), and no user or system git config.
const gitEnv = {
  ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "url-sweep test", GIT_AUTHOR_EMAIL: "test@invalid", GIT_COMMITTER_NAME: "url-sweep test", GIT_COMMITTER_EMAIL: "test@invalid",
};
const git = (cwd, ...gitArgs) => execFileSync("git", gitArgs, { cwd, env: gitEnv, encoding: "utf8" }).trim();

const here = sweep(repoRoot);
check("the sweep passes in the working tree", here.status === 0 && here.json?.unexpected === 0, here);

// 1. After the merge: main and origin/main are this tree.
{
  const dir = copyTree();
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  const commit = git(dir, "commit-tree", git(dir, "write-tree"), "-m", "this branch, merged");
  git(dir, "update-ref", "refs/heads/main", commit);
  git(dir, "update-ref", "refs/remotes/origin/main", commit);
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  const merged = sweep(dir);
  check("post-merge (main == origin/main == this branch): the sweep runs and passes", merged.status === 0 && merged.json?.unexpected === 0, merged);
  check("post-merge: the same comparisons and differences as in the working tree", summary(merged) === summary(here), { merged: summary(merged), here: summary(here) });
}

// 2. No history at all.
{
  const dir = copyTree();
  const bare = sweep(dir);
  check("no git history (no .git, no origin/main): the sweep runs and passes", bare.status === 0 && bare.json?.unexpected === 0, bare);
  check("no git history: the same comparisons and differences as in the working tree", summary(bare) === summary(here), { bare: summary(bare), here: summary(here) });
}

// 4. The frozen copy is what 7e4896d shipped.
{
  let baseHtml = null;
  try {
    execFileSync("git", ["cat-file", "-e", `${BASE_COMMIT}^{commit}`], { cwd: repoRoot, stdio: "ignore" });
    baseHtml = execFileSync("git", ["show", `${BASE_COMMIT}:public/index.html`], { cwd: repoRoot, encoding: "utf8", maxBuffer: 1 << 26 });
  } catch { /* not in this checkout */ }
  const fixture = existsSync(join(repoRoot, FIXTURE)) ? readFileSync(join(repoRoot, FIXTURE), "utf8") : "";
  check(`the fixture exists and names its commit and file`, fixture.includes(BASE_COMMIT) && fixture.includes("public/index.html"), FIXTURE);
  if (!fixture) { /* reported above */ } else if (baseHtml === null) {
    if (process.env.CI) check(`fixture fidelity: ${BASE_COMMIT} is in this checkout (CI fetches it by SHA)`, false, "commit object missing");
    else console.log(`test-url-sweep: fixture fidelity skipped, ${BASE_COMMIT.slice(0, 7)} is not in this checkout (git fetch --depth=1 origin ${BASE_COMMIT})`);
  } else {
    const names = [...fixture.matchAll(/^(?:function (\w+)\(|const (\w+) = )/gm)].map(m => m[1] || m[2]).filter(name => name !== "baseDecision");
    check("fixture fidelity: it defines the base's helpers, cleanServices and serviceTargetUrl",
      ["isObject", "objectOr", "arrayOrEmpty", "stringOr", "isLocalizable", "localizedOr", "cleanServices", "serviceTargetUrl"].every(name => names.includes(name)), names);
    for (const name of names) {
      let same = false;
      try { same = cut(fixture, name) === cut(baseHtml, name); } catch { /* reported */ }
      check(`fixture fidelity: ${name} is byte-identical to ${BASE_COMMIT.slice(0, 7)}:public/index.html`, same, name);
    }
    const verbatim = fixture.match(/\/\/ <verbatim>\n([\s\S]*?)\n\s*\/\/ <\/verbatim>/)?.[1].split("\n").map(line => line.trim()).filter(Boolean) || [];
    const baseLines = baseHtml.split("\n").map(line => line.trim());
    let at = baseLines.indexOf(verbatim[0]);
    const found = at >= 0 && verbatim.every(line => { const next = baseLines.indexOf(line, at); if (next < 0 || next - at > 30) return false; at = next + 1; return true; });
    check(`fixture fidelity: the ${verbatim.length} decision lines appear in ${BASE_COMMIT.slice(0, 7)}'s render loop, in order`, verbatim.length === 7 && found, verbatim);
  }
}

if (failures.length) {
  console.error(`test-url-sweep: ${failures.length} of ${failures.length + results.length} checks FAILED\n${failures.map(line => `  ✗ ${line}`).join("\n")}`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, checks: results.length, compared: here.json.compared, differences: here.json.diffs.length }, null, 2));
