use crate::gestures::{get_gesture, GestureStep};
use crate::protocol::{
    clamp_servo_pulse, clamp_velocity, encode_bus_servos, encode_buzzer, encode_motor_rps,
    is_valid_servo_id, mecanum_ik, ServoTarget,
};
use anyhow::Context as _;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex, MutexGuard,
};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tracing::{error, info, warn};

/// Any LiDAR sector closer than this blocks motion towards it (and limits |wz|).
pub const LIDAR_BRAKE_M: f32 = 0.28;
/// `obstacle_alert` threshold shown in telemetry.
pub const LIDAR_ALERT_M: f32 = 0.35;
/// Max |wz| while any sector is below `LIDAR_BRAKE_M` (the arm sweeps when spinning).
pub const LIDAR_BRAKE_MAX_WZ: f32 = 0.30;
/// With the `ros2` backend, scans older than this make the chassis fail closed.
pub const LIDAR_STALE_AFTER: Duration = Duration::from_millis(300);
/// The `serial` backend has no LiDAR: linear speed is capped instead.
pub const NO_LIDAR_MAX_LINEAR_MPS: f32 = 0.15;
/// While a timed `cmd_vel` is active, the current velocity is re-sent this often
/// (keeps the worker's 500 ms watchdog fed and gives `serial` a heartbeat).
pub const DRIVER_RESEND_INTERVAL: Duration = Duration::from_millis(100);
/// Max time to wait for the first line of `ros2_worker.py` (rclpy + Board init).
pub const WORKER_STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
/// Message returned (HTTP 423 / WS error event) while the E-stop is latched.
pub const ESTOP_MESSAGE: &str = "Paro de emergencia activo. POST /estop/release para liberar.";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LidarSectors {
    pub front_m: f32,
    pub left_m: f32,
    pub right_m: f32,
    pub back_m: f32,
    pub obstacle_alert: bool,
}

impl LidarSectors {
    pub fn min_m(&self) -> f32 {
        self.front_m
            .min(self.left_m)
            .min(self.right_m)
            .min(self.back_m)
    }
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
    /// True after `POST /stop` until `POST /estop/release`.
    pub estop_latched: bool,
    /// True when the real LiDAR (`ros2`) has not delivered a scan in >300 ms (chassis blocked).
    pub lidar_stale: bool,
    /// Where `lidar` comes from: `mock`, `ros2` or `none` (serial backend, values are not real).
    pub lidar_source: String,
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
            estop_latched: false,
            lidar_stale: false,
            lidar_source: LidarSource::Mock.as_str().into(),
        }
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Locks a mutex, recovering the data if a previous holder panicked
/// (the stop path must keep working even after a panic elsewhere).
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn is_moving(vx: f32, vy: f32, wz: f32) -> bool {
    vx.abs() > 1e-4 || vy.abs() > 1e-4 || wz.abs() > 1e-4
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

/// Per-axis LiDAR reflex (REP-103: +x forward, +y left, +wz counter-clockwise).
/// `vx>0` checks `front_m`, `vx<0` `back_m`, `vy>0` `left_m`, `vy<0` `right_m`;
/// if any sector is under `LIDAR_BRAKE_M`, |wz| is limited to `LIDAR_BRAKE_MAX_WZ`.
/// Returns the braked velocity and whether anything was clamped.
pub fn apply_lidar_brake(l: &LidarSectors, vx: f32, vy: f32, wz: f32) -> (f32, f32, f32, bool) {
    let (mut vx, mut vy, mut wz) = (vx, vy, wz);
    let mut braked = false;
    if (vx > 0.0 && l.front_m < LIDAR_BRAKE_M) || (vx < 0.0 && l.back_m < LIDAR_BRAKE_M) {
        vx = 0.0;
        braked = true;
    }
    if (vy > 0.0 && l.left_m < LIDAR_BRAKE_M) || (vy < 0.0 && l.right_m < LIDAR_BRAKE_M) {
        vy = 0.0;
        braked = true;
    }
    if l.min_m() < LIDAR_BRAKE_M && wz.abs() > LIDAR_BRAKE_MAX_WZ {
        wz = wz.signum() * LIDAR_BRAKE_MAX_WZ;
        braked = true;
    }
    (vx, vy, wz, braked)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LidarSource {
    /// Simulated sectors (`POST /simulate/lidar`).
    Mock,
    /// Real `/scan` sectors from `ros2_worker.py` (fails closed when stale).
    Ros2,
    /// No LiDAR at all (`serial` backend): linear speed capped at 0.15 m/s.
    None,
}

impl LidarSource {
    pub fn as_str(&self) -> &'static str {
        match self {
            LidarSource::Mock => "mock",
            LidarSource::Ros2 => "ros2",
            LidarSource::None => "none",
        }
    }
}

/// Commands consumed by the dedicated driver writer thread (serial port or worker stdin),
/// so blocking I/O never runs on tokio threads.
#[derive(Debug)]
pub enum DriverCmd {
    Velocity {
        vx: f32,
        vy: f32,
        wz: f32,
    },
    Arm {
        duration_ms: u16,
        servos: Vec<ServoTarget>,
    },
    Buzzer {
        freq_hz: u16,
        on_ms: u16,
        off_ms: u16,
        repeat: u16,
    },
    Rgb {
        r: u8,
        g: u8,
        b: u8,
    },
    /// Acknowledged once every command queued before it has been written.
    Flush(mpsc::SyncSender<()>),
}

/// Spawns the writer thread. Pending velocities are coalesced (only the newest one is
/// written); every other command keeps its order. Write errors flip `connected` to false.
fn spawn_driver_writer<F>(
    label: &'static str,
    state: Arc<Mutex<TelemetryState>>,
    mut write: F,
) -> anyhow::Result<mpsc::Sender<DriverCmd>>
where
    F: FnMut(&DriverCmd) -> std::io::Result<()> + Send + 'static,
{
    let (tx, rx) = mpsc::channel::<DriverCmd>();
    std::thread::Builder::new()
        .name(format!("{label}-writer"))
        .spawn(move || {
            let mut healthy = true;
            while let Ok(first) = rx.recv() {
                let mut batch = vec![first];
                while let Ok(more) = rx.try_recv() {
                    batch.push(more);
                }
                let last_velocity = batch
                    .iter()
                    .rposition(|c| matches!(c, DriverCmd::Velocity { .. }));
                for (idx, cmd) in batch.into_iter().enumerate() {
                    if let DriverCmd::Flush(ack) = &cmd {
                        let _ = ack.send(());
                        continue;
                    }
                    if matches!(cmd, DriverCmd::Velocity { .. }) && Some(idx) != last_velocity {
                        continue;
                    }
                    let ok = match write(&cmd) {
                        Ok(()) => true,
                        Err(e) => {
                            if healthy {
                                error!("{} write failed ({}): marking connected=false", label, e);
                            }
                            false
                        }
                    };
                    if ok != healthy {
                        healthy = ok;
                        lock(&state).connected = ok;
                        if ok {
                            info!("{} writes recovered: connected=true", label);
                        }
                    }
                }
            }
        })
        .context("spawn driver writer thread")?;
    Ok(tx)
}

/// Resolves `ros2_worker.py` without depending on the current directory:
/// explicit path (`--worker-path` / `ROS2_WORKER_PATH`) first, then next to
/// `CARGO_MANIFEST_DIR`, then relative to the executable (`target/<profile>/rosorin-bridge`).
pub fn resolve_worker_script(explicit: Option<&Path>) -> anyhow::Result<PathBuf> {
    if let Some(path) = explicit {
        if path.is_file() {
            return Ok(path.to_path_buf());
        }
        anyhow::bail!(
            "No existe el worker indicado en --worker-path/ROS2_WORKER_PATH: {}",
            path.display()
        );
    }
    let mut candidates =
        vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("scripts/ros2_worker.py")];
    if let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
    {
        candidates.push(exe_dir.join("../../scripts/ros2_worker.py"));
        candidates.push(exe_dir.join("scripts/ros2_worker.py"));
    }
    candidates
        .iter()
        .find(|p| p.is_file())
        .cloned()
        .ok_or_else(|| {
            anyhow::anyhow!(
                "No se encontró ros2_worker.py (busqué en {:?}); usa --worker-path o ROS2_WORKER_PATH",
                candidates
            )
        })
}

