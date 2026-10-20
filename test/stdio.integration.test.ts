import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const serverJs = path.join(repoRoot, "dist", "interfaces", "mcp", "stdioServer.js");
const PERSONA = "frontend-react-architect";

const TOOLS = [
  "harvest_idiom_delta",
  "process_user_turn",
  "read_dialect_delta",
  "run_evolution_cycle",
] as const;

beforeAll(() => {
  const tsc = path.join(repoRoot, "node_modules", "typescript", "lib", "tsc.js");
  const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`tsc failed\n${result.stdout}\n${result.stderr}`);
  }
}, 60_000);

async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "persona-mcp-"));
  const source = path.join(repoRoot, "data", "personas", PERSONA);
  const target = path.join(dir, "data", "personas", PERSONA);
  await mkdir(target, { recursive: true });
  await copyFile(path.join(source, "PERSONA.md"), path.join(target, "PERSONA.md"));
  await copyFile(path.join(source, "DIALECT_DELTA.md"), path.join(target, "DIALECT_DELTA.md"));
  return dir;
}

function childEnv(baseDir: string): Record<string, string> {
  const env: Record<string, string> = { PERSONA_BASE_DIR: baseDir };
  const pathValue = process.env.PATH;
  if (pathValue !== undefined) {
    env.PATH = pathValue;
  }
  return env;
}

function textOf(result: CallToolResult): string {
  return result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

function assertOk(result: CallToolResult): CallToolResult {
  if (result.isError === true) {
    throw new Error(textOf(result));
  }
  return result;
}

async function withServer(baseDir: string, run: (client: Client) => Promise<void>): Promise<void> {
  let stderr = "";
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--enable-source-maps", serverJs],
    cwd: repoRoot,
    env: childEnv(baseDir),
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  });
  const client = new Client({ name: "persona-mcp-test", version: "0.0.0" });
  try {
    await client.connect(transport);
    await run(client);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\n--- server stderr ---\n${stderr}`, { cause: error });
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function withFixture(run: (dir: string, client: Client) => Promise<void>): Promise<void> {
  const dir = await fixtureDir();
  try {
    await withServer(dir, (client) => run(dir, client));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("MCP stdio server", () => {
  it("initializes and lists the persona tools", async () => {
    await withFixture(async (_dir, client) => {
      const info = client.getServerVersion();
      expect(info?.name).toBe("persona-mcp");
      expect(info?.version).toBe("0.1.0");

      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([...TOOLS].sort());

      const prompts = await client.listPrompts();
      expect(prompts.prompts.map((prompt) => prompt.name)).toContain("get_adaptive_persona");
    });
  });

  it("calls process_user_turn", async () => {
    await withFixture(async (_dir, client) => {
      const result = assertOk(
        await client.callTool({
          name: "process_user_turn",
          arguments: {
            userId: "dev_project_1",
            userMessage: "Make the login button slay.",
            personaName: PERSONA,
          },
        }),
      );
      const text = textOf(result);
      expect(text).toContain("## Tier 1 Core Persona");
      expect(text).toContain("## Tier 2 Dialect Delta");
      expect(text).toContain("## Tier 3 User State");
      expect(text).toContain("Prefer composable React components.");
      expect(result.structuredContent).toMatchObject({
        userId: "dev_project_1",
        personaName: PERSONA,
      });
    });
  });

  it("calls harvest_idiom_delta", async () => {
    await withFixture(async (_dir, client) => {
      const result = assertOk(
        await client.callTool({
          name: "harvest_idiom_delta",
          arguments: {
            userId: "dev_project_1",
            personaName: PERSONA,
            term: "glasswave",
          },
        }),
      );
      expect(textOf(result)).toBe(
        'Queued term "glasswave" for persona "frontend-react-architect".',
      );
      expect(result.structuredContent).toMatchObject({
        term: "glasswave",
        queued: true,
      });
    });
  });

  it("calls read_dialect_delta", async () => {
    await withFixture(async (_dir, client) => {
      const result = assertOk(
        await client.callTool({
          name: "read_dialect_delta",
          arguments: { personaName: PERSONA },
        }),
      );
      const text = textOf(result);
      expect(text).toContain("# DIALECT DELTA");
      expect(text).toContain("Persona: frontend-react-architect");
    });
  });

  it("calls run_evolution_cycle", async () => {
    await withFixture(async (_dir, client) => {
      const result = assertOk(
        await client.callTool({
          name: "run_evolution_cycle",
          arguments: {},
        }),
      );
      expect(result.structuredContent).toEqual({ acceptedCount: 0, scannedProfiles: 0 });
      expect(textOf(result)).toContain('"acceptedCount":0');
    });
  });

  it("returns a tool error when the persona file is missing", async () => {
    await withFixture(async (_dir, client) => {
      const result = await client.callTool({
        name: "process_user_turn",
        arguments: {
          userId: "dev_project_1",
          userMessage: "hello there friend",
          personaName: "missing-persona",
        },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Missing required persona source file");
    });
  });

  it("promotes a harvested term through the stdio server", async () => {
    await withFixture(async (_dir, client) => {
      const turn = assertOk(
        await client.callTool({
          name: "process_user_turn",
          arguments: {
            userId: "dev_project_1",
            userMessage: "Make the login button glasswave.",
            personaName: PERSONA,
          },
        }),
      );
      expect(textOf(turn)).toContain("## Tier 1 Core Persona");

      assertOk(
        await client.callTool({
          name: "harvest_idiom_delta",
          arguments: {
            userId: "dev_project_1",
            personaName: PERSONA,
            term: "glasswave",
            context: "manual smoke insert",
            sourceType: "code",
          },
        }),
      );

      const evolution = assertOk(
        await client.callTool({
          name: "run_evolution_cycle",
          arguments: { minOccurrences: 2 },
        }),
      );
      expect(evolution.structuredContent).toMatchObject({ acceptedCount: 1, scannedProfiles: 1 });

      const delta = assertOk(
        await client.callTool({
          name: "read_dialect_delta",
          arguments: { personaName: PERSONA },
        }),
      );
      const dialect = textOf(delta);
      expect(dialect).toContain("## Accepted Term");
      expect(dialect.match(/term: glasswave/g)).toEqual(["term: glasswave"]);

      const prompt = await client.getPrompt({
        name: "get_adaptive_persona",
        arguments: {
          userId: "dev_project_2",
          userMessage: "Keep the button accessible.",
          personaName: PERSONA,
        },
      });
      const promptText = prompt.messages
        .map((message) => (message.content.type === "text" ? message.content.text : ""))
        .join("\n");
      expect(promptText).toContain("## Tier 2 Dialect Delta");

      const resource = await client.readResource({
        uri: `persona://archetypes/${PERSONA}`,
      });
      const resourceText = resource.contents
        .map((item) => ("text" in item ? item.text : ""))
        .join("\n");
      expect(resourceText).toContain("term: glasswave");
    });
  });
});
