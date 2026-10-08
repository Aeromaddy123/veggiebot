// Shared logic for the two demo-copy service workers.
//
// The gateway pages in app/ are byte-identical copies of the real ones. They ask
// their server for absolute paths such as /app.js or /api/status. On GitHub
// Pages there is no server, so this worker answers those requests from the saved
// demo data in data/ and refuses every action (POST) with a clear message.
// Nothing here can reach a robot, a camera or a model.

const DEMO_NOTE = "This is a demo copy: it is not connected to a robot, cameras or a model. Nothing was changed.";

function makeDemoWorker(routes) {
  const scope = new URL(self.registration.scope);          // .../veggiebot/<gateway>/
  const site = new URL("../", scope);                      // .../veggiebot/
  const at = (path) => new URL(path, scope).href;

  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener("fetch", (event) => {
    const request = event.request;
    const url = new URL(request.url);
    if (url.origin !== scope.origin) return;

    // The copied pages themselves: make their root-relative links relative so
    // they stay inside this folder, and add a small "demo copy" ribbon.
    if (request.mode === "navigate" && url.pathname.startsWith(scope.pathname + "app/")) {
      event.respondWith(servePage(request, site));
      return;
    }
    if (url.pathname.startsWith(scope.pathname) || url.pathname.startsWith(site.pathname)) return;

    if (request.method !== "GET" && request.method !== "HEAD") {
      event.respondWith(json({ ok: false, error: DEMO_NOTE }, 409));
      return;
    }
    const target = routes(url, { at, site: (path) => new URL(path, site).href });
    if (target === undefined) return;
    if (target && typeof target === "object") { event.respondWith(json(target, 200)); return; }
    event.respondWith(target ? Response.redirect(target, 302) : json({ ok: false, error: "Not part of the demo copy" }, 404));
  });
}

async function servePage(request, site) {
  const response = await fetch(request);
  if (!response.ok || !(response.headers.get("content-type") || "").includes("text/html")) return response;
  let html = await response.text();
  html = html.replace(/(href|src)="\/"/g, '$1="./"').replace(/(href|src)="\/(?!\/)/g, '$1="');
  const ribbon = `<div style="position:fixed;left:0;right:0;bottom:0;z-index:99999;padding:8px 14px;background:#1B2127;color:#F8F4EC;font:13px/1.4 Verdana,sans-serif;text-align:center">
Demo copy &middot; not connected to a robot, cameras or a model &middot; recorded examples only &middot;
<a href="${site.href}" style="color:#9BD35A">Back to the VeggieBot project</a></div>`;
  html = html.replace(/<\/body>/i, ribbon + "</body>");
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function json(body, status) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
