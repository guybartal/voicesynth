import { AppError, isConfigured, validateInput } from "./speech.mjs";

export const PROJECT_ID = "voicesynth-personal";
export const MAX_AUDIO_BYTES = 30_000_000;
export const API_VERSION = "2026-01-01";
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,62}[a-zA-Z0-9]$/;
const STATUSES = new Set(["NotStarted", "Running", "Succeeded", "Failed", "Disabling", "Disabled"]);
const FAILURES = {
  AudioAndScriptNotMatch: "The consent recording did not match Azure's required statement. Record the exact statement with the same speaker and company names.",
  SpeakerVerificationFailed: "Azure could not verify that the consent and sample belong to the same speaker. Do not substitute another person's recording.",
  DataNotReady: "Azure could not process the recording. Check the audio format and try a new upload.",
  DataNotEnough: "Azure needs more usable speech. Upload a clean 5-90 second recording.",
  InaccessibleCustomerStorage: "Azure cannot access the resource's configured storage. Check its storage permissions.",
  Internal: "Azure encountered an internal processing error. Try again later.",
  TerminateByUser: "Voice creation was canceled in Azure.",
};

export function validateId(id) {
  if (typeof id !== "string" || !ID.test(id)) throw new AppError(400, "Use a valid 3-64 character Azure item ID.");
  return id;
}

function field(form, name, max = 200) {
  const value = form.get(name);
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\u0000-\u001F]/.test(value)) {
    throw new AppError(400, `Provide a valid ${name} (up to ${max} characters).`);
  }
  return value.trim();
}

function acknowledge(form) {
  if (form.get("acknowledged") !== "true") {
    throw new AppError(400, "Confirm written permission, recorded consent, and approval for this internal business use before uploading.");
  }
}

export function inspectWav(buffer, purpose) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.length > MAX_AUDIO_BYTES
      || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE"
      || buffer.readUInt32LE(4) + 8 !== buffer.length) {
    throw new AppError(400, "Upload a complete PCM WAV file no larger than 30 MB.");
  }
  let format;
  let dataSize;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunk = buffer.toString("ascii", offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > buffer.length) throw new AppError(400, "The WAV file is truncated.");
    if (chunk === "fmt ") {
      if (format || length < 16) throw new AppError(400, "The WAV format header is invalid.");
      format = {
        encoding: buffer.readUInt16LE(start), channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4), byteRate: buffer.readUInt32LE(start + 8),
        blockAlign: buffer.readUInt16LE(start + 12), bits: buffer.readUInt16LE(start + 14),
      };
    }
    if (chunk === "data") {
      if (dataSize !== undefined) throw new AppError(400, "Use a WAV file with one audio data chunk.");
      dataSize = length;
    }
    offset = start + length + (length % 2);
  }
  if (offset !== buffer.length || !format || !dataSize || format.encoding !== 1
      || ![1, 2].includes(format.channels) || ![16_000, 24_000, 44_100, 48_000].includes(format.sampleRate)
      || ![16, 24, 32].includes(format.bits)
      || format.blockAlign !== format.channels * format.bits / 8
      || format.byteRate !== format.sampleRate * format.blockAlign || dataSize % format.blockAlign) {
    throw new AppError(400, "Use uncompressed PCM WAV: mono or stereo, 16/24/32-bit, at 16, 24, 44.1, or 48 kHz.");
  }
  const seconds = dataSize / format.byteRate;
  const minimum = purpose === "sample" ? 5 : 1;
  if (seconds < minimum || seconds > 90) {
    throw new AppError(400, `${purpose === "sample" ? "Voice sample" : "Consent recording"} must be ${minimum}-90 seconds long; this file is ${seconds.toFixed(1)} seconds.`);
  }
  return seconds;
}

async function audioFile(form, purpose) {
  const file = form.get("audio");
  if (!(file instanceof File) || !/\.wav$/i.test(file.name) || !file.size || file.size > MAX_AUDIO_BYTES) {
    throw new AppError(400, "Choose a PCM WAV recording no larger than 30 MB.");
  }
  inspectWav(Buffer.from(await file.arrayBuffer()), purpose);
  return new File([file], `${purpose}.wav`, { type: "audio/wav" });
}

