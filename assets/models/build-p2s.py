"""Build the editable, unbranded P2S, its real glTF mesh and static poster.

    blender -b --python assets/models/build-p2s.py

Original geometry reconstructed from official photographs; sources and remaining
uncertainties are in README.md. Metres, front = -Y, up = Z. No reference photographs,
manufacturer artwork or third-party meshes are embedded in the delivered assets.
"""

import subprocess
import sys
import bpy
import bmesh
import _cycles
import numpy as np
from functools import partial
from math import cos, sin, pi, radians
from mathutils import Matrix, Vector
from pathlib import Path

# Blender does not put the script directory on sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import blender_helpers as helpers
from blender_helpers import aim, area, box, cylinder, into_model, soften, tube

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "assets/models/bambu-p2s.blend"
# The raw export is compressed into static/models/ by scripts/compress-model.sh.
GLB = ROOT / "assets/models/build/bambu-p2s.glb"
GLB.parent.mkdir(parents=True, exist_ok=True)
SERVED_GLB = ROOT / "static/models/bambu-p2s.glb"
WEBP = ROOT / "static/models/bambu-p2s.webp"
WEBP.parent.mkdir(parents=True, exist_ok=True)
model = helpers.new_model("P2S — original unbranded geometry")
material = partial(helpers.material, ior=1.46, backface_culling=True)


shell = material("Warm graphite moulded enclosure", (.215, .219, .216), .14, .43)
trim = material("Graphite front fascia", (.195, .200, .197), .18, .39)
black = material("Black injection moulded frame", (.012, .014, .015), .04, .44)
inner = material("Chamber charcoal panels", (.032, .035, .035), .08, .64)
rubber = material("Rubber seals and belt", (.007, .008, .008), 0, .82)
steel = material("Machined steel", (.42, .45, .46), .84, .24)
lead_steel = material("Satin steel lead screws", (.42, .45, .46), .78, .34)
carbon = material("Graphite X rods", (.057, .063, .063), .6, .24)
head = material("Toolhead grey moulding", (.14, .15, .15), .14, .43)
pei = material("Fine textured PEI", (.20, .185, .15), .36, .77)
glass = material("Smoked tempered door glass", (.36, .39, .38), 0, .055, transmission=.96)
lid_glass = material("Smoked tempered lid glass", (.40, .43, .42), 0, .065, transmission=.96)
lcd = material("LCD black glass", (.003, .005, .006), 0, .3)
lcd.node_tree.nodes.get("Principled BSDF").inputs["Specular IOR Level"].default_value = .08
# RGB straight to the output exports as KHR_materials_unlit: display pixels
# should not pick up the environment reflections or the geometry's shading.
def display_material(name, color):
    mat = bpy.data.materials.new("LCD " + name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    nodes.remove(nodes.get("Principled BSDF"))
    rgb = nodes.new("ShaderNodeRGB")
    rgb.outputs[0].default_value = (*color, 1)
    mat.node_tree.links.new(rgb.outputs[0], nodes.get("Material Output").inputs["Surface"])
    return mat


ui_background = display_material("background", (.009, .009, .009))
ui_panel = display_material("charcoal tiles", (.035, .035, .035))
ui_rail = display_material("sidebar and icon wells", (.060, .060, .060))
ui_text = display_material("pale graphics", (.76, .76, .76))
ui_dim = display_material("secondary graphics", (.40, .40, .40))
ui_edge = display_material("diagram edges", (.12, .12, .12))
ui_bed = display_material("diagram build plate", (.23, .22, .20))
ui_green = display_material("green highlights", (.40, .85, .075))
led = material("Chamber LED diffuser", (.82, .88, .91), 0, .4, emission=2)

# Portable tangent-space microtexture: packed into .blend and GLB, unlike Blender
# Noise nodes which glTF cannot export. Seeded and generated here, never a photo.
rng = np.random.default_rng(23)
pixels = np.ones((256, 256, 4), dtype=np.float32)
pixels[:, :, :2] = .5 + rng.normal(0, .10, (256, 256, 2))
pixels[:, :, 2] = .985
texture = bpy.data.images.new("Original surface grain", width=256, height=256)
texture.colorspace_settings.name = "Non-Color"
texture.pixels.foreach_set(pixels.ravel())
texture.pack()
for mat, strength in [(shell, .07), (trim, .06), (pei, .55)]:
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    uv = nodes.new("ShaderNodeTexCoord")
    mapping = nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (5, 5, 5)
    image = nodes.new("ShaderNodeTexImage")
    image.image = texture
    normal = nodes.new("ShaderNodeNormalMap")
    normal.inputs["Strength"].default_value = strength
    links.new(uv.outputs["UV"], mapping.inputs["Vector"])
    links.new(mapping.outputs["Vector"], image.inputs["Vector"])
    links.new(image.outputs["Color"], normal.inputs["Color"])
    links.new(normal.outputs["Normal"], nodes.get("Principled BSDF").inputs["Normal"])


def prism(name, outline, depth, location, mat, axis="Y", bevel=0):
    # Extruded outlines allow large face radii on thin panels (a cube bevel alone
    # clamps to half the panel thickness and loses the real rounded silhouette).
    def vertex(u, v, t):
        return {"X": (t, u, v), "Y": (u, t, v), "Z": (u, v, t)}[axis]
    n = len(outline)
    vertices = [vertex(u, v, t) for t in [-depth / 2, depth / 2] for u, v in outline]
    faces = [tuple(range(n - 1, -1, -1)), tuple(range(n, 2*n))]
    faces += [(i, (i+1) % n, (i+1) % n+n, i+n) for i in range(n)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces))
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    model.objects.link(obj)
    obj.location = location
    obj.data.materials.append(mat)
    # Planar grain UVs on the large manufactured faces.
    uv = mesh.uv_layers.new(name="Surface UV")
    us, vs = zip(*outline)
    for face in mesh.polygons:
        for index in face.loop_indices:
            u, v = outline[mesh.loops[index].vertex_index % n]
            uv.data[index].uv = ((u-min(us))/(max(us)-min(us)), (v-min(vs))/(max(vs)-min(vs)))
    if bevel:
        soften(obj, bevel)
    return obj


