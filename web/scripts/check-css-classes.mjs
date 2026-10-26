#!/usr/bin/env node
/**
 * There is no Tailwind in this project: every utility class used in JSX is
 * hand-written in src/app/globals.css. This script makes sure that:
 *   1. every class used in `className` (and in `*Class` / `color` props holding
 *      class lists) under src/**\/*.tsx has a matching selector in globals.css,
 *      and so does every other string literal that looks like a class list
 *      (e.g. `const pillTone = cond ? 'border-[#34A853] bg-[#E6F4EA]' : …`);
 *   2. every arbitrary-color class (`bg-[#RRGGBB]`, `text-[#...]/50`, ...) in
 *      globals.css declares the same color its name promises.
 *
 * Usage: node scripts/check-css-classes.mjs   (exit code 1 on any problem)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const CSS_FILE = join(SRC, 'app', 'globals.css');

const CLASS_TOKEN = /^-?[a-z][a-z0-9]*(?:[-:/.][a-z0-9.%]*|\[[^\]\s]+\])*(?:\/\d+)?$/i;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Returns the index just after the string literal starting at `i` (quote char at src[i]). */
function skipString(src, i) {
  const quote = src[i];
  i += 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (quote === '`' && ch === '$' && src[i + 1] === '{') {
      i = skipBalanced(src, i + 1);
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return i;
}

/** `src[i]` must be `{`; returns index just after the matching `}`. */
function skipBalanced(src, i) {
  let depth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(src, i);
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return i;
}

/** Extracts the static text of every string literal inside an expression. */
function stringLiteralsIn(expr) {
  const pieces = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === "'" || ch === '"') {
      const end = skipString(expr, i);
      // `status === 'live'` compares values; it is not a class list.
      const isComparison = /[=!]=\s*$/.test(expr.slice(Math.max(0, i - 4), i));
      if (!isComparison) pieces.push(expr.slice(i + 1, end - 1));
      i = end;
    } else if (ch === '`') {
      const end = skipString(expr, i);
      const body = expr.slice(i + 1, end - 1);
      // Static parts of the template; interpolations become a separator and
      // are scanned recursively for nested literals.
      let text = '';
      let j = 0;
      while (j < body.length) {
        if (body[j] === '$' && body[j + 1] === '{') {
          const close = skipBalanced(body, j + 1);
          pieces.push(...stringLiteralsIn(body.slice(j + 2, close - 1)));
          text += ' \u0000 ';
          j = close;
        } else {
          text += body[j];
          j += 1;
        }
      }
      pieces.push(text);
      i = end;
    } else {
      i += 1;
    }
  }
  return pieces;
}

function tokensOf(text) {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !t.includes('\u0000') && !t.endsWith('-') && CLASS_TOKEN.test(t));
}

function lineOf(src, index) {
  return src.slice(0, index).split('\n').length;
}

/** Every string literal of a source file (static text of templates included). */
function allStringLiterals(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    // Skip comments so apostrophes in prose do not open fake strings.
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = skipString(src, i);
      out.push({ index: i, pieces: stringLiteralsIn(src.slice(i, end)) });
      i = end;
      continue;
    }
    i += 1;
  }
  return out;
}

const STYLE_KEY =
  /^(?:[a-z]+[A-Z][A-Za-z]*|display|position|overflow|cursor|float|visibility|transition|animation|background|border|outline|margin|padding|font|width|height)$/;

