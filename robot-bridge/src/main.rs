mod backend;
mod gestures;
mod protocol;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Request, State,
    },
    http::{header, HeaderMap, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use backend::{BackendConfig, MotionError, RobotController, TelemetryState, ESTOP_MESSAGE};
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use gestures::{get_gesture, is_known_gesture};
use protocol::{is_valid_servo_id, ServoTarget};
use serde::{Deserialize, Serialize};
use std::{
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{broadcast, mpsc};
use tokio::time::MissedTickBehavior;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::{error, info, warn};

/// Max size of a single WebSocket message/frame from a client.
const WS_MAX_MESSAGE_BYTES: usize = 64 * 1024;
/// Global token bucket for POST requests (except `/stop` and `/estop/release`) and WS motion ops.
const RATE_LIMIT_PER_SEC: f64 = 30.0;
const RATE_LIMIT_BURST: f64 = 60.0;
/// Jog deltas outside ±MAX_JOG_DELTA are rejected with 400.
const MAX_JOG_DELTA: i16 = 300;
/// Hostnames allowed as `Origin` besides loopback/private IP literals and `BRIDGE_ALLOWED_ORIGINS`.
const BUILTIN_ORIGIN_HOSTS: [&str; 3] = [
    "localhost",
    "jsconfmx26.web.app",
    "jsconfmx26.firebaseapp.com",
];

#[derive(Parser, Debug, Clone)]
#[command(
    name = "rosorin-bridge",
    about = "Hiwonder ROSOrin Pro Rust Bridge for Gemini Live JS"
)]
struct Args {
    /// Bind address. Anything other than loopback requires BRIDGE_TOKEN (or --insecure-no-token)
    #[arg(long, env = "BRIDGE_HOST", default_value = "127.0.0.1")]
    host: String,

    #[arg(short = 'p', long, env = "BRIDGE_PORT", default_value_t = 9000)]
    port: u16,

    /// Backend driver: `mock`, `serial` (/dev/rrc 1Mbps), or `ros2` (rclpy worker)
    #[arg(long, env = "ROBOT_BACKEND", default_value = "mock")]
    backend: String,

    #[arg(long, env = "SERIAL_PORT", default_value = "/dev/rrc")]
    serial_port: String,

    #[arg(long, env = "SERIAL_BAUD", default_value_t = 1_000_000)]
    baud: u32,

    /// Dead-man's switch timeout in milliseconds for `/cmd_vel`
    #[arg(long, env = "CMD_VEL_WATCHDOG_MS", default_value_t = 600)]
    watchdog_ms: u64,

    /// Shared secret (`Authorization: Bearer <token>` / `x-bridge-token`; `?token=` only on /ws)
    #[arg(long, env = "BRIDGE_TOKEN", default_value = "", hide_env_values = true)]
    token: String,

    /// Allow binding a non-loopback host without BRIDGE_TOKEN (anyone on the network can move the robot)
    #[arg(long)]
    insecure_no_token: bool,

    /// If the requested `serial`/`ros2` backend fails, fall back to mock instead of exiting
    #[arg(long)]
    allow_mock_fallback: bool,

    /// Path to ros2_worker.py (default: next to the crate manifest / executable, never the cwd)
    #[arg(long, env = "ROS2_WORKER_PATH", default_value = "")]
    worker_path: String,

    /// Extra exact origins allowed for CORS/WS, comma separated (e.g. `https://demo.example.com`)
    #[arg(long, env = "BRIDGE_ALLOWED_ORIGINS", default_value = "")]
    allowed_origins: String,

    /// Extra hostnames accepted in the `Host` header, comma separated (e.g. `rosorin.local`)
    #[arg(long, env = "BRIDGE_ALLOWED_HOSTS", default_value = "")]
    allowed_hosts: String,
}

#[derive(Debug, Default)]
struct SecurityConfig {
    token: Option<String>,
    /// Normalized (lowercase, no trailing `/`) exact origins.
    allowed_origins: Vec<String>,
    /// Normalized (lowercase) hostnames.
    allowed_hosts: Vec<String>,
}

/// Simple global token bucket.
struct RateLimiter {
    bucket: Mutex<(f64, Instant)>,
    rate_per_sec: f64,
    burst: f64,
}

impl RateLimiter {
    fn new(rate_per_sec: f64, burst: f64) -> Self {
        Self {
            bucket: Mutex::new((burst, Instant::now())),
            rate_per_sec,
            burst,
        }
    }

    fn try_acquire(&self) -> bool {
        let mut guard = self.bucket.lock().unwrap_or_else(|p| p.into_inner());
        let now = Instant::now();
        let refill = now.duration_since(guard.1).as_secs_f64() * self.rate_per_sec;
        guard.0 = (guard.0 + refill).min(self.burst);
        guard.1 = now;
        if guard.0 >= 1.0 {
            guard.0 -= 1.0;
            true
        } else {
            false
        }
    }
}

#[derive(Clone)]
struct AppState {
    robot: Arc<RobotController>,
    tx: broadcast::Sender<TelemetryState>,
    security: Arc<SecurityConfig>,
    limiter: Arc<RateLimiter>,
}