def rounded(name, location, width, height, depth, radius, mat, axis="Y"):
    outline = []
    for u, v, start in [(width/2-radius, height/2-radius, 0),
                         (-width/2+radius, height/2-radius, 90),
                         (-width/2+radius, -height/2+radius, 180),
                         (width/2-radius, -height/2+radius, 270)]:
        for step in range(13):
            a = radians(start + step*90/12)
            outline.append((u + radius*cos(a), v + radius*sin(a)))
    return prism(name, outline, depth, location, mat, axis, min(depth/4, .0005))


def screw(name, x, y, z, radius=.003):
    cylinder(name, (x, y, z), radius, .0012, black, (pi/2, 0, 0), 32)
    cylinder(name + " hex recess", (x, y-.0007, z), radius*.43, .0002, rubber,
             (pi/2, 0, 0), 6)


# Enclosure: continuous rounded front corners, thin seams, shallow bottom sill.
box("Chamber floor", (0, 0, .018), (.369, .370, .025), inner, .003)
box("Rear enclosure", (0, .183, .242), (.378, .013, .466), shell, .005)
box("Rear internal liner", (0, .174, .235), (.350, .003, .416), inner, .002)
for side, label in [(-1, "Left"), (1, "Right")]:
    # Lower intake/lifting recess is a real notch, not a decal on an unbroken cube.
    outline = [(-.170, .009), (-.065, .009), (-.055, .012), (-.042, .025),
               (-.036, .027), (.043, .027), (.049, .025), (.064, .012),
               (.070, .009), (.181, .009), (.187, .015), (.187, .472),
               (.181, .478), (-.170, .478)]
    panel = prism(label + " side shell with intake cutout", outline, .007,
                  (side*.1925, 0, 0), shell, "X")
    # Rounded corner cross section wraps from front to side, without a block seam.
    profile = [(side*.161, -.196), (side*.177, -.196)]
    for k in range(1, 65):
        a = -pi/2 + k*pi/128
        profile.append((side*(.177+.019*cos(a)), -.177+.019*sin(a)))
    profile += [(side*.196, -.168), (side*.186, -.168), (side*.161, -.184)]
    corner = prism(label + " rounded front upright", profile, .468,
                   (0, 0, .244), shell, "Z")
    # A single shell removes coplanar overlaps at the curved-corner/side join.
    union = panel.modifiers.new("Continuous front and side shell", "BOOLEAN")
    union.operation, union.object = "UNION", corner
    bpy.context.view_layer.objects.active = panel
    bpy.ops.object.modifier_apply(modifier=union.name)
    bpy.data.objects.remove(corner, do_unlink=True)
    soften(panel, .0007)
    for face in panel.data.polygons:
        if abs(face.normal.x) > .999:
            face.use_smooth = False
    box(label + " inner door jamb", (side*.165, -.183, .218), (.011, .015, .390), black, .0015)
    box(label + " side bottom seam", (side*.194, .118, .008), (.001, .112, .0014), black)
    rounded(label + " recessed intake", (side*.186, .004, .016), .108, .026, .007, .009, rubber, "X")
    for y in np.linspace(-.038, .044, 15):
        fin = box(label + " intake louvre", (side*.187, y, .014), (.006, .0025, .018), inner, .0006)
        fin.rotation_euler.x = radians(-25)
    for y in [-.155, .156]:
        cylinder(label + " rubber foot", (side*.165, y, .004), .016, .008, rubber)
    box(label + " upper internal frame", (side*.166, 0, .433), (.024, .346, .024), black, .003)
    box(label + " belt channel", (side*.154, 0, .448), (.013, .340, .014), inner, .002)
    cylinder(label + " Y guide", (side*.145, 0, .410), .0045, .332, steel, (pi/2, 0, 0))

