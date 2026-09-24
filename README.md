# VoiceSynth

A local text-to-speech studio using your existing Azure Speech resource. Enter a script, choose a voice and speaking style, adjust speed and pitch, then play or download MP3 or WAV audio.

## Run

Requires **Node.js 22.9 or later** and **Azure CLI 2.54 or later** on the server's PATH. Install the MCP SDK dependencies (the browser app itself still uses only Node's built-in modules):

```sh
npm ci
cp .env.example .env
az login
```

For an existing `.env`, edit it instead of copying over it. Set the full **Resource ID** from your Speech resource's **Properties** page in the Azure portal and its region:

```dotenv
AZURE_SPEECH_RESOURCE_ID=/subscriptions/YOUR-SUBSCRIPTION-ID/resourceGroups/YOUR-GROUP/providers/Microsoft.CognitiveServices/accounts/YOUR-RESOURCE
AZURE_SPEECH_REGION=eastus
PORT=3000
```

Use your resource's actual region identifier (for example `westeurope`), not its display name or endpoint URL. Your signed-in identity needs **Cognitive Services Speech User** or **Cognitive Services Speech Contributor** on that resource. A subscription Owner/Contributor management role alone is not a substitute for Speech data-plane permissions.

The server runs `az account get-access-token --resource https://cognitiveservices.azure.com --subscription <subscription-from-resource-ID>`. It does not change your default CLI subscription, start interactive login, create resources, or grant roles. An existing `AZURE_SPEECH_KEY` is ignored and can be removed. Key-based authentication may remain disabled.

Then:

```sh
npm start
```

Open **http://localhost:3000**. After changing `.env`, stop the server with Ctrl+C and run `npm start` again. The connection check loads the actual voice catalog from Azure; merely configuring a resource does not mark the service connected.

CLI tokens are cached only in server memory, refreshed two minutes before expiry, and discarded after an authentication rejection. If CLI login expires, run `az login` and use **Check connection** again. After intentionally switching CLI accounts or signing out, restart the server to discard its previously cached token.

`npm run dev` watches source changes. `npm test` runs automated tests with mocked Azure and CLI responses; no login or billable requests are needed.

## MCP server for coding agents

The local **stdio MCP server** exposes the existing Azure services directly. It uses the same `.env` and `az login` as the web app, but does **not** require `npm start` or a browser. The coding agent launches and stops its own MCP process. No HTTP MCP endpoint is exposed.

**VS Code / GitHub Copilot:** this folder includes `.vscode/mcp.json`. Open the folder in VS Code, approve the server when prompted, and start `voicesynth` from the MCP server controls. Review tool calls before approving billable generation.

**Other local coding agents:** register a stdio server with command `node` and one argument, the absolute path to `mcp.mjs`. For GitHub Copilot CLI, use `/mcp add` and enter that command and argument. For clients using an `mcpServers` JSON configuration, merge this entry into the existing configuration:

```json
{
  "mcpServers": {
    "voicesynth": {
      "command": "node",
      "args": ["/Users/gubert/voicesynth/mcp.mjs"]
    }
  }
}
```

Replace the path if the app is moved. The entrypoint loads `.env` beside itself, regardless of the agent's working directory; environment variables explicitly supplied by the client take precedence. Both `node` and `az` must be on the spawned process's PATH. Use an absolute Node executable path if your editor does not inherit your terminal's PATH, and provide a PATH containing Azure CLI. Do not put API keys or access tokens in the MCP configuration. No global agent configuration is changed by this project.

| Tool | Purpose |
| --- | --- |
| `get_status` | Read configuration, limits, and output directory without contacting Azure. This is not an authentication or approval check. |
| `list_voices` | Discover prebuilt voice IDs and supported styles; optional exact `locale`, case-insensitive `search`, `offset`, and `limit` (default 25, maximum 100). |
| `list_personal_voices` | List existing profiles with `readyForSynthesis`, supported base models, and any Azure `accessError`; supports `offset` and `limit`. |
| `synthesize_speech` | Generate MP3/WAV narration and return its absolute local `path`, `mimeType`, `bytes`, and voice metadata. |

For example, ask your agent: **"Use VoiceSynth to find an en-US voice and create a WAV narration saying 'Welcome to the demo.' Save the generated file path in your response."**

The synthesis tool's arguments are:

```json
{
  "text": "Welcome to the demo.",
  "voice": "en-US-JennyNeural",
  "voiceType": "prebuilt",
  "format": "wav",
  "rate": 0,
  "pitch": 0,
  "style": "neutral"
}
```

Discover the voice first rather than assuming regional availability. `voiceType`, `format`, `rate`, `pitch`, and `style` default to `prebuilt`, `mp3`, `0`, `0`, and `neutral`. For an existing Personal Voice, set `voiceType` to `personal`, add `personalVoiceId` from the library, and set `voice` to an available base model. Pitch must remain 0 and style neutral. Live consent and profile readiness are checked again before synthesis; a Personal Voice failure never falls back to another speaker.

