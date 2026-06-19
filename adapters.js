// Site adapters. Each adapter knows how to read board state and type guesses for a
// family of Wordle-type sites. A board is: { cols, rows: [[{letter, state}...]], solved }
// where state in {"empty","absent","present","correct"}.
(function (root) {
  "use strict";

  const STATE_MAP = { absent: "absent", present: "present", correct: "correct", a: "absent", p: "present", c: "correct" };
  function normState(v) {
    if (!v) return "empty";
    v = String(v).toLowerCase();
    return STATE_MAP[v] || "empty";
  }
  const CODE = { empty: -1, absent: 0, present: 1, correct: 2 };

  // Dispatch a physical-style keystroke on the document (works for most clones).
  function pressKey(key) {
    const opts = { key, code: keyCode(key), bubbles: true, cancelable: true };
    document.dispatchEvent(new KeyboardEvent("keydown", opts));
    document.dispatchEvent(new KeyboardEvent("keyup", opts));
  }
  function keyCode(key) {
    if (key === "Enter") return "Enter";
    if (key === "Backspace") return "Backspace";
    return "Key" + key.toUpperCase();
  }
  async function typeWordViaKeyboard(word, perKeyDelay) {
    for (const ch of word) { pressKey(ch); await sleep(perKeyDelay || 45); }
    await sleep(40);
    pressKey("Enter");
  }
  // Type with verification: clear the active row, type at a safe cadence, confirm the
  // letters landed, then submit. This cadence (50ms/key, 80ms settle, single Enter) was
  // validated live to submit reliably without dropped keystrokes. `verify` reads back the
  // currently-typed letters (lowercased), or returns null when the site can't be inspected.
  // `submitted` (optional) returns true once the guess registered as a completed row, used
  // to retry a dropped Enter.
  async function typeVerified(word, verify, submitted) {
    for (let attempt = 0; attempt < 3; attempt++) {
      for (let i = 0; i < 6; i++) { pressKey("Backspace"); await sleep(16); }
      for (const ch of word) { pressKey(ch); await sleep(50); }
      await sleep(80);
      const got = verify ? verify() : null;
      if (got != null && got !== word) continue; // dropped a key — retype
      pressKey("Enter");
      if (!submitted) return true;
      for (let i = 0; i < 25; i++) { await sleep(120); if (submitted()) return true; }
      // Enter may have been dropped; loop retypes and tries again.
    }
    return false;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- Adapter: open-source "game-app" shadow-DOM clones --------------------
  // Covers wordleunlimited.org, many wordle-clone mirrors.
  const gameAppAdapter = {
    id: "game-app",
    name: "Wordle (game-app clone)",
    cols: 5,
    detect() { return !!document.querySelector("game-app") && !!document.querySelector("game-app").shadowRoot; },
    _rows() {
      const sr = document.querySelector("game-app").shadowRoot;
      return [...sr.querySelectorAll("game-row")];
    },
    getBoards() {
      const rows = this._rows().map((r) => {
        const tiles = [...r.shadowRoot.querySelectorAll("game-tile")];
        return tiles.map((t) => ({ letter: (t.getAttribute("letter") || "").toLowerCase(), state: normState(t.getAttribute("evaluation")) }));
      });
      return [{ cols: 5, rows, solved: isSolved(rows) }];
    },
    _activeRow() {
      return this._rows().find((r) => {
        const t = r.shadowRoot.querySelector("game-tile");
        return t && !t.getAttribute("evaluation");
      });
    },
    async type(word) {
      const row = this._activeRow();
      const verify = row ? () => (row.getAttribute("letters") || "").toLowerCase() : null;
      const submitted = row ? () => !!row.shadowRoot.querySelector("game-tile").getAttribute("evaluation") : null;
      await typeVerified(word, verify, submitted);
    },
  };

  // ---- Adapter: NYT Wordle --------------------------------------------------
  const nytAdapter = {
    id: "nyt",
    name: "NYT Wordle",
    cols: 5,
    detect() {
      return /(\.)?nytimes\.com$/.test(location.hostname) && !!document.querySelector('[class*="Board"] [data-state], [aria-label="Game Board"]');
    },
    getBoards() {
      const board = document.querySelector('[aria-label="Game Board"], [class*="Board-module"]');
      if (!board) return [];
      const rowEls = [...board.querySelectorAll('[class*="Row-module"], [role="group"]')];
      const rows = rowEls.map((re) =>
        [...re.querySelectorAll('[data-state]')].map((t) => ({
          letter: (t.textContent || "").trim().toLowerCase().slice(0, 1),
          state: normState(t.getAttribute("data-state")),
        }))
      ).filter((r) => r.length === 5);
      return [{ cols: 5, rows, solved: isSolved(rows) }];
    },
    async type(word) { await typeWordViaKeyboard(word); },
  };

  // ---- Adapter: Quordle (4 simultaneous boards) -----------------------------
  const quordleAdapter = {
    id: "quordle",
    name: "Quordle",
    cols: 5,
    detect() {
      return /quordle/.test(location.hostname) || document.querySelectorAll('[aria-label*="Quordle"], [class*="quordle"]').length > 0
        || readQuordleBoards().length >= 2;
    },
    getBoards() { return readQuordleBoards(); },
    async type(word) { await typeWordViaKeyboard(word, 45); },
  };

  function readQuordleBoards() {
    // Quordle renders 4 grids; tiles carry an aria-label like "Row 1, column 1, A, correct".
    const tiles = [...document.querySelectorAll('[role="img"][aria-label*="column"]')];
    if (tiles.length === 0) return [];
    // Group into boards. Quordle wraps each grid in a container; fall back to chunking by 30 (6x5).
    const boardEls = [...document.querySelectorAll('[class*="quordle-board"], [data-testid*="board"], [aria-label*="board"]')];
    const groups = [];
    if (boardEls.length >= 2) {
      for (const be of boardEls) {
        const ts = [...be.querySelectorAll('[role="img"][aria-label*="column"]')];
        if (ts.length) groups.push(ts);
      }
    }
    if (groups.length < 2) {
      // chunk all tiles into boards of 30
      for (let i = 0; i < tiles.length; i += 30) groups.push(tiles.slice(i, i + 30));
    }
    return groups.map((ts) => {
      const rows = [];
      for (let i = 0; i < ts.length; i += 5) {
        rows.push(ts.slice(i, i + 5).map((t) => parseAriaTile(t)));
      }
      return { cols: 5, rows, solved: isSolved(rows) };
    });
  }
  function parseAriaTile(t) {
    const lbl = (t.getAttribute("aria-label") || "").toLowerCase();
    let letter = "", state = "empty";
    const m = lbl.match(/column\s*\d+,\s*([a-z])?,?\s*(correct|present|absent|empty|wrong|elsewhere)?/);
    if (m) {
      letter = m[1] || "";
      const s = m[2] || "";
      if (s === "correct") state = "correct";
      else if (s === "present" || s === "elsewhere") state = "present";
      else if (s === "absent" || s === "wrong") state = "absent";
    }
    return { letter, state };
  }

  // ---- Generic fallback: any grid of [data-state] / class tiles -------------
  const genericAdapter = {
    id: "generic",
    name: "Generic Wordle",
    cols: 5,
    detect() {
      return document.querySelectorAll('[data-state="correct"],[data-state="present"],[data-state="absent"]').length > 0;
    },
    getBoards() {
      const tiles = [...document.querySelectorAll('[data-state]')].filter((t) => /^(correct|present|absent|empty|tbd)$/.test(t.getAttribute("data-state")));
      const rows = [];
      for (let i = 0; i + 5 <= tiles.length; i += 5) {
        rows.push(tiles.slice(i, i + 5).map((t) => ({ letter: (t.textContent || "").trim().toLowerCase().slice(0, 1), state: normState(t.getAttribute("data-state")) })));
      }
      return [{ cols: 5, rows, solved: isSolved(rows) }];
    },
    async type(word) { await typeWordViaKeyboard(word); },
  };

  function isSolved(rows) {
    return rows.some((r) => r.length && r.every((c) => c.state === "correct"));
  }

  const ALL = [gameAppAdapter, nytAdapter, quordleAdapter, genericAdapter];

  function detectAdapter() {
    // quordle before single-board generic; game-app is most specific for our target.
    for (const a of [gameAppAdapter, nytAdapter, quordleAdapter, genericAdapter]) {
      try { if (a.detect()) return a; } catch (e) {}
    }
    return null;
  }

  // Convert a board's completed rows into solver constraints: list of {guess, code}.
  // A row counts as "submitted" only if all tiles have a non-empty evaluation.
  function boardToResults(board) {
    const out = [];
    for (const row of board.rows) {
      if (row.length < 5) continue;
      if (!row.every((c) => c.state !== "empty" && c.letter)) continue;
      const guess = row.map((c) => c.letter).join("");
      const code = row.reduce((acc, c) => acc * 3 + CODE[c.state], 0);
      out.push({ guess, code });
    }
    return out;
  }

  const API = { ALL, detectAdapter, boardToResults, pressKey, typeWordViaKeyboard, typeVerified, isSolved, CODE };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  root.WordleAdapters = API;
})(typeof self !== "undefined" ? self : this);
