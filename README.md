# nevambla-code

JachinShen’s fork of [nevambla/nevambla-code](https://github.com/nevambla/nevambla-code) for [herdr](https://herdr.dev), the terminal workspace manager for AI coding agents: an editor-style desktop layout called **nevambla-code**, its panels, the Dracula colors, the JetBrainsMono Nerd Font and my terminal settings.

![nevambla-code](preview.png)

## What's inside

| Path | What it is | Installed to |
| --- | --- | --- |
| `herdr/config.toml` | terminal settings: Dracula theme, system notifications, agent labels on pane borders, agents sorted by space, symbol status indicators | `~/.config/herdr/` |
| `herdr-app/layouts/nevambla-code.json` | the desktop layout | `~/.config/herdr-app/layouts/` |
| `herdr-app/mods/vsc-*` | the layout's panels (below) | `~/.config/herdr-app/mods/` |
| `herdr-app/themes/dracula.json` | Dracula colors | `~/.config/herdr-app/themes/` |
| `herdr-app/keys.json` | the layout's shortcuts, merged into yours | `~/.config/herdr-app/keys.json` |
| `fonts/` | JetBrainsMono Nerd Font (Regular, Bold, Italic, Bold Italic) | `~/Library/Fonts` (macOS) or `~/.local/share/fonts` |

## The layout

- **Title bar:** a centered command center that opens the palette, side bar and editor toggles, and a clock.
- **Path navigation and transfers:** ⌘⇧O opens a local or remote terminal path in Explorer. The file tree’s transfer action copies a file between this computer and a registered SSH machine, or between two SSH machines. Completed transfers offer the full destination path for copying.
- **Activity bar:** switches the side bar between Explorer, Changes and Spaces. Spaces are managed in that dedicated view. An Agents button sits immediately above Settings.
- **Side bar:** the file tree of the focused pane’s folder, with room for an optional Agents panel below. Git-ignored files and folders stay browsable with dimmed names and icons, locally and over SSH. Source Control follows the folder selected in Explorer; selecting a change opens a read-only diff tab in the main editor, including staged and unstaged changes against HEAD.
- **Agents:** the bottom-left button opens or hides the full list below the current sidebar view. Hidden by default, it leaves a compact scrollable rail with a small status light at the top-right of each agent icon. Click an icon to focus that agent, including agents on SSH machines; hover for its task, space and status. The button counts agents needing attention. Hiding the list preserves its size and gives the current view the room.
- **Editor:** file tabs and an editable code view, with a second editor group to split into. It also previews Markdown and PDFs, runs Python files and runs Jupyter notebooks.
- **Nix and IC source previews:** Nix, Verilog/SystemVerilog RTL and gate netlists, Verilog-A/AMS, VHDL, SPICE/CDL and Spectre open with colored tokens and line numbers. These previews are read-only; **Edit** opens the plain-text editor, and **Preview** (⇧⌘V) highlights the current buffer, including unsaved changes. **Copy** copies the complete source. Local and SSH files use the same bundled grammars, without extra tools.
- **Terminal panel:** your herdr terminals below the editor, with 160 px tabs aligned left, a new-tab button directly after them, and split, move and maximize actions on the right. Double-click a tab to rename it; right-click for Herdr's tab menu, including Close.

## Install

```sh
brew install herdr
git clone https://github.com/JachinShen/nevambla-code.git
cd nevambla-code
./install.sh
```

Open the herdr desktop app once before running it, so `~/.config/herdr-app` exists. The installer:

- backs up anything it replaces to `~/.config/nevambla-code-backups/<time>/`
- merges the shortcuts and never replaces a key you already use (it warns instead)
- switches an open herdr window to the layout; otherwise pick **nevambla-code** in Settings → Look → Layout, or cycle with `ctrl-shift-l`

### Optional tools

- Path navigation and file transfers: `python3` locally and on each SSH machine, `hc`, and a working local SSH configuration. Transfers currently support individual regular files on Unix machines; SSH-to-SSH copies use a temporary local spool that is removed when finished.
- PDF preview: `brew install poppler`
- Notebooks: `pip install jupyter_client ipykernel` (the editor uses the project's nearest `.venv`, else `python3`)

## What the panels do on your machine

As herdr asks for shared layouts:

- **Network:** when enabled with title bar `props.show_usage: true`, the usage meter (`vsc-titlebar/usage.sh`) reads your Claude Code login from the macOS Keychain and asks `api.anthropic.com` for your plan usage, the same data as Claude Code's `/usage`. The token stays inside that script. It is macOS only; elsewhere it shows no data.
- **Programs:** path navigation and Git previews run `python3` and `git` on the selected machine through Herdr. Transfers use `hc machine ls` to resolve registered SSH targets and the local `/usr/bin/ssh` command, including the user’s SSH configuration. SSH command streams preserve the same filesystem namespace as the remote shell. Each copy checks size and SHA-256 before publication; an existing destination gets a numbered sibling. Errors remain visible. The editor runs `python3` (notebooks, through `vsc-editor/kernel.py`), `pdftoppm` / `pdfinfo` (PDFs) and `open` (Open in Preview).
- **Files:** the Explorer and editor read and save files in the folders your panes are in. Temporary file-transfer payloads are staged locally or in the destination directory, then removed. Transfer destination preferences stay in local shared state. PDF pages and notebook state are cached in `~/.config/herdr-app/data/vsc-editor/`.

## Fork development

`origin` is `JachinShen/nevambla-code`; `upstream` is `nevambla/nevambla-code`. Keep source changes under `herdr-app/` and leave Herdr’s generated API declarations, local shared state, credentials and caches out of commits.

Run the portable regressions from the checkout:

```sh
node --experimental-vm-modules --test herdr-app/mods/vsc-activity/tests/activity.test.mjs herdr-app/mods/vsc-explorer/tests/explorer.test.mjs herdr-app/mods/vsc-changes/tests/changes.test.mjs herdr-app/mods/vsc-editor/tests/diff.test.mjs herdr-app/mods/vsc-editor/tests/source.test.mjs herdr-app/mods/vsc-titlebar/tests/usage.test.mjs
python3 -B -m unittest discover -s herdr-app/mods/vsc-explorer/tests -p 'test_*.py' -k Integrity
```

The transfer suite can also exercise real registered SSH targets. It creates and removes temporary fixtures on both machines:

```sh
python3 -B herdr-app/mods/vsc-explorer/tests/test_transfer.py --machines ssh-a ssh-b
python3 -B herdr-app/mods/vsc-explorer/tests/test_download.py --machine ssh-a
```

Check each changed mod with `herdr-app check /absolute/path/to/mod`, then inspect it in the running app. Notebook dependencies are needed only when running notebook cells.

## Optional Claude usage meter

Enable the meter with `props.show_usage: true`. To choose accounts, add `props` to the title bar block in `~/.config/herdr-app/layouts/nevambla-code.json`:

```json
"content": {
  "mod": "vsc-titlebar",
  "props": {
    "show_usage": true,
    "accounts": [
      { "name": "Personal" },
      { "name": "Work", "config_dir": "~/.claude-work", "command": "claude-work" }
    ]
  }
}
```

- `name`: shown in the dropdown.
- `config_dir`: the `CLAUDE_CONFIG_DIR` that account's Claude Code uses. Leave it out for the default login.
- `command`: what you type to start it, shown as a hint. Defaults to `claude`, or the config folder's name.
- `id` (optional): key for its cached usage. Defaults to the name.

The first account is the default. Hover or click **Claude** in the title bar to see them all and pick the one to show.

## Shortcuts

| Keys | Action |
| --- | --- |
| ⌘⇧O | jump to a file or directory on the focused terminal’s machine |
| ⌘B | show or hide the side bar |
| ⌘J | show or hide the terminal panel |
| ⌘⌥J | move the terminal panel between the bottom and the right |
| ⌘⇧V | switch Markdown, Nix or IC source between editing and preview |
| ⌘⌥R | run the open Python file |
| ⌘S / ⌘W | save / close the file (in the editor) |
| ⇧↩ or ⌘↩ | run the notebook cell (in the editor) |

## Agent integrations

Integrations are not part of these files. Install the ones you use, for example `herdr integration install claude`, and see them all with `herdr integration status`.

## Uninstall

Delete `~/.config/herdr-app/layouts/nevambla-code.json` and the `~/.config/herdr-app/mods/vsc-*` folders, then switch layouts with `ctrl-shift-l`. Your backups are in `~/.config/nevambla-code-backups/`.

## Contributing

There's plenty left to improve: optimizations, new panels and features I haven't needed yet. Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), open an [upstream issue](https://github.com/nevambla/nevambla-code/issues) or start an [upstream discussion](https://github.com/nevambla/nevambla-code/discussions).

## License

The Explorer navigation arrows and activity-bar agent controls use official [Lucide 0.511.0 SVG assets](https://github.com/lucide-icons/lucide/tree/0.511.0/icons), under the accompanying ISC licenses ([Explorer](herdr-app/mods/vsc-explorer/lucide-LICENSE), [activity bar](herdr-app/mods/vsc-activity/lucide-LICENSE)).

The bundled Prism 1.30.0 tokenizer and Nix, Verilog and VHDL grammars use the [MIT license](herdr-app/mods/vsc-editor/vendor/prism-LICENSE). Circuit-netlist rules and the native preview renderer live in the editor mod.

[MIT](LICENSE). The derived `vsc-changes` mod retains its [Apache-2.0 license](herdr-app/mods/vsc-changes/LICENSE) and [attribution](herdr-app/mods/vsc-changes/NOTICE). The font is JetBrains Mono patched by [Nerd Fonts](https://www.nerdfonts.com) (v3.4.0), under the SIL Open Font License 1.1 (`fonts/OFL.txt`).
