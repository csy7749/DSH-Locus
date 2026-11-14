# dsh-locus

Unity, Blender and LaTeX tools for **DeepSeek Harness**, so an agent can work
inside the tools you already have open instead of guessing from files on disk.

| Area | What the agent can do |
| --- | --- |
| Unity | Run C# in the open editor, read the console, drive play mode, search assets, read project files, run menu items, trigger a recompile |
| Blender | Run Python against `bpy` in the running Blender, report scene state, render a screenshot |
| LaTeX | Compile a `.tex` document to PDF (and page 1 to SVG), with parsed errors and warnings |

Inspired by [Locus](https://github.com/r1n7aro/Locus). This is an independent
DSH plugin implementation of the Unity, Blender and LaTeX integration idea,
not an official Locus release. Like Locus, it is licensed under GPL-3.0-or-later.

Nothing here needs the Locus desktop app. The plugin talks to a small bridge
that runs inside Unity and Blender respectively.

## Tools

| Tool | Purpose |
| --- | --- |
| `unity_status` | Editor version, project, active scene, play mode, compile state |
| `unity_execute` | Run C# in the editor (compiled with Roslyn, run on the main thread) |
| `unity_console` | Recent console entries, filtered by severity |
| `unity_playmode` | `play` / `pause` / `stop` |
| `unity_asset_search` | Search `AssetDatabase` by text, type and folder |
| `unity_asset_read` | Read a project file as text (binary as base64) |
| `unity_menu` | Execute a menu item by path |
| `unity_recompile` | Request a script recompilation |
| `blender_status` | Version, open file, scene, object count, selection |
| `blender_execute` | Run Python with `bpy`, `bmesh`, `mathutils` preloaded |
| `blender_screenshot` | Render the current scene to a PNG |
| `latex_build` | Compile `.tex` to PDF, optionally convert page 1 to SVG |
| `latex_status` | Which engines and `dvisvgm` are installed |
| `locus_instances` | List connected Unity/Blender instances and the LaTeX toolchain |

## Install

### 1. The DSH plugin

In the GUI: **Plugins → Add plugin**, then choose this directory (or paste its
absolute path). Fully restart DSH so the bundle is loaded and the tools appear.

From the command line, with DSH fully quit:

```sh
dsh plugin --profile desktop add /absolute/path/to/dsh-locus
```

Requirements: Node 22.8 or newer — the plugin itself uses nothing but Node's
standard library and the Cordis `context` the host passes in.

### 2. Unity bridge (per project)

1. Run `node scripts/sync-roslyn.mjs` once to stage the Roslyn assemblies into
   `unity-package/Editor/Roslyn/` (they are not committed). It takes them from
   the newest Unity editor it can find, which keeps them version-matched with
   the Mono the editor loads.
2. In Unity: **Window → Package Manager → + → Add package from disk…** and pick
   `unity-package/package.json`. Or copy the folder yourself:
   `node scripts/install-unity-package.mjs --project <path-to-Unity-project>`,
   which also resolves assembly clashes with DLLs the project already ships.
3. Keep the editor open. The bridge starts automatically; check
   **Tools → dsh-locus → Show bridge status**.

Requirements: Unity 2021.3 or newer (editor-only; nothing ships in builds).

### 3. Blender bridge (optional)

**Edit → Preferences → Add-ons → Install…**, pick
`blender-addon/dsh_locus_bridge.py`, then enable **dsh-locus bridge**. The
bridge starts with Blender; a `dsh-locus` tab appears in the 3D Viewport
sidebar with start/stop buttons.

### 4. LaTeX (optional)

Install MiKTeX or TeX Live and make sure `xelatex` (or `lualatex`/`pdflatex`)
is on `PATH`. `dvisvgm` is only needed for SVG previews. Use `latex_status` to
verify.

## Configuration

The bundle inserts one row into `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-locus
      name: dsh-locus
      config:
        allowExecute: true        # false disables unity_execute / blender_execute
        timeoutMs: 30000          # ordinary bridge calls
        processTimeoutMs: 120000  # code execution, recompiles, renders, LaTeX
        latexEngine: auto         # auto | xelatex | lualatex | pdflatex
        svgPreview: true          # default for latex_build's svg flag
```

Edit those values in your profile's `cordis.patch.yml` and restart DSH.

## How it works

The app runs a bridge; DSH connects to it. Both sides speak newline-delimited
JSON over a loopback TCP socket, authenticated with a random per-process token
that is published in an instance file under the dsh-locus state directory
(`%LOCALAPPDATA%\dsh-locus\instances` on Windows). The full contract, including
error codes and every method, is in [docs/PROTOCOL.md](docs/PROTOCOL.md).

Choosing a Unity instance: the plugin reads `unity_status` candidates from the
instance directory, prefers a Unity project that contains the session's working
directory, and falls back to the only live instance. Pass `project` to any
Unity tool to disambiguate by full path, project name, instance key or pid.

## Tests

```sh
npm test                      # 38 tests: plugin entry, protocol, discovery, LaTeX, tools, Blender bridge
node scripts/sync-roslyn.mjs  # stage Roslyn, needed by the C# checks below
node scripts/check-csharp.mjs # compile the Unity scripts against API stubs
node scripts/check-csharp.mjs --unity  # compile them against a real Unity install
npm run verify:host           # mount the plugin on the harness's real Cordis + validators
```

The test suite drives the real Blender add-on against a stubbed `bpy`, so the
socket server, token handshake, main-thread scheduling and instance lifecycle
are all exercised without Blender installed. Those two tests need a Python
interpreter (`PYTHON` overrides the default, which is `python` then `python3`
then `py`) and are skipped when none is found. `npm test` runs every file in one
process (`--test-isolation=none`) by design: the suite starts real sockets and a
Python child, which a per-file fork cannot do under a restrictive sandbox. If you
invoke `node --test` yourself, keep `--test-isolation=none --test-force-exit`.

`verify-host.mjs` is the check that the mock-based tests cannot give you: it
unpacks `@deepseek-ai/cordis` and `@deepseek-ai/dsh-tools` from the installed
harness's `app.asar`, mounts `dsh-locus` on that real Cordis instance, disposes
it again, and runs every tool schema through the host's own
`assertSupportedJsonSchema` / `projectToolSchema` / `validateJsonSchemaValue`.
It skips cleanly on machines without DeepSeek Harness; pass `--asar <path>` if
the archive is somewhere unusual.

## Limitations

- **Blender and LaTeX are verified without the real application.** The Blender
  add-on is exercised against a stubbed `bpy` (socket server, token handshake,
  main-thread scheduling, instance lifecycle), and the LaTeX path is covered for
  the missing-engine case and log parsing; a real Blender session and a real
  `xelatex` run are still untested here.
- **Unity is verified against one real project** (Unity 2021.3.18f1):
  `unity_status`, `unity_execute`, `unity_console`, `unity_asset_search`
  and `unity_asset_read` were exercised end to end, along with entering/leaving
  play mode, reconnecting after reload, and requesting recompilation. Menu items
  have not been exercised on that project.
- `unity_execute` compiles the snippet with Roslyn and runs it **on the editor
  main thread**, which is what lets it call Unity APIs; a script that blocks
  freezes the editor until it returns. Use `return` for the result — there is no
  trailing-expression handling. `await` works, but the continuation resumes on
  the thread pool. APIs requiring the main thread, such as Application.dataPath,
  raise Unity's main-thread error there. The editor still waits for completion;
  this fix avoids a context deadlock, not blocking from long-running snippets.
- `unity_execute` runs arbitrary C# in your editor, and `blender_execute`
  arbitrary Python. Set `allowExecute: false` if you want the rest of the tools
  without that power.
- Windows, macOS and Linux are supported by the socket protocol, but only
  Windows was exercised here.

## License

GPL-3.0-or-later, following [Locus](https://github.com/r1n7aro/Locus).
Independent implementation: no Locus source code is included. The
staged Roslyn assemblies are Microsoft's MIT-licensed build — see
[NOTICE](NOTICE).
