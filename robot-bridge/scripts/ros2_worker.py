#!/usr/bin/env python3
"""
Direct Hardware Worker for Hiwonder ROSOrin Pro (`rosorin-bridge --backend ros2`).
Uses Hiwonder's official `ros_robot_controller_sdk.Board` on `/dev/rrc` (with `rts=False, dtr=False`
so the STM32 never resets into bootloader mode), and runs a background ROS 2 Humble subscriber
on `/depth_cam/rgb0/image_raw` (2 FPS JPEG frames from the Deptrum Aurora 930 Pro 3D camera)
and `/scan` (10 Hz LiDAR sector telemetry with 6-DOF arm shadow filtering).

If `/dev/rrc` is owned by another ROS 2 node, it falls back to publishing ROS 2 topics:
`/controller/cmd_vel` (Twist), `/servo_controller` (ServosPosition) and
`/ros_robot_controller/set_buzzer` (BuzzerState).

Protocol: one JSON command per line on stdin, one JSON event per line on stdout.
On stdin EOF (bridge died or exited) the motors are set to 0.
Heartbeat: `{"op":"ping","seq":N}` is answered with `{"event":"pong","seq":N}` from the same
thread that executes the commands, so a worker that stops reading stdin is detected by the bridge
(connected=false, chassis blocked) even if the LiDAR thread keeps publishing.

This module is importable without ROS 2 / the Board (see `test_ros2_worker.py`):
hardware is only touched from `main()`.
"""
import base64
import json
import math
import os
import signal
import sys
import threading
import time

VALID_SERVO_IDS = {1, 2, 3, 4, 5, 10}
# The bridge re-sends the active velocity every ~100 ms, so 500 ms without
# commands means the bridge is gone or stuck: stop the motors.
WATCHDOG_TIMEOUT_S = 0.50


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except (TypeError, ValueError):
        sys.stderr.write(f"[ros2_worker] invalid {name}, using {default}\n")
        return default


# Arm shadow filter: returns between ARM_SHADOW_MIN_M and ARM_SHADOW_MAX_M within
# ±ARM_SHADOW_HALF_ANGLE_DEG of the front are assumed to be the robot's own arm, and only while the
# sector has other usable rays (an echo or free space). Anything closer than ARM_SHADOW_MIN_M is never
# filtered (nothing of the arm can be that close, so it is an obstacle) and anything farther than
# ARM_SHADOW_MAX_M is a normal echo. Values come from, in order: the environment, the calibration file
# written by `make calibrar-sombra` (ARM_SHADOW_FILE, robot-bridge/arm-shadow.json by default) and
# narrow defaults that fail closed (if the real arm shows up outside the band the front blocks).
# ARM_SHADOW_MAX_M=0 disables the filter.
ARM_SHADOW_DEFAULTS = {"min_m": 0.06, "max_m": 0.09, "half_angle_deg": 20.0}
ARM_SHADOW_FILE = os.environ.get(
    "ARM_SHADOW_FILE",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "arm-shadow.json"),
)


def load_arm_shadow(path: str = ARM_SHADOW_FILE, env=os.environ) -> tuple:
    """Returns ({min_m, max_m, half_angle_deg}, source) with env > calibration file > defaults."""
    values = dict(ARM_SHADOW_DEFAULTS)
    source = "defaults"
    try:
        with open(path, encoding="utf-8") as f:
            calibrated = json.load(f)
        for key in values:
            values[key] = float(calibrated[key])
        source = f"file {path}"
    except FileNotFoundError:
        pass
    except Exception as exc:
        sys.stderr.write(f"[ros2_worker] ignoring invalid {path}: {exc}\n")
    for key, var in (("min_m", "ARM_SHADOW_MIN_M"), ("max_m", "ARM_SHADOW_MAX_M"),
                     ("half_angle_deg", "ARM_SHADOW_HALF_ANGLE_DEG")):
        if var in env:
            try:
                values[key] = float(env[var])
                source = "environment"
            except ValueError:
                sys.stderr.write(f"[ros2_worker] invalid {var}, keeping {values[key]}\n")
    return values, source


