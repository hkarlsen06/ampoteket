"""Original, editable soldering-station scene with a scroll-scrubbable glTF clip.

    blender -b --python assets/models/build-soldering-station.py

Metres, Z up, front = -Y. Reference photographs are never embedded. See README.md.
"""
import subprocess
import sys
import bpy
import bmesh
import _cycles
import numpy as np
from math import cos, sin, pi, radians
from mathutils import Vector
from pathlib import Path

# Blender does not put the script directory on sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from functools import partial
import blender_helpers as helpers
from blender_helpers import aim, area, box, into_model, material, new_model, soften, tube

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "assets/models/soldering-station.blend"
# The raw export is compressed into static/models/ by scripts/compress-model.sh.
GLB = ROOT / "assets/models/build/soldering-station.glb"
GLB.parent.mkdir(parents=True, exist_ok=True)
SERVED_GLB = ROOT / "static/models/soldering-station.glb"
WEBP = ROOT / "static/models/soldering-station.webp"
model = new_model("Soldering station — original geometry")
cylinder = partial(helpers.cylinder, cap=.0004)
scene = bpy.context.scene
scene.unit_settings.system = "METRIC"
scene.render.fps = 30
scene.frame_start, scene.frame_end = 1, 121


case = material("Black moulded enclosure", (.014, .017, .019), .03, .43)
edge = material("Graphite edges", (.024, .028, .031), .06, .43)
face = material("Glossy black control fascia", (.009, .013, .017), .1, .24)
rubber = material("Soft black silicone", (.014, .016, .018), 0, .72)
dark = material("Recesses and socket interiors", (.003, .004, .005), 0, .9)
steel = material("Brushed stainless steel", (.46, .50, .54), .88, .28)
chrome = material("Polished contact metal", (.65, .70, .74), .95, .19)
oxidized = material("Heat-darkened tip sleeve", (.18, .16, .13), .88, .36)
solder = material("Tinned joints", (.56, .58, .59), .93, .23)
copper = material("Copper and plated brass", (.57, .30, .07), .76, .3)
sponge_mat = material("Cellulose cleaning sponge", (.70, .52, .065), 0, .93)
sponge_pore = material("Sponge pores", (.28, .20, .017), 0, 1)
ink = material("Warm white panel legends", (.64, .68, .66), .0, .68)
screen = material("Blue LCD backlight", (.008, .055, .33), .0, .34, .45)
led = material("Pale LCD segments", (.25, .67, .92), .0, .55, .8)
unlit = material("Unlit LCD segments", (.012, .081, .35), .0, .58)
green = material("Deep green solder mask", (.008, .075, .026), .0, .40)
trace_mat = material("Copper traces beneath solder mask", (.017, .135, .050), .12, .36)
fr4 = material("Fibreglass board edge", (.29, .28, .12), .0, .75)
silk = material("PCB cream silkscreen", (.71, .77, .61), .0, .65)
blue = material("Blue resistor lacquer", (.06, .20, .32), .05, .45)
ceramic = material("Warm ceramic capacitors", (.40, .16, .06), .0, .53)
red = material("Red power switch", (.34, .015, .011), .05, .32)

# Original packed normal maps remain portable in glTF (procedural shader nodes do not).
rng = np.random.default_rng(938)
for mat, strength, grain in [(case, .13, .055), (rubber, .18, .08), (sponge_mat, .85, .27)]:
    pixels = np.ones((256, 256, 4), dtype=np.float32)
    pixels[:, :, :2] = .5 + rng.normal(0, grain, (256, 256, 2))
    pixels[:, :, 2] = .96
    tex = bpy.data.images.new(mat.name + " original grain", width=256, height=256)
    tex.colorspace_settings.name = "Non-Color"
    tex.pixels.foreach_set(pixels.ravel())
    tex.pack()
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    image = nodes.new("ShaderNodeTexImage")
    image.image = tex
    normal = nodes.new("ShaderNodeNormalMap")
    normal.inputs["Strength"].default_value = strength
    links.new(image.outputs["Color"], normal.inputs["Color"])
    links.new(normal.outputs["Normal"], nodes.get("Principled BSDF").inputs["Normal"])


