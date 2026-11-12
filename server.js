/**
 * AI Receptionist
 * ===============
 * A self-hosted AI phone receptionist for a small business. Callers
 * reach an AI assistant that answers from a fixed knowledge base
 * (knowledge-base.md), warm-transfers to the owner during business
 * hours, takes messages outside them, and sends an SMS summary after
 * every call.
 *
 * Website chat: POST /chat + GET /widget.js reuse the same LLM,
 * knowledge base, and take_message flow for a chat widget embedded on
 * the business website. Chat uses its own system prompt
 * (prompts/chat-system-prompt.md) because web chat may quote links and
 * has no phone transfer. See the "Website chat" section below.
 *
 * Stack: Twilio ConversationRelay (Twilio does STT + TTS, $0.07/min)
 *        + Gemini gemini-3.5-flash-lite (text LLM, via Google's
 *          OpenAI-compatible endpoint; $0.30 / 1M input tokens,
 *          $2.50 / 1M output tokens). OpenAI gpt-4o-mini remains
 *          supported as a fallback via LLM_PROVIDER=openai.
 *        + Twilio Programmable Voice for the phone number, SMS, and
 *          Conference-based warm transfer.
 *
 * Why gemini-3.5-flash-lite and not gemini-2.5-flash: in September
 * 2026 Google restricted the 2.5 models to projects that had already
 * actively used them, so new projects calling gemini-2.5-flash get a
 * bare HTTP 404 with no error body; Google deprecated 2.5-flash on
 * November 2, 2026 and routes its requests to gemini-3.5-flash-lite
 * from December 1, 2026. See README "Troubleshooting".
 *
 * Why this stack (and not gpt-realtime-mini / LiveKit):
 * ConversationRelay exchanges TEXT with this server — Twilio transcribes
 * the caller and speaks the text we send back. A speech-to-speech model
 * such as gpt-realtime-mini cannot plug into that text loop; it would
 * need raw-audio Media Streams instead, at ~$0.06/min in + $0.24/min
 * out, roughly 2x the cost of this whole stack, plus custom audio
 * handling. A text model (Gemini 3.5 Flash-Lite by default) is the correct,
 * cheapest pairing for ConversationRelay, and it is fast enough for
 * short receptionist replies on a paid-tier key (<1s for a typical
 * answer; the free tier measured 5–12s — see the billing note below
 * and README "Latency"). LiveKit Agents
 * + Twilio SIP was considered and rejected: it adds a SIP trunk, a
 * second real-time service, and SIP REFER transfer handling, all of
 * which are harder to test with one phone line and one owner.
 *
 * Gemini note: Google's OpenAI-compatible endpoint
 * (https://generativelanguage.googleapis.com/v1beta/openai/) accepts
 * the same chat.completions shape as OpenAI, so the same code drives
 * either provider. Tool calling through that endpoint is limited/beta,
 * so askLLM() also parses a JSON fallback from the model text
 * ({"action":"transfer_to_owner","reason":"..."} or
 * {"action":"take_message",...}) — see parseToolCallFromText().
 *
 * Call flow:
 *   1. Caller dials the Twilio number — directly, or via unconditional
 *      call forwarding (*72) from an existing business line. See README;
 *      the business line itself is never ported.
 *   2. POST /voice returns <Connect><ConversationRelay> to wss://…/relay.
 *   3. The LLM answers from knowledge-base.md only. It may call one
 *      of two tools: transfer_to_owner (business hours only) or
 *      take_message (any time, and always out of hours).
 *   4. The server ends the Relay session with handoffData. Twilio
 *      POSTs to /connect-action, which either:
 *        - starts a warm transfer: caller is put in a Conference,
 *          the owner is called on TRANSFER_NUMBER with a spoken whisper
 *          summary, presses 1 to join the conference, or
 *        - takes a message and ends the call.
 *   5. If the owner does not join within TRANSFER_TIMEOUT_SECONDS (default
 *      25s), the caller leg is redirected to /take-message, which
 *      records a voicemail. Either way the owner gets an SMS summary.
 *   6. After every call an SMS summary goes to PERSONAL_MOBILE.
 *
 * TRANSFER TARGET — READ THIS BEFORE CHANGING IT:
 * TRANSFER_NUMBER must be a DIRECT number that does NOT forward to
 * Twilio. It defaults to the owner's personal mobile (PERSONAL_MOBILE).
 * If the business line (BUSINESS_NUMBER) unconditionally forwards
 * (*72) to the Twilio number, then dialling the business line from
 * Twilio would bounce straight back to Twilio and the owner would
 * never get the call — an infinite loop. So NEVER set TRANSFER_NUMBER
 * to the forwarding business number while *72 forwarding is on; the
 * server refuses to transfer to that number (or to the Twilio number
 * itself) and takes a message instead. See README "The transfer loop
 * warning" for the clean alternatives. A common working setup: both
 * lines on one dual-SIM handset — the business line forwards to
 * Twilio, the personal line does not, so transferring to the personal
 * number rings the same phone the owner carries, with no loop.
 *
 * Business identity is configurable: set BUSINESS_NAME, BUSINESS_NUMBER,
 * and the numbers in .env — no business facts are hard-coded in this
 * file. Edit knowledge-base.md and prompts/system-prompt.md for what
 * the AI says and may quote. Config is via .env only — see .env.example.
 * No secrets in code.
 */

import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import twilio from 'twilio';
import OpenAI from 'openai';

