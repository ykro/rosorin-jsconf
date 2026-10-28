#!/usr/bin/env python3
"""
«Reconocer entorno»: finds the Demo B trays and the Demo C totems with the Aurora 930 camera.

The bridge (`POST /scan_env`) sweeps the arm (joint1 only, wheels never move) and, at each pause,
sends `{"op":"scan_env_capture","id":N,"scene":"gatekeeper"|"bughunter","servos":{"1":p,...}}` to
`ros2_worker.py`. The worker answers `{"event":"scan_env_result","id":N,...}` from a background
thread (see `SceneScanner`): vision never runs on the stdin thread, so the heartbeat keeps going.

Everything here is pure Python (no numpy, no rclpy) so it runs in CI and on the robot alike:

- Color segmentation on a subsampled RGB frame (HSV thresholds per printed color, closing,
  largest connected blob, minimum area).
- Camera pose from the URDF chain and the servo pulses at capture time (there is no live TF while
  our bridge owns the robot). `camera_link` (on the joint4 link, before the wrist roll) looks along
  its +x; its optical frame is the usual one (z forward, x right, y down).
- Pixel → 3D in `base_link` (x forward, y left, z up; the floor is z = FLOOR_Z_M): with a valid
  depth pixel, the ray scaled by the depth; otherwise the ray intersected with the plane where the
  colored part of the prop lies (the floor for the flat trays, ~8 cm up for the totems' colored
  band). The RGB and depth cameras are a few cm apart and not registered: the depth pixel is the RGB
  pixel mapped through both intrinsics as if they shared one optical center (parallax ignored).
- Optional LiDAR check for the totems (an echo near the expected bearing and range).

Thresholds were chosen from the printed colors (docs/generate_props_pdf.py) and synthetic images:
validate them on the real robot under stage light (`SCAN_ENV_DEBUG_DIR` dumps each capture).
"""
import json
import math
import os
import queue
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from calibrar_sombra import ARM_CHAIN, PULSE_RAD, _axis_angle, _mat_mul, _mat_vec, _rpy, joint_angle  # noqa: E402

# ---------------------------------------------------------------------------------------------
# Camera (measured on the real robot, 2026-10-27: /depth_cam/rgb0/camera_info, /depth_cam/depth0/camera_info)
# ---------------------------------------------------------------------------------------------
RGB_SIZE = (640, 400)
RGB_K = (415.853, 416.574, 322.145, 192.159)  # fx, fy, cx, cy
RGB_D = (0.01089, -0.04936, -0.000637, -0.000128, 0.03041)  # plumb_bob k1, k2, p1, p2, k3
DEPTH_SIZE = (640, 400)
DEPTH_K = (423.027, 423.807, 319.225, 197.19)
DEPTH_D = (0.06046, -0.10973, 0.000397, -0.000298, 0.05538)
DEPTH_MIN_M = 0.30  # the Aurora returns nothing useful closer than ~0.43 m; keep a margin
DEPTH_MAX_M = 2.5

# camera_connect_link and camera_link from the URDF (web/src/components/Rosorin3DViewer.tsx), on the
# joint4 link: (xyz, rpy) relative to the parent.
CAMERA_CONNECT = ((-0.036369, -0.0181, 0.046638), (-1.5621, -1.5621, 1.5708))
CAMERA_LINK = ((0.022511, -0.0010257, 0.0051917), (0.0, 0.0, 0.0))


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        sys.stderr.write(f"[scan_env] invalid {name}, using {default}\n")
        return default


# The props lie on the robot's own floor/table (base_link is 2.5 cm above it). If they stand on a
# surface higher (+) or lower (-) than the robot's, say so in SCAN_ENV_PROPS_HEIGHT_M.
FLOOR_Z_M = -0.025 + _env_float("SCAN_ENV_PROPS_HEIGHT_M", 0.0)
J1_AXIS_X_M = ARM_CHAIN[0][0][0]  # joint1 axis in base_link (x = 0.04662)
LIDAR_ORIGIN_XY = (0.048156, 0.0000755)

