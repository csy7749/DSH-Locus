"""Minimal `bmesh` stand-in for the bridge tests."""


class BMesh(object):
    def __init__(self):
        self.verts = []
        self.edges = []
        self.faces = []

    def to_mesh(self, mesh):
        return mesh

    def free(self):
        pass


def new():
    return BMesh()