def torus(name, location, major, minor, mat, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor,
                                    major_segments=64, minor_segments=12,
                                    location=location, rotation=rotation)
    obj = into_model(bpy.context.object, name, mat)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def lathe(name, profile, mat, segments=64):
    vertices = [(r*cos(2*pi*i/segments), r*sin(2*pi*i/segments), z)
                for z, r in profile for i in range(segments)]
    faces = []
    for row in range(len(profile)-1):
        for i in range(segments):
            a, b = row*segments+i, row*segments+(i+1)%segments
            faces.append((a, b, b+segments, a+segments))
    faces += [tuple(range(segments-1, -1, -1)),
              tuple((len(profile)-1)*segments+i for i in range(segments))]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    model.objects.link(obj)
    mesh.materials.append(mat)
    for poly in mesh.polygons:
        poly.use_smooth = len(poly.vertices) == 4
    uv = mesh.uv_layers.new(name="Cylindrical UV")
    for loop in mesh.loops:
        row, col = divmod(loop.vertex_index, segments)
        uv.data[loop.index].uv = (col/segments, row/(len(profile)-1))
    return obj


def text(name, value, location, size, mat, rotation=(pi/2, 0, 0)):
    data = bpy.data.curves.new(name, "FONT")
    data.body, data.size, data.extrude = value, size, .000025
    obj = bpy.data.objects.new(name, data)
    model.objects.link(obj)
    obj.location, obj.rotation_euler = location, rotation
    data.materials.append(mat)
    return obj


def screw(name, x, y, z, rotation=(0, 0, 0)):
    obj = cylinder(name, (x, y, z), .0023, .0012, steel, rotation, 32)
    slot = box(name + " slot", (0, 0, .00065), (.0033, .0006, .0002), dark, .0001)
    slot.parent = obj
    return obj


# Board: an original training PCB with exposed plated holes and a target header pin.
board_x, board_y, board_z = .13, -.105, .018
box("FR4 laminate", (board_x, board_y, board_z), (.144, .100, .0016), fr4, .002)
box("Top solder mask", (board_x, board_y, board_z+.00087), (.1435, .0995, .00015), green, .0018)
box("Bottom solder mask", (board_x, board_y, board_z-.00087), (.1435, .0995, .00015), green, .0018)
surface = board_z+.001
for x in [board_x-.064, board_x+.064]:
    for y in [board_y-.042, board_y+.042]:
        cylinder("Insulating PCB standoff", (x, y, .009), .0035, .016, edge)
        cylinder("Mounting hole shadow", (x, y, surface+.0001), .0021, .0003, dark)
        torus("Mounting plated annulus", (x, y, surface+.0003), .0025, .0005, solder)
        screw("PCB mounting screw", x, y, surface+.0004)

for row in range(4):
    for col in range(11):
        x, y = .11952 + col*.00508, -.12 + row*.00508
        cylinder("Through-hole dark bore", (x, y, surface+.00015), .00065, .00025, dark, vertices=24)
        torus("Exposed plated pad", (x, y, surface+.00025), .001, .0003, copper)
        if row < 3 and col%2 == 0:
            tube("Solder mask trace", [(x, y, surface+.00006), (x+.00254, y+.00254, surface+.00006),
                                       (x+.00254, y+.00508, surface+.00006)], .00024, trace_mat, False)

# Eight-pin package, bent leads, orientation dimple and original silkscreen outline.
box("DIP-8 moulded package", (.092, -.103, surface+.005), (.009, .020, .005), case, .0008)
for side in [-1, 1]:
    for i in range(4):
        x, y = .092+side*.007, -.1105+i*.005
        tube("DIP gull-wing lead", [(x, y, surface+.0005), (x, y, surface+.004),
                                    (x-side*.003, y, surface+.006)], .00048, solder, False)
        torus("DIP solder fillet", (x, y, surface+.0003), .0009, .00035, solder)
cylinder("IC pin-one dimple", (.090, -.11, surface+.0076), .0007, .00015, dark, vertices=24)
tube("IC silkscreen outline", [(.082,-.117,surface+.00015),(.102,-.117,surface+.00015),
                               (.102,-.089,surface+.00015),(.082,-.089,surface+.00015),
                               (.082,-.117,surface+.00015)], .00018, silk, False)
text("IC designation", "U1", (.083,-.122,surface+.00015), .003, silk, (0,0,0))
for i, y in enumerate([-.135, -.078]):
    obj = cylinder("Axial metal-film resistor", (.101, y, surface+.004), .0016, .009, blue, (0,pi/2,0), 32)
    for j, mat in enumerate([case, copper, case, copper]):
        cylinder("Resistor colour band", (.098+j*.0017, y, surface+.004), .00165, .0006, mat, (0,pi/2,0), 32)
    for side in [-1,1]:
        tube("Bent resistor lead", [(.101+side*.0045,y,surface+.004),(.101+side*.009,y,surface+.004),
                                     (.101+side*.011,y,surface)], .00035, solder)
        torus("Resistor solder joint", (.101+side*.011,y,surface+.0003), .0009,.00035,solder)
    text("Resistor designation", "R"+str(i+1), (.098,y+.004,surface+.0002),.0025,silk,(0,0,0))
