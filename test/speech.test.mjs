import test from "node:test";
import assert from "node:assert/strict";
import { get as httpGet } from "node:http";
import { createApp } from "../server.mjs";
import {
  AppError, createSpeechService as makeSpeechService, createSsml, escapeXml, FORMATS, MAX_TEXT_LENGTH,
  readConfig, validateInput,
} from "../lib/speech.mjs";

const resourceId = "/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/test/providers/Microsoft.CognitiveServices/accounts/test-speech";
const config = { resourceId, region: "eastus" };
const tokenProvider = { getToken: async () => "fake-cli-token", invalidate() {} };
const createSpeechService = (settings, fetchImpl) => makeSpeechService(settings, fetchImpl, tokenProvider);
const catalog = [
  { ShortName: "en-US-JennyNeural", DisplayName: "Jenny", Locale: "en-US", LocaleName: "English (United States)", Gender: "Female", StyleList: ["cheerful", "sad"] },
  { ShortName: "fr-FR-DeniseNeural", DisplayName: "Denise", Locale: "fr-FR", LocaleName: "French (France)", Gender: "Female" },
];
const input = { text: "Hello & welcome <friend>.", voice: "en-US-JennyNeural", rate: 0, pitch: 0, style: "neutral", format: "mp3" };

function fakeAzure(calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/voices/list")) return Response.json(catalog);
    return new Response(Buffer.from("test-audio-bytes"), { headers: { "Content-Type": "audio/mpeg" } });
  };
}

async function running(t, options = {}) {
  const server = createApp({ config, fetchImpl: fakeAzure(), tokenProvider, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    get: (path, options) => fetch(`${url}${path}`, options),
    post: (body, options = {}) => fetch(`${url}/api/synthesize`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), ...options,
    }),
  };
}

test("config uses CLI resource ID, ignores legacy keys, and rejects invalid configuration", () => {
  assert.deepEqual(readConfig({}), { resourceId: "", region: "" });
  assert.deepEqual(readConfig({ AZURE_SPEECH_RESOURCE_ID: ` ${resourceId} `, AZURE_SPEECH_KEY: "ignored", AZURE_SPEECH_REGION: " eastus " }), config);
  assert.throws(() => readConfig({ AZURE_SPEECH_REGION: "https://eastus.example" }), /region ID/);
  for (const id of ["https://eastus.api.cognitive.microsoft.com", "sps-guy", `${resourceId}#injected`, `${resourceId}\nheader`]) {
    assert.throws(() => readConfig({ AZURE_SPEECH_RESOURCE_ID: id }), /full Azure resource ID/);
  }
});

test("plain text is escaped, including SSML and quotes", () => {
  assert.equal(escapeXml(`<voice name="x">'&</voice>`), "&lt;voice name=&quot;x&quot;&gt;&apos;&amp;&lt;/voice&gt;");
  const ssml = createSsml(input, { id: input.voice, locale: "en-US" });
  assert.ok(ssml.includes("Hello &amp; welcome &lt;friend&gt;."));
  assert.ok(ssml.includes('rate="+0%" pitch="+0%"'));
  assert.ok(!ssml.includes("express-as"));
  const styled = createSsml({ ...input, style: "cheerful", rate: -25, pitch: 10 }, { id: input.voice, locale: "en-US" });
  assert.ok(styled.includes('<mstts:express-as style="cheerful">'));
  assert.ok(styled.includes('rate="-25%" pitch="+10%"'));
});

test("input limits accept boundaries and multilingual text", () => {
  assert.equal(validateInput({ ...input, text: "a".repeat(MAX_TEXT_LENGTH), rate: -50, pitch: 20 }).text.length, MAX_TEXT_LENGTH);
  assert.equal(validateInput({ text: "Olá 世界 😀\n\t", voice: input.voice }).format, "mp3");
});

