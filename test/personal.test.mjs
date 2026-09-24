import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../server.mjs";
import { createSpeechService, readConfig } from "../lib/speech.mjs";
import { createPersonalVoiceService, inspectWav, PROJECT_ID } from "../lib/personal-voice.mjs";

const config = {
  region: "eastus2",
  resourceId: "/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/test/providers/Microsoft.CognitiveServices/accounts/test-speech",
  endpoint: "https://test-speech.cognitiveservices.azure.com",
};
const tokenProvider = { getToken: async () => "test-token", invalidate() {} };
const profileId = "11111111-2222-3333-4444-555555555555";

function wav(seconds = 6, sampleRate = 16_000, bits = 16, channels = 1) {
  const blockAlign = channels * bits / 8;
  const size = Math.round(seconds * sampleRate) * blockAlign;
  const buffer = Buffer.alloc(44 + size);
  buffer.write("RIFF"); buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8); buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * blockAlign, 28);
  buffer.writeUInt16LE(blockAlign, 32); buffer.writeUInt16LE(bits, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(size, 40);
  return buffer;
}

function form(kind = "consent", seconds = 6) {
  const result = new FormData();
  result.set("displayName", "Demo voice");
  result.set("voiceTalentName", "Test Speaker");
  result.set("companyName", "Test Company");
  result.set("locale", "en-US");
  result.set("acknowledged", "true");
  result.set("consentId", "consent-test");
  result.set("audio", new File([wav(seconds)], `${kind}.wav`, { type: "audio/wav" }));
  return result;
}

function azureMock() {
  const consents = new Map();
  const voices = new Map();
  const calls = [];
  let project;
  let denied = false;
  const fetchImpl = async (uri, options = {}) => {
    calls.push({ uri, ...options });
    const url = new URL(uri);
    if (url.pathname === "/cognitiveservices/v1") return new Response(wav(1));
    if (url.pathname === "/cognitiveservices/voices/list") return Response.json([{ ShortName: "en-US-JennyNeural", DisplayName: "Jenny", Locale: "en-US" }]);
    assert.equal(url.origin, config.endpoint);
    assert.equal(url.searchParams.get("api-version"), "2026-01-01");
    assert.equal(options.headers.Authorization, "Bearer test-token");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers["Ocp-Apim-Subscription-Key"], undefined);
    const [, , kind, id] = url.pathname.split("/");
    const method = options.method || "GET";
    if (kind === "basemodels") return denied
      ? new Response("secret internal details", { status: 403 })
      : Response.json({ value: [{ name: "DragonLatestNeural", capabilities: ["PersonalVoice"] }, { name: "PhoenixV2Neural", capabilities: ["PersonalVoice"] }] });
    if (kind === "projects") {
      if (method === "PUT") project = { ...JSON.parse(options.body), id };
      return project ? Response.json(project) : new Response("", { status: 404 });
    }
    const entries = kind === "consents" ? consents : voices;
    if (!id) return Response.json({ value: [...entries.values()] });
    if (method === "POST") {
      assert.ok(options.body instanceof FormData);
      assert.equal(options.body.get("projectId"), PROJECT_ID);
      assert.equal(options.body.get("audiodata").type, "audio/wav");
      assert.equal(options.headers["Operation-Id"], id);
      assert.equal(options.headers["Content-Type"], undefined);
      const item = {
        id, projectId: PROJECT_ID, status: "NotStarted", displayName: options.body.get("displayName"),
        ...(kind === "consents" ? {
          voiceTalentName: options.body.get("voiceTalentName"), companyName: options.body.get("companyName"), locale: options.body.get("locale"),
        } : { consentId: options.body.get("consentId"), speakerProfileId: profileId }),
      };
      entries.set(id, item);
      return Response.json(item, { status: 201 });
    }
    if (!entries.has(id)) return new Response("", { status: 404 });
    if (method === "DELETE") { entries.delete(id); return new Response(null, { status: 204 }); }
    return Response.json(entries.get(id));
  };
  const speech = createSpeechService(config, fetchImpl, tokenProvider);
  return {
    service: createPersonalVoiceService(config, fetchImpl, tokenProvider, speech),
    fetchImpl, calls, consents, voices,
    denyModels() { denied = true; },
  };
}

test("custom endpoint is strictly limited to Azure custom subdomain origins", () => {
  const env = { AZURE_SPEECH_REGION: "eastus2", AZURE_SPEECH_RESOURCE_ID: config.resourceId };
  assert.deepEqual(readConfig({ ...env, AZURE_SPEECH_ENDPOINT: `${config.endpoint}/` }), config);
  for (const endpoint of ["http://test.cognitiveservices.azure.com", "https://example.com", "https://localhost", "https://evil@safe.cognitiveservices.azure.com", `${config.endpoint}/customvoice`, `${config.endpoint}:8443`, `${config.endpoint}?foo=1`]) {
    assert.throws(() => readConfig({ ...env, AZURE_SPEECH_ENDPOINT: endpoint }), /AZURE_SPEECH_ENDPOINT/);
  }
});

