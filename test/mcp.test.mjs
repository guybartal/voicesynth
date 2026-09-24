import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../lib/mcp.mjs";
import { PROJECT_ID } from "../lib/personal-voice.mjs";

const config = {
  region: "eastus2",
  resourceId: "/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/test/providers/Microsoft.CognitiveServices/accounts/test-speech",
  endpoint: "https://test-speech.cognitiveservices.azure.com",
};
const wav = Buffer.alloc(524);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(480, 40);
const narration = { text: "A demo & <plain text>.", voice: "en-US-JennyNeural", format: "wav" };
const personalInput = { ...narration, voiceType: "personal", personalVoiceId: "voice-test", voice: "DragonLatestNeural" };

function mockAzure() {
  const state = { denyModels: false, consentStatus: "Succeeded", voiceStatus: "Succeeded", requests: [], audioStatus: 200, gate: null };
  return {
    state,
    async fetchImpl(uri, options = {}) {
      const path = new URL(uri).pathname;
      state.requests.push({ path, ...options });
      if (path === "/cognitiveservices/voices/list") return Response.json([
        { ShortName: "en-US-JennyNeural", DisplayName: "Jenny", Locale: "en-US", Gender: "Female", StyleList: ["cheerful"] },
        { ShortName: "en-US-GuyNeural", DisplayName: "Guy", Locale: "en-US", Gender: "Male" },
        { ShortName: "fr-FR-DeniseNeural", DisplayName: "Denise", Locale: "fr-FR", Gender: "Female" },
      ]);
      if (path === "/cognitiveservices/v1") {
        if (state.gate) await state.gate;
        return new Response(state.audioStatus === 200 ? wav : "private upstream error", { status: state.audioStatus });
      }
      if (path === "/customvoice/basemodels") return state.denyModels
        ? new Response("private upstream error", { status: 403 })
        : Response.json({ value: [{ name: "DragonLatestNeural", capabilities: ["PersonalVoice"] }] });
      const consent = { id: "consent-test", projectId: PROJECT_ID, status: state.consentStatus, displayName: "Consent", voiceTalentName: "Test Speaker", locale: "en-US" };
      const voice = { id: "voice-test", projectId: PROJECT_ID, status: state.voiceStatus, displayName: "Demo voice", consentId: consent.id, speakerProfileId: "11111111-2222-3333-4444-555555555555" };
      if (path === "/customvoice/consents") return Response.json({ value: [consent] });
      if (path === "/customvoice/consents/consent-test") return Response.json(consent);
      if (path === "/customvoice/personalvoices") return Response.json({ value: [voice] });
      if (path === "/customvoice/personalvoices/voice-test") return Response.json(voice);
      throw new Error(`Unexpected test URL ${path}`);
    },
  };
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "voicesynth-mcp-"));
  const azure = mockAzure();
  const server = createMcpServer({
    config, fetchImpl: azure.fetchImpl,
    tokenProvider: { getToken: async () => "mock-token", invalidate() {} },
    outputDirectory: directory, ...options,
  });
  const client = new Client({ name: "test-coding-agent", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client, directory, ...azure,
    call: (name, args = {}) => client.callTool({ name, arguments: args }),
  };
}

test("MCP initializes and exposes only the four authorized tools", async (t) => {
  const f = await fixture(t);
  const { tools } = await f.client.listTools();
  assert.deepEqual(tools.map(({ name }) => name).sort(), ["get_status", "list_personal_voices", "list_voices", "synthesize_speech"]);
  assert.equal(tools.find(({ name }) => name === "synthesize_speech").annotations.idempotentHint, false);
  assert.equal(tools.find(({ name }) => name === "list_voices").annotations.readOnlyHint, true);
  const response = await f.call("get_status");
  assert.equal(response.structuredContent.configured, true);
  assert.equal(response.structuredContent.outputDirectory, f.directory);
  assert.equal(f.state.requests.length, 0);
  assert.doesNotMatch(JSON.stringify(response), /mock-token|subscriptions/);
});

