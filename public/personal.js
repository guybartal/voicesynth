const element = (id) => document.getElementById(id);
const consentForm = element("consent-form");
const voiceForm = element("personal-form");
let state = { voices: [], consents: [], models: [], accessError: "" };
let available = false;
let loading = false;
let mutating = false;
let timer;
let polls = 0;
let request;
let changed;
let useVoice;
const uploadIds = new Map();
const previews = new Map();

function error(message) {
  element("personal-error").textContent = message;
  element("personal-error").hidden = !message;
}

function controls() {
  element("consent-fields").disabled = !available || loading || mutating;
  const hasConsent = state.consents.some((item) => item.status === "Succeeded");
  element("personal-fields").disabled = !available || !hasConsent || loading || mutating;
  element("consent-needed").hidden = hasConsent;
  element("refresh-personal").disabled = loading || mutating;
}

function statement() {
  element("consent-script").textContent = element("consent-locale").value === "en-US"
    ? `I ${element("talent-name").value.trim() || "[state your first and last name]"} am aware that recordings of my voice will be used by ${element("company-name").value.trim() || "[state the name of the company]"} to create and use a synthetic version of my voice.`
    : "Read the official consent statement for the selected language. Use the link below; do not translate the English example yourself.";
}

function releasePreview(input) {
  const previous = previews.get(input.id);
  const audio = element(input.id === "consent-audio" ? "consent-preview" : "sample-preview");
  audio.pause();
  audio.removeAttribute("src");
  audio.hidden = true;
  if (previous) URL.revokeObjectURL(previous);
  previews.delete(input.id);
}

function preview(input) {
  releasePreview(input);
  const file = input.files[0];
  if (!file) return;
  if (!/\.wav$/i.test(file.name) || file.size > 30_000_000 || !file.size) {
    input.value = "";
    error("Choose a PCM WAV file no larger than 30 MB. Other formats must be converted before uploading.");
    return;
  }
  const url = URL.createObjectURL(file);
  previews.set(input.id, url);
  const audio = element(input.id === "consent-audio" ? "consent-preview" : "sample-preview");
  audio.src = url;
  audio.hidden = false;
}

function renderLibrary(target, items, kind) {
  const root = element(target);
  root.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "field-help";
    empty.textContent = kind === "voices" ? "No personal voices yet. Start with the speaker's consent." : "No consent recordings yet.";
    root.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "library-row";
    const info = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = item.name;
    const status = document.createElement("p");
    status.className = "field-help";
    status.textContent = `${item.status}${kind === "consents" ? ` · ${item.talentName} · ${item.locale}` : ""}`;
    info.append(title, status);
    const id = document.createElement("code");
    id.textContent = item.id;
    info.append(id);
    if (item.failure) {
      const failure = document.createElement("p");
      failure.className = "field-help";
      failure.textContent = item.failure;
      info.append(failure);
    }
    const actions = document.createElement("div");
    actions.className = "library-actions";
    if (kind === "voices" && item.status === "Succeeded") {
      const use = document.createElement("button");
      use.type = "button";
      use.className = "button secondary";
      use.textContent = "Use voice";
      use.disabled = !available || mutating;
      use.addEventListener("click", () => useVoice(item.id));
      actions.append(use);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-button";
    remove.textContent = "Delete";
    remove.disabled = mutating || item.status === "Disabling"
      || (kind === "consents" && state.voices.some((voice) => voice.consentId === item.id));
    remove.title = kind === "consents" ? "Delete dependent personal voices before deleting their consent." : "Delete this voice from Azure.";
    remove.addEventListener("click", async () => {
      if (!confirm(`Delete "${item.name}" from Azure? This cannot be undone. Existing downloaded audio will not be deleted.`)) return;
      mutating = true;
      stopPolling();
      controls();
      render();
      error("");
      try {
        const result = await (await request(`/api/personal/${kind}/${encodeURIComponent(item.id)}`, { method: "DELETE" })).json();
        element("personal-status").textContent = result.message;
      } catch (failure) { error(failure.message); }
      finally { mutating = false; await refresh(false); }
    });
    actions.append(remove);
    row.append(info, actions);
    root.append(row);
  }
}