for x in [.117,.134]:
    cylinder("Electrolytic capacitor can", (x,-.075,surface+.009), .0042,.014,edge)
    cylinder("Aluminium capacitor lid", (x,-.075,surface+.0161), .0038,.0003,steel)
    tube("Capacitor pressure relief", [(x-.0025,-.075,surface+.0163),(x+.0025,-.075,surface+.0163)],.00015,dark,False)
    tube("Capacitor pressure relief", [(x,-.0775,surface+.0163),(x,-.0725,surface+.0163)],.00015,dark,False)
    box("Capacitor polarity stripe", (x,-.0791,surface+.009),(.0018,.0002,.010),ink,.0001)
for x in [.161,.174]:
    box("Ceramic capacitor",(x,-.075,surface+.004),(.006,.0028,.006),ceramic,.001)
    for dx in [-.002,.002]:
        cylinder("Ceramic capacitor lead",(x+dx,-.075,surface+.001),.0003,.002,solder)
text("PCB marking", "AMPOTEKET", (.111,-.147,surface+.0002),.004,silk,(0,0,0))
text("PCB revision", "SOLDER PRACTICE  /  01", (.075,-.067,surface+.0002),.0025,silk,(0,0,0))
# A row of pins extends through a connector below the board; the tip lands on pad 3.
target = Vector((.14935,-.120,surface+.0006))
box("Header insulating strip underneath",(.15,-.120,board_z-.004),(.034,.005,.004),case,.0006)
for i in range(7):
    x = .13476+i*.00508
    box("Square header pin",(x,-.120,surface+.0012),(.00065,.00065,.0065),chrome,.00009)
    torus("Header plated annulus",(x,-.120,surface+.00035),.001,.00035,copper)
    if i != 3:
        joint = lathe("Concave solder fillet",[(0,.0013),(.0003,.0011),(.0008,.00055),(.0016,.0004)],solder,32)
        joint.location=(x,-.120,surface)
text("Header designation","J1",(.134,-.126,surface+.0002),.0025,silk,(0,0,0))
board_offset=Vector((-.012,.025,0))
for obj in model.objects:
    if obj.parent is None:
        obj.location+=board_offset
target+=board_offset

# Iron local +Z runs from the working tip toward the handle/cable.
iron_root = bpy.data.objects.new("IronTipPivot",None)
model.objects.link(iron_root)
iron_pointer = bpy.data.objects.new("IronPointerPivot",None)
model.objects.link(iron_pointer)
iron_pointer.parent=iron_root
iron_parts = set(model.objects)
lathe("Tinned conical working tip",[(0,.00035),(.003,.00075),(.017,.0025),(.022,.0025)],chrome)
lathe("Heat-darkened tip shoulder",[(.020,.0025),(.026,.0031),(.035,.0031)],oxidized)
lathe("Stainless heater barrel",[(.033,.0036),(.037,.004),(.081,.004),(.084,.0048)],steel)
for z in [.04,.052,.063,.075]:
    torus("Barrel machined seam",(0,0,z),.004,.00017,oxidized)
lathe("Tip-retaining knurled collar",[(.077,.0045),(.079,.006),(.087,.006),(.089,.005)],chrome)
for i in range(48):
    a=2*pi*i/48
    tube("Collar knurl",[(.006*cos(a),.006*sin(a),.079),(.006*cos(a),.006*sin(a),.086)],.00015,steel,False)
lathe("Handle finger guard",[(.084,.0048),(.086,.0095),(.090,.0105),(.094,.0095),(.096,.0078)],case)
lathe("Soft ergonomic grip",[(.092,.0076),(.10,.0078),(.118,.0074),(.143,.0068),(.150,.0065)],rubber)
for i in range(13):
    z=.103+i*.003
    torus("Grip moulding ring",(0,0,z),.00775-(z-.103)*.019,.00024,edge)
lathe("Tapered hard handle",[(.145,.0068),(.163,.0067),(.185,.0061),(.195,.0056),(.2,.0048)],case)
tube("Handle mould seam",[(.0067,0,.15),(.0065,0,.165),(.0059,0,.185),(.0054,0,.196)],.00011,edge,False)
lathe("Flexible cable strain relief",[(.196,.0038),(.203,.0037),(.219,.0026),(.222,.0024)],rubber)
for i in range(6):
    z=.202+i*.003
    torus("Strain relief rib",(0,0,z),.00365-i*.00019,.00035,rubber)
