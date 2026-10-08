// VeggieBot recording library: browse demos, play all three cameras and the
// arm in 3D together, label outcomes, check and export corrections, and
// delete into a password-protected trash. Modelled on the raw recorder's
// library (synced "Play together", trash with restore), rebuilt for the
// gateway's recordings.
const $ = (id) => document.getElementById(id);
const CAMERAS = ["front", "fronttop", "wrist"];
const IMG_ID = { front: "pvFront", fronttop: "pvFronttop", wrist: "pvWrist" };
const OUTCOME_LABEL = { success: "Success", miss: "Miss", partial: "Partial" };

const lib = { data: null, filter: "all", selecting: false, selected: new Set(), currentId: null };
const play = { rows: [], frames: {}, t0: 0, duration: 0, t: 0, playing: false, speed: 1, last: 0, raf: 0,
               loaders: {}, minT: 0, maxT: 0, replay: null };

function showError(message) { $("libError").textContent = message || ""; }
function fmtClock(s) { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}
function fmtDate(wall) {
  const d = wall ? new Date(wall.replace(/([+-]\d{2})(\d{2})$/, "$1:$2")) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
async function post(path, body = {}) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), cache: "no-store" });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}

// ---------- Library list ----------
function outcomeOf(ep) {
  const own = ep.labels?.outcome;
  if (own) return { key: own, text: OUTCOME_LABEL[own], guess: false };
  const auto = ep.labels?.auto_outcome?.verdict || "";
  if (auto.startsWith("likely grasp")) return { key: "success", text: "Likely grasp", guess: true };
  if (auto.startsWith("likely miss")) return { key: "miss", text: "Likely miss", guess: true };
  return { key: null, text: "Not labelled", guess: true };
}
function hasProblem(ep) { return ep.status !== "COMPLETE" || ep.integrity_valid === false; }
function visibleEpisodes() {
  const eps = lib.data?.episodes || [];
  switch (lib.filter) {
    case "success": return eps.filter((e) => e.labels?.outcome === "success");
    case "miss": return eps.filter((e) => e.labels?.outcome === "miss");
    case "unlabelled": return eps.filter((e) => !e.labels?.outcome && !hasProblem(e));
    case "problem": return eps.filter(hasProblem);
    default: return eps;
  }
}
function chip(text, kind) { const s = document.createElement("span"); s.className = `chip ${kind || ""}`; s.textContent = text; return s; }

