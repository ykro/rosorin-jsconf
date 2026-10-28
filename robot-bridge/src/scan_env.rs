//! «Reconocer»: the arm-only sweep that measures where the Demo B trays and the Demo C totems are.
//!
//! The wheels never move. The arm goes to a survey pose that looks down at the table (the Aurora 930
//! camera is on the gripper), joint1 sweeps slowly from right to left in `SCAN_STEPS` pauses and
//! the arm returns home. At each pause the camera is asked for a capture: `ros2_worker.py` sends the
//! raw RGB/depth frame and LiDAR rays and this module runs the color segmentation, white-paper
//! backdrop filtering, URDF forward kinematics and 3D projection natively in Rust (the mock uses the
//! simulated scene). The views are merged in [`aggregate`] and kept in memory
//! (`TelemetryState::scan_env`) until the bridge restarts, the robot moves or they expire; the prop
//! gestures then aim joint1 at them ([`aim_for`]).
//!
//! The sweep runs through the same gate as every other motion: STOP (E-stop), any other motion
//! command or a dead worker aborts it, and every pulse goes through `clamp_servo_pulse`.

use crate::protocol::clamp_servo_pulse;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::Duration;

/// Pauses of the sweep (one capture each).
pub const SCAN_STEPS: usize = 11;
/// joint1 range of the sweep (right → left). ±53° around the front; the camera adds ±37° of view.
pub const SCAN_J1_MIN: u16 = 280;
pub const SCAN_J1_MAX: u16 = 720;
/// Survey pose for servos 2-4: camera ~29 cm above the table, pitched ~47° down, arm skeleton
/// ≥ 9 cm above the LiDAR scan plane and in front of the turret (URDF forward kinematics, see
/// scripts/test_scan_env.py). Servos 5 and 10 are never sent: the gripper keeps whatever it holds.
pub const SURVEY_POSE: [(u8, u16); 3] = [(2, 520), (3, 215), (4, 195)];
/// Home pose for servos 2-4 at the end (same as the `home` gesture).
pub const HOME_POSE: [(u8, u16); 3] = [(2, 430), (3, 310), (4, 380)];
/// Gentle arm durations: ≤ ~150 pulses/s to the survey pose, ~70 pulses/s between steps.
pub const SURVEY_MOVE_MS: u16 = 1500;
pub const STEP_MOVE_MS: u16 = 600;
pub const SETTLE_MS: u64 = 500;
pub const HOME_MOVE_MS: u16 = 1500;
/// Max wait for one capture from the worker (frame + vision).
pub const CAPTURE_TIMEOUT: Duration = Duration::from_secs(3);
/// joint1 range the prop gestures may aim at (inside `clamp_servo_pulse`'s 120..=880).
pub const AIM_J1_MIN: u16 = 250;
pub const AIM_J1_MAX: u16 = 750;
/// A scan older than this is not used.
pub const SCENE_MAX_AGE_MS: u64 = 15 * 60 * 1000;
/// Chassis displacement (odometry) since the scan that is still corrected by dead reckoning (e.g. the
/// short back-off of `gatekeeper_reject`); beyond it the scan no longer describes the stage.
pub const MOVED_TOLERANCE_M: f32 = 0.15;
pub const MOVED_TOLERANCE_RAD: f32 = 15.0 * std::f32::consts::PI / 180.0;
/// Detections below this confidence are reported but not aimed at.
pub const MIN_AIM_CONFIDENCE: f32 = 0.45;
/// joint1 axis in base_link (URDF), the center the arm turns about.
pub const J1_AXIS_X_M: f32 = 0.04662;
/// Bus servos: 1000 pulses = 240°.
pub const PULSE_DEG: f32 = 0.24;
/// Views of one prop farther than this from its best view are outliers.
pub const INLIER_RADIUS_M: f32 = 0.08;
/// Only the best views are averaged (the centered ones: less perspective and clipping).
pub const TOP_VIEWS: usize = 3;
/// Mock camera: half of the horizontal field of view (fx = 416 px for 640 px ≈ ±37.6°).
pub const MOCK_HALF_FOV_DEG: f32 = 34.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanScene {
    /// Demo B: APROBADO (green) and RECHAZADO (red) trays.
    Gatekeeper,
    /// Demo C: Cloud Run, Gemini Live and Firestore totems.
    Bughunter,
}

impl ScanScene {
    pub fn as_str(&self) -> &'static str {
        match self {
            ScanScene::Gatekeeper => "gatekeeper",
            ScanScene::Bughunter => "bughunter",
        }
    }

    pub fn objects(&self) -> &'static [&'static str] {
        match self {
            ScanScene::Gatekeeper => &["approve_tray", "reject_tray"],
            ScanScene::Bughunter => &["cloud_run", "gemini_live", "firestore"],
        }
    }
}

/// Human label of a prop id (Spanish UI / Gemini responses).
pub fn object_label(id: &str) -> &'static str {
    match id {
        "approve_tray" => "Bandeja APROBADO",
        "reject_tray" => "Bandeja RECHAZADO",
        "cloud_run" => "Tótem Cloud Run",
        "gemini_live" => "Tótem Gemini Live",
        "firestore" => "Tótem Firestore",
        _ => "Objeto",
    }
}

/// Every prop id the scans know.
pub fn is_known_object(id: &str) -> bool {
    [ScanScene::Gatekeeper, ScanScene::Bughunter]
        .iter()
        .any(|s| s.objects().contains(&id))
}

fn is_tray(id: &str) -> bool {
    id.ends_with("_tray")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ScanState {
    #[default]
    Idle,
    Running,
    Done,
    Aborted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AbortReason {
    /// `POST /stop` (E-stop latched): the arm froze where it was.
    Estop,
    /// Another motion command (gesture, arm, jog, cmd_vel, scene reset) took over the arm.
    Interrupted,
    /// The worker/driver stopped answering.
    WorkerDead,
}

/// Robot pose in the odometry frame (`TelemetryState::odometry`).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, Default)]
pub struct Pose2D {
    pub x_m: f32,
    pub y_m: f32,
    pub yaw_rad: f32,
}

impl Pose2D {
    /// Robot-frame point → odometry (world) frame.
    pub fn to_world(self, x: f32, y: f32) -> (f32, f32) {
        let (s, c) = self.yaw_rad.sin_cos();
        (self.x_m + c * x - s * y, self.y_m + s * x + c * y)
    }

    /// Odometry (world) point → robot frame.
    pub fn to_robot(self, wx: f32, wy: f32) -> (f32, f32) {
        let (s, c) = self.yaw_rad.sin_cos();
        let (dx, dy) = (wx - self.x_m, wy - self.y_m);
        (c * dx + s * dy, -s * dx + c * dy)
    }

    fn moved_from(&self, other: &Pose2D) -> bool {
        let dyaw = (self.yaw_rad - other.yaw_rad)
            .sin()
            .atan2((self.yaw_rad - other.yaw_rad).cos());
        (self.x_m - other.x_m).hypot(self.y_m - other.y_m) > MOVED_TOLERANCE_M
            || dyaw.abs() > MOVED_TOLERANCE_RAD
    }
}

/// One prop seen in one capture (worker `scan_env_result` or mock), base_link frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CaptureDetection {
    pub id: String,
    pub x_m: f32,
    pub y_m: f32,
    #[serde(default)]
    pub z_m: f32,
    pub confidence: f32,
    #[serde(default)]
    pub method: String,
    #[serde(default)]
    pub lidar_confirmed: Option<bool>,
}

/// A prop after merging the views of the sweep. Position in base_link at scan time
/// (`ScanEnvStatus::odom_at_scan`); bearing REP-103 (0 = front, + = left).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Detection {
    pub id: String,
    pub label: String,
    pub x_m: f32,
    pub y_m: f32,
    pub z_m: f32,
    pub bearing_deg: f32,
    pub distance_m: f32,
    pub confidence: f32,
    /// Captures that saw it (consistent with the best view).
    pub views: u32,
    /// `plane` (ray ∩ table plane), `depth` (depth camera) or `mock`.
    pub method: String,
    /// Totems: whether the LiDAR saw an echo there (`null` when it has no rays there).
    pub lidar_confirmed: Option<bool>,
    /// joint1 the prop gestures would use from the scan pose.
    pub joint1_target: u16,
}

