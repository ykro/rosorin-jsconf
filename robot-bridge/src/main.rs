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
use backend::{RobotController, TelemetryState};
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use gestures::{get_gesture, is_known_gesture};
use protocol::{is_valid_servo_id, ServoTarget};
use serde::{Deserialize, Serialize};
use std::{
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::broadcast;
use tokio::time::MissedTickBehavior;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing::info;

#[derive(Parser, Debug, Clone)]
#[command(
    name = "rosorin-bridge",
    about = "Hiwonder ROSOrin Pro Rust Bridge for Gemini Live JS"
)]
struct Args {
    #[arg(long, env = "BRIDGE_HOST", default_value = "0.0.0.0")]
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

    /// Optional shared secret token (`Authorization: Bearer <token>` or `?token=<token>`)
    #[arg(long, env = "BRIDGE_TOKEN", default_value = "")]
    token: String,
}

#[derive(Clone)]
struct AppState {
    robot: Arc<RobotController>,
    tx: broadcast::Sender<TelemetryState>,
    token: Option<String>,
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

/// Validates whether an `Origin` header belongs to localhost, private stage LAN, or the JSConf MX Firebase app.
pub fn is_allowed_origin(origin: &str) -> bool {
    let trimmed = origin.trim();
    let without_scheme = trimmed
        .strip_prefix("http://")
        .or_else(|| trimmed.strip_prefix("https://"))
        .unwrap_or("");
    if without_scheme.is_empty() {
        return false;
    }

    let host = if without_scheme.starts_with('[') {
        without_scheme
            .split(']')
            .next()
            .map(|s| &s[1..])
            .unwrap_or("")
    } else {
        without_scheme.split(':').next().unwrap_or("")
    };

    if matches!(
        host,
        "localhost"
            | "127.0.0.1"
            | "::1"
            | "0.0.0.0"
            | "jsconfmx26.web.app"
            | "jsconfmx26.firebaseapp.com"
    ) || host.ends_with(".local")
    {
        return true;
    }

    if host.starts_with("192.168.") || host.starts_with("10.") {
        return true;
    }

    if let Some(rest) = host.strip_prefix("172.") {
        if let Some(second_octet) = rest.split('.').next().and_then(|s| s.parse::<u8>().ok()) {
            if (16..=31).contains(&second_octet) {
                return true;
            }
        }
    }

    false
}

fn check_request_token(req: &Request, expected: &str) -> bool {
    if let Some(auth) = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    {
        if let Some(bearer) = auth.strip_prefix("Bearer ") {
            if bearer.trim() == expected {
                return true;
            }
        }
    }

    if let Some(hdr_tok) = req
        .headers()
        .get("x-bridge-token")
        .and_then(|v| v.to_str().ok())
    {
        if hdr_tok.trim() == expected {
            return true;
        }
    }

    if let Some(query) = req.uri().query() {
        for pair in query.split('&') {
            if let Some(val) = pair.strip_prefix("token=") {
                if val == expected {
                    return true;
                }
            }
        }
    }

    false
}

async fn auth_middleware(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if let Some(ref expected) = state.token {
        let is_mutating_or_ws = req.method() == Method::POST || req.uri().path() == "/ws";
        if is_mutating_or_ws && !check_request_token(&req, expected) {
            return Err(StatusCode::UNAUTHORIZED);
        }
    }
    Ok(next.run(req).await)
}

async fn get_status(State(state): State<AppState>) -> Json<TelemetryState> {
    Json(state.robot.snapshot())
}

async fn post_cmd_vel(
    State(state): State<AppState>,
    Json(req): Json<CmdVelRequest>,
) -> Json<ActionResponse> {
    state.robot.set_velocity_with_duration(
        req.linear_x,
        req.linear_y,
        req.angular_z,
        req.duration_ms,
    );
    Json(ActionResponse {
        status: "ok",
        action: format!(
            "cmd_vel(vx={:.2}, vy={:.2}, wz={:.2})",
            req.linear_x, req.linear_y, req.angular_z
        ),
        telemetry: state.robot.snapshot(),
    })
}

async fn post_arm(
    State(state): State<AppState>,
    Json(req): Json<ArmRequest>,
) -> Result<Json<ActionResponse>, StatusCode> {
    if req.servos.is_empty()
        || req.servos.len() > 6
        || !req.servos.iter().all(|s| is_valid_servo_id(s.id))
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let safe_duration = req.duration_ms.clamp(120, 5000);
    state.robot.set_arm(safe_duration, &req.servos);
    Ok(Json(ActionResponse {
        status: "ok",
        action: format!("arm({} servos, {}ms)", req.servos.len(), safe_duration),
        telemetry: state.robot.snapshot(),
    }))
}

async fn post_servo_jog(
    State(state): State<AppState>,
    Json(req): Json<ServoJogRequest>,
) -> Result<Json<ActionResponse>, StatusCode> {
    if !is_valid_servo_id(req.id) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let next = state.robot.jog_servo(req.id, req.delta);
    Ok(Json(ActionResponse {
        status: "ok",
        action: format!(
            "servo_jog(id={}, delta={}, pulse={})",
            req.id, req.delta, next
        ),
        telemetry: state.robot.snapshot(),
    }))
}

async fn post_scene_reset(State(state): State<AppState>) -> Json<ActionResponse> {
    state.robot.reset_scene();
    Json(ActionResponse {
        status: "ok",
        action: "scene_reset".into(),
        telemetry: state.robot.snapshot(),
    })
}

async fn post_hud(
    State(state): State<AppState>,
    Json(req): Json<HudUpdateRequest>,
) -> Json<ActionResponse> {
    state.robot.update_hud(
        req.speaking,
        req.listening,
        req.headline,
        req.subtext,
        req.mood,
    );
    Json(ActionResponse {
        status: "ok",
        action: "hud_update".into(),
        telemetry: state.robot.snapshot(),
    })
}

async fn post_gesture(
    State(state): State<AppState>,
    Json(req): Json<GestureRequest>,
) -> Result<Json<ActionResponse>, StatusCode> {
    if !is_known_gesture(&req.name) {
        return Err(StatusCode::NOT_FOUND);
    }
    let seq = get_gesture(&req.name);
    state.robot.run_gesture(&req.name, req.mood);
    Ok(Json(ActionResponse {
        status: "ok",
        action: format!("gesture({}) - {}", seq.name, seq.description),
        telemetry: state.robot.snapshot(),
    }))
}

async fn post_rgb(
    State(state): State<AppState>,
    Json(req): Json<RgbRequest>,
) -> Json<ActionResponse> {
    state.robot.set_rgb(req.r, req.g, req.b);
    Json(ActionResponse {
        status: "ok",
        action: format!("rgb({},{},{})", req.r, req.g, req.b),
        telemetry: state.robot.snapshot(),
    })
}

async fn post_buzzer(
    State(state): State<AppState>,
    Json(req): Json<BuzzerRequest>,
) -> Json<ActionResponse> {
    let safe_repeat = req.repeat.min(5);
    state
        .robot
        .set_buzzer(req.freq_hz, req.on_ms, req.off_ms, safe_repeat);
    Json(ActionResponse {
        status: "ok",
        action: format!("buzzer({}Hz x{})", req.freq_hz, safe_repeat),
        telemetry: state.robot.snapshot(),
    })
}

async fn post_stop(State(state): State<AppState>) -> Json<ActionResponse> {
    state.robot.stop_all();
    Json(ActionResponse {
        status: "ok",
        action: "emergency_stop".into(),
        telemetry: state.robot.snapshot(),
    })
}

async fn post_simulate_lidar(
    State(state): State<AppState>,
    Json(req): Json<LidarSimRequest>,
) -> Result<Json<ActionResponse>, StatusCode> {
    if !state.robot.is_mock() {
        return Err(StatusCode::FORBIDDEN);
    }
    {
        let mut st = state.robot.state.lock().unwrap();
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
        st.lidar.obstacle_alert = st.lidar.front_m < 0.35 || st.lidar.back_m < 0.35;
        if (st.lidar.front_m < 0.28 && st.odometry.vx > 0.0)
            || (st.lidar.back_m < 0.28 && st.odometry.vx < 0.0)
        {
            st.odometry.vx = 0.0;
            st.lidar.obstacle_alert = true;
        }
    }
    Ok(Json(ActionResponse {
        status: "ok",
        action: format!("simulate_lidar(front_m={:.2})", req.front_m),
        telemetry: state.robot.snapshot(),
    }))
}

async fn get_camera_frame(State(state): State<AppState>) -> impl IntoResponse {
    if let Some(jpeg) = state.robot.latest_jpeg.lock().unwrap().clone() {
        return (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "image/jpeg")],
            jpeg,
        );
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
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        if !is_allowed_origin(origin) {
            return StatusCode::FORBIDDEN.into_response();
        }
    }
    ws.on_upgrade(move |socket| handle_ws(socket, state))
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

