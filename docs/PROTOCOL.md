# dsh-locus wire protocol (v1)

All three bridges (Unity editor package, Blender add-on, and the Node host plugin)
speak the same protocol: **newline-delimited JSON over TCP on the loopback
interface**. One JSON object per line, UTF-8, no BOM. Lines may be up to 16 MiB.

The app is always the **server**: it binds an ephemeral port on `127.0.0.1`,
generates a random token, and advertises both through an *instance file*. The
DSH plugin is the client and connects when a tool is called.

## Instance file

Location:

| OS | Directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\dsh-locus\instances` |
| macOS | `~/Library/Application Support/dsh-locus/instances` |
| Linux | `$XDG_STATE_HOME/dsh-locus/instances` (fallback `~/.local/state/dsh-locus/instances`) |

One file per running app instance, named `<key>.json`:

```json
{
  "app": "unity",
  "key": "7f3c9a1b2d4e5f60",
  "pid": 12345,
  "port": 51234,
  "token": "a6f1...e0",
  "projectPath": "C:\\Work\\MyGame",
  "projectName": "MyGame",
  "version": "2021.3.18f1",
  "startedAt": 1762992000000
}
```

`key` is `sha256(normalized path).slice(0, 16)` for Unity, where *normalized* means:
strip a `\\?\` prefix, turn `/` into `\` on Windows, drop trailing separators,
lower-case. Blender uses `blender-<pid>`. The file is written atomically
(`.tmp` + replace) before the listener starts accepting connections, and deleted
on shutdown. A client treats an instance file as stale when its `pid` is no
longer alive and removes it.

## Envelope

Request (client → app):

```json
{"id": "1", "method": "execute", "args": {"code": "EditorApplication.isPlaying"}}
```

Response (app → client):

```json
{"id": "1", "ok": true, "result": {"output": ["True"]}}
{"id": "1", "ok": false, "error": {"code": "EXECUTION_ERROR", "message": "..."}}
```

`id` is opaque and echoed verbatim. `args` is optional; `{}` when absent.
`result` is any JSON value matching the method contract below; it is omitted on
failure. Unknown top-level fields are ignored.

The first request on every connection must be `hello` carrying the token:

```json
{"id": "1", "method": "hello", "args": {"token": "a6f1...e0"}}
```

A wrong or missing token answers `AUTH_REQUIRED` and closes the connection. A
client that sends another method first gets `AUTH_REQUIRED` as well. The app
serves one request at a time per connection, in arrival order.

### Error codes

| Code | Meaning |
| --- | --- |
| `AUTH_REQUIRED` | Missing or wrong token; the connection is closed. |
| `BAD_REQUEST` | Malformed line, unknown/missing argument, or bad argument type. |
| `UNKNOWN_METHOD` | The bridge does not implement this method. |
| `NOT_READY` | The app cannot run the request now (for example, Unity is compiling). |
| `TIMEOUT` | Client-side only: no response arrived before the deadline. |
| `EXECUTION_ERROR` | The user code threw or the operation failed inside the app. |
| `UNSUPPORTED` | The capability is not available in this build (for example, no LaTeX engine). |

## Unity methods

### `hello`
Args `{token}`. Result `{app:"unity", pid, version, projectPath, projectName, capabilities:[string]}`.

### `ping`
Result `{pong: true, timeSinceStartup: number}`.

### `status`
Result:

```json
{
  "unityVersion": "2021.3.18f1",
  "projectPath": "C:\\Work\\MyGame",
  "projectName": "MyGame",
  "isPlaying": false,
  "isPaused": false,
  "isCompiling": false,
  "isUpdating": false,
  "activeScenePath": "Assets/Scenes/Main.unity",
  "activeSceneName": "Main",
  "buildTarget": "StandaloneWindows64",
  "timeSinceStartup": 12.34,
  "frameCount": 120,
  "editorPid": 12345,
  "capabilities": ["execute", "console", "playmode", "asset_search", "read_asset", "menu", "recompile"]
}
```

### `execute`
Args `{code: string, mode?: "editor" | "play"}` (default `editor`; `play` is
rejected with `NOT_READY` when the editor is not playing). Result:

```json
{
  "compiled": true,
  "output": ["hello", ""],
  "result": "42",
  "durationMs": 87
}
```

`code` is a C# script body compiled with Roslyn script semantics: no namespace
or class wrapper, `var` allowed, trailing expression becomes `result`. The
standard imports are `System`, `System.Collections.Generic`, `System.Linq`,
`System.IO`, `UnityEngine`, `UnityEditor`. `Console.Out` and
`Debug.Log`-style console output go to `output`. A compile failure is a normal
result with `compiled: false` and `errors: [{message, line, column}]`; a
runtime exception returns `ok: false` with `EXECUTION_ERROR` and
`error.detail = {type, message, stack}`.

### `console`
Args `{limit?: 1..500, level?: "all" | "log" | "warning" | "error"}`.
Result `{entries: [{index, time, level, message, stack}], total, dropped}`.
Entries are newest-last; the bridge keeps the most recent 2000.

### `playmode`
Args `{action: "play" | "pause" | "stop"}`. Result `{isPlaying, isPaused}`.
`pause` requires play mode.

### `asset_search`
Args `{query: string, folder?: string, type?: string, limit?: 1..200}`.
Result `{results: [{path, guid, type, name}], truncated}`. `query` is a plain
substring; `AssetDatabase.FindAssets(query[, folders])` semantics apply.

### `read_asset`
Args `{path: string, maxBytes?: number}` (default 131072, cap 8388608).
Result `{path, size, isText, text?, base64?, truncated}`. `isText` is true for
files whose bytes decode as UTF-8 without replacement characters.

### `menu`
Args `{path: string}` (for example `"Assets/Reimport All"`).
Result `{executed: boolean}`.

### `recompile`
Result `{requested: true}`.

## Blender methods

### `hello`
Result `{app:"blender", pid, version, projectPath, projectName}`.

### `status`
Result `{blenderVersion, file, scene, objectCount, activeObject, selected, mode}`.

### `execute`
Args `{code: string}`. Result `{output: [string], result: string?, durationMs}`.
`code` runs in the `bpy` namespace with `bpy`, `bmesh`, `mathutils`, `math`, and
`os` pre-imported, on the main thread.

### `screenshot`
Args `{path?: string}`. Result `{path, width, height}` — the rendered image is
written to `path`, or to `<stateDir>/captures/<timestamp>.png` when omitted.

## LaTeX

LaTeX runs entirely inside the DSH host process (`execFile`, argv arrays, no
shell); there is no bridge and no instance file.
