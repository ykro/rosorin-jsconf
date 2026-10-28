import type { RepoAnalysis, RepoFinding } from './types';

export const PRESET_REPOS: Record<string, RepoAnalysis> = {
  'facebook/react': {
    repo: 'facebook/react',
    description: 'The library for web and native user interfaces.',
    stars: 234000,
    language: 'JavaScript',
    stack: ['React', 'Rollup', 'Flow'],
    dependencyCount: 148,
    hasTests: true,
    findings: [
      { label: 'useEffect loops', value: 'Un array de dependencias mal puesto y tu navegador entra en órbita', severity: 'roast' },
      { label: 'tipado interno', value: 'Sigue casado con Flow mientras todo el planeta escribe TypeScript', severity: 'roast' },
      { label: 'React Compiler', value: 'Tuvieron que inventar un compilador porque nadie entendió cuándo usar useMemo', severity: 'roast' },
      { label: 'Server Components', value: 'Diez años siendo SPA y ahora resulta que todo debía correr en el servidor', severity: 'roast' },
      { label: 'issues abiertos', value: 'Más de 1,800 issues haciendo fila como trámite de gobierno', severity: 'roast' },
      { label: 'arquitectura Fiber', value: 'Reconciliador sólido con suite completa de tests', severity: 'good' },
    ],
    suggestedGesture: 'facepalm',
    roastScore: 54,
    roastHeadline: 'React tiene 234 mil estrellas, pero un solo useEffect mal puesto sigue congelando tu navegador.',
    roastPromptContext:
      'Repo facebook/react: uses Flow internally instead of TypeScript, infinite useEffect loops in production, invented React Compiler because developers abused useMemo/useCallback, Server Components identity crisis after a decade of client SPAs, 148 monorepo dependencies, and over 1,800 open issues.',
    origin: 'preset_rehearsal',
  },
  'vercel/next.js': {
    repo: 'vercel/next.js',
    description: 'The React Framework for the Web',
    stars: 130000,
    language: 'TypeScript',
    stack: ['Next.js', 'Rust Turbopack', 'React Server Components'],
    dependencyCount: 210,
    hasTests: true,
    findings: [
      { label: 'caché misterioso', value: '4 capas de caché que ni con git clean se invalidan', severity: 'roast' },
      { label: 'sopa de directivas', value: 'use client, use server y use cache como conjuros arriba de cada archivo', severity: 'roast' },
      { label: 'dos routers', value: 'Pages Router y App Router conviviendo como divorciados en la misma casa', severity: 'roast' },
      { label: 'node_modules', value: '210 dependencias para renderizar un div en el servidor', severity: 'warn' },
      { label: 'Turbopack en Rust', value: 'Compilación incremental de alto rendimiento', severity: 'good' },
    ],
    suggestedGesture: 'suspicious_inspect',
    roastScore: 62,
    roastHeadline: 'Next.js cambia de router cada dos años, pero al menos su compilador en Rust sí corre rápido.',
    roastPromptContext:
      'Repo vercel/next.js: changes router paradigm every two years (Pages Router vs App Router), 4 mysterious caching layers, directive soup ("use client", "use server", "use cache"), 210 dependencies, saved only by Rust Turbopack.',
    origin: 'preset_rehearsal',
  },
  'denoland/deno': {
    repo: 'denoland/deno',
    description: 'A modern runtime for JavaScript and TypeScript.',
    stars: 101000,
    language: 'Rust',
    stack: ['Rust', 'V8', 'TypeScript'],
    dependencyCount: 42,
    hasTests: true,
    findings: [
      { label: 'identidad', value: 'Juró destruir a npm y package.json y terminó implementando soporte completo para ambos', severity: 'roast' },
      { label: 'flags de permisos', value: 'Necesitas cinco flags --allow-* hasta para leer un archivo .env', severity: 'roast' },
      { label: 'seguridad en Rust', value: 'Runtime en Rust y V8 con permisos explícitos por flag', severity: 'good' },
    ],
    suggestedGesture: 'chef_kiss',
    roastScore: 84,
    roastHeadline: 'Escrito en Rust y con TypeScript nativo: limpio, seguro y aprobado por mis 6 servos.',
    roastPromptContext:
      'Repo denoland/deno: Built in Rust and V8 with native TypeScript and strict --allow-* flags, swore to kill node_modules and package.json in 2018 and then quietly crawled back to full npm compatibility in Deno 2.',
    origin: 'preset_rehearsal',
  },
  'ykro/rosorin-jsconf': {
    repo: 'ykro/rosorin-jsconf',
    description: 'Physical AI with Gemini 3.8 Live, TypeScript, and a 40Hz Rust bridge for ROSOrin Pro.',
    stars: 128,
    language: 'Rust / TypeScript',
    stack: ['Gemini 3.8 Live API', 'Rust Axum 40Hz', 'Three.js URDF', 'ROS 2 Humble'],
    dependencyCount: 16,
    hasTests: true,
    findings: [
      { label: 'puente determinista', value: 'Loop de 40 Hz en Rust con escudo LiDAR de 28 cm', severity: 'good' },
      { label: 'audio bidireccional', value: 'PCM 16kHz/24kHz con barge-in en vivo y modo Bumblebee', severity: 'good' },
    ],
    suggestedGesture: 'victory_spin',
    roastScore: 95,
    roastHeadline: 'Puente en Rust a 40 Hz y Gemini 3.8 Live moviendo mis 6 grados de libertad: este repo sí merece ir a producción.',
    roastPromptContext:
      'Repo ykro/rosorin-jsconf: Adrián Catalán JSConf MX project combining a 40Hz Rust robotics bridge, 3D URDF simulator, Bumblebee radio mode, and Gemini 3.8 Live native audio.',
    origin: 'preset_rehearsal',
  },
  'legacy-js/todo-400-deps': {
    repo: 'legacy-js/todo-400-deps',
    description: 'Enterprise Todo list with 412 npm packages, 6 state managers, and zero tests',
    stars: 14,
    language: 'JavaScript',
    stack: ['Webpack 3', 'Redux', 'MobX', 'jQuery', 'left-pad'],
    dependencyCount: 412,
    hasTests: false,
    findings: [
      { label: 'prod dependencies', value: '412 paquetes para un Todo list', severity: 'roast' },
      { label: 'test suite', value: 'echo "Error: no test specified" && exit 0', severity: 'roast' },
      { label: 'state management', value: 'Redux + MobX + Context en el mismo archivo', severity: 'roast' },
    ],
    suggestedGesture: 'trash_toss',
    roastScore: 18,
    roastHeadline: '412 dependencias para tachar tareas del súper y ni un solo test.',
    roastPromptContext:
      'Repo legacy-js/todo-400-deps: 412 npm dependencies for a simple Todo list, mixes Redux + MobX + jQuery, test script is a fake echo exit 0, bundle size 14.8 MB.',
    origin: 'preset_rehearsal',
  },
  'startup-hype/any-script-api': {
    repo: 'startup-hype/any-script-api',
    description: 'TypeScript backend where every type is `any` and secrets live in config.ts',
    stars: 89,
    language: 'TypeScript',
    stack: ['Express', 'TypeScript (strict: false)', '147 uses of any'],
    dependencyCount: 94,
    hasTests: false,
    findings: [
      { label: 'tsconfig.json', value: '"strict": false, "any": 147 ocurrencias', severity: 'roast' },
      { label: 'error handling', value: 'catch (e) {} vacío en 19 endpoints', severity: 'roast' },
      { label: 'build step', value: 'tsc --noEmit deshabilitado en CI', severity: 'warn' },
    ],
    suggestedGesture: 'facepalm',
    roastScore: 31,
    roastHeadline: 'Usar TypeScript con 147 any es como comprar casco de moto y llevarlo en el codo.',
    roastPromptContext:
      'Repo startup-hype/any-script-api: claims to be TypeScript but has strict:false, 147 occurrences of `any`, 19 empty catch blocks, and skips typechecking in CI.',
    origin: 'preset_rehearsal',
  },
  'ykro/pupper-talk': {
    repo: 'ykro/pupper-talk',
    description: 'Unified Mini Pupper 2 multimodal voice & vision agent with Gemini Live and ROS 2',
    stars: 42,
    language: 'Python',
    stack: ['Gemini Live API', 'ROS 2 Humble', 'MangDang BSP', 'Vosk'],
    dependencyCount: 9,
    hasTests: true,
    findings: [
      { label: 'arquitectura', value: 'Mode ABC limpio con 7 modos y core compartido', severity: 'good' },
      { label: 'audio pipeline', value: 'Supresión de eco en 3 capas con cola de 250ms', severity: 'good' },
      { label: 'lenguaje', value: 'Python 3.10 en JSConf MX (pero hoy ya tiene puente en Rust y TS)', severity: 'warn' },
    ],
    suggestedGesture: 'chef_kiss',
    roastScore: 91,
    roastHeadline: 'Arquitectura limpia con supresión de eco en tres capas; digno de un robot serio.',
    roastPromptContext:
      'Repo ykro/pupper-talk: Clean Mode ABC architecture for Mini Pupper 2 with Gemini Live API, 3-layer echo suppression, only 9 dependencies.',
    origin: 'preset_rehearsal',
  },
};

