# Meeting Helper for Windows

An always-on-top desktop chat assistant for Teams, Zoom, or any app playing audio
on your Windows computer. Meeting Helper is independent of those meeting apps;
it does not join calls, post messages, or speak on your behalf.

## Requirements and setup

- Windows 10 version 2004 or later, or Windows 11.
- Node.js 22.12 or later and npm.
- The service operator needs SAP AI Core credentials with access to a running
  `gemini-3.5-flash` deployment, internet/VPN access, and sufficient quota.
- Hosted account control requires a PostgreSQL database and HTTPS endpoint.
- Permission from the people/organization whose meeting audio you process.
  Follow your organization's rules for external AI services.

In PowerShell, from this project directory:

```powershell
npm ci
npm start
```

For private development, the desktop app can use SAP credentials from a local
`.env`. For a managed release, run the API in `HOSTED_MODE=1` with PostgreSQL
and SAP credentials configured **only on that server**. Distribute the desktop
app with a separate `.env` containing only `MEETING_HELPER_API_URL=https://...`;
never distribute SAP credentials or `ADMIN_TOKEN`. Environment variables set
by the host take precedence over `.env`. No Gemini API key is used.

For a self-hosted API, the service creates PostgreSQL tables automatically. Set `HOSTED_MODE=1`,
`PORT`, `DATABASE_URL`, a random `ADMIN_TOKEN` of at least 32 characters, and
the SAP AI Core settings on the host. Require HTTPS at the public endpoint.
Build with `npm ci` and start with `npm run server`. The owner provisions an
account through `POST /api/admin/users`, and can immediately revoke it with
`PATCH /api/admin/users/{email}` using `{"active":false}`. Account expiry can be
set or cleared through the same endpoint using `{"expiresAt":"2027-01-01T00:00:00Z"}`
or `{"expiresAt":null}`. These admin routes require the private `X-Admin-Token`
header. User passwords must be at least 12 characters. Reset a user's password
with `PUT /api/admin/users/{email}/password` and `{"password":"new-long-password"}`;
this revokes all current sessions for that account. Accounts are provisioned
manually; this implementation does not charge users or integrate a payment
processor.

### Deploy the hosted API and database to Prisma

The Prisma deployment uses **Prisma Compute** for the API and **Prisma Postgres**
for account storage. Use Node.js 22.18+ (or 24.11+) and run `npm ci`,
`npm run check:compute`, and `npm run build:compute`; `npm ci` installs the Bun
build tool locally. The build bundles the API for Prisma's Bun runtime. This
project uses the existing `pg` client; Prisma ORM is not required.

The GitHub Actions workflow at `.github/workflows/prisma-deploy.yml` deploys
pushes to the default branch to production and other branches to previews using
OIDC; the repository must remain connected to the existing Prisma project
`meetinghelper`. Add these GitHub Actions variables: `PRISMA_REGION` (one of the
supported regions below), `SAP_AI_CORE_BASE_URL`, `SAP_AI_CORE_TOKEN_URI`, and
optionally `SAP_AI_CORE_DEPLOYMENT_ID`, `SAP_AI_CORE_MODEL`, and
`SAP_AI_CORE_RESOURCE_GROUP`. Add `ADMIN_TOKEN`, `SAP_AI_CORE_CLIENT_ID`, and
`SAP_AI_CORE_CLIENT_SECRET` as GitHub Actions secrets. The workflow passes
these settings to Prisma during deployment; it does not store their values in
the repository.

Set `SAP_AI_CORE_BASE_URL` and `SAP_AI_CORE_TOKEN_URI` in the PowerShell session
that runs the deployment. For example:

```powershell
$env:SAP_AI_CORE_BASE_URL = "https://your-sap-ai-core-host"
$env:SAP_AI_CORE_TOKEN_URI = "https://your-sap-identity-host/oauth/token"
```

Set `ADMIN_TOKEN`, `SAP_AI_CORE_CLIENT_ID`, and
`SAP_AI_CORE_CLIENT_SECRET` as production secrets in Prisma; never commit them
or put them in the desktop app's `.env`. Optional settings are
`SAP_AI_CORE_DEPLOYMENT_ID`, `SAP_AI_CORE_MODEL`, and
`SAP_AI_CORE_RESOURCE_GROUP`. Choose a supported Prisma region for the first
deployment (`us-east-1`, `us-west-1`, `eu-west-3`, `eu-central-1`,
`ap-northeast-1`, or `ap-southeast-1`), then run:

```powershell
npx prisma auth login
$env:PRISMA_REGION = "your-chosen-region"
npx prisma deploy
```

Prisma creates the PostgreSQL database and public HTTPS API URL. The API
initializes its account tables on startup. Put only that URL in the portable
desktop's `.env` as `MEETING_HELPER_API_URL=https://...`, then rebuild the
Windows executable. The API URL and Prisma deployment credentials are not
included in the executable.

Generate and set `ADMIN_TOKEN` as a private host secret (for example,
`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`).
Use the following PowerShell from the operator's computer to create an account
or disable it; keep the admin token private:

```powershell
$env:MEETING_HELPER_API_URL = "https://your-service.example"
$env:MEETING_HELPER_ADMIN_TOKEN = Read-Host "Admin token"
$email = Read-Host "User email"
$password = Read-Host "Temporary password"
$headers = @{ "X-Admin-Token" = $env:MEETING_HELPER_ADMIN_TOKEN }
Invoke-RestMethod "$env:MEETING_HELPER_API_URL/api/admin/users" -Method Post `
  -Headers $headers -ContentType "application/json" `
  -Body (@{ email = $email; password = $password } | ConvertTo-Json)
# Disable with curl.exe: the email can be passed normally, without URL encoding.
curl.exe -X PATCH "$env:MEETING_HELPER_API_URL/api/admin/users/$email" `
  -H "Content-Type: application/json" `
  -H "X-Admin-Token: $env:MEETING_HELPER_ADMIN_TOKEN" `
  --data-raw '{"active":false}'
