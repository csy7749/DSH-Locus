"""Minimal stand-in for Blender's `bpy` module, used only by the tests.

It implements exactly the surface blender-addon/dsh_locus_bridge.py touches so
the bridge can be exercised without a Blender install.
"""

import os
import sys
import time


class _Timers(object):
    """Blessed-enough timer queue: register, unregister, is_registered."""

    def __init__(self):
        self._entries = {}

    def register(self, function, first_interval=0.0, persistent=False):
        self._entries[function] = time.time() + float(first_interval or 0.0)
        return None

    def is_registered(self, function):
        return function in self._entries

    def unregister(self, function):
        if function not in self._entries:
            raise ValueError("timer is not registered")
        del self._entries[function]

    def tick(self):
        """Run every timer that is due; callbacks return their next interval."""
        for function, due in list(self._entries.items()):
            if due > time.time():
                continue
            interval = function()
            if interval is None:
                self._entries.pop(function, None)
            else:
                self._entries[function] = time.time() + float(interval)


class _App(object):
    version_string = "4.2.0"
    version = (4, 2, 0)
    background = False
    timers = _Timers()


class _ImageSettings(object):
    file_format = "PNG"


class _Render(object):
    engine = "BLENDER_EEVEE_NEXT"
    resolution_x = 1920
    resolution_y = 1080
    resolution_percentage = 50
    filepath = ""
    image_settings = _ImageSettings()


class _Scene(object):
    name = "Scene"
    render = _Render()
    camera = None


class _Camera(object):
    name = "Camera"


class _DataObjects(object):
    def __init__(self):
        self._items = {}

    def __len__(self):
        return len(self._items)

    def __iter__(self):
        return iter(self._items.values())

    def add(self, name):
        self._items[name] = name


class _DataCollections(object):
    def __len__(self):
        return 1


class _Data(object):
    filepath = ""
    objects = _DataObjects()
    collections = _DataCollections()


class _Context(object):
    scene = _Scene()
    mode = "OBJECT"
    active_object = _Camera()
    selected_objects = []


class _OpRender(object):
    def render(self, write_still=False):
        target = context.scene.render.filepath
        if write_still and target:
            directory = os.path.dirname(target)
            if directory:
                os.makedirs(directory, exist_ok=True)
            with open(target, "wb") as handle:
                handle.write(_PNG_BYTES)
        return {"FINISHED"}


class _Ops(object):
    render = _OpRender()


class _Utils(object):
    def register_class(self, cls):
        setattr(self, cls.__name__, cls)

    def unregister_class(self, cls):
        if hasattr(self, cls.__name__):
            delattr(self, cls.__name__)


class _Types(object):
    class Operator(object):
        pass

    class Panel(object):
        pass


# Smallest valid 1x1 PNG so screenshot tests can assert a file exists.
_PNG_BYTES = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
    "890000000a49444154789c6360000000020001e221bc330000000049454e44ae"
    "426082"
)

app = _App()
data = _Data()
context = _Context()
ops = _Ops()
utils = _Utils()
types = _Types()
