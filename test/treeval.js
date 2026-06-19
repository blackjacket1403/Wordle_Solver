// Fast exact evaluation of the greedy solver via memoized decision-tree expansion.
// f(idxs) = total guesses summed over all answers in idxs, counting from the
// upcoming guess. avg = f(allAnswers)/N.  Usage: node test/treeval.js [opener] [bias] [twoPly]
const WL = require("../words.js");
const ANSWERS = WL.ANSWERS;
const ALLOWED = [...new Set([...WL.ANSWERS, ...WL.ALLOWED])];

const opener = process.argv[2] || "raise";
const bias = process.argv[3] != null ? parseFloat(process.argv[3]) : 0.12;
const twoPly = process.argv[4] != null ? parseInt(process.argv[4], 10) : 0;

function pc(g, s) {
  const r = [0, 0, 0, 0, 0], cnt = {};
  for (let i = 0; i < 5; i++) { if (g[i] === s[i]) r[i] = 2; else cnt[s[i]] = (cnt[s[i]] || 0) + 1; }
  for (let i = 0; i < 5; i++) { if (r[i] === 2) continue; const c = g[i]; if (cnt[c] > 0) { r[i] = 1; cnt[c]--; } }
  return ((r[0] * 3 + r[1]) * 3 + r[2]) * 9 + r[3] * 3 + r[4];
}
const cache = new Map();
function patsFor(g) {
  let a = cache.get(g);
  if (!a) { a = new Int16Array(ANSWERS.length); for (let i = 0; i < ANSWERS.length; i++) a[i] = pc(g, ANSWERS[i]); cache.set(g, a); }
  return a;
}
function entropy(g, idxs) {
  const pats = patsFor(g), counts = {};
  for (let i = 0; i < idxs.length; i++) { const p = pats[idxs[i]]; counts[p] = (counts[p] || 0) + 1; }
  const n = idxs.length; let h = 0;
  for (const k in counts) { const p = counts[k] / n; h -= p * Math.log2(p); }
  return h;
}
function partition(g, idxs) {
  const pats = patsFor(g), m = new Map();
  for (const i of idxs) { const p = pats[i]; let b = m.get(p); if (!b) { b = []; m.set(p, b); } b.push(i); }
  return m;
}
function pickGuess(idxs) {
  if (idxs.length <= 2) return ANSWERS[idxs[0]];
  const candSet = new Set(idxs.map((i) => ANSWERS[i]));
  let best = null, bestScore = -1; const ranked = [];
  for (const g of ALLOWED) {
    const h = entropy(g, idxs) + (candSet.has(g) ? bias / idxs.length : 0);
    if (h > bestScore) { bestScore = h; best = g; }
    if (twoPly && idxs.length <= twoPly) ranked.push([h, g]);
  }
  if (!twoPly || idxs.length > twoPly) return best;
  // Exact depth-limited search: among top-K entropy guesses, choose the one with the
  // true minimum expected total guesses (assuming greedy play afterwards, via memoized f).
  ranked.sort((a, b) => b[0] - a[0]);
  const K = 14;
  let bg = best, be = Infinity;
  for (let r = 0; r < Math.min(K, ranked.length); r++) {
    const g = ranked[r][1];
    const buckets = partition(g, idxs);
    let cost = idxs.length; // this guess
    for (const [p, sub] of buckets) if (p !== 242) cost += fGreedy(sub);
    // tie-break: prefer a guess that can itself be the answer
    if (cost < be - 1e-9 || (Math.abs(cost - be) < 1e-9 && candSet.has(g) && !candSet.has(bg))) { be = cost; bg = g; }
  }
  return bg;
}
// pure-greedy cost (no 2-ply), used as the evaluation oracle inside 2-ply scoring
const memoG = new Map();
function fGreedy(idxs) {
  if (idxs.length === 1) return 1;
  const k = idxs.join(",");
  const hit = memoG.get(k); if (hit !== undefined) return hit;
  // greedy pick (entropy only)
  let g = null;
  if (idxs.length <= 2) g = ANSWERS[idxs[0]];
  else { let bs = -1; const cs = new Set(idxs.map((i) => ANSWERS[i]));
    for (const w of ALLOWED) { const h = entropy(w, idxs) + (cs.has(w) ? bias / idxs.length : 0); if (h > bs) { bs = h; g = w; } } }
  const buckets = partition(g, idxs);
  let total = idxs.length;
  for (const [p, sub] of buckets) if (p !== 242) total += fGreedy(sub);
  memoG.set(k, total);
  return total;
}
const memo = new Map();
function f(idxs) {
  if (idxs.length === 1) return 1;
  const k = idxs.join(",");
  const hit = memo.get(k); if (hit !== undefined) return hit;
  const g = pickGuess(idxs);
  const buckets = partition(g, idxs);
  let total = idxs.length; // every answer pays for this guess
  for (const [p, sub] of buckets) if (p !== 242) total += f(sub);
  memo.set(k, total);
  return total;
}

const t0 = Date.now();
const all = ANSWERS.map((_, i) => i);
// opener forced at root
const buckets = partition(opener, all);
let sum = all.length;
for (const [p, sub] of buckets) if (p !== 242) sum += f(sub);
const avg = sum / ANSWERS.length;
console.log(`opener=${opener} bias=${bias} twoPly<=${twoPly}  avg=${avg.toFixed(4)}  time=${((Date.now()-t0)/1000).toFixed(1)}s  states=${memo.size}`);
