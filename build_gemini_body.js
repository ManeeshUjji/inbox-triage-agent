// Build the Gemini request body cleanly in code, avoiding JSON-in-JSON escaping issues.
// This runs once per incoming email item from the Gmail "Get Many" node.
const email = $input.item.json;

// Pull the fields the Gmail node gives us, with safe fallbacks.
const from    = email.From    || 'unknown';
const subject = email.Subject || '(no subject)';
const content = email.snippet || '(no content)';

// The instruction prompt. Using a normal JS template literal — newlines are fine here
// because we are NOT inside a JSON string; we build a real object below.
const prompt = `You are an email triage assistant for a small business. Analyze the email below and return a JSON object with exactly these fields:
- category: one of [sales_lead, support, billing, spam, other]
- name: the sender's first and last name, or null if not found
- company: the sender's company name, or null if not found
- intent: one sentence describing what the sender wants
- urgency: integer 1-5 where 1=not urgent, 5=extremely urgent
- draft_reply: a short, professional reply draft the human can edit and send

Rules:
- Return ONLY valid JSON, no explanation, no markdown, no code fences
- Never fabricate information not present in the email
- If a field cannot be determined, use null
- urgency 5 is reserved for legal threats, outages, or explicit deadlines today

Email to analyze:
From: ${from}
Subject: ${subject}
Content: ${content}`;

// Build the full Gemini request body as a real JS object.
// n8n will serialize this to valid JSON automatically — no manual escaping needed.
const geminiBody = {
  contents: [
    {
      parts: [
        { text: prompt }
      ]
    }
  ],
  generationConfig: {
    responseMimeType: "application/json",
    responseSchema: {
      type: "object",
      properties: {
        category:    { type: "string", enum: ["sales_lead", "support", "billing", "spam", "other"] },
        name:        { type: "string", nullable: true },
        company:     { type: "string", nullable: true },
        intent:      { type: "string" },
        urgency:     { type: "integer" },
        draft_reply: { type: "string" }
      },
      required: ["category", "name", "company", "intent", "urgency", "draft_reply"]
    }
  }
};

// Pass both the original email fields (so later nodes still have them)
// and the Gemini request body.
return {
  json: {
    ...email,
    geminiBody: geminiBody
  }
};