#[derive(Debug, Clone)]
pub struct BackendConfig {
    pub backend: String,
    pub serial_port: String,
    pub baud: u32,
    pub watchdog_ms: u64,
    pub worker_path: Option<PathBuf>,
    /// If false, a failing `serial`/`ros2` backend is a hard error instead of falling back to mock.
    pub allow_mock_fallback: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MotionError {
    /// `POST /stop` latched the E-stop; only `POST /estop/release` clears it.
    EstopLatched,
    /// A newer command/gesture (or the E-stop) cancelled this gesture.
    Superseded,
}

/// Everything that decides whether (and what) goes to the motors. It is held while
/// commands are queued to the driver, so the latch/epoch check and the send are atomic.
struct MotionGate {
    estop_latched: bool,
    epoch: u64,
    /// Last command sent by a client or gesture (watchdog/brake/resend do not count).
    last_user_cmd_at: Instant,
    /// Time-boxed `cmd_vel` end (`duration_ms`, default = watchdog).
    deadline: Option<Instant>,
    last_driver_send: Instant,
}

impl MotionGate {
    fn check(&self, epoch: Option<u64>) -> Result<(), MotionError> {
        if self.estop_latched {
            return Err(MotionError::EstopLatched);
        }
        if let Some(e) = epoch {
            if e != self.epoch {
                return Err(MotionError::Superseded);
            }
        }
        Ok(())
    }

