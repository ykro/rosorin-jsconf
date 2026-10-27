use crate::gestures::{get_gesture, GestureSequence, GestureStep};
use crate::protocol::{
    clamp_servo_pulse, clamp_velocity, encode_bus_servos, encode_buzzer, encode_motor_rps,
    is_valid_servo_id, mecanum_ik, ServoTarget,
};
use anyhow::Context as _;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
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
/// Gestures reversing while the back is uncovered (the LiDAR does not look there) go at most this
/// fast...
pub const GESTURE_BLIND_REVERSE_MPS: f32 = 0.05;
/// ...and for at most this long per step. Manual `cmd_vel` is not limited beyond `protocol.rs`.
pub const GESTURE_BLIND_REVERSE_MAX_MS: u64 = 800;
/// With the `ros2` backend, scans older than this make the chassis fail closed.
pub const LIDAR_STALE_AFTER: Duration = Duration::from_millis(300);
/// The `serial` backend has no LiDAR: linear speed is capped instead.
pub const NO_LIDAR_MAX_LINEAR_MPS: f32 = 0.15;
/// While a timed `cmd_vel` is active, the current velocity is re-sent this often
/// (keeps the worker's 500 ms watchdog fed and gives `serial` a heartbeat).
pub const DRIVER_RESEND_INTERVAL: Duration = Duration::from_millis(100);
/// Max time to wait for the first line of `ros2_worker.py` (Board init + rclpy/cv2 telemetry node).
pub const WORKER_STARTUP_TIMEOUT: Duration = Duration::from_secs(20);
/// Max queued non-velocity driver commands. A full queue means the writer is stuck: new commands
/// are dropped (velocity never queues: it lives in a latest-wins slot).
pub const DRIVER_QUEUE_CAPACITY: usize = 64;
/// A single write (serial frame or worker stdin line) blocked for longer than this marks the
/// driver as unhealthy (`connected=false`, chassis blocked).
pub const DRIVER_WRITE_STALL_AFTER: Duration = Duration::from_millis(300);
/// `ros2`: a `{"op":"ping","seq":N}` is queued this often...
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_millis(100);
/// ...and the worker must echo `{"event":"pong","seq":N}` from its command thread. If the newest
/// acknowledged ping is older than this, the worker is stuck: `connected=false`, chassis blocked.
pub const HEARTBEAT_TIMEOUT: Duration = Duration::from_millis(400);
/// Message returned (HTTP 423 / WS error event) while the E-stop is latched.
pub const ESTOP_MESSAGE: &str = "STOP activo (E-stop enclavada). POST /estop/release para liberar.";

