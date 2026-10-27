//! «Reconocer»: the arm-only sweep that measures where the Demo B trays and the Demo C totems are.
//!
//! The wheels never move. The arm goes to a survey pose that looks down at the table (the Aurora 930
//! camera is on the gripper), joint1 sweeps slowly from right to left in `SCAN_STEPS` pauses and
//! the arm returns home. At each pause the camera is asked for a capture: `ros2_worker.py` answers
//! with the props it sees (scan_env.py), the mock with the simulated scene. The views are merged in
//! [`aggregate`] and kept in memory (`TelemetryState::scan_env`) until the bridge restarts, the robot
//! moves or they expire; the prop gestures then aim joint1 at them ([`aim_for`]).
//!
//! The sweep runs through the same gate as every other motion: STOP (E-stop), any other motion
//! command or a dead worker aborts it, and every pulse goes through `clamp_servo_pulse`.

use crate::protocol::clamp_servo_pulse;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Pauses of the sweep (one capture each).
pub const SCAN_STEPS: usize = 11;
/// joint1 range of the sweep (right → left). ±53° around the front; the camera adds ±37° of view.
pub const SCAN_J1_MIN: u16 = 280;
pub const SCAN_J1_MAX: u16 = 720;
/// Survey pose for servos 2-4: camera ~30 cm above the table, pitched ~54° down, arm skeleton
/// ≥ 8 cm above the LiDAR scan plane and in front of the turret (URDF forward kinematics, see
/// scripts/test_scan_env.py). Close to the first step of `facepalm` (520, 200, 220). Servos 5
/// and 10 are never sent: the gripper keeps whatever it holds.
pub const SURVEY_POSE: [(u8, u16); 3] = [(2, 520), (3, 200), (4, 180)];
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
/// RECHAZADO right; Cloud Run left, Gemini Live center, Firestore right): the trays are swapped and
/// turned toward the front, and the totems shuffled, so «Reconocer» visibly changes where the twin
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
}