**Output and permissions:** audio is saved to `outputs/` next to the app by default, not the agent's current directory. Override `VOICESYNTH_OUTPUT_DIR` in `.env` or the client environment; relative values resolve from the app folder. Each file has a unique generated name, is created without overwriting another file, and uses owner-only permissions on POSIX. New output directories are owner-only; existing directory permissions are not changed. Results contain file metadata, not large base64 payloads. Files persist until you delete them, so treat this directory as sensitive and do not commit it. An agent on a different machine cannot access these local paths; this integration is intended for a local coding agent.

**Scope and safeguards:** MCP offers discovery and synthesis only, not recording uploads, consent creation, profile creation/deletion, arbitrary SSML, or arbitrary path reads/writes. Use the app for enrollment. Existing Personal Voice approval, consent, and disclosure requirements still apply, and model-access errors remain visible. Azure usage is billable. Each MCP process permits two concurrent generations independently of the web server or other agents. Calls are not automatically retried; canceling a client request may not stop an Azure request already in flight or prevent charges. Give synthesis tools a sufficiently long client timeout (at least 120 seconds; Personal Voice may need longer for its extra checks).

For a manual launch use `npm run --silent mcp` or `node mcp.mjs`. A quiet process waiting for input is normal: stdout is reserved for MCP JSON-RPC, and errors go to stderr. Prefer the direct `node` command in client configuration so npm banners cannot corrupt the protocol. Restart the MCP server after changing `.env`, switching Azure accounts, or signing out.

## Azure API

