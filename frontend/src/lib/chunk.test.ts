// Parity + regression tests for the reading chunker.
//
// Run with `npm test` (node's built-in runner; node strips the type annotations,
// so this needs no test framework and no extra dependency).
//
// The cases live in ../../../tests/fixtures/chunking.json rather than here
// because the Android app's text/Chunker.kt must produce exactly the same output
// — the two were kept in step by a comment until now, and a divergence would
// mean the phone and the desktop generate different audio for the same reading.
// Its ChunkerParityTest reads a copy of this same file.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chunkText } from "./chunk.ts";

interface Fixture {
  cases: { name: string; input: string; expected: string[] }[];
}

const fixturePath = fileURLToPath(new URL("../../../tests/fixtures/chunking.json", import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

for (const c of fixture.cases) {
  test(`chunkText — ${c.name}`, () => {
    assert.deepEqual(chunkText(c.input), c.expected);
  });
}

// Invariants the fixture cannot express case-by-case, checked across all of it.
test("chunkText never exceeds MAX_CHARS except on an unbreakable word", () => {
  for (const c of fixture.cases) {
    for (const chunk of chunkText(c.input)) {
      const unbreakable = !chunk.includes(" ");
      assert.ok(
        chunk.length <= 400 || unbreakable,
        `"${c.name}" produced a ${chunk.length}-char chunk that could have been split`,
      );
    }
  }
});

test("chunkText loses no words", () => {
  for (const c of fixture.cases) {
    const words = (s: string) => s.split(/\s+/).filter(Boolean);
    assert.deepEqual(
      chunkText(c.input).flatMap(words),
      words(c.input),
      `"${c.name}" dropped or reordered text`,
    );
  }
});