function normalize(item, kind) {
  if (!item || typeof item.id !== "string" || !ID.test(item.id) || !STATUSES.has(item.status)
      || item.projectId !== PROJECT_ID) {
    throw new AppError(502, "Azure returned an invalid Personal Voice item. Refresh the library or check the resource in Azure.");
  }
  const failure = item.properties?.failureReason;
  const result = {
    id: item.id, name: typeof item.displayName === "string" ? item.displayName : item.id,
    status: item.status,
    failure: item.status === "Failed" ? FAILURES[failure] || "Azure could not process this recording. Check its details in Speech Studio." : "",
  };
  if (kind === "consents") {
    result.talentName = item.voiceTalentName;
    result.companyName = item.companyName;
    result.locale = item.locale;
  } else {
    result.consentId = item.consentId;
  }
  return result;
}

export function createPersonalVoiceService(config, fetchImpl, tokenProvider, speech) {
  const base = config.endpoint;
  let projectReady = false;
  let projectPending;

  function assertConfigured() {
    if (!isConfigured(config) || !base) {
      throw new AppError(503, "Personal Voice needs AZURE_SPEECH_ENDPOINT set to this resource's custom subdomain in .env, plus your region, resource ID, and az login. Prebuilt voices remain available.");
    }
  }

  async function call(path, options = {}) {
    assertConfigured();
    const url = new URL(path, `${base}/customvoice/`);
    if (url.origin !== base || !url.pathname.startsWith("/customvoice/") || url.username || url.password || url.hash) {
      throw new AppError(502, "Azure returned an unsafe pagination URL. No credentials were sent.");
    }
    url.searchParams.set("api-version", API_VERSION);
    const token = await tokenProvider.getToken();
    let response;
    try {
      response = await fetchImpl(url.href, {
        ...options, redirect: "error",
        headers: { ...options.headers, Authorization: `Bearer ${token}`, "User-Agent": "VoiceSynth" },
        signal: AbortSignal.timeout(90_000),
      });
    } catch (error) {
      throw new AppError(error.name === "TimeoutError" ? 504 : 502, "The Personal Voice request did not finish. Refresh the Azure library before retrying an upload; Azure might already have accepted it.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) {
        tokenProvider.invalidate();
        throw new AppError(401, "Azure rejected Personal Voice authentication. Run az login and verify the custom endpoint belongs to your configured Speech resource.");
      }
      if (response.status === 403) {
        throw new AppError(403, "Azure denied Personal Voice access. Verify Microsoft approval for Personal Voice business content and a Cognitive Services Speech Contributor role on this resource. A successful voice-list request alone does not establish approval.");
      }
      if (response.status === 404) throw new AppError(404, "This Personal Voice item was not found in the configured Azure resource.");
      if (response.status === 409) throw new AppError(409, "That Azure item already exists or is still processing. Refresh the library before retrying.");
      if (response.status === 429) throw new AppError(429, "Azure's Personal Voice quota or rate limit was reached. Wait and refresh the library.");
      if (response.status === 400 || response.status === 415 || response.status === 422) {
        throw new AppError(422, "Azure rejected the upload. Check the exact consent statement, names, recording language, file format, and Personal Voice approval.");
      }
      throw new AppError(502, `Azure Personal Voice returned HTTP ${response.status}. Refresh the library and try again later.`);
    }
    return response;
  }

  async function json(path, options) {
    const response = await call(path, options);
    try { return await response.json(); } catch {
      throw new AppError(502, "Azure returned an unreadable Personal Voice response. Refresh the library before submitting again.");
    }
  }

  async function list(kind, filter = true) {
    const params = new URLSearchParams();
    if (filter) params.set("filter", `projectId eq '${PROJECT_ID}'`);
    params.set("maxpagesize", "100");
    let path = `${kind}?${params}`;
    const items = [];
    const seen = new Set();
    while (path) {
      if (seen.has(path) || seen.size >= 50) throw new AppError(502, "Azure's Personal Voice list is too large or has invalid pagination.");
      seen.add(path);
      const page = await json(path);
      if (!page || !Array.isArray(page.value) || (page.nextLink !== undefined && page.nextLink !== null && typeof page.nextLink !== "string")) {
        throw new AppError(502, "Azure returned an invalid Personal Voice list.");
      }
      items.push(...page.value);
      path = page.nextLink;
    }
    return items;
  }

  async function baseModels() {
    const models = await list("basemodels", false);
    const supported = models.filter((model) => model?.capabilities?.includes("PersonalVoice")
      && typeof model.name === "string" && /^(Dragon|Phoenix)(Latest|V\d+)Neural$/.test(model.name));
    if (!supported.length) {
      throw new AppError(403, "No supported Dragon or Phoenix Personal Voice base model is available. Check feature approval and regional availability.");
    }
    return supported.map(({ name }) => name).sort((a, b) => a === "DragonLatestNeural" ? -1 : b === "DragonLatestNeural" ? 1 : a.localeCompare(b));
  }

  async function get(kind, id) {
    const item = await json(`${kind}/${validateId(id)}`);
    if (item.projectId !== PROJECT_ID) throw new AppError(403, "This item does not belong to VoiceSynth's Personal Voice project.");
    normalize(item, kind);
    return item;
  }

  async function ensureProject() {
    if (projectReady) return;
    if (!projectPending) projectPending = (async () => {
      let project;
      try { project = await json(`projects/${PROJECT_ID}`); } catch (error) {
        if (error.status !== 404) throw error;
        project = await json(`projects/${PROJECT_ID}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: "PersonalVoice", description: "VoiceSynth internal business narration" }),
        });
      }
      if (project.id !== PROJECT_ID || project.kind !== "PersonalVoice") {
        throw new AppError(409, "The voicesynth-personal project exists but is not a Personal Voice project. Resolve the name conflict in Azure.");
      }
      projectReady = true;
    })().finally(() => { projectPending = undefined; });
    return projectPending;
  }

  async function ensureNew(kind, id) {
    try { await json(`${kind}/${validateId(id)}`); } catch (error) {
      if (error.status === 404) return;
      throw error;
    }
    throw new AppError(409, "This upload ID is already in Azure. Refresh the library to recover its status; use a new upload for different recordings.");
  }

  async function overview() {
    const [voices, consents] = await Promise.all([list("personalvoices"), list("consents")]);
    let models = [];
    let accessError = "";
    try { models = await baseModels(); } catch (error) {
      if (!(error instanceof AppError)) throw error;
      accessError = error.message;
    }
    return {
      voices: voices.map((item) => normalize(item, "personalvoices")),
      consents: consents.map((item) => normalize(item, "consents")),
      models, accessError,
    };
  }

  async function createConsent(id, form) {
    validateId(id);
    acknowledge(form);
    const name = field(form, "displayName");
    const talent = field(form, "voiceTalentName");
    const company = field(form, "companyName");
    const locale = field(form, "locale", 35);
    try { Intl.getCanonicalLocales(locale); } catch { throw new AppError(400, "Choose a valid recording language, such as en-US."); }
    const file = await audioFile(form, "consent");
    await baseModels();
    await ensureProject();
    await ensureNew("consents", id);
    const upload = new FormData();
    for (const [key, value] of Object.entries({ projectId: PROJECT_ID, displayName: name, voiceTalentName: talent, companyName: company, locale })) upload.set(key, value);
    upload.set("audiodata", file);
    return normalize(await json(`consents/${id}`, { method: "POST", body: upload, headers: { "Operation-Id": id } }), "consents");
  }

  async function createVoice(id, form) {
    validateId(id);
    acknowledge(form);
    const name = field(form, "displayName");
    const consentId = validateId(field(form, "consentId", 64));
    const file = await audioFile(form, "sample");
    const consent = await get("consents", consentId);
    if (consent.status !== "Succeeded") throw new AppError(409, "Azure must verify the recorded consent successfully before a personal voice can be created.");
    await baseModels();
    await ensureNew("personalvoices", id);
    const upload = new FormData();
    for (const [key, value] of Object.entries({ projectId: PROJECT_ID, consentId, displayName: name })) upload.set(key, value);
    upload.set("audiodata", file);
    return normalize(await json(`personalvoices/${id}`, { method: "POST", body: upload, headers: { "Operation-Id": id } }), "personalvoices");
  }

  async function remove(kind, id) {
    await get(kind, id);
    if (kind === "consents" && (await list("personalvoices")).some((voice) => voice.consentId === id)) {
      throw new AppError(409, "Delete the personal voices using this consent first, then delete the consent recording.");
    }
    const response = await call(`${kind}/${id}`, { method: "DELETE" });
    await response.body?.cancel();
  }

  async function synthesize(body) {
    validateInput(body);
    const id = validateId(body.personalVoiceId);
    const voice = await get("personalvoices", id);
    if (voice.status !== "Succeeded") throw new AppError(409, "This personal voice is not ready. Wait until Azure reports Succeeded.");
    const consent = await get("consents", voice.consentId);
    if (consent.status !== "Succeeded") throw new AppError(409, "The recorded consent for this voice is no longer active.");
    if (!(await baseModels()).includes(body.voice)) throw new AppError(400, "Choose an available Personal Voice base model.");
    return speech.synthesizePersonal(body, voice.speakerProfileId);
  }

  return { overview, createConsent, createVoice, remove, synthesize };
}
