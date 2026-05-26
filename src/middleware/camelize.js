'use strict';

/**
 * FlexFlow — camelizeKeys middleware (Phase 4.5)
 * Converts snake_case response fields to camelCase for React Native frontend.
 * Applied as a global response interceptor on all JSON responses.
 */

function camelize(str) {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function camelizeKeys(obj) {
  if (Array.isArray(obj)) return obj.map(camelizeKeys);
  if (obj !== null && typeof obj === 'object' && !(obj instanceof Date)) {
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => [camelize(k), camelizeKeys(v)])
    );
  }
  return obj;
}

/**
 * Express middleware: intercepts res.json() and camelizes all keys.
 * Attach with: app.use(camelizeMiddleware)
 */
function camelizeMiddleware(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = (data) => {
    return originalJson(camelizeKeys(data));
  };
  next();
}

module.exports = { camelizeMiddleware, camelizeKeys };