for (const [name, value] of Object.entries({
  "missing body": null,
  "array body": [],
  "empty text": { ...input, text: "   " },
  "non-string text": { ...input, text: 5 },
  "too much text": { ...input, text: "a".repeat(MAX_TEXT_LENGTH + 1) },
  "XML control character": { ...input, text: "a\u0000b" },
  "unpaired surrogate": { ...input, text: "\ud800" },
  "missing voice": { ...input, voice: "" },
  "out-of-range rate": { ...input, rate: 51 },
  "string rate": { ...input, rate: "25" },
  "fractional pitch": { ...input, pitch: 1.5 },
  "out-of-range pitch": { ...input, pitch: -21 },
  "invalid style": { ...input, style: {} },
  "invalid format": { ...input, format: "ogg" },
  "prototype format": { ...input, format: "__proto__" },
})) {
  test(`rejects ${name}`, () => {
    assert.throws(() => validateInput(value), (error) => error instanceof AppError && error.status === 400);
  });
}

test("catalog is normalized, cached, and concurrent requests are deduplicated", async () => {
  const calls = [];
  const service = createSpeechService(config, fakeAzure(calls));
  const [first, second] = await Promise.all([service.listVoices(), service.listVoices()]);
  assert.deepEqual(first, second);
  assert.equal(first[0].name, "Jenny");
  assert.deepEqual(first[1].styles, []);
  await service.listVoices();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://eastus.tts.speech.microsoft.com/cognitiveservices/voices/list");
  assert.equal(calls[0].options.headers.Authorization, `Bearer aad#${resourceId}#fake-cli-token`);
  assert.equal(calls[0].options.headers["Ocp-Apim-Subscription-Key"], undefined);
  assert.equal(calls[0].options.redirect, "error");
});

for (const format of ["mp3", "wav"]) {
  test(`synthesizes ${format} with the documented Azure request`, async () => {
    const calls = [];
    const service = createSpeechService(config, fakeAzure(calls));
    const result = await service.synthesize({ ...input, format });
    assert.equal(result.audio.toString(), "test-audio-bytes");
    assert.equal(result.mime, FORMATS[format].mime);
    assert.equal(calls[1].url, "https://eastus.tts.speech.microsoft.com/cognitiveservices/v1");
    assert.equal(calls[1].options.headers["X-Microsoft-OutputFormat"], FORMATS[format].azure);
    assert.equal(calls[1].options.headers["Content-Type"], "application/ssml+xml");
    assert.equal(calls[1].options.headers.Authorization, `Bearer aad#${resourceId}#fake-cli-token`);
    assert.match(calls[1].options.body, /Hello &amp; welcome/);
  });
}

test("unknown voices and unsupported styles never reach synthesis", async () => {
  const calls = [];
  const service = createSpeechService(config, fakeAzure(calls));
  await assert.rejects(service.synthesize({ ...input, voice: "fake" }), /not available/);
  await assert.rejects(service.synthesize({ ...input, style: "whispering" }), /not supported/);
  assert.equal(calls.length, 1);
});

for (const [status, expected, message] of [
  [401, 502, /authentication/], [403, 502, /authentication/],
  [429, 429, /quota/], [400, 422, /settings/], [500, 502, /HTTP 500/],
]) {
  test(`Azure ${status} becomes actionable error without upstream body leakage`, async () => {
    const service = createSpeechService(config, async () => new Response("private upstream details", { status }));
    await assert.rejects(service.listVoices(), (error) => {
      assert.equal(error.status, expected);
      assert.match(error.message, message);
      assert.ok(!error.message.includes("private"));
      return true;
    });
  });
}

test("malformed catalogs and failed requests can be retried", async () => {
  let attempts = 0;
  const service = createSpeechService(config, async () => {
    attempts++;
    return attempts === 1 ? Response.json({ unexpected: true }) : Response.json(catalog);
  });
  await assert.rejects(service.listVoices(), /unexpected voice list/);
  assert.equal((await service.listVoices()).length, 2);
});

test("missing credentials fail without a network call", async () => {
  const service = createSpeechService({ resourceId: "", region: "" }, () => assert.fail("must not call Azure"));
  await assert.rejects(service.listVoices(), (error) => error.status === 503);
});

test("network and timeout failures are explicit", async () => {
  for (const [name, status] of [["TypeError", 502], ["TimeoutError", 504]]) {
    const service = createSpeechService(config, async () => { throw Object.assign(new Error("private"), { name }); });
    await assert.rejects(service.listVoices(), (error) => error.status === status && !error.message.includes("private"));
  }
});

test("empty audio fails rather than reporting success", async () => {
  const service = createSpeechService(config, async (url) => url.endsWith("/list") ? Response.json(catalog) : new Response(""));
  await assert.rejects(service.synthesize(input), /empty audio/);
});

