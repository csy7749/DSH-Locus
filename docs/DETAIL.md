# dsh-locus

dsh-locus gives DeepSeek Harness three kinds of hands:

- **A Unity editor.** The agent runs C# inside the editor that already has your
  project open, reads what the console said, flips play mode, searches the asset
  database, and reads project files without you copy-pasting anything.
- **A Blender session.** The agent runs Python against `bpy` in the Blender you
  are looking at, then renders a screenshot to check the result.
- **A LaTeX toolchain.** The agent compiles a document, reads the errors and
  warnings, and gets a PDF and (optionally) an SVG of page 1.

All three are ordinary DeepSeek Harness tools, not an MCP server: they appear
next to the built-in tools and need no separate app running.

## What makes it safe to leave on

- The bridge listens on `127.0.0.1` only, on a random port, and requires a token
  that is regenerated with every app start. Finding the port means reading a file
  in your own user profile.
- Code execution is one switch: `allowExecute: false` keeps inspection, console,
  assets, play mode, screenshots and LaTeX while disabling arbitrary code.
- The Unity package is editor-only (`includePlatforms: ["Editor"]`), so nothing
  is included in a player build, and the bridge is disabled with
  **Tools → dsh-locus → Disable bridge** or by an `EditorPrefs` flag that
  survives restarts.
- File reads through `unity_asset_read` are confined to the Unity project
  directory.

## Requirements

| Piece | Requirement |
| --- | --- |
| DeepSeek Harness | a version with bundle plugins (0.1.7-rc.1 or newer) |
| Unity | 2021.3 or newer, editor only |
| Blender | 3.0 or newer |
| LaTeX | MiKTeX or TeX Live; `dvisvgm` only for SVG |

Nothing is required for the other pieces: the Unity tools work without Blender
and vice versa, and LaTeX needs no app at all.

## Getting started

1. Install the plugin and restart DSH (see the README).
2. For Unity, add `unity-package/package.json` as a local package in your
   project. For Blender, install `blender-addon/dsh_locus_bridge.py` as an
   add-on.
3. Ask the agent to run `locus_instances`. It lists every connected editor and
   Blender instance plus the LaTeX engines it found — a one-call health check.

## Typical requests

- "Open the Main scene, press play for five seconds, and tell me what the console
  printed."
- "Find every script that references `BossStateSystem` and summarise the call
  sites." (via `unity_execute` and `unity_asset_search`)
- "Make the cube in this Blender file metallic blue and render a preview."
- "Compile `paper/main.tex`, fix the undefined control sequence, and show me the
  first page."

## Choosing among several open editors

Unity tools take an optional `project` argument: a full path, a project name,
an instance key, or a pid. Without it the plugin picks the Unity project that
contains the session's working directory, then falls back to the single live
instance. When two candidates remain it refuses and lists them rather than
guessing.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `allowExecute` | `true` | Enables `unity_execute` and `blender_execute` |
| `timeoutMs` | `30000` | Deadline for ordinary bridge calls |
| `processTimeoutMs` | `120000` | Deadline for code execution, recompiles, renders, LaTeX |
| `latexEngine` | `auto` | `auto`, `xelatex`, `lualatex` or `pdflatex` |
| `svgPreview` | `true` | Default for the `svg` flag of `latex_build` |

## How it is built

```
index.js                 Cordis plugin entry: registers the tool set
src/protocol.js          newline-JSON TCP client
src/instances.js         instance discovery and selection
src/latex.js             toolchain discovery, build, log parsing
src/tools/*.js           tool definitions (Unity, Blender, LaTeX)
unity-package/           Unity editor package with the bridge (C#)
blender-addon/           Blender add-on with the bridge (Python)
scripts/                 Roslyn staging, C# compile check
test/                    Node tests, fake bridges, bpy stubs
```

The app is the server and DSH is the client, which keeps DSH free of any
native dependency and lets each app publish its own lifecycle. `docs/PROTOCOL.md`
is the normative wire contract.

## Status

Working and tested: protocol client, instance discovery and selection, LaTeX
toolchain discovery and log parsing, all tool definitions against fake bridges,
and the real Blender add-on against a stubbed `bpy` (socket server, token
handshake, main-thread scheduling, instance publish/remove).

Verified against a real Unity editor (2021.3.18f1): the package imports, the
bridge starts on the editor main thread, and `status`, `execute`,
`console`, `asset_search` and `read_asset` answer correctly. `execute` was
exercised for a value, a compile error (reported against the snippet line, not
the generated wrapper line), an uncaught exception, and an `await` — the last one
runs its continuation on the thread pool, which keeps the editor responsive while
the snippet finishes and turns a Unity API call after the `await` into Unity's
own main-thread exception instead of a freeze.

Four issues that only a real editor surfaced are fixed in the package: the Roslyn
assemblies are staged from Unity's own folder (the older set failed at runtime
with a missing `System.Memory`), the plugin `.meta` files mark the assemblies
Editor-only with reference validation off (otherwise Unity refuses them over a
`System.Runtime.CompilerServices.Unsafe` version clash in the host project), the
handshake caches `Application.dataPath` before the accept thread starts
(`get_dataPath` may only be called from the main thread), and `execute` compiles
a class and loads it with `Assembly.Load` instead of using `CSharpScript`, whose
assembly loader throws `NotImplementedException` on Unity's Mono.

Play mode, menu items and recompiles are implemented but not exercised there.
No LaTeX document has been compiled end to end on this machine, and no real
Blender session has been used.

## License

MIT. No Locus source code is included; see `NOTICE` in the package root.
