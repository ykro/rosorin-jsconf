#!/usr/bin/env python3
"""
Generates a true 1:1 physical scale 5-page printable PDF for the JSConf MX stage props:
- Page 1: Demo B Production Deploy Key (65 x 110 mm front + back foldable card with 22 mm grip shaft for Servo ID 10 + 100 mm calibration ruler)
- Page 2: Demo B Stage Drop Mats (DEPLOY APPROVED Green Tray + DEPLOY REJECTED Red Tray, 180 x 110 mm each)
- Page 3: Demo C Self-Standing Tent Totem 01 — CLOUD RUN (Left, Y = +20 cm, Google Blue #1A73E8)
- Page 4: Demo C Self-Standing Tent Totem 02 — GEMINI LIVE (Center, Y = 0 cm, Google Green #1E8E3E)
- Page 5: Demo C Self-Standing Tent Totem 03 — FIRESTORE (Right, Y = -20 cm, Google Yellow #F9AB00)
"""

import subprocess

HTML_CONTENT = """<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>ROSOrin Pro — Stage Props 1:1 (JSConf MX)</title>
<style>
  @page {
    size: letter portrait;
    margin: 10mm;
  }
  * {
    box-sizing: border-box;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  body {
    margin: 0;
    padding: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #202124;
    background: #FFFFFF;
  }
  .page {
    width: 195.9mm;
    height: 259.4mm;
    page-break-after: always;
    break-after: page;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 4mm;
    position: relative;
  }
  .page:last-child {
    page-break-after: auto;
    break-after: auto;
  }
  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 0.5mm solid #DADCE0;
    padding-bottom: 2.5mm;
  }
  .badge {
    display: inline-block;
    padding: 1.2mm 3mm;
    border-radius: 2mm;
    font-size: 8.5pt;
    font-weight: 800;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .title-sm {
    font-size: 11pt;
    font-weight: 800;
    color: #202124;
  }
  .instructions {
    background: #F8F9FA;
    border: 0.4mm solid #DADCE0;
    border-radius: 3mm;
    padding: 3mm 4mm;
    font-size: 9pt;
    line-height: 1.4;
    color: #3C4043;
  }

  /* PAGE 1: DEPLOY KEY 1:1 */
  .deploy-key-wrapper {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    margin: 4mm 0;
  }
  .foldable-key {
    display: flex;
    flex-direction: row;
    border: 0.7mm dashed #202124;
    border-radius: 4mm;
    background: #FFFFFF;
  }
  .key-face {
    width: 65mm;
    height: 115mm;
    padding: 5mm;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: center;
    background: #FEF7E0;
  }
  .key-face.front {
    border-right: 0.6mm dashed #D93025;
  }
  .grip-tab {
    width: 24mm;
    height: 30mm;
    background: #202124;
    color: #FFFFFF;
    border: 0.8mm solid #F9AB00;
    border-radius: 2.5mm;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 2mm;
  }
  .grip-stripes {
    width: 18mm;
    height: 8mm;
    margin-top: 1.5mm;
    background: repeating-linear-gradient(
      0deg,
      #F9AB00,
      #F9AB00 1.2mm,
      #202124 1.2mm,
      #202124 2.4mm
    );
    border-radius: 1mm;
  }

  /* CALIBRATION RULER */
  .ruler-box {
    border: 0.4mm solid #202124;
    border-radius: 2.5mm;
    padding: 3mm 5mm;
    background: #F8F9FA;
  }
  .ruler-bar {
    width: 100mm;
    height: 6mm;
    border-bottom: 0.6mm solid #202124;
    border-left: 0.6mm solid #202124;
    border-right: 0.6mm solid #202124;
    display: flex;
    position: relative;
    margin-top: 2mm;
    background: linear-gradient(90deg, #1A73E8 0%, #1A73E8 18%, #E8F0FE 18%, #E8F0FE 100%);
  }

  /* PAGE 2: TRAYS */
  .tray-mat {
    width: 186mm;
    height: 108mm;
    border-width: 1.2mm;
    border-style: dashed;
    border-radius: 6mm;
    padding: 7mm;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: center;
    text-align: center;
  }
  .drop-circle {
    width: 56mm;
    height: 56mm;
    border-radius: 50%;
    border-width: 1mm;
    border-style: dashed;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-weight: 800;
  }

  /* PAGES 3-5: FOLDABLE TENT TOTEMS */
  .totem-sheet {
    width: 182mm;
    margin: 0 auto;
    border: 0.8mm dashed #202124;
    border-radius: 4mm;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .totem-flap {
    height: 32mm;
    background: #F1F3F4;
    border-bottom: 0.6mm dashed #5F6368;
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    font-size: 9pt;
    font-weight: 700;
    color: #5F6368;
  }
  .totem-back {
    height: 82mm;
    background: #F8F9FA;
    border-bottom: 1mm dashed #202124;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    transform: rotate(180deg);
    padding: 5mm;
    text-align: center;
  }
  .totem-front {
    height: 105mm;
    border-bottom: 0.6mm dashed #5F6368;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: space-between;
    padding: 7mm;
    text-align: center;
    background: #FFFFFF;
  }
</style>
</head>
<body>

<!-- PAGE 1: PRODUCTION DEPLOY KEY (DEMO B) -->
<div class="page">
  <div class="page-header">
    <span class="title-sm">PÁGINA 1/5 · DEMO B: LLAVE DE DEPLOY FÍSICA (ESCALA REAL 1:1)</span>
    <span class="badge" style="background:#E6F4EA; color:#1E8E3E;">SERVO ID 10 · PINZA PARALELA</span>
  </div>

  <div class="instructions">
    <strong>Instrucciones de armado (Escala 1:1 verificada):</strong><br/>
    1. Imprime en <strong>Tamaño Real / Escala 100%</strong> (sin ajustar a página). Verifica con una regla la barra inferior de <strong>100 mm</strong>.<br/>
    2. Recorta el rectángulo exterior punteado (<strong>130 × 115 mm</strong>) y dóblalo por la línea roja central para obtener una tarjeta rígida doble cara de <strong>65 × 115 mm</strong> (puedes pegar cartulina o foamboard en medio).<br/>
    3. En Demo B, pulsa <strong>Sujetar Llave</strong> y coloca la pestaña negra superior (<strong>24 mm</strong> de ancho) entre los dedos de la pinza (Servo ID 10, pulso cerrado <code>680</code>, pulso abierto <code>220</code>).
  </div>

  <div class="deploy-key-wrapper">
    <div style="font-size:8.5pt; font-weight:800; color:#D93025; margin-bottom:2mm;">
      ▼ LÍNEA DE DOBLEZ CENTRAL (DOBLAR A LA MITAD Y PEGAR) ▼
    </div>
    <div class="foldable-key">
      <!-- FRONT FACE (65 x 115 mm) -->
      <div class="key-face front">
        <div class="grip-tab">
          <div style="font-size:6.5pt; font-weight:800; color:#F9AB00; letter-spacing:0.05em;">AGARRE SERVO 10</div>
          <div style="font-size:7.5pt; font-weight:800;">ANCHO 24 mm</div>
          <div class="grip-stripes"></div>
        </div>

        <div style="text-align:center;">
          <div style="font-size:8pt; font-weight:800; color:#B06000; letter-spacing:0.08em;">JSCONF MX · CI/CD</div>
          <div style="font-size:17pt; font-weight:900; line-height:1.05; color:#202124; margin-top:1.5mm;">
            PRODUCTION<br/>DEPLOY KEY
          </div>
          <div style="margin-top:3mm; display:inline-block; background:#1E8E3E; color:#FFFFFF; font-weight:800; font-size:9pt; padding:1.5mm 4mm; border-radius:2mm;">
            RELEASE #408
          </div>
        </div>

        <div style="font-size:7.5pt; font-weight:700; color:#5F6368; border-top:0.3mm solid #DADCE0; width:100%; text-align:center; padding-top:2mm;">
          CARA FRONTAL · 65 × 115 mm
        </div>
      </div>

      <!-- BACK FACE (65 x 115 mm) -->
      <div class="key-face">
        <div class="grip-tab">
          <div style="font-size:6.5pt; font-weight:800; color:#F9AB00; letter-spacing:0.05em;">AGARRE SERVO 10</div>
          <div style="font-size:7.5pt; font-weight:800;">PULSO 680 → 220</div>
          <div class="grip-stripes"></div>
        </div>

        <div style="text-align:center;">
          <div style="font-size:8pt; font-weight:800; color:#B06000; letter-spacing:0.08em;">GATEKEEPER AGENT</div>
          <div style="font-size:17pt; font-weight:900; line-height:1.05; color:#202124; margin-top:1.5mm;">
            PRODUCTION<br/>DEPLOY KEY
          </div>
          <div style="margin-top:3mm; display:inline-block; background:#1A73E8; color:#FFFFFF; font-weight:800; font-size:9pt; padding:1.5mm 4mm; border-radius:2mm;">
            GEMINI LIVE
          </div>
        </div>

        <div style="font-size:7.5pt; font-weight:700; color:#5F6368; border-top:0.3mm solid #DADCE0; width:100%; text-align:center; padding-top:2mm;">
          CARA TRASERA · 65 × 115 mm
        </div>
      </div>
    </div>
  </div>

  <div class="ruler-box">
    <div style="display:flex; justify-content:space-between; font-size:8.5pt; font-weight:800;">
      <span>REGLA DE VERIFICACIÓN DE IMPRESIÓN 1:1 (DEBE MEDIR EXACTAMENTE 100 mm)</span>
      <span style="color:#1A73E8;">ZONA AZUL = 18 mm (APERTURA MÍNIMA PINZA)</span>
    </div>
    <div class="ruler-bar"></div>
    <div style="display:flex; justify-content:space-between; width:100mm; font-size:7.5pt; font-weight:700; margin-top:1mm;">
      <span>0 mm</span>
      <span>18 mm</span>
      <span>50 mm</span>
      <span>100 mm</span>
    </div>
  </div>
</div>

<!-- PAGE 2: STAGE DROP MATS FOR DEMO B (GREEN TRAY & RED TRAY) -->
<div class="page">
  <div class="page-header">
    <span class="title-sm">PÁGINA 2/5 · DEMO B: BANDEJAS DE DESTINO EN MESA (APROBADO / RECHAZADO)</span>
    <span class="badge" style="background:#E8F0FE; color:#1A73E8;">DEMO B · GATEKEEPER</span>
  </div>

  <!-- GREEN TRAY MAT -->
  <div class="tray-mat" style="border-color:#1E8E3E; background:#E6F4EA;">
    <div style="width:100%; display:flex; justify-content:space-between; font-size:9pt; font-weight:800; color:#1E8E3E;">
      <span>BANDEJA IZQUIERDA · COLOCAR A 18 CM A LA IZQUIERDA DEL ROBOT</span>
      <span>POSE: JOINT 1 = 680 · SERVO 10 = 220</span>
    </div>

    <div class="drop-circle" style="border-color:#1E8E3E; background:#FFFFFF; color:#1E8E3E;">
      <span style="font-size:8pt;">ZONA DE CAÍDA</span>
      <span style="font-size:13pt; margin-top:1mm;">LLAVE OK</span>
    </div>

    <div>
      <div style="font-size:24pt; font-weight:900; color:#1E8E3E; letter-spacing:0.02em;">
        DEPLOY APROBADO · PRODUCCIÓN
      </div>
      <div style="font-size:9.5pt; font-weight:700; color:#137333; margin-top:1mm;">
        Tests en verde + Plan de Rollback verificado por Gemini Live
      </div>
    </div>
  </div>

  <!-- RED TRAY MAT -->
  <div class="tray-mat" style="border-color:#D93025; background:#FCE8E6;">
    <div style="width:100%; display:flex; justify-content:space-between; font-size:9pt; font-weight:800; color:#D93025;">
      <span>BANDEJA DERECHA · COLOCAR A 18 CM A LA DERECHA DEL ROBOT</span>
      <span>POSE: JOINT 1 = 260 · SERVO 10 = 220</span>
    </div>

    <div class="drop-circle" style="border-color:#D93025; background:#FFFFFF; color:#D93025;">
      <span style="font-size:8pt;">ZONA DE RECHAZO</span>
      <span style="font-size:13pt; margin-top:1mm;">BLOCKED</span>
    </div>

    <div>
      <div style="font-size:24pt; font-weight:900; color:#D93025; letter-spacing:0.02em;">
        DEPLOY RECHAZADO · ROLLBACK
      </div>
      <div style="font-size:9.5pt; font-weight:700; color:#B3261E; margin-top:1mm;">
        PR bloqueado físicamente por falta de pruebas o riesgo en producción
      </div>
    </div>
  </div>
</div>

<!-- PAGE 3: TOTEM 01 - CLOUD RUN (LEFT) -->
<div class="page">
  <div class="page-header">
    <span class="title-sm">PÁGINA 3/5 · DEMO C: TÓTEM PLEGABLE 01 — CLOUD RUN (IZQUIERDA)</span>
    <span class="badge" style="background:#E8F0FE; color:#1A73E8;">Y = +20 CM · IZQUIERDA</span>
  </div>

  <div class="totem-sheet">
    <div class="totem-flap">
      ▲ PESTAÑA SUPERIOR DE BASE (DOBLAR HACIA ADENTRO Y PEGAR CON LA BASE INFERIOR) ▲
    </div>

    <div class="totem-back">
      <div style="font-size:11pt; font-weight:800; color:#1A73E8;">TÓTEM 01 · IZQUIERDA DEL ROBOT (Y = +20 CM)</div>
      <div style="font-size:22pt; font-weight:900; color:#202124; margin-top:2mm;">CLOUD RUN</div>
      <div style="font-size:9pt; font-weight:600; color:#5F6368; margin-top:2mm;">
        Vista para el presentador · Colocar a 42 cm frente al chasis y 20 cm a la izquierda
      </div>
    </div>

    <div class="totem-front" style="border-top:2mm solid #1A73E8;">
      <div style="width:100%; display:flex; justify-content:space-between; align-items:center;">
        <span class="badge" style="background:#1A73E8; color:#FFFFFF;">SERVICIO 01 · IZQUIERDA</span>
        <span style="font-size:9pt; font-weight:800; color:#1A73E8;">STRAFE IZQ · JOINT 1 = 560</span>
      </div>

      <div>
        <div style="display:inline-block; width:22mm; height:22mm; line-height:22mm; border-radius:5mm; background:#1A73E8; color:#FFFFFF; font-size:24pt; font-weight:900;">
          CR
        </div>
        <div style="font-size:38pt; font-weight:900; color:#202124; letter-spacing:-0.02em; line-height:1.05; margin-top:3mm;">
          CLOUD RUN
        </div>
        <div style="font-size:12pt; font-weight:700; color:#5F6368; margin-top:1.5mm;">
          Contenedores Serverless &amp; API Gateway (512 MiB OOM)
        </div>
      </div>

      <div style="font-size:8.5pt; font-weight:700; color:#5F6368;">
        ▼ DOBLAR BASE AQUÍ PARA FORMAR EL PRISMA TRIANGULAR DE MESA ▼
      </div>
    </div>

    <div class="totem-flap">
      ▼ PESTAÑA INFERIOR DE BASE (42 CM FRENTE AL ROBOT · 20 CM A LA IZQUIERDA) ▼
    </div>
  </div>
</div>

<!-- PAGE 4: TOTEM 02 - GEMINI LIVE (CENTER) -->
<div class="page">
  <div class="page-header">
    <span class="title-sm">PÁGINA 4/5 · DEMO C: TÓTEM PLEGABLE 02 — GEMINI LIVE (CENTRO)</span>
    <span class="badge" style="background:#E6F4EA; color:#1E8E3E;">Y = 0 CM · CENTRO</span>
  </div>

  <div class="totem-sheet">
    <div class="totem-flap">
      ▲ PESTAÑA SUPERIOR DE BASE (DOBLAR HACIA ADENTRO Y PEGAR CON LA BASE INFERIOR) ▲
    </div>

    <div class="totem-back">
      <div style="font-size:11pt; font-weight:800; color:#1E8E3E;">TÓTEM 02 · CENTRO FRENTE AL ROBOT (Y = 0 CM)</div>
      <div style="font-size:22pt; font-weight:900; color:#202124; margin-top:2mm;">GEMINI LIVE</div>
      <div style="font-size:9pt; font-weight:600; color:#5F6368; margin-top:2mm;">
        Vista para el presentador · Colocar a 42 cm justo frente al chasis del robot
      </div>
    </div>

    <div class="totem-front" style="border-top:2mm solid #1E8E3E;">
      <div style="width:100%; display:flex; justify-content:space-between; align-items:center;">
        <span class="badge" style="background:#1E8E3E; color:#FFFFFF;">SERVICIO 02 · CENTRO</span>
        <span style="font-size:9pt; font-weight:800; color:#1E8E3E;">CENTRO · JOINT 1 = 500</span>
      </div>

      <div>
        <div style="display:inline-block; width:22mm; height:22mm; line-height:22mm; border-radius:5mm; background:#1E8E3E; color:#FFFFFF; font-size:24pt; font-weight:900;">
          GL
        </div>
        <div style="font-size:38pt; font-weight:900; color:#202124; letter-spacing:-0.02em; line-height:1.05; margin-top:3mm;">
          GEMINI LIVE
        </div>
        <div style="font-size:12pt; font-weight:700; color:#5F6368; margin-top:1.5mm;">
          WebSocket Audio PCM 16 kHz / 24 kHz &amp; Barge-In Queue
        </div>
      </div>

      <div style="font-size:8.5pt; font-weight:700; color:#5F6368;">
        ▼ DOBLAR BASE AQUÍ PARA FORMAR EL PRISMA TRIANGULAR DE MESA ▼
      </div>
    </div>

    <div class="totem-flap">
      ▼ PESTAÑA INFERIOR DE BASE (42 CM FRENTE AL ROBOT · CENTRO Y = 0 CM) ▼
    </div>
  </div>
</div>

<!-- PAGE 5: TOTEM 03 - FIRESTORE (RIGHT) -->
<div class="page">
  <div class="page-header">
    <span class="title-sm">PÁGINA 5/5 · DEMO C: TÓTEM PLEGABLE 03 — FIRESTORE (DERECHA)</span>
    <span class="badge" style="background:#FEF7E0; color:#B06000;">Y = -20 CM · DERECHA</span>
  </div>

  <div class="totem-sheet">
    <div class="totem-flap">
      ▲ PESTAÑA SUPERIOR DE BASE (DOBLAR HACIA ADENTRO Y PEGAR CON LA BASE INFERIOR) ▲
    </div>

    <div class="totem-back">
      <div style="font-size:11pt; font-weight:800; color:#B06000;">TÓTEM 03 · DERECHA DEL ROBOT (Y = -20 CM)</div>
      <div style="font-size:22pt; font-weight:900; color:#202124; margin-top:2mm;">FIRESTORE</div>
      <div style="font-size:9pt; font-weight:600; color:#5F6368; margin-top:2mm;">
        Vista para el presentador · Colocar a 42 cm frente al chasis y 20 cm a la derecha
      </div>
    </div>

    <div class="totem-front" style="border-top:2mm solid #F9AB00;">
      <div style="width:100%; display:flex; justify-content:space-between; align-items:center;">
        <span class="badge" style="background:#F9AB00; color:#202124;">SERVICIO 03 · DERECHA</span>
        <span style="font-size:9pt; font-weight:800; color:#B06000;">STRAFE DER · JOINT 1 = 440</span>
      </div>

      <div>
        <div style="display:inline-block; width:22mm; height:22mm; line-height:22mm; border-radius:5mm; background:#F9AB00; color:#202124; font-size:24pt; font-weight:900;">
          FS
        </div>
        <div style="font-size:38pt; font-weight:900; color:#202124; letter-spacing:-0.02em; line-height:1.05; margin-top:3mm;">
          FIRESTORE
        </div>
        <div style="font-size:12pt; font-weight:700; color:#5F6368; margin-top:1.5mm;">
          Estado en Tiempo Real &amp; Índices Compuestos (`FAILED_PRECONDITION`)
        </div>
      </div>

      <div style="font-size:8.5pt; font-weight:700; color:#5F6368;">
        ▼ DOBLAR BASE AQUÍ PARA FORMAR EL PRISMA TRIANGULAR DE MESA ▼
      </div>
    </div>

    <div class="totem-flap">
      ▼ PESTAÑA INFERIOR DE BASE (42 CM FRENTE AL ROBOT · 20 CM A LA DERECHA) ▼
    </div>
  </div>
</div>

</body>
</html>
"""

import shutil
import tempfile
from pathlib import Path

DOCS_DIR = Path(__file__).resolve().parent
REPO_ROOT = DOCS_DIR.parent
PUBLIC_PROPS_DIR = REPO_ROOT / "web" / "public" / "props"
DOCS_DIR.mkdir(parents=True, exist_ok=True)
PUBLIC_PROPS_DIR.mkdir(parents=True, exist_ok=True)

html_path = Path(tempfile.gettempdir()) / "rosorin_stage_props_print.html"
html_path.write_text(HTML_CONTENT, encoding="utf-8")

pdf_out_1 = DOCS_DIR / "rosorin-stage-props-print.pdf"
pdf_out_2 = PUBLIC_PROPS_DIR / "rosorin-stage-props-print.pdf"

chrome_bin = (
    shutil.which("google-chrome")
    or shutil.which("chromium")
    or "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
)
subprocess.run(
    [
        chrome_bin,
        "--headless",
        "--disable-gpu",
        "--no-pdf-header-footer",
        f"--print-to-pdf={pdf_out_1}",
        f"file://{html_path}",
    ],
    check=True,
)

shutil.copyfile(pdf_out_1, pdf_out_2)
print("Generated:", pdf_out_1, "and", pdf_out_2)