// ---------------------------------------------------------------- config
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, ''); // e.g. https://xyz.railway.app — no trailing slash
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_NUMBER = process.env.TWILIO_NUMBER || ''; // the Twilio number callers are forwarded to, E.164
const PERSONAL_MOBILE = process.env.PERSONAL_MOBILE || ''; // the owner's personal mobile, E.164 — NEVER hard-code a real number. SMS summaries go here.
// Business identity — all configurable, nothing hard-coded. BUSINESS_NAME
// is spoken in the greeting, the transfer whisper, and SMS summaries.
// BUSINESS_NUMBER is the public business line (E.164). It is used ONLY as
// a loop guard: if it forwards (*72) to the Twilio number, the server
// must never transfer a call back to it. Leave it empty if callers dial
// the Twilio number directly and no forwarding is in place.
const BUSINESS_NAME = process.env.BUSINESS_NAME || 'our business';
const BUSINESS_NUMBER = process.env.BUSINESS_NUMBER || '';
// OWNER_FIRST_NAME (optional): if callers ask for the owner by first name,
// the transfer fast-path below recognises it. Leave blank to match only
// role words (owner, manager, real person, ...).
const OWNER_FIRST_NAME = (process.env.OWNER_FIRST_NAME || '').toLowerCase();
// STT_HINTS (optional): comma-separated words the speech recogniser should
// bias toward — your business name, location names, product names. Defaults
// to BUSINESS_NAME. Example: "Acme Dental, Main Street, Invisalign".
const STT_HINTS = process.env.STT_HINTS || BUSINESS_NAME;
// TRANSFER_NUMBER — the ONE place to change where warm transfers ring.
// Must be a DIRECT number that does NOT forward to Twilio. Defaults to
// the personal mobile (same physical phone the owner carries if dual-SIM).
// NEVER set this to BUSINESS_NUMBER while that number forwards (*72) to
// Twilio: the call would loop back to Twilio and never reach the owner.
// See README "The transfer loop warning".
const TRANSFER_NUMBER = process.env.TRANSFER_NUMBER || PERSONAL_MOBILE;
const digitsOnly = (n) => String(n || '').replace(/\D/g, '');
const isLoopNumber = (n) => {
  const d = digitsOnly(n);
  return d !== '' && ((BUSINESS_NUMBER && d === digitsOnly(BUSINESS_NUMBER)) || (TWILIO_NUMBER && d === digitsOnly(TWILIO_NUMBER)));
};
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
// --- LLM provider: gemini (default) or openai --------------------------------
// Gemini (default): get a key free at aistudio.google.com/apikey
// — no card needed for the free tier. Model gemini-3.5-flash-lite costs
// $0.30/1M input tokens, $2.50/1M output tokens on the paid tier.
// Free-tier prompts may be used by Google to improve its products;
// enable billing for paid-tier privacy terms. Latency warning: on the
// FREE tier, first-token latency through Google's OpenAI-compatible
// endpoint measured 5–12s per turn in production (Nov 2026) — far too
// slow for a phone call. Enabling billing on the project (paid tier,
// same key, no code change) fixed it. If the AI feels slow, check the
// billing tier first — see README "Latency".
// Do NOT use gemini-2.5-flash: Google restricted it to projects that had already
// actively used it (Sept 2026), so new projects get a bare HTTP 404 —
// see README "Troubleshooting". OpenAI remains available: set
// LLM_PROVIDER=openai and OPENAI_API_KEY to use gpt-4o-mini instead.
// No code change needed to switch. NOTE: OpenAI retires gpt-4o-mini
// from the API on Jan 14, 2027; its replacement is gpt-6-luna
// (set OPENAI_MODEL=gpt-6-luna, no code change).
const LLM_PROVIDER = (process.env.LLM_PROVIDER || (process.env.GEMINI_API_KEY ? 'gemini' : (process.env.OPENAI_API_KEY ? 'openai' : 'gemini'))).toLowerCase();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const GEMINI_BASE_URL = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/').replace(/\/?$/, '/');
const LLM_MODEL = LLM_PROVIDER === 'openai' ? OPENAI_MODEL : GEMINI_MODEL;
const LLM_API_KEY = LLM_PROVIDER === 'openai' ? OPENAI_API_KEY : GEMINI_API_KEY;
const TIMEZONE = process.env.TIMEZONE || 'America/New_York';
const BUSINESS_HOURS_START = process.env.BUSINESS_HOURS_START || '08:00';
const BUSINESS_HOURS_END = process.env.BUSINESS_HOURS_END || '17:00';
const TRANSFER_TIMEOUT_SECONDS = Number(process.env.TRANSFER_TIMEOUT_SECONDS || 25);
const WHISPER_TIMEOUT_SECONDS = Number(process.env.WHISPER_TIMEOUT_SECONDS || 10);
// --- Website chat: CORS allowlist for POST /chat. Set this to the origin
// the chat widget is embedded on (comma-separated for several sites).
// Empty means no browser origin is allowed — set it before embedding.
const CHAT_ALLOWED_ORIGINS = (process.env.CHAT_ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const CHAT_MAX_MESSAGE_CHARS = Number(process.env.CHAT_MAX_MESSAGE_CHARS || 1000);
const CHAT_RATE_LIMIT_PER_MINUTE = Number(process.env.CHAT_RATE_LIMIT_PER_MINUTE || 30);
const CHAT_SESSION_TTL_MS = 30 * 60 * 1000;
const CHAT_MAX_HISTORY_MESSAGES = 24; // 12 turns, same as the voice path

const E164 = /^\+1\d{10}$/;
const configOk = {
  twilio: Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && E164.test(TWILIO_NUMBER)),
  llm: Boolean(LLM_API_KEY),
  llmProvider: LLM_PROVIDER,
  llmModel: LLM_MODEL,
  // kept for backward compatibility with older health checks / docs
  openai: Boolean(OPENAI_API_KEY),
  gemini: Boolean(GEMINI_API_KEY),
  personalMobile: E164.test(PERSONAL_MOBILE),
  transferNumber: E164.test(TRANSFER_NUMBER) && !isLoopNumber(TRANSFER_NUMBER),
  publicUrl: Boolean(PUBLIC_URL && /^https:\/\//.test(PUBLIC_URL)),
};
if (!configOk.twilio) console.warn('[config] Twilio is not fully configured (need TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER in E.164). Voice/SMS will be disabled until set.');
if (!configOk.llm) console.warn(`[config] No LLM key — set GEMINI_API_KEY (default provider, free at aistudio.google.com/apikey) or OPENAI_API_KEY with LLM_PROVIDER=openai. The AI will use the fallback message only.`);
if (!configOk.personalMobile) console.warn('[config] PERSONAL_MOBILE is missing or not E.164 (+1 + 10 digits) — SMS summaries are disabled until set.');
if (!process.env.TRANSFER_NUMBER && configOk.personalMobile) console.warn('[config] TRANSFER_NUMBER not set — warm transfer defaults to PERSONAL_MOBILE. That is correct if the personal line does not forward to Twilio.');
if (!configOk.transferNumber) console.warn('[config] TRANSFER_NUMBER is missing, not E.164, or it would LOOP (it is BUSINESS_NUMBER or the Twilio number itself) — warm transfer is disabled and the AI will take a message instead. Set TRANSFER_NUMBER to a direct number that does not forward to Twilio.');
if (!configOk.publicUrl) console.warn('[config] PUBLIC_URL is missing or not https:// — Twilio cannot reach this server. Set it to your deployed URL (Railway/Render/Fly) or an ngrok https URL for local testing.');

const twilioClient = configOk.twilio ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;
// One OpenAI SDK client drives either provider: OpenAI's own API, or
// Gemini's OpenAI-compatible endpoint (same chat.completions shape).
const openai = configOk.llm
  ? new OpenAI(LLM_PROVIDER === 'openai'
      ? { apiKey: OPENAI_API_KEY }
      : { apiKey: GEMINI_API_KEY, baseURL: GEMINI_BASE_URL })
  : null;
if (openai) log(`[config] LLM provider=${LLM_PROVIDER} model=${LLM_MODEL} baseURL=${LLM_PROVIDER === 'openai' ? 'https://api.openai.com/v1' : GEMINI_BASE_URL}`);

// ------------------------------------------------------- prompt + knowledge
function readText(relPath, fallback) {
  try {
    return fs.readFileSync(path.join(__dirname, relPath), 'utf8');
  } catch {
    console.warn(`[config] Could not read ${relPath}, using fallback.`);
    return fallback;
  }
}
const SYSTEM_PROMPT = readText('prompts/system-prompt.md', 'You are the AI receptionist for a small business. Answer briefly, in English. Only quote facts you are given. Never promise refunds. Offer to take a message when unsure.');
const KNOWLEDGE_BASE = readText('knowledge-base.md', '');
const CHAT_SYSTEM_PROMPT = readText('prompts/chat-system-prompt.md', 'You are the AI assistant on a small business website. Answer briefly, in English. Only quote facts you are given. Never promise refunds. Offer to take a message when unsure.');
const CHAT_WIDGET_JS = readText('public/chat-widget.js', ''); // served at GET /widget.js; restart after editing, like the prompts

// ---------------------------------------------------------------- helpers
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/** Current time in the business timezone, as HH:MM (24h). DST-safe via IANA tz. */
function nowET() {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}
function nowETFull() {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date());
}
function isBusinessHours(date = new Date()) {
  const hhmm = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
  return hhmm >= BUSINESS_HOURS_START && hhmm < BUSINESS_HOURS_END;
}
function escapeXml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function truncate(s, n = 140) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
function guessIntent(text) {
  const t = (text || '').toLowerCase();
  if (/refund|cancel|credit|money back/.test(t)) return 'refund/cancellation';
  if (/price|cost|how much|fee|discount/.test(t)) return 'pricing';
  if (/location|address|where|directions|parking/.test(t)) return 'location';
  if (/register|sign up|enroll|book|appointment|reserve/.test(t)) return 'registration/booking';
  if (/hours|open|close|schedule|when/.test(t)) return 'hours/schedule';
  return truncate(text, 80) || 'general question';
}

