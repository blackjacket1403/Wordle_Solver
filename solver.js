// Wordle solver engine — entropy-based with answer-bias and endgame lookahead.
// Works as a browser global (self.WordleSolver) and a Node module (module.exports).
(function (root) {
  "use strict";

  // Feedback codes: 0 = absent (gray), 1 = present (yellow), 2 = correct (green).

  // Module-level scratch buffers (single-threaded JS — safe to reuse, avoids per-call alloc).
  const _res = new Int8Array(5);
  const _counts = new Int8Array(26); // letter 'a'..'z'
  const POW3 = [81, 27, 9, 3, 1];

  // Compute the feedback pattern for `guess` against `solution` as a base-3 int (0..242).
  // Handles duplicate letters exactly like Wordle (greens first, then yellows left-to-right).
  function patternCode(guess, solution) {
    for (let i = 0; i < 5; i++) {
      const gc = guess.charCodeAt(i);
      if (gc === solution.charCodeAt(i)) {
        _res[i] = 2;
      } else {
        _res[i] = 0;
        _counts[solution.charCodeAt(i) - 97]++;
      }
    }
    let code = 0;
    for (let i = 0; i < 5; i++) {
      if (_res[i] === 2) { code += POW3[i] * 2; continue; }
      const gi = guess.charCodeAt(i) - 97;
      if (_counts[gi] > 0) { _res[i] = 1; _counts[gi]--; code += POW3[i]; }
    }
    // reset only the letters we touched (solution non-green letters)
    for (let i = 0; i < 5; i++) { const sc = solution.charCodeAt(i) - 97; _counts[sc] = 0; }
    return code;
  }

  // Convert a base-3 code to an array like [2,0,1,0,0].
  function codeToArray(code) {
    const a = [0, 0, 0, 0, 0];
    for (let i = 4; i >= 0; i--) {
      a[i] = code % 3;
      code = Math.floor(code / 3);
    }
    return a;
  }

  function arrayToCode(arr) {
    return ((arr[0] * 3 + arr[1]) * 3 + arr[2]) * 9 + arr[3] * 3 + arr[4];
  }

  const ALL_CORRECT = arrayToCode([2, 2, 2, 2, 2]);

  // Keep only candidates consistent with (guess -> observed code).
  function filterCandidates(candidates, guess, code) {
    const out = [];
    for (let i = 0; i < candidates.length; i++) {
      if (patternCode(guess, candidates[i]) === code) out.push(candidates[i]);
    }
    return out;
  }

  const _hist = new Int32Array(243);
  const _touched = new Int32Array(243);
  const LOG2 = Math.log(2);

  // Shannon entropy (bits) of the feedback distribution for `guess` over `candidates`.
  function entropyOf(guess, candidates) {
    const n = candidates.length;
    let t = 0;
    for (let i = 0; i < n; i++) {
      const c = patternCode(guess, candidates[i]);
      if (_hist[c] === 0) _touched[t++] = c;
      _hist[c]++;
    }
    let h = 0;
    for (let j = 0; j < t; j++) {
      const c = _touched[j];
      const v = _hist[c];
      const p = v / n;
      h -= p * (Math.log(p) / LOG2);
      _hist[c] = 0; // reset for next call
    }
    return h;
  }

  // Score and rank guesses for a single board.
  //   candidates : possible answers still consistent with feedback
  //   allowed    : full legal-guess pool to draw probes from
  //   opts.bias  : bonus added when a guess is itself a candidate (chance to win now)
  //   opts.pool  : optional override of which words to evaluate as guesses
  //   opts.topN  : how many ranked suggestions to return
  // Returns [{word, entropy, score, isCandidate}] sorted best-first.
  function rankGuesses(candidates, allowed, opts) {
    opts = opts || {};
    const bias = opts.bias != null ? opts.bias : 0.12;
    const topN = opts.topN || 10;
    const n = candidates.length;

    // Trivial endgames.
    if (n === 0) return [];
    if (n <= 2) {
      return candidates.map((w) => ({ word: w, entropy: 0, score: 1, isCandidate: true })).slice(0, topN);
    }

    const candSet = new Set(candidates);

    // Choose evaluation pool. When few candidates remain, the full allowed list is
    // cheap and finds the best discriminating probe. When many remain, cap the pool
    // to keep it responsive: candidates plus a frequency-shortlist of probes.
    let pool = opts.pool;
    if (!pool) {
      const cost = allowed.length * n;
      if (cost <= 6_000_000) {
        pool = allowed;
      } else {
        // Large state: evaluate candidates + a positional-frequency shortlist of probes.
        const shortlist = topByLetterFreq(allowed, candidates, 600);
        const merged = new Set(candidates);
        for (const w of shortlist) merged.add(w);
        pool = Array.from(merged);
      }
    }

    const results = [];
    for (let i = 0; i < pool.length; i++) {
      const g = pool[i];
      const h = entropyOf(g, candidates);
      const isCand = candSet.has(g);
      // Answer-bias: a guess that could be the answer is worth slightly more than a
      // pure probe of equal entropy, because it can win outright this turn.
      const score = h + (isCand ? bias / n + 1e-6 : 0);
      results.push({ word: g, entropy: h, score, isCandidate: isCand });
    }
    results.sort((a, b) => b.score - a.score || (b.isCandidate - a.isCandidate) || (a.word < b.word ? -1 : 1));

    // Exact 2-ply endgame refinement. When the state is small enough to afford it,
    // re-rank the top entropy candidates by their TRUE expected guesses-to-go (assuming
    // greedy play afterwards). This beats pure entropy on the tail (5s/6s) without
    // meaningful latency, since it only runs once candidates are few.
    const twoPlyMax = opts.twoPlyMax != null ? opts.twoPlyMax : 100;
    if (n >= 3 && n <= twoPlyMax) {
      const K = Math.min(opts.twoPlyK || 12, results.length);
      const candSet2 = candSet;
      let bestG = null, bestCost = Infinity, bestIsCand = false;
      const memo = new Map();
      for (let r = 0; r < K; r++) {
        const g = results[r].word;
        const buckets = partitionCounts(g, candidates);
        let cost = n; // pay for this guess across all candidates
        for (const [pcode, sub] of buckets) if (pcode !== ALL_CORRECT) cost += greedyCost(sub, allowed, opts.bias != null ? opts.bias : 0.12, memo);
        const isC = candSet2.has(g);
        if (cost < bestCost - 1e-9 || (Math.abs(cost - bestCost) < 1e-9 && isC && !bestIsCand)) { bestCost = cost; bestG = g; bestIsCand = isC; }
      }
      if (bestG && results[0].word !== bestG) {
        const i = results.findIndex((x) => x.word === bestG);
        const picked = results[i];
        results.splice(i, 1);
        results.unshift(picked);
      }
    }
    return results.slice(0, topN);
  }

  // Partition a candidate list by the feedback pattern `guess` produces; returns Map(code -> subset).
  function partitionCounts(guess, candidates) {
    const m = new Map();
    for (let i = 0; i < candidates.length; i++) {
      const c = patternCode(guess, candidates[i]);
      let b = m.get(c); if (!b) { b = []; m.set(c, b); } b.push(candidates[i]);
    }
    return m;
  }

  // Total guesses summed over `candidates`, counting from the next guess, under greedy
  // entropy play. Memoized by candidate-set signature within a single rankGuesses call.
  function greedyCost(candidates, allowed, bias, memo) {
    const n = candidates.length;
    if (n === 1) return 1;
    if (n === 2) return 3; // 1 if first is right, 2 otherwise
    const key = candidates.join(",");
    const hit = memo.get(key); if (hit !== undefined) return hit;
    // greedy entropy pick
    const candSet = new Set(candidates);
    let g = null, bs = -1;
    for (let i = 0; i < allowed.length; i++) {
      const w = allowed[i];
      const h = entropyOf(w, candidates) + (candSet.has(w) ? bias / n : 0);
      if (h > bs) { bs = h; g = w; }
    }
    const buckets = partitionCounts(g, candidates);
    let total = n;
    for (const [pcode, sub] of buckets) if (pcode !== ALL_CORRECT) total += greedyCost(sub, allowed, bias, memo);
    memo.set(key, total);
    return total;
  }

  // Positional letter-frequency shortlist (used only to bound very large states).
  function topByLetterFreq(allowed, candidates, k) {
    const freq = [{}, {}, {}, {}, {}];
    for (const w of candidates) {
      for (let i = 0; i < 5; i++) freq[i][w[i]] = (freq[i][w[i]] || 0) + 1;
    }
    const scored = [];
    for (const w of allowed) {
      let s = 0;
      const seen = new Set();
      for (let i = 0; i < 5; i++) {
        s += freq[i][w[i]] || 0;
        if (!seen.has(w[i])) {
          seen.add(w[i]);
        } else {
          s -= 0.5 * (freq[i][w[i]] || 0); // mild penalty for repeats
        }
      }
      scored.push([s, w]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    return scored.slice(0, k).map((x) => x[1]);
  }

  // Precomputed strong opener for the standard 2315-answer list. Grid-searched offline:
  // "salet" minimizes average guesses (~3.43) under this engine; "crate" ties it.
  const DEFAULT_OPENER = "salet";

  // --- Single-board solver state machine -------------------------------------
  function createBoard(words, opts) {
    opts = opts || {};
    const answers = words.ANSWERS;
    const allowed = words.ALLOWED;
    let candidates = answers.slice();
    const history = []; // {guess, code}

    return {
      get candidates() { return candidates; },
      get history() { return history; },
      remaining() { return candidates.length; },
      reset() { candidates = answers.slice(); history.length = 0; },
      // Apply an observed (guess, feedback-code) pair.
      applyResult(guess, code) {
        history.push({ guess, code });
        candidates = filterCandidates(candidates, guess, code);
        return candidates.length;
      },
      // Best suggestions right now.
      suggest(n) {
        if (history.length === 0 && candidates.length === answers.length) {
          const opener = opts.opener || DEFAULT_OPENER;
          // Return opener first, but still surface alternates.
          const ranked = [{ word: opener, entropy: entropyOf(opener, candidates), score: 99, isCandidate: answers.includes(opener) }];
          return ranked;
        }
        return rankGuesses(candidates, allowed, { topN: n || 10, bias: opts.bias });
      },
      best() {
        const s = this.suggest(1);
        return s.length ? s[0].word : null;
      },
    };
  }

  const API = {
    patternCode,
    codeToArray,
    arrayToCode,
    filterCandidates,
    entropyOf,
    rankGuesses,
    topByLetterFreq,
    createBoard,
    ALL_CORRECT,
    DEFAULT_OPENER,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.WordleSolver = API;
})(typeof self !== "undefined" ? self : this);
