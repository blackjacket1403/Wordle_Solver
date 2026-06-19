// Simulate the shipped solver over every answer and report stats.
// Usage: node test/simulate.js [opener] [bias] [limit]
const WL = require("../words.js");
const S = require("../solver.js");

const openerArg = process.argv[2] || S.DEFAULT_OPENER;
const bias = process.argv[3] != null ? parseFloat(process.argv[3]) : 0.12;
const limit = process.argv[4] ? parseInt(process.argv[4], 10) : WL.ANSWERS.length;

function solve(target, opener) {
  let candidates = WL.ANSWERS.slice();
  let guess = opener;
  for (let turn = 1; turn <= 12; turn++) {
    const code = S.patternCode(guess, target);
    if (code === S.ALL_CORRECT) return turn;
    candidates = S.filterCandidates(candidates, guess, code);
    if (candidates.length === 0) return 99; // impossible
    const ranked = S.rankGuesses(candidates, WL.ALLOWED, { topN: 1, bias });
    guess = ranked.length ? ranked[0].word : candidates[0];
  }
  return 99;
}

const answers = WL.ANSWERS.slice(0, limit);
const dist = {};
let total = 0, worst = 0, fails = 0;
const t0 = Date.now();
for (let i = 0; i < answers.length; i++) {
  const g = solve(answers[i], openerArg);
  if (g >= 99) { fails++; continue; }
  dist[g] = (dist[g] || 0) + 1;
  total += g;
  if (g > worst) worst = g;
}
const n = answers.length - fails;
const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`opener=${openerArg} bias=${bias} games=${answers.length} time=${secs}s`);
console.log(`average guesses: ${(total / n).toFixed(4)}`);
console.log(`worst case     : ${worst}`);
console.log(`fails (>6 or impossible): ${Object.entries(dist).filter(([k])=>+k>6).reduce((a,[,v])=>a+v,0) + fails}`);
console.log("distribution:");
for (let k = 1; k <= worst; k++) if (dist[k]) console.log(`  ${k}: ${dist[k]}`);
