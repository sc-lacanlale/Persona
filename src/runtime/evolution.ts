import path from "node:path";

import { MarkdownLoader, sanitizePathSegment } from "../parser/markdownLoader.js";
import { knownTermsFromDialect } from "./detector.js";
import type { UserProfileState } from "./types.js";

export interface EvolutionRunResult {
  acceptedCount: number;
  scannedProfiles: number;
}

export interface EvolutionConfig {
  baseDir?: string;
  minOccurrences?: number;
}

interface AggregatedItem {
  personaName: string;
  term: string;
  context: string;
  sourceType: "text" | "code";
  totalOccurrences: number;
}

function candidateKey(personaName: string, term: string): string {
  return `${personaName.trim().toLowerCase()}::${term.trim().toLowerCase()}`;
}

function dialectField(value: string): string {
  return value.replace(/\s+/g, " ").replaceAll("|", "/").trim();
}

function validationPasses(item: AggregatedItem, minOccurrences: number): boolean {
  if (item.totalOccurrences < minOccurrences) return false;
  const normalized = item.term.trim();
  if (normalized.length < 3 || normalized.length > 64) return false;
  if (!/[A-Za-z]/.test(normalized)) return false;
  return true;
}

export async function runEvolutionCycle(config: EvolutionConfig = {}): Promise<EvolutionRunResult> {
  const loader = new MarkdownLoader(config.baseDir ? { baseDir: config.baseDir } : {});
  const minOccurrences = config.minOccurrences ?? 2;
  const profilePaths = await loader.listProfilePaths();

  const profiles: Array<{ path: string; state: UserProfileState }> = [];
  for (const profilePath of profilePaths) {
    const content = await loader.readOrCreateProfile(profilePath, "unknown");
    profiles.push({ path: profilePath, state: content });
  }

  const aggregated = new Map<string, AggregatedItem>();
  for (const profile of profiles) {
    for (const candidate of profile.state.unmappedCandidates) {
      const key = candidateKey(candidate.personaName, candidate.term);
      const existing = aggregated.get(key);
      if (!existing) {
        aggregated.set(key, {
          personaName: candidate.personaName,
          term: candidate.term,
          context: candidate.context,
          sourceType: candidate.sourceType,
          totalOccurrences: candidate.occurrences,
        });
        continue;
      }
      existing.totalOccurrences += candidate.occurrences;
    }
  }

  const removalKeys = new Set<string>();
  let acceptedCount = 0;

  for (const item of aggregated.values()) {
    const key = candidateKey(item.personaName, item.term);
    const dialectPath = path.join(
      config.baseDir ?? process.cwd(),
      "data",
      "personas",
      sanitizePathSegment(item.personaName),
      "DIALECT_DELTA.md",
    );
    const existingDialect = await loader.readIfExists(dialectPath);
    const known =
      existingDialect === null ? new Set<string>() : knownTermsFromDialect(existingDialect);
    if (known.has(item.term.trim().toLowerCase())) {
      removalKeys.add(key);
      continue;
    }
    if (!validationPasses(item, minOccurrences)) {
      continue;
    }

    const line = `- term: ${dialectField(item.term)} | sourceType: ${item.sourceType} | recurrence: ${item.totalOccurrences} | context: ${dialectField(item.context)}`;
    await loader.appendToDialectDelta(dialectPath, `## Accepted Term\n${line}`, item.personaName);
    removalKeys.add(key);
    acceptedCount += 1;
  }

  for (const profile of profiles) {
    profile.state.unmappedCandidates = profile.state.unmappedCandidates.filter(
      (item) => !removalKeys.has(candidateKey(item.personaName, item.term)),
    );
    profile.state.updatedAt = new Date().toISOString();
    await loader.writeProfile(profile.path, profile.state);
  }

  return {
    acceptedCount,
    scannedProfiles: profiles.length,
  };
}
