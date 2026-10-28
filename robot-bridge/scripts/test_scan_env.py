#!/usr/bin/env python3
"""Unit tests for scan_env.py («Reconocer entorno»): geometry, segmentation and the capture thread.

Pure Python (no numpy, rclpy or camera). Run:
python3 -m unittest discover -s robot-bridge/scripts -p 'test_*.py'
"""
import io
import json
import math
import os
import sys
import time
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import scan_env as se  # noqa: E402
import ros2_worker as worker  # noqa: E402

# The survey pose the bridge uses (SURVEY_POSE in robot-bridge/src/scan_env.rs) at a given joint1.
SURVEY = {"2": 520, "3": 215, "4": 195}


def survey(j1: int) -> dict:
    return {"1": j1, **SURVEY}


def project(point, servos):
    """base_link point → RGB pixel (forward model: inverse pose, pinhole, plumb_bob)."""
    origin, rot = se.camera_pose(servos)
    d = [point[i] - origin[i] for i in range(3)]
    cx = sum(d[i] * rot[i][0] for i in range(3))  # camera_link x (forward)
    cy = sum(d[i] * rot[i][1] for i in range(3))
    cz = sum(d[i] * rot[i][2] for i in range(3))
    xo, yo, zo = -cy, -cz, cx  # optical frame
    return se.distort_normalized(xo / zo, yo / zo, se.RGB_K, se.RGB_D), zo


def blank_image(width=640, height=400, bgr=(235, 235, 235)):
    row = bytes(bgr) * width
    return SimpleNamespace(width=width, height=height, step=width * 3, encoding="bgr8",
                           data=bytearray(row * height))


def paint_floor_rect(img, servos, cx, cy, half_x, half_y, z, bgr):
    """Paints the projection of a horizontal rectangle (center cx, cy; height z) into `img`."""
    corners = [(cx - half_x, cy - half_y), (cx + half_x, cy - half_y), (cx + half_x, cy + half_y), (cx - half_x, cy + half_y)]
    poly = [project((x, y, z), servos)[0] for x, y in corners]
    paint_polygon(img, poly, bgr)


def paint_polygon(img, poly, bgr):
    us = [p[0] for p in poly]
    vs = [p[1] for p in poly]
    u0, u1 = max(0, int(min(us))), min(img.width - 1, int(max(us)) + 1)
    v0, v1 = max(0, int(min(vs))), min(img.height - 1, int(max(vs)) + 1)
    n = len(poly)
    for v in range(v0, v1 + 1):
        for u in range(u0, u1 + 1):
            inside = False
            for i in range(n):
                (xa, ya), (xb, yb) = poly[i], poly[(i + 1) % n]
                if (ya > v) != (yb > v) and u < (xb - xa) * (v - ya) / (yb - ya) + xa:
                    inside = not inside
            if inside:
                o = v * img.step + u * 3
                img.data[o:o + 3] = bytes(bgr)


def paint_box(img, u0, v0, u1, v1, bgr):
    for v in range(max(0, v0), min(img.height, v1)):
        o = v * img.step
        img.data[o + max(0, u0) * 3:o + min(img.width, u1) * 3] = bytes(bgr) * (min(img.width, u1) - max(0, u0))


GREEN = (0x3E, 0x8E, 0x1E)  # #1E8E3E as BGR
RED = (0x25, 0x30, 0xD9)  # #D93025
BLUE = (0xE8, 0x73, 0x1A)  # #1A73E8
YELLOW = (0x00, 0xAB, 0xF9)  # #F9AB00