test("PCM WAV parser enforces actual duration, format, and complete data", () => {
  assert.equal(inspectWav(wav(5), "sample"), 5);
  assert.equal(inspectWav(wav(90), "sample"), 90);
  assert.equal(inspectWav(wav(1), "consent"), 1);
  assert.equal(inspectWav(wav(6, 44_100, 24, 2), "sample"), 6);
  for (const recording of [wav(4.9), wav(90.1), wav(6, 8000), wav(6, 16000, 8), Buffer.from("not a wav"), wav().subarray(0, 50)]) {
    assert.throws(() => inspectWav(recording, "sample"), (error) => error.status === 400);
  }
  const damaged = wav();
  damaged.writeUInt32LE(0xffffffff, 40);
  assert.throws(() => inspectWav(damaged, "sample"), /truncated/);
});

test("consent, voice processing, synthesis, and deletion are wired end to end", async () => {
  const az = azureMock();
  const consent = await az.service.createConsent("consent-test", form());
  assert.equal(consent.status, "NotStarted");
  assert.equal(consent.talentName, "Test Speaker");
  await assert.rejects(az.service.createVoice("voice-test", form("sample")), /verify.*consent/);
  az.consents.get("consent-test").status = "Succeeded";
  const voice = await az.service.createVoice("voice-test", form("sample"));
  assert.equal(voice.status, "NotStarted");
  const input = { voice: "DragonLatestNeural", personalVoiceId: "voice-test", text: "A <demo> & narration", rate: 25, pitch: 0, style: "neutral", format: "wav" };
  await assert.rejects(az.service.synthesize(input), /not ready/);
  az.voices.get("voice-test").status = "Succeeded";
  const audio = await az.service.synthesize(input);
  assert.equal(audio.mime, "audio/wav");
  assert.equal(audio.audio.toString("ascii", 0, 4), "RIFF");
  const synthesis = az.calls.find((call) => call.uri.endsWith("/cognitiveservices/v1"));
  assert.match(synthesis.body, /<mstts:ttsembedding speakerProfileId="11111111-2222-3333-4444-555555555555">/);
  assert.match(synthesis.body, /name="DragonLatestNeural"/);
  assert.match(synthesis.body, /rate="\+25%"/);
  assert.match(synthesis.body, /A &lt;demo&gt; &amp; narration/);
  assert.doesNotMatch(synthesis.body, /pitch=|express-as/);
  await assert.rejects(az.service.remove("consents", "consent-test"), /Delete the personal voices/);
  await az.service.remove("personalvoices", "voice-test");
  await az.service.remove("consents", "consent-test");
  assert.deepEqual((await az.service.overview()).voices, []);
});

test("uploads require attestation, valid audio and metadata before any Azure mutation", async () => {
  const az = azureMock();
  const cases = [
    (f) => f.delete("acknowledged"),
    (f) => f.set("voiceTalentName", ""),
    (f) => f.set("companyName", "company\ninjection"),
    (f) => f.set("locale", "bad_locale"),
    (f) => f.set("audio", new File(["fake"], "sample.wav")),
    (f) => f.set("audio", new File([wav()], "sample.mp3")),
  ];
  for (const change of cases) {
    const upload = form();
    change(upload);
    await assert.rejects(az.service.createConsent("consent-test", upload), (error) => error.status === 400);
  }
  await assert.rejects(az.service.createConsent("../traversal", form()), /Azure item ID/);
  assert.equal(az.calls.length, 0);
});

test("denied model access is visible, preserves the library, and blocks mutations", async () => {
  const az = azureMock();
  az.denyModels();
  const state = await az.service.overview();
  assert.deepEqual(state.models, []);
  assert.match(state.accessError, /approval/);
  assert.doesNotMatch(state.accessError, /secret/);
  await assert.rejects(az.service.createConsent("consent-test", form()), (error) => error.status === 403);
  assert.equal(az.calls.some((call) => call.method === "POST" || call.method === "PUT"), false);
});

test("existing upload IDs never create duplicates", async () => {
  const az = azureMock();
  await az.service.createConsent("consent-test", form());
  await assert.rejects(az.service.createConsent("consent-test", form()), (error) => error.status === 409);
  assert.equal(az.calls.filter((call) => call.method === "POST").length, 1);
});

test("Azure owns the persisted library and a new service instance recovers it", async () => {
  const az = azureMock();
  await az.service.createConsent("consent-test", form());
  az.consents.get("consent-test").status = "Succeeded";
  await az.service.createVoice("voice-test", form("sample"));
  const replacement = createPersonalVoiceService(config, az.fetchImpl, tokenProvider, {});
  const state = await replacement.overview();
  assert.equal(state.consents[0].id, "consent-test");
  assert.equal(state.voices[0].id, "voice-test");
});