function renderLibrary() {
  const data = lib.data; if (!data) return;
  setText("trashCount", data.trash.length ? `(${data.trash.length})` : "");
  setText("retentionDays", data.trash_retention_days);
  const list = $("episodeList"); list.replaceChildren();
  const inTrash = lib.filter === "trash";
  $("deleteSelected").hidden = inTrash || !lib.selecting;
  $("deleteSelected").disabled = !lib.selected.size;
  $("deleteSelected").textContent = lib.selected.size ? `Delete ${lib.selected.size} selected` : "Delete selected";
  $("emptyTrash").hidden = !inTrash || !data.trash.length;
  if (inTrash) {
    setText("libCount", `${data.trash.length} in trash`);
    if (!data.trash.length) list.append(Object.assign(document.createElement("li"), { className: "muted", textContent: "The trash is empty." }));
    for (const item of data.trash) {
      const li = document.createElement("li"); li.className = "ep-card ep-trash";
      const body = document.createElement("div");
      body.append(Object.assign(document.createElement("strong"), { textContent: item.name }));
      body.append(Object.assign(document.createElement("div"), { className: "muted small",
        textContent: `Deleted ${item.deleted_wall} · gone for good in ${item.expires_in_h} h · ${fmtSize(item.size_bytes)}` }));
      const restore = Object.assign(document.createElement("button"), { className: "button button-secondary button-small", textContent: "Restore" });
      restore.addEventListener("click", () => askPassword({ title: `Restore ${item.name}`, text: `${item.name} goes back to the library.`,
        confirm: "Restore", danger: false, action: (pw) => post(`/api/trash/${encodeURIComponent(item.trash_id)}/restore`, { password: pw }) }));
      li.append(body, restore); list.append(li);
    }
    return;
  }
  const eps = visibleEpisodes();
  setText("libCount", `${eps.length} of ${data.episodes.length}`);
  if (!eps.length) list.append(Object.assign(document.createElement("li"), { className: "muted", textContent: "Nothing here yet." }));
  for (const ep of eps) {
    const li = document.createElement("li");
    li.className = `ep-card${ep.id === lib.currentId ? " active" : ""}`;
    li.tabIndex = 0;
    if (lib.selecting) {
      const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: lib.selected.has(ep.id) });
      box.setAttribute("aria-label", `Select ${ep.name}`);
      box.addEventListener("click", (e) => { e.stopPropagation(); box.checked ? lib.selected.add(ep.id) : lib.selected.delete(ep.id); renderLibrary(); });
      li.append(box);
    }
    const body = document.createElement("div"); body.className = "ep-body";
    const top = document.createElement("div"); top.className = "ep-top";
    top.append(Object.assign(document.createElement("strong"), { textContent: ep.name }));
    if (ep.id === data.recording_id) top.append(chip("Recording", "rec"));
    const o = outcomeOf(ep);
    top.append(chip(o.text, `${o.key || "none"}${o.guess ? " guess" : ""}`));
    body.append(top);
    const meta = [fmtDate(ep.started_wall), ep.duration_s != null ? `${Math.round(ep.duration_s)} s` : null, fmtSize(ep.size_bytes)].filter(Boolean).join(" · ");
    body.append(Object.assign(document.createElement("div"), { className: "muted small", textContent: meta }));
    const flags = [];
    if (hasProblem(ep)) flags.push(chip(ep.status !== "COMPLETE" ? "Unusable" : "Failed checks", "bad"));
    else if (ep.integrity_valid) flags.push(chip("Checked", "ok"));
    if (ep.reviewed) flags.push(chip("Reviewed", "ok"));
    if (ep.exported) flags.push(chip("Exported", "ok"));
    if (ep.labels?.notes) flags.push(chip("Notes", ""));
    if (flags.length) { const f = document.createElement("div"); f.className = "ep-flags"; f.append(...flags); body.append(f); }
    li.append(body);
    const open = () => openEpisode(ep.id);
    li.addEventListener("click", open);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
    list.append(li);
  }
  const disk = data.disk;
  if (disk) {
    const used = disk.total_bytes - disk.free_bytes;
    $("diskRecordings").style.width = `${(100 * disk.recordings_bytes / disk.total_bytes).toFixed(1)}%`;
    $("diskTrash").style.width = `${(100 * disk.trash_bytes / disk.total_bytes).toFixed(1)}%`;
    setText("diskText", `Recordings ${fmtSize(disk.recordings_bytes)} · trash ${fmtSize(disk.trash_bytes)} · ${fmtSize(disk.free_bytes)} free of ${fmtSize(disk.total_bytes)}` +
      (used / disk.total_bytes > 0.9 ? " · disk almost full" : ""));
  }
}
function setText(id, value) { $(id).textContent = value == null ? "" : String(value); }

