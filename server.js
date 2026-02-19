const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
require('dotenv').config();

// Import new modules
const { summarizeEmail } = require('./llm/summarizer');
const { fetchUnreadGmail, archiveGmail } = require('./providers/gmail');
const { fetchUnreadOutlook, archiveOutlook } = require('./providers/outlook');
const { getCached, setCached, getLastOpen, setLastOpen } = require('./store/cache');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// In-memory storage for users (auth tokens)
const users = new Map();

// ===== CONFIGURATION =====
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'https://email-assistant-backend-production-f46e.up.railway.app/auth/callback';
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://email-assistant-frontend-qcss.vercel.app';

// OAuth2 clients
const googleOAuth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  `${REDIRECT_URI}/google`
);

// ===== AUTHENTICATION ROUTES =====

// Initiate Google OAuth
app.get('/auth/google', (req, res) => {
  const authUrl = googleOAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/userinfo.email'
    ],
    prompt: 'consent'
  });
  res.redirect(authUrl);
});

// Google OAuth callback
app.get('/auth/callback/google', async (req, res) => {
  const { code } = req.query;
  
  try {
    const { tokens } = await googleOAuth2Client.getToken(code);
    googleOAuth2Client.setCredentials(tokens);
    
    // Get user email
    const oauth2 = google.oauth2({ version: 'v2', auth: googleOAuth2Client });
    const { data } = await oauth2.userinfo.get();
    
    // Create or update user session
    const userId = data.email;
    const userToken = generateToken();
    
    let user = users.get(userId);
    
    if (!user) {
      // New user - create account
      user = {
        id: userId,
        email: data.email,
        token: userToken,
        accounts: []
      };
      users.set(userId, user);
    }
    
    // Add this Google account if not already linked
    const accountExists = user.accounts.some(acc => acc.email === data.email && acc.provider === 'google');
    if (!accountExists) {
      user.accounts.push({
        email: data.email,
        provider: 'google',
        tokens: tokens,
        id: generateToken()
      });
    } else {
      // Update existing account tokens
      const account = user.accounts.find(acc => acc.email === data.email && acc.provider === 'google');
      account.tokens = tokens;
    }
    
    // Redirect to frontend with token
    res.redirect(`${FRONTEND_URL}?token=${user.token}&email=${data.email}`);
  } catch (error) {
    console.error('Auth error:', error);
    res.redirect(`${FRONTEND_URL}?error=auth_failed`);
  }
});

// ===== MIDDLEWARE =====

function authenticateUser(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'No authorization token' });
  }
  
  const token = authHeader.split(' ')[1];
  const user = Array.from(users.values()).find(u => u.token === token);
  
  if (!user) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  req.user = user;
  next();
}

// ===== API ROUTES =====

// Get all linked accounts
app.get('/api/accounts', authenticateUser, async (req, res) => {
  const accounts = req.user.accounts.map(acc => ({
    id: acc.id,
    email: acc.email,
    provider: acc.provider
  }));
  res.json({ accounts });
});

// Remove a linked account
app.post('/api/accounts/remove', authenticateUser, async (req, res) => {
  const { accountId } = req.body;
  req.user.accounts = req.user.accounts.filter(acc => acc.id !== accountId);
  res.json({ success: true });
});

// **NEW** Sync emails on app open
app.post('/sync/on_open', authenticateUser, async (req, res) => {
  console.log(`[Sync] User ${req.user.email} opened app - fetching new emails`);
  
  try {
    const allEmails = [];
    
    // Fetch from all linked accounts
    for (const account of req.user.accounts) {
      let rawEmails = [];
      
      if (account.provider === 'google') {
        rawEmails = await fetchUnreadGmail(
          account,
          GOOGLE_CLIENT_ID,
          GOOGLE_CLIENT_SECRET,
          REDIRECT_URI
        );
      } else if (account.provider === 'outlook') {
        rawEmails = await fetchUnreadOutlook(account);
      }
      
      // Summarize each email (with caching)
      for (const email of rawEmails) {
        // Check cache first
        const cached = await getCached(account.provider, email.messageId, email.body);
        
        if (cached) {
          console.log(`[Sync] Using cached summary for: "${email.subject}"`);
          allEmails.push({
            provider: account.provider,
            messageId: email.messageId,
            from: email.from,
            subject: email.subject,
            date: email.date,
            account: email.accountEmail,
            ...cached
          });
        } else {
          // Generate new summary
          console.log(`[Sync] Summarizing: "${email.subject}"`);
          const summary = await summarizeEmail(email.subject, email.body);
          
          // Cache it
          await setCached(account.provider, email.messageId, email.body, summary);
          
          allEmails.push({
            provider: account.provider,
            messageId: email.messageId,
            from: email.from,
            subject: email.subject,
            date: email.date,
            account: email.accountEmail,
            summary_bullets: summary.summary_bullets,
            action_items: summary.action_items,
            urgency: summary.urgency,
            used_mid_tier: summary.used_mid_tier
          });
        }
      }
    }
    
    // Update last open timestamp
    await setLastOpen(req.user.id);
    
    console.log(`[Sync] Returning ${allEmails.length} emails to user`);
    res.json({ emails: allEmails });
  } catch (error) {
    console.error('[Sync] Error:', error);
    res.status(500).json({ error: 'Failed to sync emails' });
  }
});

// **NEW** Archive email
app.post('/emails/:provider/:messageId/archive', authenticateUser, async (req, res) => {
  const { provider, messageId } = req.params;
  
  console.log(`[Archive] Archiving ${provider} message ${messageId}`);
  
  try {
    // Find the account for this provider
    const account = req.user.accounts.find(acc => acc.provider === provider);
    
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    
    let success = false;
    
    if (provider === 'gmail') {
      success = await archiveGmail(
        account,
        messageId,
        GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET,
        REDIRECT_URI
      );
    } else if (provider === 'outlook') {
      success = await archiveOutlook(account, messageId);
    }
    
    if (success) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: 'Archive failed' });
    }
  } catch (error) {
    console.error('[Archive] Error:', error);
    res.status(500).json({ error: 'Archive failed' });
  }
});

// Update settings
app.post('/api/settings', authenticateUser, async (req, res) => {
  const { checkInterval } = req.body;
  req.user.checkInterval = parseInt(checkInterval);
  res.json({ success: true });
});

// ===== HELPER FUNCTIONS =====

function generateToken() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

// ===== START SERVER =====

app.listen(PORT, () => {
  console.log(`✅ Email Assistant Backend running on port ${PORT}`);
  console.log(`📧 Frontend URL: ${FRONTEND_URL}`);
  console.log(`🔄 On-open sync enabled (no background scheduling)`);
});
