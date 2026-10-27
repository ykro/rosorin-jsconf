#!/usr/bin/env python3
"""Unit tests for ros2_worker.py that run without rclpy or the Hiwonder Board.

Run: python3 -m unittest discover -s robot-bridge/scripts -p 'test_*.py'
"""
import io
import json
import math
import os
import signal
import sys
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ros2_worker as worker  # noqa: E402

BRAKE_M = 0.28  # must match LIDAR_BRAKE_M in backend.rs


def make_scan(points_deg, default=math.inf):
    """360 rays, 1 deg apart starting at -180 deg; `points_deg` maps degree -> range."""
    ranges = [default] * 360
    for deg, r in points_deg.items():
        ranges[(int(deg) + 180) % 360] = r
    return SimpleNamespace(
        angle_min=-math.pi,
        angle_increment=math.radians(1.0),
        range_min=0.05,
        range_max=12.0,
        ranges=ranges,
    )


class LidarSectorTests(unittest.TestCase):
    def test_wall_at_17cm_in_front_blocks(self):
        scan = make_scan({d: 0.17 for d in range(-45, 46)}, default=2.0)
        sectors = worker.compute_lidar_sectors(scan, 0.12, 35.0)
        self.assertAlmostEqual(sectors["front_m"], 0.17)
        self.assertLess(sectors["front_m"], BRAKE_M)

    def test_wall_at_17cm_only_inside_shadow_cone_blocks(self):
        scan = make_scan({d: 0.17 for d in range(-30, 31)})
        sectors = worker.compute_lidar_sectors(scan, 0.12, 35.0)
        self.assertAlmostEqual(sectors["front_m"], 0.17)

    def test_old_wide_filter_still_fails_closed(self):
        # With the previous 0.18 m filter a wall at 0.17 m used to vanish. A wall wider than the
        # shadow cone still has echoes outside it, so it blocks.
        scan = make_scan({d: 0.17 for d in range(-45, 46)})
        sectors = worker.compute_lidar_sectors(scan, 0.18, 35.0)
        self.assertAlmostEqual(sectors["front_m"], 0.17)
        self.assertLess(sectors["front_m"], BRAKE_M)

    def test_arm_shadow_ignored_when_sector_has_other_valid_rays(self):
        points = {d: 1.0 for d in range(-45, 46)}
        points.update({d: 0.08 for d in range(-10, 11)})  # arm
        sectors = worker.compute_lidar_sectors(make_scan(points), 0.12, 35.0)
        self.assertAlmostEqual(sectors["front_m"], 1.0)

    def test_arm_in_open_space_does_not_block(self):
        # Open stage (+inf) with only the arm in front: the arm is ignored and the front is open.
        scan = make_scan({d: 0.08 for d in range(-10, 11)})
        sectors = worker.compute_lidar_sectors(scan, 0.12, 35.0)
        self.assertEqual(sectors["front_m"], worker.LIDAR_OPEN_M)
        self.assertEqual(sectors["blind"], [])

    def test_only_shadow_rays_report_closest_filtered(self):
        # The arm is the only usable thing in the sector (the rest is NaN): it cannot see past it.
        scan = make_scan({d: 0.08 for d in range(-30, 31)}, default=math.nan)
        sectors = worker.compute_lidar_sectors(scan, 0.12, 35.0)
        self.assertAlmostEqual(sectors["front_m"], 0.08)
        self.assertLess(sectors["front_m"], BRAKE_M)

    def test_shadow_never_reports_other_sectors_max(self):
        points = {d: 0.10 for d in range(-45, 46)}  # every usable front ray is inside the band
        points.update({90: 3.0, -90: 3.5, 180: 5.0})
        sectors = worker.compute_lidar_sectors(make_scan(points, default=math.nan), 0.12, 90.0)
        self.assertAlmostEqual(sectors["front_m"], 0.10)

    def test_sector_mapping_rep103(self):
        scan = make_scan({0: 1.1, 90: 0.5, -90: 0.6, 180: 0.7}, default=3.0)
        sectors = worker.compute_lidar_sectors(scan, 0.12, 35.0)
        self.assertAlmostEqual(sectors["front_m"], 1.1)
        self.assertAlmostEqual(sectors["left_m"], 0.5)
        self.assertAlmostEqual(sectors["right_m"], 0.6)
        self.assertAlmostEqual(sectors["back_m"], 0.7)

    def test_open_stage_is_free_not_blind(self):
        # REP 117: +inf is "nothing within range". A stage with >12 m of empty space is open.
        sectors = worker.compute_lidar_sectors(make_scan({}), 0.12, 35.0)
        self.assertEqual(sectors["event"], "lidar")
        for name in ("front_m", "left_m", "right_m", "back_m"):
            self.assertEqual(sectors[name], worker.LIDAR_OPEN_M)
        self.assertEqual(sectors["blind"], [])
        # Finite values beyond range_max are free space too
        sectors = worker.compute_lidar_sectors(make_scan({}, default=15.0))
        self.assertEqual(sectors["front_m"], worker.LIDAR_OPEN_M)

    def test_covered_lidar_blocks_every_sector(self):
        for bad in (0.0, math.nan, -math.inf, 0.02):
            sectors = worker.compute_lidar_sectors(make_scan({}, default=bad))
            for name in ("front_m", "left_m", "right_m", "back_m"):
                self.assertEqual(sectors[name], 0.0, bad)
            self.assertEqual(sectors["blind"], ["front", "left", "right", "back"], bad)

    def test_sector_with_only_invalid_rays_is_blind(self):
        for bad in (-math.inf, math.nan, 0.0, 0.01):
            points = {d: bad for d in range(-45, 46)}
            sectors = worker.compute_lidar_sectors(make_scan(points, default=2.0))
            self.assertEqual(sectors["front_m"], 0.0, bad)
            self.assertLess(sectors["front_m"], BRAKE_M)
            self.assertEqual(sectors["blind"], ["front"], bad)
            self.assertAlmostEqual(sectors["left_m"], 2.0)

    def test_sparse_echoes_below_fraction_are_blind(self):
        # 9 of 91 front rays (~10%) see a far wall: below the 25% default -> blind
        points = {d: 3.0 for d in range(-45, 46, 10)}
        scan = make_scan(points, default=math.nan)
        sectors = worker.compute_lidar_sectors(scan, 0.12, 35.0, 0.06, 0.25)
        self.assertEqual(sectors["front_m"], 0.0)
        # Half of them valid -> real distance
        points = {d: 3.0 for d in range(-45, 46, 2)}
        scan = make_scan(points, default=math.nan)
        sectors = worker.compute_lidar_sectors(scan, 0.12, 35.0, 0.06, 0.25)
        self.assertAlmostEqual(sectors["front_m"], 3.0)
        self.assertNotIn("front", sectors["blind"])

    def cropped_scan(self, value=2.0):
        # This robot: LiDAR turned 180° and the driver filter keeps only 72°..291° raw, so with
        # offset 180 the robot's back has no rays at all.
        return SimpleNamespace(
            angle_min=math.radians(72.0), angle_increment=math.radians(0.9), range_min=0.1,
            range_max=10.0, ranges=[value] * 244,
        )

    def sectors_with_offset_180(self, scan, min_valid_fraction=0.25):
        old = worker.LIDAR_ANGLE_OFFSET_DEG
        worker.LIDAR_ANGLE_OFFSET_DEG = 180.0
        try:
            return worker.compute_lidar_sectors(scan, 0.12, 35.0, 0.06, min_valid_fraction)
        finally:
            worker.LIDAR_ANGLE_OFFSET_DEG = old

    def test_sector_cropped_out_of_the_scan_is_uncovered_not_blind(self):
        sectors = self.sectors_with_offset_180(self.cropped_scan())
        # 0.0 so a bridge that does not know `uncovered` fails closed
        self.assertEqual(sectors["back_m"], 0.0)
        self.assertEqual(sectors["uncovered"], ["back"])
        self.assertNotIn("back", sectors["blind"])
        self.assertAlmostEqual(sectors["front_m"], 2.0)
        # Uncovered does not depend on the blind check
        sectors = self.sectors_with_offset_180(self.cropped_scan(), min_valid_fraction=0.0)
        self.assertEqual(sectors["uncovered"], ["back"])

    def test_covered_lidar_is_blind_not_uncovered(self):
        # Rays present but all invalid (hand on the LiDAR): blind, never uncovered
        sectors = self.sectors_with_offset_180(self.cropped_scan(math.nan))
        self.assertEqual(sectors["blind"], ["front", "left", "right"])
        self.assertEqual(sectors["uncovered"], ["back"])
        sectors = worker.compute_lidar_sectors(make_scan({}, default=0.0))
        self.assertEqual(sectors["uncovered"], [])

    def test_min_valid_fraction_zero_disables_blind_check(self):
        scan = make_scan({}, default=math.nan)
        sectors = worker.compute_lidar_sectors(scan, 0.12, 35.0, 0.06, 0.0)
        self.assertEqual(sectors["front_m"], worker.LIDAR_OPEN_M)
        self.assertEqual(sectors["blind"], [])

    def test_pole_inside_shadow_cone_blocks_with_default_band(self):
        # Wall at 1 m everywhere in front, pole at 0.10 m at ±5 deg (inside the shadow cone):
        # with the default band (0.06-0.09 m) the pole is NOT the arm and blocks.
        points = {d: 1.0 for d in range(-45, 46)}
        points.update({d: 0.10 for d in range(-5, 6)})
        sectors = worker.compute_lidar_sectors(make_scan(points, default=2.0))
        self.assertAlmostEqual(sectors["front_m"], 0.10)
        self.assertLess(sectors["front_m"], BRAKE_M)

    def test_echo_closer_than_shadow_band_blocks(self):
        # Calibrated band 0.08-0.12 m: an object at 0.06 m is closer than the arm can be -> blocks
        points = {d: 1.0 for d in range(-45, 46)}
        points.update({d: 0.10 for d in range(-10, 11)})  # arm, inside the band: ignored
        points.update({d: 0.06 for d in range(20, 23)})  # obstacle under the band
        sectors = worker.compute_lidar_sectors(make_scan(points, default=2.0), 0.12, 35.0, 0.08)
        self.assertAlmostEqual(sectors["front_m"], 0.06)

    def test_calibrated_arm_inside_band_is_still_ignored(self):
        points = {d: 1.0 for d in range(-45, 46)}
        points.update({d: 0.075 for d in range(-8, 9)})  # arm at 7.5 cm, default band 0.06-0.09
        sectors = worker.compute_lidar_sectors(make_scan(points, default=2.0))
        self.assertAlmostEqual(sectors["front_m"], 1.0)

    def test_env_defaults(self):
        values, _ = worker.load_arm_shadow("/nonexistent/arm-shadow.json", env={})
        self.assertEqual(values, {"min_m": 0.06, "max_m": 0.09, "half_angle_deg": 20.0})
        self.assertEqual(
            worker.LIDAR_MIN_VALID_FRACTION,
            float(os.environ.get("LIDAR_MIN_VALID_FRACTION", 0.25)),
        )


