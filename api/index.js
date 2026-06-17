// Vercel serverless entrypoint.
// Re-exports the Express app (server.js exports `app` without calling listen()).
module.exports = require('../server');