_ARM_SHADOW, ARM_SHADOW_SOURCE = load_arm_shadow()
ARM_SHADOW_MIN_M = _ARM_SHADOW["min_m"]
ARM_SHADOW_MAX_M = _ARM_SHADOW["max_m"]
ARM_SHADOW_HALF_ANGLE_DEG = _ARM_SHADOW["half_angle_deg"]

# Rays follow REP 117: +inf (or a finite value above range_max) means "no object within range", i.e.
# free space; -inf, NaN, 0 or a value below range_min mean the sensor saw something too close or
# failed (dirty or covered window). A sector where fewer than this fraction of its rays are usable
# (an echo or free space) is blind: it is reported as 0.0 m, which the bridge treats as an obstacle
# (fail closed). Set to 0 to disable the check.
LIDAR_MIN_VALID_FRACTION = _env_float("LIDAR_MIN_VALID_FRACTION", 0.25)
LIDAR_OPEN_M = 4.0
LIDAR_BLIND_M = 0.0

# Mounting correction when the driver's angle 0 is not the robot's front (REP-103: 0 = front,
# positive = left). LIDAR_FLIP=1 mirrors the scan (driver counts clockwise) and LIDAR_ANGLE_OFFSET_DEG
# is then added, e.g. 180 for a LiDAR mounted backwards. `ensayo.sh` section 3 tells which one you need.
# Values come from, in order: the environment, the per-robot file LIDAR_MOUNT_FILE
# (robot-bridge/lidar-mount.json by default, offered by `make calibrar-sombra`) and 0 / not flipped.
LIDAR_MOUNT_FILE = os.environ.get(
    "LIDAR_MOUNT_FILE",
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lidar-mount.json"),
)


def _truthy(value) -> bool:
    return str(value).strip().lower() in ("1", "true", "yes", "si", "sí")


def load_lidar_mount(path: str = LIDAR_MOUNT_FILE, env=os.environ) -> tuple:
    """Returns ({offset_deg, flip}, source) with env > mount file > defaults (0, not flipped)."""
    values = {"offset_deg": 0.0, "flip": False}
    source = "defaults"
    try:
        with open(path, encoding="utf-8") as f:
            mount = json.load(f)
        values = {"offset_deg": float(mount.get("offset_deg", 0.0)), "flip": _truthy(mount.get("flip", False))}
        source = f"file {path}"
    except FileNotFoundError:
        pass
    except Exception as exc:
        sys.stderr.write(f"[ros2_worker] ignoring invalid {path}: {exc}\n")
    if "LIDAR_ANGLE_OFFSET_DEG" in env:
        try:
            values["offset_deg"] = float(env["LIDAR_ANGLE_OFFSET_DEG"])
            source = "environment"
        except ValueError:
            sys.stderr.write(f"[ros2_worker] invalid LIDAR_ANGLE_OFFSET_DEG, keeping {values['offset_deg']}\n")
    if "LIDAR_FLIP" in env:
        values["flip"] = _truthy(env["LIDAR_FLIP"])
        source = "environment"
    return values, source


_LIDAR_MOUNT, LIDAR_MOUNT_SOURCE = load_lidar_mount()
LIDAR_ANGLE_OFFSET_DEG = _LIDAR_MOUNT["offset_deg"]
LIDAR_FLIP = _LIDAR_MOUNT["flip"]


def robot_angle(raw_rad: float, offset_deg: float = None, flip: bool = None) -> float:
    """Driver angle -> robot angle in (-pi, pi], applying LIDAR_FLIP and LIDAR_ANGLE_OFFSET_DEG."""
    if offset_deg is None:
        offset_deg = LIDAR_ANGLE_OFFSET_DEG
    if flip is None:
        flip = LIDAR_FLIP
    a = (-raw_rad if flip else raw_rad) + math.radians(offset_deg)
    return math.atan2(math.sin(a), math.cos(a))