box("Front lower sill", (0, -.186, .022), (.322, .019, .026), trim, .0015)
box("Front upper fascia", (0, -.186, .449), (.322, .019, .058), trim, .0015)
box("Door top shadow gap", (0, -.197, .419), (.324, .002, .002), rubber)
box("Door bottom shadow gap", (0, -.197, .035), (.324, .002, .0015), rubber)

# Open roof under a genuine transmissive glass lid; no opaque roof below the glass.
for x in [-.178, .178]:
    box("Top side rim", (x, .006, .474), (.021, .351, .008), black, .002)
for y in [-.174, .169]:
    box("Top cross rim", (0, y, .474), (.349, .015, .008), black, .002)
lid_outline = [(-.172, -.171), (.172, -.171)]
for u, start in [(.148, 0), (-.148, 90)]:
    for k in range(17):
        angle = radians(start+k*90/16)
        lid_outline.append((u+.024*cos(angle), .147+.024*sin(angle)))
prism("Tempered top pane", lid_outline, .003, (0, .001, .478), lid_glass, "Z", .0004)
for x in [-.165, .165]:
    box("Lid fired black side border", (x, -.0085, .4797), (.013, .311, .0004), black, .0001)
box("Lid fired black front border", (0, -.164, .4797), (.344, .013, .0004), black)
box("Lid fired black rear border", (0, .1655, .4797), (.296, .013, .0004), black)
for u, start in [(.148, 0), (-.148, 90)]:
    outline = []
    for radius, steps in [(.024, range(17)), (.011, range(16, -1, -1))]:
        for k in steps:
            a = radians(start+k*90/16)
            outline.append((u+radius*cos(a), .148+radius*sin(a)))
    prism("Lid curved rear ceramic border", outline, .0004, (0, 0, .4797), black, "Z")
cylinder("Lid pull rubber seat", (0, -.176, .480), .012, .003, black)
cylinder("Unmarked circular lid pull", (0, -.176, .483), .012, .005, trim)

# Nearly full-height smoked door and its black ceramic edge bands.
rounded("Single smoked door pane", (0, -.1995, .227), .324, .384, .0028, .0015, glass)
for x in [-.158, .158]:
    box("Door fired black side border", (x, -.201, .227), (.007, .0004, .382), black)
for z in [.041, .412]:
    box("Door fired black end border", (0, -.201, z), (.316, .0004, .012), black)
for z in [.049, .405]:
    rounded("Door hinge leaf", (-.132, -.197, z), .053, .019, .006, .003, black)
    cylinder("Door hinge pivot", (-.160, -.197, z), .003, .021, steel)
    for x in [-.138, -.113]:
        screw("Flush glass hinge fixing", x, -.203, z, .0041)
cylinder("Handle standoff", (.149, -.209, .244), .006, .013, black, (pi/2, 0, 0))
rounded("Unmarked oval door pull", (.150, -.219, .244), .046, .015, .0055, .007, shell)

# Rear liner: purge chute on left, filter grille on right, third lead screw centre.
rounded("Rear purge chute surround", (-.074, .164, .300), .054, .091, .016, .008, black)
rounded("Purge chute cavity", (-.074, .154, .301), .039, .069, .003, .006, rubber)
box("Purge chute lower lip", (-.074, .142, .263), (.049, .017, .011), inner, .003)
box("Nozzle wiper support", (-.074, .142, .355), (.052, .041, .014), black, .002)
cylinder("Nozzle wiping roller", (-.074, .124, .366), .004, .044, rubber, (0, pi/2, 0))
rounded("Rear air filter recess", (.103, .167, .202), .068, .182, .007, .004, black)
for x in np.linspace(.074, .132, 16):
    box("Rear filter vertical grille", (x, .161, .202), (.0018, .004, .171), inner, .0004)
for x, y in [(-.143, -.139), (.143, -.139), (0, .153)]:
    cylinder("Z lead screw core", (x, y, .224), .0035, .366, lead_steel)
    # Actual helical thread, visible through the door and from above.
    thread = [(x+.004*cos(a), y+.004*sin(a), .046+.0025*a/(2*pi))
              for a in np.linspace(0, 2*pi*143, 143*32+1)]
    tube("Z screw helical thread", thread, .00065, lead_steel, False)
    for z in [.045, .402]:
        cylinder("Z screw bearing", (x, y, z), .008, .009, black)
    box("Bed lead screw nut", (x, y, .165), (.019, .023, .026), black, .003)