#[derive(Debug, Deserialize)]
struct CmdVelRequest {
    #[serde(default)]
    linear_x: f32,
    #[serde(default)]
    linear_y: f32,
    #[serde(default)]
    angular_z: f32,
    duration_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ArmRequest {
    #[serde(default = "default_duration_ms")]
    duration_ms: u16,
    servos: Vec<ServoTarget>,
}

fn default_duration_ms() -> u16 {
    500
}

#[derive(Debug, Deserialize)]
struct GestureRequest {
    name: String,
    mood: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RgbRequest {
    r: u8,
    g: u8,
    b: u8,
}

#[derive(Debug, Deserialize)]
struct BuzzerRequest {
    #[serde(default = "default_freq")]
    freq_hz: u16,
    #[serde(default = "default_on_ms")]
    on_ms: u16,
    #[serde(default = "default_off_ms")]
    off_ms: u16,
    #[serde(default = "default_repeat")]
    repeat: u16,
}

fn default_freq() -> u16 {
    1900
}
fn default_on_ms() -> u16 {
    150
}
fn default_off_ms() -> u16 {
    50
}
fn default_repeat() -> u16 {
    1
}

#[derive(Debug, Deserialize)]
struct LidarSimRequest {
    front_m: f32,
    left_m: Option<f32>,
    right_m: Option<f32>,
    back_m: Option<f32>,
}

#[derive(Debug, Deserialize)]
struct ServoJogRequest {
    id: u8,
    delta: i16,
}

#[derive(Debug, Deserialize)]
struct HudUpdateRequest {
    speaking: Option<bool>,
    listening: Option<bool>,
    headline: Option<String>,
    subtext: Option<String>,
    mood: Option<String>,
}

#[derive(Debug, Serialize)]
struct ActionResponse {
    status: &'static str,
    action: String,
    telemetry: TelemetryState,
}

/// Boxed error response (keeps `Result` small for clippy::result_large_err).
struct ApiError(Box<Response>);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        *self.0
    }
}

impl From<Response> for ApiError {
    fn from(resp: Response) -> Self {
        ApiError(Box::new(resp))
    }
}

type ApiResult = Result<Json<ActionResponse>, ApiError>;

fn json_error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(serde_json::json!({ "status": code, "message": message })),
    )
        .into_response()
}

fn motion_error_response(err: MotionError) -> ApiError {
    ApiError::from(match err {
        MotionError::EstopLatched => json_error(StatusCode::LOCKED, "estop_latched", ESTOP_MESSAGE),
        MotionError::Superseded => json_error(
            StatusCode::CONFLICT,
            "superseded",
            "Otro comando reemplazó a este.",
        ),
    })
}

fn bad_request(message: &str) -> ApiError {
    json_error(StatusCode::BAD_REQUEST, "invalid_request", message).into()
}

/// Splits `host[:port]` / `[v6][:port]` and returns the host part (without brackets).
fn split_host_port(authority: &str) -> Option<&str> {
    let a = authority.trim();
    let valid_port =
        |p: &str| !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit());
    if let Some(rest) = a.strip_prefix('[') {
        let end = rest.find(']')?;
        let after = &rest[end + 1..];
        if !(after.is_empty() || after.strip_prefix(':').is_some_and(valid_port)) {
            return None;
        }
        return Some(&rest[..end]);
    }
    let host = match a.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') => {
            if !valid_port(p) {
                return None;
            }
            h
        }
        _ => a, // no port, or a bare IPv6 literal
    };
    if host.is_empty() {
        None
    } else {
        Some(host)
    }
}

fn normalize_host(host: &str) -> String {
    host.trim().trim_end_matches('.').to_ascii_lowercase()
}

/// `Origin` check for CORS, WebSocket and any request that carries an `Origin` header:
/// loopback/private IP literals, `localhost`, the JSConf MX Firebase app, or an exact
/// origin from `BRIDGE_ALLOWED_ORIGINS`. The host is parsed, never prefix-matched.
pub fn is_allowed_origin(origin: &str, extra_origins: &[String]) -> bool {
    let trimmed = origin.trim();
    let lowered = trimmed.to_ascii_lowercase();
    if extra_origins.contains(&lowered) {
        return true;
    }
    let Some(authority) = lowered
        .strip_prefix("http://")
        .or_else(|| lowered.strip_prefix("https://"))
    else {
        return false;
    };
    if authority.is_empty() || authority.contains(['/', '@', '?', '#', '\\']) {
        return false;
    }
    let Some(host) = split_host_port(authority) else {
        return false;
    };
    if let Ok(ip) = host.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => v4.is_loopback() || v4.is_private(),
            IpAddr::V6(v6) => v6.is_loopback(),
        };
    }
    BUILTIN_ORIGIN_HOSTS.contains(&host)
}

/// Anti DNS-rebinding: the `Host` header must be an IP literal (any), `localhost`,
/// or a name listed in `BRIDGE_ALLOWED_HOSTS`.
pub fn is_allowed_host(host_header: &str, extra_hosts: &[String]) -> bool {
    let Some(host) = split_host_port(host_header) else {
        return false;
    };
    let host = normalize_host(host);
    if host.is_empty() {
        return false;
    }
    host.parse::<IpAddr>().is_ok() || host == "localhost" || extra_hosts.contains(&host)
}

