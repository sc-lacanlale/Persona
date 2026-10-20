#!/usr/bin/env node
import path from "node:path";

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createPersonaServer } from "./createServer.js";

const configured = process.env.PERSONA_BASE_DIR;

if (configured !== undefined && configured.trim() === "") {
  console.error("[persona-mcp] PERSONA_BASE_DIR is empty");
  process.exit(1);
}

const baseDir = configured === undefined ? undefined : path.resolve(configured);
console.error("[persona-mcp] starting stdio server");

function onTransportError(error: Error): void {
  console.error("[persona-mcp] transport error", error);
}

try {
  if (baseDir === undefined) {
    serveStdio(() => createPersonaServer(), { onerror: onTransportError });
  } else {
    serveStdio(() => createPersonaServer(baseDir), { onerror: onTransportError });
  }
} catch (error: unknown) {
  console.error("[persona-mcp] fatal", error);
  process.exit(1);
}
