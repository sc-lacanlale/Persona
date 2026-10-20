import type { CandidateTerm } from "./types.js";

const TOKEN_REGEX = /[A-Za-z][A-Za-z0-9_-]{2,}/g;
const CODE_HINT_REGEX = /[`{}()[\];<>_=]/;

export function knownTermsFromDialect(dialectDelta: string): Set<string> {
  const terms = new Set<string>();
  const lines = dialectDelta.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    const termMatch = line.match(/term:\s*([^|]+)/i);
    if (termMatch?.[1]) {
      terms.add(termMatch[1].trim().toLowerCase());
      continue;
    }

    if (line.trim().startsWith("- ")) {
      const plain = line.trim().slice(2).trim();
      if (plain !== "(none)" && plain.length > 0) {
        terms.add(plain.toLowerCase());
      }
    }
  }
  return terms;
}

export function detectUnmappedCandidates(
  message: string,
  dialectDelta: string,
  personaName: string,
  nowIso: string = new Date().toISOString(),
): CandidateTerm[] {
  const knownTerms = knownTermsFromDialect(dialectDelta);
  const sourceType = CODE_HINT_REGEX.test(message) ? "code" : "text";
  const matches = message.match(new RegExp(TOKEN_REGEX.source, "g")) ?? [];

  const seen = new Set<string>();
  const candidates: CandidateTerm[] = [];
  for (const token of matches) {
    const normalized = token.toLowerCase();
    if (knownTerms.has(normalized) || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    candidates.push({
      term: token,
      context: message.length > 280 ? `${message.slice(0, 277)}...` : message,
      personaName,
      firstSeenAt: nowIso,
      occurrences: 1,
      sourceType,
    });
  }

  return candidates;
}
