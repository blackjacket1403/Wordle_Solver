// Content script: detects the board, runs the solver, and renders the overlay panel.
(function () {
  "use strict";
  const S = self.WordleSolver;
  const A = self.WordleAdapters;
  const WORDS = self.WORDLE_WORDS;
  if (!S || !A || !WORDS) { console.warn("[WordleSolver] deps missing"); return; }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const state = {
    mode: "hint",            // "hint" | "solver"
    adapter: null,
    boards: [],              // last read boards
    perBoard: [],            // [{candidates, ranked, solved}]
    autoSolving: false,
    hintReveal: 0,           // progressive reveal level in hint mode
    answersOnly: false,      // restrict guess pool to answer list
    lastSignature: "",
  };

  // ---- Solver glue ----------------------------------------------------------
  function guessPool() {
    return state.answersOnly ? WORDS.ANSWERS : WORDS.ALLOWED;
  }

  function computeBoard(results) {
    // results: [{guess, code}] from submitted rows
    let candidates = WORDS.ANSWERS.slice();
    for (const r of results) candidates = S.filterCandidates(candidates, r.guess, r.code);
    const solved = results.some((r) => r.code === S.ALL_CORRECT);
    let ranked;
    if (solved) ranked = [];
    else if (results.length === 0) ranked = S.createBoard(WORDS).suggest(8);
    else ranked = S.rankGuesses(candidates, guessPool(), { topN: 8 });
    return { candidates, ranked, solved, results };
  }

  // Multi-board combined recommendation: a guess strong across all unsolved boards.
  function combinedSuggestion(perBoard) {
    const unsolved = perBoard.filter((b) => !b.solved && b.candidates.length > 0);
    if (unsolved.length === 0) return null;
    if (unsolved.length === 1) return unsolved[0].ranked[0] ? unsolved[0].ranked[0].word : null;

    // If any board is down to 1 candidate, lock it in.
    const sure = unsolved.find((b) => b.candidates.length === 1);
    if (sure) return sure.candidates[0];

    // Build a bounded pool: union of each board's candidates + global probes.
    const pool = new Set();
    for (const b of unsolved) for (const w of b.candidates.slice(0, 200)) pool.add(w);
    // add a handful of high-entropy probes from the most-constrained board
    const most = unsolved.slice().sort((a, b) => a.candidates.length - b.candidates.length)[0];
    for (const r of (most.ranked || []).slice(0, 30)) pool.add(r.word);

    let best = null, bestScore = -1;
    const minLen = Math.min(...unsolved.map((b) => b.candidates.length));
    for (const g of pool) {
      let s = 0;
      for (const b of unsolved) s += S.entropyOf(g, b.candidates);
      // bias toward solving the most-constrained board outright
      if (most.candidates.includes(g)) s += 0.15 / minLen;
      if (s > bestScore) { bestScore = s; best = g; }
    }
    return best;
  }

  // ---- Read + recompute -----------------------------------------------------
  function refresh() {
    state.adapter = A.detectAdapter();
    if (!state.adapter) { render(); return; }
    let boards = [];
    try { boards = state.adapter.getBoards(); } catch (e) { console.warn(e); }
    state.boards = boards;
    state.perBoard = boards.map((b) => computeBoard(A.boardToResults(b)));
    const sig = JSON.stringify(boards.map((b) => b.rows.map((r) => r.map((c) => c.letter + c.state[0]).join("")).join("|")));
    if (sig !== state.lastSignature) { state.hintReveal = 0; state.lastSignature = sig; }
    render();
  }

  // ---- Auto-solve loop ------------------------------------------------------
  async function waitForRowEvaluated(prevSubmitted, timeout) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeout || 8000)) {
      const boards = state.adapter.getBoards();
      const submitted = boards.reduce((n, b) => n + A.boardToResults(b).length, 0);
      if (submitted > prevSubmitted) { await sleep(300); return true; } // settle past flip animation
      await sleep(120);
    }
    return false;
  }

  async function autoSolveStep() {
    refresh();
    const word = currentRecommendation();
    if (!word) return false;
    const prev = state.boards.reduce((n, b) => n + A.boardToResults(b).length, 0);
    await state.adapter.type(word);
    await waitForRowEvaluated(prev, 5000);
    refresh();
    return true;
  }

  async function runAutoSolve() {
    if (state.autoSolving) return;
    state.autoSolving = true; render();
    try {
      for (let i = 0; i < 12 && state.autoSolving; i++) {
        refresh();
        if (allSolved()) break;
        const ok = await autoSolveStep();
        if (!ok) break;
        if (allSolved()) break;
        await sleep(300);
      }
    } finally { state.autoSolving = false; refresh(); }
  }

  function allSolved() {
    return state.perBoard.length > 0 && state.perBoard.every((b) => b.solved || b.candidates.length === 0);
  }

  function currentRecommendation() {
    if (state.perBoard.length > 1) return combinedSuggestion(state.perBoard);
    const b = state.perBoard[0];
    if (!b || b.solved) return null;
    return b.ranked[0] ? b.ranked[0].word : null;
  }

  async function typeBest() {
    const w = currentRecommendation();
    if (!w) return;
    const prev = state.boards.reduce((n, b) => n + A.boardToResults(b).length, 0);
    await state.adapter.type(w);
    await waitForRowEvaluated(prev, 5000);
    refresh();
  }

  // ---- UI -------------------------------------------------------------------
  let host, shadow;
  function mountUI() {
    if (host) return;
    host = document.createElement("div");
    host.id = "wordle-solver-host";
    host.style.cssText = "position:fixed;z-index:2147483647;top:16px;right:16px;";
    shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    shadow.appendChild(style);
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.id = "ws-panel";
    shadow.appendChild(panel);
    document.documentElement.appendChild(host);
    makeDraggable(panel);
  }

  function render() {
    if (!shadow) return;
    const panel = shadow.getElementById("ws-panel");
    if (!panel) return;
    const adapterName = state.adapter ? state.adapter.name : "No Wordle board detected";
    const boardsHtml = state.adapter ? renderBoards() : `<div class="muted">Open a Wordle game (e.g. wordleunlimited.org).</div>`;

    panel.innerHTML = `
      <div class="hdr" data-drag>
        <span class="logo">🟩</span>
        <span class="title">Wordle Solver</span>
        <span class="spacer"></span>
        <button class="icon" id="ws-min" title="Minimize">_</button>
      </div>
      <div class="body">
        <div class="modes">
          <button class="tab ${state.mode === "hint" ? "active" : ""}" data-mode="hint">💡 Hint</button>
          <button class="tab ${state.mode === "solver" ? "active" : ""}" data-mode="solver">🤖 Solver</button>
        </div>
        <div class="site">${adapterName}</div>
        ${boardsHtml}
        <div class="opts">
          <label><input type="checkbox" id="ws-ans" ${state.answersOnly ? "checked" : ""}/> guesses from answer list only</label>
        </div>
        <div class="foot">
          <button class="btn ghost" id="ws-refresh">↻ Refresh</button>
          <a class="credit" href="#" id="ws-stats">stats</a>
        </div>
      </div>`;

    // wire events
    panel.querySelectorAll(".tab").forEach((t) => t.onclick = () => { state.mode = t.dataset.mode; saveMode(); render(); });
    const min = panel.querySelector("#ws-min");
    if (min) min.onclick = toggleMin;
    const ref = panel.querySelector("#ws-refresh");
    if (ref) ref.onclick = refresh;
    const ans = panel.querySelector("#ws-ans");
    if (ans) ans.onchange = () => { state.answersOnly = ans.checked; refresh(); };
    panel.querySelectorAll("[data-act]").forEach((el) => el.onclick = () => handleAct(el.dataset.act, el.dataset.word));
    const stats = panel.querySelector("#ws-stats");
    if (stats) stats.onclick = (e) => { e.preventDefault(); alert("Solver: entropy + answer-bias.\nAvg ~3.4 guesses on the 2315-answer set.\nAnswers: " + WORDS.ANSWERS.length + "  Allowed: " + WORDS.ALLOWED.length); };
  }

  function renderBoards() {
    const multi = state.perBoard.length > 1;
    let html = "";

    if (multi) {
      const combined = combinedSuggestion(state.perBoard);
      const solvedCount = state.perBoard.filter((b) => b.solved).length;
      html += `<div class="multi-summary">${state.perBoard.length} boards • ${solvedCount} solved</div>`;
      if (state.mode === "hint") {
        html += hintCard(combined, minRemaining());
      } else {
        html += `<div class="sugg-main"><span class="lbl">Best combined guess</span><div class="word big">${combined || "—"}</div></div>`;
        html += solverButtons(combined);
      }
      html += `<div class="boards-mini">` + state.perBoard.map((b, i) =>
        `<span class="chip ${b.solved ? "done" : ""}">B${i + 1}: ${b.solved ? "✓" : b.candidates.length}</span>`).join("") + `</div>`;
      return html;
    }

    const b = state.perBoard[0];
    if (!b) return `<div class="muted">Reading board…</div>`;
    if (b.solved) return `<div class="solved">✅ Solved!</div>`;
    if (b.candidates.length === 0) return `<div class="muted err">No matching word — check the tiles were read correctly.</div>`;

    if (state.mode === "hint") {
      html += hintCard(b.ranked[0] ? b.ranked[0].word : null, b.candidates.length, b.ranked[0]);
    } else {
      const top = b.ranked[0];
      html += `<div class="sugg-main">
        <span class="lbl">Best guess • ${b.candidates.length} possible</span>
        <div class="word big">${top ? top.word : "—"}</div>
        ${top ? `<div class="metric">${top.entropy.toFixed(2)} bits${top.isCandidate ? " • possible answer" : ""}</div>` : ""}
      </div>`;
      html += solverButtons(top ? top.word : null);
      html += `<div class="alts">` + b.ranked.slice(1, 6).map((r) =>
        `<button class="alt" data-act="fill" data-word="${r.word}">${r.word} <em>${r.entropy.toFixed(2)}</em></button>`).join("") + `</div>`;
    }
    return html;
  }

  function hintCard(word, remaining, top) {
    const lvl = state.hintReveal;
    let reveal;
    if (!word) reveal = "—";
    else if (lvl === 0) reveal = `<span class="muted">${remaining} possible words. Tap to reveal a hint.</span>`;
    else if (lvl === 1) reveal = `starts with <b class="word">${word[0].toUpperCase()}</b>`;
    else if (lvl === 2) reveal = `pattern <b class="word">${word[0].toUpperCase()} _ _ _ ${word[4].toUpperCase()}</b>`;
    else reveal = `<span class="word big">${word}</span>`;
    return `<div class="hint-card">
      <div class="lbl">💡 Hint • ${remaining} possible</div>
      <div class="hint-reveal">${reveal}</div>
      <div class="hint-actions">
        <button class="btn" data-act="reveal">${lvl >= 3 ? "Hide" : "Reveal more"}</button>
      </div>
    </div>`;
  }

  function solverButtons(word) {
    return `<div class="solver-actions">
      <button class="btn primary" data-act="type" ${word ? "" : "disabled"}>⌨ Type best</button>
      ${state.autoSolving
        ? `<button class="btn danger" data-act="stop">■ Stop</button>`
        : `<button class="btn" data-act="auto" ${word ? "" : "disabled"}>▶ Auto-solve</button>`}
    </div>`;
  }

  function minRemaining() {
    const u = state.perBoard.filter((b) => !b.solved && b.candidates.length);
    return u.length ? Math.min(...u.map((b) => b.candidates.length)) : 0;
  }

  function handleAct(act, word) {
    if (act === "reveal") { state.hintReveal = state.hintReveal >= 3 ? 0 : state.hintReveal + 1; render(); }
    else if (act === "type") typeBest();
    else if (act === "auto") runAutoSolve();
    else if (act === "stop") { state.autoSolving = false; }
    else if (act === "fill") { typeSpecific(word); }
  }

  async function typeSpecific(word) {
    if (!state.adapter) return;
    const prev = state.boards.reduce((n, b) => n + A.boardToResults(b).length, 0);
    await state.adapter.type(word);
    await waitForRowEvaluated(prev, 5000);
    refresh();
  }

  function toggleMin() {
    const panel = shadow.getElementById("ws-panel");
    panel.classList.toggle("min");
  }

  function makeDraggable(panel) {
    let down = false, sx, sy, ox, oy;
    panel.addEventListener("mousedown", (e) => {
      if (!e.target.closest("[data-drag]")) return;
      down = true; sx = e.clientX; sy = e.clientY;
      const r = host.getBoundingClientRect(); ox = r.left; oy = r.top;
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!down) return;
      host.style.left = (ox + e.clientX - sx) + "px";
      host.style.top = (oy + e.clientY - sy) + "px";
      host.style.right = "auto";
    });
    window.addEventListener("mouseup", () => down = false);
  }

  function saveMode() {
    try { chrome.storage && chrome.storage.local.set({ mode: state.mode, answersOnly: state.answersOnly }); } catch (e) {}
  }
  function loadPrefs(cb) {
    try {
      chrome.storage.local.get(["mode", "answersOnly"], (v) => {
        if (v.mode) state.mode = v.mode;
        if (typeof v.answersOnly === "boolean") state.answersOnly = v.answersOnly;
        cb();
      });
    } catch (e) { cb(); }
  }

  // React to board changes.
  let observer;
  function observe() {
    observer = new MutationObserver(() => { if (!state.autoSolving) scheduleRefresh(); });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["evaluation", "data-state", "aria-label", "letters"] });
  }
  let rt;
  function scheduleRefresh() { clearTimeout(rt); rt = setTimeout(refresh, 250); }

  // ---- Messaging from popup -------------------------------------------------
  try {
    chrome.runtime.onMessage.addListener((msg, _s, send) => {
      if (msg.type === "setMode") { state.mode = msg.mode; saveMode(); render(); }
      if (msg.type === "getState") send({ mode: state.mode, detected: !!state.adapter, remaining: minRemaining() });
      if (msg.type === "toggle") { host.style.display = host.style.display === "none" ? "" : "none"; }
      return true;
    });
  } catch (e) {}

  // ---- Boot -----------------------------------------------------------------
  function boot() {
    mountUI();
    loadPrefs(() => { refresh(); observe(); });
  }

  const CSS = `
  :host { all: initial; }
  .panel{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;width:300px;background:#fff;color:#1a1a1b;border:1px solid #d3d6da;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.25);overflow:hidden;}
  .panel.min .body{display:none;}
  .hdr{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#6aaa64;color:#fff;cursor:move;user-select:none;}
  .hdr .title{font-weight:700;font-size:15px;}
  .hdr .logo{font-size:16px;}
  .spacer{flex:1;}
  .icon{background:rgba(255,255,255,.2);border:none;color:#fff;width:24px;height:24px;border-radius:6px;cursor:pointer;font-weight:700;}
  .body{padding:12px;}
  .modes{display:flex;gap:6px;margin-bottom:10px;}
  .tab{flex:1;padding:8px;border:1px solid #d3d6da;background:#f6f7f8;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;color:#555;}
  .tab.active{background:#6aaa64;color:#fff;border-color:#6aaa64;}
  .site{font-size:11px;color:#888;margin-bottom:8px;text-align:center;}
  .sugg-main{text-align:center;padding:12px;background:#f6f7f8;border-radius:10px;margin-bottom:8px;}
  .lbl{font-size:12px;color:#787c7e;}
  .word{font-variant:small-caps;letter-spacing:1px;}
  .word.big{font-size:30px;font-weight:800;text-transform:uppercase;letter-spacing:3px;color:#1a1a1b;margin-top:2px;}
  .metric{font-size:11px;color:#6aaa64;margin-top:2px;}
  .solver-actions,.hint-actions{display:flex;gap:6px;margin:8px 0;}
  .btn{flex:1;padding:9px;border:1px solid #d3d6da;background:#fff;border-radius:8px;cursor:pointer;font-size:13px;font-weight:600;}
  .btn:hover{background:#f0f0f0;}
  .btn.primary{background:#6aaa64;color:#fff;border-color:#6aaa64;}
  .btn.danger{background:#e85a4f;color:#fff;border-color:#e85a4f;}
  .btn.ghost{background:transparent;border-color:transparent;color:#787c7e;}
  .btn[disabled]{opacity:.45;cursor:not-allowed;}
  .alts{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;}
  .alt{padding:5px 8px;border:1px solid #d3d6da;background:#fff;border-radius:6px;cursor:pointer;font-size:12px;text-transform:uppercase;letter-spacing:1px;}
  .alt em{color:#c9b458;font-style:normal;font-size:10px;}
  .alt:hover{background:#f0f0f0;}
  .hint-card{text-align:center;padding:14px;background:#f6f7f8;border-radius:10px;}
  .hint-reveal{margin:10px 0;font-size:15px;min-height:28px;}
  .opts{font-size:11px;color:#666;margin:8px 0 4px;}
  .opts input{vertical-align:middle;}
  .foot{display:flex;align-items:center;gap:8px;margin-top:6px;}
  .credit{margin-left:auto;font-size:11px;color:#aaa;text-decoration:none;}
  .muted{color:#888;font-size:13px;text-align:center;padding:8px;}
  .muted.err{color:#e85a4f;}
  .solved{text-align:center;font-size:18px;font-weight:700;color:#6aaa64;padding:14px;}
  .multi-summary{text-align:center;font-size:12px;color:#787c7e;margin-bottom:6px;}
  .boards-mini{display:flex;flex-wrap:wrap;gap:5px;justify-content:center;margin-top:8px;}
  .chip{font-size:11px;padding:3px 7px;border-radius:10px;background:#eee;color:#555;}
  .chip.done{background:#6aaa64;color:#fff;}
  `;

  // Start once CSS (and everything else) is defined.
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
