// PHASE 5: Parse Gemini's response, validate it against our schema, and flag
// anything malformed so it can be routed to a safe-fail branch instead of
// silently writing garbage downstream. This is the reliability core of the agent.
const response = $input.item.json;

// --- Step 1: Safely dig out the model's text output ---------------------------
// Gemini nests the actual answer at candidates[0].content.parts[0].text.
// Any of these can be missing if the API misbehaves, so we guard every hop.
let rawText;
try {
  rawText = response.candidates[0].content.parts[0].text;
} catch (e) {
  rawText = null;
}

// --- Step 2: Parse the text as JSON inside a try/catch ------------------------
// Even with responseSchema set, we never assume the body is valid JSON.
let parsed = null;
let parseError = null;
if (rawText) {
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    parseError = `JSON parse failed: ${e.message}`;
  }
} else {
  parseError = 'No text found in Gemini response (unexpected response shape).';
}

// --- Step 3: Validate the parsed object against our expected schema -----------
const allowedCategories = ['sales_lead', 'support', 'billing', 'spam', 'other'];
const validationErrors = [];
if (parsed) {
  if (!allowedCategories.includes(parsed.category)) {
    validationErrors.push(`category "${parsed.category}" not in allowed list`);
  }
  if (typeof parsed.intent !== 'string' || parsed.intent.trim() === '') {
    validationErrors.push('intent missing or empty');
  }
  if (!Number.isInteger(parsed.urgency) || parsed.urgency < 1 || parsed.urgency > 5) {
    validationErrors.push(`urgency "${parsed.urgency}" is not an integer 1-5`);
  }
  if (typeof parsed.draft_reply !== 'string' || parsed.draft_reply.trim() === '') {
    validationErrors.push('draft_reply missing or empty');
  }
  // name/company may be null by design — we don't fail on those.
}

// --- Step 4: Decide validity and build a clean, flat output -------------------
const isValid = parsed !== null && validationErrors.length === 0;

// Pull the original email fields from the Gmail node directly, so they
// travel forward to Airtable/Slack regardless of what the HTTP node returned.
const email = $('Get many messages').item.json;

// Carry message_id forward so mark-as-read nodes can use it downstream.
const messageId = email.id;

return {
  json: {
    is_valid: isValid,
    error_reason: isValid
      ? null
      : [parseError, ...validationErrors].filter(Boolean).join('; '),
    // Original email context, carried forward for downstream nodes:
    email_from:    email.From    ?? null,
    email_subject: email.Subject ?? null,
    email_snippet: email.snippet ?? null,
    // Message ID for mark-as-read nodes at the end of each branch:
    message_id: messageId,
    // The cleaned, validated classification fields:
    category:    parsed?.category    ?? null,
    name:        parsed?.name        ?? null,
    company:     parsed?.company     ?? null,
    intent:      parsed?.intent      ?? null,
    urgency:     parsed?.urgency     ?? null,
    draft_reply: parsed?.draft_reply ?? null,
    // Raw model text kept for debugging:
    _raw_model_text: rawText,
  },
};
