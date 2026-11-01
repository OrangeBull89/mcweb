import { authenticate } from "../../_lib/core.js";
// GET /api/si/<serverId>?v=<n>  ->  that server's icon (signed-in users only)
export async function onRequestGet({ request, env, params }) {
  if (!(await authenticate(env.DB, request))) return new Response("Sign in first.", { status: 401 });
  const row = await env.DB.prepare("SELECT icon FROM servers WHERE id = ?").bind(Number(params.id)).first();
  const m = row?.icon && /^data:(image\/(?:webp|jpeg));base64,(.+)$/.exec(row.icon);
  if (!m) return new Response("No icon.", { status: 404 });
  return new Response(Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0)), { headers: { "content-type": m[1], "cache-control": "private, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
}
