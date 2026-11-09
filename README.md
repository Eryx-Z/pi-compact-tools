# pi-compact-tools

Claude-style tool rows for Pi with **shell & output keyword highlighting**, **higher-contrast chrome**, **silent mode**, and **codemode summaries**. Switch between **Claude** and **Off** (Pi native) live without reloading.

**UI only:** no changes to tool execution, model input, or session records. Includes custom-tool rendering and a GitHub Dark theme.

## Install

```bash
pi install git:github.com/Eryx-Z/pi-compact-tools
```

Run `/reload` or restart Pi, then `/compact-tools` to configure. Try without installing: `pi -e git:github.com/Eryx-Z/pi-compact-tools`.

Requires Node.js 22.19+ and Pi 0.85.1+. **Pi 1.5+ recommended** for native renderer integration, keybinding hints, and styled HTML exports.

## Styles

| Style | What you see | Command |
|---|---|---|
| **Claude** (default) | Grouped exploration, `⎿` output with keyword/path highlighting, shell syntax titles, and word-level edit diffs | `/compact-tools claude` |
| **Off / Pi native** | Pi's original rows, thinking display, and working indicator | `/compact-tools off` |

Both **claude** and **off** redraw existing rows immediately, even while tools run. Only read-only exploration is grouped; commands that write or execute work keep separate rows. Legacy `"compact"` or `"codex"` values in existing config files automatically resolve to `"claude"`.

## Highlighting & Contrast

- **Shell call titles (`Bash(...)`, `PowerShell(...)`):** highlights commands, wrappers (`sudo`, `env`, `xargs`), flags, environment assignments, variables, redirects, paths, numbers, and strings using your active theme's syntax tokens.
- **Tool output:** highlights symmetric banners (`=== ... ===`, `==> ... <==`), INI/systemd sections, `Key=Value` lines, status fields, Unix/tilde paths, and status keywords (`ERROR`, `WARN`, `OK`, `active (running)`, etc.) while leaving pre-colored ANSI/OSC output intact.
- **Tuned contrast:** frame rails, `⎿` connectors, completion metadata, running indicator pulse, and codemode summary counts use higher-legibility contrast bands across dark themes.

## Silent mode

Toggle with **`Ctrl+'`** or `/silent`; use `/silent on` and `/silent off` explicitly. Silent mode hides tool rows, thinking, intermediate assistant turns, and notices while keeping the activity indicator running. Turn it off at any time to restore every row.

Set `"mode": "silent"` to start sessions with silent mode enabled.

## Codemode summaries

Completed `codemode` scripts show nested tool outcomes (`read 3 · bash 1 · edit 3 2`) using your theme's success, error, and warning colors. Reload/resume preserves summaries from persisted nested-call records on Pi 1.2+.

## Commands and controls

```text
/compact-tools                 # choose style and save scope
/compact-tools claude project  # save for this trusted project
/compact-tools claude global   # save globally
/compact-tools status          # effective settings and paths
/compact-tools off             # restore Pi's native UI live, even while streaming
```

- Click a row/group or press `Ctrl+O` (or your configured `app.tools.expand` key on Pi 1.5+) to expand/collapse.
- `Ctrl+T` cycles the thinking display (`summary -> detail -> hidden`) without changing reasoning effort.
- Choose `github-dark-pro` in Pi's `/settings` for the included theme.

## Configuration

Optional: `~/.pi/agent/compact-tools.json` or `<project>/.pi/compact-tools.json`. Trusted project settings override global settings field by field.

```json
{
  "$schema": "https://raw.githubusercontent.com/Eryx-Z/pi-compact-tools/main/schemas/compact-tools.schema.json",
  "style": "claude",
  "mode": "normal",
  "tools": ["read", "write", "edit", "bash"],
  "custom_tools": { "enabled": true, "exclude": [] }
}
```

Add tool names to `custom_tools.exclude` to keep their own rendering. All options are described in `schemas/compact-tools.schema.json`.

## License

MIT (forked from Dong Hyeong Lee's `pi-compact-tools`).