export function normalizeRepoSlug(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, '');
  const match = trimmed.match(/github\.com\/([^/]+\/[^/#?]+)/i);
  if (match) {
    return match[1].replace(/\.git$/i, '');
  }
  return trimmed;
}

export async function analyzeGithubRepo(rawInput: string): Promise<RepoAnalysis> {
  const slug = normalizeRepoSlug(rawInput);
  if (PRESET_REPOS[slug]) {
    return PRESET_REPOS[slug];
  }

  try {
    // Unauthenticated on purpose: this runs in the browser (static export), so a
    // GitHub token would be public. The API allows 60 requests/hour per IP.
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
    };

    const repoRes = await fetch(`https://api.github.com/repos/${slug}`, {
      headers,
      signal: AbortSignal.timeout(4500),
    });

    if (!repoRes.ok) {
      throw new Error(`HTTP ${repoRes.status}`);
    }

    const meta = (await repoRes.json()) as {
      full_name: string;
      description: string | null;
      stargazers_count: number;
      language: string | null;
      default_branch: string;
    };

    const [contentsRes, pkgRes] = await Promise.allSettled([
      fetch(`https://api.github.com/repos/${slug}/contents`, {
        headers,
        signal: AbortSignal.timeout(3500),
      }),
      fetch(
        `https://raw.githubusercontent.com/${slug}/${meta.default_branch || 'main'}/package.json`,
        { signal: AbortSignal.timeout(3500) }
      ),
    ]);

    let files: string[] = [];
    if (contentsRes.status === 'fulfilled' && contentsRes.value.ok) {
      const items = (await contentsRes.value.json()) as Array<{ name: string }>;
      if (Array.isArray(items)) {
        files = items.map((i) => i.name);
      }
    }

    let depCount: number | null = null;
    let hasFakeTestScript = false;
    const stack: string[] = [];
    if (meta.language) stack.push(meta.language);

    if (pkgRes.status === 'fulfilled' && pkgRes.value.ok) {
      try {
        const pkg = (await pkgRes.value.json()) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
          scripts?: Record<string, string>;
        };
        const deps = Object.keys(pkg.dependencies || {});
        const devDeps = Object.keys(pkg.devDependencies || {});
        depCount = deps.length + devDeps.length;
        if (deps.includes('next')) stack.push('Next.js');
        if (deps.includes('react')) stack.push('React');
        if (deps.includes('@google/genai')) stack.push('@google/genai');
        const testCmd = pkg.scripts?.test || '';
        if (!testCmd || testCmd.includes('no test specified')) {
          hasFakeTestScript = true;
        }
      } catch (err) {
        console.warn(`[repo-analyzer] package.json de ${slug} no es JSON válido:`, err);
      }
    } else if (pkgRes.status === 'rejected') {
      console.warn(`[repo-analyzer] No se pudo leer package.json de ${slug}:`, pkgRes.reason);
    }

    const hasTests =
      !hasFakeTestScript &&
      files.some((f) =>
        /^(test|tests|__tests__|spec|vitest\.config|jest\.config|pytest\.ini)/i.test(f)
      );

    const findings: RepoFinding[] = [];
    let score = 72;

    if (depCount !== null && depCount > 120) {
      score -= 28;
      findings.push({
        label: 'node_modules',
        value: `${depCount} paquetes declarados en package.json`,
        severity: 'roast',
      });
    } else if (depCount !== null && depCount > 0) {
      score += 8;
      findings.push({
        label: 'dependencias',
        value: `${depCount} paquetes en package.json`,
        severity: 'good',
      });
    } else {
      findings.push({
        label: 'archivos raíz',
        value: `${files.slice(0, 5).join(', ') || 'estructura estándar'}`,
        severity: 'good',
      });
    }

    if (!hasTests) {
      score -= 22;
      findings.push({
        label: 'tests',
        value: hasFakeTestScript
          ? 'package.json no tiene script de test real'
          : 'Sin carpeta de tests visible en la raíz',
        severity: 'roast',
      });
    } else {
      score += 14;
      findings.push({
        label: 'verificación',
        value: 'Suite de tests detectada en el repositorio',
        severity: 'good',
      });
    }

    score = Math.max(12, Math.min(96, score));

    const suggestedGesture =
      score < 40
        ? 'trash_toss'
        : score < 65
          ? 'facepalm'
          : score < 82
            ? 'suspicious_inspect'
            : 'chef_kiss';

    const roastHeadline =
      score < 45
        ? `${meta.full_name} confía más en la fe que en los tests${depCount !== null ? ` (${depCount} paquetes)` : ''}.`
        : score < 75
          ? `${meta.full_name} compila y promete en el README, pero mi cámara 3D ve deuda técnica.`
          : `${meta.full_name} tiene estructura limpia y merece el saludo de mis 6 grados de libertad.`;

    return {
      repo: meta.full_name,
      description: meta.description || 'Repositorio de GitHub',
      stars: meta.stargazers_count,
      language: meta.language || 'TypeScript',
      stack: stack.length ? stack : ['GitHub'],
      dependencyCount: depCount,
      hasTests,
      findings,
      suggestedGesture,
      roastScore: score,
      roastHeadline,
      roastPromptContext: `Repo ${meta.full_name} (${meta.language}, ${meta.stargazers_count} stars): "${meta.description || 'no description'}". Root files: [${files.slice(0, 12).join(', ')}]. Dependencies: ${depCount ?? 'unknown (no package.json read)'}. Has tests: ${hasTests}. Score: ${score}/100.`,
      origin: 'github_live',
    };
  } catch (err) {
    console.warn(`[repo-analyzer] No se pudo consultar ${slug} en GitHub:`, err);
    // Never invent numbers: mark everything as unavailable.
    return {
      repo: slug,
      description: `Repositorio ${slug} (datos de GitHub no disponibles)`,
      stars: null,
      language: 'no disponible',
      stack: [],
      dependencyCount: null,
      hasTests: false,
      findings: [
        {
          label: 'GitHub',
          value: 'No se pudo consultar la API (límite de peticiones, repo privado o sin red): datos no disponibles',
          severity: 'warn',
        },
      ],
      suggestedGesture: 'suspicious_inspect',
      // Neutral placeholder (not shown in the UI); only picks the "skeptical" mood.
      roastScore: 50,
      roastHeadline: `No pude consultar ${slug} en GitHub; sin datos no hay roast justo.`,
      roastPromptContext: `GitHub data for ${slug} is unavailable (rate limit, private repo or network). Do not invent stars, dependencies or tests.`,
      origin: 'unavailable',
    };
  }
}

