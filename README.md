# AI Receptionist

A self-hosted AI phone receptionist for a small business. Callers reach
an AI assistant that answers from a fixed knowledge base you control —
hours, locations, prices, policies — and:

- **During business hours:** it can **warm-transfer** to the owner —
  caller on hold, owner called with a spoken whisper summary, press 1
  to join the call.
- **Outside business hours:** it takes a message (name, callback number,
  question) and does **not** transfer.
- **After every call:** the owner gets an **SMS summary** on their
  personal mobile.

The AI only quotes facts from `knowledge-base.md`. If a caller asks
about something not in that file, it says so and offers to take a
message — it never invents an address, price, or policy.

## Features

- Twilio ConversationRelay answers the call: Twilio handles speech
  recognition and text-to-speech; this server handles the conversation.
- Text LLM (Gemini by default, OpenAI as a fallback) answers from your
  knowledge base, with two tools: warm transfer and message taking.
- Conference-based warm transfer with a whisper summary ("Caller …
  asking about … Press 1 to accept"), a press-2 decline path, and a
  no-answer fallback to voicemail with transcription — the caller is
  never left in hold music.
- SMS summary after every call: time, caller number, name if given,
  what it was about, outcome, and callback number. Sent once per call.
- Transfer loop guard: the server refuses to transfer a call to a
  number that forwards back to Twilio (see "The transfer loop warning").
- Detailed LLM error logging: every failed model call logs the status,
  error code, and response body, so a provider failure is diagnosable
  from the server logs.

## Contents

- `server.js` — the whole service (Express + WebSocket, Twilio +
  Gemini by default, OpenAI as fallback)
- `package.json`, `Dockerfile`, `railway.json` — run / deploy
- `prompts/system-prompt.md` — the receptionist's instructions (template)
- `knowledge-base.md` — the only facts the AI may quote (template — edit
  this, not code)
- `.env.example` — every setting, with placeholders only (never real
  secrets)
- `test-plan.md` — 6 test calls to run before going live

## Architecture

```
Caller dials the business line (or the Twilio number directly)
        │
        │  optional: *72 unconditional forwarding from the
        │  business line to the Twilio number (see below)
        ▼
Twilio phone number ── Voice webhook POST /voice
        │
        │  <Connect><ConversationRelay> to wss://<server>/relay
        ▼
This server (Node.js, Express + WebSocket)
        │  ConversationRelay sends transcribed caller speech as text,
        │  speaks back the text this server returns.
        ▼
Text LLM (Gemini 3.5 Flash-Lite by default, via Google's
OpenAI-compatible endpoint; OpenAI gpt-4o-mini fallback)
        │
        ├─ Question answerable from knowledge-base.md → AI answers
        │   → caller hangs up → SMS summary to the owner
        │
        ├─ Business hours + caller wants the owner / refund / complaint
        │   → AI ends the Relay session with handoff {action: transfer}
        │   → POST /connect-action → caller into a Conference (hold music)
        │   → Twilio calls TRANSFER_NUMBER, plays the whisper summary
        │   → Owner presses 1 → joins the conference, talks to the caller
        │   → Owner presses 2 / no answer in ~25s → caller is redirected
        │     to /take-message (voicemail with transcription)
        │   → SMS summary to the owner either way
        │
        └─ Outside business hours (or transfer refused)
            → AI takes a message, ends with handoff {action: message}
            → SMS summary to the owner
```

### What was chosen and why

- **Twilio ConversationRelay + a text LLM.** ConversationRelay
  ($0.07/min) transcribes the caller, sends the text to this server
  over a WebSocket, and speaks back the text returned. The server only
  does conversation logic: it calls the LLM, decides transfer vs.
  message, and drives the warm transfer through Twilio's Conference
  API.
- A text model is the correct pairing: ConversationRelay exchanges
  **text**, so the LLM must be a text model. A speech-to-speech model
  such as `gpt-realtime-mini` cannot plug into that text loop — it
  would need raw-audio Media Streams instead, at roughly $0.06/min in
  + $0.24/min out, about 2× the cost of this whole stack, plus custom
  8 kHz audio handling. Gemini 3.5 Flash-Lite answers a short
  receptionist question in well under a second, so the server uses a
  non-streaming chat completion and sends the reply to Twilio in
  sentence chunks. Streaming token-by-token can be added later; it is
  not needed at small-business call volume.
- Gemini runs through Google's OpenAI-compatible endpoint
  (`https://generativelanguage.googleapis.com/v1beta/openai/`), so the
  same OpenAI SDK code drives either provider — only the base URL, key,
  and model name change. Tool calling through that endpoint is
  limited/beta, so the server also parses a JSON fallback from the
  model text (`{"action":"transfer_to_owner",...}` /
  `{"action":"take_message",...}`) and treats it as a tool call. Test
  the transfer tool specifically before going live (see test-plan).
- **LiveKit Agents + Twilio SIP was considered and rejected.** It adds
  a SIP trunk, a second real-time service, and SIP REFER transfer
  handling — all harder to test with one phone line and one owner, for
  no benefit at this volume. If call volume grows past ~2,000
  min/month, re-evaluate: a STT+LLM+TTS pipeline on LiveKit would then
  be cheaper per minute than ConversationRelay.
- **No serverless.** The ConversationRelay WebSocket needs a
  long-running server, so the service runs on Railway (see deploy
  steps) with a Dockerfile for Render / Fly.io.

## Prerequisites

- Node.js 20+ (for local runs and testing).
- A Twilio account with a payment method, and a Twilio phone number
  (see step 1). A trial account works for testing with the limits in
  "Trial-account limits" below.
- A Gemini API key (free at aistudio.google.com/apikey), or an OpenAI
  API key if you prefer the OpenAI fallback.
- A Railway account (or another host that runs a long-running Node.js
  server) and a GitHub account, for the deployment path below.
- Two phone numbers you control: the public business line callers dial,
  and a direct personal mobile for warm transfers and SMS summaries.
  They may be on one dual-SIM handset — see "The transfer loop warning".

## Deployment — step by step

### 1. Twilio account, phone number, and AI Features Addendum

1. Create an account at twilio.com and add a payment method
   (pay-as-you-go). The trial credit is enough to test, but a paid
   account is needed to receive forwarded calls from unverified
   numbers and to send SMS without trial restrictions.
2. In the Twilio Console, accept the **ConversationRelay / AI Features
   Addendum** (Console → Voice → ConversationRelay onboarding, or
   Voice → Settings → General). The Relay will not connect until this
   is accepted.
3. Buy a phone number: Phone Numbers → Buy a number, in your area
   code. A US local number is ~$1.15/month. This is the number the AI
   answers — it is a **new** number, not your existing business line.
4. On that number, set the Voice webhook (you will fill in the URL
   after deploying in step 4, but set it now if the server is already
   up):
   - **A call comes in:** Webhook, `https://<your-domain>/voice`,
     HTTP POST.
   - Leave the other webhooks blank; the server drives the rest from
     the TwiML it returns.

### 2. Gemini API key

1. Go to aistudio.google.com/apikey and create an API key (Google
   account, no card needed for the free tier). The key belongs to a
   Google Cloud project; the Generative Language API ("Gemini API")
   must be enabled in that project (AI Studio enables it when the key
   is created).
2. Copy the key into your deployment's environment variables as
   `GEMINI_API_KEY` (step 4). Never paste keys into chat, and never
   commit them to the repo.

### 3. Fill in the templates

1. Edit `knowledge-base.md`: replace every `[BRACKETED PLACEHOLDER]`
   with a real fact, delete sections that do not apply, and delete or
   replace the fictional EXAMPLE block. The AI may only quote what is
   in this file.
2. Edit `prompts/system-prompt.md`: replace the placeholders with your
   business name, description, language, and any special handling
   notes.
3. Copy `.env.example` to `.env` for local runs and fill in real
   values. For Railway, set the same variables in the dashboard
   (step 4) — do not commit `.env`.

### 4. Deploy to Railway from GitHub

1. Create a **private** GitHub repo and push this project to it
   (`.gitignore` already excludes `node_modules/`, `.env`, and logs).
2. In Railway, create a new project → Deploy from GitHub → select the
   repo. Railway builds with `railway.json` (Nixpacks) and starts the
   service with `node server.js`.
3. Generate a public domain for the service (Railway → service →
   Settings → Networking → Generate Domain), e.g.
   `https://<your-app>.up.railway.app`.
4. Set every variable from the table below in Railway → service →
   Variables. Then redeploy.
5. Check `https://<your-domain>/health` returns `"ok": true` and
   `"transferAvailableNow"` matches the time of day. `GET /health`
   shows which pieces are configured (`configured: {...}`) without
   revealing secrets.

Local smoke test before deploying:

```bash
npm install
npm start          # http://localhost:3000/health
```

Local testing with a real call: `ngrok http 3000`, set `PUBLIC_URL`
to the ngrok `https://…` URL, and use that as the Twilio webhook. Do
not use `localhost` as `PUBLIC_URL` — Twilio cannot reach it.

### 5. Environment variables

| Variable | Required | Description |
|---|---|---|
| `PUBLIC_URL` | Yes | Public URL of this server, no trailing slash (e.g. `https://<your-app>.up.railway.app`). Used to build the `wss://` Relay URL and all TwiML action URLs. Must match the deployed domain. |
| `BUSINESS_NAME` | Yes | Business name spoken in the greeting, the transfer whisper, and SMS summaries. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | Yes | From twilio.com/console. |
| `TWILIO_NUMBER` | Yes | The Twilio number the AI answers, E.164 (`+1` + 10 digits). |
| `BUSINESS_NUMBER` | Only if forwarding | Your existing public business line, E.164. Used ONLY as a loop guard — the server refuses to transfer to it while it forwards to Twilio. Leave blank if callers dial the Twilio number directly. |
| `PERSONAL_MOBILE` | Yes | Owner's personal mobile, E.164. SMS summaries go here; warm transfer defaults here. |
| `TRANSFER_NUMBER` | No (defaults to `PERSONAL_MOBILE`) | Warm-transfer target, E.164. Must be a DIRECT number that does NOT forward to Twilio — see the loop warning. |
| `LLM_PROVIDER` | No (default `gemini`) | `gemini` or `openai`. |
| `GEMINI_API_KEY` | Yes if `gemini` | Free at aistudio.google.com/apikey. |
| `GEMINI_MODEL` | No (default `gemini-3.5-flash-lite`) | Do not set `gemini-2.5-flash` — see Troubleshooting. |
| `GEMINI_BASE_URL` | No | Gemini OpenAI-compatible endpoint. Do not change unless Google moves it. |
| `OPENAI_API_KEY` | Yes if `openai` | From platform.openai.com/api-keys. |
| `OPENAI_MODEL` | No (default `gpt-4o-mini`) | Text model for the OpenAI fallback. |
| `BUSINESS_HOURS_START` / `BUSINESS_HOURS_END` | No (default `08:00` / `17:00`) | Warm-transfer window, 24-hour HH:MM in `TIMEZONE`. Outside it: message only. |
| `TIMEZONE` | No (default `America/New_York`) | IANA timezone name; daylight saving is handled. |
| `TRANSFER_TIMEOUT_SECONDS` | No (default `25`) | Seconds to wait for the owner to press 1 before falling back to a message. |
| `WHISPER_TIMEOUT_SECONDS` | No (default `10`) | Seconds the owner has to press 1 after the whisper. |
| `PORT` | No (default `3000`) | Railway sets this automatically. |

### 6. Optional: forward your existing business line to the AI (*72)

If callers already know your business number and you want the AI to
answer it without porting the number:

1. From the **business line**, dial **`*72` + the Twilio number**,
   wait for the confirmation tone / message, then hang up.
   Forwarding is now on: every call to the business line goes to
   Twilio. (These are the standard US unconditional-forwarding codes;
   verify them with your carrier — some carriers use a different
   method or an app setting.)
2. Test: from a **different** phone, call the business line. The AI
   should answer. Check the server logs for `[voice] inbound` and
   `[relay] setup`, and check that the SMS summary arrives.
3. Run the 6 calls in `test-plan.md` before telling callers anything.
4. To undo at any time, from the business line dial **`*73`** and wait
   for confirmation. Forwarding off = calls ring the carrier line as
   before. The Twilio number keeps working on its own.

While forwarding is on, **do not** set `TRANSFER_NUMBER` to the
business number — see the loop warning below. The server will refuse
it and take a message instead.

## The transfer loop warning

**The transfer target must be a direct number that does NOT forward
to Twilio.** If the business line forwards unconditionally (`*72`) to
the Twilio number, and the AI warm-transfers by dialling that same
business line, the carrier forwards the call straight back to Twilio
and the owner never rings — an infinite loop:

```
Caller dials the business line (carrier)
  → Carrier *72 forwards unconditionally to the Twilio number
  → Twilio AI answers
  → AI warm-transfers by dialling the business line
  → Carrier *72 forwards it straight back to Twilio
  → Twilio AI answers again … (owner never rings)
```

The server guards against this: `TRANSFER_NUMBER` is checked at
startup and again on every transfer request. If it is `BUSINESS_NUMBER`
or the Twilio number itself, warm transfer is disabled and the AI
takes a message instead (the refusal is logged).

The intended setup is a **direct** transfer target — in practice the
owner's personal mobile (`PERSONAL_MOBILE`). If both lines are on one
dual-SIM handset, transferring to the personal number still rings the
same device the owner carries, with no loop — because only the
business line forwards to Twilio, and the personal line never does.
If the personal line ever got `*72` forwarding to Twilio as well, the
loop would return; do not forward the personal line.

If the transfer must ring the business number itself, there are only
two clean ways — both are real changes, not config tweaks:

| Option | What changes | Tradeoff |
|---|---|---|
| **(a) Port the business number to Twilio** | Twilio owns the number; the AI answers it directly, no forwarding. Transfer then goes to the personal mobile. | Porting takes days, needs carrier account / PIN / authorisation, and the number leaves the carrier. Cleanest long-term setup, but it is a port, not a setting. |
| **(b) Drop unconditional forwarding** | Publish the Twilio number as the number the AI answers, or use *conditional* forwarding (busy / no-answer only) from the business line to Twilio. Then the business line is a real, answerable number again and Twilio can dial it. | Callers must learn a new number, or the AI only answers when the business line is busy/unanswered. |

Do **not** present unconditional forwarding + transfer-to-the-same-number
as a working combination. It is not.

## Cost

Approximate monthly costs, at November 2026 list prices. All totals
are **approximate** — check current Twilio, Google, and Railway
pricing before budgeting. Assumptions follow the estimation method
below: each example assumes no transfers (transfers add very little —
see below), ~3.3 minutes per call, and ~2 SMS segments per summary.

Rates used: Twilio local number $1.15/mo; inbound calls $0.0085/min;
outbound calls $0.014/min; ConversationRelay $0.07/min; Gemini 3.5
Flash-Lite $0.30/1M input tokens, $2.50/1M output tokens; Railway
Hobby $5/mo including $5 usage credit. SMS segments (~$0.0083 each)
and conference time (~$0.0018/participant/min) are Twilio list prices
at the same date, included so the estimates cover the whole call.

Gemini estimate: each call is assumed to use ~5,000 input tokens
(system prompt + knowledge base + conversation history) and ~300
output tokens (short spoken replies): 5,000 × $0.30/1M + 300 ×
$2.50/1M ≈ $0.0023 per call. On Gemini's free tier the LLM cost is $0.

**100 minutes/month (~30 calls, no transfers): ~$15/mo**

| Line | Calculation | Cost |
|---|---|---|
| Twilio number | 1 × $1.15 | $1.15 |
| Inbound minutes | 100 × $0.0085 | $0.85 |
| ConversationRelay | 100 × $0.07 | $7.00 |
| Gemini 3.5 Flash-Lite | ~30 calls × ~$0.0023 | ~$0.07 ($0 on free tier) |
| SMS summaries | 30 × ~2 segments × $0.0083 | ~$0.50 |
| Railway server | Hobby | ~$5.00 |
| **Total** | | **~$14.60** |

**500 minutes/month (~150 calls, no transfers): ~$48/mo**

| Line | Calculation | Cost |
|---|---|---|
| Twilio number | 1 × $1.15 | $1.15 |
| Inbound minutes | 500 × $0.0085 | $4.25 |
| ConversationRelay | 500 × $0.07 | $35.00 |
| Gemini 3.5 Flash-Lite | ~150 calls × ~$0.0023 | ~$0.34 ($0 on free tier) |
| SMS summaries | 150 × ~2 segments × $0.0083 | ~$2.50 |
| Railway server | Hobby | ~$5.00 |
| **Total** | | **~$48.25** |

Transfers add very little: a 5-minute transferred call adds one
outbound leg (5 × $0.014 = $0.07) plus conference time
(2 participants × 5 min × $0.0018 ≈ $0.02) — about $0.09 per
transfer.

## Trial-account limits (Twilio)

If the Twilio account is still on trial, these limits apply until the
account is upgraded and the verifications below are complete:

- **Verified Caller IDs required.** A trial account can only place
  calls to, send SMS to, and (for inbound calls to a Twilio number)
  accept calls from numbers verified as Caller IDs in the Console
  (Phone Numbers → Verified Caller IDs). An unverified caller is
  rejected before the webhook fires, and an SMS to an unverified
  number fails. Verify every number involved in testing — including
  the owner's personal mobile — before running the test plan.
- **Toll-free verification required for SMS.** A toll-free Twilio
  number cannot deliver SMS to US/Canadian mobile subscribers until
  its Toll-Free Verification is approved. Until then, Twilio accepts
  the message but it stays Undelivered. Start the verification early;
  approval can take days. Voice calls are not affected by this.
- **Emergency address.** Twilio warns that a number without a
  registered emergency address may incur a charge (shown as $75.00)
  if an emergency call is placed from it. Register an emergency
  address on the number in the Console.

## Testing

Run the 6 calls in `test-plan.md` before going live: price question,
address question, warm transfer in hours, after-hours message,
no-answer transfer fallback, and an unknown question the AI must not
invent an answer to. Test 0 checks the transfer loop guard without a
call. Keep the server logs open while testing — every step logs
`[voice]`, `[relay]`, `[llm]`, `[transfer]`, `[sms]` with the call SID.

## Editing facts

Edit `knowledge-base.md` for prices, dates, locations, and policies,
and `prompts/system-prompt.md` for behaviour. Restart the server
after editing — both files are loaded at startup. Do not edit facts
in `server.js`; the code only reads the two files.

## Limitations

- In-memory call sessions only: a server restart drops in-flight
  calls. Call history is not stored (only the SMS summary is sent).
- No CRM / booking-system lookup: the AI cannot check whether a
  caller is already registered or hold a spot. Those requests go to
  the owner.
- English only, as configured. The Relay is configured `en-US`;
  change `language` in the `/voice` handler and the system prompt to
  localise.
- No call recording beyond Twilio's voicemail transcription on the
  fallback path. If recording is wanted, add it on the Twilio number
  (note: tell callers calls may be recorded).
- One concurrent warm transfer at a time is fine; several simultaneous
  callers each get their own conference (named per call SID).

## Troubleshooting

- `GET /health` shows which pieces are configured (`configured: {...}`)
  without revealing secrets. If `transferNumber` is false, check
  `TRANSFER_NUMBER` / the loop guard.
- **AI connects but never answers, and the log shows
  `[llm] FAILED … error=404 status code (no body)`:** the model name
  is the likely cause. Google restricted `gemini-2.5-flash` on
  September 18, 2026 to projects that had already actively used it,
  so new projects calling it get a bare HTTP 404 with no error body
  — the key, the endpoint, and the API being enabled all look fine,
  and the request still fails. Google deprecated `gemini-2.5-flash`
  and `gemini-2.5-pro` on November 2, 2026, and from December 1, 2026
  requests to `gemini-2.5-flash` are automatically routed to
  `gemini-3.5-flash-lite`. Fix: set `GEMINI_MODEL` to
  `gemini-3.5-flash-lite` (the default in this project) and redeploy.
  The detailed `[llm] FAILED` log line records the provider, model,
  status, and any error body, which is what distinguishes this
  failure from a bad key (which returns an error body).
- No answer on the Twilio number: check the Voice webhook is
  `https://<domain>/voice` (POST), `PUBLIC_URL` matches the domain,
  and the ConversationRelay AI Addendum is accepted in Twilio.
- AI answers but never transfers: check the time is inside the
  configured business hours (`/health` → `transferAvailableNow`),
  and `TRANSFER_NUMBER` is set to a direct number.
- No SMS: check `PERSONAL_MOBILE` is E.164 (`+1` + 10 digits), the
  Twilio account can send SMS (paid account, or trial with the
  recipient number verified), and — for a toll-free number — that
  toll-free verification is approved (see "Trial-account limits").
- Calls from a number fail before the greeting on a trial account:
  verify that number as a Caller ID in the Twilio Console.
- Server logs: every step logs `[voice]`, `[relay]`, `[llm]`,
  `[transfer]`, `[sms]` with the call SID.
