# VeggieBot

Teaching a UR16e robot arm kitchen tasks from human demonstrations.

**Website and live demo copies:** https://aeromaddy123.github.io/veggiebot/

An operator drives the arm with a VR controller while three cameras and the robot state are
recorded. The recordings train vision-language-action (VLA) models, Pi0.5 and SmolVLA, which then
run the arm on their own through a safety gateway. The long-term goal is a robot that helps with
simple recipes at a fixed kitchen station. The current task is the first step of lemon water:

> Pick up the bottle anywhere on the table, pour into the bowl, and put the bottle back in its dock.

## What is in this repository

| Path | What it is |
|---|---|
| `index.html` | Project page (GitHub Pages) |
| `raw-recorder/` | Demo copy of the recording dashboard, with two recorded pour demos |
| `inference-gateway/` | Demo copy of the model dashboard, with two recorded model runs |
| `docs/architecture.md` | How the whole system works, step by step |
| `docs/demo-copies.md` | How the demo copies work and how to refresh them |
| `ur16e/` | 3D meshes of the arm used by both dashboards |

The demo copies use the real dashboard files **unchanged**. A small service worker answers their
server requests from saved data, so they work as plain web pages. They are not connected to any
robot, camera or model; buttons only show a "demo copy" message.

## The system in five steps

1. **Show.** Meta Quest controllers drive the arm through a WebXR page served from a laptop. The
   server turns controller motion into UR RTDE servo commands at 125 Hz, with a dedicated "pour"
   control that tilts the bottle around the fingertips.
2. **Record.** A ROS 2 stack on an NVIDIA Jetson records the front, top and wrist cameras (30 Hz),
   robot state (50 Hz) and gripper (20 Hz) into MCAP files, then validates every episode
   (frame rates, gaps, clocks) and makes preview videos.
3. **Check.** Episodes are converted to a LeRobot dataset at 10 Hz. Each sample holds the three
   images, the arm state (6 joints and gripper) and the target about 300 ms ahead. If any part of
   an episode is damaged or out of sync, the **whole episode is dropped**.
4. **Study.** Models are fine-tuned on a lab GPU server (4x RTX A4000): Pi0.5 with OpenPI (JAX,
   LoRA, 2 GPUs) and SmolVLA with LeRobot. Checkpoints are compared on held-out demos against a
   "stand still" baseline before any robot test.
5. **Try.** The inference gateway on the Jetson sends synced frames and the arm state to the model
   service over an encrypted tunnel, checks every answer (joint limits, speed and acceleration
   caps, staleness, Home position), moves the arm, and records each run for review.

More detail: [docs/architecture.md](docs/architecture.md).

## Results so far

| Task | Model | Training data | Result |
|---|---|---|---|
| Pick up a block | SmolVLA | 153 demos | Reaches and grasps on many runs; never retries after a miss |
| Pick up a block | Pi0.5 | 123 demos | About 8 of 9 grasps on the real robot after the top camera was put back in place |
| Pour and dock | Pi0.5 (80k steps) | 52 demos, about 1 hour | Predicts the demonstrator's moves 2.2x better than standing still on an unseen demo; on the robot it does not grasp yet |

What we learned:

- **Camera placement matters.** A slightly moved top camera made a good pick-and-place model reach
  for the wrong side, and fixing the camera fixed the model.
- **Few demos mean copying, not understanding.** With 52 pour demos the model reaches and carries
  well on unseen positions but mostly memorises the grasp. Its error on unseen demos is about 1.5x
  its error on training demos. Next round: about 225 demos (about 5 hours), which is the amount
  Physical Intelligence used for their simplest fine-tuning tasks.
- **Check offline first, then on the robot, and trust only the robot.** Low training loss did not
  mean the robot succeeds.

## Hardware

- Universal Robots UR16e with a Robotiq gripper
- Cameras: two Intel RealSense D435i (front, top) and a USB wrist camera
- NVIDIA Jetson for sensors, recording and the gateway
- Lab GPU server with 4x NVIDIA RTX A4000 (16 GB) for training and model serving
- Meta Quest for teleoperation

## Credits

- 3D arm meshes: [Universal Robots ROS 2 Description](https://github.com/UniversalRobots/Universal_Robots_ROS2_Description), BSD-3-Clause, Universal Robots A/S
- 3D viewer: [three.js](https://threejs.org), MIT (licence in the `vendor/` folders)
- Models and training: [OpenPI](https://github.com/Physical-Intelligence/openpi) and [LeRobot](https://github.com/huggingface/lerobot), Apache-2.0

Author: Kishan Chhari.
