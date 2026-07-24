// The /files prefix middleware in app.js (registered ahead of every /files/* route)
// unconditionally sets Content-Type: application/octet-stream on every response under
// /files — success bodies as well as error bodies (Express's res.json() only sets
// Content-Type when it isn't already set, and this middleware always sets it first).
// supertest therefore can't auto-parse those JSON responses: res.body comes back as a
// raw Buffer and res.text is left undefined. Parse it ourselves. Shared by every test
// that reads a JSON body from a /files/* route.
export function jsonBody(res) {
  return JSON.parse(Buffer.isBuffer(res.body) ? res.body.toString('utf8') : res.text);
}