test("synthesis checks model, ready profile, live consent and supported controls", async () => {
  const az = azureMock();
  await az.service.createConsent("consent-test", form());
  az.consents.get("consent-test").status = "Succeeded";
  await az.service.createVoice("voice-test", form("sample"));
  az.voices.get("voice-test").status = "Succeeded";
  const input = { voice: "DragonLatestNeural", personalVoiceId: "voice-test", text: "Hello" };
  await assert.rejects(az.service.synthesize({ ...input, voice: "unavailable" }), /base model/);
  await assert.rejects(az.service.synthesize({ ...input, pitch: 5 }), /pitch/);
  await assert.rejects(az.service.synthesize({ ...input, style: "cheerful" }), /styles/);
  az.consents.get("consent-test").status = "Disabled";
  await assert.rejects(az.service.synthesize(input), /no longer active/);
  az.consents.get("consent-test").status = "Succeeded";
  az.voices.get("voice-test").speakerProfileId = undefined;
  await assert.rejects(az.service.synthesize(input), /invalid speaker profile/);
  assert.equal(az.calls.some((call) => call.uri.endsWith("/cognitiveservices/v1")), false);
});

test("voices from unrelated Azure projects cannot be used or deleted", async () => {
  const az = azureMock();
  az.voices.set("other-voice", { id: "other-voice", projectId: "someone-else", status: "Succeeded" });
  await assert.rejects(az.service.remove("personalvoices", "other-voice"), (error) => error.status === 403);
  assert.equal(az.calls.some((call) => call.method === "DELETE"), false);
});

test("processing failures are returned as explicit actionable states", async () => {
  const az = azureMock();
  await az.service.createConsent("consent-test", form());
  Object.assign(az.consents.get("consent-test"), { status: "Failed", properties: { failureReason: "AudioAndScriptNotMatch" } });
  assert.match((await az.service.overview()).consents[0].failure, /exact statement/);
});

test("pagination never forwards credentials to another origin", async () => {
  const calls = [];
  const service = createPersonalVoiceService(config, async (uri) => {
    calls.push(uri);
    return Response.json({ value: [], nextLink: "https://other.example/customvoice/personalvoices" });
  }, tokenProvider, {});
  await assert.rejects(service.overview(), /unsafe pagination URL/);
  assert.ok(calls.every((uri) => uri.startsWith(config.endpoint)));
});

test("missing custom endpoint and Azure authentication failures are explicit", async () => {
  const missing = createPersonalVoiceService({ region: "eastus2", resourceId: config.resourceId }, () => assert.fail("no network"), tokenProvider, {});
  await assert.rejects(missing.overview(), /AZURE_SPEECH_ENDPOINT/);
  for (const status of [401, 403, 429, 500]) {
    const service = createPersonalVoiceService(config, async () => new Response("private upstream details", { status }), tokenProvider, {});
    await assert.rejects(service.overview(), (error) => {
      assert.ok(!error.message.includes("private"));
      assert.equal(error.status, status === 500 ? 502 : status);
      return true;
    });
  }
});

test("HTTP routes accept multipart uploads and preserve prebuilt synthesis", async (t) => {
  const az = azureMock();
  const server = createApp({ config, fetchImpl: az.fetchImpl, tokenProvider });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers) => fetch(`${base}${path}`, { method: "POST", body, headers });
  let response = await post("/api/personal/consents/consent-test", form());
  assert.equal(response.status, 201);
  az.consents.get("consent-test").status = "Succeeded";
  response = await post("/api/personal/voices/voice-test", form("sample"));
  assert.equal(response.status, 201);
  az.voices.get("voice-test").status = "Succeeded";
  response = await post("/api/synthesize", JSON.stringify({ voiceType: "personal", voice: "DragonLatestNeural", personalVoiceId: "voice-test", text: "Demo", format: "wav" }), { "Content-Type": "application/json" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "audio/wav");
  response = await post("/api/synthesize", JSON.stringify({ voice: "en-US-JennyNeural", text: "Prebuilt still works." }), { "Content-Type": "application/json" });
  assert.equal(response.status, 200);
  const invalid = form();
  invalid.append("audio", new File([wav()], "second.wav"));
  assert.equal((await post("/api/personal/consents/duplicate", invalid)).status, 400);
  assert.equal((await post("/api/personal/consents/bad-format", "not multipart")).status, 415);
  assert.equal((await post("/api/personal/consents/bad-origin", form(), { Origin: "https://other.example" })).status, 403);
  assert.equal((await fetch(`${base}/api/personal/voices/voice-test`, { method: "DELETE" })).status, 202);
});