# ---------------------------------------------------------------------------------------------
# Props (docs/generate_props_pdf.py): which colors to look for in each scene
# ---------------------------------------------------------------------------------------------
# Hue ranges in degrees (0-360). `min_s`/`min_v` are 0-1. The trays' fill is a pale tint (S < 0.1):
# what the camera finds are the saturated border, drop circle and the big APROBADO/RECHAZADO word.
COLOR_SPECS = {
    "green": {"hues": ((80.0, 178.0),), "min_s": 0.14, "min_v": 0.32},
    "red": {"hues": ((345.0, 360.0), (0.0, 12.0)), "min_s": 0.18, "min_v": 0.38},
    "blue": {"hues": ((195.0, 245.0),), "min_s": 0.30, "min_v": 0.25},
    "yellow": {"hues": ((35.0, 62.0),), "min_s": 0.42, "min_v": 0.35},  # not the key's amber #B06000
}
# Height (base_link z) of the colored part of each prop, for the ray/plane fallback.
TRAY_PLANE_Z_M = FLOOR_Z_M
TOTEM_PLANE_Z_M = FLOOR_Z_M + 0.08  # the totems' color band and icon sit ~5-11 cm above the table

SCENES = {
    "gatekeeper": (
        {"id": "approve_tray", "label": "APROBADO", "color": "green", "kind": "tray"},
        {"id": "reject_tray", "label": "RECHAZADO", "color": "red", "kind": "tray"},
    ),
    "bughunter": (
        {"id": "cloud_run", "label": "Cloud Run", "color": "blue", "kind": "totem"},
        {"id": "gemini_live", "label": "Gemini Live", "color": "green", "kind": "totem"},
        {"id": "firestore", "label": "Firestore", "color": "yellow", "kind": "totem"},
    ),
}

SAMPLE_STRIDE = 2  # analyze every 2nd pixel in x and y (320 x 200 cells)
CLOSE_RADIUS = 2  # default dilation radius in cells
TOTEM_CLOSE_RADIUS = 3  # joins the totem badge, icon and top band
TRAY_CLOSE_RADIUS = 5  # larger closing radius for trays: joins the dashed border, drop circle and title
MIN_BLOB_CELLS = 18  # ~72 full-resolution pixels (rejects small noise specks while keeping 45 cm props)
FULL_CONFIDENCE_CELLS = 140  # a printed totem icon or tray border/title at ~40 cm is ~120-180 cells
# The blob touches the left/right edge of the image: the prop is only partly in view and its bearing
# is uncertain. (In the survey pose the near end of a tray is always below the frame: the bottom edge
# is not penalized, and the mat center then reads ~2 cm too far, which barely changes its bearing.)
SIDE_PENALTY = 0.75
CENTERING_WEIGHT = 0.4  # confidence × (1 − 0.4 · |u − center| / half width)
LIDAR_CONFIRM_HALF_ANGLE_DEG = 5.0
LIDAR_CONFIRM_TOLERANCE_M = 0.12


# ---------------------------------------------------------------------------------------------
# Geometry
# ---------------------------------------------------------------------------------------------
def undistort_pixel(u: float, v: float, k=RGB_K, d=RGB_D, iterations: int = 8) -> tuple:
    """Pixel → normalized image coordinates (x/z, y/z), inverting plumb_bob iteratively."""
    fx, fy, cx, cy = k
    k1, k2, p1, p2, k3 = d
    xd = (u - cx) / fx
    yd = (v - cy) / fy
    x, y = xd, yd
    for _ in range(iterations):
        r2 = x * x + y * y
        radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2
        dx = 2 * p1 * x * y + p2 * (r2 + 2 * x * x)
        dy = p1 * (r2 + 2 * y * y) + 2 * p2 * x * y
        x = (xd - dx) / radial
        y = (yd - dy) / radial
    return x, y


def distort_normalized(x: float, y: float, k=DEPTH_K, d=DEPTH_D) -> tuple:
    """Normalized coordinates → pixel with plumb_bob distortion (the forward model)."""
    fx, fy, cx, cy = k
    k1, k2, p1, p2, k3 = d
    r2 = x * x + y * y
    radial = 1 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2
    xd = x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x)
    yd = y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y
    return fx * xd + cx, fy * yd + cy