test("Azure Government uses its own speech domain", async () => {
  const calls = [];
  await createSpeechService({ ...config, region: "usgovvirginia" }, fakeAzure(calls)).listVoices();
  assert.ok(calls[0].url.startsWith("https://usgovvirginia.tts.speech.azure.us/"));
});

test("local server exposes setup status without credentials", async (t) => {
  const app = await running(t);
  const response = await app.get("/api/config");
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), { configured: true, authMode: "azure-cli", region: "eastus", maxTextLength: 3000 });
  assert.ok(!body.includes("fake-cli-token"));
  assert.ok(!body.includes(resourceId));
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
});

test("unconfigured server serves UI and returns an actionable setup error", async (t) => {
  const app = await running(t, { config: { resourceId: "", region: "" } });
  const status = await (await app.get("/api/config")).json();
  assert.equal(status.configured, false);
  assert.equal((await app.get("/")).status, 200);
  const voices = await app.get("/api/voices");
  assert.equal(voices.status, 503);
  assert.match((await voices.json()).error, /\.env/);
});

test("CLI authentication errors are not hidden as network failures", async () => {
  const service = makeSpeechService(config, () => assert.fail("must not call Azure"), {
    getToken: async () => { throw new AppError(503, "Run az login."); },
  });
  await assert.rejects(service.listVoices(), (error) => error.status === 503 && error.message === "Run az login.");
});

test("authentication rejection invalidates the cached token without retrying synthesis", async () => {
  let invalidations = 0;
  let requests = 0;
  const service = makeSpeechService(config, async (url) => {
    if (url.endsWith("/list")) return Response.json(catalog);
    requests++;
    return new Response("", { status: 401 });
  }, {
    getToken: async () => "fake-token",
    invalidate: () => { invalidations++; },
  });
  await assert.rejects(service.synthesize(input), /CLI authentication/);
  assert.equal(invalidations, 1);
  assert.equal(requests, 1);
});

test("server returns actual audio bytes and matching content metadata", async (t) => {
  const app = await running(t);
  for (const format of ["mp3", "wav"]) {
    const response = await app.post({ ...input, format });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), FORMATS[format].mime);
    assert.equal(response.headers.get("Content-Disposition"), `attachment; filename="voicesynth.${format}"`);
    assert.equal(await response.text(), "test-audio-bytes");
  }
});

test("server enforces JSON, payload size, and input validation", async (t) => {
  const app = await running(t);
  assert.equal((await app.post({ ...input, text: "" })).status, 400);
  assert.equal((await app.post(input, { body: "{" })).status, 400);
  assert.equal((await app.post(input, { headers: { "Content-Type": "text/plain" } })).status, 415);
  assert.equal((await app.post({ ...input, text: "a".repeat(33_000) })).status, 413);
});

test("server blocks cross-origin calls and never serves environment/source files", async (t) => {
  const app = await running(t);
  assert.equal((await app.post(input, { headers: { "Content-Type": "application/json", Origin: "https://other.example" } })).status, 403);
  assert.equal((await app.get("/api/voices", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    httpGet(`${app.url}/api/config`, { headers: { Host: "other.example" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(badHostStatus, 403);
  for (const path of ["/.env", "/.env.example", "/server.mjs", "/package.json", "/lib/speech.mjs", "/public/../.env"]) {
    assert.equal((await app.get(path)).status, 404);
  }
  for (const path of ["/", "/app.js", "/styles.css"]) assert.equal((await app.get(path)).status, 200);
});

test("server caps concurrent synthesis and releases capacity", async (t) => {
  let waiting = [];
  const app = await running(t, {
    fetchImpl: async (url) => {
      if (url.endsWith("/list")) return Response.json(catalog);
      return new Promise((resolve) => waiting.push(() => resolve(new Response("audio"))));
    },
  });
  const first = app.post(input);
  const second = app.post(input);
  while (waiting.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await app.post(input)).status, 429);
  waiting.forEach((resolve) => resolve());
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  waiting = [];
  const third = app.post(input);
  while (!waiting.length) await new Promise((resolve) => setTimeout(resolve, 5));
  waiting[0]();
  assert.equal((await third).status, 200);
});