class ScanOrientationTests(unittest.TestCase):
    def test_offset_180_swaps_front_and_back(self):
        scan = make_scan({0: 0.5, 180: 2.0}, default=3.0)
        normal = worker.compute_lidar_sectors(scan)
        self.assertAlmostEqual(normal["front_m"], 0.5)
        old = worker.LIDAR_ANGLE_OFFSET_DEG
        worker.LIDAR_ANGLE_OFFSET_DEG = 180.0
        try:
            rotated = worker.compute_lidar_sectors(scan)
        finally:
            worker.LIDAR_ANGLE_OFFSET_DEG = old
        self.assertAlmostEqual(rotated["front_m"], 2.0)
        self.assertAlmostEqual(rotated["back_m"], 0.5)

    def test_flip_swaps_left_and_right(self):
        self.assertAlmostEqual(worker.robot_angle(math.radians(90), 0.0, True), math.radians(-90))
        self.assertAlmostEqual(worker.robot_angle(math.radians(90), 0.0, False), math.radians(90))
        self.assertAlmostEqual(abs(worker.robot_angle(0.0, 180.0, False)), math.pi)


class ArmShadowCalibrationTests(unittest.TestCase):
    def setUp(self):
        import tempfile

        self.tmp = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.tmp.name, "arm-shadow.json")

    def tearDown(self):
        self.tmp.cleanup()

    def test_calibration_file_overrides_defaults(self):
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump({"min_m": 0.07, "max_m": 0.13, "half_angle_deg": 28.0}, f)
        values, source = worker.load_arm_shadow(self.path, env={})
        self.assertEqual(values, {"min_m": 0.07, "max_m": 0.13, "half_angle_deg": 28.0})
        self.assertIn(self.path, source)

    def test_environment_overrides_file(self):
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump({"min_m": 0.07, "max_m": 0.13, "half_angle_deg": 28.0}, f)
        values, source = worker.load_arm_shadow(self.path, env={"ARM_SHADOW_MAX_M": "0.2"})
        self.assertEqual(values["max_m"], 0.2)
        self.assertEqual(values["min_m"], 0.07)
        self.assertEqual(source, "environment")

    def test_invalid_file_falls_back_to_defaults(self):
        with open(self.path, "w", encoding="utf-8") as f:
            f.write("{not json")
        values, source = worker.load_arm_shadow(self.path, env={})
        self.assertEqual(values, worker.ARM_SHADOW_DEFAULTS)
        self.assertEqual(source, "defaults")