/// `GET /scan_env` and `TelemetryState::scan_env`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScanEnvStatus {
    pub state: ScanState,
    pub scene: Option<ScanScene>,
    /// Current pause (1..=steps) while running; the last one reached otherwise.
    pub step: u32,
    pub steps: u32,
    pub started_at_ms: Option<u64>,
    pub finished_at_ms: Option<u64>,
    pub reason: Option<AbortReason>,
    /// Captures that returned nothing usable (no frame, timeout, vision error).
    pub failed_captures: u32,
    pub last_error: Option<String>,
    pub detections: Vec<Detection>,
    /// Odometry pose when the scan finished: detections are relative to it.
    pub odom_at_scan: Option<Pose2D>,
    /// The gestures may aim at these detections right now.
    pub fresh: bool,
    /// Why not: `no_scan`, `running`, `aborted`, `not_found`, `moved` or `expired`.
    pub stale_reason: Option<String>,
    /// Sticky: the chassis moved after the scan (odometry beyond the tolerance or a scene reset away
    /// from it). Internal.
    #[serde(skip)]
    pub moved: bool,
}

impl Default for ScanEnvStatus {
    fn default() -> Self {
        Self {
            state: ScanState::Idle,
            scene: None,
            step: 0,
            steps: SCAN_STEPS as u32,
            started_at_ms: None,
            finished_at_ms: None,
            reason: None,
            failed_captures: 0,
            last_error: None,
            detections: Vec::new(),
            odom_at_scan: None,
            fresh: false,
            stale_reason: Some("no_scan".into()),
            moved: false,
        }
    }
}

impl ScanEnvStatus {
    pub fn running(scene: ScanScene, now_ms: u64) -> Self {
        Self {
            state: ScanState::Running,
            scene: Some(scene),
            started_at_ms: Some(now_ms),
            stale_reason: Some("running".into()),
            ..Default::default()
        }
    }

    /// Recomputes `fresh` / `stale_reason` for the current odometry and time.
    pub fn refresh(&mut self, odom: &Pose2D, now_ms: u64) {
        let reason: Option<&'static str> = match self.state {
            ScanState::Idle => Some("no_scan"),
            ScanState::Running => Some("running"),
            ScanState::Aborted => Some("aborted"),
            ScanState::Done => {
                if self.odom_at_scan.is_some_and(|at| odom.moved_from(&at)) {
                    self.moved = true;
                }
                if self.moved {
                    Some("moved")
                } else if self
                    .finished_at_ms
                    .is_some_and(|t| now_ms.saturating_sub(t) > SCENE_MAX_AGE_MS)
                {
                    Some("expired")
                } else if self.detections.is_empty() {
                    Some("not_found")
                } else {
                    None
                }
            }
        };
        self.fresh = reason.is_none();
        if self.stale_reason.as_deref() != reason {
            self.stale_reason = reason.map(str::to_string);
        }
    }

    /// `POST /scene/reset` re-zeroes the odometry without moving the robot: if the robot had not
    /// moved since the scan, the scan stays valid (rebased to the new origin); otherwise it is stale.
    pub fn on_odometry_reset(&mut self, odom_before: &Pose2D) {
        if let Some(at) = self.odom_at_scan {
            if odom_before.moved_from(&at) {
                self.moved = true;
            } else {
                self.odom_at_scan = Some(Pose2D::default());
            }
        }
    }
}

/// joint1 pulses of the sweep, evenly spaced from right (`SCAN_J1_MIN`) to left (`SCAN_J1_MAX`).
pub fn sweep_positions() -> Vec<u16> {
    let span = (SCAN_J1_MAX - SCAN_J1_MIN) as f32;
    (0..SCAN_STEPS)
        .map(|i| SCAN_J1_MIN + (span * i as f32 / (SCAN_STEPS - 1) as f32).round() as u16)
        .collect()
}

/// joint1 pulse that turns the arm toward (x, y) in base_link: the twin's mapping (angle =
/// (pulse − 500) · 0.24° about +z, > 500 = left), clamped to the aim range and the servo limits.
pub fn joint1_for_point(x: f32, y: f32) -> u16 {
    let angle_deg = y.atan2(x - J1_AXIS_X_M).to_degrees();
    let pulse = (500.0 + angle_deg / PULSE_DEG).round();
    let pulse = pulse.clamp(AIM_J1_MIN as f32, AIM_J1_MAX as f32) as u16;
    clamp_servo_pulse(1, pulse)
}

/// Where joint1 at `pulse` points the arm, in degrees (REP-103, + = left).
pub fn joint1_heading_deg(pulse: u16) -> f32 {
    (pulse as f32 - 500.0) * PULSE_DEG
}

fn wrap_deg(a: f32) -> f32 {
    let r = a.to_radians();
    r.sin().atan2(r.cos()).to_degrees()
}

/// Merges the views of the sweep into one detection per prop: the best view (highest confidence),
/// the views within `INLIER_RADIUS_M` of it, and the confidence-weighted mean of the `TOP_VIEWS`
/// best of those. Confidence = their mean × (0.5 + 0.5 · min(1, views / 2)): one lone view counts half.
pub fn aggregate(scene: ScanScene, captures: &[Vec<CaptureDetection>]) -> Vec<Detection> {
    let mut out = Vec::new();
    for &id in scene.objects() {
        let mut views: Vec<&CaptureDetection> = captures
            .iter()
            .flatten()
            .filter(|d| {
                d.id == id
                    && d.x_m.is_finite()
                    && d.y_m.is_finite()
                    && d.z_m.is_finite()
                    && d.confidence.is_finite()
                    && d.confidence > 0.0
            })
            .collect();
        if views.is_empty() {
            continue;
        }
        views.sort_by(|a, b| b.confidence.total_cmp(&a.confidence));
        let best = views[0];
        let inliers: Vec<&CaptureDetection> = views
            .iter()
            .copied()
            .filter(|d| (d.x_m - best.x_m).hypot(d.y_m - best.y_m) <= INLIER_RADIUS_M)
            .collect();
        let top = &inliers[..inliers.len().min(TOP_VIEWS)];
        let wsum: f32 = top.iter().map(|d| d.confidence).sum();
        let mean = |f: fn(&CaptureDetection) -> f32| {
            top.iter().map(|d| f(d) * d.confidence).sum::<f32>() / wsum
        };
        let (x, y, z) = (mean(|d| d.x_m), mean(|d| d.y_m), mean(|d| d.z_m));
        let coverage = (inliers.len() as f32 / 2.0).min(1.0);
        let confidence = (wsum / top.len() as f32 * (0.5 + 0.5 * coverage)).clamp(0.0, 1.0);
        let lidar_confirmed = if inliers.iter().any(|d| d.lidar_confirmed == Some(true)) {
            Some(true)
        } else if inliers.iter().any(|d| d.lidar_confirmed == Some(false)) {
            Some(false)
        } else {
            None
        };
        out.push(Detection {
            id: id.to_string(),
            label: object_label(id).to_string(),
            x_m: round_to(x, 4),
            y_m: round_to(y, 4),
            z_m: round_to(z, 4),
            bearing_deg: round_to(y.atan2(x).to_degrees(), 1),
            distance_m: round_to(x.hypot(y), 3),
            confidence: round_to(confidence, 3),
            views: inliers.len() as u32,
            method: best.method.clone(),
            lidar_confirmed,
            joint1_target: joint1_for_point(x, y),
        });
    }
    out
}

fn round_to(v: f32, decimals: i32) -> f32 {
    let k = 10f32.powi(decimals);
    (v * k).round() / k
}

/// Where a prop gesture should aim right now, from a fresh scan.
#[derive(Debug, Clone, PartialEq)]
pub struct AimTarget {
    pub joint1: u16,
    /// Prop position in the current base_link (the scan corrected by the odometry since).
    pub x_m: f32,
    pub y_m: f32,
    pub confidence: f32,
}

/// The measured aim for `object`, or why the gesture must use its fixed default
/// (`no_scan`, `running`, `aborted`, `moved`, `expired`, `not_found` or `low_confidence`).
pub fn aim_for(
    status: &mut ScanEnvStatus,
    object: &str,
    odom: &Pose2D,
    now_ms: u64,
) -> Result<AimTarget, &'static str> {
    status.refresh(odom, now_ms);
    if !status.fresh && status.stale_reason.as_deref() != Some("not_found") {
        return Err(match status.stale_reason.as_deref() {
            Some("running") => "running",
            Some("aborted") => "aborted",
            Some("moved") => "moved",
            Some("expired") => "expired",
            _ => "no_scan",
        });
    }
    let Some(d) = status.detections.iter().find(|d| d.id == object) else {
        return Err("not_found");
    };
    if d.confidence < MIN_AIM_CONFIDENCE {
        return Err("low_confidence");
    }
    let at = status.odom_at_scan.unwrap_or_default();
    let (wx, wy) = at.to_world(d.x_m, d.y_m);
    let (x, y) = odom.to_robot(wx, wy);
    Ok(AimTarget {
        joint1: joint1_for_point(x, y),
        x_m: x,
        y_m: y,
        confidence: d.confidence,
    })
}

