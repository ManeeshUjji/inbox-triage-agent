# Inbox Triage Agent

An n8n automation pipeline that watches a Gmail inbox, uses an LLM to classify and extract structured data from each email, logs the result to Airtable, and posts a formatted Slack card for a human to review and approve — without ever auto-sending a reply.

**Stack:** n8n · Gemini 2.5 Flash-Lite · Airtable · Slack · JavaScript

---

## What it does

1. **Polls Gmail every minute** for new unread emails using a Schedule + Gmail "Get Many" pattern (see [Engineering decisions](#engineering-decisions) below for why this matters).
2. **Classifies each email** via Gemini 2.5 Flash-Lite using structured outputs, extracting:
   - `category` — one of `sales_lead`, `support`, `billing`, `spam`, `other`
   - `name` and `company` — extracted from email content, or `null` if not found
   - `intent` — one-sentence summary of what the sender wants
   - `urgency` — integer 1–5 (5 = outages, legal threats, explicit deadlines today)
   - `draft_reply` — a short professional reply the human can edit and send
3. **Validates every model response** against a strict schema before anything is written downstream. Malformed or unparseable responses are routed to a separate Slack alert — nothing bad ever reaches Airtable silently.
4. **Logs valid results to Airtable** with status `pending` for human review.
5. **Posts a formatted Slack card** showing category, urgency, sender, intent summary, and the suggested reply in a blockquote — ready to approve at a glance.
6. **Marks each email as read** after processing so the unread inbox acts as a reliable work queue.
7. **Never auto-sends.** Every draft sits in Airtable as `pending` until a human approves it. This is intentional — it is the point.

---

## Pipeline architecture

```
Schedule Trigger (every 1 min)
  └─► Gmail: Get Many (unread only)
        └─► Code: Build Gemini body
              └─► HTTP Request: Gemini 2.5 Flash-Lite
                    └─► Code: Validate response
                          └─► IF: is_valid?
                                ├─ TRUE  ─► Airtable: Create record
                                │               └─► Slack: Post card
                                │                     └─► Gmail: Mark as read
                                └─ FALSE ─► Slack: Post error alert
                                                └─► Gmail: Mark as read
```

The false branch fires when the model returns something the validation layer rejects — malformed JSON, an out-of-range urgency, an empty draft reply, etc. In practice this is rare because the structured-output schema constrains Gemini's output, but the path is there and tested.

---

## Airtable schema

Table name: `Emails`

| Field | Type | Notes |
|---|---|---|
| `category` | Single line text | One of the 5 allowed values |
| `name` | Single line text | Nullable |
| `company` | Single line text | Nullable |
| `intent` | Long text | One-sentence summary |
| `urgency` | Number | Integer 1–5 |
| `draft_reply` | Long text | Human edits before sending |
| `status` | Single select | Starts as `pending` |
| `created_time` | Created time | Auto-stamped by Airtable |

---

## Slack card format

```
📥 New sales_lead email — urgency 2/5

From:         Dana Chen <dana@brightcart.com>
Company:      BrightCart
Subject:      Need automation help
What they want: The sender is inquiring about automating their invoicing workflow.

Suggested reply (review before sending):
> Hi Dana, thanks for reaching out. I'd love to discuss how we can
> automate your invoicing. Are you free for a quick call this week?

Logged to Airtable as pending. Approve or edit the draft before replying.
```

---

## Engineering decisions

### Why Schedule + Get Many instead of the Gmail Trigger node

The native n8n Gmail Trigger node has a documented timestamp-based deduplication bug: when multiple emails arrive within the same poll window, the node collapses them into a single execution, dropping all but the latest. This is a known issue tracked across multiple n8n GitHub issues (#4272, #10470).

The replacement pattern used here:
- A **Schedule Trigger** fires every minute.
- A **Gmail "Get Many"** node fetches all currently unread messages (up to 20 per poll).
- n8n's built-in **item splitting** processes each email as a separate item through the pipeline.
- A **Gmail "Mark as Read"** node at the end of both branches marks each processed email as read.

This makes the unread inbox a reliable work queue: unread = not yet processed, read = done. Nothing collapses, nothing double-processes, nothing is dropped under load.

### Why validate every model response

Gemini's structured-output schema (`responseSchema`) significantly reduces malformed output — in testing across 10+ varied emails, it never returned unparseable JSON. But the schema is a hint, not a guarantee. The validation layer (`validate_response.js`) independently checks every response before anything is written downstream:

- Category must be in the allowed enum.
- Intent must be a non-empty string.
- Urgency must be an integer 1–5.
- Draft reply must be a non-empty string.
- Name and company are allowed to be `null`.

If any check fails, `is_valid` is set to `false` and the item routes to the false branch — a Slack alert fires, nothing is written to Airtable, and the email is still marked as read so it doesn't re-enter the queue. Bad AI output triggers a human alert instead of silently corrupting data.

### Why drafts are never auto-sent

The human-in-the-loop approval step is intentional, not a limitation. Automatically sending AI-drafted replies on behalf of a business is a reliability and trust problem — one wrong auto-reply to a billing dispute or a key client causes more damage than the time saved. The agent's job is to eliminate the *reading and drafting* work, not the *judgment* work. A human spends 2 minutes reviewing a Slack queue instead of 30 minutes writing from scratch.

---

## Setup

### Prerequisites
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed
- A Google Cloud project with the Gmail API enabled and OAuth2 credentials configured
- A [Gemini API key](https://aistudio.google.com/app/apikey) (free tier, no credit card)
- An Airtable account with a base matching the schema above
- A Slack app with `chat:write` scope installed to your workspace

### Run n8n locally

```bash
docker volume create n8n_data

docker run -d \
  --name n8n \
  -p 5678:5678 \
  -v n8n_data:/home/node/.n8n \
  -e GENERIC_TIMEZONE="America/New_York" \
  -e TZ="America/New_York" \
  -e N8N_SECURE_COOKIE=false \
  docker.n8n.io/n8nio/n8n
```

Open `http://localhost:5678`.

### Import the workflow
1. In n8n, go to **Workflows → Import** and upload `workflow/inbox_triage_agent.json`.
2. Add your credentials under **Settings → Credentials**:
   - Gmail OAuth2
   - Airtable Personal Access Token
   - Slack Bot Token
3. In the HTTP Request node, replace `YOUR_KEY` in the Gemini URL with your API key.
4. Update the Airtable node with your base ID and table name.
5. Update the Slack nodes with your channel name.
6. **Publish** the workflow.

See `.env.example` for all required credentials and where to obtain them.

---

## Local development / restarting

```bash
# Start the container after a machine reboot
docker start n8n

# Stop it when done
docker stop n8n
```

The workflow and all credentials persist in the `n8n_data` volume across restarts.

---

## Limitations and production notes

- **Not 24/7 on a local machine.** The container only polls while your machine and Docker are running. For round-the-clock operation, deploy n8n to a cloud host (Railway, Render, or a cheap VPS).
- **Snippet truncation.** Gmail's `snippet` field is ~200 characters. Long emails where key context (e.g. company name in a signature) appears after the truncation point will have those fields extracted as `null`. Mitigate by keeping the most important context in the first paragraph, or switch to full-body parsing by disabling Simplify on the Gmail node.
- **Free-tier Gemini.** Gemini 2.5 Flash-Lite free tier allows ~1,500 requests/day. For higher volume, switch to a paid tier or swap the HTTP Request node for the OpenAI or Claude API — the prompt and schema are provider-agnostic.
- **Gmail polling, not push.** The 1-minute poll means up to 60 seconds of latency between email arrival and processing. For near-real-time processing at scale, replace the Schedule + Gmail pattern with Gmail Push Notifications via Google Cloud Pub/Sub.

---

## License

MIT
