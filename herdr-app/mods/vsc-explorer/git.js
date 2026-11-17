import { exec } from "herdr";

const outsideRepository = r => r.code === 128 && /^fatal: not a git repository (?:\(or any of the parent directories\): \.git|\(or any parent up to mount point )/m.test(r.stderr);
const failure = (action, r) => new Error(`${action}: ${r.stderr.trim() || `Git exited with code ${r.code}`}`);

export async function gitRoot(cwd, on) {
  const r = await exec("sh", ["-c", 'LC_ALL=C git --no-optional-locks -c core.fsmonitor=false rev-parse --show-toplevel'], { cwd, on });
  if (outsideRepository(r)) return null;
  if (r.code !== 0) throw failure("Git repository", r);
  return r.stdout.replace(/\r?\n$/, "");
}

// Ask Git rather than parsing patterns: this includes nested .gitignore files,
// negations, info/exclude and global excludes, and respects tracked files.
export async function withGitIgnores(entries, cwd, on) {
  const ignored = new Set();
  for (let start = 0; start < entries.length; start += 128) {
    const paths = entries.slice(start, start + 128).map(e => `./${e.name}`);
    // exec has no stdin option. Pass names as literal argv, then feed them with
    // NUL separators, so spaces, quotes, newlines and shell syntax stay literal.
    const r = await exec("sh", ["-c", 'printf "%s\\0" "$@" | LC_ALL=C git --no-optional-locks -c core.fsmonitor=false check-ignore --stdin -z', "git-ignore", ...paths], { cwd, on });
    if (outsideRepository(r)) break;
    if (r.code !== 0 && r.code !== 1) throw failure("Git ignore", r);
    for (const name of r.stdout.split("\0")) if (name) ignored.add(name);
  }
  return entries.map(e => ({ ...e, ignored: ignored.has(`./${e.name}`) }));
}
