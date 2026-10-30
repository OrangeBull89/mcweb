export async function onRequestGet({ env }) {
  const out = { databaseConnected: !!env.DB, tablesCreated: false, signUpPhraseSet: !!env.SIGNUP_PHRASE, headAdminNameSet: !!env.HEAD_ADMIN && env.HEAD_ADMIN !== "change_me", problem: null };
  try {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('users','sessions','settings','attempts','games','messages','friendships')").first();
    out.tablesCreated = r.n === 7;
    if (!out.tablesCreated) out.problem = `Only ${r.n} of 7 tables exist: run schema.sql in the D1 console again.`;
  } catch (e) { out.problem = env.DB ? "Could not read the database: " + String(e.message || e).slice(0, 100) : "No database is connected: check database_id in wrangler.toml, then redeploy."; }
  if (!out.problem && !out.signUpPhraseSet) out.problem = "Sign-up phrase isn't set (or the site wasn't redeployed after adding it).";
  return new Response(JSON.stringify(out, null, 2), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
