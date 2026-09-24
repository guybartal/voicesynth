import { randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AppError, createCliTokenProvider, createSpeechService, isConfigured, MAX_TEXT_LENGTH, readConfig, validateInput } from "./speech.mjs";
import { createPersonalVoiceService } from "./personal-voice.mjs";

export const APP_DIRECTORY = fileURLToPath(new URL("../", import.meta.url));
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const pagination = {
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(25),
};

function result(data) {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
}

function page(items, offset, limit) {
  return {
    total: items.length,
    offset,
    nextOffset: offset + limit < items.length ? offset + limit : null,
    voices: items.slice(offset, offset + limit),
  };
}

function guarded(handler) {
  return async (...args) => {
    try {
      return result(await handler(...args));
    } catch (error) {
      let message;
      if (error instanceof AppError) message = error.message;
      else if (["EACCES", "EPERM", "ENOENT", "ENOTDIR", "EISDIR", "ENOSPC", "EROFS", "EEXIST", "EMFILE"].includes(error.code)) {
        message = `Audio output failed (${error.code}). Check VOICESYNTH_OUTPUT_DIR, permissions, and free disk space.`;
      } else {
        console.error("VoiceSynth MCP tool failed with an unexpected error.");
        message = "An unexpected VoiceSynth error occurred. Check the MCP server's stderr and try again.";
      }
      return { isError: true, content: [{ type: "text", text: message }] };
    }
  };
}

export function createMcpServer({
  config = readConfig(),
  fetchImpl = fetch,
  tokenProvider = createCliTokenProvider(config.resourceId),
  outputDirectory = process.env.VOICESYNTH_OUTPUT_DIR || "outputs",
} = {}) {
  const directory = resolve(APP_DIRECTORY, outputDirectory);
  const speech = createSpeechService(config, fetchImpl, tokenProvider);
  const personal = createPersonalVoiceService(config, fetchImpl, tokenProvider, speech);
  let activeSynthesis = 0;
  const server = new McpServer({ name: "voicesynth", version: "1.0.0" }, {
    instructions: "Local Azure Speech narration tools. Discover voices before synthesis. Synthesis sends text to Azure, may incur charges, and saves audio on the MCP server's machine. Obtain user authorization before generating. Never synthesize consent or impersonate a speaker. Personal Voice requires approved business use and verified consent; disclose synthetic narration to demo viewers. No enrollment, deletion, arbitrary SSML, or arbitrary file access tools are exposed.",
  });

  server.registerTool("get_status", {
    description: "Read local configuration and output location without contacting Azure. Configured does not mean authenticated or approved; use list_voices and list_personal_voices to check live access.",
    inputSchema: z.object({}).strict(),
    annotations: { ...readOnly, openWorldHint: false },
  }, guarded(async () => ({
    configured: isConfigured(config),
    authMode: "azure-cli",
    region: config.region,
    personalEndpointConfigured: Boolean(config.endpoint),
    outputDirectory: directory,
    maxTextLength: MAX_TEXT_LENGTH,
    formats: ["mp3", "wav"],
  })));

  server.registerTool("list_voices", {
    description: "List prebuilt Azure voices with IDs, locales, genders, and supported styles. Filter by exact locale (e.g. en-US) or case-insensitive search; follow nextOffset for more results. Does not synthesize audio.",
    inputSchema: z.object({
      locale: z.string().trim().min(1).max(35).optional(),
      search: z.string().trim().max(150).optional(),
      ...pagination,
    }).strict(),
    annotations: readOnly,
  }, guarded(async ({ locale, search, offset, limit }) => {
    const query = search?.toLowerCase();
    const voices = (await speech.listVoices()).filter((voice) =>
      (!locale || voice.locale.toLowerCase() === locale.toLowerCase())
      && (!query || [voice.id, voice.name, voice.locale, voice.localeName, voice.gender].some((value) => value.toLowerCase().includes(query))));
    return page(voices, offset, limit);
  }));

  server.registerTool("list_personal_voices", {
    description: "Read existing VoiceSynth Personal Voices and available base models from Azure. Reports model accessError separately from the library. Only readyForSynthesis voices can be used. Does not enroll speakers, upload recordings, or establish use-case approval.",
    inputSchema: z.object(pagination).strict(),
    annotations: readOnly,
  }, guarded(async ({ offset, limit }) => {
    const library = await personal.overview();
    const consents = new Set(library.consents.filter((item) => item.status === "Succeeded").map((item) => item.id));
    const voices = library.voices.map((voice) => ({
      ...voice,
      readyForSynthesis: !library.accessError && library.models.length > 0
        && voice.status === "Succeeded" && consents.has(voice.consentId),
    }));
    return { ...page(voices, offset, limit), models: library.models, accessError: library.accessError };
  }));

  server.registerTool("synthesize_speech", {
    description: "Generate authorized narration via Azure (billable) and save a new MP3/WAV file locally. Returns absolute path, MIME type, and byte count, not base64 audio. Use a prebuilt voice ID from list_voices, or voiceType=personal with personalVoiceId and a base-model name from list_personal_voices. Personal Voices require neutral style and pitch 0. Never use for consent recordings. Files are uniquely named and never overwritten; no automatic retries.",
    inputSchema: z.object({
      text: z.string().min(1).max(MAX_TEXT_LENGTH).describe("Plain narration text, not SSML."),
      voice: z.string().min(1).max(150).describe("Prebuilt voice ID, or an available Personal Voice base-model name."),
      voiceType: z.enum(["prebuilt", "personal"]).default("prebuilt"),
      personalVoiceId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,62}[a-zA-Z0-9]$/).optional(),
      rate: z.number().int().min(-50).max(50).default(0),
      pitch: z.number().int().min(-20).max(20).default(0),
      style: z.string().max(80).default("neutral"),
      format: z.enum(["mp3", "wav"]).default("mp3"),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, guarded(async (input, { signal }) => {
    validateInput(input);
    if (input.voiceType === "personal") {
      if (!input.personalVoiceId) throw new AppError(400, "Provide personalVoiceId from list_personal_voices.");
      if (input.pitch !== 0 || input.style !== "neutral") throw new AppError(400, "Personal Voice requires pitch 0 and neutral style.");
    } else if (input.personalVoiceId !== undefined) {
      throw new AppError(400, "Set voiceType to personal when providing personalVoiceId. No prebuilt fallback is performed.");
    }
    if (activeSynthesis >= 2) throw new AppError(429, "Two recordings are already generating in this MCP server. Wait for one to finish.");
    activeSynthesis++;
    let file;
    let path;
    try {
      if (signal.aborted) throw new AppError(499, "Speech generation was canceled.");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      path = join(directory, `voicesynth-${randomUUID()}.${input.format}`);
      file = await open(path, "wx", 0o600);
      const audio = await (input.voiceType === "personal" ? personal.synthesize(input) : speech.synthesize(input));
      if (signal.aborted) throw new AppError(499, "Speech generation was canceled. Azure may already have charged for the request.");
      await file.writeFile(audio.audio);
      await file.close();
      file = undefined;
      return {
        path, mimeType: audio.mime, bytes: audio.audio.length, format: audio.format,
        voiceType: input.voiceType, voice: input.voice,
        ...(input.personalVoiceId ? { personalVoiceId: input.personalVoiceId } : {}),
        disclosure: "AI-generated narration. Review before use and disclose synthetic narration to your audience.",
      };
    } finally {
      try {
        if (file) {
          try { await file.close(); }
          finally { await rm(path, { force: true }); }
        }
      } finally {
        activeSynthesis--;
      }
    }
  }));

  return server;
}