def camera_pose(servos: dict) -> tuple:
    """
    `camera_link` pose in base_link from the pulses of joints 1-4 ({"1": p1, ...} or {1: p1, ...}):
    (origin [x, y, z], rotation 3x3 whose columns are its x/y/z axes). Same chain as the twin.
    """
    def pulse(i):
        return int(servos.get(str(i), servos.get(i, 500)))

    rot = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    pos = [0.0, 0.0, 0.0]
    for i, (xyz, rpy, axis) in enumerate(ARM_CHAIN[:4], 1):
        pos = [p + d for p, d in zip(pos, _mat_vec(rot, xyz))]
        rot = _mat_mul(rot, _mat_mul(_rpy(*rpy), _axis_angle(axis, joint_angle(i, pulse(i)))))
    for xyz, rpy in (CAMERA_CONNECT, CAMERA_LINK):
        pos = [p + d for p, d in zip(pos, _mat_vec(rot, xyz))]
        rot = _mat_mul(rot, _rpy(*rpy))
    return pos, rot


def optical_to_base(rot, vec_optical) -> list:
    """Optical frame (z forward, x right, y down) → camera_link (x forward, y left, z up) → base_link."""
    xo, yo, zo = vec_optical
    return _mat_vec(rot, (zo, -xo, -yo))


def pixel_ray(u: float, v: float, servos: dict) -> tuple:
    """(origin, direction) in base_link of the RGB ray through pixel (u, v)."""
    origin, rot = camera_pose(servos)
    x, y = undistort_pixel(u, v)
    return origin, optical_to_base(rot, (x, y, 1.0))


def intersect_plane_z(origin, direction, z_plane: float):
    """Point where the ray meets the horizontal plane z = z_plane, or None (parallel or behind)."""
    if abs(direction[2]) < 1e-6:
        return None
    t = (z_plane - origin[2]) / direction[2]
    if t <= 0:
        return None
    return [origin[i] + t * direction[i] for i in range(3)]


def pixel_depth_to_base(u: float, v: float, depth_m: float, servos: dict) -> list:
    """3D point in base_link of RGB pixel (u, v) at `depth_m` along the optical axis."""
    origin, rot = camera_pose(servos)
    x, y = undistort_pixel(u, v)
    d = optical_to_base(rot, (x * depth_m, y * depth_m, depth_m))
    return [origin[i] + d[i] for i in range(3)]


def rgb_to_depth_pixel(u: float, v: float, rgb_size=RGB_SIZE, depth_size=DEPTH_SIZE) -> tuple:
    """
    RGB pixel → depth pixel looking along the same ray, as if both cameras shared one optical
    center (they are a few cm apart: the error is the parallax, ~1 cm at 0.5 m). Handles frames of
    another size by scaling the intrinsics.
    """
    x, y = undistort_pixel(u * RGB_SIZE[0] / rgb_size[0], v * RGB_SIZE[1] / rgb_size[1])
    ud, vd = distort_normalized(x, y)
    return ud * depth_size[0] / DEPTH_SIZE[0], vd * depth_size[1] / DEPTH_SIZE[1]


def bearing_deg(x: float, y: float) -> float:
    """REP-103 bearing from base_link: 0 = front, + = left."""
    return math.degrees(math.atan2(y, x))


def joint1_for_point(x: float, y: float, lo: int = 250, hi: int = 750) -> int:
    """
    joint1 pulse that turns the arm toward (x, y) in base_link, with the twin's mapping
    (angle = (pulse - 500) · 0.24° about +z, so > 500 = left), clamped to [lo, hi].
    """
    angle = math.atan2(y, x - J1_AXIS_X_M)
    pulse = 500 + round(angle / PULSE_RAD)
    return max(lo, min(hi, pulse))


# ---------------------------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------------------------
def rgb_to_hsv(r: int, g: int, b: int) -> tuple:
    """0-255 ints → (hue 0-360, saturation 0-1, value 0-1)."""
    mx = max(r, g, b)
    mn = min(r, g, b)
    if mx == 0:
        return 0.0, 0.0, 0.0
    delta = mx - mn
    s = delta / mx
    v = mx / 255.0
    if delta == 0:
        return 0.0, s, v
    if mx == r:
        h = 60.0 * (((g - b) / delta) % 6)
    elif mx == g:
        h = 60.0 * ((b - r) / delta + 2)
    else:
        h = 60.0 * ((r - g) / delta + 4)
    return h, s, v


