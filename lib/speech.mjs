import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeCli = promisify(execFile);

export const MAX_TEXT_LENGTH = 3000;
export const FORMATS = Object.freeze({
  mp3: { azure: "audio-24khz-48kbitrate-mono-mp3", mime: "audio/mpeg" },
  wav: { azure: "riff-24khz-16bit-mono-pcm", mime: "audio/wav" },
});

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function readConfig(env = process.env) {
  const region = env.AZURE_SPEECH_REGION?.trim() || "";
  const resourceId = env.AZURE_SPEECH_RESOURCE_ID?.trim() || "";
  if (region && !/^[a-z][a-z0-9]{1,39}$/.test(region)) {
    throw new Error("AZURE_SPEECH_REGION must be an Azure region ID, such as eastus, not a URL.");
  }
  if (resourceId && !/^\/subscriptions\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/resourceGroups\/[^/#\r\n]+\/providers\/Microsoft\.CognitiveServices\/accounts\/[\w.-]+$/i.test(resourceId)) {
    throw new Error("AZURE_SPEECH_RESOURCE_ID must be the full Azure resource ID of your Speech resource.");
  }
  const endpoint = env.AZURE_SPEECH_ENDPOINT?.trim();
  if (endpoint) {
    let url;
    try { url = new URL(endpoint); } catch { throw new Error("AZURE_SPEECH_ENDPOINT must be your HTTPS custom subdomain endpoint."); }
    if (url.protocol !== "https:" || !/^[a-z0-9][a-z0-9-]*\.cognitiveservices\.azure\.(com|us)$/.test(url.hostname)
        || url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("AZURE_SPEECH_ENDPOINT must be an Azure custom subdomain origin, such as https://my-resource.cognitiveservices.azure.com/.");
    }
    return { region, resourceId, endpoint: url.origin };
  }
  return { region, resourceId };
}

export function isConfigured(config) {
  return Boolean(config.region && config.resourceId);
}

export function createCliTokenProvider(resourceId, { execute = executeCli, now = Date.now } = {}) {
  let cached;
  let pending;

  async function acquire() {
    let stdout;
    try {
      ({ stdout } = await execute("az", [
        "account", "get-access-token",
        "--resource", "https://cognitiveservices.azure.com",
        "--subscription", resourceId.split("/")[2],
        "--output", "json", "--only-show-errors",
      ], { timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true }));
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new AppError(503, "Azure CLI is not installed or is not on the server's PATH. Install Azure CLI, run az login, and restart the server.");
      }
      if (error.killed || error.code === "ETIMEDOUT") {
        throw new AppError(504, "Azure CLI timed out. Run az login in your terminal and try again.");
      }
      // CLI errors may contain credentials; never forward stdout or stderr.
      throw new AppError(503, "Azure CLI could not get a token. Run az login with an account that can access your Speech resource's subscription, then check the connection again.");
    }
    let token;
    try {
      token = JSON.parse(stdout);
    } catch {
      throw new AppError(502, "Azure CLI returned an unreadable token response. Update Azure CLI and run az login again.");
    }
    const expiresAt = Number(token?.expires_on) * 1000;
    if (typeof token?.accessToken !== "string" || !/^[A-Za-z0-9._~-]+$/.test(token.accessToken)
        || !Number.isFinite(expiresAt) || expiresAt <= now() + 120_000) {
      throw new AppError(503, "Azure CLI returned an invalid or nearly expired token. Use Azure CLI 2.54 or later and run az login again.");
    }
    cached = { value: token.accessToken, expiresAt };
    return cached.value;
  }

  return {
    async getToken() {
      if (cached && cached.expiresAt > now() + 120_000) return cached.value;
      if (!pending) pending = acquire().finally(() => { pending = undefined; });
      return pending;
    },
    invalidate() { cached = undefined; },
  };
}

export function escapeXml(value) {
  return value.replace(/[<>&"']/g, (character) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
  })[character]);
}

function signed(value) {
  return value >= 0 ? `+${value}` : String(value);
}

export function createSsml({ text, rate, pitch, style }, voice) {
  const prosody = `<prosody rate="${signed(rate)}%" pitch="${signed(pitch)}%">${escapeXml(text)}</prosody>`;
  const content = style === "neutral" ? prosody
    : `<mstts:express-as style="${escapeXml(style)}">${prosody}</mstts:express-as>`;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${escapeXml(voice.locale)}"><voice name="${escapeXml(voice.id)}">${content}</voice></speak>`;
}

export function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError(400, "Provide a JSON object with text and a voice.");
  }
  const { text, voice, rate = 0, pitch = 0, style = "neutral", format = "mp3" } = input;
  if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT_LENGTH) {
    throw new AppError(400, `Enter between 1 and ${MAX_TEXT_LENGTH} characters of text.`);
  }
  // Reject characters XML 1.0 cannot represent, including unpaired UTF-16 surrogates.
  if (/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(text)) {
    throw new AppError(400, "The text contains unsupported control characters. Remove them and try again.");
  }
  if (typeof voice !== "string" || !voice || voice.length > 150) {
    throw new AppError(400, "Choose an available Azure voice.");
  }
  if (!Number.isInteger(rate) || rate < -50 || rate > 50
      || !Number.isInteger(pitch) || pitch < -20 || pitch > 20) {
    throw new AppError(400, "Speaking speed must be -50 to +50 and pitch must be -20 to +20.");
  }
  if (typeof style !== "string" || style.length > 80) {
    throw new AppError(400, "Choose an available speaking style.");
  }
  if (typeof format !== "string" || !Object.hasOwn(FORMATS, format)) {
    throw new AppError(400, "Choose MP3 or WAV as the audio format.");
  }
  return { text, voice, rate, pitch, style, format };
}