/// Which target a prop gesture used, reported in the `/gesture` response (`aim`) and the log.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AimInfo {
    /// `measured` (fresh «Reconocer» scan) or `default` (the fixed side of the gesture).
    pub source: &'static str,
    pub object: String,
    pub joint1: u16,
    pub bearing_deg: Option<f32>,
    pub distance_m: Option<f32>,
    pub confidence: Option<f32>,
    /// Why the default was used (`null` when measured).
    pub reason: Option<&'static str>,
}

impl AimInfo {
    pub fn measured(object: &str, t: &AimTarget) -> Self {
        Self {
            source: "measured",
            object: object.to_string(),
            joint1: t.joint1,
            bearing_deg: Some(round_to(t.y_m.atan2(t.x_m).to_degrees(), 1)),
            distance_m: Some(round_to(t.x_m.hypot(t.y_m), 3)),
            confidence: Some(t.confidence),
            reason: None,
        }
    }

    pub fn default_side(object: &str, joint1: u16, reason: &'static str) -> Self {
        Self {
            source: "default",
            object: object.to_string(),
            joint1,
            bearing_deg: None,
            distance_m: None,
            confidence: None,
            reason: Some(reason),
        }
    }

    /// Short Spanish description for logs, HUD and Gemini.
    pub fn describe(&self) -> String {
        match (self.source, self.bearing_deg, self.distance_m) {
            ("measured", Some(b), Some(d)) => format!(
                "objetivo medido: {} a {:.0}° {} y {:.2} m (joint1={})",
                object_label(&self.object),
                b.abs(),
                if b >= 0.0 { "izq" } else { "der" },
                d,
                self.joint1
            ),
            _ => format!(
                "objetivo fijo: {} en su lado por defecto (joint1={}, sin reconocimiento válido: {})",
                object_label(&self.object),
                self.joint1,
                self.reason.unwrap_or("no_scan")
            ),
        }
    }
}

/// A prop of the simulated stage (mock backend), odometry/world frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SimObject {
    pub id: String,
    pub x_m: f32,
    pub y_m: f32,
}

/// The mock's stage. On purpose NOT the fixed layout of the gestures and the twin (APROBADO left,
/// RECHAZADO right; Cloud Run left, Gemini Live center, Firestore right): the trays are swapped
/// (APROBADO right, RECHAZADO left) and the totems shuffled (Gemini Live left, Firestore near the
/// center, Cloud Run right), so «Reconocer» visibly changes where the twin
/// draws them and where the gestures aim. `POST /simulate/scene` changes it.
pub fn default_sim_scene() -> Vec<SimObject> {
    let obj = |id: &str, x_m: f32, y_m: f32| SimObject {
        id: id.into(),
        x_m,
        y_m,
    };
    vec![
        obj("approve_tray", 0.22, -0.15),
        obj("reject_tray", 0.17, 0.20),
        obj("cloud_run", 0.36, -0.19),
        obj("gemini_live", 0.33, 0.21),
        obj("firestore", 0.39, 0.04),
    ]
}

