"""Minimal `mathutils` stand-in for the bridge tests."""


class Vector(object):
    def __init__(self, values=(0.0, 0.0, 0.0)):
        self.values = list(values)

    def __repr__(self):
        return "Vector({0!r})".format(tuple(self.values))


class Matrix(object):
    def __init__(self, values=None):
        self.values = values or [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]

    def __repr__(self):
        return "Matrix(4x4)"
