mod backend;
mod gestures;
mod protocol;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use backend::{RobotController, TelemetryState};
use clap::Parser;
use futures_util::{SinkExt, StreamExt};
use gestures::get_gesture;
use protocol::ServoTarget;
use serde::{Deserialize, Serialize};
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};
use tracing::info;

#[derive(Parser, Debug, Clone)]
#[command(name = "rosorin-bridge", about = "Hiwonder ROSOrin Pro Rust Bridge for Gemini Live JS")]
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
}

#[derive(Clone)]
struct AppState {
    robot: Arc<RobotController>,
    tx: broadcast::Sender<TelemetryState>,
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

async fn get_status(State(state): State<AppState>) -> Json<TelemetryState> {
    Json(state.robot.snapshot())
}

async fn post_cmd_vel(
    State(state): State<AppState>,
    Json(req): Json<CmdVelRequest>,
) -> Json<ActionResponse> {
    state
        .robot
        .set_velocity(req.linear_x, req.linear_y, req.angular_z);
    if let Some(dur) = req.duration_ms {
        let robot = Arc::clone(&state.robot);
        let wait_ms = dur.min(4000);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(wait_ms)).await;
            if robot.last_cmd_vel_at.lock().unwrap().elapsed()
                >= Duration::from_millis(wait_ms.saturating_sub(20))
            {
                robot.set_velocity(0.0, 0.0, 0.0);
            }
        });
    }
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
) -> Json<ActionResponse> {
    state.robot.set_arm(req.duration_ms, &req.servos);
    Json(ActionResponse {
        status: "ok",
        action: format!("arm({} servos, {}ms)", req.servos.len(), req.duration_ms),
        telemetry: state.robot.snapshot(),
    })
}

async fn post_servo_jog(
    State(state): State<AppState>,
    Json(req): Json<ServoJogRequest>,
) -> Json<ActionResponse> {
    let next = state.robot.jog_servo(req.id, req.delta);
    Json(ActionResponse {
        status: "ok",
        action: format!("servo_jog(id={}, delta={}, pulse={})", req.id, req.delta, next),
        telemetry: state.robot.snapshot(),
    })
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
    state
        .robot
        .update_hud(req.speaking, req.listening, req.headline, req.subtext, req.mood);
    Json(ActionResponse {
        status: "ok",
        action: "hud_update".into(),
        telemetry: state.robot.snapshot(),
    })
}

async fn post_gesture(
    State(state): State<AppState>,
    Json(req): Json<GestureRequest>,
) -> Json<ActionResponse> {
    let seq = get_gesture(&req.name);
    state.robot.run_gesture(&req.name, req.mood);
    Json(ActionResponse {
        status: "ok",
        action: format!("gesture({}) - {}", seq.name, seq.description),
        telemetry: state.robot.snapshot(),
    })
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
    state
        .robot
        .set_buzzer(req.freq_hz, req.on_ms, req.off_ms, req.repeat);
    Json(ActionResponse {
        status: "ok",
        action: format!("buzzer({}Hz x{})", req.freq_hz, req.repeat),
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
) -> Json<ActionResponse> {
    {
        let mut st = state.robot.state.lock().unwrap();
        st.lidar.front_m = req.front_m.clamp(0.05, 5.0);
        st.lidar.obstacle_alert = st.lidar.front_m < 0.35;
    }
    Json(ActionResponse {
        status: "ok",
        action: format!("simulate_lidar(front_m={:.2})", req.front_m),
        telemetry: state.robot.snapshot(),
    })
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
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
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

    // Send initial snapshot immediately
    if let Ok(initial_json) = serde_json::to_string(&state.robot.snapshot()) {
        let _ = sender.send(Message::Text(initial_json.into())).await;
    }

    let send_task = tokio::spawn(async move {
        while let Ok(telemetry) = rx.recv().await {
            if let Ok(txt) = serde_json::to_string(&telemetry) {
                if sender.send(Message::Text(txt.into())).await.is_err() {
                    break;
                }
            }
        }
    });

    let robot = Arc::clone(&state.robot);
    let recv_task = tokio::spawn(async move {
        while let Some(Ok(Message::Text(text))) = receiver.next().await {
            if let Ok(cmd) = serde_json::from_str::<WsClientCommand>(&text) {
                match cmd {
                    WsClientCommand::CmdVel {
                        linear_x,
                        linear_y,
                        angular_z,
                        duration_ms,
                    } => {
                        robot.set_velocity(linear_x, linear_y, angular_z);
                        if let Some(dur) = duration_ms {
                            let r2 = Arc::clone(&robot);
                            let wait_ms = dur.min(4000);
                            tokio::spawn(async move {
                                tokio::time::sleep(Duration::from_millis(wait_ms)).await;
                                if r2.last_cmd_vel_at.lock().unwrap().elapsed()
                                    >= Duration::from_millis(wait_ms.saturating_sub(20))
                                {
                                    r2.set_velocity(0.0, 0.0, 0.0);
                                }
                            });
                        }
                    }
                    WsClientCommand::Gesture { name, mood } => {
                        robot.run_gesture(&name, mood);
                    }
                    WsClientCommand::Arm {
                        duration_ms,
                        servos,
                    } => {
                        robot.set_arm(duration_ms, &servos);
                    }
                    WsClientCommand::Jog { id, delta } => {
                        robot.jog_servo(id, delta);
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
    });

    tokio::select! {
        _ = send_task => {},
        _ = recv_task => {},
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
    let robot = RobotController::new(
        &args.backend,
        &args.serial_port,
        args.baud,
        args.watchdog_ms,
    );

    let (tx, _rx) = broadcast::channel::<TelemetryState>(64);
    let state = AppState {
        robot: Arc::clone(&robot),
        tx: tx.clone(),
    };

    // 40Hz kinematics + servo interpolation tick (25ms), 20Hz WebSocket telemetry broadcast
    let tick_robot = Arc::clone(&robot);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(25));
        let mut step: u64 = 0;
        loop {
            interval.tick().await;
            tick_robot.tick(0.025);
            step += 1;
            if step % 2 == 0 {
                let _ = tx.send(tick_robot.snapshot());
            }
        }
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/status", get(get_status))
        .route("/cmd_vel", post(post_cmd_vel))
        .route("/arm", post(post_arm))
        .route("/servo/jog", post(post_servo_jog))
        .route("/scene/reset", post(post_scene_reset))
        .route("/hud", post(post_hud))
        .route("/gesture", post(post_gesture))
        .route("/rgb", post(post_rgb))
        .route("/buzzer", post(post_buzzer))
        .route("/stop", post(post_stop))
        .route("/simulate/lidar", post(post_simulate_lidar))
        .route("/camera/frame", get(get_camera_frame))
        .route("/ws", get(ws_handler))
        .layer(cors)
        .with_state(state);

    let addr: SocketAddr = format!("{}:{}", args.host, args.port).parse()?;
    info!(
        "rosorin-bridge listening on http://{} (backend={}, watchdog={}ms)",
        addr, args.backend, args.watchdog_ms
    );

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