/// Constant-time comparison (no early exit on the first differing byte or on length).
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let mut diff: usize = a.len() ^ b.len();
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        diff |= (x ^ y) as usize;
    }
    diff == 0
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
                if let Some(v) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                    out.push(v);
                    i += 3;
                    continue;
                }
                out.push(b'%');
            }
            b'+' => out.push(b' '),
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Token from `Authorization: Bearer`, `x-bridge-token` or (only on `/ws`) `?token=`.
fn request_has_valid_token(req: &Request, expected: &str) -> bool {
    let expected = expected.as_bytes();
    let headers = req.headers();
    if let Some(auth) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        if let Some(bearer) = auth.strip_prefix("Bearer ") {
            if constant_time_eq(bearer.trim().as_bytes(), expected) {
                return true;
            }
        }
    }
    if let Some(tok) = headers.get("x-bridge-token").and_then(|v| v.to_str().ok()) {
        if constant_time_eq(tok.trim().as_bytes(), expected) {
            return true;
        }
    }
    if req.uri().path() == "/ws" {
        if let Some(query) = req.uri().query() {
            for pair in query.split('&') {
                if let Some(val) = pair.strip_prefix("token=") {
                    if constant_time_eq(percent_decode(val).as_bytes(), expected) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// Outermost guard: `Host` allow-list (DNS rebinding) and, when present, `Origin` allow-list.
async fn host_origin_guard(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .or_else(|| req.uri().authority().map(|a| a.as_str().to_owned()));
    let host_ok = host
        .as_deref()
        .is_some_and(|h| is_allowed_host(h, &state.security.allowed_hosts));
    if !host_ok {
        return json_error(
            StatusCode::FORBIDDEN,
            "forbidden_host",
            "Host no permitido. Usa una IP, localhost o agrega el nombre a BRIDGE_ALLOWED_HOSTS.",
        );
    }
    if let Some(origin) = req.headers().get(header::ORIGIN) {
        let allowed = origin
            .to_str()
            .is_ok_and(|o| is_allowed_origin(o, &state.security.allowed_origins));
        if !allowed {
            return json_error(
                StatusCode::FORBIDDEN,
                "forbidden_origin",
                "Origen no permitido. Agrégalo a BRIDGE_ALLOWED_ORIGINS si es tuyo.",
            );
        }
    }
    next.run(req).await
}

async fn auth_middleware(State(state): State<AppState>, req: Request, next: Next) -> Response {
    if let Some(expected) = state.security.token.as_deref() {
        let exempt = req.method() == Method::OPTIONS || req.uri().path() == "/health";
        if !exempt && !request_has_valid_token(&req, expected) {
            return json_error(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "Falta el token del bridge o no coincide (Authorization: Bearer <token> o x-bridge-token).",
            );
        }
    }
    next.run(req).await
}

async fn rate_limit_middleware(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Response {
    let path = req.uri().path();
    let limited = req.method() == Method::POST && path != "/stop" && path != "/estop/release";
    if limited && !state.limiter.try_acquire() {
        return json_error(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "Demasiadas solicitudes de movimiento. Intenta de nuevo en un momento.",
        );
    }
    next.run(req).await
}

async fn get_health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok" }))
}

async fn get_status(State(state): State<AppState>) -> Json<TelemetryState> {
    Json(state.robot.snapshot())
}

fn ok_response(state: &AppState, action: String) -> ApiResult {
    Ok(Json(ActionResponse {
        status: "ok",
        action,
        telemetry: state.robot.snapshot(),
    }))
}

async fn post_cmd_vel(State(state): State<AppState>, Json(req): Json<CmdVelRequest>) -> ApiResult {
    let (vx, vy, wz) = state
        .robot
        .set_velocity_with_duration(req.linear_x, req.linear_y, req.angular_z, req.duration_ms)
        .map_err(motion_error_response)?;
    ok_response(
        &state,
        format!("cmd_vel(vx={:.2}, vy={:.2}, wz={:.2})", vx, vy, wz),
    )
}

fn valid_arm_targets(servos: &[ServoTarget]) -> bool {
    !servos.is_empty() && servos.len() <= 6 && servos.iter().all(|s| is_valid_servo_id(s.id))
}

async fn post_arm(State(state): State<AppState>, Json(req): Json<ArmRequest>) -> ApiResult {
    if !valid_arm_targets(&req.servos) {
        return Err(bad_request("servos: 1 a 6 entradas con IDs 1-5 o 10"));
    }
    let safe_duration = req.duration_ms.clamp(120, 5000);
    state
        .robot
        .set_arm(safe_duration, &req.servos)
        .map_err(motion_error_response)?;
    ok_response(
        &state,
        format!("arm({} servos, {}ms)", req.servos.len(), safe_duration),
    )
}

fn validate_jog(id: u8, delta: i16) -> Result<(), &'static str> {
    if !is_valid_servo_id(id) {
        return Err("id de servo inválido (1-5 o 10)");
    }
    if !(-MAX_JOG_DELTA..=MAX_JOG_DELTA).contains(&delta) {
        return Err("delta fuera de rango (-300..300)");
    }
    Ok(())
}

async fn post_servo_jog(
    State(state): State<AppState>,
    Json(req): Json<ServoJogRequest>,
) -> ApiResult {
    validate_jog(req.id, req.delta).map_err(bad_request)?;
    let next = state
        .robot
        .jog_servo(req.id, req.delta)
        .map_err(motion_error_response)?;
    ok_response(
        &state,
        format!(
            "servo_jog(id={}, delta={}, pulse={})",
            req.id, req.delta, next
        ),
    )
}

async fn post_scene_reset(State(state): State<AppState>) -> ApiResult {
    state.robot.reset_scene().map_err(motion_error_response)?;
    ok_response(&state, "scene_reset".into())
}

async fn post_hud(State(state): State<AppState>, Json(req): Json<HudUpdateRequest>) -> ApiResult {
    state.robot.update_hud(
        req.speaking,
        req.listening,
        req.headline,
        req.subtext,
        req.mood,
    );
    ok_response(&state, "hud_update".into())
}

async fn post_gesture(State(state): State<AppState>, Json(req): Json<GestureRequest>) -> ApiResult {
    if !is_known_gesture(&req.name) {
        return Err(json_error(StatusCode::NOT_FOUND, "not_found", "Gesto desconocido").into());
    }
    let seq = get_gesture(&req.name);
    state
        .robot
        .run_gesture(&req.name, req.mood)
        .map_err(motion_error_response)?;
    ok_response(
        &state,
        format!("gesture({}) - {}", seq.name, seq.description),
    )
}

async fn post_rgb(State(state): State<AppState>, Json(req): Json<RgbRequest>) -> ApiResult {
    state.robot.set_rgb(req.r, req.g, req.b);
    ok_response(&state, format!("rgb({},{},{})", req.r, req.g, req.b))
}

async fn post_buzzer(State(state): State<AppState>, Json(req): Json<BuzzerRequest>) -> ApiResult {
    let safe_repeat = req.repeat.min(5);
    state
        .robot
        .set_buzzer(req.freq_hz, req.on_ms, req.off_ms, safe_repeat)
        .map_err(motion_error_response)?;
    ok_response(
        &state,
        format!("buzzer({}Hz x{})", req.freq_hz, safe_repeat),
    )
}

async fn post_stop(State(state): State<AppState>) -> ApiResult {
    state.robot.stop_all();
    ok_response(&state, "emergency_stop".into())
}

async fn post_estop_release(State(state): State<AppState>) -> ApiResult {
    state.robot.release_estop();
    ok_response(&state, "estop_release".into())
}

async fn post_simulate_lidar(
    State(state): State<AppState>,
    Json(req): Json<LidarSimRequest>,
) -> ApiResult {
    if !state.robot.is_mock() {
        return Err(json_error(
            StatusCode::FORBIDDEN,
            "forbidden",
            "/simulate/lidar solo existe en modo mock",
        )
        .into());
    }
    {
        let mut st = state.robot.state.lock().unwrap_or_else(|p| p.into_inner());
        st.lidar.front_m = req.front_m.clamp(0.05, 5.0);
        if let Some(l) = req.left_m {
            st.lidar.left_m = l.clamp(0.05, 5.0);
        }
        if let Some(r) = req.right_m {
            st.lidar.right_m = r.clamp(0.05, 5.0);
        }
        if let Some(b) = req.back_m {
            st.lidar.back_m = b.clamp(0.05, 5.0);
        }
    }
    // Re-evaluate the per-axis brake right away (the 40 Hz tick would do it within 25 ms).
    state.robot.enforce_motion_safety();
    ok_response(
        &state,
        format!("simulate_lidar(front_m={:.2})", req.front_m),
    )
}

async fn get_camera_frame(State(state): State<AppState>) -> impl IntoResponse {
    let jpeg = state
        .robot
        .latest_jpeg
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .clone();
    if let Some(jpeg) = jpeg {
        return (StatusCode::OK, [(header::CONTENT_TYPE, "image/jpeg")], jpeg);
    }
    let svg = state.robot.get_camera_svg();
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "image/svg+xml")],
        svg.into_bytes(),
    )
}

