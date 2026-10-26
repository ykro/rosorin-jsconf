use crate::protocol::ServoTarget;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GestureStep {
    pub duration_ms: u16,
    pub servos: Vec<ServoTarget>,
    pub velocity: Option<(f32, f32, f32)>, // (linear_x, linear_y, angular_z)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GestureSequence {
    pub name: String,
    pub description: String,
    pub rgb: (u8, u8, u8),
    pub buzzer: Option<(u16, u16, u16, u16)>, // (freq_hz, on_ms, off_ms, repeat)
    pub steps: Vec<GestureStep>,
}

fn pose(j1: u16, j2: u16, j3: u16, j4: u16, j5: u16, gripper_10: u16) -> Vec<ServoTarget> {
    vec![
        ServoTarget { id: 1, position: j1 },
        ServoTarget { id: 2, position: j2 },
        ServoTarget { id: 3, position: j3 },
        ServoTarget { id: 4, position: j4 },
        ServoTarget { id: 5, position: j5 },
        ServoTarget { id: 10, position: gripper_10 },
    ]
}

/// Returns true if `name` matches one of the built-in ROSOrin Pro stage gestures or its documented aliases.
pub fn is_known_gesture(name: &str) -> bool {
    matches!(
        name.trim().to_lowercase().as_str(),
        "home"
            | "reset"
            | "neutral"
            | "facepalm"
            | "cringe"
            | "disappointed"
            | "trash_toss"
            | "roast"
            | "garbage"
            | "chef_kiss"
            | "approve"
            | "clean_code"
            | "suspicious_inspect"
            | "inspect"
            | "squint"
            | "victory_spin"
            | "celebrate"
            | "ship_it"
            | "nod_yes"
            | "nod"
            | "shake_no"
            | "reject"
            | "wave_hello"
            | "wave"
            | "greet"
            | "gatekeeper_hold"
            | "hold_key"
            | "present_key"
            | "gatekeeper_approve"
            | "approve_deploy"
            | "gatekeeper_reject"
            | "reject_deploy"
            | "point_cloud_run"
            | "cloud_run"
            | "point_gemini_live"
            | "gemini_live"
            | "point_firestore"
            | "firestore"
            | "bumblebee_hype"
            | "bumblebee_celebrate"
            | "dance_hype"
            | "party"
            | "bumblebee_groove"
            | "dance_groove"
            | "chill"
            | "bumblebee_rock_out"
            | "bumblebee_spin"
            | "rock_out"
            | "headbang"
            | "bumblebee_romance"
            | "bumblebee_wave"
            | "romance"
            | "love_sway"
            | "bumblebee_sad_droop"
            | "bumblebee_nod"
            | "sad_droop"
            | "heartbreak"
            | "bumblebee_sassy"
            | "bumblebee_salute"
            | "sassy"
            | "attitude"
    )
}

