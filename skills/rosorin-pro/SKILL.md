---
name: rosorin-pro
description: Use when writing code for the Hiwonder ROSOrin Pro mobile manipulator robot — Mecanum chassis control, 6-DOF bus servo robotic arm, Aurora 930 / Astra 3D depth camera, LiDAR scan filtering, STM32 ros_robot_controller serial protocol (1Mbps), ROS 2 Humble topics, or the Rust robot-bridge.
---

# Hiwonder ROSOrin Pro — Robot Control & ROS 2 Reference

## Overview

Hiwonder ROSOrin Pro is an Embodied AI mobile manipulator combining a **Mecanum omnidirectional chassis** with a **6-DOF serial bus servo robotic arm** (5-DOF arm + 1-DOF parallel gripper), running Ubuntu 22.04 and **ROS 2 Humble** on an **NVIDIA Jetson Orin Nano** (or Raspberry Pi 5) paired with an **STM32** real-time co-controller (`ros_robot_controller`).

Official repositories:
- `https://github.com/Hiwonder/ROSOrin-Pro` (branch `orin-nano`)
- `https://github.com/Hiwonder/ROSOrin` (branch `ROS2` — chassis-only standard version)

## Hardware Quick Reference

| Subsystem | Specification | ROS 2 / Device Interface |
|---|---|---|
| Host Compute | NVIDIA Jetson Orin Nano (8GB) / RPi 5 | Ubuntu 22.04 LTS, ROS 2 Humble |
| Co-Controller | STM32 (`ros_robot_controller`) | `/dev/rrc` (symlink to `/dev/ttyACM0`), `1,000,000` baud, 8N1 |
| Chassis | 4x 520 metal DC encoder motors (1:90), Mecanum wheels | `wheelbase=0.17706m`, `track_width=0.17165m`, `wheel_diameter=0.08m` |
| Robotic Arm | 6-DOF intelligent serial bus servos (HTS-21H / HX-12H) | IDs `1..5` (arm joints), ID `10` (gripper). Range `0..1000` pulse (`500` = center) |
| 3D Depth Camera | Deptrum Aurora 930 Pro / Orbbec Astra | `/depth_cam/rgb0/image_raw`, `/depth_cam/depth0/image_raw` (640x480 @ 15fps) |
| LiDAR | LD19 / MS200 / COIN-D6 ToF | `/scan_raw` -> `laser_filters` (masks arm occlusion) -> `/scan` |
| Audio / Voice | WonderEcho Pro AI voice box + USB speaker | `/dev/ring_mic` (115200 baud) / ALSA default audio |
| Peripherals | 6-axis IMU, programmable Buzzer, WS2812 RGB LEDs, OLED | Controlled via STM32 `ros_robot_controller` |
| Battery | 11.1V 6000mAh 3S Li-ion | Reported in mV (`12600` full, `11100` nominal, `<10200` low warning) |

## Control Approaches: Rust Serial vs ROS 2 Bridge vs Mock

| Approach | Latency | When to Use |
|---|---|---|
| **Rust Serial Direct (`/dev/rrc`)** | `<1 ms` | Stage demos where SLAM/Nav2 is not needed; zero ROS 2 middleware overhead |
| **Rust + ROS 2 Worker (`rclpy` / topics)** | `5–15 ms` | When camera (`/depth_cam/...`), LiDAR (`/scan`), or Nav2 must run alongside arm/chassis |
| **Mock Mode (`--backend mock`)** | `<1 ms` | Local development on a laptop and Cloud Run rehearsals without hardware |

> **CRITICAL RULE:** Do not run `ros_robot_controller_node.py` and direct `/dev/rrc` serial mode simultaneously — both open `/dev/rrc` at 1,000,000 baud and will collide on serial reads. Pick `--backend ros2` if `ros_robot_controller` is launched, or `--backend serial` if controlling the STM32 directly from Rust.

## 6-DOF Robotic Arm Servo Mapping & Safe Bounds

All bus servos use pulse units `0..1000` (where `500` is the neutral center, `0..1000` corresponds to `0..240 deg`).

| Joint Name | Servo ID | Role | Center Pulse | Safe Demo Range | Notes |
|---|---|---|---|---|---|
| `joint1` | `1` | Base pan (yaw) | `500` | `120..880` | `500` faces forward |
| `joint2` | `2` | Shoulder pitch | `500` | `220..780` | `<200` risks hitting LiDAR tower |
| `joint3` | `3` | Elbow pitch | `500` | `150..850` | Folds/extends forearm |
| `joint4` | `4` | Wrist pitch | `500` | `150..850` | Angles camera/gripper up or down |
| `joint5` | `5` | Wrist roll | `500` | `100..900` | Rotates gripper/hand |
| `r_joint` | `10` | Parallel Gripper | `500` | `200..750` | `200` = open wide, `700` = closed |

> **Important:** The gripper servo is **ID 10**, NOT ID 6 (even though `.d6a` SQLite action files store it in column `Servo6`). Always map the 6th degree of freedom to bus servo ID `10`.

## ROS 2 Humble Topics & Message Types

