import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MarkdownLoader,
  PersonaFileNotFoundError,
  sanitizePathSegment,
} from "../src/parser/markdownLoader.js";

const directories: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdirTemp();
  directories.push(dir);
  return dir;
}

function mkdirTemp(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "persona-loader-"));
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("sanitizePathSegment", () => {
  it("rejects path segments that would escape the data directory", () => {
    expect(sanitizePathSegment("..")).toBe("default");
    expect(sanitizePathSegment(".")).toBe("default");
    expect(sanitizePathSegment("  ")).toBe("default");
    expect(sanitizePathSegment("foo/../../x")).toBe("foo_.._.._x");
    expect(sanitizePathSegment("a/b")).toBe("a_b");
  });
});

describe("MarkdownLoader", () => {
  it("keeps persona and profile paths inside the data directories", async () => {
    const dir = await tempDir();
    const loader = new MarkdownLoader({ baseDir: dir });
    const paths = loader.buildPaths("..", "../etc");
    const personas = path.join(dir, "data", "personas");
    const profiles = path.join(dir, "data", "profiles");

    expect(paths.personaDir.startsWith(personas + path.sep)).toBe(true);
    expect(path.basename(paths.personaDir)).toBe("default");
    expect(paths.profilePath.startsWith(profiles + path.sep)).toBe(true);
    expect(path.basename(paths.profilePath)).toBe("user_.._etc_state.md");
  });

  it("throws when the persona file is missing", async () => {
    const dir = await tempDir();
    const loader = new MarkdownLoader({ baseDir: dir });
    const paths = loader.buildPaths("missing", "user");

    await expect(loader.readRequiredPersonaCore(paths.personaCorePath)).rejects.toBeInstanceOf(
      PersonaFileNotFoundError,
    );
  });

  it("creates a dialect template and reads it back", async () => {
    const dir = await tempDir();
    const loader = new MarkdownLoader({ baseDir: dir });
    const dialectPath = loader.buildPaths("frontend-react-architect", "user").dialectDeltaPath;

    const created = await loader.readOrCreateDialectDelta(dialectPath, "frontend-react-architect");
    const reread = await loader.readOrCreateDialectDelta(dialectPath, "frontend-react-architect");

    expect(created).toContain("Persona: frontend-react-architect");
    expect(created).toContain("## Accepted Terms");
    expect(reread).toBe(created);
  });

  it("round-trips an empty profile without turning the (none) placeholder into context", async () => {
    const dir = await tempDir();
    const loader = new MarkdownLoader({ baseDir: dir });
    const profilePath = loader.buildPaths("frontend-react-architect", "dev").profilePath;

    const created = await loader.readOrCreateProfile(profilePath, "dev");
    await loader.writeProfile(profilePath, created);
    const loaded = await loader.readOrCreateProfile(profilePath, "fallback");

    expect(created.interactionContext).toEqual([]);
    expect(created.unmappedCandidates).toEqual([]);
    expect(loaded.userId).toBe("dev");
    expect(loaded.interactionContext).toEqual([]);
    expect(loaded.unmappedCandidates).toEqual([]);
    expect(await readFile(profilePath, "utf8")).toContain("- (none)");
  });

  it("round-trips every interaction line and candidate, not just the first", async () => {
    const dir = await tempDir();
    const loader = new MarkdownLoader({ baseDir: dir });
    const profilePath = loader.buildPaths("frontend-react-architect", "dev").profilePath;
    const state = {
      userId: "dev",
      personaName: "frontend-react-architect",
      updatedAt: "2026-01-01T00:00:00.000Z",
      interactionContext: ["first turn", "second turn"],
      unmappedCandidates: [
        {
          term: "slay",
          context: "one",
          personaName: "frontend-react-architect",
          firstSeenAt: "2026-01-01T00:00:00.000Z",
          occurrences: 1,
          sourceType: "text" as const,
        },
        {
          term: "glasswave",
          context: "two",
          personaName: "frontend-react-architect",
          firstSeenAt: "2026-01-01T00:00:00.000Z",
          occurrences: 2,
          sourceType: "text" as const,
        },
      ],
    };

    await loader.writeProfile(profilePath, state);
    const loaded = await loader.readOrCreateProfile(profilePath, "dev");

    expect(loaded.interactionContext).toEqual(["first turn", "second turn"]);
    expect(loaded.unmappedCandidates.map((item) => item.term)).toEqual(["slay", "glasswave"]);
  });

  it("keeps pipes out of delimited candidate fields", async () => {
    const dir = await tempDir();
    const loader = new MarkdownLoader({ baseDir: dir });
    const profilePath = loader.buildPaths("frontend-react-architect", "dev").profilePath;
    const state = {
      userId: "dev",
      personaName: "frontend-react-architect",
      updatedAt: "2026-01-01T00:00:00.000Z",
      interactionContext: ["line one\nline two"],
      unmappedCandidates: [
        {
          term: "glass|wave",
          context: "left | right\nnext",
          personaName: "frontend-react-architect",
          firstSeenAt: "2026-01-01T00:00:00.000Z",
          occurrences: 2,
          sourceType: "code" as const,
        },
      ],
    };

    await loader.writeProfile(profilePath, state);
    const loaded = await loader.readOrCreateProfile(profilePath, "dev");

    expect(loaded.interactionContext).toEqual(["line one line two"]);
    expect(loaded.unmappedCandidates).toEqual([
      {
        term: "glass/wave",
        context: "left / right next",
        personaName: "frontend-react-architect",
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        occurrences: 2,
        sourceType: "code",
      },
    ]);
  });

  it("writes through a temp file and replaces the destination", async () => {
    const dir = await tempDir();
    const loader = new MarkdownLoader({ baseDir: dir });
    const target = path.join(dir, "nested", "state.md");

    await loader.atomicWrite(target, "first\r\nline");
    await loader.atomicWrite(target, "second\n");

    expect(await readFile(target, "utf8")).toBe("second\n");
    const names = await readdir(path.dirname(target));
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("removes the temp file when the rename fails", async () => {
    const dir = await tempDir();
    const loader = new MarkdownLoader({ baseDir: dir });
    const blocked = path.join(dir, "blocked");
    await mkdir(blocked);

    await expect(loader.atomicWrite(blocked, "nope")).rejects.toThrow();

    const names = await readdir(dir);
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(names).toContain("blocked");
  });

  it("lists only markdown profiles", async () => {
    const dir = await tempDir();
    const loader = new MarkdownLoader({ baseDir: dir });
    const profilePath = loader.buildPaths("frontend-react-architect", "dev").profilePath;
    await loader.readOrCreateProfile(profilePath, "dev");
    await writeFile(path.join(path.dirname(profilePath), "notes.txt"), "ignore");

    const listed = await loader.listProfilePaths();
    expect(listed).toEqual([profilePath]);
  });
});
