#!/usr/bin/env python3
"""Unit tests for calibrar_sombra.py (pure functions, no rclpy or bridge needed)."""
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import calibrar_sombra as cal  # noqa: E402


class GesturePosesTests(unittest.TestCase):
    def test_parses_unique_poses_and_skips_signature(self):
        rust = """
        fn pose(j1: u16, j2: u16, j3: u16, j4: u16, j5: u16, gripper_10: u16) -> Vec<ServoTarget> {}
        servos: pose(500, 520, 200, 220, 500, 680),
        servos: pose(340, 520, 200, 220, 360, 680),
        servos: pose(500, 520, 200, 220, 500, 680),
        """
        self.assertEqual(
            cal.gesture_poses(rust),
            [(500, 520, 200, 220, 500, 680), (340, 520, 200, 220, 360, 680)],
        )

    def test_real_gestures_file_has_poses(self):
        with open(cal.GESTURES_RS, encoding="utf-8") as f:
            poses = cal.gesture_poses(f.read())
        self.assertGreater(len(poses), 10)
        self.assertTrue(all(len(p) == 6 for p in poses))


class AnalyzeShadowTests(unittest.TestCase):
    def test_band_covers_arm_echoes_with_margin(self):
        samples = [(math.radians(d), 0.08 + d / 1000) for d in range(-15, 16)]
        band = cal.analyze_shadow(samples)
        self.assertAlmostEqual(band["min_m"], 0.055, places=3)
        self.assertAlmostEqual(band["max_m"], 0.105, places=3)
        self.assertAlmostEqual(band["half_angle_deg"], 17.0)
        self.assertEqual(band["echoes"], 31)

    def test_min_never_below_range_min(self):
        band = cal.analyze_shadow([(0.0, 0.055)], range_min=0.05)
        self.assertEqual(band["min_m"], 0.05)

    def test_no_arm_echo_disables_filter(self):
        band = cal.analyze_shadow([(0.0, math.inf), (0.1, 2.0)])
        self.assertEqual(band["max_m"], 0.0)
        self.assertEqual(band["echoes"], 0)

    def test_ignores_far_and_invalid_echoes(self):
        band = cal.analyze_shadow([(0.0, 0.09), (0.2, 0.5), (0.3, math.nan), (0.4, 0.01)])
        self.assertEqual(band["echoes"], 1)
        self.assertAlmostEqual(band["max_m"], 0.1)


if __name__ == "__main__":
    unittest.main()
