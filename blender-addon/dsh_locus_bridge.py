# SPDX-License-Identifier: MIT
"""dsh-locus bridge for Blender.

Exposes a running Blender to the dsh-locus DSH plugin over a loopback TCP
socket. The wire contract is described in docs/PROTOCOL.md; this add-on and the
Unity package implement the same envelope.

Design notes
------------
* A background thread owns the listening socket and reads requests.
* Requests execute only from a ``bpy.app.timers`` callback, so every line of
  user code runs on Blender's main thread with ``bpy`` in a valid state.
* Each connection authenticates with a random token before any work happens.
  The token and port are published in a JSON instance file under the dsh-locus
  state directory, exactly like the Unity package does.

Install: Preferences > Add-ons > Install, pick this file, then enable
"dsh-locus bridge". The 3D Viewport sidebar (N panel) gains a "dsh-locus" tab.
"""

bl_info = {
    "name": "dsh-locus bridge",
    "author": "dsh-locus contributors",
    "version": (0, 1, 0),
    "blender": (3, 0, 0),
    "location": "3D Viewport > Sidebar > dsh-locus",
    "description": "Lets the dsh-locus DSH plugin run Python in this Blender session",
    "category": "Development",
}

import ast
import contextlib
import hashlib
import io
import json
import math
import os
import queue
import secrets
import socket
import sys
import threading
import time
import traceback

import bpy
import bmesh
import mathutils

try:  # Blender 2.8+ has app.version_string; older builds only expose version.
    _BLENDER_VERSION = bpy.app.version_string
except AttributeError:  # pragma: no cover - very old builds
    _BLENDER_VERSION = ".".join(str(part) for part in bpy.app.version)

APP = "blender"
MAX_LINE_BYTES = 16 * 1024 * 1024
TICK_SECONDS = 0.05
DEFAULT_OUTPUT_LIMIT = 8_000


# --------------------------------------------------------------------------- #
# Paths and identity (must match src/paths.js and src/instances.js)
# --------------------------------------------------------------------------- #

def state_dir():
    """Platform state directory shared with the DSH plugin."""
    override = os.environ.get("DSH_LOCUS_STATE")
    if override:
        return override
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
        return os.path.join(base, "dsh-locus")
    if sys.platform == "darwin":
        return os.path.join(os.path.expanduser("~"), "Library", "Application Support", "dsh-locus")
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state")
    return os.path.join(base, "dsh-locus")


def instances_dir():
    return os.path.join(state_dir(), "instances")


def captures_dir():
    return os.path.join(state_dir(), "captures")


def normalize_project_path(value):
    """Canonical form of a path; the Unity package applies the same rules."""
    text = (value or "").strip()
    if text.startswith("\\\\?\\"):
        text = text[4:]
    text = text.replace("/", "\\").rstrip("\\")
    return text.lower()


def instance_key(project_path):
    """First 16 hex characters of the SHA-256 of the normalized path."""
    return hashlib.sha256(normalize_project_path(project_path).encode("utf-8")).hexdigest()[:16]


def write_json_atomic(path, payload):
    """Write JSON so a reader never observes a half-written file."""
    directory = os.path.dirname(path)
    os.makedirs(directory, exist_ok=True)
    temporary = "{0}.{1}.tmp".format(path, os.getpid())
    with open(temporary, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False)
    os.replace(temporary, path)


def _pid_alive(pid):
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    if sys.platform == "win32":
        # On Windows os.kill(pid, 0) raises for dead pids; this is enough here.
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


# --------------------------------------------------------------------------- #
# Request plumbing
# --------------------------------------------------------------------------- #

class BridgeError(Exception):
    """A protocol-visible failure."""

    def __init__(self, code, message, detail=None):
        Exception.__init__(self, message)
        self.code = code
        self.message = message
        self.detail = detail


class _Job(object):
    """One request waiting for the main thread."""

    __slots__ = ("request_id", "method", "args", "connection")

    def __init__(self, request_id, method, args, connection):
        self.request_id = request_id
        self.method = method
        self.args = args
        self.connection = connection