export function createSpeechService(config, fetchImpl = fetch, tokenProvider = createCliTokenProvider(config.resourceId)) {
  const domain = config.region.startsWith("usgov") ? "speech.azure.us" : "speech.microsoft.com";
  const base = `https://${config.region}.tts.${domain}`;
  let cachedVoices;
  let expiresAt = 0;
  let pendingVoices;

  function assertConfigured() {
    if (!isConfigured(config)) {
      throw new AppError(503, "Add AZURE_SPEECH_RESOURCE_ID and AZURE_SPEECH_REGION to .env, run az login, then restart the server.");
    }
  }

  async function azureRequest(path, options = {}) {
    assertConfigured();
    const token = await tokenProvider.getToken();
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        ...options,
        redirect: "error",
        headers: {
          Authorization: `Bearer aad#${config.resourceId}#${token}`,
          "User-Agent": "VoiceSynth",
          ...options.headers,
        },
        signal: AbortSignal.timeout(90_000),
      });
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") {
        throw new AppError(504, "Azure took too long to respond. Try a shorter script or try again later.");
      }
      throw new AppError(502, "Could not reach Azure Speech. Check your network and Speech region.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) {
        tokenProvider.invalidate();
        throw new AppError(502, "Azure rejected CLI authentication. Run az login again and verify that your account has the Cognitive Services Speech User role on the configured resource, the resource ID and region match, and network access is allowed.");
      }
      if (response.status === 429) {
        throw new AppError(429, "Azure's speech quota or rate limit was reached. Wait a moment or check your Azure quota.");
      }
      if (response.status === 400) {
        throw new AppError(422, "Azure could not synthesize these settings. Try another voice, neutral style, or a shorter script.");
      }
      throw new AppError(502, `Azure Speech returned HTTP ${response.status}. Try again or check the resource in Azure.`);
    }
    return response;
  }

  async function fetchVoices() {
    const response = await azureRequest("/cognitiveservices/voices/list");
    let data;
    try {
      data = await response.json();
    } catch {
      throw new AppError(502, "Azure returned an unreadable voice list. Try again.");
    }
    if (!Array.isArray(data)) {
      throw new AppError(502, "Azure returned an unexpected voice list. Try again.");
    }
    const voices = data.filter((voice) => voice
      && typeof voice.ShortName === "string" && typeof voice.Locale === "string")
      .map((voice) => ({
        id: voice.ShortName,
        name: typeof voice.DisplayName === "string" ? voice.DisplayName : voice.ShortName,
        locale: voice.Locale,
        localeName: typeof voice.LocaleName === "string" ? voice.LocaleName : voice.Locale,
        gender: typeof voice.Gender === "string" ? voice.Gender : "",
        styles: Array.isArray(voice.StyleList) ? voice.StyleList.filter((style) => typeof style === "string") : [],
      }));
    if (!voices.length) {
      throw new AppError(502, "Azure returned no usable voices for this region.");
    }
    cachedVoices = voices;
    expiresAt = Date.now() + 10 * 60_000;
    return voices;
  }

  async function listVoices() {
    assertConfigured();
    if (cachedVoices && Date.now() < expiresAt) return cachedVoices;
    if (!pendingVoices) {
      pendingVoices = fetchVoices().finally(() => { pendingVoices = undefined; });
    }
    return pendingVoices;
  }

  async function synthesize(body) {
    const input = validateInput(body);
    const voices = await listVoices();
    const voice = voices.find((candidate) => candidate.id === input.voice);
    if (!voice) throw new AppError(400, "That voice is not available in your region. Reload the voice list.");
    if (input.style !== "neutral" && !voice.styles.includes(input.style)) {
      throw new AppError(400, "That style is not supported by this voice.");
    }
    return requestAudio(input, createSsml(input, voice));
  }

  async function synthesizePersonal(body, speakerProfileId) {
    const input = validateInput(body);
    if (input.pitch !== 0 || input.style !== "neutral") {
      throw new AppError(400, "Personal Voice does not support pitch adjustments or speaking styles. Use natural pitch and neutral style.");
    }
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(speakerProfileId)) {
      throw new AppError(502, "Azure returned an invalid speaker profile ID.");
    }
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US"><voice name="${escapeXml(input.voice)}"><mstts:ttsembedding speakerProfileId="${speakerProfileId}"><prosody rate="${signed(input.rate)}%">${escapeXml(input.text)}</prosody></mstts:ttsembedding></voice></speak>`;
    return requestAudio(input, ssml);
  }

  async function requestAudio(input, ssml) {
    const response = await azureRequest("/cognitiveservices/v1", {
      method: "POST",
      headers: {
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": FORMATS[input.format].azure,
      },
      body: ssml,
    });
    let audio;
    try {
      audio = Buffer.from(await response.arrayBuffer());
    } catch {
      throw new AppError(502, "The audio transfer from Azure was interrupted. Try again.");
    }
    if (!audio.length) throw new AppError(502, "Azure returned an empty audio file. Try another voice.");
    return { audio, format: input.format, mime: FORMATS[input.format].mime };
  }

  return { listVoices, synthesize, synthesizePersonal };
}
