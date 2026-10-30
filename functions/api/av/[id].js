import { authenticate } from "../../_lib/core.js";
// GET /api/av/<userId>?v=<n>  ->  that user's avatar bytes (signed-in users only)
export async function onRequestGet({ request, env, params }) {
  if (!(await authenticate(env.DB, request))) return new Response("Sign in first.", { status: 401 });
  const row = await env.DB.prepare("SELECT avatar FROM users WHERE id = ?").bind(Number(params.id)).first();
  const m = row?.avatar && /^data:(image\/(?:webp|jpeg));base64,(.+)$/.exec(row.avatar);
  if (!m) return new Response("No avatar.", { status: 404 });
  return new Response(Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)), { headers: { "content-type": m[1], "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
}