def _success(request_id, result):
    return {"id": request_id, "ok": True, "result": result}


def _failure(request_id, code, message, detail=None):
    error = {"code": code, "message": message}
    if detail is not None:
        error["detail"] = detail
    return {"id": request_id, "ok": False, "error": error}


def _describe(value, limit=DEFAULT_OUTPUT_LIMIT):
    """Render an arbitrary Python value as the string the plugin displays."""
    if value is None:
        return None
    if isinstance(value, str):
        text = value
    else:
        try:
            text = repr(value)
        except Exception:  # a hostile __repr__ must not break the bridge
            text = "<unrepresentable {0}>".format(type(value).__name__)
    if len(text) > limit:
        text = text[:limit] + u"… [{0} more characters omitted]".format(len(text) - limit)
    return text


class _StdoutCapture(io.StringIO):
    """StringIO that also mirrors writes to Blender's real stdout when asked."""

    def __init__(self, mirror=None):
        io.StringIO.__init__(self)
        self._mirror = mirror

    def write(self, text):
        if self._mirror is not None:
            self._mirror.write(text)
        return io.StringIO.write(self, text)


# --------------------------------------------------------------------------- #
# Main-thread handlers
# --------------------------------------------------------------------------- #

def _active_object_name():
    obj = getattr(bpy.context, "active_object", None)
    return obj.name if obj is not None else None


def _selected_names():
    try:
        return [obj.name for obj in bpy.context.selected_objects]
    except (AttributeError, RuntimeError):
        return []


def handle_status():
    scene = getattr(bpy.context, "scene", None)
    payload = {
        "app": APP,
        "blenderVersion": _BLENDER_VERSION,
        "file": bpy.data.filepath or None,
        "fileIsSaved": bool(bpy.data.filepath),
        "scene": scene.name if scene else None,
        "objectCount": len(bpy.data.objects),
        "collectionCount": len(bpy.data.collections),
        "mode": getattr(bpy.context, "mode", "UNKNOWN"),
        "activeObject": _active_object_name(),
        "selected": _selected_names(),
        "pid": os.getpid(),
        "isBackground": bool(bpy.app.background),
        "capabilities": ["status", "execute", "screenshot"],
        "startedAt": _STARTED_AT,
    }
    if scene is not None:
        payload["render"] = {
            "engine": scene.render.engine,
            "resolution": [
                scene.render.resolution_x * max(1, scene.render.resolution_percentage) // 100,
                scene.render.resolution_y * max(1, scene.render.resolution_percentage) // 100,
            ],
            "camera": scene.camera.name if scene.camera else None,
        }
    return payload


def handle_execute(args):
    code = args.get("code")
    if not isinstance(code, str) or not code.strip():
        raise BridgeError("BAD_REQUEST", "code must be a non-empty string.")
    started = time.monotonic()
    namespace = {
        "__name__": "__dsh_locus__",
        "__file__": "<dsh-locus>",
        "bpy": bpy,
        "bmesh": bmesh,
        "mathutils": mathutils,
        "math": math,
        "os": os,
    }
    buffer = _StdoutCapture(mirror=None)
    result = None
    try:
        with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
            tree = ast.parse(code, "<dsh-locus>", "exec")
            body = tree.body
            trailing = None
            if body and isinstance(body[-1], ast.Expr):
                trailing = body[-1]
                body = body[:-1]
            if body:
                module = ast.Module(body=body, type_ignores=[])
                exec(compile(module, "<dsh-locus>", "exec"), namespace)
            if trailing is not None:
                expression = ast.Expression(body=trailing.value)
                result = eval(compile(expression, "<dsh-locus>", "eval"), namespace)
    except SyntaxError as error:
        raise BridgeError(
            "EXECUTION_ERROR",
            "SyntaxError: {0}".format(error.msg),
            {"line": error.lineno, "offset": error.offset, "output": buffer.getvalue().splitlines()},
        )
    except Exception as error:  # user code raised; report without killing the bridge
        raise BridgeError(
            "EXECUTION_ERROR",
            "{0}: {1}".format(type(error).__name__, error),
            {"traceback": traceback.format_exc(), "output": buffer.getvalue().splitlines()},
        )
    output = buffer.getvalue().splitlines()
    duration = int((time.monotonic() - started) * 1000)
    payload = {
        "compiled": True,
        "output": output,
        "durationMs": duration,
    }
    described = _describe(result)
    if described is not None:
        payload["result"] = described
    return payload