/// What the mock camera sees with joint1 at `j1_pulse`: the props of `scene` within
/// ±`MOCK_HALF_FOV_DEG` of where the arm points and 8-90 cm from the joint1 axis, at their exact
/// positions, with a confidence that drops toward the edge of the image (like the real one).
pub fn mock_capture(
    scene: ScanScene,
    sim: &[SimObject],
    odom: &Pose2D,
    j1_pulse: u16,
) -> Vec<CaptureDetection> {
    let heading = joint1_heading_deg(j1_pulse);
    sim.iter()
        .filter(|o| scene.objects().contains(&o.id.as_str()))
        .filter_map(|o| {
            let (x, y) = odom.to_robot(o.x_m, o.y_m);
            let reach = (x - J1_AXIS_X_M).hypot(y);
            let off = wrap_deg(y.atan2(x - J1_AXIS_X_M).to_degrees() - heading);
            if off.abs() > MOCK_HALF_FOV_DEG || !(0.08..=0.90).contains(&reach) {
                return None;
            }
            Some(CaptureDetection {
                id: o.id.clone(),
                x_m: x,
                y_m: y,
                z_m: if is_tray(&o.id) { -0.025 } else { 0.055 },
                confidence: round_to(0.95 * (1.0 - 0.4 * off.abs() / 37.6), 3),
                method: "mock".into(),
                lidar_confirmed: None,
            })
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Native Rust vision + 3D camera/URDF projection (Aurora 930 Pro + 6-DOF arm)
// ---------------------------------------------------------------------------------------------

pub const RGB_SIZE: (u32, u32) = (640, 400);
pub const RGB_K: [f64; 4] = [415.853, 416.574, 322.145, 192.159]; // fx, fy, cx, cy
pub const RGB_D: [f64; 5] = [0.01089, -0.04936, -0.000637, -0.000128, 0.03041];
pub const DEPTH_SIZE: (u32, u32) = (640, 400);
pub const DEPTH_K: [f64; 4] = [423.027, 423.807, 319.225, 197.19];
pub const DEPTH_D: [f64; 5] = [0.06046, -0.10973, 0.000397, -0.000298, 0.05538];
pub const DEPTH_MIN_M: f64 = 0.30;
pub const DEPTH_MAX_M: f64 = 2.5;
pub const DEFAULT_FLOOR_Z_M: f64 = -0.025;
pub const LIDAR_ORIGIN_XY: (f64, f64) = (0.048_156, 0.000_075_5);
pub const PULSE_RAD: f64 = (240.0 * std::f64::consts::PI / 180.0) / 1000.0;

type Vec3 = [f64; 3];
type Mat3 = [[f64; 3]; 3];

/// ROSOrin Pro URDF joints 1..4: `(xyz, rpy, axis)` in `base_link` (x forward, z up).
pub const ARM_CHAIN_4: [(Vec3, Vec3, Vec3); 4] = [
    (
        [0.04662, 0.0000754, 0.16044],
        [0.0087266, 0.0, 0.0],
        [-0.0000545, -0.0087266, -0.99996],
    ),
    (
        [0.000012, 0.018766, 0.030345],
        [0.0, 0.0, 0.0],
        [0.0, 0.99996, -0.0087265],
    ),
    (
        [0.00025563, 0.00074282, 0.08513],
        [0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
    ),
    (
        [-0.00056892, 0.00074297, 0.085147],
        [0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
    ),
];
pub const CAMERA_CONNECT: (Vec3, Vec3) = (
    [-0.036369, -0.0181, 0.046638],
    [-1.5621, -1.5621, std::f64::consts::FRAC_PI_2],
);
pub const CAMERA_LINK: (Vec3, Vec3) = ([0.022511, -0.0010257, 0.0051917], [0.0, 0.0, 0.0]);

pub const SAMPLE_STRIDE: usize = 2;
pub const TOTEM_CLOSE_RADIUS: usize = 3;
pub const TRAY_CLOSE_RADIUS: usize = 5;
pub const MIN_BLOB_CELLS: usize = 18;
pub const TRAY_FULL_CONFIDENCE_CELLS: f32 = 140.0;
pub const TOTEM_FULL_CONFIDENCE_CELLS: f32 = 65.0;
pub const SIDE_PENALTY: f32 = 0.75;
pub const CENTERING_WEIGHT: f32 = 0.4;
pub const LIDAR_CONFIRM_HALF_ANGLE_DEG: f64 = 5.0;
pub const LIDAR_CONFIRM_TOLERANCE_M: f64 = 0.12;

/// Every printed prop (both Demo B trays and Demo C totems) is colored ink surrounded by a bright
/// white/pastel paper card (`S <= 0.18, V >= 0.65`). Requiring at least `MIN_PAPER_RATIO` of the
/// non-colored cells inside the padded bounding box to be paper eliminates false positives from
/// wood floors, curtains, furniture and window reflections in both Demo B and Demo C.
pub const PAPER_MAX_S: f32 = 0.18;
pub const PAPER_MIN_V: f32 = 0.65;
pub const PAPER_PAD_CELLS: usize = 6;
pub const MIN_PAPER_RATIO: f32 = 0.18;

#[derive(Debug, Clone, Copy)]
pub struct ColorSpec {
    pub name: &'static str,
    pub hues: &'static [(f32, f32)],
    pub min_s: f32,
    pub min_v: f32,
}

pub const COLOR_SPECS: [ColorSpec; 4] = [
    ColorSpec {
        name: "green",
        hues: &[(80.0, 178.0)],
        min_s: 0.13,
        min_v: 0.32,
    },
    ColorSpec {
        name: "red",
        hues: &[(335.0, 360.0), (0.0, 15.0)],
        min_s: 0.12,
        min_v: 0.42,
    },
    ColorSpec {
        name: "blue",
        hues: &[(195.0, 248.0)],
        min_s: 0.30,
        min_v: 0.30,
    },
    ColorSpec {
        name: "yellow",
        hues: &[(34.0, 65.0)],
        min_s: 0.24,
        min_v: 0.45,
    },
];

#[derive(Debug, Clone, Copy)]
struct PropSpec {
    id: &'static str,
    color: &'static str,
    is_tray: bool,
}

const GATEKEEPER_SPECS: [PropSpec; 2] = [
    PropSpec {
        id: "approve_tray",
        color: "green",
        is_tray: true,
    },
    PropSpec {
        id: "reject_tray",
        color: "red",
        is_tray: true,
    },
];

const BUGHUNTER_SPECS: [PropSpec; 3] = [
    PropSpec {
        id: "cloud_run",
        color: "blue",
        is_tray: false,
    },
    PropSpec {
        id: "gemini_live",
        color: "green",
        is_tray: false,
    },
    PropSpec {
        id: "firestore",
        color: "yellow",
        is_tray: false,
    },
];

fn scene_specs(scene: ScanScene) -> &'static [PropSpec] {
    match scene {
        ScanScene::Gatekeeper => &GATEKEEPER_SPECS,
        ScanScene::Bughunter => &BUGHUNTER_SPECS,
    }
}

pub fn floor_z_m() -> f64 {
    let extra = std::env::var("SCAN_ENV_PROPS_HEIGHT_M")
        .ok()
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.0);
    DEFAULT_FLOOR_Z_M + extra
}

/// Raw RGB or depth image buffer from the camera.
#[derive(Debug, Clone)]
pub struct RawImage {
    pub width: u32,
    pub height: u32,
    pub step: usize,
    pub encoding: String,
    pub is_bigendian: bool,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Blob {
    pub cells: usize,
    pub centroid: (f64, f64),
    pub bbox: (usize, usize, usize, usize),
    pub touches_side: bool,
    pub touches_bottom: bool,
    pub paper_ratio: f32,
}

fn mat_mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut out = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    out
}

fn mat_vec(a: &Mat3, v: Vec3) -> Vec3 {
    [
        a[0][0] * v[0] + a[0][1] * v[1] + a[0][2] * v[2],
        a[1][0] * v[0] + a[1][1] * v[1] + a[1][2] * v[2],
        a[2][0] * v[0] + a[2][1] * v[1] + a[2][2] * v[2],
    ]
}

fn rpy_matrix(roll: f64, pitch: f64, yaw: f64) -> Mat3 {
    let (sr, cr) = roll.sin_cos();
    let (sp, cp) = pitch.sin_cos();
    let (sy, cy) = yaw.sin_cos();
    let rx = [[1.0, 0.0, 0.0], [0.0, cr, -sr], [0.0, sr, cr]];
    let ry = [[cp, 0.0, sp], [0.0, 1.0, 0.0], [-sp, 0.0, cp]];
    let rz = [[cy, -sy, 0.0], [sy, cy, 0.0], [0.0, 0.0, 1.0]];
    mat_mul(&rz, &mat_mul(&ry, &rx))
}

fn axis_angle_matrix(axis: Vec3, angle: f64) -> Mat3 {
    let n = (axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2]).sqrt();
    let (x, y, z) = (axis[0] / n, axis[1] / n, axis[2] / n);
    let (s, c) = angle.sin_cos();
    let omc = 1.0 - c;
    [
        [c + x * x * omc, x * y * omc - z * s, x * z * omc + y * s],
        [y * x * omc + z * s, c + y * y * omc, y * z * omc - x * s],
        [z * x * omc - y * s, z * y * omc + x * s, c + z * z * omc],
    ]
}

fn joint_angle_rad(index: u8, pulse: u16) -> f64 {
    if (1..=4).contains(&index) {
        (500.0 - pulse as f64) * PULSE_RAD
    } else {
        (pulse as f64 - 500.0) * PULSE_RAD
    }
}

/// Pixel → normalized image coordinates `(x/z, y/z)`, inverting `plumb_bob` distortion iteratively.
pub fn undistort_pixel(u: f64, v: f64, k: &[f64; 4], d: &[f64; 5], iterations: usize) -> (f64, f64) {
    let [fx, fy, cx, cy] = *k;
    let [k1, k2, p1, p2, k3] = *d;
    let xd = (u - cx) / fx;
    let yd = (v - cy) / fy;
    let (mut x, mut y) = (xd, yd);
    for _ in 0..iterations {
        let r2 = x * x + y * y;
        let radial = 1.0 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
        let dx = 2.0 * p1 * x * y + p2 * (r2 + 2.0 * x * x);
        let dy = p1 * (r2 + 2.0 * y * y) + 2.0 * p2 * x * y;
        x = (xd - dx) / radial;
        y = (yd - dy) / radial;
    }
    (x, y)
}

/// Normalized coordinates → pixel with `plumb_bob` distortion.
pub fn distort_normalized(x: f64, y: f64, k: &[f64; 4], d: &[f64; 5]) -> (f64, f64) {
    let [fx, fy, cx, cy] = *k;
    let [k1, k2, p1, p2, k3] = *d;
    let r2 = x * x + y * y;
    let radial = 1.0 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2;
    let xd = x * radial + 2.0 * p1 * x * y + p2 * (r2 + 2.0 * x * x);
    let yd = y * radial + p1 * (r2 + 2.0 * y * y) + 2.0 * p2 * x * y;
    (fx * xd + cx, fy * yd + cy)
}

/// `camera_link` pose `(origin, rotation_3x3)` in `base_link` from joints 1..4 pulses.
pub fn camera_pose(servos: &BTreeMap<u8, u16>) -> (Vec3, Mat3) {
    let mut rot: Mat3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    let mut pos: Vec3 = [0.0, 0.0, 0.0];
    for (idx, &(xyz, rpy, axis)) in ARM_CHAIN_4.iter().enumerate() {
        let id = (idx + 1) as u8;
        let pulse = servos.get(&id).copied().unwrap_or(500);
        let d = mat_vec(&rot, xyz);
        pos = [pos[0] + d[0], pos[1] + d[1], pos[2] + d[2]];
        let step_rot = mat_mul(
            &rpy_matrix(rpy[0], rpy[1], rpy[2]),
            &axis_angle_matrix(axis, joint_angle_rad(id, pulse)),
        );
        rot = mat_mul(&rot, &step_rot);
    }
    for (xyz, rpy) in [CAMERA_CONNECT, CAMERA_LINK] {
        let d = mat_vec(&rot, xyz);
        pos = [pos[0] + d[0], pos[1] + d[1], pos[2] + d[2]];
        rot = mat_mul(&rot, &rpy_matrix(rpy[0], rpy[1], rpy[2]));
    }
    (pos, rot)
}

/// Optical frame (`z` forward, `x` right, `y` down) → `camera_link` (`x` forward, `y` left, `z` up) → `base_link`.
pub fn optical_to_base(rot: &Mat3, vec_optical: Vec3) -> Vec3 {
    let [xo, yo, zo] = vec_optical;
    mat_vec(rot, [zo, -xo, -yo])
}

/// `(origin, direction)` in `base_link` of the RGB ray through pixel `(u, v)`.
pub fn pixel_ray(u: f64, v: f64, servos: &BTreeMap<u8, u16>) -> (Vec3, Vec3) {
    let (origin, rot) = camera_pose(servos);
    let (x, y) = undistort_pixel(u, v, &RGB_K, &RGB_D, 8);
    (origin, optical_to_base(&rot, [x, y, 1.0]))
}

/// Point where the ray meets the horizontal plane `z = z_plane`, or `None` if parallel/behind.
pub fn intersect_plane_z(origin: Vec3, direction: Vec3, z_plane: f64) -> Option<Vec3> {
    if direction[2].abs() < 1e-6 {
        return None;
    }
    let t = (z_plane - origin[2]) / direction[2];
    if t <= 0.0 {
        return None;
    }
    Some([
        origin[0] + t * direction[0],
        origin[1] + t * direction[1],
        origin[2] + t * direction[2],
    ])
}

/// 3D point in `base_link` of RGB pixel `(u, v)` at `depth_m` along the optical axis.
pub fn pixel_depth_to_base(u: f64, v: f64, depth_m: f64, servos: &BTreeMap<u8, u16>) -> Vec3 {
    let (origin, rot) = camera_pose(servos);
    let (x, y) = undistort_pixel(u, v, &RGB_K, &RGB_D, 8);
    let d = optical_to_base(&rot, [x * depth_m, y * depth_m, depth_m]);
    [origin[0] + d[0], origin[1] + d[1], origin[2] + d[2]]
}

/// RGB pixel → depth pixel looking along the same ray.
pub fn rgb_to_depth_pixel(
    u: f64,
    v: f64,
    rgb_size: (u32, u32),
    depth_size: (u32, u32),
) -> (f64, f64) {
    let (x, y) = undistort_pixel(
        u * RGB_SIZE.0 as f64 / rgb_size.0 as f64,
        v * RGB_SIZE.1 as f64 / rgb_size.1 as f64,
        &RGB_K,
        &RGB_D,
        8,
    );
    let (ud, vd) = distort_normalized(x, y, &DEPTH_K, &DEPTH_D);
    (
        ud * depth_size.0 as f64 / DEPTH_SIZE.0 as f64,
        vd * depth_size.1 as f64 / DEPTH_SIZE.1 as f64,
    )
}

/// `0..=255` RGB → `(hue 0..360, saturation 0..1, value 0..1)`.
pub fn rgb_to_hsv(r: u8, g: u8, b: u8) -> (f32, f32, f32) {
    let mx = r.max(g).max(b);
    let mn = r.min(g).min(b);
    if mx == 0 {
        return (0.0, 0.0, 0.0);
    }
    let delta = (mx - mn) as f32;
    let s = delta / (mx as f32);
    let v = (mx as f32) / 255.0;
    if mx == mn {
        return (0.0, s, v);
    }
    let (rf, gf, bf) = (r as f32, g as f32, b as f32);
    let h = if mx == r {
        60.0 * (((gf - bf) / delta).rem_euclid(6.0))
    } else if mx == g {
        60.0 * ((bf - rf) / delta + 2.0)
    } else {
        60.0 * ((rf - gf) / delta + 4.0)
    };
    (h, s, v)
}

pub fn classify_color<'a>(h: f32, s: f32, v: f32, names: &[&'a str]) -> &'a str {
    for &name in names {
        let Some(spec) = COLOR_SPECS.iter().find(|c| c.name == name) else {
            continue;
        };
        if s < spec.min_s || v < spec.min_v {
            continue;
        }
        if spec.hues.iter().any(|&(lo, hi)| (lo..=hi).contains(&h)) {
            return name;
        }
    }
    ""
}

