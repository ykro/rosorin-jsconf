use serde::{Deserialize, Serialize};
use std::f32::consts::PI;

/// Exact CRC8 lookup table used by Hiwonder STM32 `ros_robot_controller` firmware (`ros_robot_controller_sdk.py`).
pub const CRC8_TABLE: [u8; 256] = [
    0, 94, 188, 226, 97, 63, 221, 131, 194, 156, 126, 32, 163, 253, 31, 65,
    157, 195, 33, 127, 252, 162, 64, 30, 95, 1, 227, 189, 62, 96, 130, 220,
    35, 125, 159, 193, 66, 28, 254, 160, 225, 191, 93, 3, 128, 222, 60, 98,
    190, 224, 2, 92, 223, 129, 99, 61, 124, 34, 192, 158, 29, 67, 161, 255,
    70, 24, 250, 164, 39, 121, 155, 197, 132, 218, 56, 102, 229, 187, 89, 7,
    219, 133, 103, 57, 186, 228, 6, 88, 25, 71, 165, 251, 120, 38, 196, 154,
    101, 59, 217, 135, 4, 90, 184, 230, 167, 249, 27, 69, 198, 152, 122, 36,
    248, 166, 68, 26, 153, 199, 37, 123, 58, 100, 134, 216, 91, 5, 231, 185,
    140, 210, 48, 110, 237, 179, 81, 15, 78, 16, 242, 172, 47, 113, 147, 205,
    17, 79, 173, 243, 112, 46, 204, 146, 211, 141, 111, 49, 178, 236, 14, 80,
    175, 241, 19, 77, 206, 144, 114, 44, 109, 51, 209, 143, 12, 82, 176, 238,
    50, 108, 142, 208, 83, 13, 239, 177, 240, 174, 76, 18, 145, 207, 45, 115,
    202, 148, 118, 40, 171, 245, 23, 73, 8, 86, 180, 234, 105, 55, 213, 139,
    87, 9, 235, 181, 54, 104, 138, 212, 149, 203, 41, 119, 244, 170, 72, 22,
    233, 183, 85, 11, 136, 214, 52, 106, 43, 117, 151, 201, 74, 20, 246, 168,
    116, 42, 200, 150, 21, 75, 169, 247, 182, 232, 10, 84, 215, 137, 107, 53,
];

/// Function IDs for the STM32 serial protocol (`PacketFunction` in Hiwonder SDK).
#[repr(u8)]
#[allow(dead_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PacketFunction {
    Sys = 0,
    Led = 1,
    Buzzer = 2,
    Motor = 3,
    PwmServo = 4,
    BusServo = 5,
    Key = 6,
    Imu = 7,
    Gamepad = 8,
    Sbus = 9,
    Oled = 10,
}

/// Computes CRC8 checksum over `[func_id, data_len, ...data]`.
pub fn crc8(bytes: &[u8]) -> u8 {
    let mut check: u8 = 0;
    for &b in bytes {
        check = CRC8_TABLE[(check ^ b) as usize];
    }
    check
}

/// Alias for `crc8` (Dallas/Maxim CRC-8/MAXIM).
pub fn checksum_crc8(bytes: &[u8]) -> u8 {
    crc8(bytes)
}

/// Builds a framed binary packet `[0xAA, 0x55, func, len, ...data, crc8]` for `/dev/rrc`.
pub fn encode_frame(func: PacketFunction, data: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(data.len() + 5);
    buf.push(0xAA);
    buf.push(0x55);
    buf.push(func as u8);
    buf.push(data.len() as u8);
    buf.extend_from_slice(data);
    let crc = checksum_crc8(&buf[2..]);
    buf.push(crc);
    buf
}

/// ROSOrin Pro Mecanum chassis geometry verified from `odom_publisher_node.py`.
pub const WHEELBASE_M: f32 = 0.17706;
pub const TRACK_WIDTH_M: f32 = 0.17165;
pub const WHEEL_DIAMETER_M: f32 = 0.08;

/// Safe stage velocity limits for ROSOrin Pro (`[-0.25, 0.25] m/s`, `[-0.80, 0.80] rad/s`).
pub const MAX_LINEAR_MPS: f32 = 0.25;
pub const MAX_ANGULAR_RAD_S: f32 = 0.80;

