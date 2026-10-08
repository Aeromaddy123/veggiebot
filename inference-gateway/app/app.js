// VeggieBot Operate screen: one guided checklist, three large camera views,
// and a Stop that is always reachable. The service is the only source of
// truth and the only place safety checks are enforced — this page only
// displays cached readings and sends explicit requests.
const $ = (id) => document.getElementById(id);
const CAMERAS = ["front", "fronttop", "wrist"];
const CAMERA_LABEL = { front: "Front", fronttop: "Top", wrist: "Wrist" };
const STATUS_POLL_MS = 1000;
const CAMERA_POLL_MS = 220; // ~4.5 fps; cheap because it serves an already-decoded cached JPEG
const STALE_CAMERA_MS = 2500;

let lastStatus = null;
let uiError = null;
let lastGoodStatusAt = null;
let recordingStartedLocalAt = null;
let wasRecordingActive = false;

function setText(id, value) { $(id).textContent = value == null ? "—" : String(value); }
function fmtMs(value) { return Number.isFinite(value) ? `${Math.round(value)} ms` : "—"; }
function fmtRad(value) { return Number.isFinite(value) ? `${value.toFixed(3)} rad` : "—"; }
function fmtClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function api(path, body = {}) {
  uiError = null;
  $("uiError").textContent = "";
  try {
    const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), cache: "no-store" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
    render(result);
    return result;
  } catch (error) {
    uiError = error.message;
    await refresh();
    $("uiError").textContent = error.message;
    return null;
  }
}

// ---------- Cameras: independent, faster poll loop; a stale/errored tile
// gets an overlay with a manual "Reconnect now" that never leaves the
// operator guessing why a picture went dark. ----------
function renderCameraTile(name, cameraStatus, live) {
  const img = $(`cam${name[0].toUpperCase()}${name.slice(1)}`);
  const overlay = $(`cam${name[0].toUpperCase()}${name.slice(1)}Overlay`);
  const message = $(`cam${name[0].toUpperCase()}${name.slice(1)}Message`);
  const statusEl = $(`cam${name[0].toUpperCase()}${name.slice(1)}Status`);
  const reconnectButton = overlay.querySelector(".reconnect-btn");
  const spinner = overlay.querySelector(".spinner");
  if (!live) {
    img.hidden = true; overlay.hidden = false;
    overlay.classList.add("camera-overlay-sim");
    spinner.hidden = true; reconnectButton.hidden = true;
    message.textContent = "Simulation: no camera to show";
    statusEl.textContent = "—"; statusEl.className = "cam-status";
    return;
  }
  overlay.classList.remove("camera-overlay-sim");
  spinner.hidden = false; reconnectButton.hidden = false;
  const age = cameraStatus?.age_ms;
  const stale = !cameraStatus?.ok || age == null || age > STALE_CAMERA_MS;
  overlay.hidden = !stale;
  img.hidden = stale && age == null; // keep the last good frame visible under a light overlay if we have one
  if (stale) {
    message.textContent = cameraStatus?.error ? `Reconnecting: ${cameraStatus.error}` : "Reconnecting…";
  }
  if (cameraStatus?.ok) {
    statusEl.textContent = `${Number.isFinite(cameraStatus.fps) ? `${cameraStatus.fps} fps` : "measuring"} · ${fmtMs(age)}`;
    statusEl.className = "cam-status ok";
  } else {
    statusEl.textContent = cameraStatus?.error ? "Reconnecting" : "No picture";
    statusEl.className = "cam-status bad";
  }
}

function pollCameraImages() {
  if (document.hidden || lastStatus?.mode !== "live") return;
  for (const name of CAMERAS) {
    const cam = lastStatus.cameras?.[name];
    if (!cam?.ok) continue; // don't keep requesting a JPEG the server has already told us is stale
    const img = $(`cam${name[0].toUpperCase()}${name.slice(1)}`);
    img.src = `/api/cameras/${name}.jpg?t=${Date.now()}`;
    img.onload = () => { img.hidden = false; };
  }
}
window.setInterval(pollCameraImages, CAMERA_POLL_MS);

for (const button of document.querySelectorAll(".reconnect-btn")) {
  button.addEventListener("click", () => api(`/api/cameras/${button.dataset.camera}/reconnect`));
}

