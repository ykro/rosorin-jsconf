/**
 * Local song matcher for Bumblebee mode: keyword intents for the stage prompts,
 * then a 32-dim semantic vector search over catalog.json. Pure functions (no DOM).
 */
export interface SongClip {
  id: string;
  lang: 'en' | 'es';
  title: string;
  artist: string;
  lyrics: string;
  mood: string;
  role: string;
  meanings: string[];
  duration: number;
  audioUrl: string;
  gesture: string;
  embedding?: number[];
}

export interface SongMatch {
  clips: SongClip[];
  gesture: string;
  caption: string;
}

/** Mutable anti-repetition memory shared across turns. */
export interface MatchState {
  recentClipIds: string[];
}

// Same 24 semantic concept axes + 8 char-trigram buckets used when indexing catalog.json
export const SEMANTIC_AXES: string[][] = [
  ['hola', 'hello', 'hey', 'greet', 'greeting', 'welcome', 'buenas', 'saludo', 'qué onda', 'que onda', 'arrival', 'entrance'],
  ['adiós', 'adios', 'bye', 'farewell', 'goodbye', 'me voy', 'despedida', 'hasta luego', 'nos vemos', 'leave', 'leaving'],
  ['sí', 'si', 'yes', 'affirm', 'claro', 'exacto', 'aprobado', 'agree', 'confirm', 'correct', 'true', 'dale'],
  ['no', 'deny', 'never', 'jamás', 'jamas', 'rechazado', 'refuse', 'disagree', 'stop', 'warning', 'falso'],
  ['pregunta', 'ask', 'question', 'qué', 'que', 'cómo', 'como', 'por qué', 'por que', 'dime', 'cuéntame', 'cuentame', 'curious', 'what', 'why', 'how'],
  ['ánimo', 'animo', 'encourage', 'fuerza', 'tú puedes', 'tu puedes', 'vamos', 'adelante', 'strong', 'survive', 'keep_going', 'power'],
  ['triste', 'sad', 'comfort', 'mal día', 'mal dia', 'llorar', 'dolor', 'hurt', 'empathy', 'broken', 'consolation', 'cry'],
  ['fiesta', 'party', 'celebrate', 'bailar', 'baila', 'dance', 'romperla', 'escenario', 'jsconf', 'hype', 'happy', 'feliz', 'alegría', 'alegria', 'fun'],
  ['chiste', 'joke', 'funny', 'risa', 'jaja', 'humor', 'loco', 'crazy', 'absurd', 'troll', 'laugh', 'silly'],
  ['gracias', 'thank', 'thanks', 'agradecido', 'gratitude', 'appreciate', 'friend', 'amigo'],
  ['perdón', 'perdon', 'sorry', 'apologize', 'disculpa', 'culpa', 'error', 'oops', 'regret', 'mistake', 'equivoqué', 'equivoque'],
  ['estado', 'state', 'cómo estás', 'como estas', 'bien', 'genial', 'levitating', 'viviendo', 'feeling', 'good', 'great'],
  ['pensar', 'ponder', 'think', 'duda', 'quizás', 'quizas', 'realidad', 'fantasía', 'fantasia', 'philosophy', 'wonder', 'maybe'],
  ['sorpresa', 'react', 'wow', 'increíble', 'increible', 'shock', 'fuego', 'fire', 'boom', 'intense', 'thunder'],
  ['reto', 'challenge', 'pelea', 'poder', 'jefe', 'bichota', 'boss', 'rebel', 'fight', 'champion', 'ganar', 'win'],
  ['amor', 'love', 'quiero', 'te amo', 'corazón', 'corazon', 'guapo', 'lindo', 'beso', 'romance', 'crush', 'sweet', 'bb', 'bebé', 'bebe'],
  ['bug', 'producción', 'produccion', 'cayó', 'cayo', 'incidente', 'server', 'servidor', 'crash', 'down', 'pressure', 'emergency', 'caos'],
  ['deploy', 'ci/cd', 'pr', 'pull request', 'verde', 'tests', 'campeón', 'campeon', 'victoria', 'success', 'ship', 'launch'],
  ['clima', 'weather', 'sol', 'sun', 'sunshine', 'lluvia', 'rain', 'calor', 'frío', 'frio', 'día', 'dia'],
  ['ia', 'ai', 'inteligencia artificial', 'robot', 'futuro', 'future', 'tecnología', 'tecnologia', 'machine', 'code', 'código', 'codigo'],
  ['música', 'musica', 'reggaeton', 'rock', 'pop', 'salsa', 'cumbia', 'canción', 'cancion', 'radio', 'ritmo', 'beat'],
  ['rápido', 'rapido', 'fast', 'velocidad', 'speed', 'gasolina', 'energía', 'energia', 'turbo', 'rush'],
  ['calma', 'calm', 'tranquilo', 'relax', 'suave', 'despacito', 'slow', 'chill', 'paz', 'ligera'],
  ['noche', 'night', 'after', 'oscuro', 'luces', 'lights', 'blinding', 'estrellas', 'party_night'],
];