async fn ws_handler(
    headers: HeaderMap,
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> Response {
    // Browsers always send Origin on WebSocket upgrades; non-browser clients may omit it.
    if let Some(origin) = headers.get(header::ORIGIN) {
        let allowed = origin
            .to_str()
            .is_ok_and(|o| is_allowed_origin(o, &state.security.allowed_origins));
        if !allowed {
            return json_error(
                StatusCode::FORBIDDEN,
                "forbidden_origin",
                "Origen no permitido",
            );
        }
    }
    ws.max_message_size(WS_MAX_MESSAGE_BYTES)
        .max_frame_size(WS_MAX_MESSAGE_BYTES)
        .on_upgrade(move |socket| handle_ws(socket, state))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum WsClientCommand {
    CmdVel {
        #[serde(default)]
        linear_x: f32,
        #[serde(default)]
        linear_y: f32,
        #[serde(default)]
        angular_z: f32,
        duration_ms: Option<u64>,
    },
    Gesture {
        name: String,
        mood: Option<String>,
    },
    Arm {
        #[serde(default = "default_duration_ms")]
        duration_ms: u16,
        servos: Vec<ServoTarget>,
    },
    Jog {
        id: u8,
        delta: i16,
    },
    ResetScene,
    Stop,
}

impl WsClientCommand {
    fn op(&self) -> &'static str {
        match self {
            WsClientCommand::CmdVel { .. } => "cmd_vel",
            WsClientCommand::Gesture { .. } => "gesture",
            WsClientCommand::Arm { .. } => "arm",
            WsClientCommand::Jog { .. } => "jog",
            WsClientCommand::ResetScene => "reset_scene",
            WsClientCommand::Stop => "stop",
        }
    }
}

/// WS error event (telemetry frames never carry an `event` key).
fn ws_error_event(op: &str, status: &str, message: &str) -> String {
    serde_json::json!({ "event": "error", "op": op, "status": status, "message": message })
        .to_string()
}

fn ws_motion_error(op: &str, err: MotionError) -> String {
    match err {
        MotionError::EstopLatched => ws_error_event(op, "estop_latched", ESTOP_MESSAGE),
        MotionError::Superseded => {
            ws_error_event(op, "superseded", "Otro comando reemplazó a este.")
        }
    }
}

/// Executes one WS command; returns an error event to send back, if any.
fn execute_ws_command(state: &AppState, cmd: WsClientCommand) -> Option<String> {
    let op = cmd.op();
    if !matches!(cmd, WsClientCommand::Stop) && !state.limiter.try_acquire() {
        return Some(ws_error_event(
            op,
            "rate_limited",
            "Demasiadas solicitudes de movimiento. Intenta de nuevo en un momento.",
        ));
    }
    let robot = &state.robot;
    let result = match cmd {
        WsClientCommand::CmdVel {
            linear_x,
            linear_y,
            angular_z,
            duration_ms,
        } => robot
            .set_velocity_with_duration(linear_x, linear_y, angular_z, duration_ms)
            .map(|_| ()),
        WsClientCommand::Gesture { name, mood } => {
            if !is_known_gesture(&name) {
                return Some(ws_error_event(op, "not_found", "Gesto desconocido"));
            }
            robot.run_gesture(&name, mood)
        }
        WsClientCommand::Arm {
            duration_ms,
            servos,
        } => {
            if !valid_arm_targets(&servos) {
                return Some(ws_error_event(
                    op,
                    "invalid_request",
                    "servos: 1 a 6 entradas con IDs 1-5 o 10",
                ));
            }
            robot.set_arm(duration_ms.clamp(120, 5000), &servos)
        }
        WsClientCommand::Jog { id, delta } => {
            if let Err(msg) = validate_jog(id, delta) {
                return Some(ws_error_event(op, "invalid_request", msg));
            }
            robot.jog_servo(id, delta).map(|_| ())
        }
        WsClientCommand::ResetScene => robot.reset_scene(),
        WsClientCommand::Stop => {
            robot.stop_all();
            Ok(())
        }
    };
    result.err().map(|e| ws_motion_error(op, e))
}

async fn handle_ws(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.tx.subscribe();
    let (err_tx, mut err_rx) = mpsc::channel::<String>(16);

    if let Ok(initial_json) = serde_json::to_string(&state.robot.snapshot()) {
        let _ = sender.send(Message::Text(initial_json)).await;
    }

    let mut send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = rx.recv() => match msg {
                    Ok(telemetry) => {
                        if let Ok(txt) = serde_json::to_string(&telemetry) {
                            if sender.send(Message::Text(txt)).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                Some(event) = err_rx.recv() => {
                    if sender.send(Message::Text(event)).await.is_err() {
                        break;
                    }
                }
            }
        }
    });

    let recv_state = state.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) => {
                    let reply = match serde_json::from_str::<WsClientCommand>(&text) {
                        Ok(cmd) => execute_ws_command(&recv_state, cmd),
                        Err(_) => Some(ws_error_event(
                            "unknown",
                            "invalid_request",
                            "Comando WS inválido",
                        )),
                    };
                    if let Some(event) = reply {
                        let _ = err_tx.try_send(event);
                    }
                }
                Message::Ping(_) | Message::Pong(_) | Message::Binary(_) => continue,
                Message::Close(_) => break,
            }
        }
    });

    tokio::select! {
        _ = &mut send_task => {
            recv_task.abort();
        },
        _ = &mut recv_task => {
            send_task.abort();
        },
    }
}