for obj in set(model.objects)-iron_parts:
    obj.parent=iron_pointer
iron_socket=bpy.data.objects.new("IronCableSocket",None)
model.objects.link(iron_socket)
iron_socket.parent=iron_pointer
iron_socket.location=(0,0,.222)

def prism(name, outline, width, x, mat, radius=0):
    # Extrude a Y/Z side profile along X; editable cross-section, real sloping fascia.
    n=len(outline)
    vertices=[(x+t,y,z) for t in [-width/2,width/2] for y,z in outline]
    faces=[tuple(range(n-1,-1,-1)),tuple(range(n,2*n))]
    faces += [(i,(i+1)%n,(i+1)%n+n,i+n) for i in range(n)]
    mesh=bpy.data.meshes.new(name)
    mesh.from_pydata(vertices,[],faces)
    bm=bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
    bm.to_mesh(mesh)
    bm.free()
    obj=bpy.data.objects.new(name,mesh)
    model.objects.link(obj)
    mesh.materials.append(mat)
    uv=mesh.uv_layers.new(name="Case grain UV")
    for loop in mesh.loops:
        co=mesh.vertices[loop.vertex_index].co
        uv.data[loop.index].uv=(co.y/.146,co.z/.091)
    return soften(obj,radius) if radius else obj


# Tenma/AT938D-family control unit: 120 mm wide × 146 mm deep × 91 mm high.
station_start=set(model.objects)
sx,sy=.006,.071
profile=[(sy-.073,.020),(sy-.066,.009),(sy+.064,.009),(sy+.073,.018),
         (sy+.073,.083),(sy+.064,.097),(sy-.046,.100),(sy-.061,.088)]
prism("Rounded wedge main enclosure",profile,.113,sx,case,.005)
for side in [-1,1]:
    profile=[(sy-.073,.016),(sy-.065,.009),(sy-.055,.009),(sy-.050,.021),
             (sy+.053,.021),(sy+.058,.009),(sy+.070,.009),(sy+.073,.023),
             (sy+.073,.086),(sy+.066,.100),(sy-.044,.100),(sy-.061,.089)]
    prism("Raised side frame and integral feet",profile,.007,sx+side*.0565,edge,.002)
    for y in [sy-.060,sy+.061]:
        box("Non-slip station foot",(sx+side*.049,y,.005),(.016,.019,.009),rubber,.002)
    # Slots are recessed between physical louvres, visible from elevated/side views.
    box("Side cooling recess",(sx+side*.0597,sy+.026,.070),(.0006,.075,.021),dark,.0002)
    for i in range(19):
        obj=box("Side cooling louvre",(sx+side*.060,sy-.010+i*.0037,.070),(.0014,.0016,.022),case,.00055)
        obj.rotation_euler.x=radians(-12)
    for y in [sy-.05,sy+.058]:
        screw("Side assembly screw",sx+side*.0605,y,.037,(0,side*pi/2,0))

# Gently rounded top, long shoulder ridges and rear vent bank.
box("Top inset panel",(sx,sy+.011,.097),(.093,.105,.002),case,.004)
for side in [-1,1]:
    tube("Top moulded shoulder",[(sx+side*.051,sy-.045,.098),(sx+side*.052,sy+.035,.099),
                                 (sx+side*.050,sy+.066,.094)],.0013,edge)
for i in range(23):
    box("Top ventilation slot",(sx-.038+i*.0034,sy+.047,.099),(.0014,.021,.0007),dark,.0005)
box("Case split seam",(sx,sy+.0732,.045),(.104,.0005,.001),dark)
box("Rear power socket",(sx-.025,sy+.074,.039),(.025,.002,.020),dark,.002)
box("Rear mains inlet rim",(sx-.025,sy+.075,.039),(.022,.003,.017),edge,.0015)
box("Power rocker recess",(sx+.0598,sy+.046,.039),(.0018,.022,.014),dark,.001)
box("Red rocker switch",(sx+.061,sy+.046,.039),(.0027,.017,.010),red,.0014)