# Heatbed support, thin removable 256 mm plate, projecting front tab and rear stops.
box("Heatbed undertray", (0, .005, .152), (.267, .272, .013), black, .003)
box("Heatbed metal edge", (0, .003, .159), (.264, .269, .004), steel, .001)
rounded("Textured PEI build sheet", (0, .003, .162), .258, .262, .001, .004, pei, "Z")
rounded("Build sheet lifting tab", (0, -.133, .162), .068, .019, .001, .004, pei, "Z")
box("Heatbed front cover", (0, -.133, .152), (.267, .007, .018), head, .0018)
# Original physical safety/detail markings, without the manufacturer's branding.
marking = material("Unbranded bed markings", (.065, .069, .064), 0, .7)
tube("Bed hot-surface triangle", [(-.116,-.137,.148),(-.110,-.137,.158),
                                  (-.104,-.137,.148),(-.116,-.137,.148)], .00045, marking, False)
box("Bed warning stroke", (-.110,-.137,.152), (.0008,.0002,.003), marking)
for text, x, size in [("HOT SURFACE", -.099, .0025), ("256 × 256 mm", -.026, .004)]:
    data = bpy.data.curves.new("Bed " + text, "FONT")
    data.body, data.size = text, size
    obj = bpy.data.objects.new("Bed " + text, data)
    model.objects.link(obj)
    obj.location, obj.rotation_euler = (x,-.137,.150), (pi/2,0,0)
    data.materials.append(marking)
for x in [-.10, .10]:
    box("Rear plate alignment stop", (x, .133, .165), (.016, .012, .007), black, .001)
for side in [-1, 1]:
    box("Bed side support arm", (side*.134, .005, .146), (.019, .287, .015), inner, .002)
# Right-side air duct and horizontal nozzle outlet.
rounded("Adaptive airflow side duct", (.165, .025, .242), .220, .082, .022, .013, inner, "X")
rounded("Auxiliary cooling outlet", (.151, .006, .290), .188, .011, .007, .005, rubber, "X")
for y in np.linspace(-.079, .089, 9):
    box("Outlet grille divider", (.148, y, .290), (.005, .0015, .009), head)

# CoreXY carriage and two round X rails: toolhead at the centre of the gantry.
for z in [.366, .399]:
    cylinder("X carbon guide rod", (0, -.039, z), .0045, .311, carbon, (0, pi/2, 0))
for side in [-1, 1]:
    box("XY carriage end", (side*.149, -.033, .388), (.030, .052, .061), black, .004)
    for y in [-.146, .141]:
        cylinder("CoreXY idler", (side*.151, y, .445), .009, .012, steel)
    box("CoreXY side belt", (side*.151, .002, .446), (.002, .284, .005), rubber)
box("CoreXY cross belt", (0, -.020, .406), (.308, .002, .006), rubber)
for x in np.linspace(-.142, .142, 95):
    box("Cross belt tooth", (x, -.021, .406), (.001, .001, .006), black)
box("Toolhead extruder carriage", (0, -.056, .379), (.064, .046, .071), black, .006)
rounded("Toolhead upper grey cover", (0, -.085, .383), .061, .060, .022, .006, head)
rounded("Toolhead lower fan shroud", (0, -.079, .341), .061, .033, .031, .007, black)
# Fan's open ring, radial blades and inset hub, not a flat disk.
bpy.ops.mesh.primitive_torus_add(major_radius=.0212, minor_radius=.0022,
    major_segments=64, minor_segments=12, location=(0, -.098, .384), rotation=(pi/2, 0, 0))
into_model(bpy.context.object, "Part cooling fan rim", black)
cylinder("Part cooling fan well", (0, -.098, .384), .020, .001, rubber, (pi/2, 0, 0))
for a in np.linspace(0, 2*pi, 37, endpoint=False):
    blade = box("Radial fan blade", (.016*sin(a), -.100, .384+.016*cos(a)),
                (.001, .002, .007), inner, .0002)
    blade.rotation_euler.y = a+.35
cylinder("Recessed fan centre", (0, -.101, .384), .0138, .002, black, (pi/2, 0, 0))
for x in [-.024, .024]:
    screw("Toolhead cover screw", x, -.098, .357, .0022)
    box("Lower cooling prong", (x, -.081, .326), (.011, .028, .015), black, .002)
box("Hotend heater", (0, -.071, .326), (.014, .018, .018), steel, .002)
for z in np.linspace(.332, .348, 7):
    box("Hotend heatsink fin", (0, -.067, z), (.023, .025, .0008), steel)