fn channel_order(encoding: &str) -> Option<((usize, usize, usize), usize)> {
    match encoding.trim().to_ascii_lowercase().as_str() {
        "rgb8" => Some(((0, 1, 2), 3)),
        "rgba8" => Some(((0, 1, 2), 4)),
        "" | "bgr8" => Some(((2, 1, 0), 3)),
        "bgra8" => Some(((2, 1, 0), 4)),
        _ => None,
    }
}

/// Subsamples `image` at `stride` and labels each cell with its matched color index (`1..=names.len()`,
/// `0` otherwise) plus a boolean paper-backdrop mask (`true` when `S <= PAPER_MAX_S && V >= PAPER_MIN_V`).
pub fn color_grid(
    image: &RawImage,
    names: &[&str],
    stride: usize,
) -> Option<(Vec<u8>, Vec<bool>, usize, usize)> {
    let ((ri, gi, bi), px) = channel_order(&image.encoding)?;
    let stride = stride.max(1);
    let w = image.width as usize;
    let h = image.height as usize;
    if w == 0 || h == 0 {
        return None;
    }
    let step = if image.step > 0 { image.step } else { w * px };
    let cols = w.div_ceil(stride);
    let rows = h.div_ceil(stride);
    let mut cells = vec![0u8; cols * rows];
    let mut paper = vec![false; cols * rows];
    for row in 0..rows {
        let base = row * stride * step;
        for col in 0..cols {
            let o = base + col * stride * px;
            if o + px > image.data.len() {
                continue;
            }
            let (hue, s, v) = rgb_to_hsv(image.data[o + ri], image.data[o + gi], image.data[o + bi]);
            let idx = row * cols + col;
            if s <= PAPER_MAX_S && v >= PAPER_MIN_V {
                paper[idx] = true;
            }
            let matched = classify_color(hue, s, v, names);
            if !matched.is_empty() {
                if let Some(pos) = names.iter().position(|&n| n == matched) {
                    cells[idx] = (pos + 1) as u8;
                }
            }
        }
    }
    Some((cells, paper, cols, rows))
}

fn dilate(mask: &[u8], cols: usize, rows: usize, radius: usize) -> Vec<u8> {
    if radius == 0 {
        return mask.to_vec();
    }
    let mut tmp = vec![0u8; mask.len()];
    for r in 0..rows {
        let off = r * cols;
        for c in 0..cols {
            if mask[off + c] != 0 {
                let lo = c.saturating_sub(radius);
                let hi = (c + radius + 1).min(cols);
                tmp[off + lo..off + hi].fill(1);
            }
        }
    }
    let mut out = vec![0u8; mask.len()];
    for r in 0..rows {
        let off = r * cols;
        let lo = r.saturating_sub(radius);
        let hi = (r + radius + 1).min(rows);
        for c in 0..cols {
            if tmp[off + c] != 0 {
                for rr in lo..hi {
                    out[rr * cols + c] = 1;
                }
            }
        }
    }
    out
}

fn compute_paper_ratio(
    cells: &[u8],
    paper: &[bool],
    cols: usize,
    rows: usize,
    color_index: u8,
    bbox: (usize, usize, usize, usize),
) -> f32 {
    let (c0, r0, c1, r1) = bbox;
    let c_lo = c0.saturating_sub(PAPER_PAD_CELLS);
    let c_hi = (c1 + PAPER_PAD_CELLS + 1).min(cols);
    let r_lo = r0.saturating_sub(PAPER_PAD_CELLS);
    let r_hi = (r1 + PAPER_PAD_CELLS + 1).min(rows);
    let mut non_self = 0usize;
    let mut paper_count = 0usize;
    for r in r_lo..r_hi {
        let off = r * cols;
        for c in c_lo..c_hi {
            let idx = off + c;
            if cells[idx] != color_index {
                non_self += 1;
                if paper[idx] {
                    paper_count += 1;
                }
            }
        }
    }
    if non_self == 0 {
        0.0
    } else {
        paper_count as f32 / non_self as f32
    }
}

/// Connected blobs of `color_index` after a square closing dilation of `radius`.
pub fn find_blobs(
    cells: &[u8],
    paper: &[bool],
    cols: usize,
    rows: usize,
    color_index: u8,
    radius: usize,
) -> Vec<Blob> {
    let mask: Vec<u8> = cells
        .iter()
        .map(|&v| u8::from(v == color_index))
        .collect();
    let grown = dilate(&mask, cols, rows, radius);
    let mut seen = vec![false; cells.len()];
    let mut blobs = Vec::new();
    let mut stack = Vec::new();
    for start in 0..cells.len() {
        if grown[start] == 0 || seen[start] {
            continue;
        }
        stack.push(start);
        seen[start] = true;
        let mut count = 0usize;
        let mut sx = 0usize;
        let mut sy = 0usize;
        let (mut c0, mut r0, mut c1, mut r1) = (cols, rows, 0usize, 0usize);
        while let Some(i) = stack.pop() {
            let (r, c) = (i / cols, i % cols);
            if mask[i] != 0 {
                count += 1;
                sx += c;
                sy += r;
                c0 = c0.min(c);
                r0 = r0.min(r);
                c1 = c1.max(c);
                r1 = r1.max(r);
            }
            let neighbors = [
                (c > 0).then(|| i - 1),
                (c + 1 < cols).then(|| i + 1),
                (r > 0).then(|| i - cols),
                (r + 1 < rows).then(|| i + cols),
            ];
            for next in neighbors.into_iter().flatten() {
                if grown[next] != 0 && !seen[next] {
                    seen[next] = true;
                    stack.push(next);
                }
            }
        }
        if count > 0 {
            let bbox = (c0, r0, c1, r1);
            let paper_ratio = compute_paper_ratio(cells, paper, cols, rows, color_index, bbox);
            blobs.push(Blob {
                cells: count,
                centroid: (sx as f64 / count as f64, sy as f64 / count as f64),
                bbox,
                touches_side: c0 == 0 || c1 + 1 == cols,
                touches_bottom: r1 + 1 == rows,
                paper_ratio,
            });
        }
    }
    blobs.sort_by_key(|a| std::cmp::Reverse(a.cells));
    blobs
}

