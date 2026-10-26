#!/usr/bin/env python3
"""Unit tests for ros2_worker.py that run without rclpy or the Hiwonder Board.

Run: python3 -m unittest discover -s robot-bridge/scripts -p 'test_*.py'
"""
import io
import json
import math
import os
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
        # With the previous 0.18 m filter the wall used to vanish (front=open). Now it blocks.
        scan = make_scan({d: 0.17 for d in range(-30, 31)})
        sectors = worker.compute_lidar_sectors(scan, 0.18, 35.0)
        self.assertAlmostEqual(sectors["front_m"], 0.17)
        self.assertLess(sectors["front_m"], BRAKE_M)

    def test_arm_shadow_ignored_when_sector_has_other_valid_rays(self):
        points = {d: 1.0 for d in range(-45, 46)}
        points.update({d: 0.08 for d in range(-10, 11)})  # arm
        sectors = worker.compute_lidar_sectors(make_scan(points), 0.12, 35.0)
        self.assertAlmostEqual(sectors["front_m"], 1.0)

    def test_only_shadow_rays_report_closest_filtered(self):
        scan = make_scan({d: 0.08 for d in range(-10, 11)})
        # Legacy rule in isolation (no blind-sector check)
        sectors = worker.compute_lidar_sectors(scan, 0.12, 35.0, 0.06, 0.0)
        self.assertAlmostEqual(sectors["front_m"], 0.08)
        # With the default blind-sector check (21/91 echoes) it blocks even harder
        sectors = worker.compute_lidar_sectors(scan, 0.12, 35.0)
        self.assertLess(sectors["front_m"], BRAKE_M)

    def test_shadow_never_reports_other_sectors_max(self):
        points = {d: 0.10 for d in range(-20, 21)}  # all front rays filtered
        points.update({90: 3.0, -90: 3.5, 180: 5.0})
        sectors = worker.compute_lidar_sectors(make_scan(points), 0.12, 35.0)
        self.assertAlmostEqual(sectors["front_m"], 0.10)

    def test_sector_mapping_rep103(self):
        scan = make_scan({0: 1.1, 90: 0.5, -90: 0.6, 180: 0.7}, default=3.0)
        sectors = worker.compute_lidar_sectors(scan, 0.12, 35.0)
        self.assertAlmostEqual(sectors["front_m"], 1.1)
        self.assertAlmostEqual(sectors["left_m"], 0.5)
        self.assertAlmostEqual(sectors["right_m"], 0.6)
        self.assertAlmostEqual(sectors["back_m"], 0.7)

    def test_no_returns_reports_blocked(self):
        # Every ray inf: nothing seen is NOT "open" (fails closed)
        sectors = worker.compute_lidar_sectors(make_scan({}), 0.12, 35.0)
        self.assertEqual(sectors["event"], "lidar")
        for name in ("front_m", "left_m", "right_m", "back_m"):
            self.assertEqual(sectors[name], 0.0)
        self.assertEqual(sectors["blind"], ["front", "left", "right", "back"])

    def test_sector_with_only_invalid_rays_is_blind(self):
        for bad in (math.inf, -math.inf, math.nan, 0.0, 0.01):
            points = {d: bad for d in range(-45, 46)}
            sectors = worker.compute_lidar_sectors(make_scan(points, default=2.0))
            self.assertEqual(sectors["front_m"], 0.0, bad)
            self.assertLess(sectors["front_m"], BRAKE_M)
            self.assertEqual(sectors["blind"], ["front"], bad)
            self.assertAlmostEqual(sectors["left_m"], 2.0)

    def test_sparse_echoes_below_fraction_are_blind(self):
        # 9 of 91 front rays (~10%) see a far wall: below the 25% default -> blind
        points = {d: 3.0 for d in range(-45, 46, 10)}
        sectors = worker.compute_lidar_sectors(make_scan(points), 0.12, 35.0, 0.06, 0.25)
        self.assertEqual(sectors["front_m"], 0.0)
        # Half of them valid -> real distance
        points = {d: 3.0 for d in range(-45, 46, 2)}
        sectors = worker.compute_lidar_sectors(make_scan(points), 0.12, 35.0, 0.06, 0.25)
        self.assertAlmostEqual(sectors["front_m"], 3.0)
        self.assertNotIn("front", sectors["blind"])

    def test_min_valid_fraction_zero_restores_open(self):
        sectors = worker.compute_lidar_sectors(make_scan({}), 0.12, 35.0, 0.06, 0.0)
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
        self.assertEqual(worker.ARM_SHADOW_MIN_M, float(os.environ.get("ARM_SHADOW_MIN_M", 0.06)))
        self.assertEqual(worker.ARM_SHADOW_MAX_M, float(os.environ.get("ARM_SHADOW_MAX_M", 0.09)))
        self.assertEqual(
            worker.ARM_SHADOW_HALF_ANGLE_DEG,
            float(os.environ.get("ARM_SHADOW_HALF_ANGLE_DEG", 20.0)),
        )
        self.assertEqual(
            worker.LIDAR_MIN_VALID_FRACTION,
            float(os.environ.get("LIDAR_MIN_VALID_FRACTION", 0.25)),
        )


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
