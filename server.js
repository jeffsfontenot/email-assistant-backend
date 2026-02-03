const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { google } = require('googleapis');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// In-memory storage (use a database in production)
const users = new Map();
const emailCache = new Map();

// ===== CONFIGURATION =====
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3001/auth/callback';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

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
        checkInterval: 12, // default 12 hours
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

// Initiate Microsoft OAuth (placeholder)
app.get('/auth/microsoft', (req, res) => {
  const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${MICROSOFT_CLIENT_ID}&response_type=code&redirect_uri=${REDIRECT_URI}/microsoft&scope=https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.ReadWrite offline_access`;
  res.redirect(authUrl);
});

// Microsoft OAuth callback (placeholder)
app.get('/auth/callback/microsoft', async (req, res) => {
  // Similar implementation for Microsoft Graph API
  res.redirect(`${FRONTEND_URL}?error=microsoft_not_implemented`);
});

// ===== API ROUTES =====

// Middleware to verify user token
const authenticateUser = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: 'No authorization header' });
  }
  
  const token = authHeader.replace('Bearer ', '');
  const user = Array.from(users.values()).find(u => u.token === token);
  
  if (!user) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  
  req.user = user;
  next();
};

// Get emails
app.get('/api/emails', authenticateUser, async (req, res) => {
  try {
    const emails = emailCache.get(req.user.id) || [];
    res.json({ emails });
  } catch (error) {
    console.error('Error fetching emails:', error);
    res.status(500).json({ error: 'Failed to fetch emails' });
  }
});

// Delete emails
app.post('/api/emails/delete', authenticateUser, async (req, res) => {
  const { emailIds } = req.body;
  
  try {
    // Get emails to find which account they belong to
    const emails = emailCache.get(req.user.id) || [];
    const emailsToDelete = emails.filter(e => emailIds.includes(e.id));
    
    // Group emails by account
    const emailsByAccount = {};
    for (const email of emailsToDelete) {
      if (!emailsByAccount[email.account]) {
        emailsByAccount[email.account] = [];
      }
      emailsByAccount[email.account].push(email.id);
    }
    
    // Delete from each account
    for (const [accountEmail, ids] of Object.entries(emailsByAccount)) {
      const account = req.user.accounts.find(acc => acc.email === accountEmail);
      if (account && account.provider === 'google') {
        await deleteGmailMessages(account, ids);
      }
    }
    
    // Remove from cache
    const updatedEmails = emails.filter(e => !emailIds.includes(e.id));
    emailCache.set(req.user.id, updatedEmails);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting emails:', error);
    res.status(500).json({ error: 'Failed to delete emails' });
  }
});

// Update check interval
app.post('/api/settings/interval', authenticateUser, async (req, res) => {
  const { interval } = req.body;
  req.user.checkInterval = parseInt(interval);
  res.json({ success: true, interval });
});

// Update phone number
app.post('/api/settings/phone', authenticateUser, async (req, res) => {
  const { phone } = req.body;
  req.user.phone = phone;
  res.json({ success: true });
});

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
  
  // Clear emails from that account
  const emails = emailCache.get(req.user.id) || [];
  const updatedEmails = emails.filter(e => {
    const account = req.user.accounts.find(acc => acc.email === e.account);
    return account !== undefined;
  });
  emailCache.set(req.user.id, updatedEmails);
  
  res.json({ success: true });
});

// ===== EMAIL FETCHING & PROCESSING =====

async function fetchGmailMessages(account) {
  try {
    const oauth2Client = new google.auth.OAuth2(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      `${REDIRECT_URI}/google`
    );
    oauth2Client.setCredentials(account.tokens);
    
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    
    // Get unread messages
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread',
      maxResults: 10
    });
    
    if (!response.data.messages) {
      return [];
    }
    
    // Fetch full message details
    const emailPromises = response.data.messages.map(async (message) => {
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
      
      // Generate AI summary
      const summary = await generateEmailSummary(subject, body);
      
      return {
        id: message.id,
        sender: from.split('<')[0].trim(),
        subject: subject,
        summary: summary,
        body: body.substring(0, 500), // First 500 chars
        time: formatDate(date),
        account: account.email,
        webLink: `https://mail.google.com/mail/u/0/#inbox/${message.id}`
      };
    });
    
    return await Promise.all(emailPromises);
  } catch (error) {
    console.error('Error fetching Gmail messages:', error);
    return [];
  }
}

async function deleteGmailMessages(account, emailIds) {
  try {
    const oauth2Client = new google.auth.OAuth2(
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET,
      `${REDIRECT_URI}/google`
    );
    oauth2Client.setCredentials(account.tokens);
    
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    
    // Delete messages
    for (const emailId of emailIds) {
      await gmail.users.messages.trash({
        userId: 'me',
        id: emailId
      });
    }
  } catch (error) {
    console.error('Error deleting Gmail messages:', error);
    throw error;
  }
}

async function generateEmailSummary(subject, body) {
  try {
    // Truncate body to save tokens
    const truncatedBody = body.substring(0, 1000);
    
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 150,
        messages: [
          {
            role: 'user',
            content: `Summarize this email in one concise sentence (max 20 words):\n\nSubject: ${subject}\n\nBody: ${truncatedBody}`
          }
        ]
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        }
      }
    );
    
    return response.data.content[0].text;
  } catch (error) {
    console.error('Error generating summary:', error.message);
    return 'Unable to generate summary';
  }
}

// ===== SCHEDULED EMAIL CHECKING =====

// Check emails for all users
async function checkAllUsersEmails() {
  console.log('Checking emails for all users...');
  
  for (const [userId, user] of users) {
    try {
      let allEmails = [];
      
      // Check each linked account
      for (const account of user.accounts) {
        if (account.provider === 'google') {
          const emails = await fetchGmailMessages(account);
          allEmails = allEmails.concat(emails);
        }
        // Add Microsoft support here later
      }
      
      if (allEmails.length > 0) {
        emailCache.set(userId, allEmails);
        console.log(`Found ${allEmails.length} emails across ${user.accounts.length} account(s) for ${user.email}`);
      }
    } catch (error) {
      console.error(`Error checking emails for ${user.email}:`, error);
    }
  }
}

// Schedule cron jobs for different intervals
// Every 3 hours: 0 */3 * * *
// Every 6 hours: 0 */6 * * *
// Every 12 hours: 0 */12 * * *
// Every 24 hours: 0 0 * * *

// For demo/testing, check every 5 minutes
// For production, change to: '0 */12 * * *' (every 12 hours) or '0 0 * * *' (daily)
cron.schedule('*/5 * * * *', () => {
  checkAllUsersEmails();
});

// ===== HELPER FUNCTIONS =====

function generateToken() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

function formatDate(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now - date;
  const hours = Math.floor(diff / 3600000);
  
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${hours}h ago`;
  
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  
  return date.toLocaleDateString();
}

// ===== START SERVER =====

app.listen(PORT, () => {
  console.log(`✅ Email Assistant Backend running on port ${PORT}`);
  console.log(`📧 Frontend URL: ${FRONTEND_URL}`);
  console.log(`🔄 Scheduled email checks active`);
});
