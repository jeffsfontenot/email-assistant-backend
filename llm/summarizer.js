const { callMini, callMid } = require('./openaiClient');

/**
 * Check if email needs mid-tier based on rules
 * @param {string} subject
 * @param {string} body
 * @returns {boolean}
 */
function rulesBasedComplexityCheck(subject, body) {
  const combinedText = `${subject} ${body}`.toLowerCase();
  
  // Length check
  if (body.length > 1500) return true;
  
  // Multiple questions
  const questionCount = (combinedText.match(/\?/g) || []).length;
  if (questionCount >= 3) return true;
  
  // Complex keywords
  const complexKeywords = [
    'contract', 'legal', 'agreement', 'terms and conditions',
    'technical issue', 'bug report', 'error log', 'stack trace',
    'financial statement', 'invoice', 'payment terms',
    'multi-step', 'detailed instructions', 'comprehensive'
  ];
  
  if (complexKeywords.some(kw => combinedText.includes(kw))) return true;
  
  // Multiple bullet points or numbered lists
  const bulletCount = (body.match(/^\s*[-*•]\s/gm) || []).length;
  const numberCount = (body.match(/^\s*\d+\.\s/gm) || []).length;
  if (bulletCount >= 5 || numberCount >= 5) return true;
  
  return false;
}

/**
 * Main summarization function with 2-tier routing
 * @param {string} subject - Email subject
 * @param {string} body - Email body
 * @returns {Promise<object>} Summary object with routing info
 */
async function summarizeEmail(subject, body) {
  // First: rules-based check
  const rulesSuggestMidTier = rulesBasedComplexityCheck(subject, body);
  
  if (rulesSuggestMidTier) {
    // Skip mini, go straight to mid
    console.log(`[Summarizer] Rules suggest mid-tier for: "${subject.substring(0, 50)}..."`);
    const result = await callMid(subject, body);
    return {
      ...result,
      used_mid_tier: true,
      escalation_reason: 'rules_based'
    };
  }
  
  // Try mini model first
  console.log(`[Summarizer] Using mini model for: "${subject.substring(0, 50)}..."`);
  const miniResult = await callMini(subject, body);
  
  // Check if mini model requests escalation
  if (miniResult.needs_mid_tier === true) {
    console.log(`[Summarizer] Mini model requested escalation: ${miniResult.why}`);
    const midResult = await callMid(subject, body);
    return {
      ...midResult,
      used_mid_tier: true,
      escalation_reason: 'model_requested',
      model_reason: miniResult.why
    };
  }
  
  // Mini was sufficient
  return {
    ...miniResult,
    used_mid_tier: false,
    escalation_reason: null
  };
}

module.exports = {
  summarizeEmail
};
