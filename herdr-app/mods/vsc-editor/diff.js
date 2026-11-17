import { div } from "gpui-kit";
import { h_flex, v_flex, v_virtual_list, Scrollbar } from "gpui-base";
import { exec, readTextFile, settings } from "herdr";

const READ = ["--literal-pathspecs", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const MAX_ROWS = 1500, MAX_LINE = 4000;
const untab = text => text.replace(/[^\t]*\t/g, s => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

export function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map(line => {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (match) { old = +match[1]; next = +match[2]; return { kind: "@", text: line }; }
    const kind = line[0];
    if (kind === "-") return { kind, old: old++, text: untab(line.slice(1)) || " " };
    if (kind === "+") return { kind, next: next++, text: untab(line.slice(1)) || " " };
    if (kind === " ") return { kind, old: old++, next: next++, text: untab(line.slice(1)) || " " };
    return { kind: "", text: line };
  });
}

// Read the current worktree against HEAD, including staged and unstaged changes.
// Status is read again so an untracked file committed after opening is not stale.
export async function readDiff(file) {
  const options = { cwd: file.root, on: file.on };
  const git = async args => {
    const result = await exec("git", [...READ, ...args], options);
    if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || `git exited ${result.code}`);
    return result.stdout;
  };
  const status = await git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--", file.relativePath]);
  if (!status) return { rows: [], message: "No uncommitted changes" };
  const head = await exec("git", [...READ, "rev-parse", "--verify", "--quiet", "HEAD"], options);
  if (head.code !== 0 && head.code !== 1) throw new Error(head.stderr.trim() || `Cannot read HEAD (exit ${head.code})`);
  let lines;
  if (status.startsWith("??") || (head.code === 1 && status.slice(0, 2).includes("A"))) {
    const text = await readTextFile(file.sourcePath, { on: file.on });
    if (text === null) throw new Error("File is unavailable, unreadable, or exceeds the 1 MiB text limit");
    if (text.includes("\0")) return { rows: [], message: "Binary file · no text diff" };
    const content = text ? text.replace(/\n$/, "").split("\n") : [];
    lines = [`@@ -0,0 +1,${content.length} @@`, ...content.map(line => `+${line}`)];
    if (text && !text.endsWith("\n")) lines.push("\\ No newline at end of file");
  } else {
    const output = await git(["diff", ...(head.code === 0 ? ["HEAD"] : ["--cached"]), "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--", file.relativePath]);
    if (/^Binary files .* differ$/m.test(output)) return { rows: [], message: "Binary file changed · no text diff" };
    const all = output.replace(/\n$/, "").split("\n"), first = all.findIndex(line => line.startsWith("@@"));
    if (first < 0) return { rows: [], message: output.trim() || "No text diff available" };
    lines = all.slice(first);
  }
  const limited = lines.length > MAX_ROWS || lines.some(line => line.length > MAX_LINE);
  return { rows: diffRows(lines.slice(0, MAX_ROWS).map(line => line.length > MAX_LINE ? line.slice(0, MAX_LINE) + "… (line truncated)" : line)),
    limited, message: null };
}

export class GitDiff {
  constructor(file) { this.file = file; this.rows = []; this.width = 300; this.loading = false; }

  refresh(cx) {
    if (this.loading) { this.again = true; return; }
    this.loading = true;
    cx.spawn(async cx => {
      try {
        const result = await readDiff(this.file);
        this.rows = result.rows; this.message = result.message; this.limited = result.limited; this.error = null;
        this.width = Math.max(300, ...this.rows.map(row => Array.from(row.text).reduce((n, char) => n + (char.charCodeAt(0) > 255 ? 2 : 1), 0) * 8.5 + 140));
      } catch (error) {
        this.rows = []; this.limited = false; this.error = `Cannot load diff: ${error.message ?? error}`;
      } finally {
        this.loading = false;
        if (this.again) { this.again = false; this.refresh(cx); }
        cx.notify();
      }
    });
  }

  row({ kind, old, next, text }, t) {
    if (kind === "@") return div().h(22).px(12).w_full().whitespace_nowrap().bg(t.raised).text_color(t.muted).child(text);
    const number = value => div().w(44).flex_none().text_right().text_color(t.dim).child(value === undefined ? "" : String(value));
    return h_flex().h(22).w_full().whitespace_nowrap().gap(8).items_center()
      .when(kind === "+", el => el.bg(t.ansi2 + "18"))
      .when(kind === "-", el => el.bg(t.ansi1 + "18"))
      .child(number(old)).child(number(next))
      .child(div().w(10).flex_none().text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim).child(kind === "+" || kind === "-" ? kind : ""))
      .child(div().flex_1().min_w(0).whitespace_nowrap().child(text));
  }

  render(t) {
    const id = this.file.path;
    return v_flex().flex_1().min_h(0)
      .child(h_flex().h(30).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.muted)
        .child(div().flex_1().min_w(0).truncate().tooltip(`${this.file.on ?? "本机"} · ${this.file.sourcePath}`)
          .child(`${this.file.on ?? "本机"} · HEAD → Working tree · Read only`))
        .child(div().id(`refresh-${id}`).px(8).h(24).flex().items_center().cursor_pointer().hover(s => s.bg(t.hover))
          .on_click((_e, cx) => this.refresh(cx)).child(this.loading ? "Loading…" : "Refresh")))
      .when(Boolean(this.limited), el => el.child(div().px(12).py(4).text_size(11).text_color(t.blocked).child("Diff preview limited to 1,500 lines and 4,000 characters per line")))
      .child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(13)
        .child(div().id(`diff-x-${id}`).size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.width).h_full()
            .child(v_virtual_list(`diff-${id}`, this.rows.length, 22, i => String(i),
              range => this.rows.slice(range.start, range.end).map(row => this.row(row, t))).size_full())))
        .child(Scrollbar.vertical(`diff-${id}`).viewport_from_layout().absolute().inset_0())
        .when(!this.rows.length, el => el.child(div().absolute().inset_0().p(16).text_color(this.error ? t.ansi1 : t.dim)
          .child(this.error ?? (this.loading ? "Loading diff…" : this.message ?? "No text diff available")))));
  }
}