fn build_router(state: AppState) -> Router {
    let cors_origins = state.security.clone();
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(move |origin, _req_parts| {
            origin
                .to_str()
                .map(|o| is_allowed_origin(o, &cors_origins.allowed_origins))
                .unwrap_or(false)
        }))
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            header::ACCEPT,
            header::HeaderName::from_static("x-bridge-token"),
        ]);

    Router::new()
        .route("/health", get(get_health))
        .route("/status", get(get_status))
        .route("/cmd_vel", post(post_cmd_vel))
        .route("/arm", post(post_arm))
        .route("/servo/jog", post(post_servo_jog))
        .route("/arm/jog", post(post_servo_jog))
        .route("/scene/reset", post(post_scene_reset))
        .route("/hud", post(post_hud))
        .route("/gesture", post(post_gesture))
        .route("/rgb", post(post_rgb))
        .route("/buzzer", post(post_buzzer))
        .route("/stop", post(post_stop))
        .route("/estop/release", post(post_estop_release))
        .route("/simulate/lidar", post(post_simulate_lidar))
        .route("/camera/frame", get(get_camera_frame))
        .route("/ws", get(ws_handler))
        // Order (outer → inner): host/origin guard → CORS → body limit → auth → rate limit → handler
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            rate_limit_middleware,
        ))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .layer(DefaultBodyLimit::max(8192))
        .layer(cors)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            host_origin_guard,
        ))
        .with_state(state)
}

fn split_csv(raw: &str, normalize: impl Fn(&str) -> String) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(normalize)
        .collect()
}