/**
 * Fast-path transfer detection. Production logs (Nov 2026) showed the LLM
 * taking 5–46s to produce a transfer tool call, so requests that are
 * unambiguously transfer-shaped skip the model entirely and go straight
 * to endRelay. Deliberately narrow: policy questions ("What is the refund
 * policy?", "How do I cancel?") must NOT match — only requests
 * ("I want a refund", "cancel my booking", "speak to a real person").
 * The last rule covers confirmations ("Yes, please.") right after the AI
 * offered a transfer; transferOffered is set from the AI's own reply text
 * and cleared when the caller says no.
 */
function isTransferRequest(text, session) {
  const t = (text || '').toLowerCase();
  if (/^\s*(no|nope|not now|no thanks|just answer)\b/.test(t)) {
    if (session) session.transferOffered = false;
    return false;
  }
  const names = ['manager', 'owner', 'person', 'someone', 'human', 'agent', 'representative'];
  if (OWNER_FIRST_NAME) names.push(OWNER_FIRST_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (new RegExp(`\\b(speak|talk)\\b.{0,20}\\b(to|with)\\b.{0,20}\\b(${names.join('|')})\\b`).test(t)) return true;
  // "Call the manager" must transfer ("call me back" must not: no person
  // word follows the verb, so callback requests still reach the LLM).
  if (new RegExp(`\\b(call|ring|reach|get|put me through to)\\b.{0,20}\\b(${names.join('|')})\\b`).test(t)) return true;
  if (/\b(transfer|connect)\b.{0,10}\b(me|us)\b/.test(t)) return true;
  if (/\b(real person|live person|human being|actual person)\b/.test(t)) return true;
  // Information questions are NOT transfer requests, even when they
  // contain a trigger word: "I'd like to know the refund policy"
  // contains "refund" + "like" but asks for information, and on a real
  // test call it was wrongly transferred instead of answered. A
  // question word + refund/cancel/credit, or any mention of "policy",
  // means the caller is asking — the LLM answers from the knowledge
  // base. False negatives here are safe (the LLM handles the request,
  // just slower); false positives send answerable questions to a
  // transfer. Explicit "speak to a person" requests above still win.
  if (/\bpolicy\b/.test(t)) return false;
  if (/\b(what|how|when|where|why|which|tell|explain|know|works|work|about)\b/.test(t) && /\b(refund|cancel|credit)\b/.test(t)) return false;
  if (/\b(refund|money back)\b/.test(t) && /\b(get|want|need|request|give|expect|ask|like|please|me|my)\b/.test(t)) return true;
  if (/\bcancel\b.{0,20}\b(my|our|the|a|registration|booking|spot|appointment|order)\b/.test(t)) return true;
  if (/\b(complaint|complain)\b/.test(t)) return true;
  if (/\b(i'm|i am|we're|we are)\b.{0,20}\b(unhappy|angry|upset|disappointed|frustrated)\b/.test(t)) return true;
  if (session?.transferOffered && /^\s*(yes|yeah|sure|please|ok|okay|please do|go ahead|that would be great|that works)\b/.test(t)) return true;
  return false;
}

// ------------------------------------------------------------ call sessions
/** callSid -> session. In-memory only; a restart loses in-flight calls, which is acceptable for the MVP. */
const sessions = new Map();

function getOrCreateSession(callSid, from, to) {
  if (!sessions.has(callSid)) {
    sessions.set(callSid, {
      callSid, from: from || 'unknown', to: to || TWILIO_NUMBER,
      createdAt: new Date().toISOString(),
      history: [], // OpenAI chat messages {role, content}
      callerName: null, callbackNumber: null, intent: '',
      summaryNotes: [], transferred: false, ownerJoined: false,
      messageTaken: false, messageText: '', smsSent: false,
      smsOutcome: '', conferenceName: null, transferTimer: null,
      outboundCallSid: null, turnId: 0, ended: false,
      transferOffered: false, abortController: null,
    });
  }
  return sessions.get(callSid);
}
function getSession(callSid) { return sessions.get(callSid); }

// ------------------------------------------------------------- SMS summary
async function sendSmsSummary(session, outcome) {
  if (!session || session.smsSent) return;
  session.smsSent = true; // set before the await: prevents double-send from parallel hooks
  session.smsOutcome = outcome;
  const name = session.callerName || 'not given';
  const callback = session.callbackNumber || session.from || 'not given';
  const body =
    `${BUSINESS_NAME} call ${nowETFull()} (${TIMEZONE})\n` +
    `From: ${session.from}\n` +
    `Name: ${name}\n` +
    `About: ${session.intent || 'general question'}\n` +
    `Outcome: ${outcome}\n` +
    `Callback: ${callback}` +
    (session.messageText ? `\nMessage: ${truncate(session.messageText, 200)}` : '');
  if (!twilioClient || !configOk.personalMobile) {
    log(`[sms] NOT SENT (Twilio/personal mobile not configured) callSid=${session.callSid} outcome=${outcome}\n${body}`);
    return;
  }
  try {
    const msg = await twilioClient.messages.create({ from: TWILIO_NUMBER, to: PERSONAL_MOBILE, body });
    log(`[sms] sent sid=${msg.sid} callSid=${session.callSid} outcome=${outcome}`);
  } catch (err) {
    log(`[sms] FAILED callSid=${session.callSid} outcome=${outcome} error=${err.message}`);
  }
}
async function finalizeCall(session, outcome) {
  if (!session || session.ended) return;
  session.ended = true;
  if (session.transferTimer) { clearTimeout(session.transferTimer); session.transferTimer = null; }
  await sendSmsSummary(session, outcome);
  // Keep the session for 10 minutes so late webhooks can still find it, then drop it.
  setTimeout(() => sessions.delete(session.callSid), 10 * 60 * 1000);
}

// ------------------------------------------------------------------- LLM
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'transfer_to_owner',
      description: 'Transfer the caller to the business owner. ONLY call this when it is within transfer hours (the system message says TRANSFER AVAILABLE) and the caller asks for the owner/a real person, or the request is a refund, credit, or complaint.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string', description: 'One sentence: what the caller wants from the owner.' } },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'take_message',
      description: 'Take a message for the business owner. Call this after confirming the caller name, callback number, and their question.',
      parameters: {
        type: 'object',
        properties: {
          caller_name: { type: 'string', description: 'Caller name, or "not given".' },
          callback_number: { type: 'string', description: 'Best callback number, or "not given".' },
          message: { type: 'string', description: 'The question/request in one sentence.' },
        },
        required: ['caller_name', 'callback_number', 'message'],
      },
    },
  },
];

/**
 * Parse a tool call out of plain model text — the Gemini fallback.
 * Gemini's OpenAI-compatible endpoint has limited/beta tool calling, so
 * if it answers in words instead of a tool call, it may emit JSON like:
 *   {"action":"transfer_to_owner","reason":"..."}
 *   {"action":"take_message","caller_name":"...","callback_number":"...","message":"..."}
 * Returns { name, args } or null. Never speaks the JSON to the caller.
 */