# Several threads (camera, LiDAR, battery, main) write JSON lines: serialize them.
_stdout_lock = threading.Lock()
_rclpy_lock = threading.Lock()


def emit(event: dict) -> None:
    line = json.dumps(event)
    with _stdout_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def ensure_rclpy():
    """Initializes rclpy exactly once, even if called from several threads."""
    with _rclpy_lock:
        import rclpy

        if not rclpy.ok():
            try:
                # Without its own SIGINT handler rclpy does not tear the nodes down on Ctrl+C
                from rclpy.signals import SignalHandlerOptions

                rclpy.init(signal_handler_options=SignalHandlerOptions.NO)
            except (ImportError, TypeError):
                rclpy.init()
        return rclpy


def spin_node(node) -> None:
    """Spins `node` on its own executor (never share the global one across threads)."""
    from rclpy.executors import SingleThreadedExecutor

    executor = SingleThreadedExecutor()
    executor.add_node(node)
    executor.spin()


def init_board():
    try:
        from ros_robot_controller.ros_robot_controller_sdk import Board

        board = Board("/dev/rrc", 1000000)
        board.enable_reception()
        return board
    except Exception as exc:
        sys.stderr.write(f"[ros2_worker] Direct Board(/dev/rrc) init info: {exc}\n")
        return None


def clamp_servo_pulse(sid: int, pos: int) -> int:
    bounds = {
        1: (120, 880),
        2: (220, 780),
        3: (150, 850),
        4: (150, 850),
        5: (100, 900),
        10: (200, 750),
    }
    lo, hi = bounds.get(sid, (150, 850))
    return max(lo, min(hi, pos))


def zero_board_motors(board):
    try:
        board.set_motor_speed([[1, 0.0], [2, 0.0], [3, 0.0], [4, 0.0]])
    except Exception:
        pass


def reply_ping(cmd: dict) -> bool:
    """Heartbeat: echoes `{"op":"ping","seq":N}` as `{"event":"pong","seq":N}`.

    Must be called from the thread that executes the commands (the stdin loop): the pong then
    proves that every command queued before the ping was consumed.
    """
    if cmd.get("op") != "ping":
        return False
    try:
        seq = int(cmd.get("seq", 0))
    except (TypeError, ValueError):
        return True
    emit({"event": "pong", "seq": seq})
    return True


def handle_board_command(board, cmd: dict, vel_state: dict):
    op = cmd.get("op")
    if reply_ping(cmd):
        return
    if op == "arm":
        dur_s = max(0.12, min(5.0, float(cmd.get("duration_s", 0.4))))
        positions = []
        for s in cmd.get("servos", [])[:6]:
            sid = int(s["id"])
            if sid not in VALID_SERVO_IDS:
                continue
            pos = clamp_servo_pulse(sid, int(s["position"]))
            positions.append([sid, pos])
        if positions:
            board.bus_servo_set_position(dur_s, positions)
    elif op == "cmd_vel":
        lx = max(-0.25, min(0.25, float(cmd.get("linear_x", 0.0))))
        ly = max(-0.25, min(0.25, float(cmd.get("linear_y", 0.0))))
        az = max(-0.80, min(0.80, float(cmd.get("angular_z", 0.0))))
        k = (0.17706 + 0.17165) / 2.0
        v1 = lx - ly - az * k
        v2 = lx + ly - az * k
        v3 = lx + ly + az * k
        v4 = lx - ly + az * k
        c = math.pi * 0.08
        # Right-side motors (3 and 4) are inverted in mounting on ROSOrin Pro
        speeds = [
            [1, v1 / c],
            [2, v2 / c],
            [3, -v3 / c],
            [4, -v4 / c],
        ]
        board.set_motor_speed(speeds)
        with vel_state["lock"]:
            vel_state["last_cmd_at"] = time.monotonic()
            vel_state["moving"] = abs(lx) > 1e-4 or abs(ly) > 1e-4 or abs(az) > 1e-4
    elif op == "buzzer":
        freq = max(0, min(5000, int(cmd.get("freq", 1900))))
        rep = max(0, min(5, int(cmd.get("repeat", 1))))
        if freq == 0 or rep == 0:
            board.set_buzzer(0, 0.0, 0.0, 0)
        else:
            on_s = max(0.05, min(2.0, float(cmd.get("on_s", 0.12))))
            off_s = max(0.05, min(2.0, float(cmd.get("off_s", 0.05))))
            board.set_buzzer(freq, on_s, off_s, rep)
    elif op == "rgb":
        r = max(0, min(255, int(cmd.get("r", 0))))
        g = max(0, min(255, int(cmd.get("g", 0))))
        b = max(0, min(255, int(cmd.get("b", 0))))
        try:
            board.set_rgb([[1, r, g, b], [2, r, g, b]])
        except Exception:
            pass