### 1. Chassis Velocity (`/cmd_vel` & `/controller/cmd_vel`)
- `/cmd_vel` (`geometry_msgs/msg/Twist`): Clamped by `odom_publisher_node` to `linear.x, linear.y in [-0.2, 0.2] m/s`, `angular.z in [-0.5, 0.5] rad/s`.
- `/controller/cmd_vel` (`geometry_msgs/msg/Twist`): Unclamped velocity input to Mecanum kinematics.

```bash
ros2 topic pub --once /cmd_vel geometry_msgs/msg/Twist "{linear: {x: 0.15, y: 0.0, z: 0.0}, angular: {x: 0.0, y: 0.0, z: 0.0}}"
```

### 2. Bus Servo Control (`/ros_robot_controller/bus_servo/set_position`)
Message type: `ros_robot_controller_msgs/msg/ServosPosition`
```bash
ros2 topic pub --once /ros_robot_controller/bus_servo/set_position ros_robot_controller_msgs/msg/ServosPosition \
  "{duration: 0.6, position: [{id: 1, position: 500}, {id: 2, position: 620}, {id: 3, position: 300}, {id: 4, position: 350}, {id: 5, position: 500}, {id: 10, position: 500}]}"
```

### 3. Buzzer & RGB LEDs
- `/ros_robot_controller/set_buzzer` (`ros_robot_controller_msgs/msg/BuzzerState`): `{freq: 1900, on_time: 0.15, off_time: 0.05, repeat: 2}`
- `/ros_robot_controller/set_rgb` (`ros_robot_controller_msgs/msg/RGBStates`): `{states: [{index: 0, red: 255, green: 40, blue: 40}]}`

### 4. Telemetry & Perception Topics
- `/ros_robot_controller/battery` (`std_msgs/msg/UInt16`): Battery voltage in millivolts (e.g. `11850` = 11.85V).
- `/ros_robot_controller/imu_raw` (`sensor_msgs/msg/Imu`): 6-axis IMU (`imu_link`).
- `/scan` (`sensor_msgs/msg/LaserScan`): Filtered 360-degree LiDAR scan (with arm occlusion removed by `laser_filters`).
- `/depth_cam/rgb0/image_raw` (`sensor_msgs/msg/Image`): 640x480 RGB camera stream from Aurora 930 Pro / Astra.

## STM32 Binary Serial Protocol (`/dev/rrc` @ 1,000,000 baud)

When using `--backend serial` in `robot-bridge`, packets use the following frame:
```text
[0xAA, 0x55, func_id: u8, data_len: u8, ...data_bytes, crc8: u8]
```
- `crc8` is computed over `[func_id, data_len, ...data_bytes]` using the Dallas/Maxim 1-Wire lookup table (`crc8_table` in `ros_robot_controller_sdk.py`).
- **Function IDs (`PacketFunction`)**:
  - `0x00`: `SYS` (Battery voltage report: sub-cmd `0x04` + `u16` little-endian mV)
  - `0x01`: `LED` (`<BHHH`: `led_id: u8, on_ms: u16, off_ms: u16, repeat: u16`)
  - `0x02`: `BUZZER` (`<HHHH`: `freq_hz: u16, on_ms: u16, off_ms: u16, repeat: u16`)
  - `0x03`: `MOTOR` (`[0x01, count: u8, ...(motor_idx_0_based: u8, rps: f32_le)]`)
  - `0x05`: `BUS_SERVO` (`[0x01, dur_lo: u8, dur_hi: u8, count: u8, ...(servo_id: u8, pulse: u16_le)]`)
  - `0x07`: `IMU` (Report: `<6f` little-endian `ax, ay, az, gx, gy, gz`)

### Mecanum Kinematics (Speed m/s to Motor RPS)
With `wheelbase = 0.17706`, `track_width = 0.17165`, `wheel_diameter = 0.08`, and `k = (wheelbase + track_width) / 2.0 = 0.174355`:
```rust
let v1 = linear_x - linear_y - angular_z * k;
let v2 = linear_x + linear_y - angular_z * k;
let v3 = linear_x + linear_y + angular_z * k;
let v4 = linear_x - linear_y + angular_z * k;
let to_rps = |v: f32| v / (std::f32::consts::PI * 0.08);
// Note: Right-side motors (3 and 4) are inverted in mounting:
let rps = [to_rps(v1), to_rps(v2), -to_rps(v3), -to_rps(v4)];
```

## Common Mistakes

| Mistake | Fix |
|---|---|
| Sending gripper commands to Servo ID 6 | Gripper is **Servo ID 10** (`1..5` are arm joints, `10` is gripper) |
| Using `mecanum.py` default `wheel_diameter=0.0065` | Typo in Hiwonder's default arg; real value in `odom_publisher_node.py` is `0.08` (80mm) |
| Running `/cmd_vel` without a watchdog | Always auto-zero motors after `600ms` without command so the robot never falls off a stage table |
| Lowering `joint2` below `200` pulse with `joint1` centered | Clashes with chassis LiDAR housing; clamp `joint2` to `220..780` |
| Running direct `/dev/rrc` while `ros_robot_controller_node` is active | Use `--backend ros2` when ROS 2 bringup is running, or stop bringup to use `--backend serial` |