// ---------- Guided checklist: derives the single next action from status,
// instead of a fixed set of always-visible buttons. ----------
function computeSteps(s) {
  const cam = s.cameras || {};
  const camerasOk = CAMERAS.every((name) => cam[name]?.ok);
  const skewOk = s.camera_skew_ms != null && s.camera_skew_ms <= 25.0;
  const robotOk = s.robot?.ok && s.robot?.safety_ok;
  const gripperOk = s.gripper?.ok;
  const checksOk = camerasOk && skewOk && robotOk && gripperOk;
  const checkProblems = [];
  if (!camerasOk) checkProblems.push("a camera has no picture");
  else if (!skewOk) checkProblems.push("the three cameras are not in sync");
  if (!robotOk) checkProblems.push(s.robot?.error || "the robot connection is not ready");
  else if (!s.robot?.safety_ok) checkProblems.push("the robot safety signal is not safe");
  if (!gripperOk) checkProblems.push(s.gripper?.error || "the gripper is not ready");

  const home = s.home || {};
  const atHome = home.configured && home.at_home;
  const stableRequired = s.practice_stable_replies_required || 20;
  const stableDone = (s.practice_good_replies || 0) >= stableRequired;
  const practiceDone = ["RUNNING"].includes(s.state) || (s.state === "PRACTICE" && stableDone);
  const recordingActive = !!s.recording?.active;
  const running = s.state === "RUNNING";

  const steps = [
    {
      key: "checks", label: "System checks",
      status: checksOk ? "done" : "problem",
      detail: checksOk ? "Cameras, robot and gripper are healthy." : checkProblems.join(" · "),
    },
    {
      key: "home", label: "Arm at Home",
      status: !home.configured ? "blocked" : atHome ? "done" : "todo",
      detail: !home.configured ? "No Home pose is set up yet."
        : atHome ? `At Home (within ${fmtRad(home.tolerance_rad)}).`
        : home.distance_rad == null ? "Waiting for a robot reading."
        : `${fmtRad(home.distance_rad)} away from the saved Home pose.`,
    },
    {
      key: "practice", label: "Practice",
      status: practiceDone ? "done" : s.state === "PRACTICE" ? "active" : "todo",
      detail: s.state === "PRACTICE" ? `The model is answering. Stable replies: ${s.practice_good_replies || 0} / ${stableRequired}.`
        : practiceDone ? "Practice passed its checks." : "Not started. The model will not move the arm.",
    },
    {
      key: "recording", label: "Recording",
      status: recordingActive ? "done" : "todo",
      detail: recordingActive ? "Recording this attempt from the start." : "Start recording before Run.",
    },
    {
      key: "run", label: "Run",
      status: running ? "active" : "todo",
      detail: running ? "Sending checked moves to the robot." : !s.motion_enabled ? "Motion has not been commissioned yet."
        : !s.checkpoint_approved ? "This checkpoint is not approved for movement."
        : "Hand control to the model once everything above is ready.",
    },
  ];
  if (running) {
    steps.push({ key: "correct", label: "Correct as needed", status: "active",
      detail: `Driver: ${s.owner === "HUMAN" ? "you" : s.owner === "PAUSED" ? "paused" : "the model"}. Take over any time.` });
  }
  // The first not-done, not-blocked step is "current".
  let markedCurrent = false;
  for (const step of steps) {
    if (!markedCurrent && step.status !== "done" && step.status !== "blocked") {
      if (step.status === "todo") step.status = "active";
      markedCurrent = true;
    }
  }
  return steps;
}

const STEP_ICON = { done: "✓", active: "•", todo: "", blocked: "–", problem: "!" };
function renderChecklist(s) {
  const steps = computeSteps(s);
  const list = $("checklist");
  list.replaceChildren();
  for (const step of steps) {
    const li = document.createElement("li");
    li.className = `step ${step.status}`;
    const icon = document.createElement("span");
    icon.className = "step-icon"; icon.setAttribute("aria-hidden", "true");
    icon.textContent = STEP_ICON[step.status] || "";
    const body = document.createElement("div");
    body.className = "step-body";
    const label = document.createElement("div");
    label.className = "step-label"; label.textContent = step.label;
    const detail = document.createElement("div");
    detail.className = "step-detail"; detail.textContent = step.detail;
    body.append(label, detail);
    li.append(icon, body);
    list.append(li);
  }
  return steps;
}

