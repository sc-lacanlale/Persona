import type { PersonaDocuments } from "../runtime/types.js";

const HEADER = "# PERSONA ENGINE PROTOCOL";

function normalizeBlock(input: string): string {
  return input.replace(/\r\n/g, "\n").trim();
}

export function compilePersonaProtocol(documents: PersonaDocuments): string {
  const personaCore = normalizeBlock(documents.personaCore);
  const dialectDelta = normalizeBlock(documents.dialectDelta);
  const userProfile = normalizeBlock(documents.userProfile);

  return [
    HEADER,
    "",
    "## Tier 1 Core Persona",
    personaCore.length > 0 ? personaCore : "(empty)",
    "",
    "## Tier 2 Dialect Delta",
    dialectDelta.length > 0 ? dialectDelta : "(empty)",
    "",
    "## Tier 3 User State",
    userProfile.length > 0 ? userProfile : "(empty)",
    "",
  ].join("\n");
}