function parseToolCallFromText(text) {
  if (!text) return null;
  const m = String(text).match(/\{[\s\S]*?"action"\s*:\s*"(transfer_to_owner|take_message)"[\s\S]*?\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    if (obj.action === 'transfer_to_owner') return { name: 'transfer_to_owner', args: { reason: obj.reason || '' } };
    if (obj.action === 'take_message') return { name: 'take_message', args: { caller_name: obj.caller_name || 'not given', callback_number: obj.callback_number || 'not given', message: obj.message || '' } };
  } catch { return null; }
  return null;
}

/**
 * One LLM turn, STREAMED token-by-token. Tokens are forwarded to Twilio
 * verbatim (last:false) the moment they arrive, and the turn ends with
 * Twilio's documented closing frame (last:true, empty token) — synthesis
 * starts on the first token instead of waiting for a sentence or the
 * whole reply. Production logs showed first-token latency dominating
 * every turn, so nothing here waits: the only hold is a 1-2 delta prefix
 * check that keeps the Gemini JSON tool-call fallback from being spoken
 * aloud. `signal` aborts the call when the caller speaks again or
 * interrupts, so a superseded turn stops consuming the model instead of
 * running to completion in the background (logs once showed two
 * overlapping 16s calls from one split utterance). Tool calls are
 * handled by the caller. Returns { text, toolCall, streamed } where
 * toolCall is null or { name, args }, and streamed says whether any
 * token was already spoken (so the caller does not repeat a fixed
 * hold/message line). If the provider rejects streaming, askLLM falls
 * back to one non-streaming completion rather than failing the call.
 */
async function askLLM(session, sendToken, signal) {
  const startedAt = Date.now();
  const inHours = isBusinessHours();
  const messages = [
    {
      role: 'system',
      content:
        `${SYSTEM_PROMPT}\n\n---\nKNOWLEDGE BASE (only facts you may quote):\n${KNOWLEDGE_BASE}\n---\n` +
        `Current time: ${nowETFull()} (${TIMEZONE}). ` +
        (inHours
          ? `TRANSFER AVAILABLE: it is within ${BUSINESS_HOURS_START}–${BUSINESS_HOURS_END} ${TIMEZONE}, so transfer_to_owner may be used.`
          : `TRANSFER NOT AVAILABLE: it is outside ${BUSINESS_HOURS_START}–${BUSINESS_HOURS_END} ${TIMEZONE}. Do NOT call transfer_to_owner. Use take_message instead.`) +
        (LLM_PROVIDER === 'gemini'
          ? '\nIf you cannot call a tool, reply with ONLY this JSON on its own line instead of speaking it: {"action":"transfer_to_owner","reason":"..."} or {"action":"take_message","caller_name":"...","callback_number":"...","message":"..."}'
          : ''),
    },
    ...session.history.slice(-12),
  ];
  const request = {
    model: LLM_MODEL, temperature: 0.3, max_tokens: 256,
    messages, tools: TOOLS, tool_choice: 'auto',
  };
  let stream;
  try {
    // NOTE: `signal` MUST be the second (options) argument, never part of
    // the request body. The OpenAI SDK serializes unknown body keys into
    // the JSON payload ("signal": {}), and Gemini's OpenAI-compatible
    // endpoint rejects the request with a bare HTTP 400. Passing it in
    // the body broke every LLM call until this fix.
    stream = await openai.chat.completions.create({ ...request, stream: true }, { signal });
  } catch (streamErr) {
    if (signal?.aborted) throw streamErr; // superseded turn: do not fall back, just stop
    log(`[llm] streaming unavailable, falling back to non-streaming error=${streamErr.message}`);
    const completion = await openai.chat.completions.create({ ...request }, { signal });
    const msg = completion.choices[0]?.message || {};
    const toolCall = msg.tool_calls?.[0];
    if (toolCall) {
      let args = {};
      try { args = JSON.parse(toolCall.function.arguments || '{}'); } catch { args = {}; }
      return { text: '', toolCall: { name: toolCall.function.name, args }, streamed: false };
    }
    const fallback = parseToolCallFromText(msg.content || '');
    if (fallback) {
      log(`[llm] tool call via JSON fallback provider=${LLM_PROVIDER} name=${fallback.name}`);
      return { text: '', toolCall: fallback, streamed: false };
    }
    return { text: msg.content || '', toolCall: null, streamed: false };
  }
  let fullText = '';
  let toolName = null;
  let toolArgsText = '';
  let jsonMode = false;
  let sawToolCall = false;
  let streamedAny = false;
  let firstTokenAt = 0;
  // Prefix detection for the Gemini JSON fallback: hold tokens only until
  // the first non-whitespace character classifies the reply. '{' means
  // JSON (hold everything, parse at the end); anything else means speech
  // (forward verbatim from here on). This costs at most one or two deltas.
  let prefixBuf = '';
  let decided = false;
  const forward = (token, isLast) => {
    streamedAny = true;
    sendToken(token, isLast);
  };
  for await (const chunk of stream) {
    if (!firstTokenAt) firstTokenAt = Date.now();
    const delta = chunk.choices?.[0]?.delta || {};
    if (delta.tool_calls?.length) {
      sawToolCall = true;
      for (const tc of delta.tool_calls) {
        if (tc.function?.name) toolName = tc.function.name;
        toolArgsText += tc.function?.arguments || '';
      }
    }
    if (!delta.content) continue;
    fullText += delta.content;
    if (jsonMode || sawToolCall) continue;
    if (!decided) {
      prefixBuf += delta.content;
      const first = prefixBuf.match(/\S/);
      if (!first && prefixBuf.length < 200) continue; // leading whitespace only, keep holding
      decided = true;
      if (first && prefixBuf[first.index] === '{') {
        jsonMode = true; // Gemini JSON tool-call fallback: hold everything until parsed.
        continue;
      }
      forward(prefixBuf, false);
      prefixBuf = '';
      continue;
    }
    // Verbatim forwarding: Twilio's own guidance is to stream tokens as
    // they arrive (last:false) without trimming, so synthesis starts on
    // the first token instead of waiting for a sentence.
    forward(delta.content, false);
  }
  const elapsedMs = Date.now() - startedAt;
  if (sawToolCall && toolName) {
    let args = {};
    try { args = JSON.parse(toolArgsText || '{}'); } catch { args = {}; }
    log(`[llm] done ms=${elapsedMs} tool=${toolName} streamed=${streamedAny}`);
    return { text: '', toolCall: { name: toolName, args }, streamed: streamedAny };
  }
  if (jsonMode) {
    const fallback = parseToolCallFromText(fullText);
    if (fallback) {
      log(`[llm] tool call via JSON fallback provider=${LLM_PROVIDER} name=${fallback.name} ms=${elapsedMs}`);
      return { text: '', toolCall: fallback, streamed: false };
    }
    // JSON-shaped but unparseable: never speak raw JSON to a caller.
    log(`[llm] unparseable JSON-shaped reply, using apology ms=${elapsedMs} text=${truncate(fullText, 80)}`);
    return { text: 'Sorry, I had trouble with that. Could you say it once more?', toolCall: null, streamed: false };
  }
  // Closing frame: Twilio's documented end-of-turn signal is a final
  // message with last:true and an empty token. Sent even when nothing was
  // spoken, so the turn always terminates cleanly.
  forward('', true);
  log(`[llm] done ms=${elapsedMs} ttfbMs=${firstTokenAt ? firstTokenAt - startedAt : -1} chars=${fullText.length} streamed=${streamedAny}`);
  return { text: fullText, toolCall: null, streamed: streamedAny };
}

/** Send reply text to ConversationRelay in sentence chunks, last chunk flagged last:true. */
function sendText(ws, text) {
  const clean = String(text || '').trim();
  if (!clean) return;
  const chunks = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
  chunks.forEach((chunk, i) => {
    ws.send(JSON.stringify({ type: 'text', token: chunk + ' ', last: i === chunks.length - 1 }));
  });
}
function endRelay(ws, handoffData) {
  ws.send(JSON.stringify({ type: 'end', handoffData: JSON.stringify(handoffData) }));
}

// ------------------------------------------------------------- warm transfer
function conferenceNameFor(callSid) { return `ai-receptionist-${callSid}`; }

/** Fire-and-forget: call the owner on TRANSFER_NUMBER, play the whisper, join them to the conference on press 1. */
async function callOwnerForWarmTransfer(session, reason) {
  if (!twilioClient || !configOk.transferNumber) return;
  try {
    const call = await twilioClient.calls.create({
      to: TRANSFER_NUMBER,
      from: TWILIO_NUMBER,
      url: `${PUBLIC_URL}/owner-whisper?origCallSid=${encodeURIComponent(session.callSid)}`,
      method: 'POST',
      timeout: TRANSFER_TIMEOUT_SECONDS,
      statusCallback: `${PUBLIC_URL}/owner-call-status?origCallSid=${encodeURIComponent(session.callSid)}`,
      statusCallbackEvent: ['completed'],
    });
    session.outboundCallSid = call.sid;
    log(`[transfer] outbound call to the owner sid=${call.sid} origCallSid=${session.callSid}`);
  } catch (err) {
    log(`[transfer] FAILED to call the owner origCallSid=${session.callSid} error=${err.message}`);
  }
}

/** 25s fallback: if the owner has not joined the conference, move the caller to voicemail-style message taking. */
async function fallbackIfOwnerNotJoined(session) {
  session.transferTimer = null;
  if (session.ownerJoined || session.ended) return;
  log(`[transfer] no answer in ${TRANSFER_TIMEOUT_SECONDS}s, redirecting caller to /take-message callSid=${session.callSid}`);
  session.intent = session.intent || 'wanted the owner';
  if (!twilioClient) { await finalizeCall(session, 'transfer — no answer, message not taken (Twilio not configured)'); return; }
  try {
    await twilioClient.calls(session.callSid).update({
      url: `${PUBLIC_URL}/take-message?callSid=${encodeURIComponent(session.callSid)}&reason=no-answer`,
      method: 'POST',
    });
  } catch (err) {
    log(`[transfer] redirect FAILED callSid=${session.callSid} error=${err.message}`);
    await finalizeCall(session, 'transfer — no answer, redirect failed');
  }
}

/**
 * Start the warm transfer. Returns the TwiML that puts the caller in a
 * conference. The outbound call to the owner and the fallback timer run in the
 * background — the caller hears hold music, not silence.
 */
function startWarmTransfer(session, reason) {
  session.transferred = true;
  session.intent = guessIntent(reason) === 'general question' ? truncate(reason, 80) : session.intent || truncate(reason, 80);
  session.summaryNotes.push(`Transfer requested: ${reason}`);
  const conf = conferenceNameFor(session.callSid);
  session.conferenceName = conf;
  callOwnerForWarmTransfer(session, reason);
  session.transferTimer = setTimeout(() => { fallbackIfOwnerNotJoined(session); }, TRANSFER_TIMEOUT_SECONDS * 1000);
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say('Please hold while I connect you to the owner.');
  const dial = twiml.dial({
    action: `${PUBLIC_URL}/conference-end?callSid=${encodeURIComponent(session.callSid)}`,
    method: 'POST',
  });
  dial.conference(
    {
      waitUrl: 'http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical',
      startConferenceOnEnter: true,
      endConferenceOnExit: true,
    },
    conf,
  );
  return twiml.toString();
}

// ------------------------------------------------------------ Website chat
// POST /chat + GET /widget.js. The website chat widget reuses the voice
// path's LLM client, knowledge base, and take_message SMS flow, with its
// own system prompt (chat may quote links; no phone transfer). Sessions
// are in-memory with a 30-minute idle TTL, like call sessions.
// Deliberately separate from askLLM(): the voice path streams tokens to
// Twilio and must not change; chat streams too, but buffers the tokens
// server-side and answers the widget with one JSON round-trip.

const CHAT_TOOLS = [TOOLS[1]]; // take_message only — no transfer from web chat

/** sessionId -> chat session. In-memory only; a restart loses open chats. */
const chatSessions = new Map();

function getOrCreateChatSession(id) {
  const now = Date.now();
  for (const [key, s] of chatSessions) {
    if (now - s.lastSeen > CHAT_SESSION_TTL_MS) chatSessions.delete(key);
  }
  if (chatSessions.size > 500) {
    const oldest = [...chatSessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
    if (oldest) chatSessions.delete(oldest[0]);
  }
  if (!chatSessions.has(id)) {
    chatSessions.set(id, {
      id, createdAt: new Date().toISOString(), lastSeen: now,
      history: [], smsSent: false, messageTaken: false,
    });
  }
  const s = chatSessions.get(id);
  s.lastSeen = now;
  return s;
}

/** Tiny per-IP rate limiter for /chat (no new dependency). */
const chatRate = new Map(); // ip -> { windowStart, count }
function chatRateLimited(ip) {
  const now = Date.now();
  const entry = chatRate.get(ip);
  if (!entry || now - entry.windowStart >= 60000) {
    chatRate.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  entry.count += 1;
  if (chatRate.size > 1000) {
    for (const [key, e] of chatRate) if (now - e.windowStart >= 60000) chatRate.delete(key);
  }
  return entry.count > CHAT_RATE_LIMIT_PER_MINUTE;
}

function chatCors(req, res) {
  const origin = req.headers.origin || '';
  if (origin && CHAT_ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

/** One chat turn: STREAMED completion, buffered server-side, with a hard
 * timeout. The voice path proved streaming is the reliable shape on
 * Gemini's OpenAI-compatible endpoint; a non-streaming completion
 * intermittently hung for ~300s per turn in live tests. Buffering keeps
 * the widget on a single JSON round-trip while the stream keeps the
 * request alive. A 60s abort bounds the worst case to a friendly 502
 * instead of a multi-minute hang. Tool calls arrive as deltas (same as
 * the voice path) or as the Gemini JSON fallback in the text.
 */
async function askChatLLM(chatSession) {
  const startedAt = Date.now();
  const messages = [
    {
      role: 'system',
      content:
        `${CHAT_SYSTEM_PROMPT}\n\n---\nKNOWLEDGE BASE (only facts you may quote):\n${KNOWLEDGE_BASE}\n---\n` +
        `Current time: ${nowETFull()} (${TIMEZONE}).` +
        (LLM_PROVIDER === 'gemini'
          ? '\nIf you cannot call a tool, reply with ONLY this JSON on its own line instead of speaking it: {"action":"take_message","caller_name":"...","callback_number":"...","message":"..."}'
          : ''),
    },
    ...chatSession.history.slice(-CHAT_MAX_HISTORY_MESSAGES),
  ];
  // NOTE: `signal` MUST be the second (options) argument, never part of
  // the request body — the OpenAI SDK serializes unknown body keys into
  // the JSON payload, and Gemini's endpoint rejects the request with a
  // bare HTTP 400. maxRetries: 1 bounds retry storms on the same endpoint.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  let stream;
  try {
    stream = await openai.chat.completions.create({
      model: LLM_MODEL, temperature: 0.3, max_tokens: 400,
      messages, tools: CHAT_TOOLS, tool_choice: 'auto', stream: true,
    }, { signal: controller.signal, maxRetries: 1 });
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
  let fullText = '';
  let toolName = null;
  let toolArgsText = '';
  let sawToolCall = false;
  let firstTokenAt = 0;
  try {
    for await (const chunk of stream) {
      if (!firstTokenAt) firstTokenAt = Date.now();
      const delta = chunk.choices?.[0]?.delta || {};
      if (delta.tool_calls?.length) {
        sawToolCall = true;
        for (const tc of delta.tool_calls) {
          if (tc.function?.name) toolName = tc.function.name;
          toolArgsText += tc.function?.arguments || '';
        }
      }
      if (delta.content) fullText += delta.content;
    }
  } finally {
    clearTimeout(timeout);
  }
  const elapsedMs = Date.now() - startedAt;
  const ttfbMs = firstTokenAt ? firstTokenAt - startedAt : -1;
  if (sawToolCall && toolName === 'take_message') {
    let args = {};
    try { args = JSON.parse(toolArgsText || '{}'); } catch { args = {}; }
    log(`[chat-llm] tool=take_message ms=${elapsedMs} ttfbMs=${ttfbMs}`);
    return { text: '', toolCall: { name: 'take_message', args } };
  }
  const fallback = parseToolCallFromText(fullText);
  if (fallback) {
    if (fallback.name === 'take_message') {
      log(`[chat-llm] tool call via JSON fallback ms=${elapsedMs} ttfbMs=${ttfbMs}`);
      return { text: '', toolCall: fallback };
    }
    // JSON-shaped but not a chat tool (e.g. a transfer request): never
    // show raw JSON in the widget.
    log(`[chat-llm] unexpected JSON-shaped reply, using fallback ms=${elapsedMs} ttfbMs=${ttfbMs}`);
    return { text: 'Sorry, I had trouble with that. Could you try asking it a different way?', toolCall: null };
  }
  const text = fullText.trim();
  if (!text || text.startsWith('{')) {
    log(`[chat-llm] empty/unusable reply, using fallback ms=${elapsedMs} ttfbMs=${ttfbMs}`);
    return { text: 'Sorry, I had trouble with that. Could you try asking it a different way?', toolCall: null };
  }
  log(`[chat-llm] done ms=${elapsedMs} ttfbMs=${ttfbMs} chars=${text.length}`);
  return { text, toolCall: null };
}

/** SMS summary to the owner for a message taken in web chat — same path as call summaries. */
async function sendChatMessageSms(chatSession, args) {
  if (chatSession.smsSent) return;
  chatSession.smsSent = true; // set before the await: prevents double-send
  const body =
    `${BUSINESS_NAME} website chat ${nowETFull()} (${TIMEZONE})\n` +
    `Name: ${args.caller_name || 'not given'}\n` +
    `Contact: ${args.callback_number || 'not given'}\n` +
    `About: ${guessIntent(args.message)}\n` +
    `Message: ${truncate(args.message, 200)}`;
  if (!twilioClient || !configOk.personalMobile) {
    log(`[chat-sms] NOT SENT (Twilio/personal mobile not configured) session=${chatSession.id}\n${body}`);
    return;
  }
  try {
    const msg = await twilioClient.messages.create({ from: TWILIO_NUMBER, to: PERSONAL_MOBILE, body });
    log(`[chat-sms] sent sid=${msg.sid} session=${chatSession.id}`);
  } catch (err) {
    log(`[chat-sms] FAILED session=${chatSession.id} error=${err.message}`);
  }
}

// ------------------------------------------------------------------ server
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/', (_req, res) => res.type('text').send('AI Receptionist — see /health.'));
app.get('/health', (_req, res) => res.json({
  ok: true,
  service: 'ai-receptionist',
  timeET: nowETFull(),
  businessHours: `${BUSINESS_HOURS_START}–${BUSINESS_HOURS_END} ${TIMEZONE}`,
  transferAvailableNow: isBusinessHours(),
  configured: configOk,
  activeSessions: sessions.size,
  chat: { enabled: true, activeChatSessions: chatSessions.size, allowedOrigins: CHAT_ALLOWED_ORIGINS },
}));

// Website chat widget file + API (see the "Website chat" section above).
app.get('/widget.js', (req, res) => {
  if (!CHAT_WIDGET_JS) return res.sendStatus(404);
  res.type('application/javascript');
  res.set('Cache-Control', 'public, max-age=300'); // short: widget updates propagate within minutes
  res.send(CHAT_WIDGET_JS);
});
app.options('/chat', (req, res) => { chatCors(req, res); res.sendStatus(204); });
app.post('/chat', async (req, res) => {
  chatCors(req, res);
  const ip = (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.ip || 'unknown';
  if (chatRateLimited(ip)) {
    log(`[chat] rate limited ip=${ip}`);
    return res.status(429).json({ error: 'Too many messages. Please wait a minute and try again.' });
  }
  const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
  if (!message) return res.status(400).json({ error: 'A message is required.' });
  if (message.length > CHAT_MAX_MESSAGE_CHARS) return res.status(400).json({ error: 'Message is too long.' });
  let sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId.trim() : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(sessionId)) {
    sessionId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }
  const chatSession = getOrCreateChatSession(sessionId);
  log(`[chat] session=${sessionId} text=${truncate(message, 120)}`);
  if (!openai) {
    log(`[chat] LLM not configured, returning fallback session=${sessionId}`);
    return res.status(503).json({ error: 'The assistant is not available right now. Please contact the business directly.' });
  }
  chatSession.history.push({ role: 'user', content: message });
  if (chatSession.history.length > CHAT_MAX_HISTORY_MESSAGES * 2) {
    chatSession.history = chatSession.history.slice(-CHAT_MAX_HISTORY_MESSAGES);
  }
  let result;
  try {
    result = await askChatLLM(chatSession);
  } catch (err) {
    // Log the full SDK error (the bare message hid whether the failure
    // was the model name, the endpoint, or the key — see the voice path).
    const detail = { status: err.status, code: err.code, type: err.type, body: err.error || err.body || null };
    log(`[chat] LLM FAILED session=${sessionId} provider=${LLM_PROVIDER} model=${LLM_MODEL} error=${err.message} detail=${JSON.stringify(detail)}`);
    return res.status(502).json({ error: 'Sorry, I had trouble with that. Please try again, or contact the business directly.' });
  }
  if (result.toolCall?.name === 'take_message') {
    const args = result.toolCall.args || {};
    const name = String(args.caller_name || '').trim();
    const contact = String(args.callback_number || '').trim();
    const msgText = String(args.message || '').trim();
    chatSession.messageTaken = true;
    await sendChatMessageSms(chatSession, {
      caller_name: name || 'not given',
      callback_number: contact || 'not given',
      message: msgText || message,
    });
    const reply = (name && name !== 'not given' && contact && contact !== 'not given')
      ? `Thanks, ${name}. I've passed your message to the owner, and you'll get a call back at ${contact}. Is there anything else I can help with?`
      : "Thanks — I've passed your message to the owner, and you'll get a call back. Is there anything else I can help with?";
    chatSession.history.push({ role: 'assistant', content: reply });
    return res.json({ sessionId, reply, messageTaken: true });
  }
  chatSession.history.push({ role: 'assistant', content: result.text });
  return res.json({ sessionId, reply: result.text });
});

// SHAKEN/STIR screening (2026-11-12): Twilio verifies inbound calls and
// passes the result as the StirVerstat webhook parameter — but ONLY when
// the originating carrier supplies SHAKEN PASSporT headers, so the
// parameter is often absent on legitimate calls. Policy: block ONLY an
// explicit verification failure (TN-Validation-Failed-*), which means a
// PASSporT was present but its signature did not verify — a strong
// spoofing signal. Every other value (Passed-A/B/C, No-TN-Validation,
// absent) is handled normally. The value is logged on every call so the
// distribution is visible in production logs before any stricter policy.
function stirVerstatBlocked(value) {
  return typeof value === 'string' && value.startsWith('TN-Validation-Failed');
}

/**
 * POST /voice — Twilio Voice webhook for the Twilio number.
 * Returns <Connect><ConversationRelay>. The <Connect action> is where
 * Twilio returns control after the Relay session ends (handoff).
 */
app.post('/voice', (req, res) => {
  const callSid = req.body.CallSid || `unknown-${Date.now()}`;
  const from = req.body.From || '';
  const stirVerstat = req.body.StirVerstat || '';
  if (stirVerstatBlocked(stirVerstat)) {
    log(`[voice] BLOCKED failed SHAKEN/STIR validation stirVerstat=${stirVerstat} callSid=${callSid} from=${from}`);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("We're sorry, we couldn't verify this call, so we can't connect you. Please reach us through our website.");
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }
  getOrCreateSession(callSid, from, req.body.To || TWILIO_NUMBER);
  log(`[voice] inbound callSid=${callSid} from=${from} stirVerstat=${stirVerstat || '(absent)'}`);
  if (!configOk.publicUrl) {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say(`Sorry, the ${BUSINESS_NAME} receptionist is not configured yet. Please try again later.`);
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }
  const wsUrl = PUBLIC_URL.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://') + '/relay';
  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect({ action: `${PUBLIC_URL}/connect-action`, method: 'POST' });
  // STT tuning (from production log diagnosis, Nov 2026): Deepgram Flux
  // fuses transcription with end-of-turn detection and answers 200-600ms
  // faster than the default nova-3 model; eotThreshold 0.7 finalises a turn
  // a little earlier than the 0.8 default. dtmfDetection must be on for
  // the press-0 transfer in the Relay handler to ever fire (its default
  // is off). Hints bias transcription toward your business/location names.
  connect.conversationRelay({
    url: wsUrl,
    welcomeGreeting: `Hello, thank you for calling ${BUSINESS_NAME}. I'm an AI assistant. How can I help you today?`,
    language: 'en-US',
    ttsProvider: 'Amazon',
    voice: 'Joanna-Neural',
    transcriptionProvider: 'Deepgram',
    speechModel: 'flux',
    eotThreshold: '0.7',
    dtmfDetection: true,
    hints: STT_HINTS,
    interruptible: true,
  });
  return res.type('text/xml').send(twiml.toString());
});

/**
 * POST /connect-action — Twilio calls this when the Relay session ends.
 * HandoffData (if any) is a JSON string: { action: 'transfer'|'message', ... }.
 * SessionStatus 'completed' = caller hung up during the AI conversation.
 */
app.post('/connect-action', async (req, res) => {
  const callSid = req.body.CallSid;
  const session = getSession(callSid) || getOrCreateSession(callSid, req.body.From, req.body.To);
  let handoff = {};
  try { handoff = JSON.parse(req.body.HandoffData || '{}'); } catch { handoff = {}; }
  log(`[connect-action] callSid=${callSid} status=${req.body.SessionStatus} handoff=${JSON.stringify(handoff)}`);

  if (handoff.action === 'transfer') {
    if (!isBusinessHours() || !configOk.transferNumber) {
      // Defence in depth: the LLM should never request this out of hours,
      // but if it does — or if TRANSFER_NUMBER is unset / would loop back
      // to Twilio — take a message instead of transferring.
      log(`[connect-action] transfer refused (out of hours / no valid TRANSFER_NUMBER / loop risk) callSid=${callSid}`);
      const twiml = new twilio.twiml.VoiceResponse();
      twiml.say("The owner isn't available right now, but I can take a message for them.");
      twiml.redirect({ method: 'POST' }, `${PUBLIC_URL}/take-message?callSid=${encodeURIComponent(callSid)}&reason=out-of-hours`);
      return res.type('text/xml').send(twiml.toString());
    }
    return res.type('text/xml').send(startWarmTransfer(session, handoff.reason || 'wants to speak to the owner'));
  }

  if (handoff.action === 'message') {
    session.messageTaken = true;
    session.callerName = handoff.caller_name || session.callerName;
    session.callbackNumber = handoff.callback_number || session.callbackNumber;
    session.messageText = handoff.message || '';
    session.intent = session.intent || guessIntent(session.messageText);
    await finalizeCall(session, 'message taken by AI');
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('Thank you. The owner will call you back.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  // No handoff: caller hung up, or the AI ended the call after answering.
  await finalizeCall(session, session.transferred ? 'transferred' : 'answered by AI, caller hung up');
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.hangup();
  return res.type('text/xml').send(twiml.toString());
});

/**
 * POST /owner-whisper — TwiML for the outbound leg to the owner.
 * Plays one short whisper line, then Gather: 1 = accept and join the
 * conference, anything else / no input = decline (the caller falls
 * back to a message). Kept to one sentence on purpose: an earlier
 * version repeated the transfer reason twice (intent + summary notes)
 * and sounded verbose and repetitive on a real test call.
 */
app.post('/owner-whisper', (req, res) => {
  const origCallSid = req.query.origCallSid;
  const session = getSession(origCallSid);
  const rawAbout = session?.intent || 'a general question';
  // Vague intents ("wants to speak to...") read badly in a whisper;
  // collapse them instead of repeating the caller's words back.
  const about = /want|speak/i.test(rawAbout) ? 'a general question' : truncate(rawAbout, 40);
  const from = session?.from || 'an unknown number';
  const summary = `${BUSINESS_NAME} call from ${from}, about ${about}. Press 1 to accept.`;
  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    numDigits: 1, timeout: WHISPER_TIMEOUT_SECONDS,
    action: `${PUBLIC_URL}/owner-accept?origCallSid=${encodeURIComponent(origCallSid)}`, method: 'POST',
  });
  gather.say(escapeXml(summary));
  twiml.say('No input received. I will let the caller leave a message.');
  twiml.hangup();
  return res.type('text/xml').send(twiml.toString());
});

/** POST /owner-accept — the owner pressed 1: join the conference. Anything else: decline. */
app.post('/owner-accept', (req, res) => {
  const origCallSid = req.query.origCallSid;
  const session = getSession(origCallSid);
  const digits = req.body.Digits || '';
  log(`[owner-accept] origCallSid=${origCallSid} digits=${digits}`);
  if (digits === '1' && session?.conferenceName) {
    session.ownerJoined = true;
    if (session.transferTimer) { clearTimeout(session.transferTimer); session.transferTimer = null; }
    const twiml = new twilio.twiml.VoiceResponse();
    const dial = twiml.dial({
      action: `${PUBLIC_URL}/owner-left?origCallSid=${encodeURIComponent(origCallSid)}`, method: 'POST',
    });
    dial.conference(
      { startConferenceOnEnter: true, endConferenceOnExit: true },
      session.conferenceName,
    );
    return res.type('text/xml').send(twiml.toString());
  }
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say('Thanks. I will let the caller leave a message.');
  twiml.hangup();
  return res.type('text/xml').send(twiml.toString());
});

/** POST /owner-call-status — outbound the owner leg finished (no answer / busy / declined). The 25s timer handles the caller fallback; this is just logging. */
app.post('/owner-call-status', (req, res) => {
  log(`[owner-call-status] origCallSid=${req.query.origCallSid} status=${req.body.CallStatus} duration=${req.body.CallDuration || 0}s`);
  return res.sendStatus(200);
});

/** POST /owner-left — the owner's conference leg ended (he hung up, or the conference ended). Finalise the SMS if it has not been sent. */
app.post('/owner-left', async (req, res) => {
  const session = getSession(req.query.origCallSid);
  if (session) await finalizeCall(session, 'transferred to the owner — call ended');
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.hangup();
  return res.type('text/xml').send(twiml.toString());
});

/** POST /conference-end — the caller's conference leg ended. Finalise the SMS. */
app.post('/conference-end', async (req, res) => {
  const session = getSession(req.query.callSid);
  if (session) {
    await finalizeCall(session, session.ownerJoined ? 'transferred to the owner — call ended' : 'transfer ended');
  }
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.hangup();
  return res.type('text/xml').send(twiml.toString());
});

/**
 * POST /take-message — fallback message taking (conference no-answer, or
 * out-of-hours redirect). Records a voicemail with transcription.
 */
app.post('/take-message', (req, res) => {
  const callSid = req.query.callSid || req.body.CallSid;
  log(`[take-message] callSid=${callSid} reason=${req.query.reason || ''}`);
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say("The owner isn't available right now. Please leave your name, callback number, and a brief message after the beep, and you will get a call back.");
  twiml.record({
    maxLength: 120, timeout: 5, playBeep: true, transcribe: true,
    transcribeCallback: `${PUBLIC_URL}/record-done?callSid=${encodeURIComponent(callSid || '')}`,
    action: `${PUBLIC_URL}/record-done?callSid=${encodeURIComponent(callSid || '')}`, method: 'POST',
  });
  twiml.say('Thank you. The owner will call you back.');
  twiml.hangup();
  return res.type('text/xml').send(twiml.toString());
});

/** POST /record-done — voicemail recorded / transcribed. Send the SMS summary. */
app.post('/record-done', async (req, res) => {
  const callSid = req.query.callSid || req.body.CallSid;
  const session = getSession(callSid);
  const text = req.body.TranscriptionText || '';
  log(`[record-done] callSid=${callSid} duration=${req.body.RecordingDuration || 0}s transcription=${truncate(text, 120)}`);
  if (session) {
    session.messageTaken = true;
    session.messageText = text || '(voicemail recorded, no transcription yet)';
    session.intent = session.intent || guessIntent(text);
    await finalizeCall(session, 'message taken (voicemail)');
  } else if (twilioClient && configOk.personalMobile) {
    // Session expired (server restarted mid-call) — still notify the owner.
    try {
      await twilioClient.messages.create({
        from: TWILIO_NUMBER, to: PERSONAL_MOBILE,
        body: `${BUSINESS_NAME} voicemail ${nowETFull()} (${TIMEZONE})\nFrom: ${req.body.From || 'unknown'}\nMessage: ${truncate(text, 200)}`,
      });
    } catch (err) { log(`[record-done] SMS fallback FAILED error=${err.message}`); }
  }
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say('Thank you. The owner will call you back.');
  twiml.hangup();
  return res.type('text/xml').send(twiml.toString());
});

// ------------------------------------------------------- ConversationRelay WS
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/relay' });

wss.on('connection', (ws) => {
  let session = null;
  let closed = false;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'setup') {
      session = getOrCreateSession(msg.callSid, msg.from, msg.to);
      log(`[relay] setup callSid=${msg.callSid} from=${msg.from} to=${msg.to}`);
      return;
    }
    if (!session) return; // ignore messages before setup

    if (msg.type === 'interrupt') {
      session.turnId += 1; // invalidate any in-flight LLM turn
      if (session.abortController) session.abortController.abort(); // stop the model call too
      return;
    }
    if (msg.type === 'dtmf') {
      log(`[relay] dtmf callSid=${session.callSid} digit=${msg.digit}`);
      if (msg.digit === '0' && isBusinessHours() && configOk.transferNumber) {
        sendText(ws, 'I will connect you to the owner now, please hold.');
        endRelay(ws, { action: 'transfer', reason: 'caller pressed 0 for a real person' });
      }
      return;
    }
    if (msg.type === 'error') {
      log(`[relay] error callSid=${session.callSid} ${JSON.stringify(msg)}`);
      return;
    }
    if (msg.type !== 'prompt' || !msg.last) return; // only act on finished utterances

    const userText = (msg.voicePrompt || '').trim();
    if (!userText) return;
    const turnId = ++session.turnId;
    log(`[relay] prompt callSid=${session.callSid} text=${truncate(userText, 120)}`);
    if (!session.intent) session.intent = guessIntent(userText);
    session.history.push({ role: 'user', content: userText });

    // A new prompt supersedes any in-flight LLM turn: abort it so it
    // stops consuming the model instead of running to completion in the
    // background (production logs once showed two overlapping 16s calls
    // from a single split utterance).
    if (session.abortController) session.abortController.abort();
    session.abortController = null;

    // Fast path: unmistakable transfer requests skip the LLM entirely
    // (it took 5-46s to produce a transfer tool call in production
    // logs). No hold line is spoken here: endRelay returns the call to
    // /connect-action, which says the hold line once.
    if (isBusinessHours() && configOk.transferNumber && isTransferRequest(userText, session)) {
      session.summaryNotes.push(`Transfer (fast path): ${userText}`);
      endRelay(ws, { action: 'transfer', reason: userText });
      return;
    }
    const controller = new AbortController();
    session.abortController = controller;

    if (!openai) {
      sendText(ws, "I'm sorry, I'm not able to answer right now. Please leave your name and number after the beep and the owner will call you back.");
      endRelay(ws, { action: 'message', caller_name: 'not given', callback_number: session.from || 'not given', message: userText });
      return;
    }

    let result;
    try {
      result = await askLLM(session, (token, isLast) => {
        if (closed || turnId !== session.turnId) return; // caller interrupted / hung up mid-reply
        ws.send(JSON.stringify({ type: 'text', token, last: isLast }));
      }, controller.signal);
    } catch (err) {
      if (session.abortController === controller) session.abortController = null;
      if (closed || turnId !== session.turnId) return; // superseded turn: stay silent
      if (err?.name === 'AbortError') return; // aborted turn: stay silent
      // Log the full SDK error: the bare message ("404 status code (no body)")
      // hid whether the failure was the model name, the endpoint, or the
      // key/project. The error body never contains the API key.
      const detail = { status: err.status, code: err.code, type: err.type, body: err.error || err.body || null };
      log(`[llm] FAILED callSid=${session.callSid} provider=${LLM_PROVIDER} model=${LLM_MODEL} error=${err.message} detail=${JSON.stringify(detail)}`);
      sendText(ws, "Sorry, I had trouble with that. Could you say it once more, or I can take a message for the owner.");
      return;
    }
    if (session.abortController === controller) session.abortController = null;
    if (closed || turnId !== session.turnId) return; // caller interrupted / hung up

    if (result.toolCall) {
      const { name, args } = result.toolCall;
      if (name === 'transfer_to_owner') {
        const reason = args.reason || session.intent || 'wants to speak to the owner';
        session.summaryNotes.push(`Transfer: ${reason}`);
        // No spoken hold line here: ending the Relay session returns the
        // call to /connect-action, which says the hold line once. Speaking
        // it here too added ~4s (TTS playback before session teardown)
        // and repeated the same line twice (production logs).
        endRelay(ws, { action: 'transfer', reason });
        return;
      }
      if (name === 'take_message') {
        session.callerName = args.caller_name && args.caller_name !== 'not given' ? args.caller_name : session.callerName;
        session.callbackNumber = args.callback_number && args.callback_number !== 'not given' ? args.callback_number : session.callbackNumber;
        session.messageText = args.message || '';
        session.intent = session.intent || guessIntent(args.message);
        if (!result.streamed) sendText(ws, "I'll pass your message to the owner and you will get a call back.");
        endRelay(ws, {
          action: 'message',
          caller_name: session.callerName || 'not given',
          callback_number: session.callbackNumber || session.from || 'not given',
          message: session.messageText,
        });
        return;
      }
    }

    if (result.text) {
      session.history.push({ role: 'assistant', content: result.text });
      // Remember transfer offers so a following "Yes, please." can take
      // the fast path instead of waiting on another model call.
      if (/connect you|transfer you|put you through/i.test(result.text)) session.transferOffered = true;
      if (!result.streamed) sendText(ws, result.text);
    }
  });

  ws.on('close', () => {
    closed = true;
    if (!session) return;
    // Backup finalisation: if the Relay socket closed without a handoff
    // (e.g. caller hung up), the /connect-action hook normally finalises
    // the SMS. This covers the case where it never arrives.
    setTimeout(() => {
      if (session && !session.smsSent && !session.transferred && session.history.length > 0) {
        finalizeCall(session, 'answered by AI, call ended').catch(() => {});
      }
    }, 5000);
  });
  ws.on('error', (err) => log(`[relay] ws error ${err.message}`));
});

// -------------------------------------------------------------------- start
server.listen(PORT, () => {
  log(`AI Receptionist listening on :${PORT} — health at /health`);
  log(`Business hours ${BUSINESS_HOURS_START}–${BUSINESS_HOURS_END} ${TIMEZONE}; transfer timeout ${TRANSFER_TIMEOUT_SECONDS}s`);
  log(`Configured: ${JSON.stringify(configOk)}`);
});