// ---------- The single primary action button adapts to whichever step is
// current, so there is only ever one obvious next thing to press. ----------
function renderPrimaryAction(s, steps) {
  const button = $("primaryAction");
  const reason = $("primaryActionReason");
  const current = steps.find((step) => step.status === "active" || step.status === "problem");
  button.hidden = false;
  button.onclick = null;
  reason.textContent = "";
  if (s.state === "FAULT") {
    button.hidden = true;
    reason.textContent = "Movement is locked after a fault. The watcher clears it once the cause is gone, " +
      "or press Clear fault. The cause is listed in the black box.";
    return;
  }
  if (!current || current.key === "correct") { button.hidden = true; return; }
  if (current.key === "checks") {
    button.hidden = true;
    reason.textContent = "Resolve the issues above before continuing.";
    return;
  }
  if (current.key === "home") {
    if (s.simulate || s.mode !== "live") { button.hidden = true; return; }
    if (!s.motion_enabled) {
      button.hidden = true;
      reason.textContent = "Home motion needs live motion to be commissioned first.";
      return;
    }
    button.textContent = "Go Home"; button.disabled = false;
    button.onclick = () => $("homeDialog").showModal();
    return;
  }
  if (current.key === "practice") {
    if (s.state === "PRACTICE") { button.hidden = true; return; } // progress shown in the checklist itself
    button.textContent = "Start Practice"; button.disabled = !s.ready;
    reason.textContent = s.ready ? "" : "Waiting for system checks to pass.";
    button.onclick = () => {
      if (s.mode === "simulation") api("/api/practice");
      else $("practiceDialog").showModal();
    };
    return;
  }
  if (current.key === "recording") {
    button.textContent = "Start recording";
    button.disabled = s.mode !== "live" || s.recording?.state !== "IDLE" || s.state === "FAULT";
    button.onclick = () => api("/api/recordings/start");
    return;
  }
  if (current.key === "run") {
    const stableRequired = s.practice_stable_replies_required || 20;
    const stable = (s.practice_good_replies || 0) >= stableRequired;
    const canRun = s.ready && s.state === "PRACTICE" && s.motion_enabled && s.checkpoint_approved && stable
      && s.recording?.active && s.home?.at_home !== false;
    button.textContent = "Run"; button.disabled = !canRun;
    button.onclick = () => $("runDialog").showModal();
    if (!canRun) {
      reason.textContent = !stable ? `Needs ${stableRequired} good Practice replies in a row.`
        : !s.recording?.active ? "Start recording first."
        : s.home?.at_home === false ? "The arm must be at the saved Home pose."
        : !s.checkpoint_approved ? "This checkpoint is not approved for movement."
        : !s.motion_enabled ? "Live motion has not been commissioned."
        : "";
    }
    return;
  }
  button.hidden = true;
}