# Front panel parts are built in panel coordinates, then tilted back together.
panel=bpy.data.objects.new("Sloping control fascia",None)
model.objects.link(panel)
panel.location=(sx,sy-.067,.057)
panel.rotation_euler.x=radians(-10)
start=set(model.objects)
box("Inset front bezel",(0,0,0),(.108,.004,.066),edge,.003)
box("Gloss black fascia insert",(0,-.0024,.001),(.101,.001,.054),face,.002)
box("LCD recess",(.012,-.0031,.011),(.050,.0009,.029),dark,.0015)
box("LCD luminous surface",(.012,-.0037,.011),(.046,.0003,.024),screen,.001)
text("Panel function label","SOLDERING",(-.045,-.0032,.019),.0037,ink)
text("Panel function label second line","STATION",(-.045,-.0032,.014),.0033,ink)
text("ESD label","ESD",(.041,-.0032,-.014),.0026,ink)
text("ESD label second line","SAFE",(.039,-.0032,-.018),.0024,ink)
text("LCD measured label","REAL",(-.009,-.00395,.016),.0017,led)
text("LCD unit","°C",(.029,-.00395,.017),.0028,led)
text("LCD preset values","200   350   400",(-.007,-.00395,.002),.0027,led)

# Seven-segment geometry is original and remains sharp at every browser angle.
segments={"3":"abgcd","5":"afgcd","0":"abcdef"}
for digit,char in enumerate("350"):
    x=-.001+digit*.009
    z=.013
    coords={"a":(0,.007,False),"g":(0,0,False),"d":(0,-.007,False),
            "f":(-.003,.0035,True),"b":(.003,.0035,True),
            "e":(-.003,-.0035,True),"c":(.003,-.0035,True)}
    for key,(dx,dz,vertical) in coords.items():
        box("LCD segment "+char+key,(x+dx,-.004,z+dz),
            (.001,.0001,.0053) if vertical else (.0049,.0001,.001),
            led if key in segments[char] else unlit,.00025)
for i in range(5):
    box("LCD heat bar",(.030+i*.0012,-.004,.008+i*.0006),(.0007,.0001,.002+i*.0012),led,.00015)
for i,label in enumerate(["1","2","3","#"]):
    x=-.011+i*.0134
    cylinder("Preset button surround",(x,-.0035,-.016),.0045,.001,edge,(pi/2,0,0),48)
    torus("Preset button bright ring",(x,-.0041,-.016),.00375,.00028,copper,(pi/2,0,0))
    cylinder("Preset membrane button",(x,-.0042,-.016),.00315,.00065,ink,(pi/2,0,0),48)
    text("Preset button legend",label,(x-.0013,-.0046,-.0176),.004,face)
# Locking DIN connector: concentric nuts, machined thread and rubber plug boot.
for depth,radius,mat,y in [(.003,.011,dark,-.004),(.002,.0094,chrome,-.006),
                           (.004,.0081,steel,-.009),(.007,.007,chrome,-.014),
                           (.008,.0057,rubber,-.021)]:
    cylinder("Iron connector fitting",(-.033,y,-.008),radius,depth,mat,(pi/2,0,0),64)
for i in range(4):
    torus("DIN retaining nut thread",(-.033,-.009-i*.0012,-.008),.0082,.0003,chrome,(pi/2,0,0))
for i in range(40):
    a=2*pi*i/40
    tube("Connector nut knurl",[(-.033+.0083*cos(a),-.012,-.008+.0083*sin(a)),
                               (-.033+.0083*cos(a),-.008,-.008+.0083*sin(a))],.00014,steel,False)
for i in range(7):
    cylinder("Connector boot rib",(-.033,-.022-i*.0015,-.008),.0049-i*.0002,.0006,rubber,(pi/2,0,0),40)
for obj in set(model.objects)-start:
    obj.parent=panel
station_root=bpy.data.objects.new("Control unit — 91 mm overall height",None)
station_root.scale.z=.91
model.objects.link(station_root)
for obj in set(model.objects)-station_start-{station_root}:
    if obj.parent is None:
        obj.parent=station_root
bpy.context.view_layer.update()
connector=panel.matrix_world @ Vector((-.033,-.033,-.008))

# Separate heavy stand and sponge tray, positioned left as in the user's photo.
hx,hy=-.117,-.050
box("Weighted stand base",(hx,hy,.012),(.077,.138,.019),case,.004)
for x in [hx-.028,hx+.028]:
    for y in [hy-.053,hy+.053]:
        cylinder("Stand rubber foot",(x,y,.0025),.006,.005,rubber)
box("Sponge tray recess",(hx,hy-.030,.022),(.067,.064,.004),dark,.002)
for x in [hx-.035,hx+.035]:
    box("Sponge tray side rim",(x,hy-.030,.026),(.005,.069,.013),case,.0017)
for y in [hy-.063,hy+.003]:
    box("Sponge tray end rim",(hx,y,.026),(.067,.005,.013),case,.0017)