def battery_poller(board):
    while True:
        try:
            mv = board.get_battery()
            if mv and 8000 <= int(mv) <= 14000:
                emit({"event": "battery", "mv": int(mv)})
        except Exception:
            pass
        time.sleep(2.0)


def board_watchdog_loop(board, vel_state: dict):
    while True:
        time.sleep(0.05)
        should_stop = False
        with vel_state["lock"]:
            if vel_state["moving"] and (time.monotonic() - vel_state["last_cmd_at"]) > WATCHDOG_TIMEOUT_S:
                vel_state["moving"] = False
                should_stop = True
        if should_stop:
            zero_board_motors(board)


def classify_ray(r: float, r_min: float, r_max: float) -> str:
    """REP 117: 'echo' (finite, in range), 'free' (+inf or beyond range_max) or 'invalid'."""
    if math.isnan(r) or r == -math.inf or r <= 0.0:
        return "invalid"
    if r == math.inf or r > r_max:
        return "free"
    if r < r_min:
        return "invalid"
    return "echo"


def compute_lidar_sectors(
    msg,
    shadow_max_m=None,
    shadow_half_angle_deg=None,
    shadow_min_m=None,
    min_valid_fraction=None,
) -> dict:
    """
    Computes (front_m, left_m, right_m, back_m) from a ROS 2 sensor_msgs/LaserScan message
    (REP-103: angle 0 = front, positive = left; REP 117 for +inf/-inf/NaN).

    - Free space: +inf or a value above range_max is "nothing within range", so an open stage
      reports the sector as open (4.0 m).
    - Blind sector: if fewer than `min_valid_fraction` of the sector's rays are usable (echo or free
      space; NaN/-inf/0/too close are not), the sector reports 0.0 m (blocking) and is listed in
      `blind`. A covered or dirty LiDAR therefore blocks.
    - Arm shadow: echoes between `shadow_min_m` and `shadow_max_m` within ±`shadow_half_angle_deg`
      of the front are ignored while the sector has other usable rays; if the arm is the only thing
      the sector can see, the closest arm echo is reported (blocking). Echoes closer than
      `shadow_min_m` or farther than `shadow_max_m` are never filtered.
    """
    if shadow_max_m is None:
        shadow_max_m = ARM_SHADOW_MAX_M
    if shadow_half_angle_deg is None:
        shadow_half_angle_deg = ARM_SHADOW_HALF_ANGLE_DEG
    if shadow_min_m is None:
        shadow_min_m = ARM_SHADOW_MIN_M
    if min_valid_fraction is None:
        min_valid_fraction = LIDAR_MIN_VALID_FRACTION

    names = ("front", "left", "right", "back")
    valid = {n: math.inf for n in names}
    shadow = dict(valid)
    total = {n: 0 for n in names}
    usable = {n: 0 for n in names}
    usable_outside_shadow = {n: 0 for n in names}

    r_min = max(0.05, float(getattr(msg, "range_min", 0.05)))
    r_max = min(12.0, float(getattr(msg, "range_max", 12.0)))
    angle = float(msg.angle_min)
    inc = float(msg.angle_increment)
    arm_shadow_rad = math.radians(shadow_half_angle_deg)
    pi_4 = math.pi / 4.0
    three_pi_4 = 3.0 * math.pi / 4.0

    for r in msg.ranges:
        curr_angle = robot_angle(angle)
        angle += inc

        if abs(curr_angle) <= pi_4:
            sector = "front"
        elif pi_4 < curr_angle <= three_pi_4:
            sector = "left"
        elif -three_pi_4 <= curr_angle < -pi_4:
            sector = "right"
        else:
            sector = "back"

        total[sector] += 1
        kind = classify_ray(float(r), r_min, r_max)
        if kind == "invalid":
            continue
        usable[sector] += 1
        if kind == "free":
            usable_outside_shadow[sector] += 1
            continue

        # Possible 6-DOF arm base/gripper shadow mounted over the front bumper
        if abs(curr_angle) <= arm_shadow_rad and shadow_min_m <= r <= shadow_max_m:
            shadow[sector] = min(shadow[sector], r)
        else:
            usable_outside_shadow[sector] += 1
            valid[sector] = min(valid[sector], r)

    def is_blind(name: str) -> bool:
        if min_valid_fraction <= 0.0 or total[name] == 0:
            return False
        return usable[name] / total[name] < min_valid_fraction

    def sector_value(name: str) -> float:
        if is_blind(name):
            return LIDAR_BLIND_M
        if math.isfinite(valid[name]):
            return valid[name]
        if math.isfinite(shadow[name]) and usable_outside_shadow[name] == 0:
            return shadow[name]
        return LIDAR_OPEN_M

    return {
        "event": "lidar",
        "front_m": round(sector_value("front"), 3),
        "left_m": round(sector_value("left"), 3),
        "right_m": round(sector_value("right"), 3),
        "back_m": round(sector_value("back"), 3),
        # Diagnostics only (the bridge ignores it): sectors reported as 0.0 for lack of usable rays.
        "blind": [n for n in names if is_blind(n)],
    }


