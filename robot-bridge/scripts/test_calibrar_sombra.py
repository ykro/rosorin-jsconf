#!/usr/bin/env python3
"""Unit tests for calibrar_sombra.py (pure functions, no rclpy or bridge needed)."""
import math
import os
import sys
import unittest
from types import SimpleNamespace

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



class ScanDiagnosisTests(unittest.TestCase):
    def test_no_publisher_points_to_driver_or_ros_environment(self):
        msg = cal.scan_diagnosis([], {"ROS_LOCALHOST_ONLY": "1"})
        self.assertIn("No veo ningún publicador", msg)
        self.assertIn("ROS_DOMAIN_ID=0, ROS_LOCALHOST_ONLY=1", msg)

    def test_silent_publisher_is_named(self):
        pub = SimpleNamespace(node_namespace="/", node_name="ldlidar")
        msg = cal.scan_diagnosis([pub], {})
        self.assertIn("1 publicador(es) (/ldlidar)", msg)
        self.assertIn("ROS_LOCALHOST_ONLY=0", msg)


class ArmModelTests(unittest.TestCase):
    HOME = (500, 430, 310, 380, 500, 500)
    SAD_DROOP = (500, 330, 230, 260, 500, 620)

    def test_home_holds_the_gripper_forward_above_the_scan(self):
        tip = cal.arm_points(self.HOME)[-1]
        self.assertGreater(tip[0], 0.25)  # forward of the base
        self.assertGreater(cal.scan_clearance(self.HOME), 0.1)

    def test_sad_droop_crosses_the_scan_plane(self):
        # Measured in the rehearsal: front sector at 0.11 m during bumblebee_sad_droop
        self.assertLess(cal.scan_clearance(self.SAD_DROOP), 0.0)

    def test_poses_not_seen_in_the_rehearsal_stay_above_the_plane(self):
        # facepalm, chef_kiss and wave_hello never got under 0.35 m in section 4
        for pose in ((500, 520, 200, 220, 500, 680), (580, 370, 290, 360, 720, 220), (340, 430, 320, 390, 320, 220)):
            self.assertGreater(cal.scan_clearance(pose), 0.03, pose)

    def test_unseen_crossings_only_without_echoes(self):
        poses = [self.HOME, self.SAD_DROOP, (420, 320, 220, 250, 440, 640)]
        self.assertEqual(cal.unseen_crossings(poses, echoes=5), [])
        self.assertEqual(cal.unseen_crossings(poses, echoes=0), [(420, 320, 220, 250, 440, 640)])


class SelectPosesTests(unittest.TestCase):
    HOME = (500, 430, 310, 380, 500, 500)

    def real_selection(self):
        with open(cal.GESTURES_RS, encoding="utf-8") as f:
            poses = cal.gesture_poses(f.read())
        return poses, cal.select_poses(poses, self.HOME)

    def test_real_gestures_reduce_to_twelve_closest_to_the_scan(self):
        poses, chosen = self.real_selection()
        self.assertGreater(len(poses), cal.MAX_POSES)
        self.assertEqual(len(chosen), cal.MAX_POSES)
        self.assertEqual(len(set(chosen)), len(chosen))
        worst_chosen = max(cal.scan_clearance(p) for p in chosen)
        self.assertLess(worst_chosen, cal.scan_clearance(self.HOME))

    def test_includes_every_bumblebee_sad_droop_pose(self):
        _, chosen = self.real_selection()
        for pose in ((500, 330, 230, 260, 500, 620), (420, 320, 220, 250, 440, 640), (580, 320, 220, 250, 560, 640)):
            self.assertIn(pose, chosen)

    def test_sorted_by_base_rotation(self):
        _, chosen = self.real_selection()
        self.assertEqual([p[0] for p in chosen], sorted(p[0] for p in chosen))

    def test_gripper_only_variants_count_once(self):
        low = (500, 340, 270, 340, 500, 220)
        same_but_closed = (500, 340, 270, 340, 500, 260)
        chosen = cal.select_poses([low, same_but_closed], self.HOME, limit=3)
        self.assertEqual(len([p for p in chosen if p[:5] == low[:5]]), 1)


def fake_scan(angle_min_deg, angle_max_deg, inc_deg=1.0):
    n = int(round((angle_max_deg - angle_min_deg) / inc_deg)) + 1
    return SimpleNamespace(
        angle_min=math.radians(angle_min_deg), angle_increment=math.radians(inc_deg), ranges=[1.0] * n
    )


class ConeCoverageTests(unittest.TestCase):
    def test_full_scan_covers_the_front(self):
        self.assertGreater(cal.cone_coverage(fake_scan(-180, 179), 0.0, False), 0.95)

    def test_scan_cropped_at_the_back_needs_offset_180(self):
        # This robot: the driver's 0 is the robot's back and the filter keeps only 72°..291°
        scan = fake_scan(72, 290.7, 0.9)
        self.assertLess(cal.cone_coverage(scan, 0.0, False), cal.MIN_CONE_COVERAGE)
        self.assertGreater(cal.cone_coverage(scan, 180.0, False), 0.95)

if __name__ == "__main__":
    unittest.main()