// ---------- Test panel, speed dial and watcher ----------
const dialBusyUntil = {}; // per dial: don't fight the operator's finger while they drag it
function renderSupervisor(s) {
  const live = s.mode === "live";
  const w = s.watcher || {};
  const seq = w.sequence;
  const busy = !!seq?.running;
  const idle = ["DISARMED", "PRACTICE"].includes(s.state);

  $("testStart").disabled = !live || busy || s.state === "RUNNING" || s.state === "FAULT" || s.state === "HOMING"
    || !s.motion_enabled || !s.checkpoint_approved;
  $("testReset").disabled = !live || busy || !s.motion_enabled || s.state === "FAULT";
  const seqText = $("sequenceText");
  seqText.classList.toggle("bad", !!seq?.error);
  seqText.textContent = !seq ? ""
    : seq.error ? `Stopped: ${seq.error}`
    : seq.running ? `${seq.step}…`
    : seq.step === "cancelled" ? "Cancelled by Stop." : "";

  const speed = s.speed || {};
  for (const [dial, key, valueId, detailId, what] of [
    ["speedDial", "percent", "speedValue", "speedDetail", "The model and Home moves."],
    ["teleopDial", "teleop_percent", "teleopValue", "teleopDetail", "Your Quest sticks, outside a run and on takeover."],
  ]) {
    if (Date.now() > (dialBusyUntil[dial] || 0) && Number.isFinite(speed[key])) $(dial).value = speed[key];
    $(dial).disabled = !live;
    const shown = Number($(dial).value);
    setText(valueId, `${shown}%`);
    setText(detailId, Number.isFinite(speed.limit_rad_s)
      ? `${(speed.limit_rad_s * shown / 100).toFixed(3)} rad/s of a ${speed.limit_rad_s} rad/s limit. ${what}`
      : what);
  }

  $("gripperOpen").disabled = !live || !idle || busy;
  $("faultReset").hidden = s.state !== "FAULT";

  const badge = $("watcherBadge");
  badge.textContent = !live ? "simulation" : w.ok ? "all good" : "needs attention";
  badge.className = `watcher-badge ${!live ? "" : w.ok ? "ok" : "bad"}`;
  const needs = $("watcherNeeds");
  needs.replaceChildren(...(w.needs_operator || []).map((text) => {
    const li = document.createElement("li"); li.textContent = text; return li;
  }));
  const checks = $("watcherChecks");
  checks.replaceChildren(...(w.checks || []).map((c) => {
    const li = document.createElement("li"); li.className = c.ok ? "" : "bad";
    const name = document.createElement("span"); name.textContent = c.label;
    const detail = document.createElement("span"); detail.textContent = c.detail;
    li.append(name, detail); return li;
  }));
  const last = w.last_run;
  setText("lastRun", last ? `Last run (${last.time}): ${last.verdict}. Estimate from the gripper reading only.`
    : w.recoveries ? `Fixed by itself ${w.recoveries} time${w.recoveries === 1 ? "" : "s"} this session.` : "");
  const box = $("blackbox");
  box.replaceChildren(...(w.events || []).slice().reverse().map((e) => {
    const li = document.createElement("li"); li.className = e.kind;
    const t = document.createElement("time"); t.textContent = (e.time || "").slice(11);
    li.append(t, document.createTextNode(e.message)); return li;
  }));
}

function render(s) {
  lastStatus = s;
  lastGoodStatusAt = Date.now();
  $("connectionBanner").hidden = true;
  $("simBanner").hidden = s.mode !== "simulation";

  const badge = $("stateBadge");
  badge.classList.remove("state-good", "state-bad", "state-busy");
  if (s.state === "FAULT") badge.classList.add("state-bad");
  else if (["PRACTICE", "RUNNING", "HOMING"].includes(s.state)) {
    badge.classList.add(s.state === "RUNNING" || s.state === "HOMING" ? "state-busy" : "state-good");
  }
  const stateLabel = { DISARMED: "Locked", PRACTICE: "Practice", RUNNING: "Running", HOMING: "Moving to Home",
    FAULT: "Fault" }[s.state] || s.state;
  setText("stateText", stateLabel);

  const ownerBadge = $("ownerBadge");
  const free = s.free_teleop || {};
  const freeDriving = s.state !== "RUNNING" && free.available;
  ownerBadge.hidden = s.state !== "RUNNING" && !freeDriving;
  const humanDetail = (s.owner === "HUMAN" || (freeDriving && free.active))
    ? ` · ${s.human_mode === 1 ? "Cartesian" : s.human_mode === 2 ? "joint jog" : "waiting"}` +
      (Number.isFinite(s.human_link_age_ms) ? ` · link ${s.human_link_age_ms < 1000 ? Math.round(s.human_link_age_ms) + " ms" : "idle"}` : "")
    : "";
  setText("ownerText", (freeDriving ? "You (free teleop)"
    : s.owner === "HUMAN" ? "You" : s.owner === "PAUSED" ? "Paused" : "Model") + humanDetail);

  const rec = s.recording || {};
  const recBadge = $("recBadge");
  recBadge.hidden = !rec.active;
  if (rec.active && !wasRecordingActive) recordingStartedLocalAt = Date.now();
  wasRecordingActive = !!rec.active;
  if (rec.active && recordingStartedLocalAt) {
    setText("recTimer", fmtClock((Date.now() - recordingStartedLocalAt) / 1000));
  }
  const countsText = ["front", "fronttop", "wrist"].map((n) => `${CAMERA_LABEL[n]} ${rec.counts?.[n] || 0}`).join(" · ");
  setText("recordCounts", rec.active || rec.state === "FINALIZING"
    ? `${rec.name || "Episode"} · ${countsText} · robot ${rec.counts?.robot || 0}${rec.problem ? ` · ${rec.problem}` : ""}`
    : rec.state === "FINALIZING" ? "Saving…" : "No active episode");
  $("recordStart").disabled = s.mode !== "live" || rec.state !== "IDLE" || s.state === "FAULT";
  $("recordStop").disabled = !rec.active || s.state === "RUNNING";

  for (const name of CAMERAS) renderCameraTile(name, s.cameras?.[name], s.mode === "live");

  renderModels(s);
  const modelLabel = s.models?.choices?.find((c) => c.name === s.models.selected)?.label;
  const chips = [
    ["chipCameras", CAMERAS.every((n) => s.cameras?.[n]?.ok), `${CAMERAS.filter((n) => s.cameras?.[n]?.ok).length} / 3`],
    ["chipRobot", !!(s.robot?.ok && s.robot?.safety_ok), s.robot?.ok ? (s.robot?.safety_ok ? "Safe" : "Not safe") : "Not ready"],
    ["chipGripper", !!s.gripper?.ok, s.gripper?.ok ? `pos ${s.gripper.position}` : "Not ready"],
    ["chipModel", !!s.model?.ok, (modelLabel ? `${modelLabel} · ` : "") + (s.model?.ok ? fmtMs(s.model.latency_ms) : "Waiting")],
  ];
  for (const [id, ok, text] of chips) {
    $(`${id}Value`).textContent = text;
    $(id).className = `health-chip ${s.state === "FAULT" ? "" : ok ? "ok" : (s.mode === "live" ? "warn" : "")}`;
  }

  const running = s.state === "RUNNING";
  $("runningPanel").hidden = !running;
  $("takeoverButton").disabled = !running || s.owner === "HUMAN" || !rec.active;
  $("pauseButton").disabled = !running || s.owner === "PAUSED" || !rec.active;
  $("returnButton").disabled = !running || s.owner === "MODEL" || !rec.active;

  const steps = renderChecklist(s);
  renderPrimaryAction(s, steps);
  renderSupervisor(s);

  $("stopButton").disabled = s.state === "DISARMED";
  setText("updatedAt", `Updated ${new Date().toLocaleTimeString()}`);
  // The full status payload, unfiltered: this is the expert escape hatch,
  // so nothing here should require guessing at a field the summary omitted.
  setText("detailText", JSON.stringify(s, null, 2));
  const errorLine = uiError || (s.faults?.length ? s.faults.join("; ") : "");
  if (errorLine) $("uiError").textContent = errorLine;
}

