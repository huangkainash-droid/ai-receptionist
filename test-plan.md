# Test Plan — AI Receptionist

Run these in order, from a phone that is **not** the business line and
**not** the owner's personal mobile (use a second phone, another
person's phone, or a Google Voice number). Keep the server logs open
(`railway logs`, or the terminal where `npm start` is running) and
the owner's personal mobile nearby.

Before you start:
- [ ] `GET /health` returns `"ok": true`, `configured.twilio: true`,
      `configured.llm: true`, `configured.personalMobile: true`,
      `configured.transferNumber: true`.
- [ ] Twilio number's Voice webhook is `https://<domain>/voice`.
- [ ] `*72` forwarding from the business line to the Twilio number is
      ON (or, for tests 1–2, call the Twilio number directly).
- [ ] Note the current time in the configured TIMEZONE and whether
      transfer should be available (BUSINESS_HOURS_START–
      BUSINESS_HOURS_END).

## 0. Config check — the transfer loop guard (no call needed)

Set `TRANSFER_NUMBER` to the business line (BUSINESS_NUMBER) in `.env`
(temporarily), restart, and check the startup log / `GET /health`:
`configured.transferNumber` must be `false` and the log must say
warm transfer is disabled. Then restore `TRANSFER_NUMBER` to the
personal mobile and restart. **This is the test that proves the
transfer loop cannot happen.** Repeat with `TRANSFER_NUMBER` set to
the Twilio number itself — same result expected.

## 1. Price question (AI answers, no transfer)

- **Call** the business line. **Say:** "How much does [YOUR PRODUCT
  OR SERVICE] cost, and is there a discount?" — use a question whose
  answer is in knowledge-base.md.
- **Expect:** AI identifies as an AI assistant, quotes the price and
  terms **exactly as written in knowledge-base.md**, nothing else
  invented. Asks if there is anything else.
- **Hang up.** **Expect:** the owner gets an SMS summary within a
  minute: caller number, "pricing", outcome "answered by AI".
- **Fail if:** any other price is quoted, or no SMS arrives.
- **Latency check (all tests):** the AI should start replying within
  about 1–2 seconds of you finishing a sentence. A pause of 5+
  seconds means the model endpoint is slow — on Gemini, check the
  project's billing tier first (free tier measured 5–12s per turn;
  see README "Latency"), and check `[llm] done … ttfbMs=…` in the
  server logs.

## 2. Address question (only listed addresses may be quoted)

- **Call** the business line. **Say:** "Where are you located?"
- **Expect:** the AI quotes **only** an address that is listed in
  knowledge-base.md, plus hours if asked.
- **Then say:** "And what is the address of [A LOCATION THAT IS NOT
  LISTED IN THE KNOWLEDGE BASE]?"
- **Expect:** AI says it does not have that address and offers to
  take a message. It must **not** state a street address that is not
  in the knowledge base.
- **Fail if:** the AI invents any street address.

## 3. Warm transfer in hours (inside BUSINESS_HOURS_START–END)

- **When:** inside business hours. **Call** the business line.
  **Say:** "I need to speak to the owner about a refund."
- **Expect:** the phone system says "Please hold while I connect
  you to the owner" once (the AI itself says nothing first — the
  transfer fast-path skips the model for this request). Hold music
  plays. The owner's **personal mobile** rings
  (not the business line) and they hear a one-line whisper: business
  name + caller number + topic + "Press 1 to accept".
- **Owner presses 1.** **Expect:** owner and caller can talk.
  Owner hangs up. **Expect:** SMS summary: outcome "transferred to
  the owner".
- **Fail if:** the business line rings instead of the personal
  mobile, the whisper is missing, or the caller hears the AI again
  after the owner answers.

## 4. After-hours message (outside BUSINESS_HOURS_START–END)

- **When:** before BUSINESS_HOURS_START or after BUSINESS_HOURS_END.
  **Call** the business line. **Say:** "I want to speak to the owner."
- **Expect:** AI does **not** offer a transfer. It asks for name,
  callback number, and the question. Give a name and a callback
  number, then hang up.
- **Expect:** SMS summary to the owner: name, callback number,
  message, outcome "message taken by AI". No call to the owner's
  mobile.
- **Fail if:** the owner's phone rings, or the AI says it will
  connect you.

## 5. No-answer transfer fallback (in hours, owner does not pick up)

- **When:** inside business hours. The owner's personal mobile is on
  silent / not answered (agree this with the owner first — do not
  just let it ring unannounced).
- **Call** the business line. **Say:** "Can I speak to the owner?"
- **Expect:** the phone system says it will connect you; hold music;
  the owner's phone rings and is **not** answered. After ~25 seconds the caller
  hears: "The owner isn't available right now. Please leave your
  name, callback number, and a brief message after the beep." Leave
  a short message.
- **Expect:** SMS summary to the owner: outcome "message taken
  (voicemail)", with the transcribed message if available.
- **Fail if:** the caller is left in hold music for more than
  ~40 seconds, or is disconnected with no chance to leave a message.

## 6. Unknown question (AI must not invent)

- **Call** the business line. **Say:** a question whose answer is
  deliberately NOT in knowledge-base.md — e.g. "What is the name of
  the person who handles [SOMETHING SPECIFIC], and can you hold a
  spot for me?"
- **Expect:** AI says it does not have that information, does not
  invent a name or promise a held spot, and offers to take a message
  for the owner (in hours: offers a transfer if you ask for a
  person; out of hours: message only).
- **Fail if:** the AI names a person, promises a spot, or promises
  a refund/credit.

## After the 6 tests

- [ ] All 6 SMS summaries arrived on the owner's personal mobile,
      each with the right caller number and outcome.
- [ ] No call ever rang the business line as a transfer target.
- [ ] Undo test: dial `*73` from the business line, call the
      business number from another phone, and confirm it rings the
      carrier line as before. Re-enable with `*72` if going live.
- [ ] If any test failed, note the call SID from the server logs
      (`[voice] inbound callSid=…`) and what was heard, before
      changing anything.
