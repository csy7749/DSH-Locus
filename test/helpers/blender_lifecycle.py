"""Exercise the add-on's register/unregister lifecycle with the stub bpy.

Results are written to a JSON file because the DSH sandbox forbids piped child
stdio; the JavaScript test polls that file.

Usage: python blender_lifecycle.py <result.json>
"""

import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
STUB = os.path.join(HERE, "blender_stub")
ADDON = os.path.join(ROOT, "blender-addon", "dsh_locus_bridge.py")


def main(argv):
    result_path = argv[1]
    sys.path.insert(0, STUB)
    import bpy  # noqa: F401  (installed by the stub path)

    spec = importlib.util.spec_from_file_location("dsh_locus_bridge", ADDON)
    module = importlib.util.module_from_spec(spec)
    sys.modules["dsh_locus_bridge"] = module
    spec.loader.exec_module(module)

    payload = {"ok": False}
    try:
        module.register()
        instance_file = os.path.join(module.instances_dir(), "blender-{0}.json".format(os.getpid()))
        payload["port"] = module._BRIDGE.port
        payload["runningAfterRegister"] = bool(module._BRIDGE.running)
        payload["instanceFile"] = instance_file
        payload["existsAfterRegister"] = os.path.exists(instance_file)
        with open(instance_file, "rb") as handle:
            payload["record"] = json.loads(handle.read().decode("utf-8"))
        payload["timerRegistered"] = bpy.app.timers.is_registered(module._pump)

        module.unregister()
        payload["runningAfterUnregister"] = bool(module._BRIDGE)
        payload["existsAfterUnregister"] = os.path.exists(instance_file)
        payload["timerAfterUnregister"] = bpy.app.timers.is_registered(module._pump)
        payload["ok"] = True
    except Exception as error:  # pragma: no cover - surfaced to the JS test
        payload["error"] = "{0}: {1}".format(type(error).__name__, error)
    finally:
        with open(result_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