/// Safe velocity bounds matching ROSOrin Pro `/cmd_vel` limits (`[-0.25, 0.25] m/s`, `[-0.8, 0.8] rad/s`).
pub fn clamp_velocity(linear_x: f32, linear_y: f32, angular_z: f32) -> (f32, f32, f32) {
    (
        linear_x.clamp(-MAX_LINEAR_MPS, MAX_LINEAR_MPS),
        linear_y.clamp(-MAX_LINEAR_MPS, MAX_LINEAR_MPS),
        angular_z.clamp(-MAX_ANGULAR_RAD_S, MAX_ANGULAR_RAD_S),
    )
}

/// Converts `(linear_x, linear_y, angular_z)` into 4 motor speeds in rotations per second (RPS).
/// Motors 3 and 4 (right side) are inverted in physical mounting as in Hiwonder `mecanum.py`.
pub fn mecanum_ik(linear_x: f32, linear_y: f32, angular_z: f32) -> [f32; 4] {
    let (vx, vy, wz) = clamp_velocity(linear_x, linear_y, angular_z);
    let k = (WHEELBASE_M + TRACK_WIDTH_M) / 2.0;
    let m1 = vx - vy - wz * k;
    let m2 = vx + vy - wz * k;
    let m3 = vx + vy + wz * k;
    let m4 = vx - vy + wz * k;
    let circumference = PI * WHEEL_DIAMETER_M;
    [
        m1 / circumference,
        m2 / circumference,
        -m3 / circumference,
        -m4 / circumference,
    ]
}

/// Encodes 4 motor RPS targets into an STM32 `PacketFunction::Motor` frame.
pub fn encode_motor_rps(rps: [f32; 4]) -> Vec<u8> {
    let mut data = Vec::with_capacity(2 + 4 * 5);
    data.push(0x01); // sub-command: set motor speed
    data.push(4); // 4 motors
    for (idx, speed) in rps.iter().enumerate() {
        data.push(idx as u8); // 0-based motor index in serial protocol
        data.extend_from_slice(&speed.to_le_bytes());
    }
    encode_frame(PacketFunction::Motor, &data)
}