async function loadLibrary() {
  try {
    const response = await fetch("/api/library", { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not load recordings (${response.status})`);
    lib.data = await response.json();
    renderLibrary();
  } catch (error) { showError(error.message); }
}

for (const tab of document.querySelectorAll(".lib-tab")) {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".lib-tab").forEach((t) => t.classList.toggle("active", t === tab));
    lib.filter = tab.dataset.filter; lib.selected.clear(); renderLibrary();
  });
}
$("selectMode").addEventListener("change", (e) => { lib.selecting = e.target.checked; lib.selected.clear(); renderLibrary(); });

// ---------- Password dialog (delete, restore, empty trash) ----------
let pending = null;
function askPassword({ title, text, confirm, danger = true, action }) {
  if (lib.data && !lib.data.delete_password_set) {
    showError("No delete password is set yet. On the Jetson, in the gateway folder, run: python3 -m gateway.set_delete_password");
    return;
  }
  pending = action;
  setText("pwTitle", title); setText("pwText", text); setText("pwError", "");
  $("pwConfirm").textContent = confirm; $("pwConfirm").className = `button ${danger ? "button-danger" : "button-primary"}`;
  $("pwInput").value = ""; $("passwordDialog").showModal(); $("pwInput").focus();
}
// Enter in the password box submits the dialog's form; without this the
// browser just closed the dialog and nothing was deleted (2026-10-02).
// Cancel is a plain button: Enter picks the form's first submit button, and
// when that was Cancel, Enter silently closed the dialog.
$("passwordDialog").querySelector("form").addEventListener("submit", (e) => { e.preventDefault(); confirmPassword(); });
$("pwCancel").addEventListener("click", () => $("passwordDialog").close());
$("pwConfirm").addEventListener("click", (e) => { e.preventDefault(); confirmPassword(); });
async function confirmPassword() {
  if (!pending) return;
  if (!$("pwInput").value) { setText("pwError", "Type the delete password."); return; }
  if ($("pwConfirm").disabled) return;
  $("pwConfirm").disabled = true;
  try {
    await pending($("pwInput").value);
    $("passwordDialog").close(); showError("");
    await loadLibrary();
  } catch (error) { setText("pwError", error.message); $("pwInput").select(); }
  finally { $("pwConfirm").disabled = false; }
}
$("passwordDialog").addEventListener("close", () => { $("pwInput").value = ""; pending = null; });

function deleteEpisodes(ids) {
  const names = ids.map((id) => lib.data.episodes.find((e) => e.id === id)?.name || id);
  askPassword({
    title: ids.length === 1 ? `Delete ${names[0]}?` : `Delete ${ids.length} demos?`,
    text: `${names.join(", ")} will move to the trash. You can restore ${ids.length === 1 ? "it" : "them"} for ${lib.data.trash_retention_days} days; after that ${ids.length === 1 ? "it is" : "they are"} gone for good.`,
    confirm: "Move to trash",
    action: async (pw) => {
      const failed = [];
      for (const id of ids) {
        try { await post(`/api/episodes/${encodeURIComponent(id)}/delete`, { password: pw }); lib.selected.delete(id); }
        catch (error) {
          if (/password/i.test(error.message)) throw error;   // stop at a wrong password
          failed.push(`${lib.data.episodes.find((e) => e.id === id)?.name}: ${error.message}`);
        }
      }
      if (ids.includes(lib.currentId)) closePlayer();
      if (failed.length) showError(`Not deleted: ${failed.join("; ")}`);
    },
  });
}
$("deleteSelected").addEventListener("click", () => deleteEpisodes([...lib.selected]));
$("deleteEpisode").addEventListener("click", () => lib.currentId && deleteEpisodes([lib.currentId]));
$("emptyTrash").addEventListener("click", () => askPassword({ title: "Empty the trash?",
  text: "Everything in the trash is removed for good. This cannot be undone.", confirm: "Empty trash",
  action: (pw) => post("/api/trash/empty", { password: pw }) }));

// ---------- Player: three cameras + 3D arm + graphs, all on one clock ----------
function closePlayer() { pause(); lib.currentId = null; $("player").hidden = true; $("emptyState").hidden = false; }

function frameAt(list, t) {               // last frame at or before time t (seconds); binary search
  let lo = 0, hi = list.length - 1, best = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid].t <= t) { best = mid; lo = mid + 1; } else hi = mid - 1; }
  return list[best];
}
function showFrame(camera, t) {
  const list = play.frames[camera]; if (!list?.length) return;
  const frame = frameAt(list, t);
  const loader = play.loaders[camera] ||= { busy: false, want: null, shown: null };
  loader.want = frame.url;
  if (loader.busy || loader.shown === frame.url) return;
  // Latest-wins image loading: never queue up stale frames while playing.
  loader.busy = true;
  const url = loader.want, img = new Image();
  const done = () => {
    $(IMG_ID[camera]).src = url; loader.shown = url; loader.busy = false;
    if (loader.want !== url) showFrame(camera, play.t);
  };
  img.onload = done; img.onerror = done;    // a missing frame must not stall the camera
  img.src = url;
}
function render() {
  const t = play.t;
  for (const camera of CAMERAS) showFrame(camera, t);
  if (play.duration > 0) $("timeline").value = String(Math.round(1000 * t / play.duration));
  setText("timeText", `${fmtClock(t)} / ${fmtClock(play.duration)}`);
  const x = 20 + 660 * (t / Math.max(1e-6, play.duration));
  for (const id of ["reviewCursor", "compareCursor", "gripperCursor"]) {
    const cursor = document.getElementById(id); if (cursor) { cursor.setAttribute("x1", x); cursor.setAttribute("x2", x); }
  }
  if (play.replay === "cad") window.drawRobotCAD?.(t);
  else if (play.replay === "lines") window.drawRobotReplay?.(t);
}
// A steady 30-per-second timer drives playback (requestAnimationFrame stops
// whenever the tab is not in front, which froze playback).
function tick() {
  if (!play.playing) return;
  const now = performance.now();
  const dt = Math.min(1.0, (now - play.last) / 1000); play.last = now;   // keeps real time even if the timer runs late
  play.t = Math.min(play.duration, play.t + dt * play.speed);
  render();
  if (play.t >= play.duration) pause();
}
function start() {
  if (!play.duration) return;
  if (play.t >= play.duration) play.t = 0;
  play.playing = true; play.last = performance.now();
  $("playButton").textContent = "❚❚ Pause";
  clearInterval(play.raf); play.raf = setInterval(tick, 33);
}
function pause() { play.playing = false; clearInterval(play.raf); $("playButton").textContent = "▶ Play all"; }
function seek(t) { play.t = Math.max(0, Math.min(play.duration, t)); render(); }
$("playButton").addEventListener("click", () => (play.playing ? pause() : start()));
$("playSpeed").addEventListener("change", (e) => { play.speed = Number(e.target.value) || 1; });
$("timeline").addEventListener("input", (e) => { pause(); seek(play.duration * Number(e.target.value) / 1000); });
const FRAME_S = 1 / 30;
$("stepBack").addEventListener("click", () => { pause(); seek(play.t - FRAME_S); });
$("stepForward").addEventListener("click", () => { pause(); seek(play.t + FRAME_S); });
document.addEventListener("keydown", (e) => {
  if ($("player").hidden || document.querySelector("dialog[open]")) return;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName) && e.code !== "Space") return;
  if (["TEXTAREA"].includes(document.activeElement?.tagName)) return;
  if (e.code === "Space") { e.preventDefault(); play.playing ? pause() : start(); }
  else if (e.code === "ArrowRight") { e.preventDefault(); pause(); seek(play.t + (e.shiftKey ? 1 : FRAME_S)); }
  else if (e.code === "ArrowLeft") { e.preventDefault(); pause(); seek(play.t - (e.shiftKey ? 1 : FRAME_S)); }
});

// 3D arm: the raw recorder's UR16e mesh model; the line model if the meshes cannot load.
function freshCanvas() {
  const old = $("robotReplay"); const canvas = old.cloneNode(false); old.replaceWith(canvas); return canvas;
}
function setupReplay(points) {
  window.stopRobotCAD?.(); window.stopRobotReplay?.();
  freshCanvas();
  if (window.setupRobotCAD && !window.veggiebotCadFailed) { play.replay = "cad"; window.setupRobotCAD(points); }
  else if (window.setupRobotReplay) { play.replay = "lines"; window.setupRobotReplay(points); }
}
window.addEventListener("veggiebot-cad-ready", () => { if (play.points && play.replay !== "cad") { setupReplay(play.points); render(); } });
window.addEventListener("veggiebot-cad-error", () => {
  window.veggiebotCadFailed = true;
  if (play.points && window.setupRobotReplay) { window.stopRobotCAD?.(); freshCanvas(); play.replay = "lines"; window.setupRobotReplay(play.points); render(); }
});

function svgEl(name, attrs) { const el = document.createElementNS("http://www.w3.org/2000/svg", name); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; }
function xOf(time_ns) { return 20 + 660 * (time_ns - play.minT) / Math.max(1, play.maxT - play.minT); }
function cursorLine(id, y1, y2) { return svgEl("line", { id, x1: 20, x2: 20, y1, y2, stroke: "#ffffff", "stroke-width": 1.5, "stroke-dasharray": "4 4" }); }

function drawGraphs(samples) {
  const rows = play.rows;
  const motion = $("motionGraph"); motion.replaceChildren();
  const grip = $("gripperGraph"); grip.replaceChildren();
  if (rows.length > 1) {
    let low = Infinity, high = -Infinity;
    for (const r of rows) for (const v of r.q) { low = Math.min(low, v); high = Math.max(high, v); }
    const range = Math.max(0.01, high - low);
    const colors = ["#78dda3", "#9fd3ff", "#ffcf7a", "#ff8f8f", "#d6a8ff", "#ffffff"];
    const step = Math.max(1, Math.ceil(rows.length / 500));
    for (let j = 0; j < 6; j++) {
      motion.append(svgEl("polyline", { fill: "none", stroke: colors[j], "stroke-width": 2,
        points: rows.filter((_, i) => i % step === 0).map((r) => `${xOf(r.time_ns)},${200 - 180 * (r.q[j] - low) / range}`).join(" ") }));
    }
  }
  for (const change of play.changes) {
    const x = xOf(change.time_ns);
    const line = svgEl("line", { x1: x, x2: x, y1: 15, y2: 205, stroke: change.owner === "HUMAN" ? "#ffcf7a" : "#61d7d0", "stroke-width": 1, "stroke-dasharray": "2 5" });
    line.append(Object.assign(document.createElementNS("http://www.w3.org/2000/svg", "title"), { textContent: `${change.previous} → ${change.owner}` }));
    motion.append(line);
  }
  motion.append(cursorLine("reviewCursor", 15, 205));
  const grips = samples.filter((r) => r.kind === "gripper" && Number.isFinite(r.position));
  if (grips.length > 1) {
    const step = Math.max(1, Math.ceil(grips.length / 1000));
    grip.append(svgEl("polyline", { fill: "none", stroke: "#ffcf7a", "stroke-width": 2,
      points: grips.filter((_, i) => i % step === 0).map((r) => `${xOf(r.time_ns)},${78 - 60 * r.position / 255}`).join(" ") }));
  }
  grip.append(cursorLine("gripperCursor", 5, 85));
  const predicted = samples.filter((r) => r.kind === "policy" && r.phase === "reply" && r.actions?.[0]?.length === 7 && Number.isFinite(r.observation_ns))
    .map((r) => ({ time_ns: r.observation_ns + 300_000_000, q: r.actions[0] }));
  const sent = samples.filter((r) => r.kind === "event" && r.name === "robot_command" && r.q?.length === 6);
  const drawComparison = () => {
    const svg = $("commandGraph"); svg.replaceChildren();
    const joint = Number($("reviewJoint").value);
    const series = [{ rows: predicted, color: "#9fd3ff", dash: "5 4" }, { rows: sent, color: "#ffcf7a", dash: "2 3" }, { rows, color: "#78dda3", dash: "" }];
    let lo = Infinity, hi = -Infinity;
    for (const s of series) for (const r of s.rows) { const v = r.q[joint]; if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
    if (Number.isFinite(lo)) {
      const range = Math.max(0.01, hi - lo);
      for (const s of series) {
        if (!s.rows.length) continue;
        const step = Math.max(1, Math.ceil(s.rows.length / 800));
        const attrs = { fill: "none", stroke: s.color, "stroke-width": 2,
          points: s.rows.filter((_, i) => i % step === 0).map((r) => `${xOf(r.time_ns)},${145 - 125 * (r.q[joint] - lo) / range}`).join(" ") };
        if (s.dash) attrs["stroke-dasharray"] = s.dash;
        svg.append(svgEl("polyline", attrs));
      }
    }
    svg.append(cursorLine("compareCursor", 5, 155));
    render();
  };
  $("reviewJoint").onchange = drawComparison;
  drawComparison();
  // Owner changes on the timeline too.
  const marks = $("timelineMarks"); marks.replaceChildren();
  for (const change of play.changes) {
    const m = document.createElement("span");
    m.className = `tl-mark ${change.owner === "HUMAN" ? "human" : "model"}`;
    m.style.left = `${100 * (change.time_ns - play.minT) / Math.max(1, play.maxT - play.minT)}%`;
    marks.append(m);
  }
}

async function openEpisode(id) {
  pause(); showError("");
  lib.currentId = id; renderLibrary();
  $("emptyState").hidden = true; $("player").hidden = false;
  setText("episodeTitle", "Loading…"); setText("episodeMeta", "");
  let data;
  try {
    const response = await fetch(`/api/episodes/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load this recording");
    data = await response.json();
  } catch (error) { showError(error.message); return; }
  if (lib.currentId !== id) return;
  const ep = lib.data.episodes.find((e) => e.id === id) || { id, name: id, labels: {} };
  const { manifest, samples, integrity, operator_review: review } = data;
  play.rows = samples.filter((r) => r.kind === "robot" && r.q?.length === 6);
  const times = samples.filter((r) => Number.isFinite(r.time_ns)).map((r) => r.time_ns);
  play.minT = play.rows[0]?.time_ns ?? Math.min(...times);
  play.maxT = play.rows.at(-1)?.time_ns ?? Math.max(...times);
  play.duration = Math.max(0, (play.maxT - play.minT) / 1e9);
  play.frames = {}; play.loaders = {};
  for (const camera of CAMERAS) {
    play.frames[camera] = samples.filter((r) => r.kind === camera && r.file)
      .map((r) => ({ t: (r.time_ns - play.minT) / 1e9, url: `/api/episodes/${encodeURIComponent(id)}/images/${camera}/${encodeURIComponent(r.file.split("/")[1])}` }))
      .sort((a, b) => a.t - b.t);
    $(IMG_ID[camera]).removeAttribute("src");
  }
  play.changes = samples.filter((r) => r.kind === "event" && r.name === "ownership_change" && Number.isFinite(r.time_ns));
  play.points = play.rows.filter((_, i) => i % Math.max(1, Math.ceil(play.rows.length / 1200)) === 0)
    .map((r) => ({ t: (r.time_ns - play.minT) / 1e9, q: r.q }));
  play.t = 0;

  setText("episodeTitle", ep.name);
  setText("episodeMeta", [fmtDate(ep.started_wall), `${fmtClock(play.duration)} long`, fmtSize(ep.size_bytes),
    `${play.frames.front.length}/${play.frames.fronttop.length}/${play.frames.wrist.length} frames`].join(" · "));
  const chips = $("episodeChips"); chips.replaceChildren();
  if (hasProblem(ep)) chips.append(chip(ep.status !== "COMPLETE" ? "Unusable for training" : "Failed checks", "bad"));
  if (play.changes.some((c) => c.owner === "HUMAN")) chips.append(chip("Has your corrections", ""));
  renderLabels(ep);
  setText("episodeHealth", manifest.status === "COMPLETE" ? "Recording complete." : `Unusable for training: ${manifest.problem || manifest.status}`);
  setText("validationResult", integrity ? (integrity.integrity_valid ? "Passed the whole-episode check." : `Failed the whole-episode check. ${integrity.errors?.join("; ") || ""}`)
    : manifest.status === "COMPLETE" ? "Not checked yet." : "");
  $("validateEpisode").disabled = manifest.status !== "COMPLETE";
  $("operatorReviewed").checked = review?.reviewed === true;
  $("operatorReviewed").disabled = integrity?.integrity_valid !== true;
  $("exportCorrection").disabled = integrity?.integrity_valid !== true || review?.reviewed !== true;
  $("deleteEpisode").disabled = ep.reviewed || ep.exported || ep.id === lib.data.recording_id;
  setText("exportResult", "");
  drawGraphs(samples);
  setupReplay(play.points);
  render();
}

// ---------- Labels ----------
function renderLabels(ep) {
  const labels = ep.labels || {};
  for (const b of document.querySelectorAll(".outcome")) b.classList.toggle("active", b.dataset.outcome === labels.outcome);
  const auto = labels.auto_outcome;
  setText("autoOutcome", auto ? `Watcher's guess: ${auto.verdict.replace(/ \(.*\)$/, "")} (gripper ended at ${auto.gripper_position} of 255).` : "");
  const cell = labels.block_cell;
  for (const b of document.querySelectorAll(".cell")) b.classList.toggle("active", !!cell && Number(b.dataset.row) === cell[0] && Number(b.dataset.col) === cell[1]);
  setText("blockText", cell ? `Row ${cell[0]}, column ${cell[1]}` : "Not set");
  $("notes").value = labels.notes || "";
  setText("labelSaved", "");
}
async function saveLabels(changes) {
  const id = lib.currentId; if (!id) return;
  try {
    const labels = await post(`/api/episodes/${encodeURIComponent(id)}/labels`, changes);
    const ep = lib.data.episodes.find((e) => e.id === id); if (ep) ep.labels = labels;
    renderLabels(ep); renderLibrary(); setText("labelSaved", "Saved.");
  } catch (error) { setText("labelSaved", error.message); }
}
for (const b of document.querySelectorAll(".outcome")) {
  b.addEventListener("click", () => saveLabels({ outcome: b.classList.contains("active") ? null : b.dataset.outcome }));
}
const grid = $("blockGrid");
for (let row = 1; row <= 5; row++) for (let col = 1; col <= 5; col++) {
  const cell = Object.assign(document.createElement("button"), { className: "cell", title: `Row ${row}, column ${col}` });
  cell.dataset.row = row; cell.dataset.col = col;
  cell.addEventListener("click", () => saveLabels({ block_cell: cell.classList.contains("active") ? null : [row, col] }));
  grid.append(cell);
}
let notesTimer = 0;
$("notes").addEventListener("input", () => { clearTimeout(notesTimer); setText("labelSaved", "…"); notesTimer = setTimeout(() => saveLabels({ notes: $("notes").value }), 700); });

// ---------- Checks and export (unchanged rules) ----------
$("validateEpisode").addEventListener("click", async () => {
  const id = lib.currentId; if (!id) return;
  setText("validationResult", "Checking every frame and sensor record…");
  try {
    const report = await post(`/api/episodes/${encodeURIComponent(id)}/validate`);
    setText("validationResult", report.integrity_valid ? "Passed the whole-episode check." : `Failed the whole-episode check. ${report.errors?.join("; ") || ""}`);
    $("operatorReviewed").disabled = !report.integrity_valid;
    $("exportCorrection").disabled = !report.integrity_valid || !$("operatorReviewed").checked;
    await loadLibrary();
  } catch (error) { setText("validationResult", error.message); }
});
$("operatorReviewed").addEventListener("change", async () => {
  const id = lib.currentId; if (!id || !$("operatorReviewed").checked) { $("exportCorrection").disabled = true; return; }
  try { await post(`/api/episodes/${encodeURIComponent(id)}/review`, { reviewed: true }); $("exportCorrection").disabled = false; await loadLibrary(); }
  catch (error) { $("operatorReviewed").checked = false; setText("exportResult", error.message); }
});
$("exportCorrection").addEventListener("click", async () => {
  const id = lib.currentId; if (!id) return;
  try {
    const result = await post(`/api/episodes/${encodeURIComponent(id)}/export`);
    setText("exportResult", `${result.rows} correction rows exported. ${result.notes || ""}`);
    await loadLibrary();
  } catch (error) { setText("exportResult", error.message); }
});

loadLibrary();
setInterval(() => { if (!play.playing && !document.querySelector("dialog[open]")) loadLibrary(); }, 15000);