async function refresh() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`Health check failed (${response.status})`);
    render(await response.json());
  } catch (error) {
    $("connectionBanner").hidden = false;
    const badge = $("stateBadge");
    badge.classList.remove("state-good", "state-busy");
    badge.classList.add("state-bad");
    setText("stateText", "Connection lost");
    $("primaryAction").hidden = true;
    // Stop stays available whenever the last known state was active, so the
    // operator can retry it the instant the connection returns.
    $("stopButton").disabled = !["PRACTICE", "RUNNING", "HOMING", "FAULT"].includes(lastStatus?.state);
    for (const id of ["chipCameras", "chipRobot", "chipGripper", "chipModel"]) $(id).className = "health-chip warn";
    setText("detailText", "Status unavailable while the gateway is offline.");
    setText("updatedAt", lastGoodStatusAt ? `Last update ${new Date(lastGoodStatusAt).toLocaleTimeString()}` : "No update yet");
  }
}

// ---------- Wiring ----------
$("stopButton").addEventListener("click", () => api("/api/stop"));
$("takeoverButton").addEventListener("click", () => api("/api/owner", { owner: "HUMAN" }));
$("pauseButton").addEventListener("click", () => api("/api/owner", { owner: "PAUSED" }));
$("returnButton").addEventListener("click", () => api("/api/owner", { owner: "MODEL" }));
$("recordStart").addEventListener("click", () => api("/api/recordings/start"));
$("recordStop").addEventListener("click", () => api("/api/recordings/stop"));

$("modeCheck").addEventListener("change", (e) => { $("confirmPractice").disabled = !e.target.checked; });
$("confirmPractice").addEventListener("click", (e) => {
  e.preventDefault();
  if (!$("modeCheck").checked) return;
  $("practiceDialog").close();
  api("/api/practice", { mode_confirmed: true });
});
$("practiceDialog").addEventListener("close", () => { $("modeCheck").checked = false; $("confirmPractice").disabled = true; });