class GeometryTests(unittest.TestCase):
    def test_undistort_inverts_distort(self):
        for u, v in ((10, 10), (320, 200), (600, 380), (100, 350)):
            x, y = se.undistort_pixel(u, v)
            uu, vv = se.distort_normalized(x, y, se.RGB_K, se.RGB_D)
            self.assertAlmostEqual(uu, u, places=3)
            self.assertAlmostEqual(vv, v, places=3)

    def test_camera_looks_forward_at_home_and_down_in_the_survey_pose(self):
        origin, rot = se.camera_pose({"1": 500, "2": 430, "3": 310, "4": 380})
        self.assertGreater(rot[0][0], 0.99)  # camera_link x = forward
        self.assertAlmostEqual(origin[1], 0.0, places=2)
        origin, rot = se.camera_pose(survey(500))
        pitch_down = math.degrees(math.asin(-rot[2][0]))
        self.assertGreater(pitch_down, 45)
        self.assertLess(pitch_down, 65)
        # Camera above the LiDAR tower (z 0.107) and in front of the turret
        self.assertGreater(origin[2], 0.2)
        self.assertGreater(origin[0], 0.1)

    def test_survey_pose_keeps_the_arm_away_from_the_lidar_plane(self):
        import calibrar_sombra as cal

        for j1 in range(280, 721, 44):  # every pause of the sweep (SCAN_J1_MIN..SCAN_J1_MAX)
            self.assertGreater(cal.scan_clearance((j1, 520, 215, 195, 500, 500)), 0.08)
            points = cal.arm_points((j1, 520, 215, 195, 500, 500))[1:]
            self.assertGreater(min(p[2] for p in points), 0.18)

    def test_floor_point_round_trips_through_the_ray(self):
        for j1, point in ((500, (0.35, 0.0, se.FLOOR_Z_M)), (700, (0.24, 0.22, se.FLOOR_Z_M)), (300, (0.25, -0.20, se.FLOOR_Z_M))):
            (u, v), _ = project(point, survey(j1))
            self.assertTrue(0 <= u < 640 and 0 <= v < 400, (u, v))
            origin, direction = se.pixel_ray(u, v, survey(j1))
            hit = se.intersect_plane_z(origin, direction, se.FLOOR_Z_M)
            for a, b in zip(hit, point):
                self.assertAlmostEqual(a, b, places=4)

    def test_depth_projection_matches_the_point(self):
        point = (0.45, 0.05, 0.02)
        (u, v), depth = project(point, survey(500))
        got = se.pixel_depth_to_base(u, v, depth, survey(500))
        for a, b in zip(got, point):
            self.assertAlmostEqual(a, b, places=4)

    def test_rgb_pixel_maps_to_the_same_ray_in_depth(self):
        du, dv = se.rgb_to_depth_pixel(se.RGB_K[2], se.RGB_K[3])
        # The principal points differ by a few pixels; the ray is the same
        self.assertAlmostEqual(du, se.DEPTH_K[2], delta=1.0)
        self.assertAlmostEqual(dv, se.DEPTH_K[3], delta=1.0)
        x, y = se.undistort_pixel(500, 300)
        xd, yd = se.undistort_pixel(*se.rgb_to_depth_pixel(500, 300), se.DEPTH_K, se.DEPTH_D)
        self.assertAlmostEqual(x, xd, places=4)
        self.assertAlmostEqual(y, yd, places=4)
        # Half-resolution frames scale the intrinsics
        hu, hv = se.rgb_to_depth_pixel(250, 150, (320, 200), (320, 200))
        fu, fv = se.rgb_to_depth_pixel(500, 300)
        self.assertAlmostEqual(hu * 2, fu, places=3)
        self.assertAlmostEqual(hv * 2, fv, places=3)

    def test_intersect_rejects_rays_that_never_reach_the_plane(self):
        self.assertIsNone(se.intersect_plane_z([0, 0, 0.3], [1, 0, 0], 0.0))
        self.assertIsNone(se.intersect_plane_z([0, 0, 0.3], [1, 0, 0.2], 0.0))

    def test_bearing_and_joint1_follow_the_twin_mapping(self):
        self.assertAlmostEqual(se.bearing_deg(1.0, 0.0), 0.0)
        self.assertAlmostEqual(se.bearing_deg(0.0, 1.0), 90.0)  # + = left (REP-103)
        self.assertEqual(se.joint1_for_point(0.5, 0.0), 500)
        # 0.24° per pulse about the joint1 axis (x = 0.04662): 48° left = 700
        y = (0.3 - se.J1_AXIS_X_M) * math.tan(math.radians(48.0))
        self.assertEqual(se.joint1_for_point(0.3, y), 700)
        self.assertEqual(se.joint1_for_point(0.3, -y), 300)
        # Default APROBADO tray (18 cm forward, 19 cm left) is past 700
        self.assertGreater(se.joint1_for_point(0.18, 0.19), 700)
        # Clamped to the aim range
        self.assertEqual(se.joint1_for_point(-0.5, 0.01), 750)
        self.assertEqual(se.joint1_for_point(-0.5, -0.01), 250)


