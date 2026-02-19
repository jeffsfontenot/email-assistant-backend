const crypto = require('crypto');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');

// Initialize lowdb with file adapter
const adapter = new JSONFile('cache.json');
const db = new Low(adapter, {});

// Initialize database structure
async function initDB() {
  await db.read();
  db.data ||= { summaries: {}, lastOpen: {} };
  await db.write();
}

initDB();

/**
 * Generate hash of email body for cache key
 * @param {string} body
 * @returns {string}
 */
function hashBody(body) {
  return crypto.createHash('sha256').update(body).digest('hex').substring(0, 16);
}

/**
 * Generate cache key
 * @param {string} provider
 * @param {string} messageId
 * @param {string} body
 * @returns {string}
 */
function getCacheKey(provider, messageId, body) {
  const bodyHash = hashBody(body);
  return `${provider}:${messageId}:${bodyHash}`;
}

/**
 * Check if email is already cached
 * @param {string} provider
 * @param {string} messageId
 * @param {string} body
 * @returns {object|null} Cached summary or null
 */
async function getCached(provider, messageId, body) {
  await db.read();
  const key = getCacheKey(provider, messageId, body);
  return db.data.summaries[key] || null;
}

/**
 * Store summary in cache
 * @param {string} provider
 * @param {string} messageId
 * @param {string} body
 * @param {object} summary
 */
async function setCached(provider, messageId, body, summary) {
  await db.read();
  const key = getCacheKey(provider, messageId, body);
  db.data.summaries[key] = {
    ...summary,
    cachedAt: new Date().toISOString()
  };
  await db.write();
}

/**
 * Get last open timestamp for user
 * @param {string} userId
 * @returns {string|null} ISO timestamp or null
 */
async function getLastOpen(userId) {
  await db.read();
  return db.data.lastOpen[userId] || null;
}

/**
 * Update last open timestamp for user
 * @param {string} userId
 */
async function setLastOpen(userId) {
  await db.read();
  db.data.lastOpen[userId] = new Date().toISOString();
  await db.write();
}

/**
 * Clean old cache entries (older than 30 days)
 */
async function cleanOldCache() {
  await db.read();
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  
  for (const [key, entry] of Object.entries(db.data.summaries)) {
    if (new Date(entry.cachedAt).getTime() < thirtyDaysAgo) {
      delete db.data.summaries[key];
    }
  }
  
  await db.write();
  console.log('[Cache] Cleaned old entries');
}

// Run cleanup once per day
setInterval(cleanOldCache, 24 * 60 * 60 * 1000);

module.exports = {
  getCached,
  setCached,
  getLastOpen,
  setLastOpen
};
