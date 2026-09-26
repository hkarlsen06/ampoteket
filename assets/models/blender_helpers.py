"""Scene helpers shared by the model generators in this directory."""

import bpy
from mathutils import Vector

model = None


def new_model(name):
    # Empty the startup scene; every part goes into one named collection.
    global model
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for coll in list(bpy.data.collections):
        bpy.data.collections.remove(coll)
    model = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(model)
    return model


def material(name, color, metallic=0, roughness=.5, emission=0, transmission=0,
             ior=None, backface_culling=False):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    inputs = {"Base Color": (*color, 1), "Metallic": metallic, "Roughness": roughness,
              "Transmission Weight": transmission, "Emission Color": (*color, 1),
              "Emission Strength": emission}
    if ior is not None:
        inputs["IOR"] = ior
    for key, value in inputs.items():
        bsdf.inputs[key].default_value = value
    mat.use_backface_culling = backface_culling
    return mat


def into_model(obj, name, mat):
    obj.name = name
    for coll in list(obj.users_collection):
        coll.objects.unlink(obj)
    model.objects.link(obj)
    if mat:
        obj.data.materials.append(mat)
    return obj


def soften(obj, width, segments=4):
    mod = obj.modifiers.new("Manufactured edge radius", "BEVEL")
    mod.width, mod.segments = width, segments
    # Freeze triangulation before computing normals and baking/exporting UVs.
    obj.modifiers.new("Stable render triangles", "TRIANGULATE")
    obj.modifiers.new("Face weighted normals", "WEIGHTED_NORMAL")
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def box(name, location, dimensions, mat, bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = into_model(bpy.context.object, name, mat)
    obj.dimensions = dimensions
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return soften(obj, bevel) if bevel else obj


def cylinder(name, location, radius, depth, mat, rotation=(0, 0, 0), vertices=48, cap=.0005):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth,
                                      location=location, rotation=rotation)
    return soften(into_model(bpy.context.object, name, mat), min(cap, depth/5), 3)


def tube(name, points, radius, mat, smooth=True):
    data = bpy.data.curves.new(name, "CURVE")
    data.dimensions, data.bevel_depth, data.bevel_resolution = "3D", radius, 3
    spline = data.splines.new("BEZIER" if smooth else "POLY")
    if smooth:
        spline.bezier_points.add(len(points)-1)
        for p, co in zip(spline.bezier_points, points):
            p.co = co
            p.handle_left_type = p.handle_right_type = "AUTO"
    else:
        spline.points.add(len(points)-1)
        for p, co in zip(spline.points, points):
            p.co = (*co, 1)
    obj = bpy.data.objects.new(name, data)
    model.objects.link(obj)
    data.materials.append(mat)
    return obj


def aim(obj, target):
    obj.rotation_euler = (Vector(target) - obj.location).to_track_quat("-Z", "Y").to_euler()


def area(name, location, power, size, target):
    data = bpy.data.lights.new(name, "AREA")
    data.energy, data.shape, data.size = power, "DISK", size
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location
    aim(obj, target)
