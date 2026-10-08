# How VeggieBot works

```
 Quest controllers ──WebXR──> Teleop server (laptop) ──RTDE 125 Hz──> UR16e + gripper
                                                                         │
 Cameras: front, top, wrist ──USB──> Jetson ─────────────────────────────┘
                                      │
              ┌───────────────────────┴────────────────────────┐
        Raw recorder (ROS 2)                          Inference gateway
   records demos, checks them                   runs a trained model on the arm
              │                                                │
              ▼                                                │  synced frames + arm state
      GPU server: dataset ──> training ──> model service <─────┘  (encrypted SSH tunnel)
```

Only one program owns the cameras and the robot link at a time: either the raw recorder (to record
demonstrations) or the inference gateway (to run a model).

## 1. Teleoperation

- A WebXR page on the Quest streams both controllers to a small Python server on a laptop.
- Holding the left grip button (the clutch) enables motion and the thumbsticks move the arm. The
  right trigger closes the gripper (release to open), the A and B buttons tilt the bottle around
  the fingertips for pouring, and a thumbstick click sends the arm Home.
- The server sends servo targets to the UR16e over RTDE at 125 Hz, with speed and workspace
  limits checked by the robot controller.

## 2. Raw recorder

A ROS 2 package on the Jetson with a web dashboard (port 8080):

- **Sensors:** front and top RealSense colour streams and the wrist camera at 30 Hz (640x480 JPEG),
  robot state from RTDE at 50 Hz, Robotiq gripper state and commands at 20 Hz.
- **Episodes:** one folder per demonstration with MCAP bags (cameras, gripper), `rtde.csv`,
  a manifest, a validation report and preview videos.
- **Validation:** frame rates, timestamp gaps, monotonic clocks and a single RTDE reader are
  checked automatically. The dashboard shows every check and lets the operator accept or reject
  each episode.
- **Review:** three synced camera videos, a joint plot and a 3D replay of the arm.

## 3. Dataset

- Episodes are converted to the LeRobot format at 10 Hz.
- A sample is kept only if all three cameras are within 25 ms of each other and the robot state
  is fresh.
- **Whole-episode rule:** if cleaning leaves any gap over 150 ms, the whole episode is dropped.
  There is no per-frame repair. In the first pour batch 9 of 61 episodes were dropped, all because
  the wrist camera lost frames while it shared a USB 2 bus with a RealSense. Moving both RealSense
  cameras to USB 3 fixed it.
- **Contract:** state = 6 joint angles plus gripper (0 to 1); action = joint target about 300 ms
  ahead plus gripper command. The model predicts 10 steps (1 second) at a time.

## 4. Training

| | Pi0.5 | SmolVLA |
|---|---|---|
| Framework | OpenPI (JAX), LoRA fine-tuning | LeRobot (PyTorch) |
| Hardware | 2 GPUs (FSDP), batch 2 | 1 GPU, batch 4 |
| Actions | joint deltas (joints), absolute (gripper) | absolute |
| Typical run | 80,000 steps, about 18 hours | 10,000 steps |

Checkpoints are compared offline on demos the model never saw: for every frame, how far is the
predicted target from what the person actually did, compared with simply standing still? A model
must clearly beat standing still before it touches the robot.

## 5. Inference gateway

A Python service on the Jetson with its own dashboard:

- **Sync:** grabs the three cameras and the arm state at the same moment and sends them to the
  model service (about 260 to 350 ms round trip).
- **Safety:** every predicted target is checked against joint limits, a joint speed cap
  (0.06 rad/s during trials), an acceleration limit, answer age, and the robot's own safety
  status. A run starts only from the Home pose and stops after a time limit.
- **States:** Disarmed, then Practice (the model answers but the arm does not move), then Run.
  Stop is always one click or the space bar away.
- **Human takeover:** the operator can take over with the Quest at any time, and the gateway
  records both the model's and the human's actions for later correction training.
- **Library:** every run is recorded with cameras, robot state, model answers and events, and can
  be replayed in 3D.

## Lessons

- A small change in camera position can quietly break a model; check the camera views before
  every test session.
- Spread demonstrations evenly over the workspace. Where demos are sparse, the model replays the
  nearest demo instead of finding the object.
- Be consistent when demonstrating: the same grasp, height and pour angle every time.