```

The desktop app stores the session only in memory. The hosted API rechecks
account status on every request, so disabling or expiring an account denies
subsequent requests across all its sessions. Each request already in progress
may finish. `MEETING_HELPER_API_URL` must be HTTPS, except localhost for testing.
For a portable release, place `.env` beside the `.exe`; no environment variable
needs to be set manually. The app reads that file using the portable launcher
path or its working directory. For local SAP mode, put the SAP AI Core settings
there. For hosted mode, put only `MEETING_HELPER_API_URL` there. Existing
Windows environment variables take precedence over values in the file.
`npm run package:win` builds the portable executable.

Keep all service credentials secret and rotate any credentials that have been
shared or exposed. The `.env.example` file contains blank placeholders only.
If your corporate network uses Windows-managed certificate authorities and an
Electron download fails certificate validation, retry with
`$env:NODE_USE_SYSTEM_CA = "1"`. The desktop app enables the Windows/system
certificate store for its server by default unless explicitly configured otherwise.
Never disable TLS verification.

Click **Verify access** before recording. This authenticates with SAP OAuth,
checks the exact running model deployment, and sends two small, potentially
billable GenerateContent requests through SAP AI Core: a text prompt and a
locally generated one-second silent WAV. Both must succeed, and the audio response
must correctly report no speech. This verifies accepted audio input and a basic
transcription instruction, not transcription accuracy for every recording.
No meeting content is used for verification. Each explicit verification rechecks
the deployment and both capabilities.

If authentication, deployment, quota or transcription checks fail, the UI shows the error and
does not enable recording/chat. It never silently selects another model. Ask the
user before changing the server's `SAP_AI_CORE_MODEL` to a substitute. By default,
the first running deployment whose metadata exactly matches `gemini-3.5-flash`
is selected in the `default` resource group. Optional server settings can change
the resource group or pin a deployment; a pinned deployment's model must still
match exactly. The app does not create, change or start SAP deployments.

## Conversation and audio workflow

### Three-part workspace and quick controls

The app is organized into **Setup**, **Overlay**, and **Responses** tabs to keep
the main window focused. Setup contains access verification, optional resume,
consent, capture modes, and screen context. Overlay contains ghost mode and typing
speed. Responses contains live suggestions, transcript review, and chat. Starting
live suggestions, meeting audio, or voice automatically opens Responses.

The compact **Quick Controls** window opens alongside the app and stays available
above other windows. By default, both windows request capture exclusion. It shows
the section shortcuts and has buttons to switch sections, toggle ghost mode, show
or minimize the main window, and maximize or restore its size. The **Shortcuts**
button in the main window reopens it if hidden.
The Quick Controls window stays interactive when the main window is click-through.
Both windows request Windows capture exclusion; this is not guaranteed in every
sharing mode.

Use **Ctrl+Alt+1**, **Ctrl+Alt+2**, or **Ctrl+Alt+3** to switch sections.
**Ctrl+Alt+G** toggles ghost mode, and **Ctrl+Alt+Space** restores the main window
to full-opacity interactive mode. If a global shortcut is already in use, the
Quick Controls window indicates that it is unavailable and its buttons remain
usable. Its ghost toggle can also restore the main window to interactive mode.

The **Screen-share visibility** control in Overlay and Quick Controls toggles
Windows capture exclusion for both Meeting Helper windows. **Ctrl+Alt+V** toggles
the same setting; if unavailable, use either button. The label reports whether
exclusion is requested or off, not whether the sharing application honored it.
Exclusion is requested by default when the app starts. Use the visible setting
when you intentionally want the helper included in a screen share.

### Click-through ghost overlay

Click **Enable ghost mode** to keep Meeting Helper above your other apps while
working in the window underneath. The **Ghost opacity** slider sets 20-90%
opacity (default 60%; lower means more transparent). In ghost mode, mouse clicks
pass through and Meeting Helper does not take keyboard focus. Live listening
and replies continue; ghost mode does not start recording on its own.

**Ctrl+Alt+G** toggles ghost mode. **Ctrl+Alt+Space**, clicking the tray icon, or
**Show Meeting Helper** in the tray always exits ghost mode and restores
full-opacity, clickable controls. The Quick Controls window's ghost toggle also
restores interaction and stays clickable while the main app is click-through.
The tray also has **Toggle ghost mode** and **Show Quick Controls**.
If Ctrl+Alt+G is unavailable, the status text says so. Ghost mode is blocked if
no recovery shortcut or tray is available. Startup is always interactive;
opacity is remembered only for the current app session.

Transparency does not provide additional screen-sharing protection. Windows
capture exclusion can be turned off from the Screen-share visibility control or
**Ctrl+Alt+V**; neither exclusion nor visibility is guaranteed in every sharing
mode. Share a specific other app window and verify from a second device.

### Paste a suggested reply into an editor

Each chat reply and live suggestion has **Paste reply into active editor** and
**Type reply into active editor** buttons. Paste prepares Ctrl+V on
**Ctrl+Alt+Shift+V**. Type simulates Unicode keyboard input on
**Ctrl+Alt+Shift+T** with varied, human-paced delays; it asks for confirmation
first and longer replies take longer to enter. Click either button, focus the
editor where the reply belongs, then press its shortcut within 60 seconds.
Meeting Helper hides after preparing the action. Both shortcuts act on whichever
field has focus, so verify the destination before pressing one. Restore Meeting
Helper with **Ctrl+Alt+Space** to cancel. The reply remains on the clipboard if
the shortcut is unavailable or expires.

Use the **Typing speed** slider near the top of the app to select **10-150 WPM**.
The default is **40 WPM**, substantially slower than the previous fixed speed.
WPM is approximate, based on five characters per word. Character timing varies,
with longer pauses at spaces, punctuation and line breaks; the pauses are scaled
to the selected average speed. Your selection is saved locally and applies when
you next click **Type reply**, for both chat and live replies. Re-prepare a pending
reply to change its speed. Paste speed is unchanged.

Keep that editor focused and avoid typing manually until the reply finishes.
Press **Escape** to stop; changing windows
also stops typing. If insertion fails, Meeting Helper returns with a visible error.
Review any partially entered text before retrying or pasting the full reply.

### Optional resume persona

Before starting live suggestions, upload a text-based PDF, DOCX or UTF-8 TXT in
**Optional resume persona** (maximum 2 MiB / 24,000 extracted characters).
Text extraction is local; scanned PDFs need OCR first. The extracted text is
included with each chat/live request through SAP AI Core. Suggestions use first
person and resume-supported experience, with instructions not to invent missing
qualifications, projects or achievements. Always review the result.
The resume is kept only in memory until **Clear resume** or app exit; **New chat**
retains it for your next conversation. Clear it and start New chat to remove old
persona context. Upload/clear is disabled while capturing or processing audio.

### Automatic live suggestions

After **Verify access**, check the permission checkbox and click **Start live
suggestions**. Confirm that unapproved audio may be processed automatically.
Keep the meeting playing through your Windows output device. The dedicated live
panel displays heard speech and suggested replies without Stop, transcript approval
or Send. It does not post messages to the meeting, speak, or add messages to your
approval-based chat.

Choose **When to answer** before starting: **After 2 seconds of silence** (default)
or **Only when I click Send audio**. Manual mode records locally without automatic
requests, even through pauses. **Send audio** submits the current turn and keeps
listening for the next one. **Stop** discards the current unsent manual turn;
previously submitted turns still finish. Turns exceeding 6 MiB stop capture with
an explicit error and are discarded; send shorter turns to avoid this limit.

Live mode monitors captured audio level and sends a speech segment only after
**2 seconds of silence** following detected audio, so the reply is not requested
at a fixed interval while someone is still speaking. Each segment uses a single
SAP AI Core Gemini request for both transcription and a suggested answer, rather
than separate transcription/chat round trips. Speech segments can be as long as
the speaker's turn; prolonged silence is discarded locally. This is
low-latency, turn-based inference, **not word-by-word streaming or instant answers**:
the two-second silence wait plus SAP/model/network processing determines actual
delay. Background audio above the activity threshold can postpone the reply.
The panel reports processing time and the time of the latest suggested reply.
Silence or incomplete speech may produce no new suggestion; the last reply stays
visible with its timestamp.

Only the latest six completed segment/reply pairs (at most 12,000 characters)
are sent as rolling context; older pairs are removed from live context. A new
live session resets this context. Audio buffering is bounded to three clips.
If the provider cannot keep up or a request fails, capture stops with an explicit
error rather than silently dropping audio. Retry retains the failed clip and
context; **Stop** ends capture but finishes already recorded clips. **New chat**
clears the live panel and context after processing has stopped. More frequent
requests may increase cost. No live content is persisted by the application.

### Screen context (ask about what is on your screen)

1. In **Screen context**, click **Choose screen or window** and pick a screen or
   app window from the thumbnails. Meeting Helper's own window is excluded.
2. With **Include a fresh snapshot** checked, every chat message you send captures
   the chosen screen or window at that moment and sends it with your question.
   For example, ask "What does this error mean?" or "What should I say about this
   slide?" The **Explain my screen** suggestion fills in a ready-made prompt.
3. Uncheck **Include** to pause it, or click **Stop screen access** to turn it off.

Snapshots are taken only when you send a message, never continuously or in live
mode. They are resized to at most 1600 px wide JPEG and sent through SAP AI Core.
They are not stored, and only the latest message includes a screen image.
Minimized windows cannot be captured. The snapshot may include anything visible
in that screen or window, including notifications and other people's content.

### Approval-based chat (unchanged)

1. Verify model access and confirm that you have permission to transcribe.
2. Select **Start meeting audio** to capture Windows output in independent
   12-second clips, or **Record voice** for microphone input (maximum 30 seconds).
   Click **Stop** when finished.
3. Review and edit the transcription. Choose **Approve & use in message** to
   transfer it to the message editor. Nothing is submitted to chat automatically.
4. Edit or add your question and click **Send message** (or Ctrl+Enter).
   The Gemini deployment receives the approved text and completed chat history
   through SAP AI Core and suggests a reply. Errors preserve the editor; retry
   does not duplicate chat messages.

Meeting audio means **all sound on the captured Windows output**, including
notifications, other apps, and remote meeting participants. It is not scoped to
Teams/Zoom. It does not include your own microphone; record your voice separately.
Choose the correct output device in Windows and the meeting app, and avoid unrelated
audio. Output-device changes, exclusive audio modes and protected audio can prevent
capture. Microphone permission is controlled by Windows privacy settings.

Transcription is near-real-time, not word-by-word streaming: latency includes the
12-second clip and the Gemini request. Small gaps can occur when a recorder restarts.
If transcription cannot keep up, recording stops instead of buffering indefinitely.
Pending audio is retained in memory for retry, or can be explicitly discarded.
Silence is reported without adding a chat message.

The UI disables incompatible operations while recording, transcribing or generating.
Stop recording and wait for queued transcription before approving. Text input,
conversation history, loading states, and explicit retryable provider errors follow
the available reference project's prompt-to-answer pattern. The supplied reference
project contained backend sources, not a frontend, so this is a new desktop UI,
not a visual reproduction. Its backend is not contacted and its credential files
are not read. The new connection uses only this app's server environment.

## Screen sharing: important limitations

The Electron window is always on top and requests Windows capture exclusion with
`BrowserWindow.setContentProtection(true)` before it becomes visible.
This uses Windows display-affinity protection, not an absolute invisibility feature.
The UI deliberately says **exclusion requested**, not "protection verified."

If the assistant is minimized or behind another window, press **Ctrl+Alt+Space**
while Teams/Zoom has focus to restore and raise it. Alternatively, click the
Meeting Helper icon in the Windows notification area (possibly under **Show
hidden icons**), or right-click it and select **Show Meeting Helper**. The tray
menu also provides **Minimize** and **Quit Meeting Helper**. Restoring reapplies
capture exclusion and always-on-top before focusing the window. It does not
restart audio, reset chat, or change the shared surface.

Always-on-top alone does not unminimize a window, and the app does not detect
when Teams/Zoom starts sharing. If another application owns Ctrl+Alt+Space or
Windows refuses registration, a warning appears; use the tray/taskbar instead.
Closing the window or choosing Quit exits the app and releases its shortcut and
tray icon. Minimizing does not stop recording; use **Stop** to end capture.

For safer sharing, select a **specific other application window** in Teams or Zoom,
not your entire desktop and never Meeting Helper. Test from another participant's
device before a real meeting, including moving the overlay above the shared app.
Capture exclusion depends on the Windows version, meeting-app version and capture
path. Unsupported recorders, remote-desktop tools, external cameras, or sharing
the wrong surface may reveal the window or display a blank area. There is no
guarantee that the assistant will be invisible in every sharing mode.

Desktop capture temporarily requires a video track to obtain Windows loopback
audio. The app immediately stops that video track: screenshots/video are not
recorded or sent to SAP AI Core.

## Model and API verification sources

The server uses SAP AI Core's OAuth2 client-credentials flow and native
Gemini GenerateContent API, not the Gemini Developer API:

- SAP's [AI Core connection documentation](https://sap.github.io/ai-sdk/docs/js/connecting-to-ai-core)
  documents client credentials and the `/oauth/token` endpoint.
- SAP's [deployment API](https://github.com/SAP/ai-sdk-js/blob/main/packages/ai-api/src/client/AI_CORE_API/deployment-api.ts)
  and [model metadata extraction](https://github.com/SAP/ai-sdk-js/blob/main/packages/ai-api/src/utils/model.ts)
  document discovery and exact model identification.
- SAP's [native Gemini integration example](https://github.com/SAP-samples/sap-btp-ai-best-practices/blob/main/use-cases/video-incident-and-safety-monitoring/backend_odata_service.py)
  uses `/inference/deployments/{id}/models/{model}:generateContent`.
- Google's [Gemini 3.5 Flash model card](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/3-5-flash.md.txt)
  gives exact ID `gemini-3.5-flash`, text input/output, audio input, and transcription
  support through GenerateContent. It does **not** support the Gemini Live API.
- Google's [audio understanding documentation](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/audio-understanding)
  lists supported audio formats and transcription capabilities.

During the SAP integration update, the configured server credentials successfully
authenticated, and a running `gemini-3.5-flash` deployment was found in the default
resource group. Live text, silent-WAV verification, and transcription of locally
synthesized speech succeeded through the authenticated local API and SAP AI Core.
The recognized synthetic sentence also produced a chat reply. Only constant prompts
and generated audio were used, not real meeting content. Credentials, access
tokens, private URLs and deployment IDs were not
copied into source code or documentation. The app rechecks access at runtime.

## Server settings and data handling

| Variable | Required | Meaning |
|---|---|---|
| `SAP_AI_CORE_BASE_URL` | Yes | SAP AI Core API root or versioned API base ending in `/v2`. Root URLs get `/v2` appended. HTTPS only. |
| `SAP_AI_CORE_CLIENT_ID` | Yes | OAuth client ID, read only by the server integration. |
| `SAP_AI_CORE_CLIENT_SECRET` | Yes | OAuth client secret, never exposed in renderer code or logs. |
| `SAP_AI_CORE_TOKEN_URI` | Yes | Full HTTPS OAuth token endpoint, including `/oauth/token`. |
| `SAP_AI_CORE_RESOURCE_GROUP` | No | Defaults to `default`. Sent as the `AI-Resource-Group` header. |
| `SAP_AI_CORE_MODEL` | No | Exact Gemini model ID. Defaults to `gemini-3.5-flash`, used for text and audio. |
| `SAP_AI_CORE_DEPLOYMENT_ID` | No | Pin a running deployment; metadata must match the requested model. |
| `SERVER_TOKEN` | Standalone server only | At least 32 characters. The desktop app generates its own random per-launch token. |

OAuth access tokens are cached only in server memory and refreshed before expiry.
A rejected token (HTTP 401) triggers at most one refresh/retry. Permission failures
(403), rate limits, invalid requests and other inference failures are not retried
automatically. Requests have timeouts, redirects are rejected, and TLS validation
stays enabled. Discovery is paginated up to 1,000 deployments. Inference URLs are
built from the configured API base and verified deployment ID, not arbitrary URLs
returned in deployment metadata.

`npm start` starts an isolated Node server bound to a random port on `127.0.0.1`.
The renderer has no Node integration or network access. A limited preload bridge
sends permitted requests through the Electron main process, which authenticates
them to the server. Neither the SAP credentials, SAP OAuth token, nor local-server
token is exposed to renderer code. Arbitrary navigation, popups and non-audio
permissions are denied.

The local server supports authenticated `GET /api/status`, `POST /api/verify`,
`POST /api/chat` (`history: [{role: "user" | "model", text}]`) and
`POST /api/transcribe` (`data`: base64 audio, `mimeType`: supported audio MIME).
The opt-in live route is `POST /api/live` with the same audio fields and
`history: []` or up to six alternating, completed user/model context pairs.
Chat and live requests accept optional `resume` text (at most 24,000 characters).
Live returns `{transcript, answer}`; an empty answer means no new suggestion.
Chat also accepts optional `screen: {data, mimeType}` (base64 JPEG/PNG, at most 4 MiB).
Errors use `{error, code, provider: "sap-ai-core", retryable}`. One AI request runs at a time.
Requests and history have bounded sizes; audio clips are limited to 6 MiB.

`npm run server` can start just the API, with `SERVER_TOKEN` supplied by the
administrator; it prints its loopback port. This is a local single-user app,
**not** an internet-deployable multi-user server.

Audio, transcripts and chat history are not written to application storage.
Completed chat history stays in the renderer's memory until **New chat** or exit.
Audio clips stay in memory while transcribing/retrying and are released when
processed, discarded or the app exits. The server logs error classifications,
not content, raw provider diagnostics or credentials. Audio, approved messages
and completed history are sent through SAP AI Core to the configured Gemini
provider for transcription/generation. SAP's and the model provider's processing,
retention and usage policies depend on your enterprise agreement and service terms.
Local OS administrators and privileged processes are outside this isolation model.

## Checks and packaging

```powershell
npm run check
npm test
npm run test:ui
npm run test:overlay
npm run package:win
# Optional live check: uses SAP environment credentials and two small model requests.
$env:NODE_USE_SYSTEM_CA = "1"
npm run verify:sap
```

Automated tests cover successful and failed SAP OAuth/discovery/text/transcription
requests using a stubbed transport, exact-model selection, pinned deployments,
pagination, token caching/refresh, timeouts, TLS errors, no fallback, input limits,
blocked/empty responses, retry behavior, and chat history.
The desktop smoke check strips SAP and Gemini settings from the server environment,
starts a real isolated unconfigured server,
verifies renderer isolation/topmost state, then uses test-only IPC responses and
synthetic audio to exercise permission denial, transcription retry, transcript
editing/approval, safe text rendering and conversation retry/history. It also
checks automatic live suggestions after the two-second silence window,
explicit live consent, live retry/context, and stopping capture on errors.
It also triggers the real Windows typing shortcut in a disposable test editor,
checks Unicode, line breaks and human-paced delays, and verifies that insertion
failures are brought into view. It checks speed preference persistence, forwarding
to chat/live typing actions, and measured typing rates at slow and fast settings.
The Windows unit tests compile and run the actual
typing helper with empty input so compilation failures cannot pass unnoticed.
`test:overlay` checks the overlay controls, opacity limits, native Windows
click-through/non-activation flags and recovery without injecting keyboard input.
`npm test` and `npm run test:ui` do not contact SAP/Google or record a real microphone.
`npm run verify:sap` is an explicit live check and may incur model charges.

`package:win` creates a portable executable in `release`. Distribution builds are
unsigned; configure signing separately before broader deployment. The existing
`src\Main.java` starter is preserved and is unrelated to the desktop application.
Launch the portable app from the same PowerShell session with the environment
variables set:

```powershell
& ".\release\Meeting Helper 1.4.5.exe"
```

Manual acceptance checks still required: permissions for your deployment, speech
accuracy, Windows microphone/output devices, and Teams/Zoom sharing from a second
participant's device. In particular, automated checks cannot establish that a
particular meeting capture path will honor exclusion.
