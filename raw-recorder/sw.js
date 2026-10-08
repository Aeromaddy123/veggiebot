// Demo copy of the raw recorder: maps the page's requests to the saved demo data.
// Routes mirror web_gateway.py (veggiebot_edge/scripts) one to one.
importScripts("../assets/demo-sw-core.js");

const STATIC = {
  "/": "app/index.html", "/index.html": "app/index.html", "/app.js": "app/app.js", "/styles.css": "app/styles.css",
  "/ur16e_replay.js": "app/ur16e_replay.js", "/ur16e_cad.js": "app/ur16e_cad.js",
  "/three.module.js": "app/vendor/three.module.js", "/ColladaLoader.js": "app/vendor/ColladaLoader.js",
  "/loaders/TGALoader.js": "app/loaders/TGALoader.js",
};

makeDemoWorker((url, { at, site }) => {
  const p = url.pathname, q = url.searchParams;
  if (STATIC[p]) return at(STATIC[p]);
  let m = p.match(/^\/api\/model\/ur16e\/(base|shoulder|upperarm|forearm|wrist1|wrist2|wrist3)\.dae$/);
  if (m) return site(`ur16e/${m[1]}.dae`);
  if (p === "/api/status") return at("data/status.json");
  if (p === "/api/session") return at("data/session.json");
  if (p === "/api/hid/status") return at("data/hid_status.json");
  if (p === "/api/episodes") return at("data/episodes.json");
  if (p === "/api/trash") return at("data/trash.json");
  if (p === "/api/observation") return { ok: false, error: "Demo copy: no live observation" };
  if (p === "/api/episode") return at(`data/episode/${encodeURIComponent(q.get("id") || "")}.json`);
  if (/^\/api\/camera\/(front|wrist|fronttop)\.jpg$/.test(p)) return site("assets/camera-not-connected.jpg");
  if (p === "/api/video") return at(`data/episode/${encodeURIComponent(q.get("episode") || "")}/${encodeURIComponent(q.get("camera") || "")}_preview.mp4`);
  if (p === "/api/file") return at(`data/episode/${encodeURIComponent(q.get("episode") || "")}/${encodeURIComponent(q.get("name") || "")}`);
  if (p.startsWith("/api/")) return null;
  return undefined;
});