def classify_color(h: float, s: float, v: float, names) -> str:
    for name in names:
        spec = COLOR_SPECS[name]
        if s < spec["min_s"] or v < spec["min_v"]:
            continue
        if any(lo <= h <= hi for lo, hi in spec["hues"]):
            return name
    return ""


def _channel_order(encoding: str) -> tuple:
    enc = (encoding or "bgr8").lower()
    if enc in ("rgb8", "rgba8"):
        return (0, 1, 2), 4 if enc == "rgba8" else 3
    if enc in ("bgr8", "bgra8"):
        return (2, 1, 0), 4 if enc == "bgra8" else 3
    raise ValueError(f"unsupported RGB encoding {encoding}")


def color_grid(image, names, stride: int = SAMPLE_STRIDE) -> tuple:
    """
    Subsamples `image` (width, height, step, encoding, data) and labels each cell with the first
    color of `names` it matches. Returns (cells: bytearray of color index + 1 or 0, cols, rows).
    """
    (ri, gi, bi), px = _channel_order(image.encoding)
    data = image.data
    step = int(getattr(image, "step", 0) or image.width * px)
    cols = (image.width + stride - 1) // stride
    rows = (image.height + stride - 1) // stride
    cells = bytearray(cols * rows)
    index = {name: i + 1 for i, name in enumerate(names)}
    for row in range(rows):
        base = row * stride * step
        for col in range(cols):
            o = base + col * stride * px
            name = classify_color(*rgb_to_hsv(data[o + ri], data[o + gi], data[o + bi]), names)
            if name:
                cells[row * cols + col] = index[name]
    return cells, cols, rows


def _dilate(mask: bytearray, cols: int, rows: int, radius: int) -> bytearray:
    """Square dilation, separable (rows then columns)."""
    if radius <= 0:
        return bytearray(mask)
    tmp = bytearray(len(mask))
    for r in range(rows):
        off = r * cols
        for c in range(cols):
            if mask[off + c]:
                lo = max(0, c - radius)
                hi = min(cols, c + radius + 1)
                tmp[off + lo:off + hi] = b"\x01" * (hi - lo)
    out = bytearray(len(mask))
    for r in range(rows):
        off = r * cols
        lo = max(0, r - radius)
        hi = min(rows, r + radius + 1)
        for c in range(cols):
            if tmp[off + c]:
                for rr in range(lo, hi):
                    out[rr * cols + c] = 1
    return out


def find_blobs(cells: bytearray, cols: int, rows: int, color_index: int, radius: int = CLOSE_RADIUS) -> list:
    """
    Connected blobs of one color after a closing-like dilation. Each blob reports only its original
    (undilated) cells: {cells, centroid (col, row), bbox (c0, r0, c1, r1), touches_side, touches_bottom}.
    """
    mask = bytearray(1 if v == color_index else 0 for v in cells)
    grown = _dilate(mask, cols, rows, radius)
    seen = bytearray(len(cells))
    blobs = []
    for start in range(len(cells)):
        if not grown[start] or seen[start]:
            continue
        stack = [start]
        seen[start] = 1
        count = 0
        sx = sy = 0
        c0, r0, c1, r1 = cols, rows, -1, -1
        while stack:
            i = stack.pop()
            r, c = divmod(i, cols)
            if mask[i]:
                count += 1
                sx += c
                sy += r
                c0, r0, c1, r1 = min(c0, c), min(r0, r), max(c1, c), max(r1, r)
            for j in (i - 1 if c > 0 else -1, i + 1 if c + 1 < cols else -1,
                      i - cols if r > 0 else -1, i + cols if r + 1 < rows else -1):
                if j >= 0 and grown[j] and not seen[j]:
                    seen[j] = 1
                    stack.append(j)
        if count:
            blobs.append({
                "cells": count,
                "centroid": (sx / count, sy / count),
                "bbox": (c0, r0, c1, r1),
                "touches_side": c0 == 0 or c1 == cols - 1,
                "touches_bottom": r1 == rows - 1,
            })
    blobs.sort(key=lambda b: -b["cells"])
    return blobs