bpy.ops.mesh.primitive_cone_add(vertices=48, radius1=.001, radius2=.004,
    depth=.006, location=(0, -.071, .313))
into_model(bpy.context.object, "Hardened nozzle tip", steel)
for z in np.linspace(.363, .391, 9):
    box("Extruder side cooling slot", (.033, -.061, z), (.001, .022, .0012), rubber)
cylinder("PTFE inlet collet", (0, -.050, .419), .005, .011, black)
tube("PTFE feed tube", [(0, -.050, .423), (.007, -.028, .458), (.071, .066, .459),
                        (.104, .135, .448), (.133, .168, .432)], .0022, material("PTFE natural tube", (.61, .64, .62), 0, .42))
tube("Toolhead flexible cable", [(-.020, -.028, .413), (-.060, .025, .452),
                                (-.10, .10, .457), (-.145, .143, .435)], .0035, rubber)
# Discreet LED and front-left chamber camera.
box("Left chamber LED body", (-.153, -.02, .428), (.009, .219, .013), black, .002)
box("Chamber light diffuser", (-.1475, -.02, .426), (.002, .209, .006), led, .001)
box("Chamber camera housing", (-.138, -.162, .392), (.026, .018, .018), black, .003)
cylinder("Chamber camera lens", (-.133, -.151, .392), .005, .003, lcd, (pi/2, 0, 0))

# Rear fittings visible at elevated angles; no optional AMS or external spool.
for x in [-.147, .147]:
    box("Rear belt tensioner cover", (x, .193, .423), (.035, .008, .042), black, .003)
box("Rear spool mounting plate", (-.139, .194, .344), (.071, .009, .029), trim, .005)
rounded("Rear purge outlet", (.071, .192, .230), .047, .092, .006, .006, black)
rounded("Rear fan vent inset", (.133, .191, .225), .050, .110, .003, .003, rubber)
for x in np.linspace(.112, .154, 11):
    box("Rear exhaust grille", (x, .193, .225), (.002, .002, .102), inner)
box("Rear power socket surround", (-.146, .192, .061), (.024, .004, .053), black, .002)
box("Rear power switch", (-.146, .196, .075), (.012, .005, .014), rubber, .001)
rounded("Rear IEC socket", (-.146, .196, .052), .017, .017, .004, .003, rubber)
cylinder("Rear filament inlet", (.145, .193, .459), .005, .009, black, (pi/2, 0, 0))

# The 5-inch landscape touchscreen sits LEFT OF CENTRE, on a visible tilt hinge.
# All interface artwork is original geometry, including the small printer diagram.
cylinder("Display hinge", (-.080, -.209, .460), .010, .049, black, (0, pi/2, 0))
screen_start = set(model.objects)
rounded("Display rear casing", (-.080, -.221, .468), .130, .077, .009, .007, black)
rounded("Display thin graphite edge", (-.080, -.226, .468), .127, .074, .002, .0065, head)
rounded("Display glass bezel", (-.080, -.2275, .468), .126, .073, .0015, .006, lcd)
rounded("LCD active area", (-.080, -.2285, .468), .113, .060, .0005, .002, ui_background)
# Author in an 800 × 424 display grid; every mark remains editable mesh/curves.
pixel = .113 / 800


def screen_point(x, y, layer=1):
    return (-.1365 + x*pixel, -.229 - layer*.00012, .498 - y*pixel)


def screen_tile(name, x, y, width, height, mat=ui_panel, radius=7, layer=0):
    return rounded("LCD " + name, screen_point(x+width/2, y+height/2, layer),
                   width*pixel, height*pixel, .00008, radius*pixel, mat)


def screen_line(name, points, mat=ui_dim, width=2, layer=2):
    obj = tube("LCD " + name, [(-.1365+x*pixel, 0, .498-y*pixel) for x, y in points],
               width*pixel/2, mat, False)
    # Flat display strokes must not protrude through artwork in front of them.
    obj.scale.y = .1
    obj.location.y = screen_point(0, 0, layer)[1]
    return obj


def screen_face(name, points, mat, layer=1):
    return prism("LCD " + name, [(x*pixel, -y*pixel) for x, y in points],
                 .00008, screen_point(0, 0, layer), mat)


def screen_disc(name, x, y, radius, mat, layer=1):
    return cylinder("LCD " + name, screen_point(x, y, layer), radius*pixel,
                    .00008, mat, (pi/2, 0, 0), 32)


def screen_text(text, x, y, size, mat=ui_text):
    data = bpy.data.curves.new("LCD " + text, "FONT")
    data.body, data.size, data.extrude = text, size*pixel, 0
    obj = bpy.data.objects.new("LCD " + text, data)
    model.objects.link(obj)
    obj.location = screen_point(x, y, 3)
    obj.rotation_euler = (pi/2, 0, 0)
    data.materials.append(mat)


