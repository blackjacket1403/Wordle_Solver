#!/usr/bin/env python3
"""Regenerate words.js from a Wordle clone's main.js.

The open-source Wordle clone embeds two arrays:
  SOLUTION_LIST  -> the official answer pool (~2315 words)
  WORD_LIST      -> extra accepted guesses (~10657 words)
Valid guesses = the union (~12972). The answer is always in SOLUTION_LIST,
which is exactly the candidate set the solver reasons over.

Usage:
  curl -s https://wordleunlimited.org/main.js -o main.js
  python3 tools/extract_words.py main.js
"""
import re, sys, json, os

src_path = sys.argv[1] if len(sys.argv) > 1 else "main.js"
src = open(src_path).read()

runs = [m.group(0) for m in re.finditer(r'"[a-z]{5}"(?:, ?"[a-z]{5}")+', src)]
runs = sorted((re.findall(r'[a-z]{5}', r) for r in runs), key=len, reverse=True)
allowed_extra, answers = runs[0], runs[1]            # longest = WORD_LIST, next = SOLUTION_LIST
allowed = sorted(set(answers) | set(allowed_extra))  # union = all valid guesses

out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "words.js")
js = (
    "// Auto-generated Wordle word lists (see tools/extract_words.py).\n"
    f"// ANSWERS: official solution pool ({len(answers)}). ALLOWED: all valid guesses ({len(allowed)}).\n"
    "(function(root){\n"
    f'  const ANSWERS = "{",".join(answers)}".split(",");\n'
    f'  const ALLOWED = "{",".join(allowed)}".split(",");\n'
    "  const WL = { ANSWERS, ALLOWED };\n"
    "  if (typeof module !== \"undefined\" && module.exports) module.exports = WL;\n"
    "  root.WORDLE_WORDS = WL;\n"
    "})(typeof self !== \"undefined\" ? self : this);\n"
)
open(out, "w").write(js)
print(f"wrote {out}: answers={len(answers)} allowed={len(allowed)}")