def depth_at(depth_image, u: float, v: float, half_window: int = 4):
    """Median depth (m) of the valid pixels around (u, v) in a mono16/16UC1 (mm) or 32FC1 (m) image."""
    if depth_image is None:
        return None
    w, h = depth_image.width, depth_image.height
    cu, cv = int(round(u)), int(round(v))
    if not (0 <= cu < w and 0 <= cv < h):
        return None
    enc = (depth_image.encoding or "16UC1").lower()
    data = depth_image.data
    step = int(getattr(depth_image, "step", 0) or 0)
    values = []
    if enc in ("mono16", "16uc1"):
        step = step or w * 2
        big = bool(getattr(depth_image, "is_bigendian", 0))
        for y in range(max(0, cv - half_window), min(h, cv + half_window + 1)):
            for x in range(max(0, cu - half_window), min(w, cu + half_window + 1)):
                o = y * step + x * 2
                mm = (data[o] << 8 | data[o + 1]) if big else (data[o + 1] << 8 | data[o])
                if mm:
                    values.append(mm / 1000.0)
    elif enc == "32fc1":
        import struct

        step = step or w * 4
        fmt = ">f" if getattr(depth_image, "is_bigendian", 0) else "<f"
        for y in range(max(0, cv - half_window), min(h, cv + half_window + 1)):
            for x in range(max(0, cu - half_window), min(w, cu + half_window + 1)):
                o = y * step + x * 4
                m = struct.unpack(fmt, bytes(data[o:o + 4]))[0]
                if math.isfinite(m) and m > 0:
                    values.append(m)
    else:
        return None
    values = [m for m in values if DEPTH_MIN_M <= m <= DEPTH_MAX_M]
    if len(values) < 3:
        return None
    values.sort()
    return values[len(values) // 2]


def lidar_confirms(lidar, x: float, y: float):
    """
    True when the scan has an echo near (x, y) (bearing ± LIDAR_CONFIRM_HALF_ANGLE_DEG, range ±
    LIDAR_CONFIRM_TOLERANCE_M from the LiDAR), False when its rays there see past it, None without
    rays there. `lidar` is a list of (robot_angle_rad, range_m) with REP-117 values.
    """
    if not lidar:
        return None
    dx, dy = x - LIDAR_ORIGIN_XY[0], y - LIDAR_ORIGIN_XY[1]
    expected = math.hypot(dx, dy)
    target = math.atan2(dy, dx)
    half = math.radians(LIDAR_CONFIRM_HALF_ANGLE_DEG)
    rays = [r for a, r in lidar if abs(math.atan2(math.sin(a - target), math.cos(a - target))) <= half]
    if not rays:
        return None
    if any(math.isfinite(r) and abs(r - expected) <= LIDAR_CONFIRM_TOLERANCE_M for r in rays):
        return True
    return False


def detect_objects(scene: str, rgb, servos: dict, depth=None, lidar=None, stride: int = SAMPLE_STRIDE) -> list:
    """
    Finds the props of `scene` in one RGB frame (plus optional depth frame and LiDAR rays) taken with
    the arm at `servos`. Returns one detection per prop found, positions in base_link:
    {id, label, x_m, y_m, z_m, bearing_deg, distance_m, confidence, method, pixel, cells, lidar_confirmed}.
    """
    specs = SCENES[scene]
    names = []
    for spec in specs:
        if spec["color"] not in names:
            names.append(spec["color"])
    cells, cols, rows = color_grid(rgb, names, stride)
    sx, sy = stride, stride
    out = []
    for spec in specs:
        radius = TRAY_CLOSE_RADIUS if spec["kind"] == "tray" else TOTEM_CLOSE_RADIUS
        blobs = find_blobs(cells, cols, rows, names.index(spec["color"]) + 1, radius=radius)
        if not blobs or blobs[0]["cells"] < MIN_BLOB_CELLS:
            continue
        blob = blobs[0]
        if spec["kind"] == "tray":
            # The border outlines the mat: its box center is the mat center (the word sits low).
            c0, r0, c1, r1 = blob["bbox"]
            cu, cv = (c0 + c1) / 2.0, (r0 + r1) / 2.0
        else:
            cu, cv = blob["centroid"]
        u, v = cu * sx + sx / 2.0, cv * sy + sy / 2.0
        point = None
        method = "plane"
        if depth is not None:
            du, dv = rgb_to_depth_pixel(u, v, (rgb.width, rgb.height), (depth.width, depth.height))
            z = depth_at(depth, du, dv)
            if z is not None:
                point = pixel_depth_to_base(u * RGB_SIZE[0] / rgb.width, v * RGB_SIZE[1] / rgb.height, z, servos)
                method = "depth"
        if point is None:
            origin, direction = pixel_ray(u * RGB_SIZE[0] / rgb.width, v * RGB_SIZE[1] / rgb.height, servos)
            plane = TRAY_PLANE_Z_M if spec["kind"] == "tray" else TOTEM_PLANE_Z_M
            point = intersect_plane_z(origin, direction, plane)
        if point is None:
            continue
        confidence = 0.35 + 0.65 * min(1.0, blob["cells"] / FULL_CONFIDENCE_CELLS)
        if blob["touches_side"]:
            confidence *= SIDE_PENALTY
        # Off-center views see the prop in stronger perspective and clipped: trust them less, so the
        # bridge's aggregation favours the steps that had it in the middle of the image.
        confidence *= 1.0 - CENTERING_WEIGHT * min(1.0, abs(u - rgb.width / 2.0) / (rgb.width / 2.0))
        confirmed = lidar_confirms(lidar, point[0], point[1]) if spec["kind"] == "totem" else None
        if confirmed:
            confidence = min(1.0, confidence + 0.1)
        out.append({
            "id": spec["id"],
            "label": spec["label"],
            "x_m": round(point[0], 4),
            "y_m": round(point[1], 4),
            "z_m": round(point[2], 4),
            "bearing_deg": round(bearing_deg(point[0], point[1]), 2),
            "distance_m": round(math.hypot(point[0], point[1]), 4),
            "confidence": round(confidence, 3),
            "method": method,
            "pixel": [round(u, 1), round(v, 1)],
            "cells": blob["cells"],
            "lidar_confirmed": confirmed,
        })
    return out


# ---------------------------------------------------------------------------------------------
# Worker side: frame cache + background vision thread
# ---------------------------------------------------------------------------------------------
FRAME_WAIT_S = 1.2  # wait this long for an RGB frame newer than the request (the arm has settled)
DEPTH_WAIT_S = 0.3


class SceneScanner:
    """
    Keeps the newest RGB and depth frames and LiDAR rays (cheap: references only, from the ROS
    callbacks) and answers `scan_env_capture` requests on its own thread. `request()` is what the
    stdin thread calls: it only enqueues, so the heartbeat pong is never delayed by vision.
    """

    def __init__(self, emit, lidar_rays=None, clock=time.monotonic):
        self.emit = emit
        self.lidar_rays = lidar_rays  # LaserScan -> [(robot_angle_rad, range_m)] (mount corrected)
        self.clock = clock
        self.lock = threading.Lock()
        self.cond = threading.Condition(self.lock)
        self.rgb = None  # (msg, received_at)
        self.depth = None
        self.scan = None  # newest LaserScan
        self.queue = queue.Queue(maxsize=4)
        self.thread = None
        self.debug_dir = os.environ.get("SCAN_ENV_DEBUG_DIR", "").strip()

    def on_rgb(self, msg):
        with self.cond:
            self.rgb = (msg, self.clock())
            self.cond.notify_all()

    def on_depth(self, msg):
        with self.cond:
            self.depth = (msg, self.clock())
            self.cond.notify_all()

    def on_scan(self, msg):
        with self.lock:
            self.scan = msg

    def request(self, cmd: dict) -> None:
        """Non-blocking (stdin thread). A full queue answers `busy` right away."""
        try:
            cid = int(cmd.get("id", 0))
        except (TypeError, ValueError):
            cid = 0
        scene = str(cmd.get("scene", ""))
        if scene not in SCENES:
            self.emit({"event": "scan_env_result", "id": cid, "ok": False, "error": "unknown_scene"})
            return
        servos = cmd.get("servos") if isinstance(cmd.get("servos"), dict) else {}
        job = {"id": cid, "scene": scene, "servos": servos, "requested_at": self.clock()}
        if self.thread is None:
            self.thread = threading.Thread(target=self._run, name="scan-env", daemon=True)
            self.thread.start()
        try:
            self.queue.put_nowait(job)
        except queue.Full:
            self.emit({"event": "scan_env_result", "id": cid, "ok": False, "error": "busy"})

    def _frames_after(self, t0: float):
        deadline = t0 + FRAME_WAIT_S
        with self.cond:
            while (self.rgb is None or self.rgb[1] <= t0) and self.clock() < deadline:
                self.cond.wait(timeout=max(0.01, deadline - self.clock()))
            if self.rgb is None or self.rgb[1] <= t0:
                return None, None, None
            depth_deadline = self.clock() + DEPTH_WAIT_S
            while (self.depth is None or self.depth[1] <= t0) and self.clock() < depth_deadline:
                self.cond.wait(timeout=max(0.01, depth_deadline - self.clock()))
            depth = self.depth[0] if self.depth is not None and self.depth[1] > t0 else None
            return self.rgb[0], depth, self.scan

    def process(self, job: dict) -> dict:
        rgb, depth, scan = self._frames_after(job["requested_at"])
        if rgb is None:
            return {"event": "scan_env_result", "id": job["id"], "ok": False, "error": "no_rgb_frame"}
        lidar = self.lidar_rays(scan) if scan is not None and self.lidar_rays else None
        rgb = _as_bytes_image(rgb)
        depth = _as_bytes_image(depth) if depth is not None else None
        started = self.clock()
        detections = detect_objects(job["scene"], rgb, job["servos"], depth, lidar)
        if self.debug_dir:
            self._dump(job, rgb, detections)
        return {
            "event": "scan_env_result",
            "id": job["id"],
            "ok": True,
            "detections": detections,
            "depth": depth is not None,
            "vision_ms": round((self.clock() - started) * 1000),
        }

    def _run(self):
        while True:
            job = self.queue.get()
            try:
                self.emit(self.process(job))
            except Exception as exc:  # never kill the thread: answer the request with the error
                sys.stderr.write(f"[ros2_worker] scan_env error: {exc}\n")
                self.emit({"event": "scan_env_result", "id": job["id"], "ok": False, "error": "vision_error"})

    def _dump(self, job, rgb, detections):
        """SCAN_ENV_DEBUG_DIR: saves each capture (JPEG if cv2 is there) and its detections."""
        try:
            os.makedirs(self.debug_dir, exist_ok=True)
            stem = os.path.join(self.debug_dir, f"scan-{int(time.time())}-{job['id']}")
            with open(stem + ".json", "w", encoding="utf-8") as f:
                json.dump({"job": {k: job[k] for k in ("id", "scene", "servos")}, "detections": detections}, f, indent=2)
            import cv2
            import numpy as np

            (ri, gi, bi), px = _channel_order(rgb.encoding)
            step = rgb.step or rgb.width * px
            arr = np.frombuffer(rgb.data, dtype=np.uint8).reshape((rgb.height, step))
            arr = arr[:, : rgb.width * px].reshape((rgb.height, rgb.width, px))
            bgr = arr[:, :, [bi, gi, ri]]
            cv2.imwrite(stem + ".jpg", bgr)
        except Exception as exc:
            sys.stderr.write(f"[ros2_worker] scan_env debug dump failed: {exc}\n")


class _BytesImage:
    __slots__ = ("width", "height", "step", "encoding", "data", "is_bigendian")

    def __init__(self, msg):
        self.width = int(msg.width)
        self.height = int(msg.height)
        self.step = int(getattr(msg, "step", 0) or 0)
        self.encoding = str(getattr(msg, "encoding", ""))
        self.is_bigendian = int(getattr(msg, "is_bigendian", 0) or 0)
        data = msg.data
        self.data = data if isinstance(data, (bytes, bytearray)) else bytes(data)


def _as_bytes_image(msg):
    return _BytesImage(msg)