/// Alias for `encode_motor_rps`.
#[allow(dead_code)]
pub fn encode_motor_speeds(rps: [f32; 4]) -> Vec<u8> {
    encode_motor_rps(rps)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct ServoTarget {
    pub id: u8,
    pub position: u16,
}

/// Returns true if `id` is a valid ROSOrin Pro bus servo ID (1..=5 arm joints, 10 parallel gripper).
pub fn is_valid_servo_id(id: u8) -> bool {
    matches!(id, 1 | 2 | 3 | 4 | 5 | 10)
}

/// Clamps bus servo pulse to mechanical safety limits so the 6-DOF arm never hits the LiDAR tower.
/// Valid IDs on ROSOrin Pro: 1..=5 (arm joints) and 10 (parallel gripper).
pub fn clamp_servo_pulse(id: u8, position: u16) -> u16 {
    match id {
        1 => position.clamp(120, 880),  // base pan
        2 => position.clamp(220, 780),  // shoulder pitch (<200 hits LiDAR housing)
        3 => position.clamp(150, 850),  // elbow pitch
        4 => position.clamp(150, 850),  // wrist pitch
        5 => position.clamp(100, 900),  // wrist roll
        10 => position.clamp(200, 750), // parallel gripper (200=open, 700=closed)
        _ => position.clamp(150, 850),
    }
}

/// Encodes a multi-servo trajectory command (`PacketFunction::BusServo`, sub-command `0x01`).
/// Filters to valid ROSOrin Pro servo IDs (max 6) and clamps `duration_ms` to `120..=5000`.
pub fn encode_bus_servos(duration_ms: u16, targets: &[ServoTarget]) -> Vec<u8> {
    let safe_duration = duration_ms.clamp(120, 5000);
    let valid_targets: Vec<ServoTarget> = targets
        .iter()
        .copied()
        .filter(|t| is_valid_servo_id(t.id))
        .take(6)
        .collect();
    let mut data = Vec::with_capacity(4 + valid_targets.len() * 3);
    data.push(0x01); // sub-command: set position
    data.extend_from_slice(&safe_duration.to_le_bytes());
    data.push(valid_targets.len() as u8);
    for t in valid_targets {
        let safe_pos = clamp_servo_pulse(t.id, t.position);
        data.push(t.id);
        data.extend_from_slice(&safe_pos.to_le_bytes());
    }
    encode_frame(PacketFunction::BusServo, &data)
}

/// Encodes a buzzer command (`PacketFunction::Buzzer`, `<HHHH`: freq_hz, on_ms, off_ms, repeat).
pub fn encode_buzzer(freq_hz: u16, on_ms: u16, off_ms: u16, repeat: u16) -> Vec<u8> {
    let mut data = Vec::with_capacity(8);
    data.extend_from_slice(&freq_hz.to_le_bytes());
    data.extend_from_slice(&on_ms.to_le_bytes());
    data.extend_from_slice(&off_ms.to_le_bytes());
    data.extend_from_slice(&repeat.to_le_bytes());
    encode_frame(PacketFunction::Buzzer, &data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_crc8_matches_hiwonder_sdk() {
        // Standard Dallas/Maxim CRC-8 check vector: "123456789" -> 0xA1
        assert_eq!(crc8(b"123456789"), 0xA1);
        assert_eq!(checksum_crc8(b"123456789"), 0xA1);

        // Exact byte slice check for encode_buzzer:
        // PacketFunction::Buzzer (0x02), len 8 (0x08),
        // freq=1900 (0x6C, 0x07), on=300 (0x2C, 0x01), off=10 (0x0A, 0x00), repeat=1 (0x01, 0x00)
        // CRC8 over [0x02, 0x08, 0x6C, 0x07, 0x2C, 0x01, 0x0A, 0x00, 0x01, 0x00] = 0x6C
        let buzzer_frame = encode_buzzer(1900, 300, 10, 1);
        assert_eq!(
            buzzer_frame,
            vec![0xAA, 0x55, 0x02, 0x08, 0x6C, 0x07, 0x2C, 0x01, 0x0A, 0x00, 0x01, 0x00, 0x6C]
        );

        // Exact byte slice check for encode_bus_servos (with duration clamping and invalid ID filtering):
        // duration=50 -> clamped to 120 (0x78, 0x00)
        // targets: id=1 pos=500 (0xF4, 0x01), id=99 (filtered out), id=10 pos=900 -> clamped to 750 (0xEE, 0x02)
        let servo_frame = encode_bus_servos(
            50,
            &[
                ServoTarget { id: 1, position: 500 },
                ServoTarget { id: 99, position: 500 },
                ServoTarget { id: 10, position: 900 },
            ],
        );
        assert_eq!(
            servo_frame,
            vec![
                0xAA, 0x55, 0x05, 0x0A, 0x01, 0x78, 0x00, 0x02, 0x01, 0xF4, 0x01, 0x0A, 0xEE, 0x02,
                0x06
            ]
        );

        // Exact byte slice check for encode_motor_speeds([0.0, 0.0, 0.0, 0.0]):
        let motor_frame = encode_motor_speeds([0.0, 0.0, 0.0, 0.0]);
        assert_eq!(
            motor_frame,
            vec![
                0xAA, 0x55, 0x03, 0x16, 0x01, 0x04,
                0x00, 0x00, 0x00, 0x00, 0x00,
                0x01, 0x00, 0x00, 0x00, 0x00,
                0x02, 0x00, 0x00, 0x00, 0x00,
                0x03, 0x00, 0x00, 0x00, 0x00,
                0x07
            ]
        );
    }

    #[test]
    fn test_mecanum_forward_and_strafe() {
        // Pure forward motion: left motors positive, right motors negative (due to inverted mount)
        let rps_fwd = mecanum_ik(0.15, 0.0, 0.0);
        assert!(rps_fwd[0] > 0.0 && rps_fwd[1] > 0.0);
        assert!(rps_fwd[2] < 0.0 && rps_fwd[3] < 0.0);
        assert!((rps_fwd[0] + rps_fwd[2]).abs() < 1e-5);

        // Pure strafe left (linear_y > 0): m1 < 0, m2 > 0, m3 > 0 (so -m3 < 0), m4 < 0 (so -m4 > 0)
        let rps_strafe = mecanum_ik(0.0, 0.15, 0.0);
        assert!(rps_strafe[0] < 0.0);
        assert!(rps_strafe[1] > 0.0);
    }

    #[test]
    fn test_servo_safety_clamping_and_validation() {
        assert!(is_valid_servo_id(1));
        assert!(is_valid_servo_id(5));
        assert!(is_valid_servo_id(10));
        assert!(!is_valid_servo_id(0));
        assert!(!is_valid_servo_id(6));
        assert!(!is_valid_servo_id(99));

        // Shoulder joint2 must never drop below 220 to protect the LiDAR tower
        assert_eq!(clamp_servo_pulse(2, 50), 220);
        assert_eq!(clamp_servo_pulse(2, 950), 780);
        // Gripper ID 10 clamped to 200..=750
        assert_eq!(clamp_servo_pulse(10, 0), 200);
        assert_eq!(clamp_servo_pulse(10, 999), 750);
    }
}
