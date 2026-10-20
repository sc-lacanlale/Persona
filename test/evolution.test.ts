import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MarkdownLoader } from "../src/parser/markdownLoader.js";
import { runEvolutionCycle } from "../src/runtime/evolution.js";
import type { CandidateTerm } from "../src/runtime/types.js";

const PERSONA = "frontend-react-architect";
const directories: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "persona-evolution-"));
  directories.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function candidate(term: string, occurrences: number): CandidateTerm {
  return {
    term,
    context: `context for ${term}`,
    personaName: PERSONA,
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    occurrences,
    sourceType: "text",
  };
}

async function writeProfile(
  loader: MarkdownLoader,
  userId: string,
  candidates: CandidateTerm[],
): Promise<void> {
  const paths = loader.buildPaths(PERSONA, userId);
  await loader.writeProfile(paths.profilePath, {
    userId,
    personaName: PERSONA,
    updatedAt: "2026-01-01T00:00:00.000Z",
    interactionContext: [],
    unmappedCandidates: candidates,
  });
}

function dialectPath(dir: string): string {
  return path.join(dir, "data", "personas", PERSONA, "DIALECT_DELTA.md");
}

async function assertNoTempFiles(dir: string): Promise<void> {
  const entries = await readdir(dir, { recursive: true });
  const temps = entries.filter((entry) => entry.endsWith(".tmp"));
  expect(temps).toEqual([]);
}

describe("runEvolutionCycle", () => {
  it("dedupes the same term across profiles into one dialect line", async () => {
    const dir = await tempDir();
    const loader = new MarkdownLoader({ baseDir: dir });
    await writeProfile(loader, "alpha", [candidate("Slay", 1)]);
    await writeProfile(loader, "beta", [candidate("slay", 1)]);

    const report = await runEvolutionCycle({ baseDir: dir, minOccurrences: 2 });
    const dialect = await readFile(dialectPath(dir), "utf8");

    expect(report).toEqual({ acceptedCount: 1, scannedProfiles: 2 });
    expect(dialect.match(/term: slay/gi)).toHaveLength(1);
    expect(dialect).toContain("recurrence: 2");
    expect(dialect).toContain("Persona: frontend-react-architect");

    for (const userId of ["alpha", "beta"]) {
      const profile = await loader.readOrCreateProfile(
        loader.buildPaths(PERSONA, userId).profilePath,
        userId,
      );
      expect(profile.unmappedCandidates).toEqual([]);
    }
    await assertNoTempFiles(dir);
  });

  it("does not append a term that is already in the dialect", async () => {
    const dir = await tempDir();
    const loader = new MarkdownLoader({ baseDir: dir });
    const target = dialectPath(dir);
    await loader.atomicWrite(
      target,
      [
        "# DIALECT DELTA",
        "",
        "Persona: frontend-react-architect",
        "",
        "## Accepted Terms",
        "- term: slay | sourceType: text",
        "",
      ].join("\n"),
    );
    const before = await readFile(target, "utf8");
    await writeProfile(loader, "alpha", [candidate("slay", 5)]);

    const report = await runEvolutionCycle({ baseDir: dir, minOccurrences: 2 });

    expect(report.acceptedCount).toBe(0);
    expect(report.scannedProfiles).toBe(1);
    expect(await readFile(target, "utf8")).toBe(before);
    const profile = await loader.readOrCreateProfile(
      loader.buildPaths(PERSONA, "alpha").profilePath,
      "alpha",
    );
    expect(profile.unmappedCandidates).toEqual([]);
    await assertNoTempFiles(dir);
  });

  it("leaves terms below the threshold, and does not create a dialect file for them", async () => {
    const dir = await tempDir();
    const loader = new MarkdownLoader({ baseDir: dir });
    await writeProfile(loader, "alpha", [
      candidate("slay", 1),
      candidate("no", 4),
      candidate("12345", 4),
    ]);

    const report = await runEvolutionCycle({ baseDir: dir, minOccurrences: 2 });
    const profile = await loader.readOrCreateProfile(
      loader.buildPaths(PERSONA, "alpha").profilePath,
      "alpha",
    );

    expect(report.acceptedCount).toBe(0);
    expect(profile.unmappedCandidates.map((item) => item.term).sort()).toEqual([
      "12345",
      "no",
      "slay",
    ]);
    await expect(readFile(dialectPath(dir), "utf8")).rejects.toThrow();
  });

  it("ignores non-markdown files when counting profiles", async () => {
    const dir = await tempDir();
    const loader = new MarkdownLoader({ baseDir: dir });
    await writeProfile(loader, "alpha", [candidate("glasswave", 2)]);
    await writeFile(path.join(dir, "data", "profiles", "notes.txt"), "ignore");

    const report = await runEvolutionCycle({ baseDir: dir, minOccurrences: 2 });

    expect(report).toEqual({ acceptedCount: 1, scannedProfiles: 1 });
    expect(await readFile(dialectPath(dir), "utf8")).toContain("term: glasswave");
    await assertNoTempFiles(dir);
  });
});