test("voice discovery filters and paginates with usable styles", async (t) => {
  const f = await fixture(t);
  const first = (await f.call("list_voices", { locale: "EN-us", limit: 1 })).structuredContent;
  assert.equal(first.total, 2);
  assert.equal(first.nextOffset, 1);
  assert.deepEqual(first.voices[0].styles, ["cheerful"]);
  const second = (await f.call("list_voices", { locale: "en-US", limit: 1, offset: 1 })).structuredContent;
  assert.equal(second.voices[0].id, "en-US-GuyNeural");
  assert.equal(second.nextOffset, null);
  const search = (await f.call("list_voices", { search: "DENISE" })).structuredContent;
  assert.equal(search.voices[0].locale, "fr-FR");
  assert.equal((await f.call("list_voices", { search: "not-a-voice" })).structuredContent.total, 0);
  assert.equal(f.state.requests.length, 1);
});

test("MCP synthesizes and persists unique private files without returning script or audio blobs", async (t) => {
  const f = await fixture(t);
  const a = (await f.call("synthesize_speech", narration)).structuredContent;
  const b = (await f.call("synthesize_speech", { ...narration, format: "mp3" })).structuredContent;
  assert.notEqual(a.path, b.path);
  assert.equal(dirname(a.path), f.directory);
  assert.equal(a.mimeType, "audio/wav");
  assert.equal(b.mimeType, "audio/mpeg");
  assert.equal(a.bytes, wav.length);
  assert.deepEqual(await readFile(a.path), wav);
  assert.deepEqual(await readFile(b.path), wav);
  if (process.platform !== "win32") assert.equal((await stat(a.path)).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(a), /A demo|base64|mock-token/);
  const requests = f.state.requests.filter(({ path }) => path === "/cognitiveservices/v1");
  assert.match(requests[0].body, /A demo &amp; &lt;plain text&gt;/);
  assert.equal(requests[1].headers["X-Microsoft-OutputFormat"], "audio-24khz-48kbitrate-mono-mp3");
});

test("personal discovery preserves access errors and verifies consent readiness", async (t) => {
  const f = await fixture(t);
  let library = (await f.call("list_personal_voices")).structuredContent;
  assert.equal(library.voices[0].readyForSynthesis, true);
  f.state.consentStatus = "Disabled";
  library = (await f.call("list_personal_voices")).structuredContent;
  assert.equal(library.voices[0].readyForSynthesis, false);
  f.state.denyModels = true;
  library = (await f.call("list_personal_voices")).structuredContent;
  assert.equal(library.voices.length, 1);
  assert.deepEqual(library.models, []);
  assert.match(library.accessError, /approval/);
  assert.doesNotMatch(JSON.stringify(library), /private upstream/);
});

test("personal synthesis resolves the profile through existing Azure consent gates", async (t) => {
  const f = await fixture(t);
  const output = (await f.call("synthesize_speech", personalInput)).structuredContent;
  assert.equal(output.personalVoiceId, "voice-test");
  assert.deepEqual(await readFile(output.path), wav);
  assert.match(f.state.requests.find(({ path }) => path === "/cognitiveservices/v1").body, /ttsembedding speakerProfileId="11111111-2222-3333-4444-555555555555"/);
  f.state.consentStatus = "Disabled";
  const denied = await f.call("synthesize_speech", personalInput);
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /consent.*no longer active/);
  assert.equal((await readdir(f.directory)).length, 1);
});

test("unready or model-blocked personal voices never synthesize or leave empty files", async (t) => {
  const f = await fixture(t);
  f.state.voiceStatus = "Running";
  assert.equal((await f.call("synthesize_speech", personalInput)).isError, true);
  f.state.voiceStatus = "Succeeded";
  f.state.denyModels = true;
  assert.equal((await f.call("synthesize_speech", personalInput)).isError, true);
  assert.equal(f.state.requests.some(({ path }) => path === "/cognitiveservices/v1"), false);
  assert.deepEqual(await readdir(f.directory), []);
});