box("Porous cleaning sponge",(hx,hy-.030,.025),(.061,.057,.007),sponge_mat,.002)
for i in range(190):
    x,y=hx+rng.uniform(-.028,.028),hy-.030+rng.uniform(-.025,.025)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=8,ring_count=4,radius=1,location=(x,y,.02825+rng.uniform(-.00025,.00025)))
    obj=into_model(bpy.context.object,"Cellulose pore",sponge_pore)
    obj.scale=(rng.uniform(.0003,.0011),rng.uniform(.0003,.0009),.00016)
prism("Raised stand support",[(hy+.002,.02),(hy+.061,.02),(hy+.054,.067),
                              (hy+.022,.071),(hy+.003,.041)],.064,hx,case,.005)
for i in range(6):
    box("Stand rear ventilation",(hx-.024+i*.0095,hy+.038,.071),(.004,.021,.001),dark,.001)
for x in [hx-.026,hx+.026]:
    screw("Holder mounting screw",x,hy+.012,.044)
dock=Vector((hx,-.036,.017))
dock_axis=Vector((0,.56,.829)).normalized()
dock_rotation=dock_axis.to_track_quat("Z","Y")
holster=bpy.data.objects.new("Angled hollow iron holster",None)
model.objects.link(holster)
holster.location=dock
holster.rotation_mode="QUATERNION"
holster.rotation_quaternion=dock_rotation
start=set(model.objects)
lathe("Holster hollow heat-resistant funnel",[(.026,.012),(.066,.020),(.078,.022),(.082,.022),
                                             (.082,.014),(.073,.012),(.027,.006),(.026,.006)],case)
lathe("Inner steel rest",[(.033,.0065),(.073,.0128),(.075,.0128),(.074,.0115),(.033,.0055)],steel)
torus("Holster outer flange",(0,0,.083),.023,.0018,edge)
torus("Holster inner flange",(0,0,.083),.014,.0014,edge)
for i in range(6):
    a=i*pi/3
    obj=box("Holster vent bridge",(.0185*cos(a),.0185*sin(a),.083),(.011,.0035,.0027),edge,.001)
    obj.rotation_euler.z=a
for obj in set(model.objects)-start:
    obj.parent=holster

# Replaceable barrel cooling slots and the ridged black collet ahead of the guard.
for a in [0,pi/2,pi,3*pi/2]:
    slot=box("Heater barrel cooling slot",(.00405*cos(a),.00405*sin(a),.062),(.0002,.0012,.007),dark,.0005)
    slot.rotation_euler.z=a
    slot.parent=iron_pointer
for i in range(40):
    a=2*pi*i/40
    part=tube("Black collet longitudinal rib",[(.007*cos(a),.007*sin(a),.086),
                                             (.007*cos(a),.007*sin(a),.095)],.00022,edge,False)
    part.parent=iron_pointer


# Rigid tip-pivot motion: straight withdrawal first, travel second, contact last.
# Hold the start/end briefly so the operation reads while the section is visible.
contact=bpy.data.objects.new("SolderContactTarget",None)
model.objects.link(contact)
contact.location=target
contact.empty_display_size=.003
final_axis=Vector((-.48,.20,.854)).normalized()
final_rotation=final_axis.to_track_quat("Z","Y")
lift=dock+dock_axis*.094
above=target+Vector((-.012,.025,.105))


def smooth(t):
    t=max(0,min(1,t))
    return t*t*(3-2*t)


def pose(t):
    if t<=.12:
        return dock,dock_rotation
    if t<.37:
        return dock.lerp(lift,smooth((t-.12)/.25)),dock_rotation
    if t<.67:
        u=smooth((t-.37)/.30)
        return lift.lerp(above,u)+Vector((0,0,.030*sin(pi*u))),dock_rotation.slerp(final_rotation,u)
    return above.lerp(target,smooth((t-.67)/.25)),final_rotation


iron_root.rotation_mode="QUATERNION"
for frame in range(1,122):
    iron_root.location,iron_root.rotation_quaternion=pose((frame-1)/120)
    iron_root.keyframe_insert(data_path="location",frame=frame)
    iron_root.keyframe_insert(data_path="rotation_quaternion",frame=frame)
iron_root.animation_data.action.name="Soldering iron motion"
for curve in iron_root.animation_data.action.fcurves:
    for key in curve.keyframe_points:
        key.interpolation="LINEAR"