def create_telemetry_node():
    """
    Builds the node that subscribes to:
    - /depth_cam/rgb0/image_raw (Aurora 930 3D camera, 2 FPS JPEG base64)
    - /scan (LD19/MS200 LiDAR, up to 10 Hz sector distances with arm shadow filtering)
    Without /scan the bridge marks the LiDAR as stale and blocks the chassis.

    Call it before the first stdout line: importing rclpy, cv2 and numpy holds the GIL for about a
    second, and done in a background thread it delays the pongs past the bridge's heartbeat timeout
    (`connected=false` right after start-up). Returns None if ROS 2 is not available.
    """
    try:
        os.environ.setdefault("ROS_LOCALHOST_ONLY", "1")
        ensure_rclpy()
        from rclpy.node import Node
        from rclpy.qos import qos_profile_sensor_data
        from sensor_msgs.msg import Image, LaserScan

        try:
            import cv2
            import numpy as np

            has_cv2 = True
        except Exception:
            has_cv2 = False

        node = Node("rosorin_telemetry_bridge_sub")
        last_img_sent = [0.0]
        last_scan_sent = [0.0]

        if has_cv2:
            def on_image(msg: Image):
                now = time.monotonic()
                if now - last_img_sent[0] < 0.5:
                    return
                last_img_sent[0] = now
                try:
                    arr = np.frombuffer(msg.data, dtype=np.uint8)
                    channels = 3
                    if msg.encoding in ("rgba8", "bgra8"):
                        channels = 4
                    frame = arr.reshape((msg.height, msg.width, channels))
                    if msg.encoding == "rgb8":
                        frame = cv2.cvtColor(frame, cv2.COLOR_RGB2BGR)
                    elif msg.encoding == "rgba8":
                        frame = cv2.cvtColor(frame, cv2.COLOR_RGBA2BGR)
                    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), 78])
                    if ok:
                        b64 = base64.b64encode(buf.tobytes()).decode("ascii")
                        emit({"event": "camera_jpeg", "b64": b64})
                except Exception as e:
                    sys.stderr.write(f"[ros2_worker] camera encode error: {e}\n")

            # Best-effort QoS matches both reliable and best-effort sensor publishers
            node.create_subscription(
                Image, "/depth_cam/rgb0/image_raw", on_image, qos_profile_sensor_data
            )
            sys.stderr.write("[ros2_worker] Subscribed to /depth_cam/rgb0/image_raw (Aurora 930)\n")

        def on_scan(msg: LaserScan):
            now = time.monotonic()
            # ~20 Hz max: well inside the bridge's 300 ms staleness window
            if now - last_scan_sent[0] < 0.05:
                return
            last_scan_sent[0] = now
            try:
                emit(compute_lidar_sectors(msg))
            except Exception as e:
                sys.stderr.write(f"[ros2_worker] lidar scan parse error: {e}\n")

        node.create_subscription(LaserScan, "/scan", on_scan, qos_profile_sensor_data)
        if LIDAR_MIN_VALID_FRACTION <= 0.0:
            sys.stderr.write(
                "[ros2_worker] ATENCIÓN: LIDAR_MIN_VALID_FRACTION=0, un LiDAR tapado o sucio ya no "
                "bloquea el chasis\n"
            )
        sys.stderr.write(
            "[ros2_worker] Subscribed to /scan (arm shadow filter "
            f"{ARM_SHADOW_MIN_M}-{ARM_SHADOW_MAX_M} m within ±{ARM_SHADOW_HALF_ANGLE_DEG} deg from "
            f"{ARM_SHADOW_SOURCE}, blind sector below {LIDAR_MIN_VALID_FRACTION:.0%} usable rays, "
            f"angle offset {LIDAR_ANGLE_OFFSET_DEG} deg{', flipped' if LIDAR_FLIP else ''} from "
            f"{LIDAR_MOUNT_SOURCE})\n"
        )
        return node
    except Exception as exc:
        sys.stderr.write(f"[ros2_worker] Telemetry subscriber info: {exc}\n")
        return None


