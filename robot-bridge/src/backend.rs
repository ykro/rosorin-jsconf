use crate::gestures::get_gesture;
use crate::protocol::{
    clamp_servo_pulse, clamp_velocity, encode_bus_servos, encode_buzzer, encode_motor_rps,
    is_valid_servo_id, mecanum_ik, ServoTarget,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tracing::{info, warn};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LidarSectors {
    pub front_m: f32,
    pub left_m: f32,
    pub right_m: f32,
    pub back_m: f32,
    pub obstacle_alert: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OdometryState {
    pub x_m: f32,
    pub y_m: f32,
    pub yaw_rad: f32,
    pub vx: f32,
    pub vy: f32,
    pub wz: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryState {
    pub backend: String,
    pub connected: bool,
    pub battery_mv: u16,
    pub servos: BTreeMap<u8, u16>,
    pub target_servos: BTreeMap<u8, u16>,
    pub rgb: [u8; 3],
    pub active_gesture: String,
    pub mood: String,
    pub held_object: String,
    pub pointed_totem: Option<String>,
    pub speaking: bool,
    pub listening: bool,
    pub hud_headline: String,
    pub hud_subtext: String,
    pub odometry: OdometryState,
    pub lidar: LidarSectors,
    pub last_command_ms_ago: u64,
    pub timestamp_ms: u64,
}

impl Default for TelemetryState {
    fn default() -> Self {
        let mut servos = BTreeMap::new();
        servos.insert(1, 500);
        servos.insert(2, 430);
        servos.insert(3, 310);
        servos.insert(4, 380);
        servos.insert(5, 500);
        servos.insert(10, 500); // Gripper ID 10
        let target_servos = servos.clone();
        Self {
            backend: "mock".into(),
            connected: true,
            battery_mv: 11850,
            servos,
            target_servos,
            rgb: [15, 118, 110],
            active_gesture: "home".into(),
            mood: "attentive".into(),
            held_object: "deploy_key".into(),
            pointed_totem: None,
            speaking: false,
            listening: false,
            hud_headline: "LISTO EN ESCENARIO".into(),
            hud_subtext: "ROSOrin Pro · Gemini Live".into(),
            odometry: OdometryState {
                x_m: 0.0,
                y_m: 0.0,
                yaw_rad: 0.0,
                vx: 0.0,
                vy: 0.0,
                wz: 0.0,
            },
            lidar: LidarSectors {
                front_m: 1.42,
                left_m: 1.85,
                right_m: 1.76,
                back_m: 2.10,
                obstacle_alert: false,
            },
            last_command_ms_ago: 0,
            timestamp_ms: now_ms(),
        }
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Escapes special XML characters to prevent SVG injection in `/camera/frame`.
pub fn xml_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

pub struct Ros2ProcessDriver {
    pub stdin: ChildStdin,
    pub child: Child,
}

impl Drop for Ros2ProcessDriver {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub enum DriverKind {
    Mock,
    Serial(Mutex<Box<dyn serialport::SerialPort>>),
    Ros2(Mutex<Ros2ProcessDriver>),
}

pub struct RobotController {
    pub state: Arc<Mutex<TelemetryState>>,
    pub servo_speeds_pps: Mutex<BTreeMap<u8, f32>>,
    pub last_cmd_vel_at: Mutex<Instant>,
    pub cmd_deadline: Mutex<Option<Instant>>,
    pub gesture_epoch: AtomicU64,
    pub estop_latched: AtomicBool,
    pub latest_jpeg: Arc<Mutex<Option<Vec<u8>>>>,
    pub driver: DriverKind,
    pub watchdog_timeout: Duration,
}

#[allow(dead_code)]
pub type BridgeService = RobotController;

fn default_servo_speeds() -> BTreeMap<u8, f32> {
    let mut m = BTreeMap::new();
    for id in [1, 2, 3, 4, 5, 10] {
        m.insert(id, 900.0);
    }
    m
}

impl RobotController {
    pub fn new(
        backend_name: &str,
        serial_port_path: &str,
        baud_rate: u32,
        watchdog_ms: u64,
    ) -> Arc<Self> {
        let mut initial_state = TelemetryState::default();
        let resolved_serial = std::fs::canonicalize(serial_port_path)
            .ok()
            .and_then(|p| p.into_os_string().into_string().ok())
            .unwrap_or_else(|| serial_port_path.to_string());

        let driver = match backend_name {
            "serial" => match serialport::new(&resolved_serial, baud_rate)
                .timeout(Duration::from_millis(50))
                .open()
            {
                Ok(mut port) => {
                    let _ = port.write_data_terminal_ready(false);
                    let _ = port.write_request_to_send(false);
                    info!(
                        "Opened STM32 serial controller at {} ({}) @ {} baud",
                        serial_port_path, resolved_serial, baud_rate
                    );
                    initial_state.backend = "serial".into();
                    DriverKind::Serial(Mutex::new(port))
                }
                Err(e) => {
                    warn!(
                        "Direct serial open on {} ({}) returned: {}. Trying ROS 2 / pyserial worker before mock...",
                        serial_port_path, resolved_serial, e
                    );
                    match Self::spawn_ros2_worker() {
                        Ok((proc_driver, state_ref, jpeg_ref)) => {
                            info!("Connected to physical robot via ros2_worker fallback");
                            return Arc::new(Self {
                                state: state_ref,
                                servo_speeds_pps: Mutex::new(default_servo_speeds()),
                                last_cmd_vel_at: Mutex::new(Instant::now()),
                                cmd_deadline: Mutex::new(None),
                                gesture_epoch: AtomicU64::new(0),
                                estop_latched: AtomicBool::new(false),
                                latest_jpeg: jpeg_ref,
                                driver: DriverKind::Ros2(Mutex::new(proc_driver)),
                                watchdog_timeout: Duration::from_millis(watchdog_ms),
                            });
                        }
                        Err(ros_err) => {
                            warn!(
                                "Failed both serial ({}) and ros2_worker ({}); falling back to mock",
                                e, ros_err
                            );
                            initial_state.backend = "mock (serial-fallback)".into();
                            DriverKind::Mock
                        }
                    }
                }
            },
            "ros2" => match Self::spawn_ros2_worker() {
                Ok((proc_driver, state_ref, jpeg_ref)) => {
                    initial_state.backend = "ros2".into();
                    return Arc::new(Self {
                        state: state_ref,
                        servo_speeds_pps: Mutex::new(default_servo_speeds()),
                        last_cmd_vel_at: Mutex::new(Instant::now()),
                        cmd_deadline: Mutex::new(None),
                        gesture_epoch: AtomicU64::new(0),
                        estop_latched: AtomicBool::new(false),
                        latest_jpeg: jpeg_ref,
                        driver: DriverKind::Ros2(Mutex::new(proc_driver)),
                        watchdog_timeout: Duration::from_millis(watchdog_ms),
                    });
                }
                Err(e) => {
                    warn!(
                        "Failed to spawn ROS 2 rclpy worker ({}); falling back to mock",
                        e
                    );
                    initial_state.backend = "mock (ros2-fallback)".into();
                    DriverKind::Mock
                }
            },
            _ => {
                initial_state.backend = "mock".into();
                DriverKind::Mock
            }
        };

        Arc::new(Self {
            state: Arc::new(Mutex::new(initial_state)),
            servo_speeds_pps: Mutex::new(default_servo_speeds()),
            last_cmd_vel_at: Mutex::new(Instant::now()),
            cmd_deadline: Mutex::new(None),
            gesture_epoch: AtomicU64::new(0),
            estop_latched: AtomicBool::new(false),
            latest_jpeg: Arc::new(Mutex::new(None)),
            driver,
            watchdog_timeout: Duration::from_millis(watchdog_ms),
        })
    }

    pub fn is_mock(&self) -> bool {
        matches!(self.driver, DriverKind::Mock)
    }

    fn resolve_worker_script() -> PathBuf {
        let rel = PathBuf::from("scripts/ros2_worker.py");
        if rel.exists() {
            return rel;
        }
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("scripts/ros2_worker.py")
    }

    #[allow(clippy::type_complexity)]
    fn spawn_ros2_worker() -> anyhow::Result<(
        Ros2ProcessDriver,
        Arc<Mutex<TelemetryState>>,
        Arc<Mutex<Option<Vec<u8>>>>,
    )> {
        use base64::Engine as _;
        use std::io::{BufRead, BufReader};

        let script_path = Self::resolve_worker_script();
        let mut child = Command::new("python3")
            .arg(&script_path)
            .env("ROS_LOCALHOST_ONLY", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow::anyhow!("Failed to capture ros2_worker stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("Failed to capture ros2_worker stdout"))?;

        let mut reader = BufReader::new(stdout);
        let mut first_line = String::new();
        let bytes_read = reader.read_line(&mut first_line)?;
        if bytes_read == 0 {
            let _ = child.kill();
            let _ = child.wait();
            return Err(anyhow::anyhow!(
                "ros2_worker exited without connecting to any hardware transport"
            ));
        }

        let mut detected_name = "ros2".to_string();
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(first_line.trim()) {
            if let Some(name) = v.get("name").and_then(|s| s.as_str()) {
                detected_name = name.to_string();
            }
        }

        let initial = TelemetryState {
            backend: detected_name,
            ..Default::default()
        };
        let state_mutex = Arc::new(Mutex::new(initial));
        let jpeg_mutex = Arc::new(Mutex::new(None));

        let state_reader = Arc::clone(&state_mutex);
        let jpeg_reader = Arc::clone(&jpeg_mutex);

        std::thread::spawn(move || {
            for line in reader.lines().map_while(Result::ok) {
                if line.starts_with('{') {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                        match v.get("event").and_then(|s| s.as_str()) {
                            Some("camera_jpeg") => {
                                if let Some(b64) = v.get("b64").and_then(|s| s.as_str()) {
                                    if let Ok(bytes) =
                                        base64::engine::general_purpose::STANDARD.decode(b64)
                                    {
                                        *jpeg_reader.lock().unwrap() = Some(bytes);
                                    }
                                }
                            }
                            Some("battery") => {
                                if let Some(mv) = v.get("mv").and_then(|n| n.as_u64()) {
                                    state_reader.lock().unwrap().battery_mv = mv as u16;
                                }
                            }
                            Some("lidar") => {
                                let mut st = state_reader.lock().unwrap();
                                if let Some(f) = v.get("front_m").and_then(|n| n.as_f64()) {
                                    st.lidar.front_m = (f as f32).clamp(0.05, 12.0);
                                }
                                if let Some(l) = v.get("left_m").and_then(|n| n.as_f64()) {
                                    st.lidar.left_m = (l as f32).clamp(0.05, 12.0);
                                }
                                if let Some(r) = v.get("right_m").and_then(|n| n.as_f64()) {
                                    st.lidar.right_m = (r as f32).clamp(0.05, 12.0);
                                }
                                if let Some(b) = v.get("back_m").and_then(|n| n.as_f64()) {
                                    st.lidar.back_m = (b as f32).clamp(0.05, 12.0);
                                }
                                st.lidar.obstacle_alert =
                                    st.lidar.front_m < 0.35 || st.lidar.back_m < 0.35;
                            }
                            _ => {
                                info!(target: "ros2_worker", "{}", line);
                            }
                        }
                    }
                }
            }
        });

        Ok((Ros2ProcessDriver { stdin, child }, state_mutex, jpeg_mutex))
    }

    fn send_velocity_to_driver(&self, vx: f32, vy: f32, wz: f32) {
        match &self.driver {
            DriverKind::Mock => {}
            DriverKind::Serial(port_mtx) => {
                let rps = mecanum_ik(vx, vy, wz);
                let frame = encode_motor_rps(rps);
                if let Ok(mut port) = port_mtx.lock() {
                    let _ = port.write_all(&frame);
                }
            }
            DriverKind::Ros2(proc_mtx) => {
                let cmd = serde_json::json!({
                    "op": "cmd_vel",
                    "linear_x": vx,
                    "linear_y": vy,
                    "angular_z": wz,
                });
                if let Ok(mut proc) = proc_mtx.lock() {
                    let _ = writeln!(proc.stdin, "{}", cmd);
                }
            }
        }
    }

    fn send_arm_to_driver(&self, duration_ms: u16, clamped: &[ServoTarget]) {
        let safe_duration = duration_ms.clamp(120, 5000);
        match &self.driver {
            DriverKind::Mock => {}
            DriverKind::Serial(port_mtx) => {
                let frame = encode_bus_servos(safe_duration, clamped);
                if let Ok(mut port) = port_mtx.lock() {
                    let _ = port.write_all(&frame);
                }
            }
            DriverKind::Ros2(proc_mtx) => {
                let cmd = serde_json::json!({
                    "op": "arm",
                    "duration_s": (safe_duration as f32) / 1000.0,
                    "servos": clamped,
                });
                if let Ok(mut proc) = proc_mtx.lock() {
                    let _ = writeln!(proc.stdin, "{}", cmd);
                }
            }
        }
    }

    fn apply_velocity_internal(
        &self,
        linear_x: f32,
        linear_y: f32,
        angular_z: f32,
        duration_ms: Option<u64>,
    ) {
        let (mut vx, vy, wz) = clamp_velocity(linear_x, linear_y, angular_z);

        // LiDAR safety reflex: block forward velocity if front_m < 0.28m, or backward if back_m < 0.28m
        {
            let mut st = self.state.lock().unwrap();
            if st.lidar.front_m < 0.28 && vx > 0.0 {
                warn!(
                    "LiDAR safety reflex triggered (front_m = {:.2}m < 0.28m): clamping forward vx to 0",
                    st.lidar.front_m
                );
                vx = 0.0;
                st.lidar.obstacle_alert = true;
            } else if st.lidar.back_m < 0.28 && vx < 0.0 {
                warn!(
                    "LiDAR safety reflex triggered (back_m = {:.2}m < 0.28m): clamping reverse vx to 0",
                    st.lidar.back_m
                );
                vx = 0.0;
                st.lidar.obstacle_alert = true;
            } else {
                st.lidar.obstacle_alert = st.lidar.front_m < 0.35 || st.lidar.back_m < 0.35;
            }
            st.odometry.vx = vx;
            st.odometry.vy = vy;
            st.odometry.wz = wz;
            st.timestamp_ms = now_ms();
        }

        let now = Instant::now();
        *self.last_cmd_vel_at.lock().unwrap() = now;

        let is_moving = vx.abs() > 1e-4 || vy.abs() > 1e-4 || wz.abs() > 1e-4;
        if is_moving {
            let default_ms = (self.watchdog_timeout.as_millis() as u64).max(100);
            let dur_ms = duration_ms.unwrap_or(default_ms).clamp(100, 2500);
            *self.cmd_deadline.lock().unwrap() = Some(now + Duration::from_millis(dur_ms));
        } else {
            *self.cmd_deadline.lock().unwrap() = None;
        }

        self.send_velocity_to_driver(vx, vy, wz);
    }

    #[allow(dead_code)]
    pub fn set_velocity(&self, linear_x: f32, linear_y: f32, angular_z: f32) {
        self.set_velocity_with_duration(linear_x, linear_y, angular_z, None);
    }

    pub fn set_velocity_with_duration(
        &self,
        linear_x: f32,
        linear_y: f32,
        angular_z: f32,
        duration_ms: Option<u64>,
    ) {
        self.estop_latched.store(false, Ordering::SeqCst);
        self.gesture_epoch.fetch_add(1, Ordering::SeqCst);
        self.apply_velocity_internal(linear_x, linear_y, angular_z, duration_ms);
    }

    fn apply_arm_internal(&self, duration_ms: u16, targets: &[ServoTarget]) {
        let safe_duration = duration_ms.clamp(120, 5000);
        let dur_s = (safe_duration as f32) / 1000.0;
        let mut clamped = Vec::with_capacity(targets.len().min(6));
        {
            let mut st = self.state.lock().unwrap();
            let mut speeds = self.servo_speeds_pps.lock().unwrap();
            for t in targets.iter().filter(|t| is_valid_servo_id(t.id)).take(6) {
                let safe = clamp_servo_pulse(t.id, t.position);
                let current = st.servos.get(&t.id).copied().unwrap_or(safe);
                st.servos.entry(t.id).or_insert(safe);
                st.target_servos.insert(t.id, safe);

                let delta = (safe as f32 - current as f32).abs();
                let speed_pps = if delta < 1.0 {
                    900.0
                } else {
                    (delta / dur_s).clamp(150.0, 1800.0)
                };
                speeds.insert(t.id, speed_pps);

                clamped.push(ServoTarget {
                    id: t.id,
                    position: safe,
                });
            }
            st.timestamp_ms = now_ms();
        }

        self.send_arm_to_driver(safe_duration, &clamped);
    }

    pub fn set_arm(&self, duration_ms: u16, targets: &[ServoTarget]) {
        self.estop_latched.store(false, Ordering::SeqCst);
        self.gesture_epoch.fetch_add(1, Ordering::SeqCst);
        self.apply_arm_internal(duration_ms, targets);
    }

    pub fn jog_servo(&self, id: u8, delta: i16) -> u16 {
        let current = {
            let st = self.state.lock().unwrap();
            st.target_servos
                .get(&id)
                .copied()
                .or_else(|| st.servos.get(&id).copied())
                .unwrap_or(500)
        };
        let raw = (current as i32 + delta as i32).clamp(0, 1000) as u16;
        let next = clamp_servo_pulse(id, raw);
        self.set_arm(120, &[ServoTarget { id, position: next }]);
        next
    }

    pub fn reset_scene(&self) {
        self.estop_latched.store(false, Ordering::SeqCst);
        self.gesture_epoch.fetch_add(1, Ordering::SeqCst);
        self.apply_velocity_internal(0.0, 0.0, 0.0, None);
        let home = get_gesture("home");
        if let Some(first) = home.steps.first() {
            self.apply_arm_internal(first.duration_ms, &first.servos);
        }
        self.set_rgb(home.rgb.0, home.rgb.1, home.rgb.2);
        let mut st = self.state.lock().unwrap();
        st.odometry = OdometryState {
            x_m: 0.0,
            y_m: 0.0,
            yaw_rad: 0.0,
            vx: 0.0,
            vy: 0.0,
            wz: 0.0,
        };
        st.held_object = "deploy_key".into();
        st.pointed_totem = None;
        st.active_gesture = "home".into();
        st.mood = "attentive".into();
        st.speaking = false;
        st.hud_headline = "POSICIÓN INICIAL".into();
        st.hud_subtext = "ROSOrin Pro · Centrado".into();
        st.timestamp_ms = now_ms();
    }

    pub fn update_hud(
        &self,
        speaking: Option<bool>,
        listening: Option<bool>,
        headline: Option<String>,
        subtext: Option<String>,
        mood: Option<String>,
    ) {
        let mut st = self.state.lock().unwrap();
        if let Some(sp) = speaking {
            st.speaking = sp;
        }
        if let Some(ls) = listening {
            st.listening = ls;
        }
        if let Some(h) = headline {
            let trimmed = h.trim();
            if !trimmed.is_empty() {
                st.hud_headline = trimmed.chars().take(200).collect();
            }
        }
        if let Some(sub) = subtext {
            st.hud_subtext = sub.chars().take(200).collect();
        }
        if let Some(m) = mood {
            st.mood = m.chars().take(64).collect();
        }
        st.timestamp_ms = now_ms();
    }

    pub fn set_rgb(&self, r: u8, g: u8, b: u8) {
        {
            let mut st = self.state.lock().unwrap();
            st.rgb = [r, g, b];
            st.timestamp_ms = now_ms();
        }
        if let DriverKind::Ros2(proc_mtx) = &self.driver {
            let cmd = serde_json::json!({ "op": "rgb", "r": r, "g": g, "b": b });
            if let Ok(mut proc) = proc_mtx.lock() {
                let _ = writeln!(proc.stdin, "{}", cmd);
            }
        }
    }

    pub fn set_buzzer(&self, freq_hz: u16, on_ms: u16, off_ms: u16, repeat: u16) {
        let safe_repeat = repeat.min(5);
        let safe_on = on_ms.min(2000);
        let safe_off = off_ms.min(2000);
        match &self.driver {
            DriverKind::Mock => {}
            DriverKind::Serial(port_mtx) => {
                let frame = encode_buzzer(freq_hz, safe_on, safe_off, safe_repeat);
                if let Ok(mut port) = port_mtx.lock() {
                    let _ = port.write_all(&frame);
                }
            }
            DriverKind::Ros2(proc_mtx) => {
                let cmd = serde_json::json!({
                    "op": "buzzer",
                    "freq": freq_hz,
                    "on_s": (safe_on as f32) / 1000.0,
                    "off_s": (safe_off as f32) / 1000.0,
                    "repeat": safe_repeat,
                });
                if let Ok(mut proc) = proc_mtx.lock() {
                    let _ = writeln!(proc.stdin, "{}", cmd);
                }
            }
        }
    }

    /// Emergency stop (`/stop`): cancels any active gesture via `gesture_epoch`, zeroes chassis
    /// velocity, silences buzzer, and freezes the 6-DOF arm at its current servo positions
    /// (does NOT swing the arm to `home` on emergency stop).
    pub fn stop_all(&self) {
        self.estop_latched.store(true, Ordering::SeqCst);
        self.gesture_epoch.fetch_add(1, Ordering::SeqCst);
        self.apply_velocity_internal(0.0, 0.0, 0.0, None);
        self.set_buzzer(0, 0, 0, 0);

        let frozen_targets: Vec<ServoTarget> = {
            let mut st = self.state.lock().unwrap();
            let current = st.servos.clone();
            st.target_servos = current.clone();
            st.active_gesture = "stopped".into();
            st.mood = "attentive".into();
            st.speaking = false;
            st.timestamp_ms = now_ms();
            current
                .into_iter()
                .map(|(id, position)| ServoTarget { id, position })
                .collect()
        };
        self.send_arm_to_driver(120, &frozen_targets);
    }

    pub fn run_gesture(self: &Arc<Self>, name: &str, mood_override: Option<String>) {
        self.estop_latched.store(false, Ordering::SeqCst);
        let my_epoch = self.gesture_epoch.fetch_add(1, Ordering::SeqCst) + 1;
        let seq = get_gesture(name);
        {
            let mut st = self.state.lock().unwrap();
            st.active_gesture = seq.name.clone();
            if let Some(m) = mood_override {
                st.mood = m.chars().take(64).collect();
            } else {
                st.mood = seq.name.clone();
            }
            match seq.name.as_str() {
                "gatekeeper_hold" => {
                    st.held_object = "deploy_key".into();
                    st.pointed_totem = None;
                    st.odometry.x_m = 0.0;
                    st.odometry.y_m = 0.0;
                    st.hud_headline = "CUSTODIANDO LLAVE".into();
                    st.hud_subtext = "Servo ID 10 · Pulso Cerrado 680".into();
                }
                "gatekeeper_approve" => {
                    st.held_object = "released_approved".into();
                    st.hud_headline = "DEPLOY APROBADO".into();
                    st.hud_subtext = "Llave liberada en Bandeja Verde".into();
                }
                "gatekeeper_reject" => {
                    st.held_object = "released_rejected".into();
                    st.hud_headline = "DEPLOY RECHAZADO".into();
                    st.hud_subtext = "PR bloqueado en Bandeja Roja".into();
                }
                "point_cloud_run" => {
                    st.pointed_totem = Some("cloud_run".into());
                    st.odometry.x_m = 0.04;
                    st.odometry.y_m = 0.20;
                    st.hud_headline = "CLOUD RUN · OOM".into();
                    st.hud_subtext = "Tótem Izquierdo (Y = +20 cm)".into();
                }
                "point_gemini_live" => {
                    st.pointed_totem = Some("gemini_live".into());
                    st.odometry.x_m = 0.06;
                    st.odometry.y_m = 0.0;
                    st.hud_headline = "GEMINI LIVE · PCM".into();
                    st.hud_subtext = "Tótem Central (Y = 0 cm)".into();
                }
                "point_firestore" => {
                    st.pointed_totem = Some("firestore".into());
                    st.odometry.x_m = 0.04;
                    st.odometry.y_m = -0.20;
                    st.hud_headline = "FIRESTORE · ÍNDICE".into();
                    st.hud_subtext = "Tótem Derecho (Y = -20 cm)".into();
                }
                "facepalm" => {
                    st.hud_headline = "CÓDIGO CRÍTICO".into();
                    st.hud_subtext = "Gesto: Facepalm".into();
                }
                "trash_toss" => {
                    st.hud_headline = "A LA BASURA".into();
                    st.hud_subtext = "Gesto: Trash Toss".into();
                }
                "chef_kiss" => {
                    st.hud_headline = "ARQUITECTURA LIMPIA".into();
                    st.hud_subtext = "Gesto: Chef Kiss".into();
                }
                "victory_spin" => {
                    st.hud_headline = "DEPLOY EXITOSO".into();
                    st.hud_subtext = "Gesto: Giro de Victoria".into();
                }
                "wave_hello" => {
                    st.hud_headline = "¡HOLA JSCONF MX!".into();
                    st.hud_subtext = "ROSOrin Pro · En Vivo".into();
                }
                _ => {}
            }
        }
        self.set_rgb(seq.rgb.0, seq.rgb.1, seq.rgb.2);
        if let Some((freq, on_ms, off_ms, rep)) = seq.buzzer {
            self.set_buzzer(freq, on_ms, off_ms, rep);
        }

        let ctrl = Arc::clone(self);
        tokio::spawn(async move {
            for step in seq.steps {
                if ctrl.gesture_epoch.load(Ordering::SeqCst) != my_epoch {
                    return;
                }
                ctrl.apply_arm_internal(step.duration_ms, &step.servos);
                let mut remaining = step.duration_ms as u64;
                while remaining > 0 {
                    if ctrl.gesture_epoch.load(Ordering::SeqCst) != my_epoch {
                        return;
                    }
                    if let Some((vx, vy, wz)) = step.velocity {
                        ctrl.apply_velocity_internal(vx, vy, wz, Some(250));
                    }
                    let slice = remaining.min(25);
                    tokio::time::sleep(Duration::from_millis(slice)).await;
                    remaining -= slice;
                }
            }
            if ctrl.gesture_epoch.load(Ordering::SeqCst) == my_epoch {
                ctrl.apply_velocity_internal(0.0, 0.0, 0.0, None);
            }
        });
    }

    /// Periodic 40Hz physics + servo interpolation + LiDAR reflex + watchdog tick.
    pub fn tick(&self, dt_s: f32) {
        let now = Instant::now();
        let elapsed = self.last_cmd_vel_at.lock().unwrap().elapsed();

        let deadline_expired = {
            let mut dl = self.cmd_deadline.lock().unwrap();
            if let Some(deadline) = *dl {
                if now >= deadline {
                    *dl = None;
                    true
                } else {
                    false
                }
            } else {
                let st = self.state.lock().unwrap();
                let moving = st.odometry.vx.abs() > 1e-4
                    || st.odometry.vy.abs() > 1e-4
                    || st.odometry.wz.abs() > 1e-4;
                moving && elapsed > self.watchdog_timeout
            }
        };

        if deadline_expired {
            self.apply_velocity_internal(0.0, 0.0, 0.0, None);
        }

        // 40 Hz continuous LiDAR brake reflex (front_m < 0.28m when vx > 0, back_m < 0.28m when vx < 0)
        let lidar_brake = {
            let mut st = self.state.lock().unwrap();
            if (st.lidar.front_m < 0.28 && st.odometry.vx > 0.0)
                || (st.lidar.back_m < 0.28 && st.odometry.vx < 0.0)
            {
                st.odometry.vx = 0.0;
                st.lidar.obstacle_alert = true;
                Some((0.0, st.odometry.vy, st.odometry.wz))
            } else {
                st.lidar.obstacle_alert = st.lidar.front_m < 0.35 || st.lidar.back_m < 0.35;
                None
            }
        };

        if let Some((vx, vy, wz)) = lidar_brake {
            self.send_velocity_to_driver(vx, vy, wz);
        }

        let speeds = self.servo_speeds_pps.lock().unwrap().clone();
        let mut st = self.state.lock().unwrap();
        let yaw = st.odometry.yaw_rad;
        let vx = st.odometry.vx;
        let vy = st.odometry.vy;
        let wz = st.odometry.wz;
        st.odometry.x_m += (vx * yaw.cos() - vy * yaw.sin()) * dt_s;
        st.odometry.y_m += (vx * yaw.sin() + vy * yaw.cos()) * dt_s;
        st.odometry.yaw_rad += wz * dt_s;

        // Smoothly interpolate each servo in `st.servos` toward `st.target_servos` using per-servo `speed_pps`
        let targets: Vec<(u8, u16)> = st.target_servos.iter().map(|(&k, &v)| (k, v)).collect();
        for (id, target) in targets {
            let speed_pps = speeds.get(&id).copied().unwrap_or(900.0);
            let max_step = (speed_pps * dt_s).max(1.0);
            let current = st.servos.get(&id).copied().unwrap_or(target);
            let diff = (target as f32) - (current as f32);
            let next = if diff.abs() <= max_step {
                target
            } else if diff > 0.0 {
                ((current as f32) + max_step).round() as u16
            } else {
                ((current as f32) - max_step).round() as u16
            };
            st.servos.insert(id, next);
        }

        // Update held_object when gripper (ID 10) opens below 320 pulse
        let gripper_pulse = st.servos.get(&10).copied().unwrap_or(500);
        if gripper_pulse < 320 {
            match st.active_gesture.as_str() {
                "gatekeeper_approve" => st.held_object = "released_approved".into(),
                "gatekeeper_reject" | "trash_toss" => st.held_object = "released_rejected".into(),
                _ => {}
            }
        }

        st.last_command_ms_ago = elapsed.as_millis() as u64;
        st.timestamp_ms = now_ms();
    }

    pub fn snapshot(&self) -> TelemetryState {
        self.state.lock().unwrap().clone()
    }

    /// Generates an SVG camera view representing the Aurora 930 Pro 3D view in Mock mode,
    /// or returns the latest JPEG frame captured from `/depth_cam/rgb0/image_raw`.
    pub fn get_camera_svg(&self) -> String {
        let st = self.snapshot();
        let j1 = st.servos.get(&1).copied().unwrap_or(500);
        let j2 = st.servos.get(&2).copied().unwrap_or(520);
        let j3 = st.servos.get(&3).copied().unwrap_or(360);
        let j10 = st.servos.get(&10).copied().unwrap_or(500);
        let [r, g, b] = st.rgb;
        let safe_gesture = xml_escape(&st.active_gesture);
        let safe_mood = xml_escape(&st.mood);
        format!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
  <rect width="640" height="480" fill="#F8F7F4"/>
  <rect x="24" y="24" width="592" height="432" rx="16" fill="#FFFFFF" stroke="#DFDDD4" stroke-width="2"/>
  <circle cx="56" cy="58" r="10" fill="rgb({r},{g},{b})"/>
  <text x="78" y="64" font-family="monospace" font-size="18" font-weight="bold" fill="#18181B">AURORA 930 PRO 3D · /depth_cam/rgb0/image_raw</text>
  <line x1="44" y1="86" x2="596" y2="86" stroke="#DFDDD4" stroke-width="1.5"/>
  <text x="48" y="124" font-family="sans-serif" font-size="22" font-weight="bold" fill="#18181B">Gesture: {gesture} · Mood: {mood}</text>
  <text x="48" y="160" font-family="monospace" font-size="17" fill="#3F3F46">Arm Pulses: J1={j1} J2={j2} J3={j3} Gripper(ID10)={j10}</text>
  <text x="48" y="190" font-family="monospace" font-size="17" fill="#3F3F46">Mecanum Vel: vx={vx:.2}m/s vy={vy:.2}m/s wz={wz:.2}rad/s</text>
  <text x="48" y="220" font-family="monospace" font-size="17" fill="#0F766E">LiDAR /scan Front: {front:.2}m · Battery: {bat:.2}V</text>
  <g transform="translate(320, 340)">
    <rect x="-70" y="20" width="140" height="44" rx="8" fill="#18181B"/>
    <circle cx="-48" cy="64" r="16" fill="#B45309"/>
    <circle cx="48" cy="64" r="16" fill="#B45309"/>
    <line x1="0" y1="20" x2="{arm_x}" y2="-55" stroke="rgb({r},{g},{b})" stroke-width="12" stroke-linecap="round"/>
    <circle cx="{arm_x}" cy="-55" r="14" fill="#18181B"/>
  </g>
</svg>"##,
            r = r,
            g = g,
            b = b,
            gesture = safe_gesture,
            mood = safe_mood,
            j1 = j1,
            j2 = j2,
            j3 = j3,
            j10 = j10,
            vx = st.odometry.vx,
            vy = st.odometry.vy,
            wz = st.odometry.wz,
            front = st.lidar.front_m,
            bat = (st.battery_mv as f32) / 1000.0,
            arm_x = ((j1 as i32 - 500) / 5),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_servo_smooth_interpolation_and_gripper_release() {
        let ctrl = RobotController::new("mock", "/dev/null", 1_000_000, 600);
        {
            let mut st = ctrl.state.lock().unwrap();
            st.active_gesture = "gatekeeper_approve".into();
        }
        ctrl.set_arm(
            450,
            &[
                ServoTarget { id: 1, position: 680 },
                ServoTarget { id: 10, position: 220 },
            ],
        );

        let snap0 = ctrl.snapshot();
        assert_eq!(snap0.target_servos.get(&1), Some(&680));
        assert_eq!(snap0.servos.get(&1), Some(&500));
        assert_eq!(snap0.held_object, "deploy_key");

        ctrl.tick(0.025);
        let snap1 = ctrl.snapshot();
        let s1 = *snap1.servos.get(&1).unwrap();
        assert!(s1 > 500 && s1 < 680);

        for _ in 0..20 {
            ctrl.tick(0.025);
        }
        let snap_final = ctrl.snapshot();
        assert_eq!(snap_final.servos.get(&1), Some(&680));
        assert_eq!(snap_final.servos.get(&10), Some(&220));
        assert_eq!(snap_final.held_object, "released_approved");

        ctrl.reset_scene();
        let snap_reset = ctrl.snapshot();
        assert_eq!(snap_reset.held_object, "deploy_key");
        assert_eq!(snap_reset.pointed_totem, None);
        assert_eq!(snap_reset.target_servos.get(&1), Some(&500));
    }

    #[test]
    fn test_jog_servo_clamping() {
        let ctrl = RobotController::new("mock", "/dev/null", 1_000_000, 600);
        let next = ctrl.jog_servo(2, -400);
        assert_eq!(next, 220);
        assert_eq!(ctrl.snapshot().target_servos.get(&2), Some(&220));
    }

    #[tokio::test]
    async fn test_stop_cancels_active_gesture_and_freezes_arm() {
        let ctrl = RobotController::new("mock", "/dev/null", 1_000_000, 600);
        ctrl.run_gesture("victory_spin", None);
        tokio::time::sleep(Duration::from_millis(60)).await;
        ctrl.tick(0.025);

        // Emergency stop should freeze arm at current servo positions (NOT snap to 500 home)
        ctrl.stop_all();
        let snap_stopped = ctrl.snapshot();
        assert_eq!(snap_stopped.odometry.vx, 0.0);
        assert_eq!(snap_stopped.odometry.vy, 0.0);
        assert_eq!(snap_stopped.odometry.wz, 0.0);
        assert_eq!(snap_stopped.servos, snap_stopped.target_servos);

        // Wait longer and ensure the cancelled gesture task does NOT overwrite velocity or targets
        tokio::time::sleep(Duration::from_millis(120)).await;
        let snap_after = ctrl.snapshot();
        assert_eq!(snap_after.odometry.wz, 0.0);
        assert_eq!(snap_after.target_servos, snap_stopped.target_servos);
    }

    #[test]
    fn test_duration_ms_deadline_and_lidar_brake_in_tick() {
        let ctrl = RobotController::new("mock", "/dev/null", 1_000_000, 600);
        // Command a 1200ms forward move (longer than 600ms default watchdog)
        ctrl.set_velocity_with_duration(0.20, 0.0, 0.0, Some(1200));
        assert!((ctrl.snapshot().odometry.vx - 0.20).abs() < 1e-4);

        // Simulate obstacle appearing at 0.20m during 40Hz tick
        {
            let mut st = ctrl.state.lock().unwrap();
            st.lidar.front_m = 0.20;
        }
        ctrl.tick(0.025);
        let snap = ctrl.snapshot();
        assert_eq!(snap.odometry.vx, 0.0);
        assert!(snap.lidar.obstacle_alert);
    }

    #[test]
    fn test_xml_escape_in_camera_svg() {
        let ctrl = RobotController::new("mock", "/dev/null", 1_000_000, 600);
        ctrl.update_hud(
            None,
            None,
            Some("a".repeat(300)),
            None,
            Some("<script>alert(1)</script>".into()),
        );
        let snap = ctrl.snapshot();
        assert_eq!(snap.hud_headline.chars().count(), 200);
        let svg = ctrl.get_camera_svg();
        assert!(!svg.contains("<script>"));
        assert!(svg.contains("&lt;script&gt;"));
    }
}
