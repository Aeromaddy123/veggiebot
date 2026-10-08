# The demo copies

`raw-recorder/` and `inference-gateway/` are frozen copies of the two real dashboards, so anyone can
see how they work without access to the lab.

## What is real and what is not

| | Demo copy |
|---|---|
| Page layout, styles and scripts | The real files, unchanged (`app/`) |
| Recorded episodes | Real recordings, two per dashboard |
| Cameras | Show "Camera not connected" |
| Robot, gripper, model | Not connected |
| Buttons (record, run, delete, ...) | Do nothing; they show a "demo copy" message |

## How it works

The real dashboards are served by a Python server on the Jetson and ask it for absolute paths such
as `/app.js`, `/api/status` or `/api/episodes/<id>`. GitHub Pages has no server, so each copy
registers a service worker (`sw.js`):

1. `index.html` registers `sw.js` and opens `app/`.
2. `sw.js` catches the page's requests and redirects each one to a saved file in `data/` (status,
   episode list, episode details, images, preview videos) or to the shared `ur16e/` meshes.
3. Any action (a POST request) gets a "demo copy" answer, so nothing can be changed.
4. When it serves the dashboard page, the worker turns its root links (`/styles.css`) into relative
   links and adds a small "Demo copy" ribbon. The files themselves stay byte-identical.

The routes in each `sw.js` mirror the real server one to one (`web_gateway.py` for the recorder,
`gateway/web.py` for the inference gateway).

## Refreshing a copy

1. Copy the dashboard's web files into `app/` unchanged.
2. Save the server's answers into `data/` with the same shape: for the recorder `status.json`,
   `episodes.json`, `episode/<id>.json` plus that episode's preview videos and files; for the
   gateway `status.json`, `library.json`, `episodes/<id>.json` plus the camera frames listed in it.
3. Remove anything private: home paths, IP addresses, tokens. Mark cameras, robot and model as
   not connected in `status.json`.
4. Check it locally from a folder named `veggiebot` (the worker expects the `/veggiebot/` path):

   ```bash
   python3 -m http.server 8000
   ```

   then open `http://localhost:8000/veggiebot/`.
