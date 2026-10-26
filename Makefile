.PHONY: up start bridge robot web test lint reset release build-robot calibrar-sombra

BRIDGE_PORT ?= 9000
ROBOT_BACKEND ?= mock
# Token del puente: del entorno (o `make reset BRIDGE_TOKEN=...`) o del archivo .bridge-token que
# genera ./run.sh en el robot. Se lee dentro del shell y viaja a curl por stdin (`-H @-`):
# nunca aparece en argv (`ps`) ni en `make -n`.
BRIDGE_CURL = printf 'x-bridge-token: %s\n' "$${BRIDGE_TOKEN:-$$(cat .bridge-token 2>/dev/null | tr -d '[:space:]')}" | curl -s -m 3 -H @-

# Un solo comando: auto-detecta si estás en el ROSOrin Pro (ros2/serial) o en tu laptop (mock) y levanta todo
up:
	./run.sh

start:
	./run.sh

# Levantar únicamente el puente en el robot físico (:9000, 0.0.0.0 con token)
robot:
	./run.sh --bridge-only

# Start Rust robot-bridge on 127.0.0.1:9000 (mock por defecto)
bridge:
	cd robot-bridge && cargo run -- --backend $(ROBOT_BACKEND) --host 127.0.0.1 --port $(BRIDGE_PORT)

# Start Next.js web console on :3000
web:
	cd web && npm run dev

# Emergency stop: motores a 0, brazo congelado y E-stop enclavada (se libera con `make release`)
reset:
	@$(BRIDGE_CURL) -X POST http://localhost:$(BRIDGE_PORT)/stop | head -c 300; echo ""

# Liberar la E-stop enclavada (POST /estop/release)
release:
	@$(BRIDGE_CURL) -X POST http://localhost:$(BRIDGE_PORT)/estop/release | head -c 300; echo ""

# Run Rust unit tests, Python worker tests (sin rclpy) and TypeScript analyzer tests
test:
	cd robot-bridge && cargo test
	cd robot-bridge && python3 -m unittest discover -s scripts -p 'test_*.py'
	cd web && npm test

# Clippy estricto (warnings = error)
lint:
	cd robot-bridge && cargo clippy --all-targets -- -D warnings

# En el robot, con el bridge corriendo (make robot): mide dónde ve el LiDAR al brazo en cada pose
# de los gestos (solo mueve el brazo) y guarda la banda en robot-bridge/arm-shadow.json.
calibrar-sombra:
	bash -c 'source /opt/ros/humble/setup.bash 2>/dev/null; python3 robot-bridge/scripts/calibrar_sombra.py'

# Build release binary on Jetson Orin Nano
build-robot:
	cd robot-bridge && cargo build --release
