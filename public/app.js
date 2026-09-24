import { initPersonal } from "./personal.js";

const element = (id) => document.getElementById(id);
const form = element("studio");
const text = element("text");
const language = element("language");
const voice = element("voice");
const style = element("style");
const rate = element("rate");
const pitch = element("pitch");
const format = element("format");
const voiceType = element("voice-type");
const baseModel = element("base-model");
const generate = element("generate");
const audio = element("audio");
let voices = [];
let ready = false;
let busy = false;
let connecting = false;
let audioUrl;
let recordingSignature;
let personalState = { voices: [], models: [] };
let personalAvailable = false;

const personal = initPersonal({
  request,
  changed(state, available) {
    personalState = state;
    personalAvailable = available;
    if (voiceType.value === "personal") populatePersonal(voice.value);
  },
  useVoice(id) {
    voiceType.value = "personal";
    populatePersonal(id);
    showSection(false);
    voice.focus();
  },
});

function showSection(isPersonal) {
  element("studio-view").hidden = isPersonal;
  element("personal-view").hidden = !isPersonal;
  element("show-studio").setAttribute("aria-pressed", String(!isPersonal));
  element("show-personal").setAttribute("aria-pressed", String(isPersonal));
  if (isPersonal) personal.refresh(); else personal.hide();
}

function showError(message) {
  element("notice").textContent = message;
  element("notice").hidden = !message;
}

function connection(state, message) {
  element("connection").dataset.state = state;
  element("connection-text").textContent = message;
}

function settings() {
  if (voiceType.value === "personal") {
    return {
      text: text.value, voiceType: "personal", personalVoiceId: voice.value,
      voice: baseModel.value, style: "neutral", rate: Number(rate.value), pitch: 0, format: format.value,
    };
  }
  return {
    text: text.value, voice: voice.value, style: style.value,
    rate: Number(rate.value), pitch: Number(pitch.value), format: format.value,
  };
}

function update() {
  const usingPersonal = voiceType.value === "personal";
  const canGenerate = ready && (!usingPersonal || (personalAvailable && voice.value && baseModel.value));
  element("count").textContent = `${text.value.length.toLocaleString()} / 3,000`;
  element("rate-value").value = `${(1 + Number(rate.value) / 100).toFixed(2)}×`;
  element("pitch-value").value = Number(pitch.value) === 0 ? "Natural" : `${Number(pitch.value) > 0 ? "+" : ""}${pitch.value}%`;
  rate.setAttribute("aria-valuetext", `${(1 + Number(rate.value) / 100).toFixed(2)} times normal speed`);
  pitch.setAttribute("aria-valuetext", element("pitch-value").value);
  generate.disabled = !canGenerate || busy || !text.value.trim();
  element("voice-controls").disabled = !ready || busy;
  pitch.disabled = usingPersonal;
  style.disabled = usingPersonal;
  element("language-field").hidden = usingPersonal;
  element("base-model-field").hidden = !usingPersonal;
  element("manage-personal").hidden = !usingPersonal;
  text.readOnly = busy;
  element("sample").disabled = busy;
  form.setAttribute("aria-busy", String(busy));
  element("generate-label").textContent = busy ? "Generating speech…" : "Generate speech";
  element("generation-hint").replaceChildren();
  const hint = busy ? "Creating your recording with Azure…"
    : !canGenerate ? usingPersonal ? "Create or select an available personal voice." : "Connect Azure to start generating."
    : !text.value.trim() ? "Add your script to get started."
    : "Ready when you are.";
  const detail = document.createElement("span");
  detail.textContent = "Your text is sent to Azure only when you generate.";
  element("generation-hint").append(hint, document.createElement("br"), detail);
  if (recordingSignature) {
    element("recording-note").hidden = false;
    element("recording-note").textContent = JSON.stringify(settings()) === recordingSignature
      ? "Download to keep this recording. Disclose AI-generated narration in your demo. Audio is not saved when you leave this page."
      : "This recording uses your previous script or settings. Generate again to hear your changes.";
  }
}

function option(value, label) {
  return new Option(label, value);
}

function populateStyles() {
  if (voiceType.value === "personal") {
    style.replaceChildren(option("neutral", "Neutral (required)"));
    pitch.value = "0";
    element("voice-detail").textContent = personalAvailable
      ? "Your authorized synthetic voice. Only succeeded Azure profiles can be used."
      : "Personal Voice is unavailable. Open Manage personal voices for setup and access details.";
    update();
    return;
  }
  const selected = voices.find((item) => item.id === voice.value);
  style.replaceChildren(option("neutral", "Neutral"), ...(selected?.styles || [])
    .filter((name) => name !== "neutral")
    .map((name) => option(name, name.charAt(0).toUpperCase() + name.slice(1))));
  element("voice-detail").textContent = selected ? `${selected.gender} · ${selected.locale}` : "No voices available.";
  update();
}

function populateVoices(preferred) {
  if (voiceType.value === "personal") return populatePersonal(preferred);
  const available = voices.filter((item) => item.locale === language.value);
  voice.replaceChildren(...available.map((item) => option(item.id, item.name)));
  if (available.some((item) => item.id === preferred)) voice.value = preferred;
  populateStyles();
}

