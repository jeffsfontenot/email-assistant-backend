const { google } = require('googleapis');

/**
 * Check if email is marketing/promotional based on heuristics
 * @param {object} headers - Email headers
 * @param {string} body - Email body
 * @returns {boolean}
 */
function isMarketingEmail(headers, body) {
  const from = headers.find(h => h.name === 'From')?.value || '';
  const subject = headers.find(h => h.name === 'Subject')?.value || '';
  const listUnsubscribe = headers.find(h => h.name === 'List-Unsubscribe');
  
  const combinedText = `${from} ${subject} ${body}`.toLowerCase();
  
  // Has unsubscribe link
  if (listUnsubscribe) return true;
  
  // Common bulk/marketing indicators
  const marketingKeywords = [
    'unsubscribe', 'noreply', 'no-reply', 'newsletter',
    'promotional', 'marketing', 'offer', 'sale', 'discount',
    'bulk mail', 'mailing list', 'click here', 'limited time'
  ];
  
  if (marketingKeywords.some(kw => combinedText.includes(kw))) return true;
  
  // No-reply addresses
  if (from.includes('noreply') || from.includes('no-reply') || from.includes('donotreply')) {
    return true;
  }
  
  return false;
}

/**
 * Fetch unread Gmail messages (excluding promotions)
 * @param {object} account - Account object with tokens
 * @param {string} GOOGLE_CLIENT_ID
 * @param {string} GOOGLE_CLIENT_SECRET
 * @param {string} REDIRECT_URI
 * @returns {Promise<Array>} Array of raw email objects
 */
async function fetchUnreadGmail(account, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI) {
  try {
    const oauth2Client = new google.auth.OAuth2(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      `${REDIRECT_URI}/google`
    );
    oauth2Client.setCredentials(account.tokens);
    
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    
    // Query: unread AND NOT in promotions category
    const query = 'is:unread -category:promotions -category:social -category:forums';
    
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 20
    });
    
    if (!response.data.messages) {
      return [];
    }
    
    // Fetch full message details
    const emails = [];
    
    for (const message of response.data.messages) {
      const msg = await gmail.users.messages.get({
        userId: 'me',
        id: message.id,
        format: 'full'
      });
      
      const headers = msg.data.payload.headers;
      const subject = headers.find(h => h.name === 'Subject')?.value || 'No Subject';
      const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
      const date = headers.find(h => h.name === 'Date')?.value || '';
      
      // Extract email body
      let body = '';
      if (msg.data.payload.parts) {
        const textPart = msg.data.payload.parts.find(p => p.mimeType === 'text/plain');
        if (textPart && textPart.body.data) {
          body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
        }
      } else if (msg.data.payload.body.data) {
        body = Buffer.from(msg.data.payload.body.data, 'base64').toString('utf-8');
      }
      
      // Apply heuristic filter
      if (isMarketingEmail(headers, body)) {
        console.log(`[Gmail] Skipping marketing email: "${subject}"`);
        continue;
      }
      
      emails.push({
        messageId: message.id,
        from,
        subject,
        date,
        body,
        accountEmail: account.email
      });
    }
    
    return emails;
  } catch (error) {
    console.error('[Gmail] Error fetching messages:', error.message);
    return [];
  }
}

/**
 * Archive a Gmail message (remove INBOX label)
 * @param {object} account - Account object with tokens
 * @param {string} messageId - Gmail message ID
 * @param {string} GOOGLE_CLIENT_ID
 * @param {string} GOOGLE_CLIENT_SECRET
 * @param {string} REDIRECT_URI
 * @returns {Promise<boolean>} Success
 */
async function archiveGmail(account, messageId, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI) {
  try {
    const oauth2Client = new google.auth.OAuth2(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      `${REDIRECT_URI}/google`
    );
    oauth2Client.setCredentials(account.tokens);
    
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    
    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: {
        removeLabelIds: ['INBOX']
      }
    });
    
    console.log(`[Gmail] Archived message ${messageId}`);
    return true;
  } catch (error) {
    console.error('[Gmail] Error archiving message:', error.message);
    return false;
  }
}

module.exports = {
  fetchUnreadGmail,
  archiveGmail
};
