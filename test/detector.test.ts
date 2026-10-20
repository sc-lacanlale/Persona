import { describe, expect, it } from "vitest";

import { detectUnmappedCandidates, knownTermsFromDialect } from "../src/runtime/detector.js";

const NOW = "2026-01-02T03:04:05.000Z";
const PERSONA = "frontend-react-architect";

describe("knownTermsFromDialect", () => {
  it("reads term fields and plain bullets, and skips the empty placeholder", () => {
    const known = knownTermsFromDialect(
      ["## Accepted Terms", "- (none)", "- frosted-glass", "- term: Slay | sourceType: text"].join(
        "\n",
      ),
    );

    expect(known).toEqual(new Set(["frosted-glass", "slay"]));
  });
});

describe("detectUnmappedCandidates", () => {
  it("returns one candidate per distinct token and skips known dialect terms", () => {
    const dialect = [
      "## Accepted Terms",
      "- slay",
      "- term: frosted-glass | sourceType: text",
    ].join("\n");
    const found = detectUnmappedCandidates(
      "slay slay Slay this frosted-glass panel",
      dialect,
      PERSONA,
      NOW,
    );

    expect(found.map((candidate) => candidate.term)).toEqual(["this", "panel"]);
    expect(found.every((candidate) => candidate.occurrences === 1)).toBe(true);
    expect(found.every((candidate) => candidate.firstSeenAt === NOW)).toBe(true);
    expect(found.every((candidate) => candidate.sourceType === "text")).toBe(true);
    expect(found.every((candidate) => candidate.personaName === PERSONA)).toBe(true);
  });

  it("marks messages that look like code", () => {
    const found = detectUnmappedCandidates("render <Button />", "", PERSONA, NOW);
    const button = found.find((candidate) => candidate.term === "Button");

    expect(button?.sourceType).toBe("code");
  });

  it("ignores tokens shorter than 3 characters and truncates long context", () => {
    const message = `ab ${"x".repeat(300)}`;
    const found = detectUnmappedCandidates(message, "", PERSONA, NOW);

    expect(found.map((candidate) => candidate.term)).toEqual(["x".repeat(300)]);
    expect(found[0]?.context.endsWith("...")).toBe(true);
    expect(found[0]?.context.length).toBe(280);
  });
});