/// Returns the built-in expressive choreography for a named gesture on the ROSOrin Pro.
pub fn get_gesture(name: &str) -> GestureSequence {
    let key = name.trim().to_lowercase();
    match key.as_str() {
        "facepalm" | "cringe" | "disappointed" => GestureSequence {
            name: "facepalm".into(),
            description: "Folds the 6-DOF arm in disbelief, shakes base left/right, and backs Mecanum chassis away".into(),
            rgb: (220, 38, 38), // crimson red
            buzzer: Some((950, 220, 60, 2)),
            steps: vec![
                GestureStep {
                    duration_ms: 650,
                    servos: pose(500, 520, 200, 220, 500, 680),
                    velocity: Some((-0.14, 0.0, 0.0)),
                },
                GestureStep {
                    duration_ms: 550,
                    servos: pose(340, 520, 200, 220, 360, 680),
                    velocity: Some((0.0, 0.0, 0.0)),
                },
                GestureStep {
                    duration_ms: 550,
                    servos: pose(660, 520, 200, 220, 640, 680),
                    velocity: None,
                },
                GestureStep {
                    duration_ms: 650,
                    servos: pose(500, 490, 230, 260, 500, 640),
                    velocity: Some((0.0, 0.0, 0.0)),
                },
            ],
        },
        "trash_toss" | "roast" | "garbage" => GestureSequence {
            name: "trash_toss".into(),
            description: "Reaches forward, grabs bad code with Gripper ID 10, swings hard to the side, and opens gripper wide to drop it".into(),
            rgb: (239, 68, 68), // bright red
            buzzer: Some((1400, 120, 40, 3)),
            steps: vec![
                GestureStep {
                    duration_ms: 600,
                    servos: pose(500, 340, 270, 340, 500, 220), // reach low forward with open gripper
                    velocity: Some((0.12, 0.0, 0.0)),
                },
                GestureStep {
                    duration_ms: 450,
                    servos: pose(500, 340, 270, 340, 500, 680), // clamp gripper shut on bad code
                    velocity: Some((0.0, 0.0, 0.0)),
                },
                GestureStep {
                    duration_ms: 700,
                    servos: pose(210, 400, 300, 350, 300, 680), // swing far to the right trash bin
                    velocity: Some((-0.08, -0.14, 0.0)),
                },
                GestureStep {
                    duration_ms: 550,
                    servos: pose(210, 400, 300, 320, 300, 220), // open gripper wide to drop it in the bin
                    velocity: Some((0.0, 0.0, 0.0)),
                },
            ],
        },
        "chef_kiss" | "approve" | "clean_code" => GestureSequence {
            name: "chef_kiss".into(),
            description: "Draws closed gripper in and blossoms outward forward with wrist roll in appreciation of clean architecture".into(),
            rgb: (16, 185, 129), // emerald green
            buzzer: Some((2400, 100, 40, 2)),
            steps: vec![
                GestureStep {
                    duration_ms: 550,
                    servos: pose(500, 510, 230, 260, 500, 680),
                    velocity: Some((0.10, 0.0, 0.0)),
                },
                GestureStep {
                    duration_ms: 650,
                    servos: pose(580, 370, 290, 360, 720, 220), // blossom forward-left with open gripper
                    velocity: Some((0.0, 0.0, 0.0)),
                },
                GestureStep {
                    duration_ms: 650,
                    servos: pose(420, 370, 290, 360, 280, 220), // blossom forward-right
                    velocity: None,
                },
                GestureStep {
                    duration_ms: 600,
                    servos: pose(500, 400, 300, 370, 500, 220),
                    velocity: Some((0.0, 0.0, 0.0)),
                },
            ],
        },
        "suspicious_inspect" | "inspect" | "squint" => GestureSequence {
            name: "suspicious_inspect".into(),
            description: "Advances Mecanum chassis and extends the 6-DOF arm low and forward, scanning left and right with the 3D camera".into(),
            rgb: (245, 158, 11), // amber warning
            buzzer: Some((1850, 90, 90, 1)),
            steps: vec![
                GestureStep {
                    duration_ms: 650,
                    servos: pose(500, 340, 280, 340, 500, 320),
                    velocity: Some((0.14, 0.0, 0.0)),
                },
                GestureStep {
                    duration_ms: 600,
                    servos: pose(360, 340, 280, 340, 380, 240),
                    velocity: Some((0.0, 0.0, 0.0)),
                },
                GestureStep {
                    duration_ms: 600,
                    servos: pose(640, 340, 280, 340, 620, 240),
                    velocity: None,
                },
                GestureStep {
                    duration_ms: 600,
                    servos: pose(500, 370, 290, 350, 500, 300),
                    velocity: Some((-0.08, 0.0, 0.0)),
                },
            ],
        },
        "victory_spin" | "celebrate" | "ship_it" => GestureSequence {
            name: "victory_spin".into(),
            description: "Raises the 6-DOF arm high, opens/closes the gripper, and performs a Mecanum celebration spin".into(),
            rgb: (14, 165, 233), // sky blue
            buzzer: Some((2600, 110, 30, 3)),
            steps: vec![
                GestureStep {
                    duration_ms: 700,
                    servos: pose(660, 470, 360, 420, 260, 220),
                    velocity: Some((0.0, 0.0, 0.65)),
                },
                GestureStep {
                    duration_ms: 700,
                    servos: pose(340, 470, 360, 420, 740, 680),
                    velocity: Some((0.0, 0.0, -0.65)),
                },
                GestureStep {
                    duration_ms: 600,
                    servos: pose(500, 420, 310, 380, 500, 240),
                    velocity: Some((0.0, 0.0, 0.0)),
                },
            ],
        },
        "nod_yes" | "nod" => GestureSequence {
            name: "nod_yes".into(),
            description: "Nods the shoulder, elbow, and wrist joints deeply in agreement".into(),
            rgb: (34, 197, 94),
            buzzer: Some((2200, 80, 40, 1)),
            steps: vec![
                GestureStep {
                    duration_ms: 450,
                    servos: pose(500, 360, 260, 290, 500, 260),
                    velocity: Some((0.08, 0.0, 0.0)),
                },
                GestureStep {
                    duration_ms: 450,
                    servos: pose(500, 470, 350, 440, 500, 620),
                    velocity: Some((0.0, 0.0, 0.0)),
                },
                GestureStep {
                    duration_ms: 450,
                    servos: pose(500, 370, 270, 310, 500, 260),
                    velocity: None,
                },
                GestureStep {
                    duration_ms: 500,
                    servos: pose(500, 430, 310, 380, 500, 450),
                    velocity: None,
                },
            ],
        },
        "shake_no" | "reject" => GestureSequence {
            name: "shake_no".into(),
            description: "Sweeps base joint 1 wide left and right to reject a bad PR or excuse".into(),
            rgb: (220, 38, 38),
            buzzer: Some((1100, 160, 50, 2)),
            steps: vec![
                GestureStep {
                    duration_ms: 450,
                    servos: pose(280, 420, 300, 370, 350, 660),
                    velocity: Some((-0.08, 0.0, 0.0)),
                },
                GestureStep {
                    duration_ms: 450,
                    servos: pose(720, 420, 300, 370, 650, 660),
                    velocity: Some((0.0, 0.0, 0.0)),
                },
                GestureStep {
                    duration_ms: 450,
                    servos: pose(320, 420, 300, 370, 350, 660),
                    velocity: None,
                },
                GestureStep {
                    duration_ms: 500,
                    servos: pose(500, 430, 310, 380, 500, 500),
                    velocity: None,
                },
            ],
        },
        "wave_hello" | "wave" | "greet" => GestureSequence {
            name: "wave_hello".into(),
            description: "Extends arm forward and waves base and gripper to greet the JSConf MX audience".into(),
            rgb: (15, 118, 110), // teal
            buzzer: Some((2100, 90, 40, 2)),
            steps: vec![
                GestureStep {
                    duration_ms: 500,
                    servos: pose(340, 430, 320, 390, 320, 220),
                    velocity: None,
                },
                GestureStep {
                    duration_ms: 500,
                    servos: pose(660, 430, 320, 390, 680, 660),
                    velocity: None,
                },
                GestureStep {
                    duration_ms: 500,
                    servos: pose(500, 430, 310, 380, 500, 320),
                    velocity: None,
                },
            ],
        },
        "gatekeeper_hold" | "hold_key" | "present_key" => GestureSequence {
            name: "gatekeeper_hold".into(),
            description: "Puts arm in a forward presentation pose holding the Deploy Key firmly in Servo 10".into(),
            rgb: (245, 158, 11), // amber
            buzzer: Some((1950, 90, 40, 1)),
            steps: vec![GestureStep {
                duration_ms: 600,
                servos: pose(500, 430, 310, 380, 500, 680),
                velocity: Some((0.0, 0.0, 0.0)),
            }],
        },
        "gatekeeper_approve" | "approve_deploy" => GestureSequence {
            name: "gatekeeper_approve".into(),
            description: "Rotates base to green tray, lowers arm, and opens gripper wide to release the Deploy Key".into(),
            rgb: (16, 185, 129), // emerald
            buzzer: Some((2500, 120, 40, 2)),
            steps: vec![
                GestureStep {
                    duration_ms: 700,
                    servos: pose(700, 360, 270, 340, 500, 680),
                    velocity: Some((0.06, 0.08, 0.0)),
                },
                GestureStep {
                    duration_ms: 650,
                    servos: pose(700, 350, 260, 330, 500, 220), // open gripper wide over green tray
                    velocity: Some((0.0, 0.0, 0.0)),
                },
            ],
        },
        "gatekeeper_reject" | "reject_deploy" => GestureSequence {
            name: "gatekeeper_reject".into(),
            description: "Shakes base in refusal, swings to red reject tray, opens gripper to drop the Deploy Key, and backs away".into(),
            rgb: (220, 38, 38), // crimson
            buzzer: Some((950, 200, 50, 2)),
            steps: vec![
                GestureStep {
                    duration_ms: 400,
                    servos: pose(360, 430, 310, 380, 500, 680),
                    velocity: None,
                },
                GestureStep {
                    duration_ms: 400,
                    servos: pose(640, 430, 310, 380, 500, 680),
                    velocity: None,
                },
                GestureStep {
                    duration_ms: 700,
                    servos: pose(280, 360, 270, 340, 500, 680),
                    velocity: Some((0.0, -0.08, 0.0)),
                },
                GestureStep {
                    duration_ms: 650,
                    servos: pose(280, 350, 260, 330, 500, 220), // open gripper wide over red tray & back up
                    velocity: Some((-0.12, 0.0, 0.0)),
                },
            ],
        },
        "point_cloud_run" | "cloud_run" => GestureSequence {
            name: "point_cloud_run".into(),
            description: "Strafes Mecanum left and extends arm forward pointing at the Cloud Run totem".into(),
            rgb: (43, 74, 203), // cobalt
            buzzer: Some((2150, 80, 40, 1)),
            steps: vec![
                GestureStep {
                    duration_ms: 850,
                    servos: pose(610, 350, 270, 350, 500, 660),
                    velocity: Some((0.0, 0.22, 0.0)),
                },
                GestureStep {
                    duration_ms: 450,
                    servos: pose(610, 350, 270, 350, 500, 660),
                    velocity: Some((0.0, 0.0, 0.0)),
                },
            ],
        },
        "point_gemini_live" | "gemini_live" => GestureSequence {
            name: "point_gemini_live".into(),
            description: "Centers chassis and extends arm low and straight ahead pointing at the Gemini Live totem".into(),
            rgb: (15, 118, 110), // teal
            buzzer: Some((2300, 80, 40, 1)),
            steps: vec![GestureStep {
                duration_ms: 750,
                servos: pose(500, 340, 260, 340, 500, 660),
                velocity: Some((0.08, 0.0, 0.0)),
            }],
        },
        "point_firestore" | "firestore" => GestureSequence {
            name: "point_firestore".into(),
            description: "Strafes Mecanum right and extends arm forward pointing at the Firestore totem".into(),
            rgb: (180, 83, 9), // amber
            buzzer: Some((2050, 80, 40, 1)),
            steps: vec![
                GestureStep {
                    duration_ms: 850,
                    servos: pose(390, 350, 270, 350, 500, 660),
                    velocity: Some((0.0, -0.22, 0.0)),
                },
                GestureStep {
                    duration_ms: 450,
                    servos: pose(390, 350, 270, 350, 500, 660),
                    velocity: Some((0.0, 0.0, 0.0)),
                },
            ],
        },
        "bumblebee_hype" | "bumblebee_celebrate" | "dance_hype" | "party" => GestureSequence {
            name: if key == "bumblebee_celebrate" {
                "bumblebee_celebrate".into()
            } else {
                "bumblebee_hype".into()
            },
            description: "Bumblebee high-energy dance: Mecanum side-to-side groove with 6-DOF arm pumping and gripper clapping to the beat".into(),
            rgb: (245, 158, 11), // Bumblebee gold
            buzzer: None,
            steps: vec![
                GestureStep {
                    duration_ms: 520,
                    servos: pose(640, 480, 370, 430, 320, 220),
                    velocity: Some((0.0, 0.16, 0.35)),
                },
                GestureStep {
                    duration_ms: 520,
                    servos: pose(360, 480, 370, 430, 680, 680),
                    velocity: Some((0.0, -0.16, -0.35)),
                },
                GestureStep {
                    duration_ms: 520,
                    servos: pose(620, 400, 290, 350, 340, 220),
                    velocity: Some((0.08, 0.14, 0.25)),
                },
                GestureStep {
                    duration_ms: 520,
                    servos: pose(380, 460, 350, 410, 660, 680),
                    velocity: Some((-0.08, -0.14, -0.25)),
                },
                GestureStep {
                    duration_ms: 480,
                    servos: pose(500, 430, 310, 380, 500, 340),
                    velocity: Some((0.0, 0.0, 0.0)),
                },
            ],
        },
        "bumblebee_groove" | "dance_groove" | "chill" => GestureSequence {
            name: "bumblebee_groove".into(),
            description: "Smooth Bumblebee radio groove: rhythmic figure-eight arm wave with gentle Mecanum sway".into(),
            rgb: (234, 179, 8), // warm yellow
            buzzer: None,
            steps: vec![
                GestureStep {
                    duration_ms: 600,
                    servos: pose(590, 440, 330, 400, 380, 260),
                    velocity: Some((0.0, 0.12, 0.0)),
                },
                GestureStep {
                    duration_ms: 600,
                    servos: pose(410, 410, 290, 360, 620, 580),
                    velocity: Some((0.0, -0.12, 0.0)),
                },
                GestureStep {
                    duration_ms: 600,
                    servos: pose(570, 450, 340, 410, 400, 260),
                    velocity: Some((0.0, 0.10, 0.0)),
                },
                GestureStep {
                    duration_ms: 550,
                    servos: pose(500, 430, 310, 380, 500, 420),
                    velocity: Some((0.0, 0.0, 0.0)),
                },
            ],
        },
        "bumblebee_rock_out" | "bumblebee_spin" | "rock_out" | "headbang" => GestureSequence {
            name: if key == "bumblebee_spin" {
                "bumblebee_spin".into()
            } else {
                "bumblebee_rock_out".into()
            },
            description: "Rock anthem headbang: aggressive shoulder/elbow pump with Mecanum spin bursts".into(),
            rgb: (239, 68, 68), // electric red
            buzzer: None,
            steps: vec![
                GestureStep {
                    duration_ms: 420,
                    servos: pose(500, 340, 240, 270, 500, 220),
                    velocity: Some((0.12, 0.0, 0.0)),
                },
                GestureStep {
                    duration_ms: 420,
                    servos: pose(500, 500, 390, 460, 500, 680),
                    velocity: Some((-0.12, 0.0, 0.45)),
                },
                GestureStep {
                    duration_ms: 420,
                    servos: pose(500, 340, 240, 270, 500, 220),
                    velocity: Some((0.10, 0.0, -0.45)),
                },
                GestureStep {
                    duration_ms: 480,
                    servos: pose(500, 430, 310, 380, 500, 460),
                    velocity: Some((0.0, 0.0, 0.0)),
                },
            ],
        },
        "bumblebee_romance" | "bumblebee_wave" | "romance" | "love_sway" => GestureSequence {
            name: if key == "bumblebee_wave" {
                "bumblebee_wave".into()
            } else {
                "bumblebee_romance".into()
            },
            description: "Slow romantic sway: draws gripper to chest and opens outward with a slow Mecanum waltz".into(),
            rgb: (236, 72, 153), // rose pink
            buzzer: None,
            steps: vec![
                GestureStep {
                    duration_ms: 680,
                    servos: pose(500, 500, 230, 260, 500, 660),
                    velocity: Some((0.06, 0.08, 0.15)),
                },
                GestureStep {
                    duration_ms: 720,
                    servos: pose(580, 390, 300, 370, 680, 220),
                    velocity: Some((-0.06, -0.08, -0.15)),
                },
                GestureStep {
                    duration_ms: 680,
                    servos: pose(420, 390, 300, 370, 320, 220),
                    velocity: Some((0.0, 0.06, 0.0)),
                },
                GestureStep {
                    duration_ms: 550,
                    servos: pose(500, 430, 310, 380, 500, 340),
                    velocity: Some((0.0, 0.0, 0.0)),
                },
            ],
        },
        "bumblebee_sad_droop" | "bumblebee_nod" | "sad_droop" | "heartbreak" => GestureSequence {
            name: if key == "bumblebee_nod" {
                "bumblebee_nod".into()
            } else {
                "bumblebee_sad_droop".into()
            },
            description: "Melancholic droop: lowers arm toward the floor, sways slowly left/right, and backs away".into(),
            rgb: (59, 130, 246), // sad blue
            buzzer: None,
            steps: vec![
                GestureStep {
                    duration_ms: 750,
                    servos: pose(500, 330, 230, 260, 500, 620),
                    velocity: Some((-0.08, 0.0, 0.0)),
                },
                GestureStep {
                    duration_ms: 700,
                    servos: pose(420, 320, 220, 250, 440, 640),
                    velocity: Some((0.0, 0.0, 0.0)),
                },
                GestureStep {
                    duration_ms: 700,
                    servos: pose(580, 320, 220, 250, 560, 640),
                    velocity: None,
                },
                GestureStep {
                    duration_ms: 600,
                    servos: pose(500, 410, 290, 350, 500, 500),
                    velocity: Some((0.0, 0.0, 0.0)),
                },
            ],
        },
        "bumblebee_sassy" | "bumblebee_salute" | "sassy" | "attitude" => GestureSequence {
            name: if key == "bumblebee_salute" {
                "bumblebee_salute".into()
            } else {
                "bumblebee_sassy".into()
            },
            description: "Sassy attitude snap: snaps gripper side-to-side with a Mecanum hip-check".into(),
            rgb: (168, 85, 247), // purple attitude
            buzzer: None,
            steps: vec![
                GestureStep {
                    duration_ms: 480,
                    servos: pose(660, 440, 320, 390, 260, 220),
                    velocity: Some((0.0, 0.18, 0.0)),
                },
                GestureStep {
                    duration_ms: 420,
                    servos: pose(660, 440, 320, 390, 260, 680),
                    velocity: Some((0.0, -0.18, 0.0)),
                },
                GestureStep {
                    duration_ms: 480,
                    servos: pose(340, 440, 320, 390, 740, 220),
                    velocity: Some((0.0, 0.14, 0.0)),
                },
                GestureStep {
                    duration_ms: 500,
                    servos: pose(500, 430, 310, 380, 500, 500),
                    velocity: Some((0.0, 0.0, 0.0)),
                },
            ],
        },
        _ => GestureSequence {
            name: "home".into(),
            description: "Neutral attentive stance with arm and 3D camera facing forward over the front bumper".into(),
            rgb: (15, 118, 110),
            buzzer: None,
            steps: vec![GestureStep {
                duration_ms: 500,
                servos: pose(500, 430, 310, 380, 500, 500),
                velocity: Some((0.0, 0.0, 0.0)),
            }],
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_stage_and_gatekeeper_gestures() {
        for g in [
            "home",
            "facepalm",
            "trash_toss",
            "chef_kiss",
            "suspicious_inspect",
            "victory_spin",
            "nod_yes",
            "shake_no",
            "wave_hello",
            "gatekeeper_hold",
            "gatekeeper_approve",
            "gatekeeper_reject",
            "point_cloud_run",
            "point_gemini_live",
            "point_firestore",
            "bumblebee_wave",
            "bumblebee_groove",
            "bumblebee_spin",
            "bumblebee_nod",
            "bumblebee_salute",
            "bumblebee_celebrate",
        ] {
            assert!(is_known_gesture(g), "Expected {} to be known", g);
        }
        assert!(!is_known_gesture("nonexistent_gesture"));
        assert!(!is_known_gesture(""));

        let hold = get_gesture("gatekeeper_hold");
        assert_eq!(hold.name, "gatekeeper_hold");
        assert_eq!(hold.rgb, (245, 158, 11));

        let approve = get_gesture("gatekeeper_approve");
        assert_eq!(approve.name, "gatekeeper_approve");
        assert_eq!(approve.rgb, (16, 185, 129));
        assert_eq!(approve.buzzer, Some((2500, 120, 40, 2)));
        assert_eq!(approve.steps.len(), 2);

        let reject = get_gesture("gatekeeper_reject");
        assert_eq!(reject.name, "gatekeeper_reject");
        assert_eq!(reject.rgb, (220, 38, 38));
        assert_eq!(reject.buzzer, Some((950, 200, 50, 2)));

        let cr = get_gesture("point_cloud_run");
        assert_eq!(cr.name, "point_cloud_run");
        assert_eq!(cr.rgb, (43, 74, 203));
        assert_eq!(cr.steps[0].velocity, Some((0.0, 0.22, 0.0)));

        let gl = get_gesture("point_gemini_live");
        assert_eq!(gl.name, "point_gemini_live");
        assert_eq!(gl.rgb, (15, 118, 110));

        let fs = get_gesture("point_firestore");
        assert_eq!(fs.name, "point_firestore");
        assert_eq!(fs.rgb, (180, 83, 9));
        assert_eq!(fs.steps[0].velocity, Some((0.0, -0.22, 0.0)));
    }
}
