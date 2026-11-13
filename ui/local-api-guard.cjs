'use strict';
// Shared boundary for both local applications. JSON is required before any
// state-changing manager is reached; a missing Origin is allowed for local CLI.
function apiRequestError(req) {
  const localHost = /^(127\.0\.0\.1|localhost|\[::1\])(:[0-9]+)?$/;
  const host = req.headers.host || '';
  if (!localHost.test(host) || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ||
      (req.headers.origin && req.headers.origin !== 'http://' + host)) {
    return {status: 403, error: 'Use the local Rehearsal server from its own origin.'};
  }
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) &&
      (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
    return {status: 415, error: 'State-changing API requests require application/json.'};
  }
  return null;
}
module.exports = {apiRequestError};
