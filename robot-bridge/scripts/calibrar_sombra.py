#!/usr/bin/env python3
"""
Calibrates the LiDAR arm-shadow filter of ros2_worker.py on the real robot.

Runs ON THE ROBOT with the bridge up (`make robot`) and ROS 2 sourced (`make calibrar-sombra` does
both checks). It moves only the arm (POST /arm, never the chassis) through every pose used by the
gestures in robot-bridge/src/gestures.rs, reads the raw /scan while each pose holds, and measures
where the arm shows up. With the area clear (nothing within ARM_SEARCH_RADIUS_M of the LiDAR), every
echo that close is the robot itself. The band it finds is written to robot-bridge/arm-shadow.json,
which the worker loads on start (environment variables still override it).

Usage: python3 robot-bridge/scripts/calibrar_sombra.py [--yes] [--bridge http://127.0.0.1:9000]
"""
import argparse
import json
import math
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.request

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
BRIDGE_DIR = os.path.dirname(SCRIPTS_DIR)
REPO_DIR = os.path.dirname(BRIDGE_DIR)
GESTURES_RS = os.path.join(BRIDGE_DIR, "src", "gestures.rs")
OUTPUT = os.environ.get("ARM_SHADOW_FILE", os.path.join(BRIDGE_DIR, "arm-shadow.json"))

ARM_SEARCH_RADIUS_M = 0.30  # anything closer with the area clear is the robot itself
ARM_SEARCH_HALF_ANGLE_DEG = 90.0
RANGE_MARGIN_M = 0.01
ANGLE_MARGIN_DEG = 2.0
MAX_SAFE_BAND_M = 0.25  # a band reaching the 0.28 m brake would hide real obstacles
SERVO_IDS = (1, 2, 3, 4, 5, 10)


def gesture_poses(rust_source: str) -> list:
    """Unique arm poses (j1..j5, gripper) used by the gestures, in order of appearance."""
    poses = []
    for match in re.finditer(r"pose\(([^)]*)\)", rust_source):
        values = match.group(1).split(",")
        if len(values) != 6:
            continue
        try:
            pose = tuple(int(v.strip()) for v in values)
        except ValueError:
            continue  # the `fn pose(j1: u16, ...)` signature
        if pose not in poses:
            poses.append(pose)
    return poses


def analyze_shadow(samples: list, range_min: float = 0.05) -> dict:
    """
    `samples` is a list of (angle_rad, range_m) arm echoes collected with the area clear.
    Returns the band {min_m, max_m, half_angle_deg} that covers them with a small margin, or a
    disabled filter (max_m = 0) when the LiDAR never sees the arm.
    """
    arm = [(a, r) for a, r in samples if math.isfinite(r) and range_min <= r <= ARM_SEARCH_RADIUS_M]
    if not arm:
        return {"min_m": 0.0, "max_m": 0.0, "half_angle_deg": 0.0, "echoes": 0}
    ranges = [r for _, r in arm]
    angles = [abs(math.degrees(a)) for a, _ in arm]
    return {
        "min_m": round(max(range_min, min(ranges) - RANGE_MARGIN_M), 3),
        "max_m": round(max(ranges) + RANGE_MARGIN_M, 3),
        "half_angle_deg": round(min(180.0, max(angles) + ANGLE_MARGIN_DEG), 1),
        "echoes": len(arm),
    }


def ray_census(msg) -> dict:
    """Counts echo/free/invalid rays (REP 117) to show how this driver reports empty space."""
    sys.path.insert(0, SCRIPTS_DIR)
    from ros2_worker import classify_ray  # noqa: E402

    r_min = max(0.05, float(msg.range_min))
    r_max = min(12.0, float(msg.range_max))
    census = {"echo": 0, "free": 0, "invalid": 0}
    for r in msg.ranges:
        census[classify_ray(float(r), r_min, r_max)] += 1
    return census