def screen_icon(name, x, y, mat=ui_dim, scale=1):
    # Simple original line icons, in a 24-pixel square.
    paths = {
        "home": [[(-11,0),(0,-10),(11,0)], [(-8,-2),(-8,10),(-3,10),(-3,3),(3,3),(3,10),(8,10),(8,-2)]],
        "controls": [[(-6,-12),(-6,12)], [(6,-12),(6,12)], [(-10,4),(-2,4)], [(2,-4),(10,-4)]],
        "spool": [[(-9,-10),(-9,10)], [(9,-10),(9,10)], [(-5,-7),(5,-7),(5,7),(-5,7),(-5,-7)]],
        "settings": [[(12*cos(a),12*sin(a)) for a in np.linspace(0,2*pi,7)],
                     [(4*cos(a),4*sin(a)) for a in np.linspace(0,2*pi,17)]],
        "help": [[(-10,-8),(10,-8),(12,-4),(12,5),(8,9),(-3,9),(-10,13),(-8,7),(-12,4),(-12,-4),(-10,-8)],
                 [(-6,0),(-5,0)], [(0,0),(1,0)], [(6,0),(7,0)]],
        "nozzle": [[(-7,-10),(-7,0),(0,7),(7,0),(7,-10),(-7,-10)], [(-8,8),(-10,12)], [(0,10),(0,13)], [(8,8),(10,12)]],
        "heat": [[(-8,8),(8,8)], *[[(x,-10),(x-2,-5),(x+2,0),(x,5)] for x in [-6,0,6]]],
        "chamber": [[(-11,-12),(11,-12),(11,12),(-11,12),(-11,-12)],
                    *[[(x,-7),(x-1,-3),(x+2,2),(x+1,6)] for x in [-5,0,5]]],
        "speed": [[(11*cos(a),11*sin(a)) for a in np.linspace(pi,2*pi,17)],
                  [(-11,0),(-8,7),(8,7),(11,0)], [(0,2),(5,-7)]],
        "motion": [[(-12,0),(12,0)], [(-7,-5),(-12,0),(-7,5)], [(7,-5),(12,0),(7,5)]],
        "light": [[(-5,5),(-8,0),(-8,-6),(-4,-10),(4,-10),(8,-6),(8,0),(5,5),(-5,5)],
                  [(-4,9),(4,9)], [(0,-14),(0,-17)], [(-12,-9),(-15,-12)], [(12,-9),(15,-12)]]
    }
    for points in paths[name]:
        screen_line(name + " icon", [(x+u*scale,y+v*scale) for u,v in points], mat, 2.7*scale, 3)


screen_tile("sidebar", 0, 0, 76, 424, ui_rail, 4)
for name, y in [("home",44),("controls",125),("spool",207),("settings",290),("help",373)]:
    screen_icon(name, 38, y, ui_green if name == "controls" else ui_dim, 1.1)

for name, y, height in [("fan",18,72),("nozzle",106,126),("chamber",249,72),("heatbed",337,72)]:
    screen_tile(name + " tile", 94, y, 250, height)
for x, label, value, icon in [(356,"Speed","Standard","speed"),(572,"Motion","XYZ","motion")]:
    screen_tile(label + " tile", x, 18, 210, 72)
    screen_disc(label + " well", x+29, 54, 19, ui_rail)
    screen_icon(icon, x+29, 54)
    screen_text(label, x+56, 45, 19, ui_dim)
    screen_text(value, x+56, 70, 25)
    screen_line("chevron", [(x+191,49),(x+196,54),(x+191,59)], width=2)

for label, value, y, icon in [("Fan","Cooling",54,None),("Chamber","35°C",285,"chamber"),
                             ("Heatbed","30°C / 0°C",373,"heat")]:
    screen_disc(label + " well", 123, y, 19, ui_rail)
    if icon:
        screen_icon(icon, 123, y)
    else:
        for a in [0, pi/2, pi, 3*pi/2]:
            screen_face("fan blade", [(123+u*cos(a)-v*sin(a), y+u*sin(a)+v*cos(a))
                                      for u,v in [(1,0),(4,-11),(10,-10),(11,-5),(5,2)]], ui_dim, 3)
        screen_disc("fan hub", 123, y, 3, ui_text, 4)
    screen_text(label, 150, y-9, 19, ui_dim)
    screen_text(value, 150, y+16, 26)
    if label != "Chamber":
        screen_line("chevron", [(325,y-5),(330,y),(325,y+5)], width=2)
