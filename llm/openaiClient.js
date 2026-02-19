const OpenAI = require('openai');

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Model configuration
const MINI_MODEL = process.env.OPENAI_MODEL_MINI || 'gpt-5-mini';
const MID_MODEL = process.env.OPENAI_MODEL_MID || 'gpt-5';

/**
 * Call OpenAI with structured JSON output
 * @param {string} model - Model to use
 * @param {string} subject - Email subject
 * @param {string} body - Email body
 * @returns {Promise<object>} Parsed JSON response
 */
async function callOpenAI(model, subject, body) {
  const truncatedBody = body.substring(0, 2000); // Limit to 2000 chars
  
  const prompt = `Analyze this email and return a JSON object with the following structure:
{
  "summary_bullets": ["brief point 1", "brief point 2"],
  "action_items": ["action 1", "action 2"],
  "urgency": "low" | "med" | "high",
  "needs_mid_tier": true | false,
  "why": "brief reason if needs_mid_tier is true"
}

Rules:
- summary_bullets: 1-2 concise points (max 15 words each)
- action_items: 0-3 actionable items (max 12 words each), empty array if none
- urgency: "low" for newsletters/info, "med" for normal emails, "high" for time-sensitive
- needs_mid_tier: true if email is complex (multiple questions, technical, nuanced), false otherwise
- why: only needed if needs_mid_tier is true

Email:
Subject: ${subject}

Body: ${truncatedBody}`;

  try {
    const response = await openai.chat.completions.create({
      model: model,
      messages: [
        {
          role: 'system',
          content: 'You are an email analysis assistant. Always respond with valid JSON only, no markdown or explanations.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
      max_tokens: 500
    });

    const content = response.choices[0].message.content;
    return JSON.parse(content);
  } catch (error) {
    console.error(`Error calling OpenAI ${model}:`, error.message);
    // Return fallback structure
    return {
      summary_bullets: ['Unable to summarize - API error'],
      action_items: [],
      urgency: 'low',
      needs_mid_tier: false,
      why: ''
    };
  }
}

/**
 * Call mini model
 */
async function callMini(subject, body) {
  return callOpenAI(MINI_MODEL, subject, body);
}

/**
 * Call mid-tier model
 */
async function callMid(subject, body) {
  return callOpenAI(MID_MODEL, subject, body);
}

module.exports = {
  callMini,
  callMid,
  MINI_MODEL,
  MID_MODEL
};
