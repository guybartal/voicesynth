import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./lib/mcp.mjs";

try {
  try {
    loadEnvFile(fileURLToPath(new URL("./.env", import.meta.url)));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await createMcpServer().connect(new StdioServerTransport());
} catch {
  console.error("VoiceSynth MCP could not start. Check Node.js 22.9+, npm install, .env permissions, and Azure configuration values.");
  process.exitCode = 1;
}
