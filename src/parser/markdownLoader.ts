import { access, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

import type { CandidateTerm, UserProfileState } from "../runtime/types.js";

const PERSONA_FILE = "PERSONA.md";
const DIALECT_FILE = "DIALECT_DELTA.md";

export class PersonaFileNotFoundError extends Error {
  constructor(filePath: string) {
    super(`Missing required persona source file: ${filePath}`);
    this.name = "PersonaFileNotFoundError";
  }
}

export interface LoaderConfig {
  baseDir?: string;
}

/** Keep persona and user ids as a single path segment. `.` and `..` are rejected. */
export function sanitizePathSegment(value: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9._-]/g, "_");
  if (safe.length === 0 || safe === "." || safe === "..") {
    return "default";
  }
  return safe;
}

export interface PathSet {
  personaDir: string;
  personaCorePath: string;
  dialectDeltaPath: string;
  profilesDir: string;
  profilePath: string;
}

export class MarkdownLoader {
  private readonly baseDir: string;
  private readonly personasDir: string;
  private readonly profilesDir: string;

  constructor(config: LoaderConfig = {}) {
    this.baseDir = config.baseDir ?? process.cwd();
    this.personasDir = path.join(this.baseDir, "data", "personas");
    this.profilesDir = path.join(this.baseDir, "data", "profiles");
  }

  buildPaths(personaName: string, userId: string): PathSet {
    const safePersona = sanitizePathSegment(personaName);
    const safeUser = sanitizePathSegment(userId);
    const personaDir = path.join(this.personasDir, safePersona);
    const profilePath = path.join(this.profilesDir, `user_${safeUser}_state.md`);

    return {
      personaDir,
      personaCorePath: path.join(personaDir, PERSONA_FILE),
      dialectDeltaPath: path.join(personaDir, DIALECT_FILE),
      profilesDir: this.profilesDir,
      profilePath,
    };
  }

  async listProfilePaths(): Promise<string[]> {
    await this.ensureDir(this.profilesDir);
    const entries = await readdir(this.profilesDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => path.join(this.profilesDir, entry.name));
  }

  async readRequiredPersonaCore(personaPath: string): Promise<string> {
    await this.ensureReadable(personaPath, true);
    return this.normalizeNewlines(await readFile(personaPath, "utf8")).trim();
  }

  async readOrCreateDialectDelta(dialectPath: string, personaName: string): Promise<string> {
    await this.ensureDir(path.dirname(dialectPath));
    const exists = await this.exists(dialectPath);
    if (!exists) {
      const template = this.renderDialectTemplate(personaName);
      await this.atomicWrite(dialectPath, template);
      return template;
    }
    return this.normalizeNewlines(await readFile(dialectPath, "utf8"));
  }

  async readOrCreateProfile(profilePath: string, userId: string): Promise<UserProfileState> {
    await this.ensureDir(path.dirname(profilePath));
    const exists = await this.exists(profilePath);
    if (!exists) {
      const initial = this.defaultProfile(userId);
      await this.atomicWrite(profilePath, this.serializeProfile(initial));
      return initial;
    }
    const content = this.normalizeNewlines(await readFile(profilePath, "utf8"));
    return this.parseProfile(content, userId);
  }

  async writeProfile(profilePath: string, state: UserProfileState): Promise<void> {
    const rendered = this.serializeProfile(state);
    await this.atomicWrite(profilePath, rendered);
  }

  async appendToDialectDelta(
    dialectPath: string,
    appendContent: string,
    personaName = "unknown",
  ): Promise<void> {
    const existing = await this.readOrCreateDialectDelta(dialectPath, personaName);
    const rendered = `${existing.trimEnd()}\n\n${appendContent.trim()}\n`;
    await this.atomicWrite(dialectPath, rendered);
  }

  async readIfExists(filePath: string): Promise<string | null> {
    if (!(await this.exists(filePath))) {
      return null;
    }
    return this.normalizeNewlines(await readFile(filePath, "utf8"));
  }

  async ensureDir(dirPath: string): Promise<void> {
    await mkdir(dirPath, { recursive: true });
  }