class LidarMountTests(unittest.TestCase):
    def setUp(self):
        import tempfile

        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "lidar-mount.json")

    def tearDown(self):
        import shutil

        shutil.rmtree(self.dir, ignore_errors=True)

    def test_defaults_without_file(self):
        self.assertEqual(worker.load_lidar_mount(self.path, env={}), ({"offset_deg": 0.0, "flip": False}, "defaults"))

    def test_file_sets_offset(self):
        with open(self.path, "w") as f:
            json.dump({"offset_deg": 180, "flip": False}, f)
        values, source = worker.load_lidar_mount(self.path, env={})
        self.assertEqual(values, {"offset_deg": 180.0, "flip": False})
        self.assertTrue(source.startswith("file "))

    def test_environment_wins_over_file(self):
        with open(self.path, "w") as f:
            json.dump({"offset_deg": 180}, f)
        values, source = worker.load_lidar_mount(self.path, env={"LIDAR_ANGLE_OFFSET_DEG": "0", "LIDAR_FLIP": "1"})
        self.assertEqual(values, {"offset_deg": 0.0, "flip": True})
        self.assertEqual(source, "environment")

class HeartbeatTests(unittest.TestCase):
    def test_ping_is_echoed_as_pong(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.assertTrue(worker.reply_ping({"op": "ping", "seq": 41}))
            self.assertFalse(worker.reply_ping({"op": "cmd_vel", "linear_x": 0.1}))
        lines = buf.getvalue().splitlines()
        self.assertEqual([json.loads(l) for l in lines], [{"event": "pong", "seq": 41}])

    def test_board_command_loop_answers_ping_without_touching_hardware(self):
        class NoBoard:
            def __getattr__(self, name):
                raise AssertionError(f"ping must not touch the board ({name})")

        buf = io.StringIO()
        with redirect_stdout(buf):
            worker.handle_board_command(NoBoard(), {"op": "ping", "seq": 7}, {})
        self.assertEqual(json.loads(buf.getvalue()), {"event": "pong", "seq": 7})

    def test_board_main_builds_telemetry_before_first_line_and_ignores_sigint(self):
        # The rclpy/cv2 imports hold the GIL: done after the first line they delay the pongs.
        calls = []
        saved = {n: getattr(worker, n) for n in (
            "init_board", "create_telemetry_node", "start_telemetry", "emit",
            "battery_poller", "board_watchdog_loop", "zero_board_motors")}
        try:
            worker.init_board = lambda: object()
            worker.create_telemetry_node = lambda: calls.append("telemetry") or "node"
            worker.start_telemetry = lambda node: calls.append(f"spin:{node}")
            worker.emit = lambda event: calls.append(event.get("event"))
            worker.battery_poller = lambda *a: None
            worker.board_watchdog_loop = lambda *a: None
            worker.zero_board_motors = lambda *a: None
            stdin, sys.stdin = sys.stdin, io.StringIO("")
            sigint = signal.getsignal(signal.SIGINT)
            try:
                worker.main()
                # Ctrl+C belongs to the bridge: the worker waits for stdin EOF
                self.assertIs(signal.getsignal(signal.SIGINT), signal.SIG_IGN)
            finally:
                sys.stdin = stdin
                signal.signal(signal.SIGINT, sigint)
        finally:
            for n, f in saved.items():
                setattr(worker, n, f)
        self.assertEqual(calls, ["telemetry", "backend", "spin:node"])


class EmitTests(unittest.TestCase):
    def test_emit_writes_one_json_line(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            worker.emit({"event": "battery", "mv": 11800})
        lines = buf.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0]), {"event": "battery", "mv": 11800})


if __name__ == "__main__":
    unittest.main()