async fn handle_ws(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.tx.subscribe();

    if let Ok(initial_json) = serde_json::to_string(&state.robot.snapshot()) {
        let _ = sender.send(Message::Text(initial_json)).await;
    }

    let mut send_task = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(telemetry) => {
                    if let Ok(txt) = serde_json::to_string(&telemetry) {
                        if sender.send(Message::Text(txt)).await.is_err() {
                            break;
                        }
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    let robot = Arc::clone(&state.robot);
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) => {
                    if let Ok(cmd) = serde_json::from_str::<WsClientCommand>(&text) {
                        match cmd {
                            WsClientCommand::CmdVel {
                                linear_x,
                                linear_y,
                                angular_z,
                                duration_ms,
                            } => {
                                robot.set_velocity_with_duration(
                                    linear_x,
                                    linear_y,
                                    angular_z,
                                    duration_ms,
                                );
                            }
                            WsClientCommand::Gesture { name, mood } => {
                                if is_known_gesture(&name) {
                                    robot.run_gesture(&name, mood);
                                }
                            }
                            WsClientCommand::Arm {
                                duration_ms,
                                servos,
                            } => {
                                if !servos.is_empty()
                                    && servos.len() <= 6
                                    && servos.iter().all(|s| is_valid_servo_id(s.id))
                                {
                                    robot.set_arm(duration_ms.clamp(120, 5000), &servos);
                                }
                            }
                            WsClientCommand::Jog { id, delta } => {
                                if is_valid_servo_id(id) {
                                    robot.jog_servo(id, delta);
                                }
                            }
                            WsClientCommand::ResetScene => {
                                robot.reset_scene();
                            }
                            WsClientCommand::Stop => {
                                robot.stop_all();
                            }
                        }
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
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin, _req_parts| {
            origin.to_str().map(is_allowed_origin).unwrap_or(false)
        }))
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            header::ACCEPT,
            header::HeaderName::from_static("x-bridge-token"),
        ]);

    Router::new()
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
        .route("/simulate/lidar", post(post_simulate_lidar))
        .route("/camera/frame", get(get_camera_frame))
        .route("/ws", get(ws_handler))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .layer(DefaultBodyLimit::max(8192))
        .layer(cors)
        .with_state(state)
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
    let robot = RobotController::new(
        &args.backend,
        &args.serial_port,
        args.baud,
        args.watchdog_ms,
    );

    let (tx, _rx) = broadcast::channel::<TelemetryState>(64);
    let token = {
        let trimmed = args.token.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    };
    let state = AppState {
        robot: Arc::clone(&robot),
        tx: tx.clone(),
        token,
    };

    // 40Hz kinematics + servo interpolation tick (25ms), 20Hz WebSocket telemetry broadcast
    let tick_robot = Arc::clone(&robot);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(25));
        interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let mut last_tick = Instant::now();
        let mut step: u64 = 0;
        loop {
            interval.tick().await;
            let now = Instant::now();
            let dt_s = now.duration_since(last_tick).as_secs_f32().clamp(0.005, 0.100);
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
        "rosorin-bridge listening on http://{} (backend={}, watchdog={}ms)",
        addr, args.backend, args.watchdog_ms
    );

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;
    use tower::ServiceExt;

    fn test_app(token: Option<String>) -> Router {
        let robot = RobotController::new("mock", "/dev/null", 1_000_000, 600);
        let (tx, _rx) = broadcast::channel::<TelemetryState>(16);
        build_router(AppState { robot, tx, token })
    }

    #[test]
    fn test_origin_validation() {
        assert!(is_allowed_origin("http://localhost:3000"));
        assert!(is_allowed_origin("http://127.0.0.1:3000"));
        assert!(is_allowed_origin("http://192.168.10.224:3000"));
        assert!(is_allowed_origin("http://10.0.0.5:3000"));
        assert!(is_allowed_origin("http://172.20.10.2:3000"));
        assert!(is_allowed_origin("https://jsconfmx26.web.app"));
        assert!(is_allowed_origin("http://rosorin.local:3000"));
        assert!(!is_allowed_origin("https://evil.example.com"));
        assert!(!is_allowed_origin("http://172.32.0.1:3000"));
    }

    #[tokio::test]
    async fn test_unknown_gesture_returns_404() {
        let app = test_app(None);
        let req = HttpRequest::builder()
            .method("POST")
            .uri("/gesture")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"name":"nonexistent_dance"}"#))
            .unwrap();
        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);

        let valid_req = HttpRequest::builder()
            .method("POST")
            .uri("/gesture")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"name":"chef_kiss"}"#))
            .unwrap();
        let valid_resp = app.oneshot(valid_req).await.unwrap();
        assert_eq!(valid_resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_invalid_servo_id_returns_400() {
        let app = test_app(None);
        let bad_arm = HttpRequest::builder()
            .method("POST")
            .uri("/arm")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                r#"{"duration_ms":400,"servos":[{"id":7,"position":500}]}"#,
            ))
            .unwrap();
        let resp = app.clone().oneshot(bad_arm).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

        let bad_jog = HttpRequest::builder()
            .method("POST")
            .uri("/arm/jog")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(r#"{"id":99,"delta":20}"#))
            .unwrap();
        let resp_jog = app.oneshot(bad_jog).await.unwrap();
        assert_eq!(resp_jog.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_bearer_token_middleware() {
        let app = test_app(Some("stage-secret-2026".into()));
        let unauth_req = HttpRequest::builder()
            .method("POST")
            .uri("/stop")
            .body(Body::empty())
            .unwrap();
        let unauth_resp = app.clone().oneshot(unauth_req).await.unwrap();
        assert_eq!(unauth_resp.status(), StatusCode::UNAUTHORIZED);

        let auth_req = HttpRequest::builder()
            .method("POST")
            .uri("/stop")
            .header(header::AUTHORIZATION, "Bearer stage-secret-2026")
            .body(Body::empty())
            .unwrap();
        let auth_resp = app.oneshot(auth_req).await.unwrap();
        assert_eq!(auth_resp.status(), StatusCode::OK);
    }
}
