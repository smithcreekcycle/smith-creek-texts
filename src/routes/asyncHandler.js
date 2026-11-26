// Express 4 doesn't notice when an async route handler rejects: the request
// just hangs until the client gives up. Wrapping a handler in this passes the
// rejection to Express's error handler (server.js), which logs it and sends
// a generic 500.
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
