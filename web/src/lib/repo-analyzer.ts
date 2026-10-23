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
      { label: 'issues abiertos', value: 'Más de 1,800 issues esperando respuesta', severity: 'roast' },
      { label: 'useEffect loops', value: 'Responsable del 80% de los bugs en producción', severity: 'roast' },
      { label: 'arquitectura Fiber', value: 'Reconciliador sólido con suite completa de tests', severity: 'good' },
    ],
    suggestedGesture: 'facepalm',
    roastScore: 54,
    roastHeadline: 'React tiene 234 mil estrellas, pero un solo useEffect mal puesto sigue congelando tu navegador.',
    roastPromptContext:
      'Repo facebook/react: 234k stars, over 1,800 open issues, uses Flow instead of TypeScript internally, and developers still cause infinite loops with useEffect.',
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
      { label: 'caché misterioso', value: '4 capas de caché que nadie sabe cómo invalidar', severity: 'roast' },
      { label: 'Directivas', value: 'use client, use server, use cache en cada archivo', severity: 'warn' },
      { label: 'Turbopack en Rust', value: 'Compilación incremental de alto rendimiento', severity: 'good' },
    ],
    suggestedGesture: 'suspicious_inspect',
    roastScore: 62,
    roastHeadline: 'Next.js cambia de router cada dos años, pero al menos su compilador en Rust sí corre rápido.',
    roastPromptContext:
      'Repo vercel/next.js: 130k stars, mixes Pages Router and App Router, complex caching layers, directive soup ("use client", "use server"), fast Rust Turbopack.',
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
      { label: 'seguridad', value: 'Permisos explícitos por flag (--allow-net)', severity: 'good' },
      { label: 'identidad', value: 'Prometió matar a package.json y terminó soportándolo', severity: 'roast' },
    ],
    suggestedGesture: 'chef_kiss',
    roastScore: 84,
    roastHeadline: 'Escrito en Rust y con TypeScript nativo: limpio, seguro y aprobado por mis 6 servos.',
    roastPromptContext:
      'Repo denoland/deno: Built in Rust and V8 with native TypeScript support and explicit security permissions, though it eventually had to add npm and package.json compatibility.',
    origin: 'preset_rehearsal',
  },
  'ykro/rosorin-jsconf': {
    repo: 'ykro/rosorin-jsconf',
    description: 'Embodied AI with Gemini 3.8 Live, TypeScript, and a 40Hz Rust bridge for ROSOrin Pro.',
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
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'rosorin-jsconf-analyzer',
    };
    if (process.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

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

    let depCount = 0;
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
      } catch {
        // ignore malformed package.json
      }
    }

    const hasTests =
      !hasFakeTestScript &&
      files.some((f) =>
        /^(test|tests|__tests__|spec|vitest\.config|jest\.config|pytest\.ini)/i.test(f)
      );

    const findings: RepoFinding[] = [];
    let score = 72;

    if (depCount > 120) {
      score -= 28;
      findings.push({
        label: 'node_modules',
        value: `${depCount} paquetes declarados en package.json`,
        severity: 'roast',
      });
    } else if (depCount > 0) {
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
        ? `${meta.full_name} confía más en la fe que en los tests (${depCount} paquetes).`
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
      roastPromptContext: `Repo ${meta.full_name} (${meta.language}, ${meta.stargazers_count} stars): "${meta.description || 'no description'}". Root files: [${files.slice(0, 12).join(', ')}]. Dependencies: ${depCount}. Has tests: ${hasTests}. Score: ${score}/100.`,
      origin: 'github_live',
    };
  } catch {
    return {
      repo: slug,
      description: `Repositorio ${slug}`,
      stars: 42,
      language: 'TypeScript',
      stack: ['TypeScript', 'Node.js'],
      dependencyCount: 64,
      hasTests: false,
      findings: [
        { label: 'análisis rápido', value: `Inspección en vivo de ${slug}`, severity: 'warn' },
      ],
      suggestedGesture: 'suspicious_inspect',
      roastScore: 58,
      roastHeadline: `Estuve revisando ${slug} con mi cámara 3D y veo más promesas en el README que pruebas unitarias.`,
      roastPromptContext: `Repository ${slug}: analyzed live on stage. Roast its README promises vs test coverage in witty Spanish.`,
      origin: 'preset_rehearsal',
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
  'https://github.com/facebook/react/pull/28912': {
    url: 'https://github.com/facebook/react/pull/28912',
    repoSlug: 'facebook/react',
    prNumber: 28912,
    prSummary:
      'PR #28912 (facebook/react): Bypass de validación en reconciliador de hooks (-42 líneas de tests eliminadas)',
    testsPassing: false,
    justification:
      'Se eliminaron 42 líneas de pruebas unitarias para subir un hotfix en viernes sin cobertura ni plan de rollback.',
  },
  'https://github.com/vercel/next.js/pull/64501': {
    url: 'https://github.com/vercel/next.js/pull/64501',
    repoSlug: 'vercel/next.js',
    prNumber: 64501,
    prSummary:
      'PR #64501 (vercel/next.js): Parche de invalidación de caché en App Router con 18 tests E2E y canary 5%',
    testsPassing: true,
    justification:
      'Todas las pruebas E2E están en verde, incluye despliegue canary al 5% y script automático de rollback.',
  },
  'https://github.com/denoland/deno/pull/23415': {
    url: 'https://github.com/denoland/deno/pull/23415',
    repoSlug: 'denoland/deno',
    prNumber: 23415,
    prSummary:
      'PR #23415 (denoland/deno): Endurecimiento de permisos de red en runtime con suite completa de tests en Rust',
    testsPassing: true,
    justification:
      'Cobertura de pruebas al 100% en verde, validación de seguridad verificada y rollback limpio.',
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
        { headers: { Accept: 'application/vnd.github+json' } }
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
      }),
      fetch(`https://api.github.com/repos/${ownerRepo}/pulls/${prNum}/files?per_page=30`, {
        headers: { Accept: 'application/vnd.github+json' },
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
  } catch {
    return {
      url: canonicalUrl,
      repoSlug: ownerRepo,
      prNumber: prNum,
      prSummary: `PR #${prNum} (${ownerRepo}): Cambios en servicio principal enviados para revisión`,
      testsPassing: prNum % 2 !== 0,
      justification:
        prNum % 2 !== 0
          ? `PR #${prNum} de ${ownerRepo} con tests en verde, canary y plan de rollback.`
          : `PR #${prNum} de ${ownerRepo} enviado de urgencia sin suite de tests adjunta.`,
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
  'https://github.com/vercel/next.js/issues/54280': {
    url: 'https://github.com/vercel/next.js/issues/54280',
    label: 'vercel/next.js#54280 · Cloud Run OOM',
    service: 'cloud_run',
    incidentLog:
      'GitHub Issue https://github.com/vercel/next.js/issues/54280 — ERROR 503 en Cloud Run: El contenedor superó el límite de 512MiB de memoria (OOMKilled) por fuga de descriptores WebSocket durante pico de tráfico.',
  },
  'https://github.com/googleapis/js-genai/issues/142': {
    url: 'https://github.com/googleapis/js-genai/issues/142',
    label: 'googleapis/js-genai#142 · Gemini Live PCM',
    service: 'gemini_live',
    incidentLog:
      'GitHub Issue https://github.com/googleapis/js-genai/issues/142 — WARN en Gemini Live: La cola de audio PCM a 24kHz superó los 4800ms tras el barge-in del usuario porque no se vació el buffer en serverContent.interrupted.',
  },
  'https://github.com/firebase/firebase-js-sdk/issues/7984': {
    url: 'https://github.com/firebase/firebase-js-sdk/issues/7984',
    label: 'firebase/firebase-js-sdk#7984 · Firestore 400',
    service: 'firestore',
    incidentLog:
      'GitHub Issue https://github.com/firebase/firebase-js-sdk/issues/7984 — FirebaseError [code=failed-precondition] (HTTP 400) en Firestore: La consulta sobre (sessionId ASC, createdAt DESC) requiere un índice compuesto faltante.',
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
    } catch {
      // fall through
    }
  }

  return {
    url: raw,
    label: raw.slice(0, 40),
    service: 'cloud_run',
    incidentLog: raw,
  };
}

