# Skills para agentes de código

Estos 3 skills documentan el hardware, la sesión de Gemini Live y el gemelo 3D tal como están en el código:

| Skill | Qué cubre |
|---|---|
| [`rosorin-pro`](./rosorin-pro/SKILL.md) | Servos (IDs 1 a 5 y pinza 10, nunca 6), límites por articulación, protocolo STM32 (`0xAA 0x55`, CRC8, 1 Mbps), tópicos de ROS 2, LiDAR por sectores con sombra del brazo y sectores ciegos, *heartbeat* del worker, freno por eje, campo `blocked`, E-stop y token. |
| [`gemini-live-js`](./gemini-live-js/SKILL.md) | Sesión Live con reanudación y compresión, `goAway` al terminar el turno, estados de conexión, audio 16/24 kHz, barge-in por generación, herramientas bloqueantes con resultado real (`blocked` nunca es éxito), turnos sin herramientas (`tool_disabled`) y datos no confiables. |
| [`threejs-urdf-twin`](./threejs-urdf-twin/SKILL.md) | Mallas STL del fabricante, cadena URDF `J1..J5` y pinza paralela, suavizado independiente de los FPS y limpieza de recursos. |

Las reglas para agentes que trabajen en este repo están en [`AGENTS.md`](../AGENTS.md).