def handle_screenshot(args):
    target = args.get("path")
    if not isinstance(target, str) or not target.strip():
        stamp = time.strftime("%Y%m%d-%H%M%S")
        target = os.path.join(captures_dir(), "blender-{0}.png".format(stamp))
    target = os.path.abspath(os.path.expanduser(target))
    if not target.lower().endswith(".png"):
        target += ".png"
    os.makedirs(os.path.dirname(target), exist_ok=True)

    scene = bpy.context.scene
    previous_path = scene.render.filepath
    previous_format = scene.render.image_settings.file_format
    try:
        scene.render.image_settings.file_format = "PNG"
        scene.render.filepath = target
        bpy.ops.render.render(write_still=True)
    finally:
        scene.render.filepath = previous_path
        scene.render.image_settings.file_format = previous_format

    percentage = max(1, scene.render.resolution_percentage)
    return {
        "path": target,
        "width": scene.render.resolution_x * percentage // 100,
        "height": scene.render.resolution_y * percentage // 100,
        "engine": scene.render.engine,
    }


HANDLERS = {
    "status": lambda args: handle_status(),
    "execute": handle_execute,
    "screenshot": handle_screenshot,
}


# --------------------------------------------------------------------------- #
# Bridge server
# --------------------------------------------------------------------------- #