/** Utility "families" (first segment: bg, text, border, rounded…) defined in globals.css. */
function utilityPrefixes(rules) {
  const prefixes = new Set();
  for (const cls of rules.keys()) {
    const base = cls.replace(/^(?:[a-z0-9-]+:)+/, '').replace(/^-/, '');
    const head = base.split(/[-[]/)[0];
    if (head) prefixes.add(head);
  }
  return prefixes;
}

/** A literal is a class list when every token is class-shaped and from a known utility family. */
function looksLikeClassList(text, prefixes) {
  const raw = text.trim().split(/\s+/).filter(Boolean);
  if (!raw.length) return false;
  const toks = tokensOf(text);
  if (toks.length !== raw.length) return false;
  if (!toks.some((t) => t.includes('-') || t.includes('['))) return false;
  return toks.every((t) => {
    const base = t.replace(/^(?:[a-z0-9-]+:)+/, '').replace(/^-/, '');
    const outsideBrackets = base.replace(/\[[^\]]*\]/g, '');
    return prefixes.has(base.split(/[-[]/)[0]) && outsideBrackets === outsideBrackets.toLowerCase();
  });
}

function collectUsedClasses(files, prefixes) {
  /** @type {Map<string, string[]>} class -> locations */
  const used = new Map();
  const add = (cls, loc) => {
    if (!used.has(cls)) used.set(cls, []);
    used.get(cls).push(loc);
  };

  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);

    // 1. className="..." | className={...}
    const attr = /className=/g;
    let m;
    while ((m = attr.exec(src))) {
      const start = m.index + m[0].length;
      const loc = `${rel}:${lineOf(src, m.index)}`;
      if (src[start] === '"' || src[start] === "'") {
        const end = skipString(src, start);
        for (const t of tokensOf(src.slice(start + 1, end - 1))) add(t, loc);
      } else if (src[start] === '{') {
        const end = skipBalanced(src, start);
        for (const piece of stringLiteralsIn(src.slice(start + 1, end - 1))) {
          for (const t of tokensOf(piece)) add(t, loc);
        }
      }
    }

    // 2. Object properties that hold class lists: bgClass: '...', tagClass, color: 'bg-[...] text-[...]'
    const prop = /\b(\w*Class|className|color)\s*:\s*(['"`])/g;
    while ((m = prop.exec(src))) {
      const start = m.index + m[0].length - 1;
      const end = skipString(src, start);
      const raw = src.slice(start + 1, end - 1);
      const toks = tokensOf(raw);
      const looksLikeClassList =
        toks.length > 0 && toks.length === raw.trim().split(/\s+/).length && toks.some((t) => t.includes('-'));
      if (!looksLikeClassList) continue;
      const loc = `${rel}:${lineOf(src, m.index)}`;
      for (const t of toks) add(t, loc);
    }

    // 3. Any other string literal shaped like a class list (constants, ternaries, maps…).
    for (const lit of allStringLiterals(src)) {
      for (const piece of lit.pieces) {
        if (!looksLikeClassList(piece, prefixes)) continue;
        // Inline style values (`justifyContent: 'space-between'`) are CSS, not classes.
        const key = /(\w+)\s*:\s*$/.exec(src.slice(Math.max(0, lit.index - 40), lit.index))?.[1];
        if (key && STYLE_KEY.test(key) && !/class/i.test(key)) continue;
        const loc = `${rel}:${lineOf(src, lit.index)}`;
        for (const t of tokensOf(piece)) add(t, loc);
      }
    }
  }
  return used;
}

function parseCss(css) {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import[^;]+;/g, '');
  /** @type {Map<string, string[]>} class -> declaration blocks */
  const rules = new Map();
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(noComments))) {
    const selector = m[1];
    const body = m[2];
    const classRe = /\.((?:\\.|[A-Za-z0-9_-])+)/g;
    let c;
    while ((c = classRe.exec(selector))) {
      if (/^[0-9]/.test(c[1])) continue;
      const name = c[1].replace(/\\(.)/g, '$1');
      if (!rules.has(name)) rules.set(name, []);
      rules.get(name).push(body);
    }
  }
  return rules;
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  return [0, 2, 4].map((o) => parseInt(full.slice(o, o + 2), 16));
}

function declaredColors(body) {
  const colors = [];
  for (const m of body.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    colors.push({ rgb: hexToRgb(m[1]), alpha: 1 });
  }
  for (const m of body.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/gi)) {
    colors.push({ rgb: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: m[4] ? Number(m[4]) : 1 });
  }
  return colors;
}

const files = walk(SRC);
const rules = parseCss(readFileSync(CSS_FILE, 'utf8'));
const used = collectUsedClasses(files, utilityPrefixes(rules));

let problems = 0;

const missing = [...used.keys()].filter((c) => !rules.has(c)).sort();
if (missing.length) {
  console.error(`\n${missing.length} clase(s) usadas en JSX sin regla en src/app/globals.css:`);
  for (const cls of missing) {
    console.error(`  ${cls}    (${used.get(cls).slice(0, 3).join(', ')})`);
  }
  problems += missing.length;
}

const mismatched = [];
for (const [cls, bodies] of rules) {
  const m = cls.match(/^(?:[a-z-]+:)*(?:-)?[a-z-]+-\[#([0-9a-f]{3}|[0-9a-f]{6})\](?:\/(\d+))?$/i);
  if (!m) continue;
  const expected = hexToRgb(m[1]);
  const expectedAlpha = m[2] ? Number(m[2]) / 100 : 1;
  const colors = bodies.flatMap(declaredColors);
  const ok = colors.some(
    (c) =>
      c.rgb.every((v, i) => v === expected[i]) && Math.abs(c.alpha - expectedAlpha) < 0.011
  );
  if (!ok) mismatched.push(cls);
}
if (mismatched.length) {
  console.error(`\n${mismatched.length} clase(s) cuyo nombre no coincide con el color declarado:`);
  for (const cls of mismatched.sort()) console.error(`  ${cls}`);
  problems += mismatched.length;
}

if (problems) {
  console.error(`\ncheck:css FALLÓ (${problems} problema(s)).`);
  process.exit(1);
}
console.log(`check:css OK: ${used.size} clases usadas en ${files.length} archivos .tsx, todas definidas y coherentes.`);