def cable_vertices(t):
    tip,rotation=pose(t)
    end=tip+rotation@Vector((0,0,.222))
    # C1-continuous cubic curves: slack rests around the PCB, rises behind the
    # controller and bends DOWN smoothly from the handle's strain relief.
    # Explicit tangents avoid the pinched reversal of an interpolated polyline.
    front=Vector((.060,-.170,.005))
    right=Vector((.232,-.028,.005))
    rear=Vector((.085,.169,.005))
    rising=Vector((end.x+.060,max(.179,end.y+.090),max(.062,end.z*.48)))
    curves=[(connector,connector+Vector((0,-.045,-.008)),front+Vector((-.092,0,0)),front),
            (front,front+Vector((.105,0,0)),right+Vector((0,-.112,0)),right),
            (right,right+Vector((0,.125,0)),rear+Vector((.10,0,0)),rear),
            (rear,rear+Vector((-.075,0,0)),rising+Vector((.012,.023,-.044)),rising),
            (rising,rising+Vector((-.012,-.023,.044)),end+rotation@Vector((0,0,.052)),end)]
    centers=[]
    for a,b,c,d in curves:
        for step in range(24):
            u=step/24
            centers.append((1-u)**3*a+3*(1-u)**2*u*b+3*(1-u)*u*u*c+u**3*d)
    centers.append(end)
    vertices=[]
    for i,center in enumerate(centers):
        tangent=(centers[min(i+1,len(centers)-1)]-centers[max(0,i-1)]).normalized()
        normal=tangent.cross(Vector((1,0,0))).normalized()
        binormal=tangent.cross(normal).normalized()
        for j in range(12):
            a=j*2*pi/12
            vertices.append(center+.0024*(normal*cos(a)+binormal*sin(a)))
    return vertices