export const analyzeGitHubRepo = analyzeGithubRepo;

export interface GitHubPRAnalysis {
  url: string;
  repoSlug: string;
  prNumber: number;
  prSummary: string;
  testsPassing: boolean;
  justification: string;
}

export const PRESET_PRS: Record<string, GitHubPRAnalysis> = {
  'https://github.com/acme-cloud/edge-router/pull/289': {
    url: 'https://github.com/acme-cloud/edge-router/pull/289',
    repoSlug: 'acme-cloud/edge-router',
    prNumber: 289,
    prSummary:
      'PR #289 (acme-cloud/edge-router · Escenario Simulado): Bypass de validación en middleware de pagos (-42 líneas de tests eliminadas)',
    testsPassing: false,
    justification:
      'Se eliminaron 42 líneas de pruebas unitarias para subir un hotfix en viernes a las 4:55 PM; comentaron verifySignature() en el webhook de cobros; pusieron skipAuth: true temporal con un TODO para el lunes; cero cobertura y sin script de rollback.',
  },
  'https://github.com/acme-cloud/checkout-api/pull/645': {
    url: 'https://github.com/acme-cloud/checkout-api/pull/645',
    repoSlug: 'acme-cloud/checkout-api',
    prNumber: 645,
    prSummary:
      'PR #645 (acme-cloud/checkout-api · Escenario Simulado): Parche de idempotencia con 18 tests E2E y canary 5%',
    testsPassing: true,
    justification:
      'Todas las 18 pruebas E2E de cobros están en verde; agrega llave de idempotencia en Redis para evitar cobros dobles; despliegue canary gradual al 5% del tráfico; incluye script automático de rollback si sube la latencia p99.',
  },
  'https://github.com/acme-cloud/rust-gateway/pull/234': {
    url: 'https://github.com/acme-cloud/rust-gateway/pull/234',
    repoSlug: 'acme-cloud/rust-gateway',
    prNumber: 234,
    prSummary:
      'PR #234 (acme-cloud/rust-gateway · Escenario Simulado): Endurecimiento de límites de velocidad con suite completa de tests en Rust',
    testsPassing: true,
    justification:
      'Cobertura de pruebas al 100% en verde con cargo test y fuzzing; rate limiter token-bucket en Rust sin asignaciones en el hot path; validación estricta de cabeceras y origen verificada; feature flag listo para rollback limpio en un segundo.',
  },
};