/// Median depth (m) of valid pixels around `(u, v)` in a `mono16`/`16UC1` (mm) or `32FC1` (m) image.
pub fn depth_at(depth_image: &RawImage, u: f64, v: f64, half_window: i32) -> Option<f64> {
    let (w, h) = (depth_image.width as i32, depth_image.height as i32);
    let (cu, cv) = (u.round() as i32, v.round() as i32);
    if cu < 0 || cu >= w || cv < 0 || cv >= h {
        return None;
    }
    let enc = depth_image.encoding.trim().to_ascii_lowercase();
    let mut values = Vec::new();
    let y0 = (cv - half_window).max(0) as usize;
    let y1 = (cv + half_window + 1).min(h) as usize;
    let x0 = (cu - half_window).max(0) as usize;
    let x1 = (cu + half_window + 1).min(w) as usize;

    if enc.is_empty() || enc == "mono16" || enc == "16uc1" {
        let step = if depth_image.step > 0 {
            depth_image.step
        } else {
            depth_image.width as usize * 2
        };
        for y in y0..y1 {
            for x in x0..x1 {
                let o = y * step + x * 2;
                if o + 2 > depth_image.data.len() {
                    continue;
                }
                let mm = if depth_image.is_bigendian {
                    u16::from_be_bytes([depth_image.data[o], depth_image.data[o + 1]])
                } else {
                    u16::from_le_bytes([depth_image.data[o], depth_image.data[o + 1]])
                };
                if mm > 0 {
                    let m = mm as f64 / 1000.0;
                    if (DEPTH_MIN_M..=DEPTH_MAX_M).contains(&m) {
                        values.push(m);
                    }
                }
            }
        }
    } else if enc == "32fc1" {
        let step = if depth_image.step > 0 {
            depth_image.step
        } else {
            depth_image.width as usize * 4
        };
        for y in y0..y1 {
            for x in x0..x1 {
                let o = y * step + x * 4;
                if o + 4 > depth_image.data.len() {
                    continue;
                }
                let bytes = [
                    depth_image.data[o],
                    depth_image.data[o + 1],
                    depth_image.data[o + 2],
                    depth_image.data[o + 3],
                ];
                let m = if depth_image.is_bigendian {
                    f32::from_be_bytes(bytes) as f64
                } else {
                    f32::from_le_bytes(bytes) as f64
                };
                if m.is_finite() && (DEPTH_MIN_M..=DEPTH_MAX_M).contains(&m) {
                    values.push(m);
                }
            }
        }
    } else {
        return None;
    }

    if values.len() < 3 {
        return None;
    }
    values.sort_by(|a, b| a.total_cmp(b));
    Some(values[values.len() / 2])
}

/// Checks whether the LiDAR scan has an echo near `(x, y)` in `base_link`.
pub fn lidar_confirms(lidar: Option<&[(f64, f64)]>, x: f64, y: f64) -> Option<bool> {
    let rays = lidar?;
    if rays.is_empty() {
        return None;
    }
    let (dx, dy) = (x - LIDAR_ORIGIN_XY.0, y - LIDAR_ORIGIN_XY.1);
    let expected = dx.hypot(dy);
    let target = dy.atan2(dx);
    let half = LIDAR_CONFIRM_HALF_ANGLE_DEG.to_radians();
    let mut in_cone = Vec::new();
    for &(a, r) in rays {
        let diff = (a - target).sin().atan2((a - target).cos()).abs();
        if diff <= half {
            in_cone.push(r);
        }
    }
    if in_cone.is_empty() {
        return None;
    }
    Some(
        in_cone
            .into_iter()
            .any(|r| r.is_finite() && (r - expected).abs() <= LIDAR_CONFIRM_TOLERANCE_M),
    )
}

/// Finds the props of `scene` in one RGB frame (plus optional depth frame and LiDAR rays) taken with
/// the arm at `servos`. Rejects any color blob that is not backed by white/pastel paper
/// (`paper_ratio >= MIN_PAPER_RATIO`).
pub fn detect_objects(
    scene: ScanScene,
    rgb: &RawImage,
    servos: &BTreeMap<u8, u16>,
    depth: Option<&RawImage>,
    lidar: Option<&[(f64, f64)]>,
    stride: usize,
) -> Option<Vec<CaptureDetection>> {
    let specs = scene_specs(scene);
    let mut names: Vec<&str> = Vec::new();
    for spec in specs {
        if !names.contains(&spec.color) {
            names.push(spec.color);
        }
    }
    let stride = stride.max(1);
    let (cells, paper, cols, rows) = color_grid(rgb, &names, stride)?;
    let sx = stride as f64;
    let sy = stride as f64;
    let floor_z = floor_z_m();
    let mut out = Vec::new();

    for spec in specs {
        let color_idx = (names.iter().position(|&n| n == spec.color)? + 1) as u8;
        let radius = if spec.is_tray {
            TRAY_CLOSE_RADIUS
        } else {
            TOTEM_CLOSE_RADIUS
        };
        let blobs = find_blobs(&cells, &paper, cols, rows, color_idx, radius);
        let Some(blob) = blobs
            .into_iter()
            .find(|b| b.cells >= MIN_BLOB_CELLS && b.paper_ratio >= MIN_PAPER_RATIO)
        else {
            continue;
        };
        let (cu, cv) = if spec.is_tray {
            let (c0, r0, c1, r1) = blob.bbox;
            ((c0 + c1) as f64 / 2.0, (r0 + r1) as f64 / 2.0)
        } else {
            blob.centroid
        };
        let (u, v) = (cu * sx + sx / 2.0, cv * sy + sy / 2.0);
        let mut point = None;
        let mut method = "plane";
        if let Some(d_img) = depth {
            let (du, dv) = rgb_to_depth_pixel(u, v, (rgb.width, rgb.height), (d_img.width, d_img.height));
            if let Some(z) = depth_at(d_img, du, dv, 4) {
                point = Some(pixel_depth_to_base(
                    u * RGB_SIZE.0 as f64 / rgb.width as f64,
                    v * RGB_SIZE.1 as f64 / rgb.height as f64,
                    z,
                    servos,
                ));
                method = "depth";
            }
        }
        if point.is_none() {
            let (origin, direction) = pixel_ray(
                u * RGB_SIZE.0 as f64 / rgb.width as f64,
                v * RGB_SIZE.1 as f64 / rgb.height as f64,
                servos,
            );
            let plane = if spec.is_tray {
                floor_z
            } else {
                floor_z + 0.08
            };
            point = intersect_plane_z(origin, direction, plane);
        }
        let Some(pt) = point else {
            continue;
        };
        let full_cells = if spec.is_tray {
            TRAY_FULL_CONFIDENCE_CELLS
        } else {
            TOTEM_FULL_CONFIDENCE_CELLS
        };
        let mut confidence = 0.35 + 0.65 * (blob.cells as f32 / full_cells).min(1.0);
        if blob.touches_side {
            confidence *= SIDE_PENALTY;
        }
        let half_w = (rgb.width as f32) / 2.0;
        if half_w > 0.0 {
            confidence *= 1.0 - CENTERING_WEIGHT * ((u as f32 - half_w).abs() / half_w).min(1.0);
        }
        let confirmed = if !spec.is_tray {
            lidar_confirms(lidar, pt[0], pt[1])
        } else {
            None
        };
        if confirmed == Some(true) {
            confidence = (confidence + 0.1).min(1.0);
        }
        out.push(CaptureDetection {
            id: spec.id.to_string(),
            x_m: round_to(pt[0] as f32, 4),
            y_m: round_to(pt[1] as f32, 4),
            z_m: round_to(pt[2] as f32, 4),
            confidence: round_to(confidence, 3),
            method: method.to_string(),
            lidar_confirmed: confirmed,
        });
    }
    Some(out)
}

