#!/usr/bin/env node
/**
 * audit-motion.mjs — reduced-motion coverage audit for game.css
 *
 * Finds every rule that sets `animation:` outside a media query,
 * then checks whether a selector that plausibly matches it appears
 * inside a `@media (prefers-reduced-motion: reduce)` block with
 * `animation: none`.
 *
 * Matching is approximate (string-containment both directions) and
 * prints a REVIEW list for manual confirmation — CSS selector matching
 * is not fully emulated (nth-child, sibling chains, pseudo-elements).
 */
import { readFileSync } from 'node:fs';

const path = process.argv[2] ?? '/home/z/my-project/FightingGameEngine-Demo/src/styles/game.css';
const css = readFileSync(path, 'utf8');

// ---- tokenize media blocks (only top-level @media here) -------------------
function extractMediaBlocks(src) {
  const blocks = [];
  const re = /@media\s+([^{]+)\{/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length;
    let depth = 1, i = start;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    blocks.push({ cond: m[1].trim(), body: src.slice(start, i - 1) });
  }
  return blocks;
}

// ---- parse rules: selector -> declarations --------------------------------
function parseRules(src) {
  const rules = [];
  // strip comments
  src = src.replace(/\/\*[\s\S]*?\*\//g, '');
  // split into top-level rules (handles nested @media by recursion)
  let i = 0;
  const n = src.length;
  while (i < n) {
    const brace = src.indexOf('{', i);
    if (brace === -1) break;
    const sel = src.slice(i, brace).trim();
    if (sel.startsWith('@media')) {
      // recurse into body
      let depth = 1, j = brace + 1;
      while (j < n && depth > 0) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        j++;
      }
      for (const r of parseRules(src.slice(brace + 1, j - 1))) rules.push({ ...r, media: sel });
      i = j;
    } else if (sel.startsWith('@keyframes')) {
      let depth = 1, j = brace + 1;
      while (j < n && depth > 0) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        j++;
      }
      i = j;
    } else {
      let depth = 1, j = brace + 1;
      while (j < n && depth > 0) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        j++;
      }
      rules.push({ selector: sel, body: src.slice(brace + 1, j - 1), media: null });
      i = j;
    }
  }
  return rules;
}

const blocks = extractMediaBlocks(css);
const reduceBlocks = blocks.filter((b) => /prefers-reduced-motion\s*:\s*reduce/.test(b.cond));
const reduceCss = reduceBlocks.map((b) => b.body).join('\n');

const reduceSelectors = [];
for (const r of parseRules(reduceCss)) {
  if (/animation\s*:\s*none/.test(r.body)) {
    r.selector.split(',').forEach((s) => reduceSelectors.push(s.trim()));
  }
}

const rules = parseRules(css).filter((r) => r.media === null);
const animated = [];
for (const r of rules) {
  const m = r.body.match(/animation\s*:\s*([^;]+);/);
  if (m && !/none/.test(m[1])) {
    r.selector.split(',').forEach((s) =>
      animated.push({ selector: s.trim(), anim: m[1].trim() })
    );
  }
}

// also: transitions on base rules that hovers rely on (informational)
const withTransition = rules
  .filter((r) => /(^|[,\s])transition\s*:/.test(r.body))
  .map((r) => r.selector);

// ---- approximate match -----------------------------------------------------
function covers(animatedSel, reduceSel) {
  if (!animatedSel || !reduceSel) return false;
  const a = animatedSel.toLowerCase();
  const b = reduceSel.toLowerCase();
  if (a === b) return true;
  // reduce selector contains the animated selector (covers compound prefixes)
  if (b.includes(a)) return true;
  // animated selector contains reduce selector (e.g. reduce lists a base class)
  return a.includes(b);
}

const uncovered = [];
for (const a of animated) {
  const hit = reduceSelectors.some((rs) => covers(a.selector, rs));
  if (!hit) uncovered.push(a);
}

console.log(`animated rules (top-level): ${animated.length}`);
console.log(`reduce-block 'animation:none' selectors: ${reduceSelectors.length}`);
console.log(`\n=== NOT covered by prefers-reduced-motion (REVIEW) ===`);
for (const u of uncovered) console.log(`  ${u.selector}\n      -> ${u.anim}`);
console.log(`\n=== rules carrying transition (informational) ===`);
console.log(withTransition.join('\n'));