$("homeCheck").addEventListener("change", (e) => { $("confirmHome").disabled = !e.target.checked; });
$("confirmHome").addEventListener("click", (e) => {
  e.preventDefault();
  if (!$("homeCheck").checked) return;
  $("homeDialog").close();
  api("/api/home", { operator_confirmed: true });
});
$("homeDialog").addEventListener("close", () => { $("homeCheck").checked = false; $("confirmHome").disabled = true; });

$("confirmCheck").addEventListener("change", (e) => { $("confirmRun").disabled = !e.target.checked; });
$("confirmRun").addEventListener("click", (e) => {
  e.preventDefault();
  if (!$("confirmCheck").checked) return;
  $("runDialog").close();
  api("/api/run", { operator_confirmed: true });
});
$("runDialog").addEventListener("close", () => { $("confirmCheck").checked = false; $("confirmRun").disabled = true; });

let pendingSequence = null;
function askSequence(path, title, text) {
  pendingSequence = path;
  setText("seqTitle", title); setText("seqText", text);
  $("seqDialog").showModal();
}
$("testStart").addEventListener("click", () => askSequence("/api/test/start", "Start test",
  "The arm will move on its own: it opens the gripper and goes Home if needed, then the model drives. " +
  "Place the block first. Stop or the Space bar ends it at any time."));
$("testReset").addEventListener("click", () => askSequence("/api/test/reset", "Reset to Home",
  "This stops the run, closes the recording, opens the gripper (anything it holds will drop) and moves the arm Home."));
$("seqCheck").addEventListener("change", (e) => { $("confirmSeq").disabled = !e.target.checked; });
$("confirmSeq").addEventListener("click", (e) => {
  e.preventDefault();
  if (!$("seqCheck").checked || !pendingSequence) return;
  $("seqDialog").close();
  api(pendingSequence, { operator_confirmed: true });
});
$("seqDialog").addEventListener("close", () => { $("seqCheck").checked = false; $("confirmSeq").disabled = true; });
for (const [dial, valueId, path] of [["speedDial", "speedValue", "/api/speed"],
                                     ["teleopDial", "teleopValue", "/api/teleop-speed"]]) {
  $(dial).addEventListener("input", () => {
    dialBusyUntil[dial] = Date.now() + 2500;
    setText(valueId, `${$(dial).value}%`);
  });
  $(dial).addEventListener("change", () => {
    dialBusyUntil[dial] = Date.now() + 1500;
    api(path, { percent: Number($(dial).value) });
  });
}
// Model selector: only changeable while locked (DISARMED); Practice must pass again after a change.
function renderModels(status) {
  const models = status.models;
  const select = $("modelSelect");
  $("modelRow").hidden = !models || models.choices.length < 2;
  if ($("modelRow").hidden) return;
  if (select.options.length !== models.choices.length) {
    select.replaceChildren(...models.choices.map((c) => new Option(c.label, c.name)));
  }
  if (document.activeElement !== select) select.value = models.selected;
  select.disabled = status.state !== "DISARMED";
  setText("modelHint", status.state !== "DISARMED" ? "Lock (DISARMED) to change" :
    `checkpoint ${String(models.checkpoint_id || "").slice(0, 12)}`);
}
$("modelSelect").addEventListener("change", (e) => api("/api/model", { name: e.target.value }));
$("gripperOpen").addEventListener("click", () => api("/api/gripper/open"));
$("faultReset").addEventListener("click", () => api("/api/fault/reset"));

// Space stops from anywhere that isn't already an interactive control
// (which handles its own Space/Enter activation natively).
document.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat) return;
  const tag = document.activeElement?.tagName;
  if (["BUTTON", "INPUT", "SELECT", "TEXTAREA", "A"].includes(tag)) return;
  if (document.querySelector("dialog[open]")) return;
  if (!$("stopButton").disabled) { event.preventDefault(); $("stopButton").click(); }
});

for (const [id, target] of [["chipCameras", "detailText"], ["chipRobot", "detailText"],
                            ["chipGripper", "detailText"], ["chipModel", "detailText"]]) {
  $(id).addEventListener("click", () => { $("advanced").open = true; $(target).scrollIntoView({ block: "center" }); });
}

refresh();
window.setInterval(refresh, STATUS_POLL_MS);
