// Splits reading text into synthesis-sized chunks.
//
// Chunking is what makes playback feel immediate: the first chunk is spoken
// while the rest are still being generated. Boundaries follow paragraphs first,
// then sentences, so pauses land where a reader would pause anyway. Ported from
// the Android app's Chunker.kt — keep the two in sync so desktop and phone
// produce the same chunking (and therefore the same audio).

const MAX_CHARS = 400;
const MIN_CHARS = 120;

// Sentence end: .?!… (optionally a closing quote) then whitespace.
const SENTENCE_END = /(?<=[.!?…]["'»”’)]?)\s+/;

export function chunkText(text: string): string[] {
  const paragraphs = text
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);

  const out: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= MAX_CHARS) {
      out.push(p);
    } else {
      out.push(...packSentences(splitLongSentences(p.split(SENTENCE_END))));
    }
  }
  return mergeRunts(out);
}

/** Greedily fill chunks up to MAX_CHARS on sentence boundaries. */
function packSentences(sentences: string[]): string[] {
  const out: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (current.length === 0) {
      current = s;
    } else if (current.length + 1 + s.length <= MAX_CHARS) {
      current += " " + s;
    } else {
      out.push(current);
      current = s;
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** A single over-long sentence is broken at commas/semicolons, then whitespace. */
function splitLongSentences(sentences: string[]): string[] {
  const out: string[] = [];
  for (const s of sentences) {
    if (s.length <= MAX_CHARS) {
      out.push(s);
      continue;
    }
    for (const part of s.split(/(?<=[,;:])\s+/)) {
      if (part.length <= MAX_CHARS) out.push(part);
      else out.push(...hardWrap(part));
    }
  }
  return out;
}

function hardWrap(s: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const word of s.split(" ")) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= MAX_CHARS) {
      current += " " + word;
    } else {
      out.push(current);
      current = word;
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** Fold very short fragments into their neighbour so playback doesn't stutter. */
function mergeRunts(chunks: string[]): string[] {
  if (chunks.length < 2) return chunks;
  const out: string[] = [];
  for (const c of chunks) {
    const last = out.length > 0 ? out[out.length - 1] : null;
    const runt = last !== null && (last.length < MIN_CHARS || c.length < MIN_CHARS);
    if (last !== null && runt && last.length + 1 + c.length <= MAX_CHARS) {
      out[out.length - 1] = `${last} ${c}`;
    } else {
      out.push(c);
    }
  }
  return out;
}