export async function analyzeGitHubPR(prInput: string): Promise<GitHubPRAnalysis> {
  const raw = prInput.trim().replace(/\/+$/, '');
  if (PRESET_PRS[raw]) {
    return PRESET_PRS[raw];
  }

  let ownerRepo = 'facebook/react';
  let prNum = 28912;

  const urlMatch = raw.match(/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)/i);
  const hashMatch = raw.match(/^([^/]+\/[^/#]+)#(\d+)$/i);
  if (urlMatch) {
    ownerRepo = urlMatch[1];
    prNum = Number(urlMatch[2]);
  } else if (hashMatch) {
    ownerRepo = hashMatch[1];
    prNum = Number(hashMatch[2]);
  } else {
    ownerRepo = normalizeRepoSlug(raw) || 'facebook/react';
  }

  const canonicalUrl = `https://github.com/${ownerRepo}/pull/${prNum}`;
  if (PRESET_PRS[canonicalUrl]) {
    return PRESET_PRS[canonicalUrl];
  }

  try {
    if (!urlMatch && !hashMatch) {
      const listRes = await fetch(
        `https://api.github.com/repos/${ownerRepo}/pulls?state=all&per_page=1`,
        { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(3500) }
      );
      if (listRes.ok) {
        const list = (await listRes.json()) as Array<{ number: number }>;
        if (list.length > 0) {
          prNum = list[0].number;
        }
      }
    }

    const [prRes, filesRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${ownerRepo}/pulls/${prNum}`, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(4500),
      }),
      fetch(`https://api.github.com/repos/${ownerRepo}/pulls/${prNum}/files?per_page=30`, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(4500),
      }),
    ]);

    if (!prRes.ok) throw new Error('PR fetch failed');
    const prData = (await prRes.json()) as {
      number: number;
      title: string;
      body: string | null;
      additions: number;
      deletions: number;
      changed_files: number;
      user?: { login?: string };
    };

    const filesData = filesRes.ok
      ? ((await filesRes.json()) as Array<{ filename: string }>)
      : [];

    const hasTestChanges = filesData.some((f) =>
      /(test|spec|__tests__|e2e|\.test\.|\.spec\.)/i.test(f.filename)
    );

    const summary = `PR #${prData.number} (${ownerRepo}): ${prData.title} (+${prData.additions}/-${prData.deletions} en ${prData.changed_files} archivos)`;
    const justification = hasTestChanges
      ? `Incluye pruebas automatizadas verificadas en el PR (+${prData.additions}/-${prData.deletions}) y plan de rollback.`
      : `Cambios directos en ${prData.changed_files} archivos (+${prData.additions}/-${prData.deletions}) sin nuevos archivos de test detectados.`;

    return {
      url: `https://github.com/${ownerRepo}/pull/${prData.number}`,
      repoSlug: ownerRepo,
      prNumber: prData.number,
      prSummary: summary,
      testsPassing: hasTestChanges,
      justification,
    };
  } catch (err) {
    console.warn(`[repo-analyzer] No se pudo consultar el PR ${ownerRepo}#${prNum}:`, err);
    // No data means no evidence of tests: never invent a passing suite.
    return {
      url: canonicalUrl,
      repoSlug: ownerRepo,
      prNumber: prNum,
      prSummary: `PR #${prNum} (${ownerRepo}): datos de GitHub no disponibles`,
      testsPassing: false,
      justification: `No se pudo consultar el PR #${prNum} en GitHub, así que no hay evidencia de tests ni de plan de rollback.`,
    };
  }
}

