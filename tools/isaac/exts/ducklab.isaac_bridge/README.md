# Duck Lab XR bridge (Isaac Sim extension)

Mirrors a live Duck Lab XR session into Isaac Sim: the room's and the course's
colliders, the terrain, Pip and the ball, posed every frame. Duck Lab XR
connects to `ws://<host>:8211/ducklab/ws` on Kit's own web server and shows
the viewport through Isaac Sim's WebRTC stream. Written for Isaac Sim 2022.2
(Kit 104); see `tools/isaac/README.md`.