test("invalid inputs, arbitrary file paths, and personal/prebuilt ambiguity fail before Azure", async (t) => {
  const f = await fixture(t);
  for (const input of [
    { ...narration, text: "x".repeat(3001) },
    { ...narration, text: " \n " },
    { ...narration, text: "\u0000" },
    { ...narration, rate: 51 },
    { ...narration, format: "../../secret" },
    { ...narration, outputPath: "/tmp/override.wav" },
    { ...narration, speakerProfileId: "arbitrary" },
    { ...narration, voiceType: "unknown" },
    { ...narration, personalVoiceId: "voice-test" },
    { ...personalInput, personalVoiceId: undefined },
    { ...personalInput, pitch: 1 },
    { ...personalInput, style: "cheerful" },
  ]) {
    assert.equal((await f.call("synthesize_speech", input)).isError, true);
  }
  assert.equal((await f.call("list_voices", { limit: 101 })).isError, true);
  assert.equal((await f.call("list_voices", { offset: -1 })).isError, true);
  assert.equal(f.state.requests.length, 0);
  assert.deepEqual(await readdir(f.directory), []);
});

test("Azure errors are explicit, do not leak details, and clean output files", async (t) => {
  const f = await fixture(t);
  f.state.audioStatus = 429;
  const failure = await f.call("synthesize_speech", narration);
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, /quota|rate limit/);
  assert.doesNotMatch(JSON.stringify(failure), /private upstream/);
  assert.deepEqual(await readdir(f.directory), []);
  f.state.audioStatus = 200;
  assert.equal((await f.call("synthesize_speech", narration)).isError, undefined);
});

test("unwritable output location fails before a billable call", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "voicesynth-mcp-file-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "not-a-directory");
  await writeFile(path, "keep");
  const f = await fixture(t, { outputDirectory: path });
  const response = await f.call("synthesize_speech", narration);
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /Audio output failed/);
  assert.equal(f.state.requests.length, 0);
  assert.equal(await readFile(path, "utf8"), "keep");
});

test("unconfigured MCP remains discoverable and returns actionable setup errors", async (t) => {
  const f = await fixture(t, { config: { region: "", resourceId: "" } });
  assert.equal((await f.call("get_status")).structuredContent.configured, false);
  const response = await f.call("list_voices");
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /AZURE_SPEECH_RESOURCE_ID/);
  assert.equal((await f.call("list_personal_voices")).isError, true);
});

test("MCP caps concurrent generation and releases capacity", async (t) => {
  const f = await fixture(t);
  let release;
  f.state.gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  const first = f.call("synthesize_speech", narration);
  const second = f.call("synthesize_speech", narration);
  const third = await f.call("synthesize_speech", narration);
  assert.equal(third.isError, true);
  assert.match(third.content[0].text, /Two recordings/);
  release();
  for (const response of await Promise.all([first, second])) assert.equal(response.isError, undefined);
  assert.equal((await f.call("synthesize_speech", narration)).isError, undefined);
  assert.equal((await readdir(f.directory)).length, 3);
});

test("real stdio entrypoint launches from another cwd with protocol-only stdout", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "voicesynth-mcp-stdio-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../mcp.mjs", import.meta.url))],
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      AZURE_SPEECH_REGION: "eastus",
      AZURE_SPEECH_RESOURCE_ID: config.resourceId,
      AZURE_SPEECH_ENDPOINT: "",
      VOICESYNTH_OUTPUT_DIR: directory,
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr.on("data", (chunk) => { stderr += chunk; });
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  });
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 4);
  const response = await client.callTool({ name: "get_status", arguments: {} });
  assert.equal(response.structuredContent.region, "eastus");
  assert.equal(response.structuredContent.outputDirectory, directory);
  assert.equal(stderr, "");
});
