/* UR16e visual mesh replay.
 * The DAE assets are the visual meshes from the Jetson's official ROS
 * ur_description package. URDF joint frames drive the meshes, while Three.js
 * is loaded locally by the Jetson and never fetched from a CDN at runtime.
 * Copied from the raw recorder (veggiebot_edge/web/ur16e_cad.js), 2026-10-02.
 */
import * as THREE from '/vendor/three.module.js';
import {ColladaLoader} from '/vendor/ColladaLoader.js';

(() => {
  'use strict';

  const PI = Math.PI;
  const WORLD = new THREE.Matrix4().makeRotationX(-PI / 2);
  const TARGET = new THREE.Vector3(0, 0.35, 0);
  const SPECS = [
    {name: 'base_link_inertia', asset: 'base', xyz: [0, 0, 0], rpy: [0, 0, PI]},
    {name: 'shoulder_link', asset: 'shoulder', xyz: [0, 0, 0], rpy: [0, 0, PI]},
    {name: 'upper_arm_link', asset: 'upperarm', xyz: [0, 0, 0.176], rpy: [PI / 2, 0, -PI / 2]},
    {name: 'forearm_link', asset: 'forearm', xyz: [0, 0, 0.04], rpy: [PI / 2, 0, -PI / 2]},
    {name: 'wrist_1_link', asset: 'wrist1', xyz: [0, 0, -0.135], rpy: [PI / 2, 0, 0]},
    {name: 'wrist_2_link', asset: 'wrist2', xyz: [0, 0, -0.12], rpy: [0, 0, 0]},
    {name: 'wrist_3_link', asset: 'wrist3', xyz: [0, -0.0005, -0.1168], rpy: [PI / 2, 0, 0]},
  ];
  const JOINTS = [
    {xyz: [0, 0, 0.1807], rpy: [0, 0, 0]},
    {xyz: [0, 0, 0], rpy: [PI / 2, 0, 0]},
    {xyz: [-0.4784, 0, 0], rpy: [0, 0, 0]},
    {xyz: [-0.36, 0, 0.17415], rpy: [0, 0, 0]},
    {xyz: [0, -0.11985, 0], rpy: [PI / 2, 0, 0]},
    {xyz: [0, 0.11655, 0], rpy: [PI / 2, PI, PI]},
  ];
  const meshCache = new Map();
  const state = {
    canvas: null, points: [], renderer: null, scene: null, camera: null,
    root: null, links: [], tcp: null, trail: null, trailVisible: true,
    yaw: PI / 4, pitch: 0.38, distance: 1.75, cursor: 0,
    handlers: [], dragging: false, loading: false, renderQueued: false,
  };

  function translation([x, y, z]) { return new THREE.Matrix4().makeTranslation(x, y, z); }
  function rotation([roll, pitch, yaw]) {
    // URDF rpy is a fixed-axis roll-pitch-yaw rotation: Rz(yaw) * Ry(pitch) * Rx(roll).
    return new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(roll, pitch, yaw, 'ZYX'));
  }
  function zRotation(angle) { return new THREE.Matrix4().makeRotationZ(angle); }
  function frameMatrices(q) {
    let frame = new THREE.Matrix4();
    const frames = [frame.clone()];
    JOINTS.forEach((joint, index) => {
      frame = frame.clone().multiply(translation(joint.xyz));
      frame.multiply(rotation(joint.rpy));
      frame.multiply(zRotation(Number(q[index] || 0)));
      frames.push(frame.clone());
    });
    const tcp = frame.clone().multiply(translation([0, 0, 0.11655]));
    frames.push(tcp);
    return frames;
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
  function toWorld(matrix) { return WORLD.clone().multiply(matrix); }
  function worldPoint(matrix) { return new THREE.Vector3().setFromMatrixPosition(toWorld(matrix)); }
  function resize() {
    if (!state.renderer || !state.canvas) return;
    const width = Math.max(240, state.canvas.clientWidth || 640);
    const height = Math.max(220, state.canvas.clientHeight || 340);
    state.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    state.renderer.setSize(width, height, false);
    state.camera.aspect = width / height;
    state.camera.updateProjectionMatrix();
  }
  function updateCamera() {
    if (!state.camera) return;
    const horizontal = state.distance * Math.cos(state.pitch);
    state.camera.position.set(
      TARGET.x + horizontal * Math.cos(state.yaw),
      TARGET.y + state.distance * Math.sin(state.pitch),
      TARGET.z + horizontal * Math.sin(state.yaw),
    );
    state.camera.lookAt(TARGET);
  }
  function frameGroup(index, matrix) {
    const link = state.links[index];
    if (!link) return;
    link.matrixAutoUpdate = false;
    link.matrix.copy(toWorld(matrix).multiply(visualMatrix(SPECS[index])));
  }
  function visualMatrix(spec) { return translation(spec.xyz).multiply(rotation(spec.rpy)); }
  function loadAsset(asset) {
    if (meshCache.has(asset)) return meshCache.get(asset);
    const promise = new Promise((resolve, reject) => {
      const loader = new ColladaLoader();
      loader.load(`/api/model/ur16e/${encodeURIComponent(asset)}.dae`, result => {
        // ColladaLoader converts the mesh from ROS Z-up to Three.js Y-up at
        // the scene root. The URDF link and visual transforms below are still
        // expressed in ROS coordinates, so keep the mesh in its original
        // Z-up frame and perform that conversion once at WORLD instead.
        result.scene.rotation.set(0, 0, 0);
        result.scene.updateMatrix();
        result.scene.traverse(object => {
          if (!object.isMesh) return;
          object.castShadow = false; object.receiveShadow = false;
          if (Array.isArray(object.material)) object.material.forEach(material => { material.flatShading = false; });
          else if (object.material) object.material.flatShading = false;
        });
        resolve(result.scene);
      }, undefined, reject);
    });
    meshCache.set(asset, promise);
    return promise;
  }
  function makeScene() {
    state.renderer = new THREE.WebGLRenderer({canvas: state.canvas, antialias: true, powerPreference: 'low-power'});
    state.renderer.outputColorSpace = THREE.SRGBColorSpace;
    state.renderer.setClearColor(0x071019, 1);
    state.scene = new THREE.Scene();
    state.scene.add(new THREE.AmbientLight(0xd9e9f2, 1.8));
    const key = new THREE.DirectionalLight(0xffffff, 2.2); key.position.set(1.8, 2.4, 1.3); state.scene.add(key);
    const fill = new THREE.DirectionalLight(0x6eb8e8, 0.8); fill.position.set(-1.5, 1.0, -1.8); state.scene.add(fill);
    const grid = new THREE.GridHelper(1.4, 14, 0x36515d, 0x1c303b);
    grid.position.y = 0; state.scene.add(grid);
    state.root = new THREE.Group(); state.scene.add(state.root);
    state.camera = new THREE.PerspectiveCamera(34, 1, 0.01, 10);
    state.links = SPECS.map(() => new THREE.Group());
    state.links.forEach(link => { link.matrixAutoUpdate = false; state.root.add(link); });
    const tcpMaterial = new THREE.MeshStandardMaterial({color: 0xf2a64a, roughness: 0.48, metalness: 0.12});
    state.tcp = new THREE.Mesh(new THREE.SphereGeometry(0.024, 16, 10), tcpMaterial);
    state.root.add(state.tcp);
    state.tcp.matrixAutoUpdate = false;
    resize(); updateCamera();
  }
  function makeTrail() {
    const points = [];
    state.points.forEach(item => points.push(worldPoint(frameMatrices(item.q)[7])));
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({color: 0x61d7d0, transparent: true, opacity: 0.78});
    state.trail = new THREE.Line(geometry, material); state.trail.visible = state.trailVisible; state.root.add(state.trail);
  }
  async function loadMeshes() {
    state.loading = true;
    try {
      const loaded = await Promise.all(SPECS.map(spec => loadAsset(spec.asset)));
      loaded.forEach((scene, index) => state.links[index].add(scene.clone(true)));
      makeTrail();
      state.loading = false;
      const badge = document.querySelector('.replay-badge'); if (badge) badge.textContent = 'UR16e CAD mesh + URDF';
      draw(state.cursor);
    } catch (error) {
      state.loading = false;
      const readout = document.getElementById('replayReadout');
      if (readout) readout.textContent = `UR16e CAD mesh unavailable: ${error.message || error}`;
      // The existing lightweight URDF line replay remains available as fallback.
      window.dispatchEvent(new CustomEvent('veggiebot-cad-error', {detail: String(error)}));
    }
  }
  function draw(cursor = 0) {
    if (!state.renderer || !state.points.length) return;
    state.cursor = Number(cursor) || 0;
    const frames = frameMatrices(interpolate(state.points, state.cursor));
    frames.slice(0, SPECS.length).forEach((frame, index) => frameGroup(index, frame));
    if (state.tcp) state.tcp.matrix.copy(toWorld(frames[7]));
    updateCamera(); state.renderer.render(state.scene, state.camera);
    const readout = document.getElementById('replayReadout');
    if (readout && !state.loading) {
      const tcp = worldPoint(frames[7]);
      const q = interpolate(state.points, state.cursor);
      readout.textContent = `UR16e CAD + URDF · t ${formatTimeSafe(state.cursor)} · TCP ` +
        `${tcp.x.toFixed(3)}, ${(-tcp.z).toFixed(3)}, ${tcp.y.toFixed(3)} m · ` +
        `J1 ${q[0].toFixed(2)}  J2 ${q[1].toFixed(2)}  J3 ${q[2].toFixed(2)} rad`;
    }
  }
  function formatTimeSafe(value) { const seconds = Math.max(0, Math.floor(Number(value) || 0)); return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; }
  function removeHandlers() { state.handlers.forEach(([target, name, handler, options]) => target.removeEventListener(name, handler, options)); state.handlers = []; }
  function setup(points) {
    stop();
    state.canvas = document.getElementById('robotReplay');
    state.points = Array.isArray(points) ? points.filter(item => Array.isArray(item.q) && item.q.length >= 6) : [];
    if (!state.canvas || !state.points.length) return;
    try { makeScene(); } catch (error) { window.dispatchEvent(new CustomEvent('veggiebot-cad-error', {detail: String(error)})); return; }
    const canvas = state.canvas;
    const down = event => { state.dragging = true; canvas.setPointerCapture?.(event.pointerId); };
    const move = event => { if (!state.dragging) return; state.yaw += event.movementX * 0.009; state.pitch = Math.max(-0.7, Math.min(1.3, state.pitch + event.movementY * 0.006)); draw(state.cursor); };
    const up = event => { state.dragging = false; canvas.releasePointerCapture?.(event.pointerId); };
    const wheel = event => { event.preventDefault(); state.distance = Math.max(0.8, Math.min(3.2, state.distance * (event.deltaY < 0 ? 0.93 : 1.08))); draw(state.cursor); };
    const resizeHandler = () => { resize(); draw(state.cursor); };
    [[canvas, 'pointerdown', down], [canvas, 'pointermove', move], [canvas, 'pointerup', up], [canvas, 'pointercancel', up], [canvas, 'wheel', wheel, {passive: false}], [window, 'resize', resizeHandler]].forEach(([target, name, handler, options]) => { target.addEventListener(name, handler, options); state.handlers.push([target, name, handler, options]); });
    const setView = (yaw, pitch) => { state.yaw = yaw; state.pitch = pitch; state.distance = 1.75; draw(state.cursor); };
    const iso = document.getElementById('replayViewIso'); if (iso) iso.onclick = () => setView(PI / 4, 0.38);
    const front = document.getElementById('replayViewFront'); if (front) front.onclick = () => setView(0, 0.05);
    const top = document.getElementById('replayViewTop'); if (top) top.onclick = () => setView(0, PI / 2 - 0.04);
    const trail = document.getElementById('replayTrail'); if (trail) { trail.textContent = state.trailVisible ? 'Hide trail' : 'Show trail'; trail.onclick = () => { state.trailVisible = !state.trailVisible; if (state.trail) state.trail.visible = state.trailVisible; trail.textContent = state.trailVisible ? 'Hide trail' : 'Show trail'; draw(state.cursor); }; }
    draw(0); loadMeshes();
  }
  function stop() {
    removeHandlers();
    if (state.renderer) state.renderer.clear();
    state.canvas = null; state.points = []; state.links = []; state.root = null; state.scene = null; state.tcp = null; state.trail = null; state.loading = false;
  }

  window.setupRobotCAD = setup;
  window.drawRobotCAD = draw;
  window.stopRobotCAD = stop;
  window.dispatchEvent(new Event('veggiebot-cad-ready'));
})();
