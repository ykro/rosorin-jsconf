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
        sectors = worker.compute_lidar_sectors(scan, 0.12, 35.0)
        self.assertAlmostEqual(sectors["front_m"], 0.08)

    def test_shadow_never_reports_other_sectors_max(self):
        points = {d: 0.10 for d in range(-20, 21)}  # all front rays filtered
        points.update({90: 3.0, -90: 3.5, 180: 5.0})
        sectors = worker.compute_lidar_sectors(make_scan(points), 0.12, 35.0)
        self.assertAlmostEqual(sectors["front_m"], 0.10)

    def test_sector_mapping_rep103(self):
        scan = make_scan({0: 1.1, 90: 0.5, -90: 0.6, 180: 0.7})
        sectors = worker.compute_lidar_sectors(scan, 0.12, 35.0)
        self.assertAlmostEqual(sectors["front_m"], 1.1)
        self.assertAlmostEqual(sectors["left_m"], 0.5)
        self.assertAlmostEqual(sectors["right_m"], 0.6)
        self.assertAlmostEqual(sectors["back_m"], 0.7)

    def test_no_returns_reports_open(self):
        sectors = worker.compute_lidar_sectors(make_scan({}), 0.12, 35.0)
        self.assertEqual(sectors["front_m"], 4.0)
        self.assertEqual(sectors["event"], "lidar")

    def test_env_defaults(self):
        self.assertEqual(worker.ARM_SHADOW_MAX_M, float(os.environ.get("ARM_SHADOW_MAX_M", 0.12)))
        self.assertEqual(
            worker.ARM_SHADOW_HALF_ANGLE_DEG,
            float(os.environ.get("ARM_SHADOW_HALF_ANGLE_DEG", 35.0)),
        )


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