The originally linked [Custom Speech section](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-to-text#custom-speech) concerns **speech recognition**, not voice synthesis. This app instead implements Azure's [text-to-speech REST API](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech):

- Fetch regional voices with `GET https://{region}.tts.speech.microsoft.com/cognitiveservices/voices/list`.
- Send server-generated SSML to `POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1`.
- Authenticate on the server with `Authorization: Bearer aad#<resource-ID>#<Entra-access-token>`, using the resource-scoped format documented in the REST reference. No key-based token exchange is performed.
- Request `audio-24khz-48kbitrate-mono-mp3` or `riff-24khz-16bit-mono-pcm`.

The small request/response app uses REST so it needs no Azure SDK dependencies. The agent integration uses the official MCP SDK and Zod for tool schemas. It does not need streaming synthesis events. Style choices come from each voice's supported styles; plain text is XML-escaped rather than interpreted as SSML.

The studio supports **prebuilt Azure voices** and the **Personal Voice** workflow below. It does not train Professional Voice models or use Custom Speech recognition models. Azure Government regions beginning with `usgov` use `speech.azure.us` for prebuilt synthesis. Personal Voice additionally requires a supported region, feature approval, and a resource-specific custom endpoint; Azure China endpoints are not supported.

The regional REST resource-ID flow is used here; the app does not create a custom domain. [Microsoft's Entra setup guide](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-configure-azure-ad-auth) also describes custom-domain SDK flows, which are different from this REST integration. For sovereign-cloud resources, Azure CLI must be logged into the corresponding Azure cloud.

## Privacy and limits

- Access tokens stay on the server and are never returned to the browser, logged, or written to disk by this app. Azure CLI manages its own login cache. `.env` is excluded from version control. No credentials belong in `public/`.
- Text is sent to your Azure Speech resource when you select **Generate speech** or an agent calls `synthesize_speech`. Azure usage is billable according to your resource's pricing and quotas.
- The browser app does not save text or generated audio to disk or browser storage; download a recording to keep it before navigating away. **MCP-generated audio is saved to the output directory** until you delete it. VoiceSynth does not log script text, keys, tokens, or audio; your coding agent may retain tool arguments and results in its conversation history. **Personal Voice uploads and profiles are retained in Azure**, as described below.
- Scripts are limited to 3,000 JavaScript string characters. Azure's real-time REST output is capped at **10 minutes** and may truncate longer output; this character limit is not a guarantee of duration, especially for slow delivery or non-English scripts. For long-form work, split the script into short sections.
- The voice catalog is cached for 10 minutes; restart the app to refresh it immediately.
- The server binds only to `127.0.0.1`, rejects non-local hostnames and cross-origin requests, and allows at most two concurrent synthesis requests. This is a **local single-user app**, not a public deployment. Do not expose it through a reverse proxy or tunnel without adding authentication, authorization, and usage controls.
- If Azure rejects CLI authentication, run `az login` again and check the resource ID, region, Speech role assignment, and network rules. Newly assigned roles may take time to propagate. CLI installation, login, quota, and timeout failures are displayed in the app without exposing tokens or raw CLI output.

## Personal Voice for internal demos

This workflow is for **internal, authorized business content**. Microsoft must approve your Personal Voice use case; an accessible API or a successful library request is not proof of that approval. See the [approved Personal Voice use cases](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/speech-service/text-to-speech/transparency-note#intended-uses-for-personal-voice) and [apply for access](https://aka.ms/customneural). Obtain explicit written permission, share the [speaker disclosure](https://learn.microsoft.com/en-us/azure/foundry/responsible-ai/speech-service/text-to-speech/disclosure-voice-talent), and record the required verbal consent.

Set the **same resource's** custom endpoint in `.env`:

```dotenv
AZURE_SPEECH_ENDPOINT=https://YOUR-CUSTOM-SUBDOMAIN.cognitiveservices.azure.com/
```

Unlike regional synthesis, the Custom Voice API requires a custom subdomain for Entra token authentication. Enabling that subdomain in Azure is **irreversible**; do not invent the hostname without configuring the resource. Your identity needs permissions to create/manage Speech projects and recordings, such as **Cognitive Services Speech Contributor**, as well as feature approval and a supported paid tier/region. The app never assigns roles, obtains feature approval, or changes Azure resource settings automatically.

After restarting:

1. Open **Personal voices**. Azure library and base-model access are checked independently. A denied base-model request is displayed and disables uploads/usage, without affecting prebuilt voices.
2. Enter the speaker and company/resource-owner names exactly as they are spoken. Record the official statement in the same language as the voice sample. The form renders the official English (US) statement; for other languages, follow the linked official statement rather than translating it yourself.
3. Upload the consent recording and wait for **Succeeded**. Then select that verified consent and upload a 5-90 second recording of the same person speaking naturally.
4. Wait for the personal voice to reach **Succeeded**, then select **Use voice**. The studio uses the server-resolved speaker profile ID with a supported Dragon/Phoenix base model. Languages are detected automatically; speed is adjustable, but pitch and speaking styles are unavailable.
5. Listen and review before downloading. Include a clear disclosure in your actual demo, for example: “AI-generated narration using an authorized synthetic version of my voice.” A notice in the authoring app alone does not inform your demo's audience.

**Recording limits:** this app accepts one uncompressed PCM WAV per upload, not MP3, float WAV, or WAV extensible. Use mono/stereo, 16/24/32-bit samples, at 16, 24, 44.1, or 48 kHz; at most 30 MB. Voice samples must be 5-90 seconds; consent recordings must be 1-90 seconds. Actual WAV data, duration, headers, and alignment are validated server-side before Azure mutation. Azure performs the speech-quality, statement, and speaker-verification checks. Convert other formats to PCM WAV yourself before uploading; never synthesize or impersonate the consent.

**Persistence and recovery:** Azure stores the `voicesynth-personal` project, consent records, recordings, and profiles. The app does not save uploaded audio to local disk or browser storage. Closing/restarting the app does not cancel Azure processing; refresh the library to recover its state. Automatic checks run every five seconds while pending items are visible, pause after five minutes, and stop on errors; use **Refresh library** to resume. After an interrupted upload, refresh before retrying to avoid duplicates. The app supplies stable operation IDs while retrying unchanged submissions and does not blindly retry uploads or synthesis.

**Deletion:** use the library's **Delete** action and confirmation. Delete a voice before deleting its associated consent. Deletion is requested in Azure and can be asynchronous; refresh to confirm it disappears. Previously downloaded audio is not deleted. Consult Azure's retention terms; this UI does not promise immediate destruction of every service-side retained copy. Other Azure projects are not exposed or modified by this app.

**External users:** do not expose this upload workflow to people outside your organization. The [Code of Conduct](https://learn.microsoft.com/en-us/legal/ai-code-of-conduct#azure-speech-and-voice-services-in-foundry-tools) imposes additional external-user requirements, including in-app dynamic-script recording instead of prerecorded training uploads, disclosures, and opt-out/removal. This local internal-use tool is not an implementation of those external-user requirements.

**API contract:** project/consent/personal-voice management uses `/customvoice/...` with API version `2026-01-01` and a plain Entra bearer token on the custom endpoint. File uploads use `multipart/form-data` with `audiodata`. Synthesis uses the existing regional endpoint with resource-scoped Entra authorization and SSML `mstts:ttsembedding`; clients cannot supply arbitrary profile IDs. Read the [consent upload](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/personal-voice-create-consent?pivots=rest-api), [voice upload](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/personal-voice-create-voice?pivots=rest-api), and [synthesis](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/personal-voice-how-to-use) documentation.

## Layout

`server.mjs` serves the local app and API. `mcp.mjs` starts the stdio MCP server; `lib/mcp.mjs` defines agent tools and audio-file output. `lib/speech.mjs` handles CLI tokens and synthesis. `lib/personal-voice.mjs` validates recordings and manages Azure Personal Voice objects. `public/` contains the dependency-free browser interface. `test/` covers CLI authentication, uploads, consent gates, API failures, speech integration, MCP protocol, and file output.