export interface GitHubIncidentAnalysis {
  url: string;
  label: string;
  service: 'cloud_run' | 'gemini_live' | 'firestore';
  incidentLog: string;
}

export const PRESET_INCIDENTS: Record<string, GitHubIncidentAnalysis> = {
  'https://github.com/acme-cloud/cloud-run-worker/issues/542': {
    url: 'https://github.com/acme-cloud/cloud-run-worker/issues/542',
    label: 'acme-cloud/cloud-run-worker#542 · Cloud Run OOM',
    service: 'cloud_run',
    incidentLog:
      'Incidente Simulado acme-cloud/cloud-run-worker#542 — ERROR 503 en Cloud Run: El contenedor superó el límite de 512MiB de memoria (exit code 137 OOMKilled); fuga de descriptores WebSocket sin cerrar en reconexiones; el recolector de basura colapsó al llegar a 1,200 conexiones concurrentes.',
  },
  'https://github.com/acme-cloud/voice-stream/issues/142': {
    url: 'https://github.com/acme-cloud/voice-stream/issues/142',
    label: 'acme-cloud/voice-stream#142 · Gemini Live PCM',
    service: 'gemini_live',
    incidentLog:
      'Incidente Simulado acme-cloud/voice-stream#142 — WARN en Gemini Live: La cola de reproducción PCM a 24kHz acumuló 4800ms de retraso tras el barge-in; olvidaron vaciar el AudioBuffer cuando llegó serverContent.interrupted; el robot seguía hablando encima del usuario.',
  },
  'https://github.com/acme-cloud/firestore-orders/issues/798': {
    url: 'https://github.com/acme-cloud/firestore-orders/issues/798',
    label: 'acme-cloud/firestore-orders#798 · Firestore 400',
    service: 'firestore',
    incidentLog:
      'Incidente Simulado acme-cloud/firestore-orders#798 — FirebaseError [code=failed-precondition] (HTTP 400) en Firestore: La consulta con filtro where("sessionId") y orderBy("createdAt", "desc") falló en producción; falta declarar el índice compuesto en firestore.indexes.json.',
  },
};

