import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { AppError, createCliTokenProvider, createSpeechService, isConfigured, MAX_TEXT_LENGTH, readConfig } from "./lib/speech.mjs";
import { createPersonalVoiceService, MAX_AUDIO_BYTES } from "./lib/personal-voice.mjs";

const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/personal.js", ["personal.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

function json(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new AppError(415, "Send the request as application/json.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 32_768) throw new AppError(413, "The request is too large. Keep the script under 3,000 characters.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError(400, "The request body is not valid JSON.");
  }
}

async function readUpload(request) {
  const contentType = request.headers["content-type"];
  if (!contentType?.startsWith("multipart/form-data;")) throw new AppError(415, "Upload audio as multipart/form-data.");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_AUDIO_BYTES + 65_536) throw new AppError(413, "The upload is too large. Choose one WAV file no larger than 30 MB.");
    chunks.push(chunk);
  }
  let form;
  try {
    form = await new Request("http://localhost/upload", { method: "POST", headers: { "Content-Type": contentType }, body: Buffer.concat(chunks) }).formData();
  } catch { throw new AppError(400, "The upload is malformed. Select the recording again and retry."); }
  const seen = new Set();
  for (const [name, value] of form) {
    if (seen.has(name) || (value instanceof File && name !== "audio")) throw new AppError(400, "Upload one audio file and one value per field.");
    seen.add(name);
  }
  return form;
}

export function createApp({ config = readConfig(), fetchImpl = fetch, tokenProvider } = {}) {
  tokenProvider ??= createCliTokenProvider(config.resourceId);
  const speech = createSpeechService(config, fetchImpl, tokenProvider);
  const personal = createPersonalVoiceService(config, fetchImpl, tokenProvider, speech);
  let activeSynthesis = 0;
  let personalMutation = false;
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const port = server.address()?.port;
      const allowedHosts = [`localhost:${port}`, `127.0.0.1:${port}`];
      const host = request.headers.host;
      if (!allowedHosts.includes(host)) throw new AppError(403, "Use the localhost address printed by the server.");
      if (request.headers.origin && request.headers.origin !== `http://${host}`) {
        throw new AppError(403, "Cross-origin requests are not allowed.");
      }
      if (request.headers["sec-fetch-site"] === "cross-site") {
        throw new AppError(403, "Cross-site requests are not allowed.");
      }
      const path = new URL(request.url, `http://${host}`).pathname;
      if (request.method === "GET" && path === "/api/config") {
        return json(response, 200, {
          configured: isConfigured(config),
          authMode: "azure-cli",
          region: config.region,
          maxTextLength: MAX_TEXT_LENGTH,
        });
      }
      if (request.method === "GET" && path === "/api/voices") {
        return json(response, 200, { voices: await speech.listVoices() });
      }
      if (request.method === "GET" && path === "/api/personal") {
        return json(response, 200, await personal.overview());
      }
      const personalPath = path.match(/^\/api\/personal\/(consents|voices)\/([^/]+)$/);
      if (personalPath && ["POST", "DELETE"].includes(request.method)) {
        if (personalMutation) throw new AppError(429, "A Personal Voice upload or deletion is already running. Wait for it to finish.");
        personalMutation = true;
        try {
          const [, kind, id] = personalPath;
          if (request.method === "DELETE") {
            await personal.remove(kind === "voices" ? "personalvoices" : kind, id);
            return json(response, 202, { message: "Deletion requested in Azure. Refresh to confirm it has completed." });
          }
          const form = await readUpload(request);
          const item = kind === "consents" ? await personal.createConsent(id, form) : await personal.createVoice(id, form);
          return json(response, 201, item);
        } finally { personalMutation = false; }
      }
      if (request.method === "POST" && path === "/api/synthesize") {
        if (activeSynthesis >= 2) throw new AppError(429, "Two recordings are already generating. Wait for one to finish.");
        activeSynthesis++;
        try {
          const body = await readJson(request);
          if (body?.voiceType !== undefined && !["prebuilt", "personal"].includes(body.voiceType)) throw new AppError(400, "Choose prebuilt or personal voice.");
          const result = body?.voiceType === "personal" ? await personal.synthesize(body) : await speech.synthesize(body);
          response.writeHead(200, {
            "Content-Type": result.mime,
            "Content-Length": result.audio.length,
            "Content-Disposition": `attachment; filename="voicesynth.${result.format}"`,
          });
          response.end(result.audio);
          return;
        } finally {
          activeSynthesis--;
        }
      }
      if (request.method === "GET" && assets.has(path)) {
        const [file, type] = assets.get(path);
        const content = await readFile(new URL(`./public/${file}`, import.meta.url));
        response.writeHead(200, { "Content-Type": type });
        response.end(content);
        return;
      }
      throw new AppError(404, "This page or endpoint does not exist.");
    } catch (error) {
      const known = error instanceof AppError;
      if (!known) console.error("VoiceSynth request failed:", error.name);
      if (!response.destroyed && !response.headersSent) {
        json(response, known ? error.status : 500, {
          error: known ? error.message : "An unexpected server error occurred. Check the server terminal and try again.",
        });
      }
    }
  });
  server.requestTimeout = 150_000;
  server.headersTimeout = 15_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const port = Number(process.env.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be an integer between 1 and 65535.");
    const config = readConfig();
    const app = createApp({ config });
    app.on("error", (error) => {
      console.error(`VoiceSynth could not start (${error.code}). Check PORT and whether another server is already running.`);
      process.exitCode = 1;
    });
    app.listen(port, "127.0.0.1", () => {
      console.log(`VoiceSynth is available at http://localhost:${port}`);
      console.log("Authentication: Azure CLI (az login). No API key is used.");
      if (!isConfigured(config)) console.log("Setup needed: set AZURE_SPEECH_RESOURCE_ID and AZURE_SPEECH_REGION in .env and restart.");
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