function render() {
  const select = element("verified-consent");
  const previous = select.value;
  const verified = state.consents.filter((item) => item.status === "Succeeded");
  select.replaceChildren(new Option(verified.length ? "Choose verified consent" : "No verified consent yet", ""));
  for (const consent of verified) select.add(new Option(`${consent.name} · ${consent.talentName} · ${consent.locale}`, consent.id));
  if (verified.some((item) => item.id === previous)) select.value = previous;
  else if (verified.length === 1) select.value = verified[0].id;
  renderLibrary("personal-list", state.voices, "voices");
  renderLibrary("consent-list", state.consents, "consents");
  controls();
  changed(state, available);
}

function stopPolling() {
  clearTimeout(timer);
}

function schedule() {
  stopPolling();
  if (element("personal-view").hidden || document.hidden || !available) return;
  const pending = [...state.consents, ...state.voices].some((item) => ["NotStarted", "Running", "Disabling"].includes(item.status));
  if (!pending) return;
  if (polls >= 60) {
    element("personal-status").textContent = "Azure is still processing. Automatic checks paused after 5 minutes. Use Refresh library to continue; do not upload again.";
    return;
  }
  timer = setTimeout(() => { polls++; refresh(false); }, 5000);
}

async function refresh(reset = true) {
  if (loading || mutating) return;
  stopPolling();
  if (reset) { polls = 0; error(""); }
  loading = true;
  controls();
  try {
    state = await (await request("/api/personal")).json();
    available = !state.accessError && state.models.length > 0;
    if (state.accessError) error(state.accessError);
    else if (reset) error("");
    element("personal-status").textContent = available
      ? "Azure library loaded. API access does not replace approval for your specific use case."
      : "Library loaded. Creating and using personal voices is blocked until Azure grants model access.";
    render();
  } catch (failure) {
    available = false;
    error(failure.message);
    element("personal-status").textContent = "Library refresh failed. Previously loaded items may be out of date. Your prebuilt voices are unaffected.";
    changed(state, false);
  } finally {
    loading = false;
    controls();
    if (available) schedule();
  }
}

async function submit(event, kind) {
  event.preventDefault();
  if (!available || mutating || loading) return;
  const form = event.currentTarget;
  const data = new FormData(form);
  const file = data.get("audio");
  if (!file?.size || file.size > 30_000_000) return error("Choose one PCM WAV file no larger than 30 MB.");
  const id = uploadIds.get(kind) || `${kind === "consents" ? "consent" : "voice"}-${crypto.randomUUID()}`;
  uploadIds.set(kind, id);
  mutating = true;
  stopPolling();
  error("");
  controls();
  render();
  element("personal-status").textContent = "Uploading to Azure. Keep this page open until the request finishes.";
  let accepted = false;
  try {
    const item = await (await request(`/api/personal/${kind}/${id}`, { method: "POST", body: data })).json();
    accepted = true;
    uploadIds.delete(kind);
    releasePreview(element(kind === "consents" ? "consent-audio" : "sample-audio"));
    form.reset();
    statement();
    element("personal-status").textContent = `Azure accepted ${item.name}. Status: ${item.status}.`;
  } catch (failure) {
    error(`${failure.message} Upload ID: ${id}. Refresh the library before starting another upload.`);
  } finally {
    mutating = false;
    await refresh(accepted);
  }
}

export function initPersonal(options) {
  ({ request, changed, useVoice } = options);
  consentForm.addEventListener("submit", (event) => submit(event, "consents"));
  voiceForm.addEventListener("submit", (event) => submit(event, "voices"));
  for (const form of [consentForm, voiceForm]) {
    form.addEventListener("change", () => {
      if (!mutating) uploadIds.delete(form === consentForm ? "consents" : "voices");
    });
  }
  element("refresh-personal").addEventListener("click", () => refresh());
  for (const id of ["talent-name", "company-name", "consent-locale"]) element(id).addEventListener("input", statement);
  for (const id of ["consent-audio", "sample-audio"]) {
    element(id).addEventListener("change", (event) => preview(event.target));
    element(id === "consent-audio" ? "consent-preview" : "sample-preview").addEventListener("error", () => error("This browser could not preview the WAV recording. Check that it is a valid uncompressed PCM WAV file."));
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopPolling(); else schedule();
  });
  window.addEventListener("pagehide", () => {
    stopPolling();
    for (const id of ["consent-audio", "sample-audio"]) releasePreview(element(id));
  });
  statement();
  return {
    refresh,
    hide: stopPolling,
    setLocales(locales) {
      const select = element("consent-locale");
      const previous = select.value;
      select.replaceChildren(...locales.map(([id, name]) => new Option(name, id)));
      if (locales.some(([id]) => id === previous)) select.value = previous;
      statement();
    },
  };
}