class ColorTests(unittest.TestCase):
    def test_printed_colors_classify(self):
        names = ("green", "red", "blue", "yellow")
        for hexcolor, expected in (("1E8E3E", "green"), ("137333", "green"), ("D93025", "red"),
                                   ("1A73E8", "blue"), ("F9AB00", "yellow")):
            r, g, b = (int(hexcolor[i:i + 2], 16) for i in (0, 2, 4))
            self.assertEqual(se.classify_color(*se.rgb_to_hsv(r, g, b), names), expected, hexcolor)

    def test_paper_wood_and_pale_tints_are_ignored(self):
        names = ("green", "red", "blue", "yellow")
        for hexcolor in ("FFFFFF", "F1F3F4", "E6F4EA", "FCE8E6", "C8A27A", "202124", "808080", "B06000"):
            r, g, b = (int(hexcolor[i:i + 2], 16) for i in (0, 2, 4))
            self.assertEqual(se.classify_color(*se.rgb_to_hsv(r, g, b), names), "", hexcolor)

    def test_blobs_are_closed_and_small_specks_dropped(self):
        img = blank_image(80, 40)
        # A dashed line (gaps of 2 px) is one blob after closing at stride 1
        for u in range(10, 60, 4):
            paint_box(img, u, 10, u + 2, 14, GREEN)
        paint_box(img, 70, 30, 71, 31, GREEN)  # one-pixel speck
        cells, cols, rows = se.color_grid(img, ("green",), stride=1)
        blobs = se.find_blobs(cells, cols, rows, 1, radius=2)
        self.assertGreaterEqual(len(blobs), 2)
        self.assertEqual(blobs[0]["bbox"][0], 10)
        self.assertEqual(blobs[0]["bbox"][2], 59)
        self.assertEqual(blobs[-1]["cells"], 1)


class DetectTests(unittest.TestCase):
    def test_trays_swapped_are_found_where_they_are(self):
        j1 = 720  # looking left
        servos = survey(j1)
        img = blank_image()
        # Red RECHAZADO tray on the LEFT this time (swapped from the default layout)
        paint_floor_rect(img, servos, 0.24, 0.22, 0.054, 0.093, se.FLOOR_Z_M, RED)
        found = se.detect_objects("gatekeeper", img, servos)
        ids = [d["id"] for d in found]
        self.assertEqual(ids, ["reject_tray"])
        d = found[0]
        self.assertEqual(d["method"], "plane")
        self.assertAlmostEqual(d["x_m"], 0.24, delta=0.03)
        self.assertAlmostEqual(d["y_m"], 0.22, delta=0.03)
        self.assertGreater(d["bearing_deg"], 30)
        self.assertGreater(d["confidence"], 0.5)

    def test_partly_visible_tray_is_less_confident(self):
        servos = survey(500)  # the tray is at the left edge of the image
        img = blank_image()
        paint_floor_rect(img, servos, 0.24, 0.22, 0.054, 0.093, se.FLOOR_Z_M, GREEN)
        found = se.detect_objects("gatekeeper", img, servos)
        self.assertEqual([d["id"] for d in found], ["approve_tray"])
        full = se.detect_objects("gatekeeper", self._tray_image(720, GREEN), survey(720))[0]
        self.assertLess(found[0]["confidence"], full["confidence"])

    def _tray_image(self, j1, color):
        img = blank_image()
        paint_floor_rect(img, survey(j1), 0.24, 0.22, 0.054, 0.093, se.FLOOR_Z_M, color)
        return img

    def test_tiny_blob_is_not_a_tray(self):
        img = blank_image()
        paint_box(img, 300, 200, 306, 206, GREEN)
        self.assertEqual(se.detect_objects("gatekeeper", img, survey(500)), [])

    def test_totems_use_their_color_band_height(self):
        servos = survey(500)
        img = blank_image()
        z = se.TOTEM_PLANE_Z_M
        for color, y in ((BLUE, 0.11), (GREEN, 0.0), (YELLOW, -0.11)):
            paint_floor_rect(img, servos, 0.36, y, 0.015, 0.028, z, color)
        found = {d["id"]: d for d in se.detect_objects("bughunter", img, servos)}
        self.assertEqual(set(found), {"cloud_run", "gemini_live", "firestore"})
        self.assertAlmostEqual(found["cloud_run"]["y_m"], 0.11, delta=0.025)
        self.assertAlmostEqual(found["gemini_live"]["y_m"], 0.0, delta=0.025)
        self.assertAlmostEqual(found["firestore"]["y_m"], -0.11, delta=0.025)
        self.assertGreater(found["cloud_run"]["bearing_deg"], 0)
        self.assertLess(found["firestore"]["bearing_deg"], 0)
        # Green means a tray only in the gatekeeper scene
        self.assertEqual([d["id"] for d in se.detect_objects("gatekeeper", img, servos)], ["approve_tray"])

    def test_valid_depth_wins_over_the_plane(self):
        servos = survey(500)
        img = blank_image()
        point = (0.42, 0.0, 0.05)
        (u, v), depth_m = project(point, servos)
        paint_box(img, int(u) - 20, int(v) - 20, int(u) + 20, int(v) + 20, BLUE)
        w, h = 640, 400
        mm = int(round(depth_m * 1000))
        depth = SimpleNamespace(width=w, height=h, step=w * 2, encoding="mono16", is_bigendian=0,
                                data=bytes([mm & 0xFF, mm >> 8]) * (w * h))
        d = se.detect_objects("bughunter", img, servos, depth)[0]
        self.assertEqual(d["method"], "depth")
        self.assertAlmostEqual(d["x_m"], point[0], delta=0.01)
        self.assertAlmostEqual(d["z_m"], point[2], delta=0.01)
        # Invalid depth (zeros or too close) falls back to the plane
        zero = SimpleNamespace(width=w, height=h, step=w * 2, encoding="16UC1", is_bigendian=0, data=bytes(w * h * 2))
        self.assertEqual(se.detect_objects("bughunter", img, servos, zero)[0]["method"], "plane")
        self.assertIsNone(se.depth_at(zero, 10, 10))

    def test_lidar_confirmation(self):
        x, y = 0.40, 0.10
        bearing = math.atan2(y - se.LIDAR_ORIGIN_XY[1], x - se.LIDAR_ORIGIN_XY[0])
        expected = math.hypot(x - se.LIDAR_ORIGIN_XY[0], y - se.LIDAR_ORIGIN_XY[1])
        self.assertTrue(se.lidar_confirms([(bearing, expected + 0.03)], x, y))
        self.assertFalse(se.lidar_confirms([(bearing, math.inf)], x, y))
        self.assertIsNone(se.lidar_confirms([(bearing + 1.0, expected)], x, y))
        self.assertIsNone(se.lidar_confirms(None, x, y))


class ScannerThreadTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.scanner = se.SceneScanner(self.events.append)

    def wait_for(self, n, timeout=5.0):
        deadline = time.monotonic() + timeout
        while len(self.events) < n and time.monotonic() < deadline:
            time.sleep(0.01)

    def test_request_returns_at_once_and_answers_after_a_fresh_frame(self):
        servos = survey(720)
        img = blank_image()
        paint_floor_rect(img, servos, 0.24, 0.22, 0.054, 0.093, se.FLOOR_Z_M, GREEN)
        self.scanner.on_rgb(img)  # older than the request: must not be used
        t0 = time.monotonic()
        self.scanner.request({"op": "scan_env_capture", "id": 7, "scene": "gatekeeper", "servos": servos})
        self.assertLess(time.monotonic() - t0, 0.05)
        time.sleep(0.05)
        self.assertEqual(self.events, [])
        self.scanner.on_rgb(img)
        self.wait_for(1)
        ev = self.events[0]
        self.assertEqual((ev["event"], ev["id"], ev["ok"]), ("scan_env_result", 7, True))
        self.assertEqual([d["id"] for d in ev["detections"]], ["approve_tray"])
        self.assertFalse(ev["depth"])

    def test_no_frame_answers_an_error(self):
        old = se.FRAME_WAIT_S
        se.FRAME_WAIT_S = 0.1
        try:
            self.scanner.request({"op": "scan_env_capture", "id": 3, "scene": "bughunter", "servos": {}})
            self.wait_for(1)
        finally:
            se.FRAME_WAIT_S = old
        self.assertEqual(self.events[0], {"event": "scan_env_result", "id": 3, "ok": False, "error": "no_rgb_frame"})

    def test_unknown_scene_is_refused(self):
        self.scanner.request({"op": "scan_env_capture", "id": 4, "scene": "kitchen"})
        self.assertEqual(self.events[0]["error"], "unknown_scene")


class WorkerProtocolTests(unittest.TestCase):
    def test_capture_op_only_enqueues_and_pings_still_answer(self):
        calls = []
        original = worker.SCANNER.request
        worker.SCANNER.request = lambda cmd: calls.append(cmd)
        try:
            out = io.StringIO()
            vel_state = {"lock": __import__("threading").Lock(), "last_cmd_at": 0.0, "moving": False}
            board = SimpleNamespace()
            with redirect_stdout(out):
                t0 = time.monotonic()
                worker.handle_board_command(board, {"op": "scan_env_capture", "id": 1, "scene": "gatekeeper"}, vel_state)
                worker.handle_board_command(board, {"op": "ping", "seq": 9}, vel_state)
                elapsed = time.monotonic() - t0
        finally:
            worker.SCANNER.request = original
        self.assertEqual(len(calls), 1)
        self.assertLess(elapsed, 0.05)
        self.assertEqual(json.loads(out.getvalue().strip()), {"event": "pong", "seq": 9})

    def test_scan_rays_apply_the_mount(self):
        scan = SimpleNamespace(angle_min=0.0, angle_increment=math.pi / 2, ranges=[1.0, 2.0])
        rays = worker.scan_rays(scan)
        self.assertEqual(len(rays), 2)
        self.assertAlmostEqual(rays[0][0], worker.robot_angle(0.0))
        self.assertEqual(rays[1][1], 2.0)


if __name__ == "__main__":
    unittest.main()
