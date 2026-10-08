// Demo copy of the inference gateway: maps the page's requests to the saved demo data.
// Routes mirror gateway/web.py one to one.
importScripts("../assets/demo-sw-core.js");

const PAGES = new Set(["/index.html", "/review.html", "/app.js", "/review.js", "/styles.css", "/ur16e_replay.js", "/ur16e_cad.js"]);

makeDemoWorker((url, { at, site }) => {
  const p = url.pathname;
  if (p === "/") return at("app/index.html");
  if (PAGES.has(p)) return at("app" + p);
  if (p.startsWith("/vendor/")) return at("app" + p);
  let m = p.match(/^\/api\/model\/ur16e\/(base|shoulder|upperarm|forearm|wrist1|wrist2|wrist3)\.dae$/);
  if (m) return site(`ur16e/${m[1]}.dae`);
  if (p === "/api/status") return at("data/status.json");
  if (p === "/api/library") return at("data/library.json");
  if (p === "/api/blackbox") return at("data/blackbox.json");
  if (/^\/api\/cameras\/(front|fronttop|wrist)\.jpg$/.test(p)) return site("assets/camera-not-connected.jpg");
  m = p.match(/^\/api\/episodes\/([^/]+)\/images\/(front|fronttop|wrist)\/([^/]+)$/);
  if (m) return at(`data/episodes/${m[1]}/${m[2]}/${m[3]}`);
  m = p.match(/^\/api\/episodes\/([^/]+)$/);
  if (m) return at(`data/episodes/${m[1]}.json`);
  if (p.startsWith("/api/")) return null;
  return undefined;
});
