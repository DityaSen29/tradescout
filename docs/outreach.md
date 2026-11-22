# Outreach

Sends approved drafts from the client's own Gmail, follows up on days 3, 7 and 14 in the same thread,
stops when the person answers, and works toward a booked meeting.

```
npx tsx src/outreach/server.ts --simulate   # http://127.0.0.1:8789/outreach, nothing is emailed
npx tsx src/outreach/server.ts              # http://127.0.0.1:8788/outreach, team test inboxes only
npx vitest run tests/outreach.test.ts
```

## Live setup

1. In the Google Cloud project, create an OAuth client of type **Desktop app**, enable the Gmail API and save the
   JSON as `~/.tradescout/google-desktop-client.json` (mode 600). A web client will not work here.
2. Set these in `.env`:

| Variable | Meaning |
|---|---|
| `OUTREACH_TEST_RECIPIENTS` | Exact addresses, comma separated, that may receive mail. Empty sends nothing. There is no wildcard. |
| `OUTREACH_ALERT_EMAIL` | Optional alert inbox. It must also be in the list above. |
| `OUTREACH_MAILBOX_DAILY_CAP` | Ceiling per mailbox, default 40. The ramp can only be lowered. |
| `GEMINI_API_KEY` | Classifier and next-action agent. Without it, rules decide and unclear replies go to a person. |
| `OUTREACH_LLM_MODEL` | Default `gemini-3.1-flash-lite`. |

3. Open the desk, click Connect Gmail, then choose that mailbox for the client.
4. Telegram is optional. Save a **new** bot's token as `~/.tradescout/telegram-token`, then click Link Telegram.
   Never use a token that another service polls.

## Before every send

1. Approved, text hash matches, address deliverable, not suppressed, on the test list, campaign not paused, under the cap.
2. The thread, the recipient, their colleagues and bounce notices are read. If that fails, nothing is sent.
3. Sent is searched for this email's key.
4. Step 1 runs again, then `ledger.executeAction` claims the action and sends.

An error after the claim is `unknown` and is never retried by itself. The worker marks it done if it finds it in
Sent. Only a person's "Check Sent and retry" can send again, and only after a second look and two minutes.

## What the runner decides, and what it can't

| Situation | Next action | Who sends |
|---|---|---|
| No reply | Follow-up: the model picks an angle and an unused product fact from conversation memory | full auto, or a person in approval mode |
| Interested | Booking message | a person, in both modes |
| Question | Answer made of product-file facts, or escalate | a person, in both modes |
| Not now, out of office | Check back on the date they gave | a person, in both modes |
| Not interested, unsubscribe, hard bounce | Stop. The last two also suppress | nobody |
| Wrong person, unclear, low confidence | Escalate | a person |

The model returns an action, an angle and fact ids. Code writes the email from fixed lines and the seller's facts.
Each lead's 0-100 score is rebuilt from fit and behaviour, with its reasons, and decides who gets the day's cap first.
Known names, contact details, greetings, sign-offs and amounts are redacted before a model call. A name nobody told
us about, in the middle of a sentence, can get through.

## Caps

10, 20, 30, then 40 a day by week. Failing or unknown SPF means 0. Failing DKIM or DMARC means 5. A warning halves
the cap. Three or more bounces that exceed 3% over 7 days means 0. A missing DKIM key under common selector names
is a warning, because DKIM selectors can't be listed from DNS.

## Wiring into the main server

```ts
import { executeDraft, Outreach, outreachRoutes, startWorker } from "../outreach/index.js";

const outreach = new Outreach(ledger);
const handleOutreach = outreachRoutes(ledger, outreach);
startWorker(outreach);
// first line inside the request handler:
if (await handleOutreach(req, res)) return;
// in executeApproved, for kind email_draft, in place of writing the .eml:
return executeDraft(ledger, actionId);
```

The two executors must not both stay wired: an action written to `.eml` counts as executed and will not be emailed.

## API

`GET /api/outreach` returns `mailboxes` (health, cap), `campaigns` (mode, product facts), `drafts` (exact outgoing
body, hash, plan, why blocked), `conversations` (score, signals, replies, next due), `alerts` and `channels`.
The write endpoints are listed at the top of `src/outreach/routes.ts`. The page at `/outreach` uses nothing else,
so it can be replaced.

## Not built

Automatic meeting detection (a person marks it booked), Gmail push (it polls each minute), one-click unsubscribe
over HTTPS (reply or mailto only), editing a draft, and sending to real buyers (blocked on purpose today).
Alert email goes from the first connected mailbox. Buyer intelligence is feature 2 and is not part of this module.