pub const LIDAR_SECTORS: [&str; 4] = ["front", "left", "right", "back"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LidarSectors {
    pub front_m: f32,
    pub left_m: f32,
    pub right_m: f32,
    pub back_m: f32,
    pub obstacle_alert: bool,
    /// Sectors the LiDAR does not cover at all (no rays in the scan, e.g. the back hidden by the
    /// chassis). Their distance arrives as 0.0 but the brake ignores them: manual reverse is free and
    /// gestures reverse slowly (`GESTURE_BLIND_REVERSE_MPS`). A *blind* sector (rays present but
    /// unusable: covered or dirty LiDAR) is not uncovered and still blocks.
    #[serde(default)]
    pub uncovered: Vec<String>,
}

impl LidarSectors {
    pub fn covers(&self, sector: &str) -> bool {
        !self.uncovered.iter().any(|s| s == sector)
    }

    /// Closest distance among the sectors the LiDAR covers (`f32::INFINITY` if it covers none).
    pub fn min_m(&self) -> f32 {
        [
            ("front", self.front_m),
            ("left", self.left_m),
            ("right", self.right_m),
            ("back", self.back_m),
        ]
        .into_iter()
        .filter(|(name, _)| self.covers(name))
        .map(|(_, m)| m)
        .fold(f32::INFINITY, f32::min)
    }
}

/// Parses the worker's `uncovered` list. Only known sector names count, and a scan that would leave
/// every sector uncovered is treated as covering all of them (their 0.0 then blocks).
fn parse_uncovered(v: Option<&serde_json::Value>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for name in v.and_then(|a| a.as_array()).into_iter().flatten() {
        if let Some(n) = name.as_str().filter(|n| LIDAR_SECTORS.contains(n)) {
            if !out.iter().any(|s| s == n) {
                out.push(n.to_string());
            }
        }
    }
    if out.len() == LIDAR_SECTORS.len() {
        out.clear();
    }
    out
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
                uncovered: Vec::new(),
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
/// Sectors listed in `uncovered` (the LiDAR does not look there) are skipped, including for the
/// |wz| limit. Returns the braked velocity and whether anything was clamped.
pub fn apply_lidar_brake(l: &LidarSectors, vx: f32, vy: f32, wz: f32) -> (f32, f32, f32, bool) {
    let (mut vx, mut vy, mut wz) = (vx, vy, wz);
    let mut braked = false;
    let near = |sector: &str, m: f32| l.covers(sector) && m < LIDAR_BRAKE_M;
    if (vx > 0.0 && near("front", l.front_m)) || (vx < 0.0 && near("back", l.back_m)) {
        vx = 0.0;
        braked = true;
    }
    if (vy > 0.0 && near("left", l.left_m)) || (vy < 0.0 && near("right", l.right_m)) {
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

/// Why a motion command was accepted (HTTP 200 / no WS error) but did not move the robot as asked.
/// Serialized as `"worker_dead" | "lidar_stale" | "braked"` in the `blocked` field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockReason {
    /// The driver is not taking commands: worker EOF, worker stuck (no heartbeat ack),
    /// writer blocked or failing writes. Nothing reaches the robot (chassis, arm, LEDs, buzzer).
    WorkerDead,
    /// `ros2`: no LiDAR scan in >300 ms, the chassis is held at 0.
    LidarStale,
    /// The LiDAR reflex zeroed at least one axis or capped |wz| (obstacle closer than 0.28 m).
    Braked,
}

impl BlockReason {
    /// Spanish message for the UI / Gemini tool responses.
    pub fn message(&self) -> &'static str {
        match self {
            BlockReason::WorkerDead => {
                "El robot no responde (worker o driver caído o atascado): no se movió."
            }
            BlockReason::LidarStale => {
                "LiDAR sin datos recientes: el chasis está bloqueado y no se movió."
            }
            BlockReason::Braked => {
                "Freno del LiDAR: hay un obstáculo cerca y el movimiento se limitó o se anuló."
            }
        }
    }
}

/// Result of the chassis choke point: the velocity actually applied and, if the request was
/// reduced or cancelled by a safety layer, why.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VelocityOutcome {
    pub applied: (f32, f32, f32),
    pub blocked: Option<BlockReason>,
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
    /// `ros2` heartbeat: the worker echoes `{"event":"pong","seq":N}` from its command thread.
    Ping {
        seq: u64,
    },
    /// Wakes the writer to pick up the pending velocity slot (never written).
    Wake,
    /// Acknowledged once every command queued before it has been written.
    Flush(mpsc::SyncSender<()>),
}

/// `ros2` heartbeat bookkeeping (pings in flight and the newest acknowledged one).
struct Heartbeat {
    next_seq: u64,
    last_ping_at: Option<Instant>,
    /// Recently sent pings `(seq, sent_at)`, oldest first; bounded.
    in_flight: VecDeque<(u64, Instant)>,
    /// Send time of the newest acknowledged ping (the worker's first line counts as one).
    last_acked_sent_at: Instant,
}

impl Heartbeat {
    fn new(now: Instant) -> Self {
        Self {
            next_seq: 1,
            last_ping_at: None,
            in_flight: VecDeque::new(),
            last_acked_sent_at: now,
        }
    }

    /// Returns the next ping sequence number when one is due.
    fn next_ping(&mut self, now: Instant) -> Option<u64> {
        if self
            .last_ping_at
            .is_some_and(|t| now.saturating_duration_since(t) < HEARTBEAT_INTERVAL)
        {
            return None;
        }
        let seq = self.next_seq;
        self.next_seq += 1;
        self.last_ping_at = Some(now);
        self.in_flight.push_back((seq, now));
        while self.in_flight.len() > 32 {
            self.in_flight.pop_front();
        }
        Some(seq)
    }

    /// A pong only counts if it answers a ping we still remember (stale or unknown seqs are ignored,
    /// so a stuck worker flushing old pongs does not look healthy).
    fn ack(&mut self, seq: u64) {
        let Some(pos) = self.in_flight.iter().position(|(s, _)| *s == seq) else {
            return;
        };
        let sent_at = self.in_flight[pos].1;
        if sent_at > self.last_acked_sent_at {
            self.last_acked_sent_at = sent_at;
        }
        self.in_flight.drain(..=pos);
    }

    fn fresh(&self, now: Instant) -> bool {
        now.saturating_duration_since(self.last_acked_sent_at) <= HEARTBEAT_TIMEOUT
    }
}

/// Driver link health, shared by the writer thread, the worker reader and the 40 Hz tick
/// (which mirrors it into `TelemetryState::connected` and blocks the chassis when unhealthy).
struct DriverHealth {
    /// The last command that was actually written succeeded. Commands that are not written
    /// (RGB on `serial`) never change it.
    write_ok: AtomicBool,
    /// Set while a write is in progress: detects a writer blocked on a full pipe / serial port.
    write_started_at: Mutex<Option<Instant>>,
    /// `ros2` only.
    heartbeat: Option<Mutex<Heartbeat>>,
}

impl DriverHealth {
    fn new(with_heartbeat: bool) -> Arc<Self> {
        Arc::new(Self {
            write_ok: AtomicBool::new(true),
            write_started_at: Mutex::new(None),
            heartbeat: with_heartbeat.then(|| Mutex::new(Heartbeat::new(Instant::now()))),
        })
    }

    fn healthy(&self, now: Instant) -> bool {
        let write_stalled = lock(&self.write_started_at)
            .is_some_and(|t| now.saturating_duration_since(t) > DRIVER_WRITE_STALL_AFTER);
        self.write_ok.load(Ordering::SeqCst)
            && !write_stalled
            && self.heartbeat.as_ref().is_none_or(|h| lock(h).fresh(now))
    }

    fn ack_ping(&self, seq: u64) {
        if let Some(h) = &self.heartbeat {
            lock(h).ack(seq);
        }
    }
}

/// Sender side of the writer thread: a bounded queue plus a latest-wins velocity slot,
/// so a stuck writer can neither grow memory without limit nor replay stale velocities.
struct DriverLink {
    tx: mpsc::SyncSender<DriverCmd>,
    pending_velocity: Arc<Mutex<Option<(f32, f32, f32)>>>,
    queue_full_warned: AtomicBool,
}

/// Spawns the writer thread. Velocities are coalesced (only the newest one is written, before the
/// rest of the batch); every other command keeps its order. `write` returns `Ok(false)` for
/// commands that are not written (they do not count for health); errors flip `write_ok`.
fn spawn_driver_writer<F>(
    label: &'static str,
    health: Arc<DriverHealth>,
    mut write: F,
) -> anyhow::Result<DriverLink>
where
    F: FnMut(&DriverCmd) -> std::io::Result<bool> + Send + 'static,
{
    let (tx, rx) = mpsc::sync_channel::<DriverCmd>(DRIVER_QUEUE_CAPACITY);
    let pending_velocity = Arc::new(Mutex::new(None::<(f32, f32, f32)>));
    let slot = Arc::clone(&pending_velocity);
    std::thread::Builder::new()
        .name(format!("{label}-writer"))
        .spawn(move || {
            while let Ok(first) = rx.recv() {
                let mut batch = vec![first];
                while let Ok(more) = rx.try_recv() {
                    batch.push(more);
                }
                // Taken after draining the queue: a velocity set before a queued Flush is
                // always written before that Flush is acknowledged.
                let velocity =
                    lock(&slot)
                        .take()
                        .map(|(vx, vy, wz)| DriverCmd::Velocity { vx, vy, wz });
                for cmd in velocity.into_iter().chain(batch) {
                    match cmd {
                        DriverCmd::Flush(ack) => {
                            let _ = ack.send(());
                        }
                        DriverCmd::Wake => {}
                        cmd => {
                            *lock(&health.write_started_at) = Some(Instant::now());
                            let res = write(&cmd);
                            *lock(&health.write_started_at) = None;
                            match res {
                                Ok(false) => {}
                                Ok(true) => {
                                    if !health.write_ok.swap(true, Ordering::SeqCst) {
                                        info!("{} writes recovered", label);
                                    }
                                }
                                Err(e) => {
                                    if health.write_ok.swap(false, Ordering::SeqCst) {
                                        error!(
                                            "{} write failed ({}): marking connected=false",
                                            label, e
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
        })
        .context("spawn driver writer thread")?;
    Ok(DriverLink {
        tx,
        pending_velocity,
        queue_full_warned: AtomicBool::new(false),
    })
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

/// Errors a client can get from a motion command. (A cancelled gesture is internal: it just stops.)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MotionError {
    /// `POST /stop` latched the E-stop; only `POST /estop/release` clears it.
    EstopLatched,
}

/// Everything that decides whether (and what) goes to the motors. It is held while
/// commands are queued to the driver, so the latch/epoch check and the send are atomic.
struct MotionGate {
    estop_latched: bool,
    epoch: u64,
    /// Last command sent by a client or gesture, arm and jog included
    /// (watchdog/brake/resend do not count).
    last_user_cmd_at: Instant,
    /// Time-boxed `cmd_vel` end (`duration_ms`, default = watchdog).
    deadline: Option<Instant>,
    last_driver_send: Instant,
    /// Epoch of the gesture whose step set the current (non-zero) chassis velocity.
    /// When the epoch moves on, that velocity is cancelled instead of re-sent.
    gesture_velocity_epoch: Option<u64>,
}

impl MotionGate {
    fn check(&self) -> Result<(), MotionError> {
        if self.estop_latched {
            return Err(MotionError::EstopLatched);
        }
        Ok(())
    }

    /// True while the gesture started at `epoch` may keep moving the robot.
    fn is_current(&self, epoch: u64) -> bool {
        !self.estop_latched && self.epoch == epoch
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
    driver: Mutex<Option<DriverLink>>,
    health: Arc<DriverHealth>,
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
    driver: Option<DriverLink>,
    health: Arc<DriverHealth>,
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
        lock(&self.driver).take();
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
            driver: None,
            health: DriverHealth::new(false),
            lidar_source: LidarSource::Mock,
            last_scan_at: Arc::new(Mutex::new(None)),
            worker_alive: Arc::new(AtomicBool::new(true)),
            worker_child: None,
            watchdog_ms,
        })
    }

    fn from_parts(p: ControllerParts) -> Arc<Self> {
        let mock = p.driver.is_none();
        {
            let mut st = lock(&p.state);
            st.lidar_source = p.lidar_source.as_str().into();
            st.lidar_stale = p.lidar_source == LidarSource::Ros2;
            if p.lidar_source == LidarSource::Ros2 {
                // No real scan yet: show "blocked" (0.0) instead of the mock's invented distances.
                st.lidar = LidarSectors {
                    front_m: 0.0,
                    left_m: 0.0,
                    right_m: 0.0,
                    back_m: 0.0,
                    obstacle_alert: true,
                    uncovered: Vec::new(),
                };
            }
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
                gesture_velocity_epoch: None,
            }),
            latest_jpeg: p.latest_jpeg,
            driver: Mutex::new(p.driver),
            health: p.health,
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
        let health = DriverHealth::new(false);
        let link = spawn_driver_writer("serial", Arc::clone(&health), move |cmd| {
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
                // Not written, so it does not count for `connected`.
                DriverCmd::Rgb { .. }
                | DriverCmd::Ping { .. }
                | DriverCmd::Wake
                | DriverCmd::Flush(_) => return Ok(false),
            };
            port.write_all(&frame)?;
            port.flush()?;
            Ok(true)
        })?;
        Ok(Self::from_parts(ControllerParts {
            state,
            latest_jpeg: Arc::new(Mutex::new(None)),
            driver: Some(link),
            health,
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
            // The worker never needs the Gemini key the bridge serves on /config/gemini-key
            .env_remove("GEMINI_API_KEY")
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
        let health = DriverHealth::new(true);

        let (first_tx, first_rx) = mpsc::sync_channel::<Option<String>>(1);
        {
            let state = Arc::clone(&state);
            let jpeg = Arc::clone(&latest_jpeg);
            let last_scan = Arc::clone(&last_scan_at);
            let alive = Arc::clone(&worker_alive);
            let health = Arc::clone(&health);
            std::thread::Builder::new()
                .name("ros2-worker-reader".into())
                .spawn(move || {
                    let mut reader = BufReader::new(stdout);
                    let mut first = String::new();
                    match reader.read_line(&mut first) {
                        Ok(n) if n > 0 => {
                            let _ = first_tx.send(Some(first.clone()));
                            handle_worker_line(first.trim(), &state, &jpeg, &last_scan, &health);
                        }
                        _ => {
                            let _ = first_tx.send(None);
                            mark_worker_dead(&state, &alive);
                            return;
                        }
                    }
                    for line in reader.lines() {
                        match line {
                            Ok(line) => {
                                handle_worker_line(line.trim(), &state, &jpeg, &last_scan, &health)
                            }
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

        // The worker's first line proves it is alive: the heartbeat starts counting from here.
        if let Some(h) = &health.heartbeat {
            lock(h).last_acked_sent_at = Instant::now();
        }
        let link = spawn_driver_writer("ros2_worker", Arc::clone(&health), move |cmd| {
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
                DriverCmd::Ping { seq } => serde_json::json!({ "op": "ping", "seq": seq }),
                DriverCmd::Wake | DriverCmd::Flush(_) => return Ok(false),
            };
            writeln!(stdin, "{}", json)?;
            stdin.flush()?;
            Ok(true)
        })?;

        Ok(Self::from_parts(ControllerParts {
            state,
            latest_jpeg,
            driver: Some(link),
            health,
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

    /// Never blocks: velocities go to the latest-wins slot, everything else to the bounded queue
    /// (dropped with a warning when the writer is stuck and the queue is full).
    fn send_driver(&self, cmd: DriverCmd) {
        let guard = lock(&self.driver);
        let Some(link) = guard.as_ref() else {
            return;
        };
        let cmd = match cmd {
            DriverCmd::Velocity { vx, vy, wz } => {
                *lock(&link.pending_velocity) = Some((vx, vy, wz));
                // If the queue is full the writer is busy and will read the slot on its next batch.
                DriverCmd::Wake
            }
            other => other,
        };
        let is_wake = matches!(cmd, DriverCmd::Wake);
        match link.tx.try_send(cmd) {
            Ok(()) => {
                link.queue_full_warned.store(false, Ordering::Relaxed);
            }
            Err(mpsc::TrySendError::Full(_)) => {
                if !is_wake && !link.queue_full_warned.swap(true, Ordering::Relaxed) {
                    warn!(
                        "driver queue full ({} commands): the writer is stuck, dropping commands",
                        DRIVER_QUEUE_CAPACITY
                    );
                }
            }
            Err(mpsc::TrySendError::Disconnected(_)) => {
                warn!("driver writer thread is gone; command dropped");
            }
        }
    }

    /// True when commands reach the robot: always in mock; otherwise worker alive, writes OK and
    /// not stalled, and (`ros2`) a fresh heartbeat ack.
    fn driver_ok(&self, now: Instant) -> bool {
        self.worker_alive.load(Ordering::SeqCst) && self.health.healthy(now)
    }

    /// `Some(WorkerDead)` when nothing would reach the robot right now (for the `blocked` field
    /// of non-chassis commands: arm, jog, LEDs, buzzer, stop).
    pub fn driver_block(&self) -> Option<BlockReason> {
        (!self.driver_ok(Instant::now())).then_some(BlockReason::WorkerDead)
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
    ) -> VelocityOutcome {
        let now = Instant::now();
        let (mut vx, mut vy, mut wz) = clamp_velocity(linear_x, linear_y, angular_z);
        if self.lidar_source == LidarSource::None {
            vx = vx.clamp(-NO_LIDAR_MAX_LINEAR_MPS, NO_LIDAR_MAX_LINEAR_MPS);
            vy = vy.clamp(-NO_LIDAR_MAX_LINEAR_MPS, NO_LIDAR_MAX_LINEAR_MPS);
        }
        let requested_moving = is_moving(vx, vy, wz);
        let driver_ok = self.driver_ok(now);
        let stale = self.lidar_is_stale(now);
        let mut blocked = None;
        {
            let mut st = lock(&self.state);
            st.lidar_stale = stale;
            if !driver_ok || stale {
                if requested_moving {
                    if driver_ok {
                        warn!("LiDAR sin datos recientes (>300 ms): chasis bloqueado");
                        blocked = Some(BlockReason::LidarStale);
                    } else {
                        warn!("Driver sin respuesta (worker caído/atascado): chasis bloqueado");
                        blocked = Some(BlockReason::WorkerDead);
                    }
                }
                vx = 0.0;
                vy = 0.0;
                wz = 0.0;
            } else if self.lidar_source != LidarSource::None {
                let (bx, by, bw, braked) = apply_lidar_brake(&st.lidar, vx, vy, wz);
                if braked {
                    blocked = Some(BlockReason::Braked);
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
            self.mark_user_command_locked(gate);
        }
        gate.deadline = if is_moving(vx, vy, wz) {
            let default_ms = (self.watchdog_timeout.as_millis() as u64).max(100);
            let dur_ms = duration_ms.unwrap_or(default_ms).clamp(100, 2500);
            Some(now + Duration::from_millis(dur_ms))
        } else {
            gate.gesture_velocity_epoch = None;
            None
        };
        gate.last_driver_send = now;
        self.send_driver(DriverCmd::Velocity { vx, vy, wz });
        VelocityOutcome {
            applied: (vx, vy, wz),
            blocked,
        }
    }

    /// Records a client/gesture command (chassis, arm or jog) for the watchdog and for
    /// `last_command_ms_ago` (reset right away, not only on the next tick).
    fn mark_user_command_locked(&self, gate: &mut MotionGate) {
        gate.last_user_cmd_at = Instant::now();
        lock(&self.state).last_command_ms_ago = 0;
    }

    /// Starts a new command epoch, cancelling any running gesture. If that gesture was driving
    /// the chassis, its velocity is zeroed right here, under the same lock (otherwise the tick
    /// would keep re-sending it until the step deadline).
    fn cancel_gesture_locked(&self, gate: &mut MotionGate) -> u64 {
        let epoch = gate.next_epoch();
        if gate.gesture_velocity_epoch.take().is_some() {
            self.apply_velocity_locked(gate, 0.0, 0.0, 0.0, None, false);
        }
        epoch
    }

    /// Client `cmd_vel`: cancels any gesture. Returns the velocity actually applied and,
    /// if a safety layer reduced it, why.
    pub fn set_velocity_with_duration(
        &self,
        linear_x: f32,
        linear_y: f32,
        angular_z: f32,
        duration_ms: Option<u64>,
    ) -> Result<VelocityOutcome, MotionError> {
        let mut gate = lock(&self.gate);
        gate.check()?;
        gate.next_epoch();
        gate.gesture_velocity_epoch = None;
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

    /// Client arm pose: cancels any gesture (and the chassis velocity it was driving).
    pub fn set_arm(&self, duration_ms: u16, targets: &[ServoTarget]) -> Result<(), MotionError> {
        let mut gate = lock(&self.gate);
        gate.check()?;
        self.cancel_gesture_locked(&mut gate);
        self.mark_user_command_locked(&mut gate);
        self.apply_arm_locked(duration_ms, targets);
        Ok(())
    }

    pub fn jog_servo(&self, id: u8, delta: i16) -> Result<u16, MotionError> {
        let mut gate = lock(&self.gate);
        gate.check()?;
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
        self.cancel_gesture_locked(&mut gate);
        self.mark_user_command_locked(&mut gate);
        self.apply_arm_locked(120, &[ServoTarget { id, position: next }]);
        Ok(next)
    }

    pub fn reset_scene(&self) -> Result<(), MotionError> {
        let mut gate = lock(&self.gate);
        gate.check()?;
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
        gate.check()?;
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
    /// latches the E-stop (open keep-alive/WS connections cannot move the robot while the server
    /// drains), zeroes velocity and waits until the writer has flushed it (bounded).
    pub fn halt_for_shutdown(&self) {
        {
            let mut gate = lock(&self.gate);
            gate.estop_latched = true;
            gate.next_epoch();
            gate.deadline = None;
            gate.gesture_velocity_epoch = None;
        }
        {
            let mut st = lock(&self.state);
            st.estop_latched = true;
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
        warn!("Apagado: E-stop enclavada y chasis a 0 (ninguna conexión abierta puede mover el robot)");
    }

    /// What would stop `seq` from moving as designed right now (reported in `blocked`).
    fn gesture_block_reason(&self, seq: &GestureSequence, now: Instant) -> Option<BlockReason> {
        if !self.driver_ok(now) {
            return Some(BlockReason::WorkerDead);
        }
        let mut velocities = seq
            .steps
            .iter()
            .filter_map(|s| s.velocity)
            .filter(|&(vx, vy, wz)| is_moving(vx, vy, wz))
            .peekable();
        velocities.peek()?;
        if self.lidar_is_stale(now) {
            return Some(BlockReason::LidarStale);
        }
        if self.lidar_source == LidarSource::None {
            return None;
        }
        let lidar = lock(&self.state).lidar.clone();
        velocities
            .any(|(vx, vy, wz)| apply_lidar_brake(&lidar, vx, vy, wz).3)
            .then_some(BlockReason::Braked)
    }

    /// Starts a gesture (cancelling the previous one and any chassis velocity it was driving).
    /// Returns why the chassis part would be blocked right now, if it would.
    pub fn run_gesture(
        self: &Arc<Self>,
        name: &str,
        mood_override: Option<String>,
    ) -> Result<Option<BlockReason>, MotionError> {
        let seq = get_gesture(name);
        let (my_epoch, blocked) = {
            let mut gate = lock(&self.gate);
            gate.check()?;
            let my_epoch = self.cancel_gesture_locked(&mut gate);
            let blocked = self.gesture_block_reason(&seq, Instant::now());
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
            (my_epoch, blocked)
        };

        let ctrl = Arc::clone(self);
        tokio::spawn(async move {
            let mut reverse_logged = false;
            for step in &seq.steps {
                if !ctrl.gesture_step(my_epoch, step, &seq.name, &mut reverse_logged) {
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
            if gate.is_current(my_epoch) {
                ctrl.apply_velocity_locked(&mut gate, 0.0, 0.0, 0.0, None, false);
            }
        });
        Ok(blocked)
    }

    /// One gesture step, atomically checked against the latch and the gesture epoch
    /// (returns false if the gesture was cancelled). The velocity is then kept alive by the
    /// tick resend until the step ends, unless the gesture is cancelled first.
    fn gesture_step(
        &self,
        epoch: u64,
        step: &GestureStep,
        gesture: &str,
        reverse_logged: &mut bool,
    ) -> bool {
        let mut gate = lock(&self.gate);
        if !gate.is_current(epoch) {
            return false;
        }
        self.apply_arm_locked(step.duration_ms, &step.servos);
        if let Some((vx, vy, wz)) = step.velocity {
            let mut vx = vx;
            let mut duration_ms = step.duration_ms as u64 + 100;
            let back_uncovered =
                self.lidar_source != LidarSource::None && !lock(&self.state).lidar.covers("back");
            if vx < 0.0 && back_uncovered {
                // Nothing senses behind the robot: reverse slowly and briefly.
                vx = vx.max(-GESTURE_BLIND_REVERSE_MPS);
                duration_ms = duration_ms.min(GESTURE_BLIND_REVERSE_MAX_MS);
                if !*reverse_logged {
                    info!(
                        "Gesto {}: el LiDAR no cubre atrás; reversa limitada a {:.2} m/s y {} ms",
                        gesture, GESTURE_BLIND_REVERSE_MPS, GESTURE_BLIND_REVERSE_MAX_MS
                    );
                    *reverse_logged = true;
                }
            }
            let out = self.apply_velocity_locked(&mut gate, vx, vy, wz, Some(duration_ms), true);
            let (ax, ay, aw) = out.applied;
            gate.gesture_velocity_epoch = is_moving(ax, ay, aw).then_some(epoch);
        }
        true
    }

    fn gesture_is_current(&self, epoch: u64) -> bool {
        lock(&self.gate).is_current(epoch)
    }

    /// Periodic 40Hz physics + servo interpolation + LiDAR reflex + watchdog + resend tick.
    pub fn tick(&self, dt_s: f32) {
        let last_command_ms_ago = self.enforce_motion_safety();
        self.integrate(dt_s, last_command_ms_ago);
    }

    /// Watchdog/deadline, driver health + heartbeat, fail-closed LiDAR, per-axis brake and
    /// ~100 ms resend. Returns ms since the last client command.
    pub fn enforce_motion_safety(&self) -> u64 {
        let now = Instant::now();
        let mut gate = lock(&self.gate);
        if let Some(h) = &self.health.heartbeat {
            let due = lock(h).next_ping(now);
            if let Some(seq) = due {
                self.send_driver(DriverCmd::Ping { seq });
            }
        }
        let driver_ok = self.driver_ok(now);
        let stale = self.lidar_is_stale(now);
        let (cur, lidar) = {
            let mut st = lock(&self.state);
            if !self.mock && st.connected != driver_ok {
                if driver_ok {
                    info!("Driver respondiendo de nuevo: connected=true");
                } else {
                    error!("Driver sin respuesta (heartbeat/escritura): connected=false, chasis bloqueado");
                }
                st.connected = driver_ok;
            }
            st.lidar_stale = stale;
            st.lidar.obstacle_alert =
                self.lidar_source != LidarSource::None && st.lidar.min_m() < LIDAR_ALERT_M;
            (
                (st.odometry.vx, st.odometry.vy, st.odometry.wz),
                st.lidar.clone(),
            )
        };
        let moving = is_moving(cur.0, cur.1, cur.2);

        // A cancelled gesture's velocity is never re-sent (cancel_gesture_locked already zeroes
        // it; this also covers any path that moved the epoch on without it).
        let orphaned = gate.gesture_velocity_epoch.is_some_and(|e| e != gate.epoch);
        let expired = orphaned
            || match gate.deadline {
                Some(deadline) => now >= deadline,
                None => {
                    moving
                        && now.saturating_duration_since(gate.last_user_cmd_at)
                            > self.watchdog_timeout
                }
            };

        if expired {
            // Watchdog / duration end: stop, but never latch and never count as a client command.
            self.apply_velocity_locked(&mut gate, 0.0, 0.0, 0.0, None, false);
        } else if moving {
            let target = if stale || !driver_ok {
                (0.0, 0.0, 0.0)
            } else if self.lidar_source != LidarSource::None {
                let (vx, vy, wz, _) = apply_lidar_brake(&lidar, cur.0, cur.1, cur.2);
                (vx, vy, wz)
            } else {
                cur
            };
            if target != cur {
                let remaining_deadline = gate.deadline;
                let (ax, ay, aw) = self
                    .apply_velocity_locked(&mut gate, target.0, target.1, target.2, None, false)
                    .applied;
                if is_moving(ax, ay, aw) {
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

    /// Test-only controller whose driver commands go through the real writer thread and are
    /// captured by the returned receiver. With `ack_pings`, heartbeat pings are echoed at once
    /// (a healthy worker); without it the worker looks stuck.
    #[cfg(test)]
    pub fn new_with_test_driver_opts(
        lidar_source: LidarSource,
        watchdog_ms: u64,
        ack_pings: bool,
    ) -> (Arc<Self>, mpsc::Receiver<DriverCmd>) {
        let (tx, rx) = mpsc::channel();
        let health = DriverHealth::new(lidar_source == LidarSource::Ros2);
        let echo = Arc::clone(&health);
        let link = spawn_driver_writer("test", Arc::clone(&health), move |cmd| {
            let copy = match cmd {
                DriverCmd::Ping { seq } => {
                    if ack_pings {
                        echo.ack_ping(*seq);
                    }
                    return Ok(true);
                }
                DriverCmd::Velocity { vx, vy, wz } => DriverCmd::Velocity {
                    vx: *vx,
                    vy: *vy,
                    wz: *wz,
                },
                DriverCmd::Arm {
                    duration_ms,
                    servos,
                } => DriverCmd::Arm {
                    duration_ms: *duration_ms,
                    servos: servos.clone(),
                },
                DriverCmd::Buzzer {
                    freq_hz,
                    on_ms,
                    off_ms,
                    repeat,
                } => DriverCmd::Buzzer {
                    freq_hz: *freq_hz,
                    on_ms: *on_ms,
                    off_ms: *off_ms,
                    repeat: *repeat,
                },
                DriverCmd::Rgb { r, g, b } => DriverCmd::Rgb {
                    r: *r,
                    g: *g,
                    b: *b,
                },
                DriverCmd::Wake | DriverCmd::Flush(_) => return Ok(false),
            };
            let _ = tx.send(copy);
            Ok(true)
        })
        .expect("test writer");
        let ctrl = Self::from_parts(ControllerParts {
            state: Arc::new(Mutex::new(TelemetryState {
                backend: format!("test-{}", lidar_source.as_str()),
                ..Default::default()
            })),
            latest_jpeg: Arc::new(Mutex::new(None)),
            driver: Some(link),
            health,
            lidar_source,
            last_scan_at: Arc::new(Mutex::new(None)),
            worker_alive: Arc::new(AtomicBool::new(true)),
            worker_child: None,
            watchdog_ms,
        });
        (ctrl, rx)
    }

    #[cfg(test)]
    pub fn new_with_test_driver(
        lidar_source: LidarSource,
        watchdog_ms: u64,
    ) -> (Arc<Self>, mpsc::Receiver<DriverCmd>) {
        Self::new_with_test_driver_opts(lidar_source, watchdog_ms, true)
    }

    /// Waits until everything queued so far has been written (tests).
    #[cfg(test)]
    fn flush_driver(&self) {
        let (ack_tx, ack_rx) = mpsc::sync_channel(1);
        {
            let guard = lock(&self.driver);
            let Some(link) = guard.as_ref() else {
                return;
            };
            // Blocking send on purpose: tests may flush right after a full queue drains.
            link.tx
                .send(DriverCmd::Flush(ack_tx))
                .expect("writer alive");
        }
        ack_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("driver flush");
    }

    #[cfg(test)]
    fn mark_scan_received(&self, at: Instant) {
        *lock(&self.last_scan_at) = Some(at);
    }

    /// Feeds one stdout line as if the ros2 worker had printed it (tests).
    #[cfg(test)]
    fn feed_worker_line(&self, line: &str) {
        handle_worker_line(
            line,
            &self.state,
            &self.latest_jpeg,
            &self.last_scan_at,
            &self.health,
        );
    }
}

fn handle_worker_line(
    line: &str,
    state: &Arc<Mutex<TelemetryState>>,
    jpeg: &Arc<Mutex<Option<Vec<u8>>>>,
    last_scan: &Arc<Mutex<Option<Instant>>>,
    health: &DriverHealth,
) {
    use base64::Engine as _;
    if !line.starts_with('{') {
        return;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
        return;
    };
    match v.get("event").and_then(|s| s.as_str()) {
        Some("pong") => {
            if let Some(seq) = v.get("seq").and_then(|n| n.as_u64()) {
                health.ack_ping(seq);
            }
        }
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
        // A sector the worker could not see (too few valid echoes) arrives as 0.0: it blocks.
        Some("lidar") => {
            {
                let mut st = lock(state);
                if let Some(f) = v.get("front_m").and_then(|n| n.as_f64()) {
                    st.lidar.front_m = (f as f32).clamp(0.0, 12.0);
                }
                if let Some(l) = v.get("left_m").and_then(|n| n.as_f64()) {
                    st.lidar.left_m = (l as f32).clamp(0.0, 12.0);
                }
                if let Some(r) = v.get("right_m").and_then(|n| n.as_f64()) {
                    st.lidar.right_m = (r as f32).clamp(0.0, 12.0);
                }
                if let Some(b) = v.get("back_m").and_then(|n| n.as_f64()) {
                    st.lidar.back_m = (b as f32).clamp(0.0, 12.0);
                }
                // An older worker sends no `uncovered`: every sector counts (fail closed).
                st.lidar.uncovered = parse_uncovered(v.get("uncovered"));
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

    fn drain_velocities(
        ctrl: &RobotController,
        rx: &mpsc::Receiver<DriverCmd>,
    ) -> Vec<(f32, f32, f32)> {
        ctrl.flush_driver();
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
            uncovered: Vec::new(),
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
        assert_eq!(applied.applied, (0.0, 0.0, 0.3));

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

        // No scan yet: fail closed, and no invented distances in telemetry
        let snap = ctrl.snapshot();
        assert_eq!(
            (
                snap.lidar.front_m,
                snap.lidar.left_m,
                snap.lidar.right_m,
                snap.lidar.back_m
            ),
            (0.0, 0.0, 0.0, 0.0)
        );
        let applied = ctrl
            .set_velocity_with_duration(0.15, 0.0, 0.3, Some(1000))
            .unwrap();
        assert_eq!(applied.applied, (0.0, 0.0, 0.0));
        assert_eq!(applied.blocked, Some(BlockReason::LidarStale));
        assert!(ctrl.snapshot().lidar_stale);

        // Fresh scan: motion allowed
        ctrl.feed_worker_line(
            r#"{"event":"lidar","front_m":1.5,"left_m":1.2,"right_m":1.1,"back_m":2.0}"#,
        );
        let applied = ctrl
            .set_velocity_with_duration(0.15, 0.0, 0.0, Some(1000))
            .unwrap();
        assert_eq!(applied.applied, (0.15, 0.0, 0.0));
        assert_eq!(applied.blocked, None);
        assert!(!ctrl.snapshot().lidar_stale);

        // Scan becomes older than 300 ms during the move: the tick zeroes the chassis
        ctrl.mark_scan_received(Instant::now() - Duration::from_millis(400));
        let _ = drain_velocities(&ctrl, &rx);
        ctrl.tick(0.025);
        let snap = ctrl.snapshot();
        assert!(snap.lidar_stale);
        assert_eq!(
            (snap.odometry.vx, snap.odometry.vy, snap.odometry.wz),
            (0.0, 0.0, 0.0)
        );
        assert_eq!(drain_velocities(&ctrl, &rx).last(), Some(&(0.0, 0.0, 0.0)));

        // Worker EOF: connected=false and stale even with a fresh timestamp
        ctrl.mark_scan_received(Instant::now());
        mark_worker_dead(&ctrl.state, &ctrl.worker_alive);
        assert!(!ctrl.snapshot().connected);
        let applied = ctrl
            .set_velocity_with_duration(0.15, 0.0, 0.0, None)
            .unwrap();
        assert_eq!(applied.applied, (0.0, 0.0, 0.0));
        assert_eq!(applied.blocked, Some(BlockReason::WorkerDead));
        assert_eq!(ctrl.driver_block(), Some(BlockReason::WorkerDead));
    }

    #[test]
    fn test_uncovered_sector_is_ignored_by_brake_and_alert() {
        let back_uncovered = LidarSectors {
            front_m: 2.0,
            left_m: 2.0,
            right_m: 2.0,
            back_m: 0.0,
            obstacle_alert: false,
            uncovered: vec!["back".into()],
        };
        // Reverse is not braked and the 0.0 does not cap |wz|
        assert_eq!(
            apply_lidar_brake(&back_uncovered, -0.2, 0.0, 0.8),
            (-0.2, 0.0, 0.8, false)
        );
        assert_eq!(back_uncovered.min_m(), 2.0);
        // The covered sectors still brake
        let front_close = LidarSectors {
            front_m: 0.2,
            ..back_uncovered.clone()
        };
        assert_eq!(
            apply_lidar_brake(&front_close, 0.1, 0.0, 0.0),
            (0.0, 0.0, 0.0, true)
        );
        // Only known names count, and "everything uncovered" means nothing is
        let v: serde_json::Value = serde_json::json!(["back", "back", "up"]);
        assert_eq!(parse_uncovered(Some(&v)), vec!["back".to_string()]);
        let all: serde_json::Value = serde_json::json!(["front", "left", "right", "back"]);
        assert!(parse_uncovered(Some(&all)).is_empty());
        assert!(parse_uncovered(None).is_empty());
    }

    #[test]
    fn test_uncovered_back_allows_manual_reverse_but_blind_back_brakes() {
        let (ctrl, _rx) = RobotController::new_with_test_driver(LidarSource::Ros2, 600);
        ctrl.feed_worker_line(
            r#"{"event":"lidar","front_m":1.5,"left_m":1.2,"right_m":1.1,"back_m":0.0,"uncovered":["back"]}"#,
        );
        let snap = ctrl.snapshot();
        assert_eq!(snap.lidar.uncovered, vec!["back".to_string()]);
        assert!(!snap.lidar.obstacle_alert);
        let out = ctrl
            .set_velocity_with_duration(-0.15, 0.0, 0.0, Some(500))
            .unwrap();
        assert_eq!(out.applied, (-0.15, 0.0, 0.0));
        assert_eq!(out.blocked, None);

        // Same 0.0 without `uncovered` (blind back or an older worker): reverse is braked
        ctrl.feed_worker_line(
            r#"{"event":"lidar","front_m":1.5,"left_m":1.2,"right_m":1.1,"back_m":0.0}"#,
        );
        let snap = ctrl.snapshot();
        assert!(snap.lidar.uncovered.is_empty());
        assert!(snap.lidar.obstacle_alert);
        let out = ctrl
            .set_velocity_with_duration(-0.15, 0.0, 0.0, Some(500))
            .unwrap();
        assert_eq!(out.applied, (0.0, 0.0, 0.0));
        assert_eq!(out.blocked, Some(BlockReason::Braked));
    }

    #[test]
    fn test_gesture_reverse_is_slow_and_short_when_back_is_uncovered() {
        let (ctrl, _rx) = RobotController::new_with_test_driver(LidarSource::Ros2, 600);
        ctrl.feed_worker_line(
            r#"{"event":"lidar","front_m":1.5,"left_m":1.2,"right_m":1.1,"back_m":0.0,"uncovered":["back"]}"#,
        );
        let step = GestureStep {
            duration_ms: 1500,
            servos: Vec::new(),
            velocity: Some((-0.14, 0.05, 0.2)),
        };
        let epoch = {
            let mut gate = lock(&ctrl.gate);
            ctrl.cancel_gesture_locked(&mut gate)
        };
        let mut logged = false;
        assert!(ctrl.gesture_step(epoch, &step, "facepalm", &mut logged));
        assert!(logged);
        let snap = ctrl.snapshot();
        assert_eq!(
            (snap.odometry.vx, snap.odometry.vy, snap.odometry.wz),
            (-GESTURE_BLIND_REVERSE_MPS, 0.05, 0.2)
        );
        let deadline = lock(&ctrl.gate)
            .deadline
            .expect("reverse step has a deadline");
        assert!(
            deadline.saturating_duration_since(Instant::now())
                <= Duration::from_millis(GESTURE_BLIND_REVERSE_MAX_MS)
        );

        // With the back covered (mock, 360°) the gesture reverses as written
        let ctrl = mock();
        let epoch = {
            let mut gate = lock(&ctrl.gate);
            ctrl.cancel_gesture_locked(&mut gate)
        };
        let mut logged = false;
        assert!(ctrl.gesture_step(epoch, &step, "facepalm", &mut logged));
        assert!(!logged);
        assert_eq!(ctrl.snapshot().odometry.vx, -0.14);
    }

    #[test]
    fn test_blind_lidar_sector_blocks_motion_towards_it() {
        let (ctrl, _rx) = RobotController::new_with_test_driver(LidarSource::Ros2, 600);
        // The worker reports a sector without enough valid echoes as 0.0
        ctrl.feed_worker_line(
            r#"{"event":"lidar","front_m":0.0,"left_m":1.2,"right_m":1.1,"back_m":2.0}"#,
        );
        let snap = ctrl.snapshot();
        assert_eq!(snap.lidar.front_m, 0.0);
        let out = ctrl
            .set_velocity_with_duration(0.15, 0.0, 0.0, None)
            .unwrap();
        assert_eq!(out.applied, (0.0, 0.0, 0.0));
        assert_eq!(out.blocked, Some(BlockReason::Braked));
        let out = ctrl
            .set_velocity_with_duration(-0.10, 0.0, 0.0, None)
            .unwrap();
        assert_eq!(out.applied, (-0.10, 0.0, 0.0));
        assert_eq!(out.blocked, None);
    }

    #[test]
    fn test_stuck_worker_without_heartbeat_ack_is_disconnected_and_blocked() {
        let (ctrl, rx) = RobotController::new_with_test_driver_opts(LidarSource::Ros2, 600, false);
        let open = r#"{"event":"lidar","front_m":1.5,"left_m":1.2,"right_m":1.1,"back_m":2.0}"#;
        ctrl.feed_worker_line(open);
        // Start-up grace: the worker's first line counts as an ack
        let out = ctrl
            .set_velocity_with_duration(0.1, 0.0, 0.0, Some(2000))
            .unwrap();
        assert_eq!(out.blocked, None);
        // Keep scans fresh but never ack a ping (worker not reading stdin)
        let start = Instant::now();
        while start.elapsed() < HEARTBEAT_TIMEOUT + Duration::from_millis(200) {
            ctrl.feed_worker_line(open);
            ctrl.tick(0.025);
            std::thread::sleep(Duration::from_millis(25));
        }
        let snap = ctrl.snapshot();
        assert!(!snap.connected);
        assert!(!snap.lidar_stale);
        assert_eq!(
            (snap.odometry.vx, snap.odometry.vy, snap.odometry.wz),
            (0.0, 0.0, 0.0)
        );
        assert_eq!(drain_velocities(&ctrl, &rx).last(), Some(&(0.0, 0.0, 0.0)));
        let out = ctrl
            .set_velocity_with_duration(0.1, 0.0, 0.0, None)
            .unwrap();
        assert_eq!(out.applied, (0.0, 0.0, 0.0));
        assert_eq!(out.blocked, Some(BlockReason::WorkerDead));

        // A pong for an old / unknown seq does not revive it; a fresh one does
        ctrl.feed_worker_line(r#"{"event":"pong","seq":999999}"#);
        ctrl.tick(0.025);
        assert!(!ctrl.snapshot().connected);
        let seq = {
            let mut hb = lock(ctrl.health.heartbeat.as_ref().unwrap());
            hb.last_ping_at = None;
            hb.next_ping(Instant::now()).unwrap()
        };
        ctrl.feed_worker_line(&format!(r#"{{"event":"pong","seq":{seq}}}"#));
        ctrl.tick(0.025);
        assert!(ctrl.snapshot().connected);
    }

    #[test]
    fn test_heartbeat_pings_are_acked_by_a_healthy_worker() {
        let (ctrl, _rx) = RobotController::new_with_test_driver(LidarSource::Ros2, 600);
        let start = Instant::now();
        while start.elapsed() < HEARTBEAT_TIMEOUT * 2 {
            ctrl.mark_scan_received(Instant::now());
            ctrl.tick(0.025);
            std::thread::sleep(Duration::from_millis(25));
        }
        ctrl.flush_driver();
        ctrl.tick(0.025);
        assert!(ctrl.snapshot().connected);
        assert_eq!(ctrl.driver_block(), None);
    }

    #[test]
    fn test_heartbeat_ignores_stale_and_unknown_pongs() {
        let t0 = Instant::now();
        let mut hb = Heartbeat::new(t0);
        let s1 = hb.next_ping(t0).unwrap();
        assert_eq!(hb.next_ping(t0 + Duration::from_millis(10)), None);
        let s2 = hb.next_ping(t0 + HEARTBEAT_INTERVAL).unwrap();
        assert!(s2 > s1);
        hb.ack(s2);
        assert_eq!(hb.last_acked_sent_at, t0 + HEARTBEAT_INTERVAL);
        // s1 was dropped when s2 was acked: acking it now changes nothing
        hb.ack(s1);
        assert_eq!(hb.last_acked_sent_at, t0 + HEARTBEAT_INTERVAL);
        hb.ack(12345);
        assert!(hb.fresh(t0 + HEARTBEAT_INTERVAL + HEARTBEAT_TIMEOUT));
        assert!(!hb.fresh(t0 + HEARTBEAT_INTERVAL + HEARTBEAT_TIMEOUT + Duration::from_millis(1)));
    }

    #[test]
    fn test_unwritten_commands_do_not_count_for_health() {
        // Writer that fails every real write but skips RGB (like `serial`).
        let health = DriverHealth::new(false);
        let link = spawn_driver_writer("t", Arc::clone(&health), |cmd| match cmd {
            DriverCmd::Rgb { .. } => Ok(false),
            _ => Err(std::io::Error::other("port gone")),
        })
        .unwrap();
        let flush = |link: &DriverLink| {
            let (ack_tx, ack_rx) = mpsc::sync_channel(1);
            link.tx.send(DriverCmd::Flush(ack_tx)).unwrap();
            ack_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        };
        link.tx
            .send(DriverCmd::Buzzer {
                freq_hz: 1,
                on_ms: 1,
                off_ms: 1,
                repeat: 1,
            })
            .unwrap();
        flush(&link);
        assert!(!health.healthy(Instant::now()));
        link.tx.send(DriverCmd::Rgb { r: 1, g: 2, b: 3 }).unwrap();
        flush(&link);
        assert!(
            !health.healthy(Instant::now()),
            "RGB is not written on serial"
        );
    }

    #[test]
    fn test_full_driver_queue_never_blocks_and_keeps_newest_velocity() {
        // Writer stuck on the first write until released.
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let (seen_tx, seen_rx) = mpsc::channel::<(f32, f32, f32)>();
        let health = DriverHealth::new(false);
        let mut first = true;
        let link = spawn_driver_writer("t", Arc::clone(&health), move |cmd| {
            if first {
                first = false;
                let _ = release_rx.recv();
            }
            if let DriverCmd::Velocity { vx, vy, wz } = cmd {
                let _ = seen_tx.send((*vx, *vy, *wz));
            }
            Ok(true)
        })
        .unwrap();
        let ctrl = RobotController::from_parts(ControllerParts {
            state: Arc::new(Mutex::new(TelemetryState::default())),
            latest_jpeg: Arc::new(Mutex::new(None)),
            driver: Some(link),
            health: Arc::clone(&health),
            lidar_source: LidarSource::Mock,
            last_scan_at: Arc::new(Mutex::new(None)),
            worker_alive: Arc::new(AtomicBool::new(true)),
            worker_child: None,
            watchdog_ms: 600,
        });
        ctrl.set_rgb(1, 1, 1); // the writer blocks on this one
        std::thread::sleep(Duration::from_millis(50));
        let start = Instant::now();
        for i in 0..(DRIVER_QUEUE_CAPACITY * 4) {
            ctrl.set_rgb(i as u8, 0, 0);
            ctrl.send_driver(DriverCmd::Velocity {
                vx: 0.1,
                vy: 0.0,
                wz: 0.0,
            });
        }
        ctrl.send_driver(DriverCmd::Velocity {
            vx: 0.0,
            vy: 0.0,
            wz: 0.0,
        });
        assert!(
            start.elapsed() < Duration::from_millis(200),
            "send_driver blocked"
        );
        // The stalled write is detected
        std::thread::sleep(DRIVER_WRITE_STALL_AFTER + Duration::from_millis(50));
        assert!(!health.healthy(Instant::now()));
        ctrl.tick(0.025);
        assert!(!ctrl.snapshot().connected || ctrl.is_mock());
        release_tx.send(()).unwrap();
        ctrl.flush_driver();
        let seen: Vec<_> = seen_rx.try_iter().collect();
        assert_eq!(
            seen,
            vec![(0.0, 0.0, 0.0)],
            "only the newest velocity is written"
        );
        assert!(health.healthy(Instant::now()));
    }

    #[tokio::test]
    async fn test_cancelling_a_moving_gesture_zeroes_velocity_at_once() {
        let (ctrl, rx) = RobotController::new_with_test_driver(LidarSource::Mock, 600);
        ctrl.run_gesture("victory_spin", None).unwrap();
        tokio::time::sleep(Duration::from_millis(60)).await;
        ctrl.tick(0.025);
        assert!(
            ctrl.snapshot().odometry.wz.abs() > 0.5,
            "victory_spin should be spinning"
        );

        // New gesture without chassis motion in its first step: the spin stops right away,
        // before any tick could re-send it.
        ctrl.run_gesture("wave_hello", None).unwrap();
        assert_eq!(ctrl.snapshot().odometry.wz, 0.0);
        assert_eq!(drain_velocities(&ctrl, &rx).last(), Some(&(0.0, 0.0, 0.0)));
        for _ in 0..8 {
            ctrl.tick(0.025);
            assert!(
                drain_velocities(&ctrl, &rx).iter().all(|v| v.2 == 0.0),
                "the cancelled spin must never be re-sent"
            );
        }

        // Same through /arm and jog
        for cancel in 0..2 {
            ctrl.run_gesture("victory_spin", None).unwrap();
            tokio::time::sleep(Duration::from_millis(60)).await;
            assert!(ctrl.snapshot().odometry.wz.abs() > 0.5);
            let _ = drain_velocities(&ctrl, &rx);
            if cancel == 0 {
                ctrl.set_arm(
                    300,
                    &[ServoTarget {
                        id: 1,
                        position: 520,
                    }],
                )
                .unwrap();
            } else {
                ctrl.jog_servo(1, 10).unwrap();
            }
            assert_eq!(ctrl.snapshot().odometry.wz, 0.0);
            ctrl.tick(0.025);
            assert!(drain_velocities(&ctrl, &rx).iter().all(|v| v.2 == 0.0));
        }

        // A client cmd_vel is NOT cancelled by an arm command
        ctrl.set_velocity_with_duration(0.1, 0.0, 0.0, Some(1000))
            .unwrap();
        ctrl.jog_servo(1, 10).unwrap();
        assert_eq!(ctrl.snapshot().odometry.vx, 0.1);
    }

    #[test]
    fn test_gesture_reports_blocked_reason() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        rt.block_on(async {
            let (ctrl, _rx) = RobotController::new_with_test_driver(LidarSource::Ros2, 600);
            // No scan: a gesture with chassis motion is blocked, an arm-only one is not
            assert_eq!(
                ctrl.run_gesture("victory_spin", None).unwrap(),
                Some(BlockReason::LidarStale)
            );
            assert_eq!(ctrl.run_gesture("gatekeeper_hold", None).unwrap(), None);
            // Obstacle close: the spin would be capped by the reflex
            ctrl.feed_worker_line(
                r#"{"event":"lidar","front_m":0.2,"left_m":1.2,"right_m":1.1,"back_m":2.0}"#,
            );
            assert_eq!(
                ctrl.run_gesture("victory_spin", None).unwrap(),
                Some(BlockReason::Braked)
            );
            // Worker gone: everything is blocked
            mark_worker_dead(&ctrl.state, &ctrl.worker_alive);
            assert_eq!(
                ctrl.run_gesture("gatekeeper_hold", None).unwrap(),
                Some(BlockReason::WorkerDead)
            );
        });
    }

    #[test]
    fn test_shutdown_latches_estop() {
        let ctrl = mock();
        ctrl.set_velocity_with_duration(0.1, 0.0, 0.0, None)
            .unwrap();
        ctrl.halt_for_shutdown();
        let snap = ctrl.snapshot();
        assert!(snap.estop_latched);
        assert_eq!(snap.odometry.vx, 0.0);
        assert_eq!(
            ctrl.set_velocity_with_duration(0.1, 0.0, 0.0, None),
            Err(MotionError::EstopLatched)
        );
        assert!(ctrl.run_gesture("chef_kiss", None).is_err());
    }

    #[test]
    fn test_arm_and_jog_count_as_last_command() {
        let ctrl = mock();
        std::thread::sleep(Duration::from_millis(80));
        ctrl.tick(0.025);
        assert!(ctrl.snapshot().last_command_ms_ago >= 80);
        ctrl.set_arm(
            300,
            &[ServoTarget {
                id: 1,
                position: 520,
            }],
        )
        .unwrap();
        ctrl.tick(0.025);
        assert!(ctrl.snapshot().last_command_ms_ago < 80);
        std::thread::sleep(Duration::from_millis(80));
        ctrl.jog_servo(2, 5).unwrap();
        ctrl.tick(0.025);
        assert!(ctrl.snapshot().last_command_ms_ago < 80);
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
        assert_eq!(applied.applied, (0.15, -0.15, 0.5));
    }

    #[test]
    fn test_cmd_vel_is_resent_until_deadline() {
        // Timing-robust: each tick is bracketed by `before`/`after` timestamps. Sleeps can only
        // overshoot, so a resend must happen before the deadline (`before` < deadline) and the
        // stop at or after it (`after` >= deadline), however slow the machine is.
        const DEADLINE_MS: u64 = 450;
        let (ctrl, rx) = RobotController::new_with_test_driver(LidarSource::Mock, 600);
        ctrl.set_velocity_with_duration(0.1, 0.0, 0.0, Some(DEADLINE_MS))
            .unwrap();
        let start = Instant::now();
        assert_eq!(drain_velocities(&ctrl, &rx), vec![(0.1, 0.0, 0.0)]);

        let deadline = Duration::from_millis(DEADLINE_MS);
        let mut sent = Vec::new();
        let mut ticks_mid_window = 0;
        while start.elapsed() < deadline + Duration::from_millis(400) {
            std::thread::sleep(Duration::from_millis(25));
            let before = start.elapsed();
            ctrl.tick(0.025);
            let after = start.elapsed();
            if before >= DRIVER_RESEND_INTERVAL + Duration::from_millis(10)
                && after < deadline - Duration::from_millis(10)
            {
                ticks_mid_window += 1;
            }
            for v in drain_velocities(&ctrl, &rx) {
                sent.push((before, after, v));
            }
        }
        let resends: Vec<_> = sent.iter().filter(|(_, _, v)| v.0 > 0.0).collect();
        if ticks_mid_window > 0 {
            assert!(!resends.is_empty(), "expected resends, got {:?}", sent);
        }
        assert!(
            resends.iter().all(|(before, _, _)| *before < deadline),
            "resend after the deadline: {:?}",
            sent
        );
        let stop = sent.iter().find(|(_, _, v)| *v == (0.0, 0.0, 0.0));
        assert!(
            stop.is_some(),
            "expected a stop after the deadline: {:?}",
            sent
        );
        assert!(stop.unwrap().1 >= deadline);
        assert_eq!(ctrl.snapshot().odometry.vx, 0.0);
        // The watchdog/deadline stop does not count as a client command
        assert!(ctrl.snapshot().last_command_ms_ago >= DEADLINE_MS);
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