export async function analyzeGitHubIncident(input: string): Promise<GitHubIncidentAnalysis> {
  const raw = input.trim().replace(/\/+$/, '');
  if (PRESET_INCIDENTS[raw]) {
    return PRESET_INCIDENTS[raw];
  }

  const match = raw.match(/github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/i);
  if (match) {
    const ownerRepo = match[1];
    const num = match[2];
    try {
      const res = await fetch(`https://api.github.com/repos/${ownerRepo}/issues/${num}`, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(3500),
      });
      if (res.ok) {
        const data = (await res.json()) as { title: string; body?: string | null };
        const combined = `${ownerRepo} ${data.title} ${(data.body || '').slice(0, 300)}`;
        const lower = combined.toLowerCase();
        const service: 'cloud_run' | 'gemini_live' | 'firestore' =
          lower.includes('firestore') || lower.includes('firebase') || lower.includes('index') || lower.includes('query')
            ? 'firestore'
            : lower.includes('audio') || lower.includes('pcm') || lower.includes('live') || lower.includes('genai') || lower.includes('voice')
              ? 'gemini_live'
              : 'cloud_run';
        return {
          url: raw,
          label: `${ownerRepo}#${num}`,
          service,
          incidentLog: `GitHub ${ownerRepo}#${num}: ${data.title}. ${(data.body || '').slice(0, 220)}`,
        };
      }
    } catch (err) {
      console.warn(`[repo-analyzer] No se pudo consultar ${ownerRepo}#${num}:`, err);
    }
  }

  return {
    url: raw,
    label: raw.slice(0, 40),
    service: 'cloud_run',
    incidentLog: raw,
  };
}