  async atomicWrite(filePath: string, content: string): Promise<void> {
    await this.ensureDir(path.dirname(filePath));
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await writeFile(tempPath, this.normalizeNewlines(content), "utf8");
      await rename(tempPath, filePath);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  parseProfile(markdown: string, userIdFallback: string): UserProfileState {
    const normalized = this.normalizeNewlines(markdown);

    const userId = this.captureValue(normalized, /- userId: (.+)/) ?? userIdFallback;
    const personaName = this.captureValue(normalized, /- personaName: (.+)/) ?? "default";
    const updatedAt =
      this.captureValue(normalized, /- updatedAt: (.+)/) ?? new Date().toISOString();

    const interactionBlock = this.captureSection(normalized, "## Interaction Context");
    const interactionContext = interactionBlock
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- "))
      .map((line) => line.slice(2).trim())
      .filter((line) => line.length > 0 && line !== "(none)");

    const candidatesBlock = this.captureSection(normalized, "## Unmapped Candidates");
    const unmappedCandidates = this.parseCandidates(candidatesBlock, personaName);

    return {
      userId,
      personaName,
      updatedAt,
      interactionContext,
      unmappedCandidates,
    };
  }

  serializeProfile(state: UserProfileState): string {
    const interactionEntries = state.interactionContext
      .map((entry) => this.field(entry))
      .filter((entry) => entry.length > 0);
    const interactionLines =
      interactionEntries.length > 0
        ? interactionEntries.map((entry) => `- ${entry}`).join("\n")
        : "- (none)";

    const candidateLines =
      state.unmappedCandidates.length > 0
        ? state.unmappedCandidates
            .map((item) => {
              return `- term: ${this.field(item.term)} | persona: ${this.field(item.personaName)} | occurrences: ${item.occurrences} | firstSeenAt: ${item.firstSeenAt} | sourceType: ${item.sourceType} | context: ${this.field(item.context)}`;
            })
            .join("\n")
        : "- (none)";

    return [
      "# User State",
      "",
      "## Metadata",
      `- userId: ${state.userId}`,
      `- personaName: ${state.personaName}`,
      `- updatedAt: ${state.updatedAt}`,
      "",
      "## Interaction Context",
      interactionLines,
      "",
      "## Unmapped Candidates",
      candidateLines,
      "",
    ].join("\n");
  }

  private defaultProfile(userId: string): UserProfileState {
    return {
      userId,
      personaName: "default",
      updatedAt: new Date().toISOString(),
      interactionContext: [],
      unmappedCandidates: [],
    };
  }

  private parseCandidates(section: string, fallbackPersona: string): CandidateTerm[] {
    const lines = section
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("- term: "));

    return lines
      .map((line) => {
        const parts = line
          .slice(2)
          .split(" | ")
          .map((part) => part.trim());
        const map = new Map<string, string>();
        for (const part of parts) {
          const splitIndex = part.indexOf(":");
          if (splitIndex === -1) continue;
          const key = part.slice(0, splitIndex).trim();
          const value = part.slice(splitIndex + 1).trim();
          map.set(key, value);
        }

        const source = map.get("sourceType");
        const sourceType = source === "code" ? "code" : "text";

        return {
          term: map.get("term") ?? "",
          context: map.get("context") ?? "",
          personaName: map.get("persona") ?? fallbackPersona,
          firstSeenAt: map.get("firstSeenAt") ?? new Date().toISOString(),
          occurrences: Number.parseInt(map.get("occurrences") ?? "1", 10) || 1,
          sourceType,
        } satisfies CandidateTerm;
      })
      .filter((candidate) => candidate.term.length > 0);
  }

  private captureValue(input: string, regex: RegExp): string | null {
    const match = input.match(regex);
    return match?.[1]?.trim() ?? null;
  }

  private captureSection(input: string, sectionTitle: string): string {
    const escaped = sectionTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const expression = new RegExp(`${escaped}\\n([\\s\\S]*?)(\\n## |$)`);
    const match = input.match(expression);
    return match?.[1]?.trim() ?? "";
  }

  private renderDialectTemplate(personaName: string): string {
    return [
      "# DIALECT DELTA",
      "",
      `Persona: ${personaName}`,
      "",
      "## Accepted Terms",
      "- (none)",
      "",
    ].join("\n");
  }

  /** Candidate lines are split on ` | `, so a literal pipe cannot survive in a field. */
  private field(value: string): string {
    return value.replace(/\s+/g, " ").replaceAll("|", "/").trim();
  }

  private normalizeNewlines(content: string): string {
    return content.replace(/\r\n/g, "\n");
  }

  private async ensureReadable(filePath: string, required: boolean): Promise<void> {
    try {
      await access(filePath, constants.R_OK);
    } catch {
      if (required) {
        throw new PersonaFileNotFoundError(filePath);
      }
    }
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await access(filePath, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}