screen_disc("nozzle well", 123, 133, 19, ui_rail)
screen_icon("nozzle", 123, 133)
screen_text("Nozzle & Extruder", 150, 139, 19, ui_dim)
screen_line("chevron", [(325,128),(330,133),(325,138)], width=2)
screen_tile("extruder illustration", 112, 174, 23, 34, ui_dim, 3, 2)
screen_disc("extruder fan", 123.5, 190, 8, ui_background, 3)
screen_disc("extruder hub", 123.5, 190, 4, ui_edge, 4)
screen_text("35°C / 0°C", 150, 201, 29)

# A shaded enclosure, gantry and bed, following the reference's control preview.
screen_face("preview right wall", [(592,130),(778,97),(778,375),(592,410)], ui_panel, 0)
screen_face("preview back wall", [(383,98),(570,98),(778,97),(592,130)], ui_rail, 0)
for x, y, bottom in [(383,98,386),(592,130,410),(776,97,375)]:
    screen_face("preview upright", [(x,y),(x+8,y+1),(x+8,bottom),(x,bottom-1)], ui_edge, 1)
    screen_line("upright highlight", [(x,y),(x,bottom)], ui_rail, 2)
for points in [[(390,130),(600,161),(770,123)], [(390,150),(600,181),(770,143)],
               [(399,194),(570,163),(755,183)], [(405,380),(583,403),(764,369)]]:
    screen_line("preview frame", points, ui_rail, 5, 1)
for x, y in [(417,194),(733,168)]:
    screen_line("preview lead screw", [(x,y),(x,371)], ui_edge, 2, 1)
screen_face("preview bed front edge", [(415,330),(627,359),(627,367),(415,338)], ui_edge, 2)
screen_face("preview bed side edge", [(627,359),(718,318),(718,326),(627,367)], ui_rail, 2)
screen_face("preview build plate", [(415,330),(512,291),(718,318),(627,359)], ui_bed, 3)
screen_line("preview bed lip", [(415,330),(627,359)], ui_dim, 2, 4)
screen_face("preview toolhead side", [(574,130),(594,121),(594,178),(574,190)], ui_edge, 3)
screen_face("preview toolhead top", [(535,125),(555,118),(594,121),(574,130)], ui_dim, 3)
screen_face("preview toolhead face", [(535,125),(574,130),(574,190),(535,185)], ui_bed, 3)
screen_disc("preview fan rim", 554, 160, 15, ui_edge, 4)
screen_disc("preview fan opening", 554, 160, 11, ui_background, 5)
screen_disc("preview fan hub", 554, 160, 4, ui_rail, 6)
screen_face("preview nozzle", [(548,190),(560,192),(554,199)], ui_dim, 3)

screen_tile("light control", 646, 370, 136, 39, ui_panel, 7, 2)
screen_icon("light", 663, 390, ui_green, .65)
screen_text("Light", 678, 397, 20)
screen_tile("light switch", 733, 380, 40, 21, ui_green, 10, 8)
screen_disc("light switch thumb", 762, 390.5, 8, ui_background, 9)
screen_line("light switch check", [(758,390),(761,393),(766,387)], ui_green, 1.7, 10)
# Side view references put the screen about 20° back from vertical.
bpy.context.view_layer.update()
pivot = Vector((-.080, -.220, .468))
tilt = Matrix.Translation(pivot) @ Matrix.Rotation(radians(-20), 4, "X") @ Matrix.Translation(-pivot)
for obj in set(model.objects) - screen_start:
    obj.matrix_world = tilt @ obj.matrix_world


camera_data = bpy.data.cameras.new("Marketing camera")
camera = bpy.data.objects.new("Marketing camera", camera_data)
bpy.context.scene.collection.objects.link(camera)
camera.location = (.98, -.98, .50)
aim(camera, (0, 0, .255))
camera_data.type = "PERSP"
camera_data.angle = radians(30)
bpy.context.scene.camera = camera
area("Front softbox", (-.5, -.7, .9), 18, .65, (0, 0, .25))
area("Right softbox", (.65, -.1, .65), 14, .65, (0, 0, .25))
area("Top reflection", (.0, .25, 1.1), 10, .5, (0, 0, .25))
area("Chamber illumination", (-.13, -.01, .431), .18, .16, (0, 0, .20))
world = bpy.data.worlds.new("Neutral photographic studio")
bpy.context.scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs["Color"].default_value = (.32, .32, .32, 1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value = .35
scene = bpy.context.scene
scene.unit_settings.system = "METRIC"
scene.render.engine = "CYCLES"
# Official Blender includes OIDN; some distribution builds omit it.
scene.cycles.use_denoising = bool(getattr(_cycles, "with_openimagedenoise", False))
scene.cycles.samples = 192 if scene.cycles.use_denoising else 512
scene.render.film_transparent = True
scene.render.resolution_x = scene.render.resolution_y = 1100
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "WEBP"
scene.render.image_settings.color_mode = "RGBA"
scene.render.image_settings.quality = 92
scene.render.filepath = str(WEBP)
scene.view_settings.view_transform = "AgX"
scene["Reference and limitations"] = "See assets/models/README.md. Original photo-based mesh; no branding or photographic textures."
bpy.ops.object.select_all(action="DESELECT")
for obj in model.objects:
    obj.select_set(True)
bpy.context.view_layer.objects.active = next(iter(model.objects))
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE))

