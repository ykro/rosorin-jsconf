.PHONY: up start bridge robot web test reset build-robot

BRIDGE_PORT ?= 9000
ROBOT_BACKEND ?= mock

# Un solo comando: auto-detecta si estás en el ROSOrin Pro (ros2/serial) o en tu laptop (mock) y levanta todo
up:
	./run.sh

start:
	./run.sh

# Levantar únicamente el puente en el robot físico (:9000)
robot:
	./run.sh --bridge-only

# Start Rust robot-bridge on :9000
bridge:
	cd robot-bridge && cargo run -- --backend $(ROBOT_BACKEND) --port $(BRIDGE_PORT)

# Start Next.js web console on :3000
web:
	cd web && npm run dev

# Emergency stop all motors and freeze arm in <1s
reset:
	curl -s -X POST http://localhost:$(BRIDGE_PORT)/stop | head -c 300; echo ""

# Run both Rust unit tests and TypeScript analyzer tests
test:
	cd robot-bridge && cargo test
	cd web && npm test

# Build release binary on Jetson Orin Nano
build-robot:
	cd robot-bridge && cargo build --release
