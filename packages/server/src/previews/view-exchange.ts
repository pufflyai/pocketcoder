import type { Context } from "hono";
import type { AppEnv } from "../http/middleware";
import type { PreviewSessions } from "./sessions";
import type { ViewPolicy } from "./view-policy";

const checkScript = `const parentOrigin=document.body.dataset.parent;fetch('/.pc/check',{credentials:'same-origin'}).then(r=>{if(r.ok)location.replace('/');else throw Error('blocked')}).catch(()=>{document.getElementById('status').textContent='This browser blocked the embedded session. Open in a new tab using the button in your application.';parent.postMessage({type:'pocketcoder.view_unavailable'},parentOrigin)});`;

export async function viewExchange(c: Context<AppEnv>, url: URL, policy: ViewPolicy, sessions: PreviewSessions) {
  if (c.req.method !== "GET") return;
  if (url.pathname === "/.pc/open") {
    const { secret, session, embedded } = await sessions.exchange(url.searchParams.get("token") ?? "", url.origin);
    c.header("set-cookie", policy.cookie(secret, session));
    c.header("content-security-policy", policy.framing(session));
    return c.redirect(embedded ? `/.pc/embed?reference=${embedded}` : "/", 303);
  }
  if (url.pathname === "/.pc/embed") {
    const session = await sessions.embedded(url.searchParams.get("reference") ?? "", url.origin);
    c.header(
      "content-security-policy",
      `default-src 'self'; connect-src 'self'; ${policy.framing(session)}; base-uri 'none'; form-action 'none'`,
    );
    return c.html(
      `<!doctype html><html><head><meta charset="utf-8"><title>Embedded workspace view</title></head><body data-parent="${session.parentOrigin}"><p id="status">Checking the embedded session…</p><p>Open in a new tab using your application's button if this browser blocks cookies.</p><script src="/.pc/embed.js"></script></body></html>`,
    );
  }
  if (url.pathname === "/.pc/embed.js") return c.body(checkScript, 200, { "content-type": "text/javascript" });
  if (url.pathname === "/.pc/check") {
    await sessions.lookup(policy.secret(c.req.header("cookie"), url), url.origin);
    return c.body(null, 204);
  }
}