fn is_loopback_bind(host: &str) -> bool {
    let h = host.trim().trim_start_matches('[').trim_end_matches(']');
    h.eq_ignore_ascii_case("localhost") || h.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "rosorin_bridge=info,tower_http=info".into()),
        )
        .init();

    let args = Args::parse();
    let token = {
        let trimmed = args.token.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    };

    if !is_loopback_bind(&args.host) && token.is_none() {
        if args.insecure_no_token {
            warn!(
                "ATENCIÓN: escuchando en {} SIN token (--insecure-no-token). Cualquiera en la red puede mover el robot.",
                args.host
            );
        } else {
            eprintln!(
                "[rosorin-bridge] Me niego a escuchar en {} sin token: cualquiera en la red podría mover el robot.\n\
                 Define BRIDGE_TOKEN (p. ej. `export BRIDGE_TOKEN=$(openssl rand -hex 16)`), \
                 usa --host 127.0.0.1, o pasa --insecure-no-token si de verdad lo quieres así.",
                args.host
            );
            std::process::exit(2);
        }
    }
    if let Some(t) = &token {
        if t.len() < 16 {
            warn!("BRIDGE_TOKEN tiene menos de 16 caracteres; usa `openssl rand -hex 16`");
        }
    }

    let robot = match RobotController::new(&BackendConfig {
        backend: args.backend.clone(),
        serial_port: args.serial_port.clone(),
        baud: args.baud,
        watchdog_ms: args.watchdog_ms,
        worker_path: Some(args.worker_path.trim())
            .filter(|p| !p.is_empty())
            .map(PathBuf::from),
        allow_mock_fallback: args.allow_mock_fallback,
    }) {
        Ok(robot) => robot,
        Err(e) => {
            eprintln!(
                "[rosorin-bridge] Error al iniciar el backend '{}': {:#}",
                args.backend, e
            );
            std::process::exit(1);
        }
    };

    let (tx, _rx) = broadcast::channel::<TelemetryState>(64);
    let security = Arc::new(SecurityConfig {
        token,
        allowed_origins: split_csv(&args.allowed_origins, |s| {
            s.trim_end_matches('/').to_ascii_lowercase()
        }),
        allowed_hosts: split_csv(&args.allowed_hosts, normalize_host),
    });
    let state = AppState {
        robot: Arc::clone(&robot),
        tx: tx.clone(),
        security: Arc::clone(&security),
        limiter: Arc::new(RateLimiter::new(RATE_LIMIT_PER_SEC, RATE_LIMIT_BURST)),
    };

    // 40Hz kinematics + servo interpolation tick (25ms), 20Hz WebSocket telemetry broadcast
    let tick_robot = Arc::clone(&robot);
    let tick_handle = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(25));
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut last_tick = Instant::now();
        let mut step: u64 = 0;
        loop {
            interval.tick().await;
            let now = Instant::now();
            let dt_s = now
                .duration_since(last_tick)
                .as_secs_f32()
                .clamp(0.005, 0.100);
            last_tick = now;
            tick_robot.tick(dt_s);
            step += 1;
            if step.is_multiple_of(2) {
                let _ = tx.send(tick_robot.snapshot());
            }
        }
    });

    let app = build_router(state);

    let addr: SocketAddr = format!("{}:{}", args.host, args.port).parse()?;
    info!(
        "rosorin-bridge listening on http://{} (backend={}, watchdog={}ms, token={}, lidar={})",
        addr,
        robot.snapshot().backend,
        args.watchdog_ms,
        if security.token.is_some() {
            "sí"
        } else {
            "no"
        },
        robot.snapshot().lidar_source,
    );

    let listener = tokio::net::TcpListener::bind(addr).await?;
    let server = std::future::IntoFuture::into_future(axum::serve(listener, app));

    // Supervise the control loop: if it ever ends or panics, stop the motors and exit.
    tokio::select! {
        res = tick_handle => {
            error!("El loop de control de 40 Hz terminó ({:?}); deteniendo motores y saliendo", res);
            robot.halt_for_shutdown();
            std::process::exit(70);
        }
        res = server => {
            robot.halt_for_shutdown();
            res?;
        }
        _ = shutdown_signal() => {
            info!("Señal recibida: deteniendo motores y cerrando el bridge");
            robot.halt_for_shutdown();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use tower::ServiceExt;

    fn test_state(token: Option<&str>) -> AppState {
        let robot = RobotController::new_mock(600, "mock");
        let (tx, _rx) = broadcast::channel::<TelemetryState>(16);
        AppState {
            robot,
            tx,
            security: Arc::new(SecurityConfig {
                token: token.map(str::to_string),
                allowed_origins: vec!["https://demo.example.com".into()],
                allowed_hosts: vec!["rosorin.local".into()],
            }),
            limiter: Arc::new(RateLimiter::new(RATE_LIMIT_PER_SEC, RATE_LIMIT_BURST)),
        }
    }

    fn test_app(token: Option<&str>) -> Router {
        build_router(test_state(token))
    }

    fn req(method: &str, uri: &str) -> axum::http::request::Builder {
        HttpRequest::builder()
            .method(method)
            .uri(uri)
            .header(header::HOST, "localhost:9000")
    }

    fn post_json(uri: &str, body: &str) -> HttpRequest<Body> {
        req("POST", uri)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    }

    async fn body_json(resp: Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), 1 << 20)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn test_origin_validation() {
        let extra = vec!["https://demo.example.com".to_string()];
        assert!(is_allowed_origin("http://localhost:3000", &extra));
        assert!(is_allowed_origin("http://127.0.0.1:3000", &extra));
        assert!(is_allowed_origin("http://[::1]:3000", &extra));
        assert!(is_allowed_origin("http://192.168.1.20:3000", &extra));
        assert!(is_allowed_origin("http://10.0.0.5:3000", &extra));
        assert!(is_allowed_origin("http://172.20.10.2:3000", &extra));
        assert!(is_allowed_origin("https://jsconfmx26.web.app", &extra));
        assert!(is_allowed_origin(
            "https://jsconfmx26.firebaseapp.com",
            &extra
        ));
        assert!(is_allowed_origin("https://demo.example.com", &extra));

        // Text-prefix and wildcard tricks are rejected
        assert!(!is_allowed_origin("http://10.evil.example.com", &extra));
        assert!(!is_allowed_origin("http://192.168.attacker.net", &extra));
        assert!(!is_allowed_origin("http://172.16.x.attacker.io", &extra));
        assert!(!is_allowed_origin("http://rosorin.local:3000", &extra));
        assert!(!is_allowed_origin(
            "https://jsconfmx26.web.app.evil.com",
            &extra
        ));
        assert!(!is_allowed_origin("https://evil.example.com", &extra));
        assert!(!is_allowed_origin(
            "https://demo.example.com.evil.io",
            &extra
        ));
        assert!(!is_allowed_origin("http://172.32.0.1:3000", &extra));
        assert!(!is_allowed_origin("http://8.8.8.8", &extra));
        assert!(!is_allowed_origin("http://0.0.0.0:3000", &extra));
        assert!(!is_allowed_origin("null", &extra));
    }

    #[test]
    fn test_host_validation() {
        let extra = vec!["rosorin.local".to_string()];
        assert!(is_allowed_host("localhost:9000", &extra));
        assert!(is_allowed_host("127.0.0.1:9000", &extra));
        assert!(is_allowed_host("192.168.1.20:9000", &extra));
        assert!(is_allowed_host("203.0.113.7:9000", &extra)); // public IP literal is fine
        assert!(is_allowed_host("[::1]:9000", &extra));
        assert!(is_allowed_host("rosorin.local:9000", &extra));
        assert!(!is_allowed_host("evil.example.com:9000", &extra));
        assert!(!is_allowed_host("127.0.0.1.nip.io:9000", &extra));
        assert!(!is_allowed_host("other.local", &extra));
        assert!(!is_allowed_host("", &extra));
    }

    #[test]
    fn test_constant_time_eq() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"abcd"));
        assert!(!constant_time_eq(b"", b"a"));
        assert_eq!(percent_decode("a%2Bb+c"), "a+b c");
    }

    #[tokio::test]
    async fn test_host_header_rebinding_is_rejected() {
        let app = test_app(None);
        let evil = HttpRequest::builder()
            .uri("/health")
            .header(header::HOST, "evil.example.com:9000")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(evil).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );

        let listed = HttpRequest::builder()
            .uri("/health")
            .header(header::HOST, "rosorin.local:9000")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(listed).await.unwrap().status(),
            StatusCode::OK
        );

        let bad_origin = req("POST", "/scene/reset")
            .header(header::ORIGIN, "https://evil.example.com")
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.oneshot(bad_origin).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }

    #[tokio::test]
    async fn test_unknown_gesture_returns_404() {
        let app = test_app(None);
        let resp = app
            .clone()
            .oneshot(post_json("/gesture", r#"{"name":"nonexistent_dance"}"#))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        let valid_resp = app
            .oneshot(post_json("/gesture", r#"{"name":"chef_kiss"}"#))
            .await
            .unwrap();
        assert_eq!(valid_resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_invalid_servo_id_and_jog_delta_return_400() {
        let app = test_app(None);
        let resp = app
            .clone()
            .oneshot(post_json(
                "/arm",
                r#"{"duration_ms":400,"servos":[{"id":7,"position":500}]}"#,
            ))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        let resp_jog = app
            .clone()
            .oneshot(post_json("/arm/jog", r#"{"id":99,"delta":20}"#))
            .await
            .unwrap();
        assert_eq!(resp_jog.status(), StatusCode::BAD_REQUEST);

        let resp_delta = app
            .clone()
            .oneshot(post_json("/servo/jog", r#"{"id":1,"delta":400}"#))
            .await
            .unwrap();
        assert_eq!(resp_delta.status(), StatusCode::BAD_REQUEST);

        let resp_ok = app
            .oneshot(post_json("/servo/jog", r#"{"id":1,"delta":-300}"#))
            .await
            .unwrap();
        assert_eq!(resp_ok.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_token_required_on_every_route_except_health_and_preflight() {
        let token = "stage-secret-2026-abcdef";
        let app = test_app(Some(token));

        // POST without / with token
        let unauth = req("POST", "/stop").body(Body::empty()).unwrap();
        assert_eq!(
            app.clone().oneshot(unauth).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        let bearer = req("POST", "/stop")
            .header(header::AUTHORIZATION, format!("Bearer {token}"))
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(bearer).await.unwrap().status(),
            StatusCode::OK
        );

        // GET /status and /camera/frame are protected too
        for path in ["/status", "/camera/frame"] {
            let no_tok = req("GET", path).body(Body::empty()).unwrap();
            assert_eq!(
                app.clone().oneshot(no_tok).await.unwrap().status(),
                StatusCode::UNAUTHORIZED
            );
            let hdr = req("GET", path)
                .header("x-bridge-token", token)
                .body(Body::empty())
                .unwrap();
            assert_eq!(
                app.clone().oneshot(hdr).await.unwrap().status(),
                StatusCode::OK
            );
            let wrong = req("GET", path)
                .header("x-bridge-token", "stage-secret-2026-abcdeX")
                .body(Body::empty())
                .unwrap();
            assert_eq!(
                app.clone().oneshot(wrong).await.unwrap().status(),
                StatusCode::UNAUTHORIZED
            );
        }

        // ?token= is NOT accepted outside /ws
        let query = req("GET", &format!("/status?token={token}"))
            .body(Body::empty())
            .unwrap();
        assert_eq!(
            app.clone().oneshot(query).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );

        // /ws: query token passes auth (then fails the upgrade because this is not a real socket)
        let ws_no_tok = req("GET", "/ws").body(Body::empty()).unwrap();
        assert_eq!(
            app.clone().oneshot(ws_no_tok).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        let ws_query = req("GET", &format!("/ws?token={token}"))
            .body(Body::empty())
            .unwrap();
        let ws_status = app.clone().oneshot(ws_query).await.unwrap().status();
        assert_ne!(ws_status, StatusCode::UNAUTHORIZED);
        assert_ne!(ws_status, StatusCode::FORBIDDEN);

        // /health is public and minimal
        let health = req("GET", "/health").body(Body::empty()).unwrap();
        let resp = app.clone().oneshot(health).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await, serde_json::json!({ "status": "ok" }));

        // CORS preflight is answered without token and allows the auth headers
        let preflight = req("OPTIONS", "/cmd_vel")
            .header(header::ORIGIN, "http://localhost:3000")
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
            .header(
                header::ACCESS_CONTROL_REQUEST_HEADERS,
                "authorization,x-bridge-token,content-type",
            )
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(preflight).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let allow_headers = resp
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
            .unwrap()
            .to_str()
            .unwrap()
            .to_ascii_lowercase();
        for h in ["authorization", "x-bridge-token", "content-type"] {
            assert!(allow_headers.contains(h), "{allow_headers}");
        }
    }

    #[tokio::test]
    async fn test_estop_latch_returns_423_until_release() {
        let app = test_app(None);
        let stop = req("POST", "/stop").body(Body::empty()).unwrap();
        let resp = app.clone().oneshot(stop).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await["telemetry"]["estop_latched"], true);

        let moving = [
            ("/cmd_vel", r#"{"linear_x":0.1}"#),
            ("/arm", r#"{"servos":[{"id":1,"position":600}]}"#),
            ("/servo/jog", r#"{"id":1,"delta":20}"#),
            ("/arm/jog", r#"{"id":1,"delta":20}"#),
            ("/gesture", r#"{"name":"chef_kiss"}"#),
            ("/scene/reset", "{}"),
            ("/buzzer", "{}"),
        ];
        for (path, body) in moving {
            let resp = app.clone().oneshot(post_json(path, body)).await.unwrap();
            assert_eq!(resp.status(), StatusCode::LOCKED, "{path}");
            let json = body_json(resp).await;
            assert_eq!(json["status"], "estop_latched");
            assert_eq!(json["message"], ESTOP_MESSAGE);
        }

        // Non-moving routes keep working
        let hud = app
            .clone()
            .oneshot(post_json("/hud", r#"{"headline":"hola"}"#))
            .await
            .unwrap();
        assert_eq!(hud.status(), StatusCode::OK);

        let release = req("POST", "/estop/release").body(Body::empty()).unwrap();
        let resp = app.clone().oneshot(release).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await["telemetry"]["estop_latched"], false);

        let resp = app
            .oneshot(post_json("/cmd_vel", r#"{"linear_x":0.1}"#))
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[test]
    fn test_ws_commands_respect_latch() {
        let state = test_state(None);
        state.robot.stop_all();
        let event = execute_ws_command(
            &state,
            WsClientCommand::CmdVel {
                linear_x: 0.1,
                linear_y: 0.0,
                angular_z: 0.0,
                duration_ms: None,
            },
        )
        .expect("error event");
        let json: serde_json::Value = serde_json::from_str(&event).unwrap();
        assert_eq!(json["event"], "error");
        assert_eq!(json["op"], "cmd_vel");
        assert_eq!(json["status"], "estop_latched");
        assert!(execute_ws_command(&state, WsClientCommand::Stop).is_none());
    }

    #[tokio::test]
    async fn test_rate_limit_returns_429_but_never_blocks_stop() {
        let app = test_app(None);
        let mut limited = 0;
        for _ in 0..80 {
            let resp = app
                .clone()
                .oneshot(post_json("/cmd_vel", r#"{"linear_x":0.05}"#))
                .await
                .unwrap();
            if resp.status() == StatusCode::TOO_MANY_REQUESTS {
                limited += 1;
                assert_eq!(body_json(resp).await["status"], "rate_limited");
            }
        }
        assert!(
            limited >= 15,
            "expected 429s after the burst, got {limited}"
        );

        let stop = req("POST", "/stop").body(Body::empty()).unwrap();
        assert_eq!(
            app.clone().oneshot(stop).await.unwrap().status(),
            StatusCode::OK
        );
        let release = req("POST", "/estop/release").body(Body::empty()).unwrap();
        assert_eq!(app.oneshot(release).await.unwrap().status(), StatusCode::OK);
    }

    #[test]
    fn test_loopback_bind_detection() {
        assert!(is_loopback_bind("127.0.0.1"));
        assert!(is_loopback_bind("::1"));
        assert!(is_loopback_bind("localhost"));
        assert!(!is_loopback_bind("0.0.0.0"));
        assert!(!is_loopback_bind("192.168.1.20"));
    }
}
