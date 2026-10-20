import { compilePersonaProtocol } from "../parser/compiler.js";
import { MarkdownLoader } from "../parser/markdownLoader.js";
import { detectUnmappedCandidates } from "./detector.js";
import type {
  CandidateTerm,
  PersonaDocuments,
  ProcessUserTurnResult,
  ProfileMetadata,
} from "./types.js";

export interface PersonaEngineConfig {
  baseDir?: string;
}

export class PersonaEngine {
  private readonly loader: MarkdownLoader;

  constructor(config: PersonaEngineConfig = {}) {
    this.loader = new MarkdownLoader(config);
  }

  async processUserTurn(
    userId: string,
    message: string,
    personaName: string,
  ): Promise<ProcessUserTurnResult> {
    const nowIso = new Date().toISOString();
    const paths = this.loader.buildPaths(personaName, userId);

    const personaCore = await this.loader.readRequiredPersonaCore(paths.personaCorePath);
    const dialectDelta = await this.loader.readOrCreateDialectDelta(
      paths.dialectDeltaPath,
      personaName,
    );

    const profile = await this.loader.readOrCreateProfile(paths.profilePath, userId);
    profile.personaName = personaName;
    profile.updatedAt = nowIso;
    profile.interactionContext = this.bumpInteractionContext(
      profile.interactionContext,
      message,
      nowIso,
    );

    const detected = detectUnmappedCandidates(message, dialectDelta, personaName, nowIso);
    profile.unmappedCandidates = this.mergeCandidates(profile.unmappedCandidates, detected);

    await this.loader.writeProfile(paths.profilePath, profile);

    const userProfile = this.loader.serializeProfile(profile);
    const documents: PersonaDocuments = { personaCore, dialectDelta, userProfile };
    const systemInstruction = compilePersonaProtocol(documents);

    const profileMetadata: ProfileMetadata = {
      userId,
      personaName,
      updatedAt: nowIso,
      candidateCount: profile.unmappedCandidates.length,
    };

    return { systemInstruction, profileMetadata };
  }

  async harvestIdiomDelta(
    userId: string,
    personaName: string,
    term: string,
    context: string,
    sourceType: "text" | "code" = "text",
  ): Promise<void> {
    const nowIso = new Date().toISOString();
    const paths = this.loader.buildPaths(personaName, userId);
    const profile = await this.loader.readOrCreateProfile(paths.profilePath, userId);
    profile.personaName = personaName;
    profile.updatedAt = nowIso;

    const manualCandidate: CandidateTerm = {
      term,
      context,
      personaName,
      firstSeenAt: nowIso,
      occurrences: 1,
      sourceType,
    };

    profile.unmappedCandidates = this.mergeCandidates(profile.unmappedCandidates, [
      manualCandidate,
    ]);
    await this.loader.writeProfile(paths.profilePath, profile);
  }

  async readDialectDelta(personaName: string): Promise<string> {
    const paths = this.loader.buildPaths(personaName, "system");
    return this.loader.readOrCreateDialectDelta(paths.dialectDeltaPath, personaName);
  }

  private bumpInteractionContext(existing: string[], message: string, nowIso: string): string[] {
    const entry = `${nowIso} :: ${message.replace(/\s+/g, " ").trim()}`;
    return [entry, ...existing].slice(0, 10);
  }

  private mergeCandidates(current: CandidateTerm[], incoming: CandidateTerm[]): CandidateTerm[] {
    const merged = new Map<string, CandidateTerm>();

    for (const item of current) {
      merged.set(this.key(item.personaName, item.term), { ...item });
    }

    for (const candidate of incoming) {
      const key = this.key(candidate.personaName, candidate.term);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...candidate });
        continue;
      }

      merged.set(key, {
        ...existing,
        context: candidate.context,
        occurrences: existing.occurrences + 1,
        sourceType: candidate.sourceType,
      });
    }

    return [...merged.values()].sort((a, b) => b.occurrences - a.occurrences);
  }

  private key(personaName: string, term: string): string {
    return `${personaName.toLowerCase()}::${term.toLowerCase()}`;
  }
}
