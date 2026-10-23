#!/usr/bin/env python3
"""
Direct Hardware Worker for Hiwonder ROSOrin Pro (`rosorin-bridge --backend ros2`).
Uses Hiwonder's official `ros_robot_controller_sdk.Board` on `/dev/rrc` (with `rts=False, dtr=False`
so the STM32 never resets into bootloader mode), and runs a background ROS 2 Humble subscriber
on `/depth_cam/rgb0/image_raw` to capture live JPEG frames from the Deptrum Aurora 930 Pro 3D camera.
"""
import base64
import json
import math
import os
import sys
import threading
import time

HAS_BOARD = False
board_instance = None

try:
    from ros_robot_controller.ros_robot_controller_sdk import Board

    board_instance = Board("/dev/rrc", 1000000)
    board_instance.enable_reception()
    HAS_BOARD = True
except Exception as exc:
    sys.stderr.write(f"[ros2_worker] Direct Board(/dev/rrc) init info: {exc}\n")


def handle_board_command(board, cmd: dict):
    op = cmd.get("op")
    if op == "arm":
        dur_s = max(0.12, float(cmd.get("duration_s", 0.4)))
        positions = []
        for s in cmd.get("servos", []):
            sid = int(s["id"])
            pos = max(0, min(1000, int(s["position"])))
            positions.append([sid, pos])
        if positions:
            board.bus_servo_set_position(dur_s, positions)
    elif op == "cmd_vel":
        lx = float(cmd.get("linear_x", 0.0))
        ly = float(cmd.get("linear_y", 0.0))
        az = float(cmd.get("angular_z", 0.0))
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
    elif op == "buzzer":
        freq = int(cmd.get("freq", 1900))
        on_s = max(0.05, float(cmd.get("on_s", 0.12)))
        off_s = max(0.05, float(cmd.get("off_s", 0.05)))
        rep = int(cmd.get("repeat", 1))
        board.set_buzzer(freq, on_s, off_s, rep)
    elif op == "rgb":
        r = int(cmd.get("r", 0))
        g = int(cmd.get("g", 0))
        b = int(cmd.get("b", 0))
        try:
            board.set_rgb([[1, r, g, b], [2, r, g, b]])
        except Exception:
            pass


def battery_poller(board):
    while True:
        try:
            mv = board.get_battery()
            if mv and 8000 <= int(mv) <= 14000:
                print(json.dumps({"event": "battery", "mv": int(mv)}), flush=True)
        except Exception:
            pass
        time.sleep(2.0)


def ros2_camera_subscriber():
    """Subscribes to /depth_cam/rgb0/image_raw (Aurora 930 3D camera) and emits 2 FPS JPEG base64."""
    try:
        os.environ.setdefault("ROS_LOCALHOST_ONLY", "1")
        import rclpy
        from rclpy.node import Node
        from sensor_msgs.msg import Image
        import numpy as np
        import cv2

        if not rclpy.ok():
            rclpy.init()
        node = Node("rosorin_camera_bridge_sub")
        last_sent = [0.0]

        def on_image(msg: Image):
            now = time.time()
            if now - last_sent[0] < 0.5:
                return
            last_sent[0] = now
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
                    print(json.dumps({"event": "camera_jpeg", "b64": b64}), flush=True)
            except Exception as e:
                sys.stderr.write(f"[ros2_worker] camera encode error: {e}\n")

        node.create_subscription(Image, "/depth_cam/rgb0/image_raw", on_image, 1)
        sys.stderr.write("[ros2_worker] Subscribed to /depth_cam/rgb0/image_raw (Aurora 930)\n")
        rclpy.spin(node)
    except Exception as exc:
        sys.stderr.write(f"[ros2_worker] Camera subscriber info: {exc}\n")


def main():
    # Start Aurora 930 camera subscriber thread in the background
    threading.Thread(target=ros2_camera_subscriber, daemon=True).start()

    if HAS_BOARD and board_instance is not None:
        backend_label = "stm32-board (/dev/rrc @ 1Mbps)"
        sys.stderr.write(f"[ros2_worker] Connected directly to STM32: {backend_label}\n")
        print(json.dumps({"event": "backend", "name": backend_label}), flush=True)
        threading.Thread(target=battery_poller, args=(board_instance,), daemon=True).start()

        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                cmd = json.loads(line)
                handle_board_command(board_instance, cmd)
            except Exception as exc:
                sys.stderr.write(f"[ros2_worker] board command error: {exc}\n")
        return

    # Fallback to ROS 2 rclpy topics if Board(/dev/rrc) is owned by another ROS 2 node
    import rclpy
    from rclpy.node import Node
    from geometry_msgs.msg import Twist
    from servo_controller_msgs.msg import ServoPosition, ServosPosition
    from ros_robot_controller_msgs.msg import BuzzerState

    if not rclpy.ok():
        rclpy.init()
    node = Node("rosorin_rust_bridge_worker")
    vel_pub = node.create_publisher(Twist, "/controller/cmd_vel", 10)
    servo_pub = node.create_publisher(ServosPosition, "/servo_controller", 10)
    buzzer_pub = node.create_publisher(BuzzerState, "/ros_robot_controller/set_buzzer", 10)

    print(json.dumps({"event": "backend", "name": "ros2-topics"}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
            op = cmd.get("op")
            if op == "cmd_vel":
                msg = Twist()
                msg.linear.x = float(cmd.get("linear_x", 0.0))
                msg.linear.y = float(cmd.get("linear_y", 0.0))
                msg.angular.z = float(cmd.get("angular_z", 0.0))
                vel_pub.publish(msg)
            elif op == "arm":
                msg = ServosPosition()
                msg.duration = max(0.2, float(cmd.get("duration_s", 0.5)))
                msg.position_unit = "pulse"
                msg.position = [
                    ServoPosition(id=int(s["id"]), position=float(s["position"]))
                    for s in cmd.get("servos", [])
                ]
                servo_pub.publish(msg)
            elif op == "buzzer":
                msg = BuzzerState()
                msg.freq = int(cmd.get("freq", 1900))
                msg.on_time = max(0.05, float(cmd.get("on_s", 0.15)))
                msg.off_time = max(0.05, float(cmd.get("off_s", 0.05)))
                msg.repeat = int(cmd.get("repeat", 1))
                buzzer_pub.publish(msg)
        except Exception as exc:
            sys.stderr.write(f"[ros2_worker] ros2 fallback error: {exc}\n")

    node.destroy_node()
    rclpy.shutdown()


if __name__ == "__main__":
    main()
