/* Lightweight UR16e replay.
 *
 * This is a browser-side projection of the official ROS ur_description UR16e
 * chain. It uses the real URDF joint origins and link dimensions, rather than
 * an unrelated box model. It is deliberately kinematic: no ROS node, camera
 * reader, physics engine, or network round trip is added to the recorder.
 */
(() => {
  'use strict';

  const PI = Math.PI;
  const MODEL = Object.freeze({
    name: 'UR16e',
    source: '/opt/ros/humble/share/ur_description/urdf/ur.urdf.xacro',
    urType: 'ur16e',
    // Values are from the generated UR16e ROS URDF on the Jetson.
    joints: [
      {name: 'shoulder_pan', xyz: [0, 0, 0.1807], rpy: [0, 0, 0]},
      {name: 'shoulder_lift', xyz: [0, 0, 0], rpy: [PI / 2, 0, 0]},
      {name: 'elbow', xyz: [-0.4784, 0, 0], rpy: [0, 0, 0]},
      {name: 'wrist_1', xyz: [-0.36, 0, 0.17415], rpy: [0, 0, 0]},
      {name: 'wrist_2', xyz: [0, -0.11985, 0], rpy: [PI / 2, 0, 0]},
      {name: 'wrist_3', xyz: [0, 0.11655, 0], rpy: [PI / 2, PI, PI]},
    ],
    linkLengths: {upperArm: 0.4784, forearm: 0.36},
  });

  const state = {
    canvas: null,
    points: [],
    trail: true,
    yaw: PI / 4,
    pitch: 0.38,
    zoom: 1,
    raf: null,
    handlers: [],
    trailCache: null,
    lastCursor: 0,
  };

  function identity() {
    return [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  }

  function multiply(a, b) {
    const out = identity();
    for (let r = 0; r < 4; r += 1) {
      for (let c = 0; c < 4; c += 1) {
        out[r][c] = a[r][0] * b[0][c] + a[r][1] * b[1][c] +
          a[r][2] * b[2][c] + a[r][3] * b[3][c];
      }
    }
    return out;
  }

  function translation([x, y, z]) {
    const t = identity();
    t[0][3] = x; t[1][3] = y; t[2][3] = z;
    return t;
  }

  function rpy([roll, pitch, yaw]) {
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    return [
      [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr, 0],
      [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr, 0],
      [-sp, cp * sr, cp * cr, 0],
      [0, 0, 0, 1],
    ];
  }

  function rotZ(angle) {
    const c = Math.cos(angle), s = Math.sin(angle);
    return [[c, -s, 0, 0], [s, c, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  }

  function point(transform) {
    return [transform[0][3], transform[1][3], transform[2][3]];
  }

  function forwardKinematics(q) {
    // RTDE joint samples are expressed in the controller base frame. The
    // generated ROS URDF adds a fixed pi rotation only for REP-103 display
    // conventions, so keep the controller frame here to match recorded TCP.
    let transform = identity();
    const chain = [[0, 0, 0]];
    MODEL.joints.forEach((joint, index) => {
      transform = multiply(transform, translation(joint.xyz));
      transform = multiply(transform, rpy(joint.rpy));
      transform = multiply(transform, rotZ(Number(q[index] || 0)));
      chain.push(point(transform));
    });
    // Small tool offset used by the URDF flange/tool frame for a readable TCP.
    const tool = multiply(transform, translation([0, 0, 0.11655]));
    chain.push(point(tool));
    return chain;
  }

  function interpolate(points, cursor) {
    if (!points.length) return [0, 0, 0, 0, 0, 0];
    if (points.length === 1 || cursor <= points[0].t) return points[0].q.slice(0, 6);
    const last = points[points.length - 1];
    if (cursor >= last.t) return last.q.slice(0, 6);
    let right = 1;
    while (right < points.length && points[right].t < cursor) right += 1;
    const left = points[right - 1], next = points[right];
    const ratio = Math.max(0, Math.min(1, (cursor - left.t) / Math.max(1e-6, next.t - left.t)));
    return left.q.slice(0, 6).map((value, index) => value + (next.q[index] - value) * ratio);
  }

  function project([x, y, z], width, height) {
    const cy = Math.cos(state.yaw), sy = Math.sin(state.yaw);
    const horizontal = cy * x - sy * y;
    const depthPlane = sy * x + cy * y;
    const cp = Math.cos(state.pitch), sp = Math.sin(state.pitch);
    const vertical = cp * z - sp * depthPlane;
    const depth = sp * z + cp * depthPlane;
    const scale = Math.min(width / 1.25, height / 1.28) * state.zoom;
    return {x: width / 2 + horizontal * scale, y: height * 0.84 - vertical * scale, depth};
  }

  function resizeCanvas(canvas) {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(240, canvas.clientWidth || 640);
    const height = Math.max(220, canvas.clientHeight || 360);
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    return {width, height, ratio};
  }

  function line(ctx, a, b, color, width, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.restore();
  }

  function drawGrid(ctx, width, height) {
    for (let value = -0.6; value <= 0.6001; value += 0.1) {
      const a = project([value, -0.6, 0], width, height);
      const b = project([value, 0.6, 0], width, height);
      const c = project([-0.6, value, 0], width, height);
      const d = project([0.6, value, 0], width, height);
      line(ctx, a, b, '#263844', 1, 0.8);
      line(ctx, c, d, '#263844', 1, 0.8);
    }
    const origin = project([0, 0, 0], width, height);
    line(ctx, origin, project([0.18, 0, 0], width, height), '#d15c67', 2, 0.8);
    line(ctx, origin, project([0, 0.18, 0], width, height), '#5eb8e8', 2, 0.8);
  }

  function drawBase(ctx, base, width, height) {
    const p = project(base, width, height);
    ctx.save();
    ctx.fillStyle = '#182a35';
    ctx.strokeStyle = '#5d7886';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(p.x, p.y + 8, 34, 10, 0, 0, 2 * PI); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#263f4c';
    ctx.beginPath(); ctx.ellipse(p.x, p.y + 1, 28, 8, 0, 0, 2 * PI); ctx.fill();
    ctx.restore();
  }

  function drawJointsAndLinks(ctx, chain, width, height) {
    const projected = chain.map(value => project(value, width, height));
    const linkColors = ['#dbe7ed', '#b7d1df', '#9db7c6', '#dbe7ed', '#acc6d3', '#dbe7ed', '#f2a64a'];
    const linkWidths = [24, 20, 18, 14, 11, 9, 7];
    for (let index = 0; index < projected.length - 1; index += 1) {
      line(ctx, projected[index], projected[index + 1], '#071016', linkWidths[index] + 8, 0.72);
      line(ctx, projected[index], projected[index + 1], linkColors[index], linkWidths[index], 1);
      line(ctx, projected[index], projected[index + 1], '#ffffff', 2, 0.22);
    }
    projected.forEach((item, index) => {
      const radius = index === 0 ? 16 : index < 4 ? 12 : 8;
      ctx.save();
      ctx.fillStyle = index === projected.length - 1 ? '#f2a64a' : '#253c49';
      ctx.strokeStyle = '#d7e5ec'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(item.x, item.y, radius, 0, 2 * PI); ctx.fill(); ctx.stroke();
      ctx.restore();
    });
    // A simple gripper silhouette attached to the URDF TCP, not a box proxy.
    const tcp = projected[projected.length - 1];
    const wrist = projected[projected.length - 2];
    const dx = tcp.x - wrist.x, dy = tcp.y - wrist.y;
    const norm = Math.max(1, Math.hypot(dx, dy));
    const nx = -dy / norm, ny = dx / norm;
    line(ctx, tcp, {x: tcp.x + dx / norm * 19 + nx * 12, y: tcp.y + dy / norm * 19 + ny * 12}, '#f2a64a', 5);
    line(ctx, tcp, {x: tcp.x + dx / norm * 19 - nx * 12, y: tcp.y + dy / norm * 19 - ny * 12}, '#f2a64a', 5);
    return projected;
  }

  function drawTrail(ctx, width, height) {
    if (!state.trail || !state.trailCache || state.trailCache.length < 2) return;
    ctx.save(); ctx.strokeStyle = '#61d7d0'; ctx.lineWidth = 2; ctx.globalAlpha = 0.75;
    ctx.setLineDash([4, 5]); ctx.beginPath();
    state.trailCache.forEach((value, index) => {
      const p = project(value, width, height);
      if (index) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
    });
    ctx.stroke(); ctx.restore();
  }

  function nearestPoint(points, cursor) {
    return points.reduce((best, item) => Math.abs(item.t - cursor) < Math.abs(best.t - cursor) ? item : best, points[0]);
  }

  function draw(cursor = 0) {
    if (!state.canvas || !state.points.length) return;
    state.lastCursor = cursor;
    const canvas = state.canvas;
    const {width, height, ratio} = resizeCanvas(canvas);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, '#071019'); gradient.addColorStop(1, '#0d1b24');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height);
    drawGrid(ctx, width, height);
    drawBase(ctx, [0, 0, 0], width, height);
    drawTrail(ctx, width, height);
    const q = interpolate(state.points, cursor);
    const chain = forwardKinematics(q);
    const projected = drawJointsAndLinks(ctx, chain, width, height);
    const latest = nearestPoint(state.points, cursor);
    const tcp = chain[chain.length - 1];
    const readout = document.getElementById('replayReadout');
    if (readout && latest) {
      readout.textContent = `UR16e URDF · t ${formatTimeSafe(cursor)} · TCP ` +
        `${tcp[0].toFixed(3)}, ${tcp[1].toFixed(3)}, ${tcp[2].toFixed(3)} m · ` +
        `J1 ${q[0].toFixed(2)}  J2 ${q[1].toFixed(2)}  J3 ${q[2].toFixed(2)} rad`;
    }
    ctx.save();
    ctx.fillStyle = '#9bb0bd'; ctx.font = '600 11px system-ui, sans-serif';
    ctx.fillText('UR16e · official ROS URDF kinematics', 12, 18);
    ctx.fillStyle = '#6d8794'; ctx.font = '10px system-ui, sans-serif';
    ctx.fillText('Drag to orbit · scroll to zoom', 12, height - 10);
    ctx.restore();
    // Keep the model visually grounded even when a short episode has no motion.
    if (!projected.length) return;
  }

  function formatTimeSafe(value) {
    const seconds = Math.max(0, Math.floor(Number(value) || 0));
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function removeHandlers() {
    state.handlers.forEach(([target, name, handler, options]) => target.removeEventListener(name, handler, options));
    state.handlers = [];
  }

  function setup(points) {
    stop();
    state.canvas = document.getElementById('robotReplay');
    state.points = Array.isArray(points) ? points.filter(item => Array.isArray(item.q) && item.q.length >= 6) : [];
    if (!state.canvas || !state.points.length) return;
    // Cache the TCP trail once. Episode detail is bounded server-side, so this is cheap.
    state.trailCache = state.points.map(item => forwardKinematics(item.q)[7]);
    const canvas = state.canvas;
    const orbit = event => {
      if (!state.dragging) return;
      state.yaw += event.movementX * 0.009;
      state.pitch = Math.max(-0.7, Math.min(1.3, state.pitch + event.movementY * 0.006));
      draw(state.lastCursor);
    };
    const down = event => { state.dragging = true; canvas.setPointerCapture?.(event.pointerId); };
    const up = event => { state.dragging = false; canvas.releasePointerCapture?.(event.pointerId); };
    const wheel = event => { event.preventDefault(); state.zoom = Math.max(0.65, Math.min(1.8, state.zoom * (event.deltaY < 0 ? 1.08 : 0.93))); draw(state.lastCursor); };
    const resize = () => draw(state.lastCursor);
    [[canvas, 'pointerdown', down], [canvas, 'pointermove', orbit], [canvas, 'pointerup', up],
      [canvas, 'pointercancel', up], [canvas, 'wheel', wheel, {passive: false}], [window, 'resize', resize]]
      .forEach(([target, name, handler, options]) => { target.addEventListener(name, handler, options); state.handlers.push([target, name, handler, options]); });
    const setView = (yaw, pitch) => { state.yaw = yaw; state.pitch = pitch; state.zoom = 1; draw(state.lastCursor); };
    const iso = document.getElementById('replayViewIso');
    const front = document.getElementById('replayViewFront');
    const top = document.getElementById('replayViewTop');
    const trail = document.getElementById('replayTrail');
    if (iso) iso.onclick = () => setView(PI / 4, 0.38);
    if (front) front.onclick = () => setView(0, 0.05);
    if (top) top.onclick = () => setView(0, PI / 2 - 0.04);
    if (trail) {
      trail.textContent = state.trail ? 'Hide trail' : 'Show trail';
      trail.onclick = () => { state.trail = !state.trail; trail.textContent = state.trail ? 'Hide trail' : 'Show trail'; draw(state.lastCursor); };
    }
    draw(0);
  }

  function stop() {
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = null;
    removeHandlers();
    state.canvas = null;
    state.points = [];
    state.trailCache = null;
  }

  window.setupRobotReplay = setup;
  window.drawRobotReplay = draw;
  window.stopRobotReplay = stop;
  window.VEGGIEBOT_UR16E_REPLAY_MODEL = MODEL;
})();
