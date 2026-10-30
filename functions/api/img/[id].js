import { authenticate } from "../../_lib/core.js";
// GET /api/img/<32 hex>  ->  a picture sent in a chat (signed-in users only)
export async function onRequestGet({ request, env, params }) {
  if (!(await authenticate(env.DB, request))) return new Response("Sign in first.", { status: 401 });
  if (!/^[0-9a-f]{32}$/.test(params.id)) return new Response("Not found.", { status: 404 });
  const row = await env.DB.prepare("SELECT mime, data FROM images WHERE id = ?").bind(params.id).first();
  if (!row) return new Response("Not found.", { status: 404 });
  return new Response(Uint8Array.from(atob(row.data), (c) => c.charCodeAt(0)), { headers: { "content-type": row.mime, "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
}
