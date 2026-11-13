"""Run the dsh-locus Blender add-on against the stub bpy module (tests only).

The bridge only executes user code from a bpy timer callback, so this harness
drives the stub timer queue from the main thread exactly like Blender would.
"""

import importlib.util
import os
import signal
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
STUB = os.path.join(HERE, "blender_stub")
ADDON = os.path.join(ROOT, "blender-addon", "dsh_locus_bridge.py")

sys.path.insert(0, STUB)

import bpy  # noqa: E402  (must come after the stub path is installed)

spec = importlib.util.spec_from_file_location("dsh_locus_bridge", ADDON)
module = importlib.util.module_from_spec(spec)
sys.modules["dsh_locus_bridge"] = module
spec.loader.exec_module(module)


def shutdown(*_args):
    try:
        module.unregister()
    finally:
        sys.exit(0)


signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)

bpy.data.objects.add("Cube")
bpy.context.scene.camera = bpy.context.active_object

module.register()
print("bridge ready on port {0}".format(module._BRIDGE.port), flush=True)

try:
    while True:
        bpy.app.timers.tick()
        time.sleep(0.02)
except (KeyboardInterrupt, SystemExit):
    shutdown()