# Keep individual editable parts in Blender; merge evaluated export copies by
# material to avoid hundreds of draw calls on a phone. This also bakes bevels,
# weighted normals, text and tubes into REAL mesh rather than dropping modifiers.
export = bpy.data.collections.new("Temporary glTF batching")
scene.collection.children.link(export)
depsgraph = bpy.context.evaluated_depsgraph_get()
groups = {}
for obj in model.objects:
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph), depsgraph=depsgraph)
    clone = bpy.data.objects.new(obj.name, mesh)
    export.objects.link(clone)
    clone.matrix_world = obj.matrix_world
    groups.setdefault(obj.data.materials[0].name, []).append(clone)
for name, objects in groups.items():
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    if len(objects) > 1:
        bpy.ops.object.join()
    objects[0].name = name
# Bake ambient occlusion with Blender's native baker: browser image-based
# lighting has no enclosure shadows. Keep the source parts/materials untouched;
# this atlas is derived lighting for export, not a photographic texture.
for obj in model.objects:
    obj.hide_render = True
solid = []
for obj in export.objects:
    obj.data.materials[0] = obj.data.materials[0].copy()
    mat = obj.data.materials[0]
    if any(word in mat.name for word in ("glass", "LCD", "LED")):
        obj.hide_render = True
        continue
    # The shared atlas cannot resolve sub-millimetre thread UV islands: mipmaps
    # turn their seams into black gaps. Keep the rods on analytic PBR lighting;
    # they remain visible to the baker and still cast shadows on the enclosure.
    if mat.name.startswith(lead_steel.name):
        continue
    solid.append(obj)
    obj.data.uv_layers.new(name="Occlusion UV")
    obj.data.uv_layers.active_index = len(obj.data.uv_layers)-1
bpy.ops.object.select_all(action="DESELECT")
for obj in solid:
    obj.select_set(True)
bpy.context.view_layer.objects.active = solid[0]
bpy.ops.object.mode_set(mode="EDIT")
bpy.ops.mesh.select_all(action="SELECT")
bpy.ops.uv.smart_project(angle_limit=radians(66), island_margin=.003)
bpy.ops.object.mode_set(mode="OBJECT")
ao = bpy.data.images.new("Baked enclosure occlusion", width=2048, height=2048)
ao.colorspace_settings.name = "Non-Color"
for obj in solid:
    node = obj.data.materials[0].node_tree.nodes.new("ShaderNodeTexImage")
    node.image = ao
    obj.data.materials[0].node_tree.nodes.active = node
scene.cycles.samples = 32
bpy.ops.object.bake(type="AO", margin=6, use_clear=True, uv_layer="Occlusion UV")
ao.pack()
output = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
output.interface.new_socket(name="Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
for obj in solid:
    mat = obj.data.materials[0]
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    image = nodes.active
    uv = nodes.new("ShaderNodeUVMap")
    uv.uv_map = "Occlusion UV"
    links.new(uv.outputs["UV"], image.inputs["Vector"])
    settings = nodes.new("ShaderNodeGroup")
    settings.node_tree = output
    links.new(image.outputs["Color"], settings.inputs["Occlusion"])
    obj.data.uv_layers.active_index = 0
for obj in export.objects:
    obj.hide_render = False
bpy.ops.object.select_all(action="DESELECT")
for obj in export.objects:
    obj.select_set(True)
assert len(export.objects) == len(groups)
assert not any(obj.type == "FONT" for obj in export.objects)
bpy.ops.export_scene.gltf(filepath=str(GLB), export_format="GLB", use_selection=True,
                          export_apply=True, export_cameras=False, export_lights=False)
for obj in list(export.objects):
    bpy.data.objects.remove(obj, do_unlink=True)
bpy.data.collections.remove(export)
for obj in model.objects:
    obj.hide_render = False
scene.cycles.samples = 192 if scene.cycles.use_denoising else 512
bpy.ops.render.render(write_still=True)
SOURCE.with_name(SOURCE.name + "1").unlink(missing_ok=True)
subprocess.run(["sh", "scripts/compress-model.sh", GLB.stem], cwd=ROOT, check=True)
print(f"Created {SOURCE}, {SERVED_GLB}, {WEBP}")
