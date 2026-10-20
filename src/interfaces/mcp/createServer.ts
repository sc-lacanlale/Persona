import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";

import { PersonaEngine } from "../../runtime/engine.js";
import { runEvolutionCycle, type EvolutionConfig } from "../../runtime/evolution.js";

interface PackageIdentity {
  name: string;
  version: string;
}

let identity: PackageIdentity | undefined;

function readPackageString(value: object, field: "name" | "version"): string {
  if (!(field in value)) {
    throw new Error(`package.json is missing ${field}`);
  }
  const record = value as Record<string, unknown>;
  const fieldValue = record[field];
  if (typeof fieldValue !== "string" || fieldValue.trim().length === 0) {
    throw new Error(`package.json ${field} must be a non-empty string`);
  }
  return fieldValue;
}

function packageIdentity(): PackageIdentity {
  if (identity !== undefined) {
    return identity;
  }
  const packagePath = fileURLToPath(new URL("../../../package.json", import.meta.url));
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Could not read package.json at ${packagePath}: ${message}`, {
      cause: error,
    });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`package.json at ${packagePath} is not an object`);
  }
  const next = {
    name: readPackageString(parsed, "name"),
    version: readPackageString(parsed, "version"),
  };
  identity = next;
  return next;
}

function firstVariable(value: string | string[] | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return "";
}

function fail(message: string): {
  content: [{ type: "text"; text: string }];
  isError: true;
} {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

const nonEmpty = z.string().min(1);

const processInput = z.object({
  userId: nonEmpty.describe("Profile id written to data/profiles/user_<id>_state.md."),
  userMessage: nonEmpty.describe("The user turn to record and scan for unmapped terms."),
  personaName: nonEmpty.describe("Directory name under data/personas/."),
});

const processOutput = z.object({
  systemInstruction: z.string(),
  userId: z.string(),
  personaName: z.string(),
  updatedAt: z.string(),
  candidateCount: z.number().int(),
});

const harvestInput = z.object({
  userId: nonEmpty.describe("Profile that should remember the term."),
  personaName: nonEmpty.describe("Persona the term belongs to."),
  term: nonEmpty.describe("Idiom or identifier to queue."),
  context: z.string().default("manual").describe("Where the term showed up."),
  sourceType: z.enum(["text", "code"]).default("text").describe("text or code."),
});

const harvestOutput = z.object({
  term: z.string(),
  personaName: z.string(),
  userId: z.string(),
  queued: z.boolean(),
});

const readInput = z.object({
  personaName: nonEmpty.describe("Persona whose DIALECT_DELTA.md should be read."),
});

const readOutput = z.object({
  personaName: z.string(),
  dialectDelta: z.string(),
});

const evolutionInput = z.object({
  minOccurrences: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(2)
    .describe("Promote a term once it has been seen this many times."),
});

const evolutionOutput = z.object({
  acceptedCount: z.number().int(),
  scannedProfiles: z.number().int(),
});

const promptArgs = z.object({
  userId: nonEmpty,
  userMessage: nonEmpty,
  personaName: nonEmpty,
});

export function createPersonaServer(baseDir?: string): McpServer {
  const engine = new PersonaEngine(baseDir === undefined ? {} : { baseDir });
  const { name, version } = packageIdentity();
  const server = new McpServer({ name, version });

  server.registerTool(
    "process_user_turn",
    {
      title: "Process user turn",
      description:
        "Load PERSONA.md, DIALECT_DELTA.md, and the user profile, record the turn, and return the compiled protocol.",
      inputSchema: processInput,
      outputSchema: processOutput,
    },
    async ({ userId, userMessage, personaName }) => {
      try {
        const result = await engine.processUserTurn(userId, userMessage, personaName);
        const structured = {
          systemInstruction: result.systemInstruction,
          userId: result.profileMetadata.userId,
          personaName: result.profileMetadata.personaName,
          updatedAt: result.profileMetadata.updatedAt,
          candidateCount: result.profileMetadata.candidateCount,
        };
        return {
          content: [{ type: "text" as const, text: result.systemInstruction }],
          structuredContent: structured,
        };
      } catch (error: unknown) {
        return fail(errorMessage(error));
      }
    },
  );

  server.registerTool(
    "harvest_idiom_delta",
    {
      title: "Harvest idiom",
      description: "Queue one term on a user profile so a later evolution cycle can promote it.",
      inputSchema: harvestInput,
      outputSchema: harvestOutput,
    },
    async ({ userId, personaName, term, context, sourceType }) => {
      try {
        await engine.harvestIdiomDelta(userId, personaName, term, context, sourceType);
        const structured = { term, personaName, userId, queued: true };
        return {
          content: [
            {
              type: "text" as const,
              text: `Queued term "${term}" for persona "${personaName}".`,
            },
          ],
          structuredContent: structured,
        };
      } catch (error: unknown) {
        return fail(errorMessage(error));
      }
    },
  );

  server.registerTool(
    "read_dialect_delta",
    {
      title: "Read dialect delta",
      description:
        "Return DIALECT_DELTA.md for one persona. Creates the template if the file is missing.",
      inputSchema: readInput,
      outputSchema: readOutput,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ personaName }) => {
      try {
        const dialectDelta = await engine.readDialectDelta(personaName);
        return {
          content: [{ type: "text" as const, text: dialectDelta }],
          structuredContent: { personaName, dialectDelta },
        };
      } catch (error: unknown) {
        return fail(errorMessage(error));
      }
    },
  );

  server.registerTool(
    "run_evolution_cycle",
    {
      title: "Run evolution cycle",
      description:
        "Promote recurring unmapped terms into each persona's DIALECT_DELTA.md. Terms already present are not appended again.",
      inputSchema: evolutionInput,
      outputSchema: evolutionOutput,
    },
    async ({ minOccurrences }) => {
      try {
        const cycleConfig: EvolutionConfig = { minOccurrences };
        if (baseDir !== undefined) {
          cycleConfig.baseDir = baseDir;
        }
        const report = await runEvolutionCycle(cycleConfig);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(report) }],
          structuredContent: report,
        };
      } catch (error: unknown) {
        return fail(errorMessage(error));
      }
    },
  );

  server.registerPrompt(
    "get_adaptive_persona",
    {
      title: "Adaptive persona",
      description: "Compile the three-tier persona protocol for one user turn.",
      argsSchema: promptArgs,
    },
    async ({ userId, userMessage, personaName }) => {
      const result = await engine.processUserTurn(userId, userMessage, personaName);
      return {
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text: result.systemInstruction },
          },
        ],
      };
    },
  );

  server.registerResource(
    "persona-archetype-delta",
    new ResourceTemplate("persona://archetypes/{personaName}", { list: undefined }),
    {
      title: "Persona dialect delta",
      description: "Raw DIALECT_DELTA.md for one persona.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const personaName = firstVariable(variables.personaName);
      if (personaName.length === 0) {
        throw new Error("personaName is required");
      }
      const dialectDelta = await engine.readDialectDelta(personaName);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: dialectDelta,
          },
        ],
      };
    },
  );

  return server;
}