class LocusBridge(object):
    """Loopback TCP server; requests hop to the main thread through a timer."""

    def __init__(self):
        self.token = secrets.token_hex(16)
        self.port = 0
        self._socket = None
        self._thread = None
        self._running = False
        self._jobs = queue.Queue()
        self._instance_file = None
        self._published_path = None
        self._published_key = None

    # -- lifecycle ---------------------------------------------------------

    def start(self):
        if self._running:
            return
        self._socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._socket.bind(("127.0.0.1", 0))
        self._socket.listen(8)
        self.port = self._socket.getsockname()[1]
        self._running = True
        self._thread = threading.Thread(target=self._accept_loop, name="dsh-locus-accept")
        self._thread.daemon = True
        self._thread.start()
        _publish_instance()
        if not bpy.app.timers.is_registered(_pump):
            bpy.app.timers.register(_pump, first_interval=TICK_SECONDS, persistent=True)

    def stop(self):
        if not self._running:
            _remove_instance()
            return
        self._running = False
        try:
            if self._socket is not None:
                self._socket.close()
        except OSError:
            pass
        self._socket = None
        if bpy.app.timers.is_registered(_pump):
            try:
                bpy.app.timers.unregister(_pump)
            except ValueError:
                pass
        _remove_instance()
        _clear_queue(self._jobs)

    @property
    def running(self):
        return self._running

    # -- networking --------------------------------------------------------

    def _accept_loop(self):
        while self._running:
            try:
                connection, _address = self._socket.accept()
            except (OSError, AttributeError):
                return
            thread = threading.Thread(target=self._serve, args=(connection,), name="dsh-locus-client")
            thread.daemon = True
            thread.start()

    def _serve(self, connection):
        connection.settimeout(None)
        authenticated = False
        stream = connection.makefile("rb")
        try:
            while self._running:
                line = stream.readline(MAX_LINE_BYTES + 1)
                if not line:
                    return
                if len(line) > MAX_LINE_BYTES:
                    self._send(connection, _failure("?", "BAD_REQUEST", "Request line exceeds the 16 MiB limit."))
                    return
                text = line.decode("utf-8", "replace").strip()
                if not text:
                    continue
                try:
                    request = json.loads(text)
                except ValueError as error:
                    self._send(connection, _failure("?", "BAD_REQUEST", "Malformed JSON: {0}".format(error)))
                    continue
                if not isinstance(request, dict):
                    self._send(connection, _failure("?", "BAD_REQUEST", "A request must be a JSON object."))
                    continue

                request_id = str(request.get("id", "?"))
                method = request.get("method")
                args = request.get("args") or {}
                if not isinstance(args, dict):
                    args = {}
                if not isinstance(method, str):
                    self._send(connection, _failure(request_id, "BAD_REQUEST", "Every request needs a string \"method\"."))
                    continue

                if method == "hello":
                    if args.get("token") != self.token:
                        self._send(connection, _failure(
                            request_id,
                            "AUTH_REQUIRED",
                            "Invalid instance token. Re-read the instance file in the dsh-locus state directory.",
                        ))
                        return
                    authenticated = True
                    self._send(connection, _success(request_id, self._hello_payload()))
                    continue

                if not authenticated:
                    self._send(connection, _failure(
                        request_id, "AUTH_REQUIRED", "Send hello with the instance token before any other method.",
                    ))
                    return

                self._jobs.put(_Job(request_id, method, args, connection))
        except (OSError, ValueError):
            pass
        finally:
            try:
                stream.close()
            except (OSError, ValueError):
                pass
            try:
                connection.close()
            except OSError:
                pass

    def _send(self, connection, payload):
        try:
            connection.sendall((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        except (OSError, ValueError):
            pass

    def _hello_payload(self):
        status = handle_status()
        return {
            "app": APP,
            "pid": os.getpid(),
            "version": _BLENDER_VERSION,
            "file": status["file"],
            "blenderVersion": _BLENDER_VERSION,
            "capabilities": status["capabilities"],
        }

    # -- main-thread pump --------------------------------------------------

    def pump(self):
        """Drain queued requests; returns the next timer interval."""
        if not self._running:
            return None
        self._refresh_instance()
        budget = 4
        while budget > 0:
            budget -= 1
            try:
                job = self._jobs.get_nowait()
            except queue.Empty:
                break
            self._run(job)
        return TICK_SECONDS

    def _run(self, job):
        try:
            handler = HANDLERS.get(job.method)
            if handler is None:
                raise BridgeError(
                    "UNKNOWN_METHOD",
                    "Unknown method \"{0}\". This bridge supports: {1}.".format(job.method, ", ".join(sorted(HANDLERS))),
                )
            payload = _success(job.request_id, handler(job.args))
        except BridgeError as error:
            payload = _failure(job.request_id, error.code, error.message, error.detail)
        except Exception as error:  # never let one request kill the timer
            payload = _failure(
                job.request_id,
                "EXECUTION_ERROR",
                "{0}: {1}".format(type(error).__name__, error),
                {"traceback": traceback.format_exc()},
            )
        self._send(job.connection, payload)

    # -- instance publication ---------------------------------------------

    def _refresh_instance(self):
        """Re-publish when the user opens or saves a different .blend file."""
        current = bpy.data.filepath or ""
        if current == self._published_path:
            return
        try:
            _publish_instance()
        except OSError:
            pass


_BRIDGE = None
_STARTED_AT = int(time.time() * 1000)


def _pump():
    global _BRIDGE
    if _BRIDGE is None:
        return None
    return _BRIDGE.pump()


def _publish_instance():
    """Write the instance file other processes read to find this Blender."""
    global _BRIDGE
    if _BRIDGE is None:
        return
    target = bpy.data.filepath or ""
    key = instance_key(target) if target else "unsaved"
    record = {
        "app": APP,
        "key": key,
        "pid": os.getpid(),
        "port": _BRIDGE.port,
        "token": _BRIDGE.token,
        "projectPath": target or None,
        "projectName": os.path.splitext(os.path.basename(target))[0] if target else "Unsaved",
        "version": _BLENDER_VERSION,
        "startedAt": _STARTED_AT,
    }
    directory = instances_dir()
    os.makedirs(directory, exist_ok=True)
    for name in os.listdir(directory):
        if not name.startswith("blender-") or not name.endswith(".json"):
            continue
        path = os.path.join(directory, name)
        if name == "blender-{0}.json".format(os.getpid()):
            continue
        try:
            with open(path, "r", encoding="utf-8") as handle:
                other = json.load(handle)
        except (OSError, ValueError):
            other = None
        if not other or not _pid_alive(other.get("pid")):
            try:
                os.remove(path)
            except OSError:
                pass
    filename = os.path.join(directory, "blender-{0}.json".format(os.getpid()))
    write_json_atomic(filename, record)
    _BRIDGE._instance_file = filename
    _BRIDGE._published_path = target
    _BRIDGE._published_key = key


def _remove_instance():
    global _BRIDGE
    if _BRIDGE is None:
        return
    filename = _BRIDGE._instance_file
    if filename:
        try:
            os.remove(filename)
        except OSError:
            pass
    _BRIDGE._instance_file = None


def _clear_queue(jobs):
    while True:
        try:
            jobs.get_nowait()
        except queue.Empty:
            return


# --------------------------------------------------------------------------- #
# Add-on UI
# --------------------------------------------------------------------------- #

class DSHLOCUS_OT_start(bpy.types.Operator):
    bl_idname = "dsh_locus.start_bridge"
    bl_label = "Start dsh-locus bridge"
    bl_description = "Open the loopback bridge the dsh-locus DSH plugin talks to"

    def execute(self, context):
        global _BRIDGE
        if _BRIDGE is None:
            _BRIDGE = LocusBridge()
        _BRIDGE.start()
        self.report({"INFO"}, "dsh-locus bridge listening on 127.0.0.1:{0}".format(_BRIDGE.port))
        return {"FINISHED"}


class DSHLOCUS_OT_stop(bpy.types.Operator):
    bl_idname = "dsh_locus.stop_bridge"
    bl_label = "Stop dsh-locus bridge"
    bl_description = "Close the bridge and remove the instance file"

    def execute(self, context):
        if _BRIDGE is not None:
            _BRIDGE.stop()
        self.report({"INFO"}, "dsh-locus bridge stopped")
        return {"FINISHED"}


class DSHLOCUS_PT_panel(bpy.types.Panel):
    bl_idname = "DSHLOCUS_PT_panel"
    bl_label = "dsh-locus"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "dsh-locus"

    def draw(self, context):
        layout = self.layout
        bridge = _BRIDGE
        if bridge is not None and bridge.running:
            layout.label(text="Listening on 127.0.0.1:{0}".format(bridge.port), icon="CHECKMARK")
            layout.label(text="File: {0}".format(bpy.data.filepath or "(unsaved)"))
            layout.operator("dsh_locus.stop_bridge", icon="PAUSE")
        else:
            layout.label(text="Bridge stopped", icon="INFO")
            layout.operator("dsh_locus.start_bridge", icon="PLAY")
        layout.separator()
        layout.label(text="Tools are exposed by the DSH plugin", icon="INFO")


_CLASSES = (DSHLOCUS_OT_start, DSHLOCUS_OT_stop, DSHLOCUS_PT_panel)


def register():
    global _BRIDGE
    for cls in _CLASSES:
        bpy.utils.register_class(cls)
    _BRIDGE = LocusBridge()
    _BRIDGE.start()


def unregister():
    global _BRIDGE
    if _BRIDGE is not None:
        _BRIDGE.stop()
        _BRIDGE = None
    for cls in reversed(_CLASSES):
        bpy.utils.unregister_class(cls)


if __name__ == "__main__":
    register()