def check_foot_clearance(vertices):
    # Tube surface must clear every finite cylindrical board support.
    clearance=1.0
    for row in range(len(vertices)//12):
        center=sum(vertices[row*12:(row+1)*12],Vector())/12
        for x in [board_x-.064+board_offset.x,board_x+.064+board_offset.x]:
            for y in [board_y-.042+board_offset.y,board_y+.042+board_offset.y]:
                radial=max(0,((center.x-x)**2+(center.y-y)**2)**.5-.0035)
                vertical=max(.001-center.z,0,center.z-.017)
                clearance=min(clearance,(radial**2+vertical**2)**.5-.0024)
    assert clearance>.003, f"Iron lead clips a PCB support: {clearance*1000:.2f} mm clearance"
    return clearance


vertices=cable_vertices(0)
minimum_clearance=check_foot_clearance(vertices)
faces=[]
for i in range(len(vertices)//12-1):
    for j in range(12):
        a,b=i*12+j,i*12+(j+1)%12
        faces.append((a,b,b+12,a+12))
mesh=bpy.data.meshes.new("Flexible iron lead mesh")
mesh.from_pydata(vertices,[],faces)
mesh.update()
cable=bpy.data.objects.new("Flexible iron lead",mesh)
model.objects.link(cable)
mesh.materials.append(rubber)
for poly in mesh.polygons:
    poly.use_smooth=True
uv=mesh.uv_layers.new(name="Cable UV")
for loop in mesh.loops:
    # U is also the browser's hover-deformation weight coordinate: socket=0, iron=1.
    uv.data[loop.index].uv=(loop.vertex_index//12/(len(vertices)//12-1),loop.vertex_index%12/12)
cable.shape_key_add(name="Resting cable")
previous_vertices=vertices
for sample in range(1,31):
    key=cable.shape_key_add(name=f"Cable pose {sample:02}")
    sample_vertices=cable_vertices(sample/30)
    minimum_clearance=min(minimum_clearance,check_foot_clearance(sample_vertices),
                          check_foot_clearance([(a+b)/2 for a,b in zip(previous_vertices,sample_vertices)]))
    previous_vertices=sample_vertices
    for vert,co in zip(key.data,sample_vertices):
        vert.co=co
    for neighbor,value in [(sample-1,0),(sample,1),(sample+1,0)]:
        key.value=value
        key.keyframe_insert(data_path="value",frame=1+neighbor*4)
for curve in cable.data.shape_keys.animation_data.action.fcurves:
    for key in curve.keyframe_points:
        key.interpolation="LINEAR"

# Joint remains a physical mesh, with its fillet growing only after tip contact.
joint=lathe("Fresh solder fillet",[(0,.00135),(.0003,.00115),(.0008,.0006),(.0016,.0004)],solder,48)
joint.location=(.150+board_offset.x,target.y,surface)
for frame,scale in [(1,.01),(111,.01),(121,1)]:
    joint.scale=(scale,scale,scale)
    joint.keyframe_insert(data_path="scale",frame=frame)

camera_data=bpy.data.cameras.new("Marketing camera")
camera=bpy.data.objects.new("Marketing camera",camera_data)
scene.collection.objects.link(camera)
camera_target=Vector((.03,0,.115))
camera.location=camera_target+Vector((sin(radians(20))*sin(radians(62)),
                                     -cos(radians(20))*sin(radians(62)),cos(radians(62))))
aim(camera,camera_target)
camera_data.type="PERSP"
camera_data.angle=radians(30)
scene.camera=camera
area("Large front softbox",(-.35,-.55,.65),12,.55,(0,0,.07))
area("Right edge light",(.48,-.02,.55),9,.45,(0,0,.09))
area("Rear top softbox",(-.10,.4,.65),11,.40,(0,0,.08))
world=bpy.data.worlds.new("Neutral studio")
world.use_nodes=True
world.node_tree.nodes["Background"].inputs["Color"].default_value=(.38,.38,.38,1)
world.node_tree.nodes["Background"].inputs["Strength"].default_value=.4
scene.world=world
scene.render.engine="CYCLES"
scene.cycles.use_denoising=bool(getattr(_cycles,"with_openimagedenoise",False))
scene.cycles.samples=128 if scene.cycles.use_denoising else 384
scene.render.film_transparent=True
scene.render.resolution_x=scene.render.resolution_y=1100
scene.render.resolution_percentage=100
scene.render.image_settings.file_format="WEBP"
scene.render.image_settings.color_mode="RGBA"
scene.render.image_settings.quality=92
scene.render.filepath=str(WEBP)
scene.view_settings.view_transform="AgX"
scene["Reference and limitations"]="Original reconstruction of the supplied workshop photo; Tenma/AT938D-family references. See assets/models/README.md."
scene.frame_set(1)
bpy.ops.object.select_all(action="DESELECT")
for obj in model.objects:
    obj.select_set(True)
bpy.context.view_layer.objects.active=iron_root
bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE))

# Batch only static parts / rigid iron parts. Preserve the source's editable parts,
# iron hierarchy and cable morph targets; there is no raster animation in this GLB.
export=bpy.data.collections.new("Temporary export batches")
scene.collection.children.link(export)
depsgraph=bpy.context.evaluated_depsgraph_get()
groups={}
for obj in list(model.objects):
    if obj.type not in {"MESH","CURVE","FONT"} or obj in [cable,joint]:
        continue
    mesh=bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph),depsgraph=depsgraph)
    clone=bpy.data.objects.new(obj.name,mesh)
    export.objects.link(clone)
    if obj.parent==iron_pointer:
        clone.parent=iron_pointer
        clone.matrix_local=obj.matrix_local.copy()
        group="Iron"
    else:
        clone.matrix_world=obj.matrix_world.copy()
        group="Station and board"
    groups.setdefault((group,obj.data.materials[0].name),[]).append(clone)
for (group,name),objects in groups.items():
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active=objects[0]
    if len(objects)>1:
        bpy.ops.object.join()
    objects[0].name=group+" — "+name
for obj in model.objects:
    if obj not in [iron_root,iron_pointer,iron_socket,contact,cable,joint]:
        obj.hide_render=True
bpy.ops.object.select_all(action="DESELECT")
for obj in [*export.objects,iron_root,iron_pointer,iron_socket,contact,cable,joint]:
    obj.select_set(True)
bpy.ops.export_scene.gltf(filepath=str(GLB),export_format="GLB",use_selection=True,
                          export_apply=False,export_cameras=False,export_lights=False,
                          export_animations=True,export_animation_mode="ACTIVE_ACTIONS",
                          export_frame_range=True,export_frame_step=1,
                          export_anim_slide_to_zero=True,
                          export_nla_strips_merged_animation_name="Soldering",
                          export_morph=True,export_morph_animation=True)
for obj in list(export.objects):
    bpy.data.objects.remove(obj,do_unlink=True)
bpy.data.collections.remove(export)
for obj in model.objects:
    obj.hide_render=False
scene.frame_set(1)
bpy.ops.render.render(write_still=True)
SOURCE.with_name(SOURCE.name+"1").unlink(missing_ok=True)
print(f"Minimum cable / PCB support clearance: {minimum_clearance*1000:.2f} mm")
subprocess.run(["sh", "scripts/compress-model.sh", GLB.stem], cwd=ROOT, check=True)
print(f"Created {SOURCE}, {SERVED_GLB}, {WEBP}")