function simpleHashBucket(tri: string): number {
  let h = 2166136261;
  for (let i = 0; i < tri.length; i++) {
    h ^= tri.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 8;
}

export function embedQueryVector(queryText: string): number[] {
  const combined = queryText.toLowerCase();
  const vec: number[] = [];
  for (const axisWords of SEMANTIC_AXES) {
    let score = 0;
    for (const w of axisWords) {
      if (combined.includes(w)) {
        score += 1.0;
      }
    }
    vec.push(score);
  }
  const buckets = [0, 0, 0, 0, 0, 0, 0, 0];
  const clean = combined.replace(/[^a-z0-9áéíóúüñ]/g, '');
  for (let i = 0; i < Math.max(0, clean.length - 2); i++) {
    const tri = clean.slice(i, i + 3);
    buckets[simpleHashBucket(tri)] += 0.25;
  }
  vec.push(...buckets);
  const norm = Math.sqrt(vec.reduce((acc, v) => acc + v * v, 0)) || 1.0;
  return vec.map((v) => v / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Semantic Embedding Matcher:
 * Uses the 32-dim semantic embeddings in `catalog.json` to score all vocal-verified
 * song segments in <2ms. By default plays 1 single coherent clip whose complete sung lyric
 * directly answers the user; only uses 2 clips if they form an explicit coherent sentence.
 */
export function matchSongsForPrompt(
  catalog: SongClip[],
  userText: string,
  state: MatchState
): SongMatch {
  if (!catalog.length) {
    return { clips: [], gesture: 'bumblebee_groove', caption: 'Catálogo vacío' };
  }

  const q = userText.toLowerCase();
  const queryVec = embedQueryVector(userText);
  const tokens = q
    .replace(/[^a-z0-9áéíóúüñ\s]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  const pickById = (id: string) => catalog.find((c) => c.id === id);
  const pickFresh = (candidates: Array<SongClip | undefined>): SongClip => {
    const valid = candidates.filter(Boolean) as SongClip[];
    const fresh = valid.find((c) => !state.recentClipIds.includes(c.id)) || valid[0] || catalog[0];
    state.recentClipIds = [fresh.id, ...state.recentClipIds].slice(0, 8);
    return fresh;
  };

  // 0. Loyalty / Support at 3 AM ("¿Me vas a dejar solo arreglando este bug a las 3 AM?")
  if (
    q.includes('dejar solo') ||
    q.includes('dejarme solo') ||
    q.includes('3 am') ||
    q.includes('3am') ||
    q.includes('abandonar') ||
    q.includes('ayúdame') ||
    q.includes('ayudame') ||
    q.includes('apoyo') ||
    q.includes('conmigo')
  ) {
    const clip = pickFresh([
      pickById('en_never_gonna_give_you_up'), // "Never gonna give you up, never gonna let you down"
      pickById('en_lean_on_me'), // "Lean on me, when you're not strong"
      pickById('en_youve_got_a_friend'), // "You've got a friend"
      pickById('en_i_will_always_love_you'), // "And I will always love you"
    ]);
    return {
      clips: [clip],
      gesture: 'bumblebee_romance',
      caption: 'Promesa de lealtad robótica en guardia nocturna...',
    };
  }

  // 1. Production crash / bug / outage ("Se cayó producción y nadie sabe por qué")
  if (
    q.includes('cayó') ||
    q.includes('cayo') ||
    q.includes('bug') ||
    q.includes('error') ||
    q.includes('incidente') ||
    q.includes('producción') ||
    q.includes('produccion') ||
    q.includes('fuego') ||
    q.includes('caos') ||
    q.includes('mal día') ||
    q.includes('mal dia')
  ) {
    const clip = pickFresh([
      pickById('en_anti_hero'), // "It's me, hi, I'm the problem, it's me"
      pickById('en_under_pressure'), // "Pressure! Pushing down on me, pressing down on you — Under pressure!"
      pickById('en_another_one_bites_the_dust'), // "Another one bites the dust"
      pickById('es_lo_siento_bb'), // "Lo siento, BB, lo siento"
      pickById('en_everybody_hurts'), // "Everybody hurts sometimes"
    ]);
    const gesture = clip.id === 'en_anti_hero' ? 'bumblebee_sassy' : 'bumblebee_sad_droop';
    return {
      clips: [clip],
      gesture,
      caption:
        clip.id === 'en_anti_hero'
          ? 'Confesión musical del culpable del incidente...'
          : 'Sintonizando alerta de emergencia en producción...',
    };
  }

  // 2. Opinion on Artificial Intelligence / Robots / Future ("¿Qué opinas de la inteligencia artificial?")
  if (
    q.includes('inteligencia artificial') ||
    /\bia\b/.test(q) ||
    /\bai\b/.test(q) ||
    q.includes('opinas') ||
    q.includes('piensas') ||
    q.includes('futuro') ||
    q.includes('realidad')
  ) {
    const clip = pickFresh([
      pickById('en_bohemian_rhapsody'), // "Is this the real life? Is this just fantasy?"
      pickById('es_te_felicito'), // "Te felicito, qué bien actúas, de eso no me cabe duda"
      pickById('en_the_final_countdown'), // "It's the final countdown! The final countdown!"
      pickById('es_en_la_ciudad_de_la_furia'), // "Me verás volar por la ciudad de la furia"
    ]);
    return {
      clips: [clip],
      gesture: clip.id === 'es_te_felicito' ? 'bumblebee_sassy' : 'bumblebee_rock_out',
      caption: `Opinión filosófica en FM: "${clip.title}"`,
    };
  }

  // 3. Joke / Humor ("Cuéntame un chiste") — check before dance so "Cuéntame un chiste" triggers humor
  if (
    q.includes('chiste') ||
    q.includes('risa') ||
    q.includes('reír') ||
    q.includes('reir') ||
    q.includes('broma') ||
    q.includes('joke')
  ) {
    const clip = pickFresh([
      pickById('en_never_gonna_give_you_up'), // "Never gonna give you up, never gonna let you down" (Rickroll!)
      pickById('es_bzrp_music_sessions_53'), // "Las mujeres ya no lloran, las mujeres facturan"
      pickById('en_anti_hero'), // "It's me, hi, I'm the problem, it's me"
      pickById('es_te_felicito'), // "Te felicito, qué bien actúas, de eso no me cabe duda"
    ]);
    return {
      clips: [clip],
      gesture: 'bumblebee_sassy',
      caption:
        clip.id === 'en_never_gonna_give_you_up'
          ? '¡Rickrolleado en vivo por un robot!'
          : 'Sintonizando frecuencia de sarcasmo musical...',
    };
  }

  // 4. Dance / Mecanum wheels ("Baila con las llantas Mecanum")
  if (
    q.includes('baila') ||
    q.includes('bailar') ||
    q.includes('mecanum') ||
    q.includes('llantas') ||
    q.includes('pasos') ||
    q.includes('fiesta') ||
    q.includes('party')
  ) {
    const clip = pickFresh([
      pickById('es_danza_kuduro'), // "La mano arriba, cintura sola, da media vuelta, danza kuduro"
      pickById('es_la_bamba'), // "Para bailar la bamba se necesita una poca de gracia"
      pickById('es_siguelo_bailando'), // "Síguelo bailando"
      pickById('en_footloose'), // "Everybody cut footloose"
    ]);
    return {
      clips: [clip],
      gesture: 'bumblebee_hype',
      caption: '¡Activando pasos prohibidos en las 4 llantas Mecanum!',
    };
  }

  // 5. Deploy success / Victory ("El deploy en viernes salió perfecto a la primera")
  if (
    q.includes('perfecto') ||
    q.includes('verde') ||
    q.includes('aprobado') ||
    q.includes('deploy') ||
    q.includes('campeón') ||
    q.includes('campeon') ||
    q.includes('ganamos') ||
    q.includes('éxito') ||
    q.includes('exito')
  ) {
    const clip = pickFresh([
      pickById('en_we_are_the_champions'), // "We are the champions, my friends"
      pickById('es_bichota'), // "Me siento bichota sin salir del bloque"
      pickById('es_perro_negro'), // "Vamo' a celebrarlo en Perro Negro"
      pickById('en_walking_on_sunshine'), // "I'm walking on sunshine, whoa-oh"
    ]);
    return {
      clips: [clip],
      gesture: 'bumblebee_rock_out',
      caption: '¡Sintonizando himno de victoria para el deploy!',
    };
  }

  // 6. Love / Gratitude ("Te quiero mucho robotcito, gracias por todo")
  if (
    q.includes('gracias') ||
    q.includes('thank') ||
    q.includes('amor') ||
    q.includes('quiero') ||
    q.includes('love') ||
    q.includes('corazón') ||
    q.includes('corazon')
  ) {
    const clip = pickFresh([
      pickById('es_gracias_a_la_vida'), // "Gracias a la vida que me ha dado tanto"
      pickById('es_limon_y_sal'), // "Yo te quiero con limón y sal, yo te quiero tal y como estás"
      pickById('en_thank_you_for_being_a_friend'), // "Thank you for being a friend"
      pickById('en_youve_got_a_friend'), // "You've got a friend"
    ]);
    return {
      clips: [clip],
      gesture: 'bumblebee_romance',
      caption: 'Frecuencia FM · Agradecimiento y cariño robótico',
    };
  }

  // 7. Greeting / How are you ("¡Hola Bumblebee! ¿Cómo estás hoy?")
  if (
    q.includes('hola') ||
    q.includes('hello') ||
    q.includes('cómo estás') ||
    q.includes('como estas') ||
    q.includes('listo') ||
    q.includes('romperla') ||
    q.includes('escenario') ||
    q.includes('buenas')
  ) {
    const clip = pickFresh([
      pickById('es_vivir_mi_vida'), // "Voy a reír, voy a bailar, vivir mi vida, la, la, la, la"
      pickById('en_levitating'), // "I'm levitating"
      pickById('es_provenza'), // "Baby, ¿qué más? Hace rato que no sé na de ti"
      pickById('en_walking_on_sunshine'), // "I'm walking on sunshine, whoa-oh"
    ]);
    return {
      clips: [clip],
      gesture: 'bumblebee_hype',
      caption: '¡Sintonizando saludo y estado de ánimo al 100%!',
    };
  }

  // 8. Dense vector cosine similarity search across all vocal-verified clips (returns 1 single best clip)
  const scored = catalog.map((clip) => {
    const clipVec =
      clip.embedding && clip.embedding.length > 0
        ? clip.embedding
        : embedQueryVector(`${clip.title} ${clip.artist} ${clip.lyrics} ${clip.role} ${clip.meanings.join(' ')}`);

    let sim = cosineSimilarity(queryVec, clipVec) * 10;

    const hay = `${clip.title} ${clip.artist} ${clip.lyrics} ${clip.role} ${clip.meanings.join(' ')}`.toLowerCase();
    for (const tok of tokens) {
      if (hay.includes(tok)) sim += 2.5;
    }

    if (!state.recentClipIds.includes(clip.id)) {
      sim += 1.8;
    } else {
      sim -= 3.5;
    }

    sim += Math.random() * 0.25;
    return { clip, score: sim };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]?.clip || catalog[0];
  state.recentClipIds = [best.id, ...state.recentClipIds].slice(0, 8);

  return {
    clips: [best],
    gesture: best.gesture || 'bumblebee_groove',
    caption: `Sintonizando "${best.title}" — ${best.artist}`,
  };
}