def read_token() -> str:
    token = os.environ.get("BRIDGE_TOKEN", "").strip()
    if token:
        return token
    path = os.path.join(REPO_DIR, ".bridge-token")
    try:
        with open(path, encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""


def bridge_post(base: str, token: str, path: str, body: dict) -> dict:
    req = urllib.request.Request(
        base + path,
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json", "x-bridge-token": token},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        return json.loads(resp.read() or b"{}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Calibra el filtro de sombra del brazo en el LiDAR.")
    parser.add_argument("--bridge", default=os.environ.get("BRIDGE_URL", "http://127.0.0.1:9000"))
    parser.add_argument("--yes", action="store_true", help="no pedir confirmación del área despejada")
    parser.add_argument("--hold", type=float, default=1.0, help="segundos que se mide cada pose")
    args = parser.parse_args()

    sys.path.insert(0, SCRIPTS_DIR)
    from ros2_worker import robot_angle  # noqa: E402

    try:
        import rclpy
        from rclpy.node import Node
        from rclpy.qos import qos_profile_sensor_data
        from sensor_msgs.msg import LaserScan
    except ImportError:
        print("[calibrar] Falta rclpy: corre en el robot con ROS 2 cargado (make calibrar-sombra).", file=sys.stderr)
        return 1

    with open(GESTURES_RS, encoding="utf-8") as f:
        poses = gesture_poses(f.read())
    home = (500, 430, 310, 380, 500, 500)
    if home not in poses:
        poses.insert(0, home)

    token = read_token()
    print(f"[calibrar] {len(poses)} poses del brazo de gestures.rs · bridge {args.bridge}")
    print(f"[calibrar] Solo se mueve el brazo. Despeja {int(ARM_SEARCH_RADIUS_M * 100) + 20} cm alrededor del robot:")
    print("[calibrar] todo eco a menos de 30 cm se tomará como parte del robot.")
    if not args.yes and input("[calibrar] ¿Área despejada? [s/n] ").strip().lower()[:1] not in ("s", "y"):
        print("[calibrar] Cancelado.")
        return 1

    os.environ.setdefault("ROS_LOCALHOST_ONLY", "1")
    rclpy.init()
    node = Node("rosorin_arm_shadow_calibration")
    lock = threading.Lock()
    state = {"collect": False, "samples": [], "last": None}

    def on_scan(msg):
        with lock:
            state["last"] = msg
            if not state["collect"]:
                return
            angle = float(msg.angle_min)
            limit = math.radians(ARM_SEARCH_HALF_ANGLE_DEG)
            for r in msg.ranges:
                a = robot_angle(angle)  # same mounting correction as the worker
                angle += float(msg.angle_increment)
                if abs(a) <= limit and math.isfinite(r) and r <= ARM_SEARCH_RADIUS_M:
                    state["samples"].append((a, float(r)))

    node.create_subscription(LaserScan, "/scan", on_scan, qos_profile_sensor_data)
    spinner = threading.Thread(target=rclpy.spin, args=(node,), daemon=True)
    spinner.start()

    deadline = time.monotonic() + 3.0
    while state["last"] is None and time.monotonic() < deadline:
        time.sleep(0.05)
    if state["last"] is None:
        print("[calibrar] No llega /scan en 3 s. Revisa el driver del LiDAR (ros2 topic hz /scan).", file=sys.stderr)
        return 1

    census = ray_census(state["last"])
    print(f"[calibrar] Rayos del último scan: {census} (REP 117: free = +inf, sin objeto en rango)")
    if census["invalid"] > census["echo"] + census["free"]:
        print("[calibrar] AVISO: la mayoría de rayos son inválidos (NaN/0/-inf). Si el LiDAR no está tapado,")
        print("[calibrar]        tu driver reporta el espacio vacío así y los sectores abiertos se verán ciegos.")

    try:
        for i, pose in enumerate(poses, 1):
            servos = [{"id": sid, "position": pos} for sid, pos in zip(SERVO_IDS, pose)]
            try:
                bridge_post(args.bridge, token, "/arm", {"servos": servos, "duration_ms": 700})
            except urllib.error.HTTPError as err:
                print(f"[calibrar] /arm respondió {err.code}: {err.read().decode(errors='replace')}", file=sys.stderr)
                return 1
            time.sleep(0.9)
            with lock:
                state["collect"] = True
            time.sleep(args.hold)
            with lock:
                state["collect"] = False
            print(f"[calibrar] pose {i:2d}/{len(poses)} {pose}: {len(state['samples'])} ecos del brazo acumulados")
    finally:
        try:
            bridge_post(args.bridge, token, "/arm", {"servos": [{"id": s, "position": p} for s, p in zip(SERVO_IDS, home)], "duration_ms": 800})
        except Exception:
            pass
        node.destroy_node()
        rclpy.shutdown()

    msg = state["last"]
    band = analyze_shadow(state["samples"], max(0.05, float(msg.range_min)))
    if band["echoes"] == 0:
        print("[calibrar] El LiDAR no ve el brazo en ninguna pose: el filtro queda desactivado (max_m = 0).")
    elif band["max_m"] > MAX_SAFE_BAND_M:
        print(f"[calibrar] La banda medida llega a {band['max_m']} m, demasiado cerca del freno de 0.28 m.", file=sys.stderr)
        print("[calibrar] Probablemente algo estaba dentro de 30 cm. Despeja el área y vuelve a correr.", file=sys.stderr)
        return 1

    result = {
        "min_m": band["min_m"],
        "max_m": band["max_m"],
        "half_angle_deg": band["half_angle_deg"],
        "echoes": band["echoes"],
        "poses": len(poses),
        "measured_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    with open(OUTPUT, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)
        f.write("\n")
    print(f"[calibrar] Banda del brazo: {result['min_m']}-{result['max_m']} m dentro de ±{result['half_angle_deg']}°")
    print(f"[calibrar] Guardada en {OUTPUT}. Reinicia el bridge (Ctrl+C y make robot) para aplicarla.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
