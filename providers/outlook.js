const axios = require('axios');

/**
 * Check if email is marketing/promotional based on heuristics
 * @param {object} message - Outlook message object
 * @returns {boolean}
 */
function isMarketingEmail(message) {
  const from = message.from?.emailAddress?.address || '';
  const subject = message.subject || '';
  const body = message.body?.content || '';
  
  const combinedText = `${from} ${subject} ${body}`.toLowerCase();
  
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
 * Fetch unread Outlook messages
 * @param {object} account - Account object with tokens
 * @returns {Promise<Array>} Array of raw email objects
 */
async function fetchUnreadOutlook(account) {
  try {
    // Graph API endpoint for unread messages in inbox
    const url = 'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages';
    const params = {
      $filter: 'isRead eq false',
      $select: 'id,from,subject,receivedDateTime,body',
      $top: 20,
      $orderby: 'receivedDateTime desc'
    };
    
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${account.tokens.access_token}`
      },
      params
    });
    
    const messages = response.data.value || [];
    const emails = [];
    
    for (const msg of messages) {
      // Apply heuristic filter
      if (isMarketingEmail(msg)) {
        console.log(`[Outlook] Skipping marketing email: "${msg.subject}"`);
        continue;
      }
      
      const body = msg.body?.content || '';
      // Strip HTML tags for plain text (simple approach)
      const plainBody = body.replace(/<[^>]*>/g, '');
      
      emails.push({
        messageId: msg.id,
        from: msg.from?.emailAddress?.address || 'Unknown',
        subject: msg.subject || 'No Subject',
        date: msg.receivedDateTime || '',
        body: plainBody,
        accountEmail: account.email
      });
    }
    
    return emails;
  } catch (error) {
    console.error('[Outlook] Error fetching messages:', error.message);
    return [];
  }
}

/**
 * Archive an Outlook message (move to Archive folder)
 * @param {object} account - Account object with tokens
 * @param {string} messageId - Outlook message ID
 * @returns {Promise<boolean>} Success
 */
async function archiveOutlook(account, messageId) {
  try {
    // First, get the Archive folder ID
    const foldersUrl = 'https://graph.microsoft.com/v1.0/me/mailFolders';
    const foldersResponse = await axios.get(foldersUrl, {
      headers: {
        'Authorization': `Bearer ${account.tokens.access_token}`
      }
    });
    
    const folders = foldersResponse.data.value || [];
    const archiveFolder = folders.find(f => f.displayName === 'Archive');
    
    if (!archiveFolder) {
      console.error('[Outlook] Archive folder not found');
      return false;
    }
    
    // Move message to Archive folder
    const moveUrl = `https://graph.microsoft.com/v1.0/me/messages/${messageId}/move`;
    await axios.post(moveUrl, 
      {
        destinationId: archiveFolder.id
      },
      {
        headers: {
          'Authorization': `Bearer ${account.tokens.access_token}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log(`[Outlook] Archived message ${messageId}`);
    return true;
  } catch (error) {
    console.error('[Outlook] Error archiving message:', error.message);
    return false;
  }
}

module.exports = {
  fetchUnreadOutlook,
  archiveOutlook
};