fn unpack_raw_image(v: &serde_json::Value) -> Option<RawImage> {
    use base64::Engine as _;
    let width = v.get("width")?.as_u64()? as u32;
    let height = v.get("height")?.as_u64()? as u32;
    let step = v.get("step").and_then(|n| n.as_u64()).unwrap_or(0) as usize;
    let encoding = v
        .get("encoding")
        .and_then(|s| s.as_str())
        .unwrap_or("bgr8")
        .to_string();
    let is_bigendian = v
        .get("is_bigendian")
        .and_then(|b| b.as_bool())
        .unwrap_or(false);
    let b64 = v.get("b64")?.as_str()?;
    let data = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
    Some(RawImage {
        width,
        height,
        step,
        encoding,
        is_bigendian,
        data,
    })
}

/// Decodes a worker `scan_env_result` JSON payload containing a raw `"rgb"` frame and runs
/// [`detect_objects`] natively in Rust.
pub fn detect_from_worker_json(v: &serde_json::Value) -> Option<Vec<CaptureDetection>> {
    let scene_str = v.get("scene")?.as_str()?;
    let scene = match scene_str {
        "gatekeeper" => ScanScene::Gatekeeper,
        "bughunter" => ScanScene::Bughunter,
        _ => return None,
    };
    let rgb = unpack_raw_image(v.get("rgb")?)?;
    let depth = v.get("depth_frame").and_then(unpack_raw_image);
    let mut servos = BTreeMap::new();
    if let Some(obj) = v.get("servos").and_then(|s| s.as_object()) {
        for (k, val) in obj {
            if let (Ok(id), Some(pos)) = (k.parse::<u8>(), val.as_u64()) {
                servos.insert(id, pos as u16);
            }
        }
    }
    let lidar: Option<Vec<(f64, f64)>> = v
        .get("lidar")
        .and_then(|l| l.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|pair| {
                    let p = pair.as_array()?;
                    let a = p.first()?.as_f64()?;
                    let r = p.get(1).and_then(|x| x.as_f64()).unwrap_or(f64::INFINITY);
                    Some((a, r))
                })
                .collect()
        });
    let stride = v
        .get("stride")
        .and_then(|n| n.as_u64())
        .map(|n| n as usize)
        .unwrap_or(SAMPLE_STRIDE);
    detect_objects(scene, &rgb, &servos, depth.as_ref(), lidar.as_deref(), stride)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cap(id: &str, x: f32, y: f32, c: f32) -> CaptureDetection {
        CaptureDetection {
            id: id.into(),
            x_m: x,
            y_m: y,
            z_m: 0.0,
            confidence: c,
            method: "plane".into(),
            lidar_confirmed: None,
        }
    }

    #[test]
    fn test_sweep_is_monotonic_inside_limits() {
        let p = sweep_positions();
        assert_eq!(p.len(), SCAN_STEPS);
        assert_eq!(p[0], SCAN_J1_MIN);
        assert_eq!(*p.last().unwrap(), SCAN_J1_MAX);
        assert!(p.windows(2).all(|w| w[1] > w[0] && w[1] - w[0] <= 50));
        assert!(p.iter().all(|&j| clamp_servo_pulse(1, j) == j));
        for (id, pos) in SURVEY_POSE.iter().chain(HOME_POSE.iter()) {
            assert_eq!(clamp_servo_pulse(*id, *pos), *pos);
        }
    }

    #[test]
    fn test_joint1_mapping_matches_the_twin_and_clamps() {
        assert_eq!(joint1_for_point(0.5, 0.0), 500);
        // 48° left of the joint1 axis = 700 (the fixed APROBADO side), right = 300
        let y = (0.3 - J1_AXIS_X_M) * 48f32.to_radians().tan();
        assert_eq!(joint1_for_point(0.3, y), 700);
        assert_eq!(joint1_for_point(0.3, -y), 300);
        assert_eq!(joint1_for_point(-0.5, 0.01), AIM_J1_MAX);
        assert_eq!(joint1_for_point(-0.5, -0.01), AIM_J1_MIN);
        assert_eq!(joint1_heading_deg(700), 48.0);
    }

    #[test]
    fn test_aggregate_prefers_best_views_and_drops_outliers() {
        let captures = vec![
            vec![cap("approve_tray", 0.21, -0.15, 0.6)],
            vec![
                cap("approve_tray", 0.22, -0.15, 0.95),
                cap("cloud_run", 1.0, 1.0, 0.9),
            ],
            vec![cap("approve_tray", 0.23, -0.15, 0.9)],
            vec![cap("approve_tray", 0.60, 0.40, 0.5)], // outlier
            vec![],
        ];
        let out = aggregate(ScanScene::Gatekeeper, &captures);
        assert_eq!(
            out.len(),
            1,
            "cloud_run is not part of the gatekeeper scene"
        );
        let d = &out[0];
        assert_eq!(d.id, "approve_tray");
        assert_eq!(d.views, 3);
        assert!((d.x_m - 0.2212).abs() < 0.001, "{}", d.x_m);
        assert!((d.y_m + 0.15).abs() < 1e-4);
        assert!(d.bearing_deg < 0.0, "right of the robot");
        assert!(d.joint1_target < 500);
        assert!((d.confidence - 0.817).abs() < 0.002, "{}", d.confidence);
        // A single view counts half
        let lone = aggregate(
            ScanScene::Gatekeeper,
            &[vec![cap("reject_tray", 0.2, 0.2, 0.8)]],
        );
        assert!((lone[0].confidence - 0.6).abs() < 1e-3);
        // Garbage is ignored
        let nan = aggregate(
            ScanScene::Gatekeeper,
            &[vec![cap("reject_tray", f32::NAN, 0.2, 0.8)]],
        );
        assert!(nan.is_empty());
    }

    #[test]
    fn test_mock_capture_sees_only_what_the_camera_points_at() {
        let sim = default_sim_scene();
        let home = Pose2D::default();
        // approve_tray at (0.22, -0.15): to the right
        let right = mock_capture(ScanScene::Gatekeeper, &sim, &home, 300);
        assert!(right.iter().any(|d| d.id == "approve_tray"));
        assert!(right.iter().all(|d| d.id != "reject_tray"));
        let left = mock_capture(ScanScene::Gatekeeper, &sim, &home, 720);
        assert!(left.iter().any(|d| d.id == "reject_tray"));
        assert!(left.iter().all(|d| d.id != "approve_tray"));
        // Totems are not seen in the gatekeeper scene
        assert!(right
            .iter()
            .chain(left.iter())
            .all(|d| d.id.ends_with("_tray")));
        // The whole sweep finds every prop of the scene
        let sweep: Vec<_> = sweep_positions()
            .into_iter()
            .map(|j| mock_capture(ScanScene::Bughunter, &sim, &home, j))
            .collect();
        let found = aggregate(ScanScene::Bughunter, &sweep);
        assert_eq!(found.len(), 3);
        for d in &found {
            let o = sim.iter().find(|o| o.id == d.id).unwrap();
            assert!((d.x_m - o.x_m).abs() < 1e-3 && (d.y_m - o.y_m).abs() < 1e-3);
            assert!(d.confidence > 0.8);
        }
        // With the robot moved, positions come back in its own frame
        let moved = Pose2D {
            x_m: 0.1,
            y_m: 0.0,
            yaw_rad: 0.0,
        };
        let d = mock_capture(ScanScene::Bughunter, &sim, &moved, 500);
        let fs = d.iter().find(|d| d.id == "firestore").unwrap();
        assert!((fs.x_m - 0.29).abs() < 1e-4);
    }

    fn done_status(dets: Vec<Detection>) -> ScanEnvStatus {
        ScanEnvStatus {
            state: ScanState::Done,
            scene: Some(ScanScene::Gatekeeper),
            finished_at_ms: Some(1_000),
            detections: dets,
            odom_at_scan: Some(Pose2D::default()),
            ..Default::default()
        }
    }

    #[test]
    fn test_freshness_and_aim() {
        let dets = aggregate(
            ScanScene::Gatekeeper,
            &[
                vec![cap("approve_tray", 0.22, -0.15, 0.9)],
                vec![
                    cap("approve_tray", 0.22, -0.15, 0.9),
                    cap("reject_tray", 0.2, 0.2, 0.2),
                ],
            ],
        );
        let mut st = done_status(dets);
        let here = Pose2D::default();
        let t = aim_for(&mut st, "approve_tray", &here, 2_000).unwrap();
        assert!(st.fresh);
        assert!(t.joint1 < 400, "{}", t.joint1);
        assert_eq!(t.joint1, joint1_for_point(0.22, -0.15));
        assert_eq!(
            aim_for(&mut st, "reject_tray", &here, 2_000),
            Err("low_confidence")
        );
        assert_eq!(
            aim_for(&mut st, "cloud_run", &here, 2_000),
            Err("not_found")
        );
        // A small odometry drift is corrected, not rejected
        let drift = Pose2D {
            x_m: 0.02,
            y_m: 0.0,
            yaw_rad: 0.0,
        };
        let t2 = aim_for(&mut st, "approve_tray", &drift, 2_000).unwrap();
        assert!((t2.x_m - 0.20).abs() < 1e-4);
        // Expired
        assert_eq!(
            aim_for(&mut st, "approve_tray", &here, 1_000 + SCENE_MAX_AGE_MS + 1),
            Err("expired")
        );
        // Moved: sticky even if the robot comes back
        let far = Pose2D {
            x_m: 0.20,
            y_m: 0.0,
            yaw_rad: 0.0,
        };
        assert_eq!(aim_for(&mut st, "approve_tray", &far, 2_000), Err("moved"));
        assert_eq!(aim_for(&mut st, "approve_tray", &here, 2_000), Err("moved"));
        assert_eq!(st.stale_reason.as_deref(), Some("moved"));
        // No scan / running / aborted
        let mut idle = ScanEnvStatus::default();
        assert_eq!(aim_for(&mut idle, "approve_tray", &here, 0), Err("no_scan"));
        let mut running = ScanEnvStatus::running(ScanScene::Gatekeeper, 0);
        assert_eq!(
            aim_for(&mut running, "approve_tray", &here, 0),
            Err("running")
        );
        running.state = ScanState::Aborted;
        assert_eq!(
            aim_for(&mut running, "approve_tray", &here, 0),
            Err("aborted")
        );
    }

    #[test]
    fn test_odometry_reset_keeps_a_scan_only_if_the_robot_did_not_move() {
        let one = vec![cap("approve_tray", 0.22, -0.15, 0.9)];
        let det = aggregate(ScanScene::Gatekeeper, &[one.clone(), one]);
        let mut st = done_status(det);
        st.odom_at_scan = Some(Pose2D {
            x_m: 0.3,
            y_m: 0.1,
            yaw_rad: 0.2,
        });
        st.on_odometry_reset(&Pose2D {
            x_m: 0.3,
            y_m: 0.1,
            yaw_rad: 0.2,
        });
        assert_eq!(st.odom_at_scan, Some(Pose2D::default()));
        assert!(aim_for(&mut st, "approve_tray", &Pose2D::default(), 2_000).is_ok());
        st.on_odometry_reset(&Pose2D {
            x_m: 0.25,
            y_m: 0.0,
            yaw_rad: 0.0,
        });
        assert_eq!(
            aim_for(&mut st, "approve_tray", &Pose2D::default(), 2_000),
            Err("moved")
        );
    }

    #[test]
    fn test_pose_transforms_round_trip() {
        let p = Pose2D {
            x_m: 0.4,
            y_m: -0.2,
            yaw_rad: 0.7,
        };
        let (wx, wy) = p.to_world(0.3, 0.1);
        let (x, y) = p.to_robot(wx, wy);
        assert!((x - 0.3).abs() < 1e-5 && (y - 0.1).abs() < 1e-5);
    }

    #[test]
    fn test_aim_info_describes_both_sources() {
        let t = AimTarget {
            joint1: 320,
            x_m: 0.22,
            y_m: -0.15,
            confidence: 0.9,
        };
        let m = AimInfo::measured("approve_tray", &t);
        assert_eq!(m.source, "measured");
        assert!(m.describe().contains("der"));
        let d = AimInfo::default_side("approve_tray", 700, "no_scan");
        assert!(d.describe().contains("objetivo fijo"));
        assert!(is_known_object("firestore") && !is_known_object("lamp"));
    }

    fn survey_servos(j1: u16) -> BTreeMap<u8, u16> {
        let mut m = BTreeMap::new();
        m.insert(1, j1);
        for &(id, pos) in &SURVEY_POSE {
            m.insert(id, pos);
        }
        m
    }

    fn project_point(point: Vec3, servos: &BTreeMap<u8, u16>) -> ((f64, f64), f64) {
        let (origin, rot) = camera_pose(servos);
        let d = [
            point[0] - origin[0],
            point[1] - origin[1],
            point[2] - origin[2],
        ];
        let cx = d[0] * rot[0][0] + d[1] * rot[1][0] + d[2] * rot[2][0];
        let cy = d[0] * rot[0][1] + d[1] * rot[1][1] + d[2] * rot[2][1];
        let cz = d[0] * rot[0][2] + d[1] * rot[1][2] + d[2] * rot[2][2];
        let (xo, yo, zo) = (-cy, -cz, cx);
        (distort_normalized(xo / zo, yo / zo, &RGB_K, &RGB_D), zo)
    }

    fn blank_raw_image(width: u32, height: u32, bgr: [u8; 3]) -> RawImage {
        let mut data = Vec::with_capacity((width * height * 3) as usize);
        for _ in 0..(width * height) {
            data.extend_from_slice(&bgr);
        }
        RawImage {
            width,
            height,
            step: (width * 3) as usize,
            encoding: "bgr8".into(),
            is_bigendian: false,
            data,
        }
    }

    fn paint_box(img: &mut RawImage, u0: u32, v0: u32, u1: u32, v1: u32, bgr: [u8; 3]) {
        for v in v0.min(img.height)..v1.min(img.height) {
            for u in u0.min(img.width)..u1.min(img.width) {
                let o = (v as usize) * img.step + (u as usize) * 3;
                img.data[o..o + 3].copy_from_slice(&bgr);
            }
        }
    }

    #[test]
    fn test_rust_camera_geometry_and_floor_projection() {
        for (u, v) in [(10.0, 10.0), (320.0, 200.0), (600.0, 380.0)] {
            let (x, y) = undistort_pixel(u, v, &RGB_K, &RGB_D, 8);
            let (uu, vv) = distort_normalized(x, y, &RGB_K, &RGB_D);
            assert!((uu - u).abs() < 1e-3 && (vv - v).abs() < 1e-3);
        }
        let servos = survey_servos(720);
        let target = [0.18, 0.19, DEFAULT_FLOOR_Z_M];
        let ((u, v), _) = project_point(target, &servos);
        let (origin, dir) = pixel_ray(u, v, &servos);
        let hit = intersect_plane_z(origin, dir, DEFAULT_FLOOR_Z_M).unwrap();
        for (a, b) in hit.iter().zip(target.iter()) {
            assert!((a - b).abs() < 1e-4);
        }
    }

    #[test]
    fn test_rust_vision_rejects_wood_floor_reflection_and_finds_real_tray_and_totems() {
        let servos = survey_servos(720);
        // Background is warm reddish-brown wood floor (R=130, G=95, B=70 -> BGR=[70, 95, 130])
        let mut img = blank_raw_image(640, 400, [70, 95, 130]);
        // 1) A huge false-positive orange-red curtain reflection directly on the wood floor
        // (R=112, G=70, B=65 -> Hue ~6°, S=0.42, V=0.44, NO white paper around it):
        paint_box(&mut img, 40, 60, 220, 220, [65, 70, 112]);
        assert!(
            detect_objects(ScanScene::Gatekeeper, &img, &servos, None, None, 2)
                .unwrap()
                .is_empty(),
            "curtain reflection on wood floor without white paper backdrop must be rejected"
        );

        // 2) Now place the real printed RECHAZADO tray (white paper card + red border/title)
        let ((u, v), _) = project_point([0.24, 0.22, DEFAULT_FLOOR_Z_M], &servos);
        let (cu, cv) = (u as u32, v as u32);
        paint_box(&mut img, cu - 45, cv - 35, cu + 45, cv + 35, [242, 242, 245]); // white paper card
        paint_box(&mut img, cu - 30, cv - 20, cu + 30, cv + 20, [0x25, 0x30, 0xD9]); // red ink #D93025
        let found = detect_objects(ScanScene::Gatekeeper, &img, &servos, None, None, 2).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "reject_tray");
        assert!((found[0].x_m - 0.24).abs() < 0.03);
        assert!((found[0].y_m - 0.22).abs() < 0.03);
    }
}