    fn next_epoch(&mut self) -> u64 {
        self.epoch = self.epoch.wrapping_add(1);
        self.epoch
    }
}

pub struct RobotController {
    pub state: Arc<Mutex<TelemetryState>>,
    servo_speeds_pps: Mutex<BTreeMap<u8, f32>>,
    gate: Mutex<MotionGate>,
    pub latest_jpeg: Arc<Mutex<Option<Vec<u8>>>>,
    driver_tx: Mutex<Option<mpsc::Sender<DriverCmd>>>,
    lidar_source: LidarSource,
    last_scan_at: Arc<Mutex<Option<Instant>>>,
    worker_alive: Arc<AtomicBool>,
    worker_child: Mutex<Option<Child>>,
    mock: bool,
    pub watchdog_timeout: Duration,
}

fn default_servo_speeds() -> BTreeMap<u8, f32> {
    let mut m = BTreeMap::new();
    for id in [1, 2, 3, 4, 5, 10] {
        m.insert(id, 900.0);
    }
    m
}

struct ControllerParts {
    state: Arc<Mutex<TelemetryState>>,
    latest_jpeg: Arc<Mutex<Option<Vec<u8>>>>,
    driver_tx: Option<mpsc::Sender<DriverCmd>>,
    lidar_source: LidarSource,
    last_scan_at: Arc<Mutex<Option<Instant>>>,
    worker_alive: Arc<AtomicBool>,
    worker_child: Option<Child>,
    watchdog_ms: u64,
}

impl Drop for RobotController {
    fn drop(&mut self) {
        // Closing the channel ends the writer thread, which closes the worker's stdin:
        // the worker then zeroes the motors on EOF. Give it a moment before killing it.
        lock(&self.driver_tx).take();
        if let Some(mut child) = lock(&self.worker_child).take() {
            for _ in 0..10 {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl RobotController {
    /// Builds the requested backend. `serial`/`ros2` failures are errors unless
    /// `allow_mock_fallback` is set (then: serial → ros2 worker → mock, ros2 → mock).
    pub fn new(cfg: &BackendConfig) -> anyhow::Result<Arc<Self>> {
        match cfg.backend.as_str() {
            "mock" => Ok(Self::new_mock(cfg.watchdog_ms, "mock")),
            "serial" => match Self::open_serial(cfg) {
                Ok(ctrl) => Ok(ctrl),
                Err(e) if cfg.allow_mock_fallback => {
                    warn!("Backend serial no disponible ({:#}); probando ros2_worker...", e);
                    match Self::start_ros2(cfg) {
                        Ok(ctrl) => Ok(ctrl),
                        Err(ros_err) => {
                            warn!(
                                "ros2_worker tampoco arrancó ({:#}); usando MOCK (sin hardware)",
                                ros_err
                            );
                            Ok(Self::new_mock(cfg.watchdog_ms, "mock (serial-fallback)"))
                        }
                    }
                }
                Err(e) => Err(e.context(
                    "No se pudo abrir el backend serial (usa --allow-mock-fallback para caer a mock)",
                )),
            },
            "ros2" => match Self::start_ros2(cfg) {
                Ok(ctrl) => Ok(ctrl),
                Err(e) if cfg.allow_mock_fallback => {
                    warn!("ros2_worker no arrancó ({:#}); usando MOCK (sin hardware)", e);
                    Ok(Self::new_mock(cfg.watchdog_ms, "mock (ros2-fallback)"))
                }
                Err(e) => Err(e.context(
                    "No se pudo iniciar el backend ros2 (usa --allow-mock-fallback para caer a mock)",
                )),
            },
            other => anyhow::bail!("Backend desconocido '{}': usa mock, serial o ros2", other),
        }
    }

    pub fn new_mock(watchdog_ms: u64, label: &str) -> Arc<Self> {
        let state = TelemetryState {
            backend: label.into(),
            ..Default::default()
        };
        Self::from_parts(ControllerParts {
            state: Arc::new(Mutex::new(state)),
            latest_jpeg: Arc::new(Mutex::new(None)),
            driver_tx: None,
            lidar_source: LidarSource::Mock,
            last_scan_at: Arc::new(Mutex::new(None)),
            worker_alive: Arc::new(AtomicBool::new(true)),
            worker_child: None,
            watchdog_ms,
        })
    }

    fn from_parts(p: ControllerParts) -> Arc<Self> {
        let mock = p.driver_tx.is_none();
        {
            let mut st = lock(&p.state);
            st.lidar_source = p.lidar_source.as_str().into();
            st.lidar_stale = p.lidar_source == LidarSource::Ros2;
        }
        let now = Instant::now();
        Arc::new(Self {
            state: p.state,
            servo_speeds_pps: Mutex::new(default_servo_speeds()),
            gate: Mutex::new(MotionGate {
                estop_latched: false,
                epoch: 0,
                last_user_cmd_at: now,
                deadline: None,
                last_driver_send: now,
            }),
            latest_jpeg: p.latest_jpeg,
            driver_tx: Mutex::new(p.driver_tx),
            lidar_source: p.lidar_source,
            last_scan_at: p.last_scan_at,
            worker_alive: p.worker_alive,
            worker_child: Mutex::new(p.worker_child),
            mock,
            watchdog_timeout: Duration::from_millis(p.watchdog_ms),
        })
    }

    fn open_serial(cfg: &BackendConfig) -> anyhow::Result<Arc<Self>> {
        let resolved = std::fs::canonicalize(&cfg.serial_port)
            .ok()
            .and_then(|p| p.into_os_string().into_string().ok())
            .unwrap_or_else(|| cfg.serial_port.clone());
        let mut port = serialport::new(&resolved, cfg.baud)
            .timeout(Duration::from_millis(50))
            .open()
            .with_context(|| format!("abrir {} ({})", cfg.serial_port, resolved))?;
        let _ = port.write_data_terminal_ready(false);
        let _ = port.write_request_to_send(false);
        info!(
            "Opened STM32 serial controller at {} ({}) @ {} baud",
            cfg.serial_port, resolved, cfg.baud
        );
        warn!(
            "Backend serial SIN LiDAR: el freno por obstáculos no está activo y la velocidad lineal se limita a {} m/s",
            NO_LIDAR_MAX_LINEAR_MPS
        );

        let state = Arc::new(Mutex::new(TelemetryState {
            backend: "serial".into(),
            ..Default::default()
        }));
        let tx = spawn_driver_writer("serial", Arc::clone(&state), move |cmd| {
            let frame = match cmd {
                DriverCmd::Velocity { vx, vy, wz } => encode_motor_rps(mecanum_ik(*vx, *vy, *wz)),
                DriverCmd::Arm {
                    duration_ms,
                    servos,
                } => encode_bus_servos(*duration_ms, servos),
                DriverCmd::Buzzer {
                    freq_hz,
                    on_ms,
                    off_ms,
                    repeat,
                } => encode_buzzer(*freq_hz, *on_ms, *off_ms, *repeat),
                // TODO(hardware): RGB frame for the STM32 is not implemented (no PacketFunction for it yet).
                DriverCmd::Rgb { .. } | DriverCmd::Flush(_) => return Ok(()),
            };
            port.write_all(&frame)?;
            port.flush()
        })?;
        Ok(Self::from_parts(ControllerParts {
            state,
            latest_jpeg: Arc::new(Mutex::new(None)),
            driver_tx: Some(tx),
            lidar_source: LidarSource::None,
            last_scan_at: Arc::new(Mutex::new(None)),
            worker_alive: Arc::new(AtomicBool::new(true)),
            worker_child: None,
            watchdog_ms: cfg.watchdog_ms,
        }))
    }

    fn start_ros2(cfg: &BackendConfig) -> anyhow::Result<Arc<Self>> {
        let script_path = resolve_worker_script(cfg.worker_path.as_deref())?;
        info!("Launching ros2 worker: python3 {}", script_path.display());
        let mut child = Command::new("python3")
            .arg(&script_path)
            .env("ROS_LOCALHOST_ONLY", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context("lanzar python3 ros2_worker.py")?;

        let stdin = child.stdin.take();
        let stdout = child.stdout.take();
        let (Some(mut stdin), Some(stdout)) = (stdin, stdout) else {
            let _ = child.kill();
            let _ = child.wait();
            anyhow::bail!("No se pudo capturar stdin/stdout de ros2_worker");
        };

        let state = Arc::new(Mutex::new(TelemetryState {
            backend: "ros2".into(),
            ..Default::default()
        }));
        let latest_jpeg = Arc::new(Mutex::new(None));
        let last_scan_at = Arc::new(Mutex::new(None));
        let worker_alive = Arc::new(AtomicBool::new(true));

        let (first_tx, first_rx) = mpsc::sync_channel::<Option<String>>(1);
        {
            let state = Arc::clone(&state);
            let jpeg = Arc::clone(&latest_jpeg);
            let last_scan = Arc::clone(&last_scan_at);
            let alive = Arc::clone(&worker_alive);
            std::thread::Builder::new()
                .name("ros2-worker-reader".into())
                .spawn(move || {
                    let mut reader = BufReader::new(stdout);
                    let mut first = String::new();
                    match reader.read_line(&mut first) {
                        Ok(n) if n > 0 => {
                            let _ = first_tx.send(Some(first.clone()));
                            handle_worker_line(first.trim(), &state, &jpeg, &last_scan);
                        }
                        _ => {
                            let _ = first_tx.send(None);
                            mark_worker_dead(&state, &alive);
                            return;
                        }
                    }
                    for line in reader.lines() {
                        match line {
                            Ok(line) => handle_worker_line(line.trim(), &state, &jpeg, &last_scan),
                            Err(e) => {
                                warn!("ros2_worker stdout read error: {}", e);
                                break;
                            }
                        }
                    }
                    mark_worker_dead(&state, &alive);
                })
                .context("spawn ros2 worker reader thread")?;
        }

        let first_line = match first_rx.recv_timeout(WORKER_STARTUP_TIMEOUT) {
            Ok(Some(line)) => line,
            Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                let _ = child.kill();
                let _ = child.wait();
                anyhow::bail!("ros2_worker terminó sin conectarse a ningún transporte de hardware");
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let _ = child.kill();
                let _ = child.wait();
                anyhow::bail!(
                    "ros2_worker no respondió en {} s",
                    WORKER_STARTUP_TIMEOUT.as_secs()
                );
            }
        };
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(first_line.trim()) {
            if let Some(name) = v.get("name").and_then(|s| s.as_str()) {
                lock(&state).backend = name.to_string();
            }
        }

        let tx = spawn_driver_writer("ros2_worker", Arc::clone(&state), move |cmd| {
            let json = match cmd {
                DriverCmd::Velocity { vx, vy, wz } => serde_json::json!({
                    "op": "cmd_vel",
                    "linear_x": vx,
                    "linear_y": vy,
                    "angular_z": wz,
                }),
                DriverCmd::Arm {
                    duration_ms,
                    servos,
                } => serde_json::json!({
                    "op": "arm",
                    "duration_s": (*duration_ms as f32) / 1000.0,
                    "servos": servos,
                }),
                DriverCmd::Buzzer {
                    freq_hz,
                    on_ms,
                    off_ms,
                    repeat,
                } => serde_json::json!({
                    "op": "buzzer",
                    "freq": freq_hz,
                    "on_s": (*on_ms as f32) / 1000.0,
                    "off_s": (*off_ms as f32) / 1000.0,
                    "repeat": repeat,
                }),
                DriverCmd::Rgb { r, g, b } => {
                    serde_json::json!({ "op": "rgb", "r": r, "g": g, "b": b })
                }
                DriverCmd::Flush(_) => return Ok(()),
            };
            writeln!(stdin, "{}", json)?;
            stdin.flush()
        })?;

        Ok(Self::from_parts(ControllerParts {
            state,
            latest_jpeg,
            driver_tx: Some(tx),
            lidar_source: LidarSource::Ros2,
            last_scan_at,
            worker_alive,
            worker_child: Some(child),
            watchdog_ms: cfg.watchdog_ms,
        }))
    }

    pub fn is_mock(&self) -> bool {
        self.mock
    }

    fn send_driver(&self, cmd: DriverCmd) {
        if let Some(tx) = lock(&self.driver_tx).as_ref() {
            if tx.send(cmd).is_err() {
                warn!("driver writer thread is gone; command dropped");
            }
        }
    }

    fn lidar_is_stale(&self, now: Instant) -> bool {
        match self.lidar_source {
            LidarSource::Ros2 => {
                !self.worker_alive.load(Ordering::SeqCst)
                    || lock(&self.last_scan_at)
                        .is_none_or(|t| now.saturating_duration_since(t) > LIDAR_STALE_AFTER)
            }
            LidarSource::Mock | LidarSource::None => false,
        }
    }

    /// Single choke point for chassis velocity. Must be called with the gate held.
    fn apply_velocity_locked(
        &self,
        gate: &mut MotionGate,
        linear_x: f32,
        linear_y: f32,
        angular_z: f32,
        duration_ms: Option<u64>,
        user_command: bool,
    ) -> (f32, f32, f32) {
        let now = Instant::now();
        let (mut vx, mut vy, mut wz) = clamp_velocity(linear_x, linear_y, angular_z);
        if self.lidar_source == LidarSource::None {
            vx = vx.clamp(-NO_LIDAR_MAX_LINEAR_MPS, NO_LIDAR_MAX_LINEAR_MPS);
            vy = vy.clamp(-NO_LIDAR_MAX_LINEAR_MPS, NO_LIDAR_MAX_LINEAR_MPS);
        }
        let stale = self.lidar_is_stale(now);
        {
            let mut st = lock(&self.state);
            st.lidar_stale = stale;
            if stale {
                if is_moving(vx, vy, wz) {
                    warn!("LiDAR sin datos recientes (>300 ms): chasis bloqueado");
                }
                vx = 0.0;
                vy = 0.0;
                wz = 0.0;
            } else if self.lidar_source != LidarSource::None {
                let (bx, by, bw, braked) = apply_lidar_brake(&st.lidar, vx, vy, wz);
                if braked {
                    warn!(
                        "LiDAR safety reflex: ({:.2},{:.2},{:.2}) -> ({:.2},{:.2},{:.2}) [front={:.2} back={:.2} left={:.2} right={:.2}]",
                        vx, vy, wz, bx, by, bw, st.lidar.front_m, st.lidar.back_m, st.lidar.left_m, st.lidar.right_m
                    );
                }
                vx = bx;
                vy = by;
                wz = bw;
            }
            st.odometry.vx = vx;
            st.odometry.vy = vy;
            st.odometry.wz = wz;
            st.timestamp_ms = now_ms();
        }

        if user_command {
            gate.last_user_cmd_at = now;
        }
        gate.deadline = if is_moving(vx, vy, wz) {
            let default_ms = (self.watchdog_timeout.as_millis() as u64).max(100);
            let dur_ms = duration_ms.unwrap_or(default_ms).clamp(100, 2500);
            Some(now + Duration::from_millis(dur_ms))
        } else {
            None
        };
        gate.last_driver_send = now;
        self.send_driver(DriverCmd::Velocity { vx, vy, wz });
        (vx, vy, wz)
    }

    /// Client `cmd_vel`: cancels any gesture. Returns the velocity actually applied.
    pub fn set_velocity_with_duration(
        &self,
        linear_x: f32,
        linear_y: f32,
        angular_z: f32,
        duration_ms: Option<u64>,
    ) -> Result<(f32, f32, f32), MotionError> {
        let mut gate = lock(&self.gate);
        gate.check(None)?;
        gate.next_epoch();
        Ok(self.apply_velocity_locked(&mut gate, linear_x, linear_y, angular_z, duration_ms, true))
    }

    /// Arm choke point. Must be called with the gate held.
    fn apply_arm_locked(&self, duration_ms: u16, targets: &[ServoTarget]) {
        let safe_duration = duration_ms.clamp(120, 5000);
        let dur_s = (safe_duration as f32) / 1000.0;
        let mut clamped = Vec::with_capacity(targets.len().min(6));
        {
            let mut st = lock(&self.state);
            let mut speeds = lock(&self.servo_speeds_pps);
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
        if !clamped.is_empty() {
            self.send_driver(DriverCmd::Arm {
                duration_ms: safe_duration,
                servos: clamped,
            });
        }
    }

    pub fn set_arm(&self, duration_ms: u16, targets: &[ServoTarget]) -> Result<(), MotionError> {
        let mut gate = lock(&self.gate);
        gate.check(None)?;
        gate.next_epoch();
        self.apply_arm_locked(duration_ms, targets);
        Ok(())
    }

    pub fn jog_servo(&self, id: u8, delta: i16) -> Result<u16, MotionError> {
        let mut gate = lock(&self.gate);
        gate.check(None)?;
        let current = {
            let st = lock(&self.state);
            st.target_servos
                .get(&id)
                .copied()
                .or_else(|| st.servos.get(&id).copied())
                .unwrap_or(500)
        };
        let raw = (current as i32 + delta as i32).clamp(0, 1000) as u16;
        let next = clamp_servo_pulse(id, raw);
        gate.next_epoch();
        self.apply_arm_locked(120, &[ServoTarget { id, position: next }]);
        Ok(next)
    }

    pub fn reset_scene(&self) -> Result<(), MotionError> {
        let mut gate = lock(&self.gate);
        gate.check(None)?;
        gate.next_epoch();
        self.apply_velocity_locked(&mut gate, 0.0, 0.0, 0.0, None, true);
        let home = get_gesture("home");
        if let Some(first) = home.steps.first() {
            self.apply_arm_locked(first.duration_ms, &first.servos);
        }
        self.set_rgb(home.rgb.0, home.rgb.1, home.rgb.2);
        let mut st = lock(&self.state);
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
        Ok(())
    }

    pub fn update_hud(
        &self,
        speaking: Option<bool>,
        listening: Option<bool>,
        headline: Option<String>,
        subtext: Option<String>,
        mood: Option<String>,
    ) {
        let mut st = lock(&self.state);
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

    /// LEDs do not move anything, so they are allowed while the E-stop is latched.
    pub fn set_rgb(&self, r: u8, g: u8, b: u8) {
        {
            let mut st = lock(&self.state);
            st.rgb = [r, g, b];
            st.timestamp_ms = now_ms();
        }
        self.send_driver(DriverCmd::Rgb { r, g, b });
    }

    fn send_buzzer(&self, freq_hz: u16, on_ms: u16, off_ms: u16, repeat: u16) {
        self.send_driver(DriverCmd::Buzzer {
            freq_hz,
            on_ms: on_ms.min(2000),
            off_ms: off_ms.min(2000),
            repeat: repeat.min(5),
        });
    }

    pub fn set_buzzer(
        &self,
        freq_hz: u16,
        on_ms: u16,
        off_ms: u16,
        repeat: u16,
    ) -> Result<(), MotionError> {
        let gate = lock(&self.gate);
        gate.check(None)?;
        self.send_buzzer(freq_hz, on_ms, off_ms, repeat);
        Ok(())
    }

    /// Emergency stop (`/stop`): latches the E-stop, cancels any active gesture, zeroes chassis
    /// velocity, silences buzzer, and freezes the 6-DOF arm at its current servo positions
    /// (does NOT swing the arm to `home` on emergency stop). Only `release_estop` unlatches.
    pub fn stop_all(&self) {
        let mut gate = lock(&self.gate);
        gate.estop_latched = true;
        gate.next_epoch();
        self.apply_velocity_locked(&mut gate, 0.0, 0.0, 0.0, None, false);
        self.send_buzzer(0, 0, 0, 0);

        let frozen_targets: Vec<ServoTarget> = {
            let mut st = lock(&self.state);
            let current = st.servos.clone();
            st.target_servos = current.clone();
            st.active_gesture = "stopped".into();
            st.mood = "attentive".into();
            st.speaking = false;
            st.estop_latched = true;
            st.timestamp_ms = now_ms();
            current
                .into_iter()
                .map(|(id, position)| ServoTarget { id, position })
                .collect()
        };
        self.send_driver(DriverCmd::Arm {
            duration_ms: 120,
            servos: frozen_targets,
        });
        warn!("E-stop enclavada: movimiento bloqueado hasta POST /estop/release");
    }

    /// `POST /estop/release`: the only way to clear the latch.
    pub fn release_estop(&self) {
        let mut gate = lock(&self.gate);
        gate.estop_latched = false;
        let mut st = lock(&self.state);
        st.estop_latched = false;
        st.timestamp_ms = now_ms();
        info!("E-stop liberada");
    }

    /// Best-effort halt used when the process is about to exit (signal or dead control loop):
    /// zero velocity and wait until the writer has flushed it (bounded).
    pub fn halt_for_shutdown(&self) {
        {
            let mut gate = lock(&self.gate);
            gate.next_epoch();
            gate.deadline = None;
        }
        {
            let mut st = lock(&self.state);
            st.odometry.vx = 0.0;
            st.odometry.vy = 0.0;
            st.odometry.wz = 0.0;
        }
        self.send_driver(DriverCmd::Velocity {
            vx: 0.0,
            vy: 0.0,
            wz: 0.0,
        });
        let (ack_tx, ack_rx) = mpsc::sync_channel(1);
        self.send_driver(DriverCmd::Flush(ack_tx));
        if !self.mock {
            let _ = ack_rx.recv_timeout(Duration::from_millis(300));
        }
    }

    pub fn run_gesture(
        self: &Arc<Self>,
        name: &str,
        mood_override: Option<String>,
    ) -> Result<(), MotionError> {
        let seq = get_gesture(name);
        let my_epoch = {
            let mut gate = lock(&self.gate);
            gate.check(None)?;
            let my_epoch = gate.next_epoch();
            {
                let mut st = lock(&self.state);
                st.active_gesture = seq.name.clone();
                if let Some(m) = mood_override {
                    st.mood = m.chars().take(64).collect();
                } else {
                    st.mood = seq.name.clone();
                }
                // Odometry is only integrated from velocity (no "teleport" offsets here).
                match seq.name.as_str() {
                    "gatekeeper_hold" => {
                        st.held_object = "deploy_key".into();
                        st.pointed_totem = None;
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
                        st.hud_headline = "CLOUD RUN · OOM".into();
                        st.hud_subtext = "Tótem Izquierdo (Y = +20 cm)".into();
                    }
                    "point_gemini_live" => {
                        st.pointed_totem = Some("gemini_live".into());
                        st.hud_headline = "GEMINI LIVE · PCM".into();
                        st.hud_subtext = "Tótem Central (Y = 0 cm)".into();
                    }
                    "point_firestore" => {
                        st.pointed_totem = Some("firestore".into());
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
                self.send_buzzer(freq, on_ms, off_ms, rep);
            }
            my_epoch
        };

        let ctrl = Arc::clone(self);
        tokio::spawn(async move {
            for step in &seq.steps {
                if ctrl.gesture_step(my_epoch, step).is_err() {
                    return;
                }
                let mut remaining = step.duration_ms as u64;
                while remaining > 0 {
                    let slice = remaining.min(25);
                    tokio::time::sleep(Duration::from_millis(slice)).await;
                    remaining -= slice;
                    if !ctrl.gesture_is_current(my_epoch) {
                        return;
                    }
                }
            }
            let mut gate = lock(&ctrl.gate);
            if gate.check(Some(my_epoch)).is_ok() {
                ctrl.apply_velocity_locked(&mut gate, 0.0, 0.0, 0.0, None, false);
            }
        });
        Ok(())
    }

    /// One gesture step, atomically checked against the latch and the gesture epoch.
    /// The velocity is then kept alive by the tick resend until the step ends.
    fn gesture_step(&self, epoch: u64, step: &GestureStep) -> Result<(), MotionError> {
        let mut gate = lock(&self.gate);
        gate.check(Some(epoch))?;
        self.apply_arm_locked(step.duration_ms, &step.servos);
        if let Some((vx, vy, wz)) = step.velocity {
            self.apply_velocity_locked(
                &mut gate,
                vx,
                vy,
                wz,
                Some(step.duration_ms as u64 + 100),
                true,
            );
        }
        Ok(())
    }

    fn gesture_is_current(&self, epoch: u64) -> bool {
        lock(&self.gate).check(Some(epoch)).is_ok()
    }

    /// Periodic 40Hz physics + servo interpolation + LiDAR reflex + watchdog + resend tick.
    pub fn tick(&self, dt_s: f32) {
        let last_command_ms_ago = self.enforce_motion_safety();
        self.integrate(dt_s, last_command_ms_ago);
    }

    /// Watchdog/deadline, fail-closed LiDAR, per-axis brake and ~100 ms resend.
    /// Returns ms since the last client command.
    pub fn enforce_motion_safety(&self) -> u64 {
        let now = Instant::now();
        let mut gate = lock(&self.gate);
        let stale = self.lidar_is_stale(now);
        let (cur, lidar) = {
            let mut st = lock(&self.state);
            st.lidar_stale = stale;
            st.lidar.obstacle_alert =
                self.lidar_source != LidarSource::None && st.lidar.min_m() < LIDAR_ALERT_M;
            (
                (st.odometry.vx, st.odometry.vy, st.odometry.wz),
                st.lidar.clone(),
            )
        };
        let moving = is_moving(cur.0, cur.1, cur.2);

        let expired = match gate.deadline {
            Some(deadline) => now >= deadline,
            None => {
                moving
                    && now.saturating_duration_since(gate.last_user_cmd_at) > self.watchdog_timeout
            }
        };

        if expired {
            // Watchdog / duration end: stop, but never latch and never count as a client command.
            self.apply_velocity_locked(&mut gate, 0.0, 0.0, 0.0, None, false);
        } else if moving {
            let target = if stale {
                (0.0, 0.0, 0.0)
            } else if self.lidar_source != LidarSource::None {
                let (vx, vy, wz, _) = apply_lidar_brake(&lidar, cur.0, cur.1, cur.2);
                (vx, vy, wz)
            } else {
                cur
            };
            if target != cur {
                let remaining_deadline = gate.deadline;
                let applied = self
                    .apply_velocity_locked(&mut gate, target.0, target.1, target.2, None, false);
                if is_moving(applied.0, applied.1, applied.2) {
                    gate.deadline = remaining_deadline;
                }
            } else if gate.deadline.is_some()
                && now.saturating_duration_since(gate.last_driver_send) >= DRIVER_RESEND_INTERVAL
            {
                gate.last_driver_send = now;
                self.send_driver(DriverCmd::Velocity {
                    vx: cur.0,
                    vy: cur.1,
                    wz: cur.2,
                });
            }
        }

        now.saturating_duration_since(gate.last_user_cmd_at)
            .as_millis() as u64
    }

    /// Odometry integration (commanded velocity, not encoders) + servo pulse estimation.
    fn integrate(&self, dt_s: f32, last_command_ms_ago: u64) {
        let speeds = lock(&self.servo_speeds_pps).clone();
        let mut st = lock(&self.state);
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

        st.last_command_ms_ago = last_command_ms_ago;
        st.timestamp_ms = now_ms();
    }

    pub fn snapshot(&self) -> TelemetryState {
        lock(&self.state).clone()
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

    /// Test-only controller whose driver commands are captured by the returned receiver.
    #[cfg(test)]
    pub fn new_with_test_driver(
        lidar_source: LidarSource,
        watchdog_ms: u64,
    ) -> (Arc<Self>, mpsc::Receiver<DriverCmd>) {
        let (tx, rx) = mpsc::channel();
        let ctrl = Self::from_parts(ControllerParts {
            state: Arc::new(Mutex::new(TelemetryState {
                backend: format!("test-{}", lidar_source.as_str()),
                ..Default::default()
            })),
            latest_jpeg: Arc::new(Mutex::new(None)),
            driver_tx: Some(tx),
            lidar_source,
            last_scan_at: Arc::new(Mutex::new(None)),
            worker_alive: Arc::new(AtomicBool::new(true)),
            worker_child: None,
            watchdog_ms,
        });
        (ctrl, rx)
    }

    #[cfg(test)]
    fn mark_scan_received(&self, at: Instant) {
        *lock(&self.last_scan_at) = Some(at);
    }
}

fn handle_worker_line(
    line: &str,
    state: &Arc<Mutex<TelemetryState>>,
    jpeg: &Arc<Mutex<Option<Vec<u8>>>>,
    last_scan: &Arc<Mutex<Option<Instant>>>,
) {
    use base64::Engine as _;
    if !line.starts_with('{') {
        return;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return;
    };
    match v.get("event").and_then(|s| s.as_str()) {
        Some("camera_jpeg") => {
            if let Some(b64) = v.get("b64").and_then(|s| s.as_str()) {
                if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) {
                    *lock(jpeg) = Some(bytes);
                }
            }
        }
        Some("battery") => {
            if let Some(mv) = v.get("mv").and_then(|n| n.as_u64()) {
                lock(state).battery_mv = mv.min(u16::MAX as u64) as u16;
            }
        }
        Some("lidar") => {
            {
                let mut st = lock(state);
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
                st.lidar.obstacle_alert = st.lidar.min_m() < LIDAR_ALERT_M;
            }
            *lock(last_scan) = Some(Instant::now());
        }
        Some("backend") => {}
        _ => {
            info!(target: "ros2_worker", "{}", line);
        }
    }
}

/// Worker EOF: it already zeroes the motors on its side; here we stop trusting any data.
fn mark_worker_dead(state: &Arc<Mutex<TelemetryState>>, alive: &Arc<AtomicBool>) {
    alive.store(false, Ordering::SeqCst);
    let mut st = lock(state);
    st.connected = false;
    st.lidar_stale = true;
    st.odometry.vx = 0.0;
    st.odometry.vy = 0.0;
    st.odometry.wz = 0.0;
    error!("ros2_worker terminó (EOF): connected=false, chasis bloqueado");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mock() -> Arc<RobotController> {
        RobotController::new_mock(600, "mock")
    }

    fn drain_velocities(rx: &mpsc::Receiver<DriverCmd>) -> Vec<(f32, f32, f32)> {
        rx.try_iter()
            .filter_map(|c| match c {
                DriverCmd::Velocity { vx, vy, wz } => Some((vx, vy, wz)),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn test_servo_smooth_interpolation_and_gripper_release() {
        let ctrl = mock();
        {
            let mut st = ctrl.state.lock().unwrap();
            st.active_gesture = "gatekeeper_approve".into();
        }
        ctrl.set_arm(
            450,
            &[
                ServoTarget {
                    id: 1,
                    position: 680,
                },
                ServoTarget {
                    id: 10,
                    position: 220,
                },
            ],
        )
        .unwrap();

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

        ctrl.reset_scene().unwrap();
        let snap_reset = ctrl.snapshot();
        assert_eq!(snap_reset.held_object, "deploy_key");
        assert_eq!(snap_reset.pointed_totem, None);
        assert_eq!(snap_reset.target_servos.get(&1), Some(&500));
    }

    #[test]
    fn test_jog_servo_clamping() {
        let ctrl = mock();
        let next = ctrl.jog_servo(2, -300).unwrap();
        assert_eq!(next, 220);
        assert_eq!(ctrl.snapshot().target_servos.get(&2), Some(&220));
    }

    #[tokio::test]
    async fn test_stop_cancels_active_gesture_and_freezes_arm() {
        let ctrl = mock();
        ctrl.run_gesture("victory_spin", None).unwrap();
        tokio::time::sleep(Duration::from_millis(60)).await;
        ctrl.tick(0.025);

        // Emergency stop should freeze arm at current servo positions (NOT snap to 500 home)
        ctrl.stop_all();
        let snap_stopped = ctrl.snapshot();
        assert_eq!(snap_stopped.odometry.vx, 0.0);
        assert_eq!(snap_stopped.odometry.vy, 0.0);
        assert_eq!(snap_stopped.odometry.wz, 0.0);
        assert_eq!(snap_stopped.servos, snap_stopped.target_servos);
        assert!(snap_stopped.estop_latched);

        // Wait longer and ensure the cancelled gesture task does NOT overwrite velocity or targets
        tokio::time::sleep(Duration::from_millis(120)).await;
        let snap_after = ctrl.snapshot();
        assert_eq!(snap_after.odometry.wz, 0.0);
        assert_eq!(snap_after.target_servos, snap_stopped.target_servos);
    }

    #[test]
    fn test_estop_latch_blocks_everything_until_release() {
        let ctrl = mock();
        ctrl.stop_all();
        assert_eq!(
            ctrl.set_velocity_with_duration(0.1, 0.0, 0.0, None),
            Err(MotionError::EstopLatched)
        );
        assert_eq!(
            ctrl.set_arm(
                400,
                &[ServoTarget {
                    id: 1,
                    position: 600
                }]
            ),
            Err(MotionError::EstopLatched)
        );
        assert_eq!(ctrl.jog_servo(1, 20), Err(MotionError::EstopLatched));
        assert_eq!(ctrl.reset_scene(), Err(MotionError::EstopLatched));
        assert_eq!(
            ctrl.set_buzzer(1900, 100, 50, 1),
            Err(MotionError::EstopLatched)
        );

        // The watchdog / tick never clears the latch
        for _ in 0..30 {
            ctrl.tick(0.025);
        }
        assert!(ctrl.snapshot().estop_latched);
        assert!(lock(&ctrl.gate).estop_latched);

        ctrl.release_estop();
        assert!(!ctrl.snapshot().estop_latched);
        assert!(ctrl.set_velocity_with_duration(0.1, 0.0, 0.0, None).is_ok());
    }

    #[test]
    fn test_duration_ms_deadline_and_lidar_brake_in_tick() {
        let ctrl = mock();
        // Command a 1200ms forward move (longer than 600ms default watchdog)
        ctrl.set_velocity_with_duration(0.20, 0.0, 0.0, Some(1200))
            .unwrap();
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
    fn test_lidar_brake_per_axis_and_wz_limit() {
        let open = LidarSectors {
            front_m: 2.0,
            left_m: 2.0,
            right_m: 2.0,
            back_m: 2.0,
            obstacle_alert: false,
        };
        assert_eq!(
            apply_lidar_brake(&open, 0.2, 0.2, 0.8),
            (0.2, 0.2, 0.8, false)
        );

        let left_close = LidarSectors {
            left_m: 0.20,
            ..open.clone()
        };
        // +vy (left) is blocked, -vy (right) is allowed, |wz| capped at 0.3
        assert_eq!(
            apply_lidar_brake(&left_close, 0.1, 0.2, 0.8),
            (0.1, 0.0, 0.3, true)
        );
        assert_eq!(
            apply_lidar_brake(&left_close, 0.0, -0.2, -0.8),
            (0.0, -0.2, -0.3, true)
        );

        let right_close = LidarSectors {
            right_m: 0.20,
            ..open.clone()
        };
        assert_eq!(
            apply_lidar_brake(&right_close, 0.0, -0.2, 0.0),
            (0.0, 0.0, 0.0, true)
        );
        assert_eq!(
            apply_lidar_brake(&right_close, 0.0, 0.2, 0.0),
            (0.0, 0.2, 0.0, false)
        );

        let back_close = LidarSectors {
            back_m: 0.20,
            ..open.clone()
        };
        assert_eq!(
            apply_lidar_brake(&back_close, -0.1, 0.0, 0.2),
            (0.0, 0.0, 0.2, true)
        );
        assert_eq!(
            apply_lidar_brake(&back_close, 0.1, 0.0, 0.0),
            (0.1, 0.0, 0.0, false)
        );

        // Lateral brake through the controller (cmd_vel path) and the 40 Hz tick
        let ctrl = mock();
        ctrl.state.lock().unwrap().lidar.left_m = 0.20;
        let applied = ctrl
            .set_velocity_with_duration(0.0, 0.2, 0.8, Some(800))
            .unwrap();
        assert_eq!(applied, (0.0, 0.0, 0.3));

        ctrl.state.lock().unwrap().lidar.left_m = 2.0;
        ctrl.set_velocity_with_duration(0.0, -0.2, 0.0, Some(800))
            .unwrap();
        ctrl.state.lock().unwrap().lidar.right_m = 0.20;
        ctrl.tick(0.025);
        let snap = ctrl.snapshot();
        assert_eq!(snap.odometry.vy, 0.0);
        assert!(snap.lidar.obstacle_alert);
    }

    #[test]
    fn test_ros2_lidar_stale_blocks_chassis() {
        let (ctrl, rx) = RobotController::new_with_test_driver(LidarSource::Ros2, 600);
        assert_eq!(ctrl.snapshot().lidar_source, "ros2");

        // No scan yet: fail closed
        let applied = ctrl
            .set_velocity_with_duration(0.15, 0.0, 0.3, Some(1000))
            .unwrap();
        assert_eq!(applied, (0.0, 0.0, 0.0));
        assert!(ctrl.snapshot().lidar_stale);

        // Fresh scan: motion allowed
        ctrl.mark_scan_received(Instant::now());
        let applied = ctrl
            .set_velocity_with_duration(0.15, 0.0, 0.0, Some(1000))
            .unwrap();
        assert_eq!(applied, (0.15, 0.0, 0.0));
        assert!(!ctrl.snapshot().lidar_stale);

        // Scan becomes older than 300 ms during the move: the tick zeroes the chassis
        ctrl.mark_scan_received(Instant::now() - Duration::from_millis(400));
        let _ = drain_velocities(&rx);
        ctrl.tick(0.025);
        let snap = ctrl.snapshot();
        assert!(snap.lidar_stale);
        assert_eq!(
            (snap.odometry.vx, snap.odometry.vy, snap.odometry.wz),
            (0.0, 0.0, 0.0)
        );
        assert_eq!(drain_velocities(&rx).last(), Some(&(0.0, 0.0, 0.0)));

        // Worker EOF: connected=false and stale even with a fresh timestamp
        ctrl.mark_scan_received(Instant::now());
        mark_worker_dead(&ctrl.state, &ctrl.worker_alive);
        assert!(!ctrl.snapshot().connected);
        let applied = ctrl
            .set_velocity_with_duration(0.15, 0.0, 0.0, None)
            .unwrap();
        assert_eq!(applied, (0.0, 0.0, 0.0));
    }

    #[test]
    fn test_serial_without_lidar_caps_linear_speed() {
        let (ctrl, _rx) = RobotController::new_with_test_driver(LidarSource::None, 600);
        let snap = ctrl.snapshot();
        assert_eq!(snap.lidar_source, "none");
        assert!(!snap.lidar_stale);
        let applied = ctrl
            .set_velocity_with_duration(0.25, -0.25, 0.5, None)
            .unwrap();
        assert_eq!(applied, (0.15, -0.15, 0.5));
    }

    #[test]
    fn test_cmd_vel_is_resent_until_deadline() {
        let (ctrl, rx) = RobotController::new_with_test_driver(LidarSource::Mock, 600);
        ctrl.set_velocity_with_duration(0.1, 0.0, 0.0, Some(450))
            .unwrap();
        assert_eq!(drain_velocities(&rx), vec![(0.1, 0.0, 0.0)]);

        let start = Instant::now();
        let mut sent = Vec::new();
        while start.elapsed() < Duration::from_millis(700) {
            std::thread::sleep(Duration::from_millis(25));
            ctrl.tick(0.025);
            for v in drain_velocities(&rx) {
                sent.push((start.elapsed(), v));
            }
        }
        let resends: Vec<_> = sent.iter().filter(|(_, v)| v.0 > 0.0).collect();
        // ~100 ms cadence over the 450 ms window
        assert!(resends.len() >= 3, "expected >=3 resends, got {:?}", sent);
        assert!(resends.iter().all(|(t, _)| *t < Duration::from_millis(470)));
        let stop = sent.iter().find(|(_, v)| *v == (0.0, 0.0, 0.0));
        assert!(
            stop.is_some(),
            "expected a stop after the deadline: {:?}",
            sent
        );
        assert!(stop.unwrap().0 >= Duration::from_millis(430));
        assert_eq!(ctrl.snapshot().odometry.vx, 0.0);
        // The watchdog/deadline stop does not count as a client command
        assert!(ctrl.snapshot().last_command_ms_ago >= 600);
    }

    #[test]
    fn test_gestures_do_not_teleport_odometry() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        rt.block_on(async {
            let ctrl = mock();
            ctrl.run_gesture("point_cloud_run", None).unwrap();
            let snap = ctrl.snapshot();
            assert_eq!(snap.pointed_totem.as_deref(), Some("cloud_run"));
            assert_eq!(snap.odometry.y_m, 0.0);
        });
    }

    #[test]
    fn test_worker_script_resolution_ignores_cwd() {
        let resolved = resolve_worker_script(None).unwrap();
        assert!(resolved.is_absolute());
        assert!(resolved.starts_with(env!("CARGO_MANIFEST_DIR")));
        assert!(resolve_worker_script(Some(Path::new("/nonexistent/ros2_worker.py"))).is_err());
        let explicit = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("scripts/ros2_worker.py");
        assert_eq!(resolve_worker_script(Some(&explicit)).unwrap(), explicit);
    }

    #[test]
    fn test_explicit_backend_failure_is_an_error() {
        let cfg = BackendConfig {
            backend: "serial".into(),
            serial_port: "/dev/definitely-not-a-port".into(),
            baud: 1_000_000,
            watchdog_ms: 600,
            worker_path: Some(PathBuf::from("/nonexistent/ros2_worker.py")),
            allow_mock_fallback: false,
        };
        assert!(RobotController::new(&cfg).is_err());

        let fallback = BackendConfig {
            allow_mock_fallback: true,
            ..cfg
        };
        let ctrl = RobotController::new(&fallback).unwrap();
        assert!(ctrl.is_mock());
        assert_eq!(ctrl.snapshot().backend, "mock (serial-fallback)");
    }

    #[test]
    fn test_xml_escape_in_camera_svg() {
        let ctrl = mock();
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