function populatePersonal(preferred) {
  const readyVoices = personalState.voices.filter((item) => item.status === "Succeeded");
  voice.replaceChildren(...readyVoices.map((item) => option(item.id, item.name)));
  if (!readyVoices.length) voice.add(option("", "No ready personal voices"));
  if (readyVoices.some((item) => item.id === preferred)) voice.value = preferred;
  const previousModel = baseModel.value;
  baseModel.replaceChildren(...personalState.models.map((name) => option(name, name)));
  if (personalState.models.includes(previousModel)) baseModel.value = previousModel;
  populateStyles();
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, { ...options, signal: AbortSignal.timeout(135_000) });
  } catch (error) {
    if (error.name === "TimeoutError") throw new Error("The request timed out. Try a shorter script or try again later.");
    throw new Error("Could not reach the local server. Make sure npm start is running, then try again.");
  }
  if (!response.ok) {
    let data;
    try { data = await response.json(); } catch { throw new Error(`The server returned HTTP ${response.status}. Restart the server and try again.`); }
    throw new Error(data.error || `Request failed (HTTP ${response.status}).`);
  }
  return response;
}

async function connect() {
  if (connecting || busy) return;
  connecting = true;
  ready = false;
  element("reconnect").disabled = true;
  showError("");
  connection("loading", "Checking connection");
  update();
  try {
    const config = await (await request("/api/config")).json();
    element("setup").hidden = config.configured;
    if (!config.configured) {
      connection("setup", "Setup needed");
      return;
    }
    connection("loading", "Loading Azure voices");
    const data = await (await request("/api/voices")).json();
    voices = data.voices.sort((a, b) => a.name.localeCompare(b.name));
    const locales = [...new Map(voices.map((item) => [item.locale, item.localeName])).entries()]
      .sort((a, b) => a[1].localeCompare(b[1]));
    language.replaceChildren(...locales.map(([id, name]) => option(id, name)));
    personal.setLocales(locales);
    const preferredLanguage = navigator.language;
    language.value = locales.some(([id]) => id === preferredLanguage) ? preferredLanguage
      : locales.some(([id]) => id === "en-US") ? "en-US" : locales[0][0];
    ready = true;
    populateVoices("en-US-JennyNeural");
    connection("ready", `Connected · ${config.region} · Azure CLI`);
  } catch (error) {
    connection("error", "Connection unavailable");
    element("setup").hidden = false;
    showError(error.message);
  } finally {
    connecting = false;
    element("reconnect").disabled = false;
    update();
  }
}

language.addEventListener("change", () => populateVoices());
voice.addEventListener("change", populateStyles);
voiceType.addEventListener("change", () => {
  populateVoices();
  if (voiceType.value === "personal") personal.refresh();
});
element("show-studio").addEventListener("click", () => showSection(false));
element("show-personal").addEventListener("click", () => showSection(true));
element("manage-personal").addEventListener("click", () => showSection(true));
form.addEventListener("input", update);
form.addEventListener("change", update);
element("reconnect").addEventListener("click", connect);
element("sample").addEventListener("click", () => {
  text.value = "Every idea begins with a voice. A story worth telling, a thought worth sharing, a moment worth remembering. Give your words a little room to breathe, and see where they take you.";
  update();
  text.focus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (generate.disabled || !ready || busy || !text.value.trim()) return;
  busy = true;
  showError("");
  audio.pause();
  const input = settings();
  const selectedVoice = input.voiceType === "personal"
    ? personalState.voices.find((item) => item.id === input.personalVoiceId)
    : voices.find((item) => item.id === input.voice);
  element("empty-message").textContent = "Finding the voice in your words…";
  element("empty-detail").textContent = "Azure is generating your audio. Longer scripts can take a moment.";
  update();
  try {
    const response = await request("/api/synthesize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const blob = await response.blob();
    if (!blob.size) throw new Error("The recording is empty. Try generating again.");
    const nextUrl = URL.createObjectURL(blob);
    const oldUrl = audioUrl;
    audioUrl = nextUrl;
    audio.src = audioUrl;
    const download = element("download");
    download.href = audioUrl;
    download.download = `voicesynth-${input.personalVoiceId || input.voice}.${input.format}`;
    download.textContent = `Download ${input.format.toUpperCase()}`;
    element("empty-recording").hidden = true;
    element("audio-result").hidden = false;
    element("recording-meta").textContent = `${selectedVoice.name} · ${input.voiceType === "personal" ? "Personal voice · AI-generated" : selectedVoice.locale} · ${input.format.toUpperCase()}`;
    recordingSignature = JSON.stringify(input);
    if (oldUrl) URL.revokeObjectURL(oldUrl);
    element("recording-title").setAttribute("tabindex", "-1");
    element("recording-title").focus({ preventScroll: true });
    element("recording-title").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "nearest" });
  } catch (error) {
    showError(error.message);
  } finally {
    busy = false;
    element("empty-message").textContent = "A little quiet in here.";
    element("empty-detail").textContent = "Your generated audio will appear here, ready to play and download.";
    update();
  }
});

audio.addEventListener("error", () => {
  showError("This browser could not play the recording. Download it to play locally, or try the other audio format.");
});
window.addEventListener("pagehide", (event) => {
  if (!event.persisted && audioUrl) URL.revokeObjectURL(audioUrl);
});
connect();