def start_telemetry(node) -> None:
    """Spins the node from create_telemetry_node() in the background (no-op if it is None)."""
    if node is not None:
        threading.Thread(target=spin_node, args=(node,), daemon=True).start()


def main():
    # Ctrl+C in `make robot` also reaches this process (same process group). The bridge owns the
    # shutdown: it latches the E-stop and closes stdin, and the EOF below zeroes the motors.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    board_instance = init_board()

    if board_instance is not None:
        backend_label = "stm32-board (/dev/rrc @ 1Mbps)"
        sys.stderr.write(f"[ros2_worker] Connected directly to STM32: {backend_label}\n")
        # Aurora 930 camera + /scan LiDAR: built before the first line, spun in the background
        telemetry = create_telemetry_node()
        # First line on stdout must be the backend event (the bridge waits for it)
        emit({"event": "backend", "name": backend_label})
        start_telemetry(telemetry)

        vel_state = {"lock": threading.Lock(), "last_cmd_at": time.monotonic(), "moving": False}
        threading.Thread(target=battery_poller, args=(board_instance,), daemon=True).start()
        threading.Thread(
            target=board_watchdog_loop, args=(board_instance, vel_state), daemon=True
        ).start()

        try:
            for line in sys.stdin:
                line = line.strip()
                if not line:
                    continue
                try:
                    cmd = json.loads(line)
                    handle_board_command(board_instance, cmd, vel_state)
                except Exception as exc:
                    sys.stderr.write(f"[ros2_worker] board command error: {exc}\n")
        finally:
            # stdin EOF: the bridge is gone, never leave the wheels spinning
            zero_board_motors(board_instance)
        return

    # Fallback to ROS 2 rclpy topics if Board(/dev/rrc) is owned by another ROS 2 node
    os.environ.setdefault("ROS_LOCALHOST_ONLY", "1")
    rclpy = ensure_rclpy()
    from rclpy.node import Node
    from geometry_msgs.msg import Twist
    from servo_controller_msgs.msg import ServoPosition, ServosPosition
    from ros_robot_controller_msgs.msg import BuzzerState

    node = Node("rosorin_rust_bridge_worker")
    vel_pub = node.create_publisher(Twist, "/controller/cmd_vel", 10)
    servo_pub = node.create_publisher(ServosPosition, "/servo_controller", 10)
    buzzer_pub = node.create_publisher(BuzzerState, "/ros_robot_controller/set_buzzer", 10)

    vel_state = {"lock": threading.Lock(), "last_cmd_at": time.monotonic(), "moving": False}

    def ros2_watchdog():
        should_stop = False
        with vel_state["lock"]:
            if vel_state["moving"] and (time.monotonic() - vel_state["last_cmd_at"]) > WATCHDOG_TIMEOUT_S:
                vel_state["moving"] = False
                should_stop = True
        if should_stop:
            try:
                vel_pub.publish(Twist())
            except Exception:
                pass

    node.create_timer(0.1, ros2_watchdog)

    telemetry = create_telemetry_node()
    emit({"event": "backend", "name": "ros2-topics"})
    threading.Thread(target=spin_node, args=(node,), daemon=True).start()
    start_telemetry(telemetry)

    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                cmd = json.loads(line)
                op = cmd.get("op")
                if reply_ping(cmd):
                    continue
                if op == "cmd_vel":
                    lx = max(-0.25, min(0.25, float(cmd.get("linear_x", 0.0))))
                    ly = max(-0.25, min(0.25, float(cmd.get("linear_y", 0.0))))
                    az = max(-0.80, min(0.80, float(cmd.get("angular_z", 0.0))))
                    msg = Twist()
                    msg.linear.x = lx
                    msg.linear.y = ly
                    msg.angular.z = az
                    vel_pub.publish(msg)
                    with vel_state["lock"]:
                        vel_state["last_cmd_at"] = time.monotonic()
                        vel_state["moving"] = (
                            abs(lx) > 1e-4 or abs(ly) > 1e-4 or abs(az) > 1e-4
                        )
                elif op == "arm":
                    msg = ServosPosition()
                    msg.duration = max(0.12, min(5.0, float(cmd.get("duration_s", 0.5))))
                    msg.position_unit = "pulse"
                    positions = []
                    for s in cmd.get("servos", [])[:6]:
                        sid = int(s["id"])
                        if sid not in VALID_SERVO_IDS:
                            continue
                        pos = clamp_servo_pulse(sid, int(s["position"]))
                        positions.append(ServoPosition(id=sid, position=float(pos)))
                    if positions:
                        msg.position = positions
                        servo_pub.publish(msg)
                elif op == "buzzer":
                    msg = BuzzerState()
                    msg.freq = max(0, min(5000, int(cmd.get("freq", 1900))))
                    msg.on_time = max(0.05, min(2.0, float(cmd.get("on_s", 0.15))))
                    msg.off_time = max(0.05, min(2.0, float(cmd.get("off_s", 0.05))))
                    msg.repeat = max(0, min(5, int(cmd.get("repeat", 1))))
                    buzzer_pub.publish(msg)
            except Exception as exc:
                sys.stderr.write(f"[ros2_worker] ros2 fallback error: {exc}\n")
    finally:
        try:
            vel_pub.publish(Twist())
        except Exception:
            pass
        try:
            node.destroy_node()
            rclpy.shutdown()
        except Exception:
            pass


if __name__ == "__main__":
    main()
