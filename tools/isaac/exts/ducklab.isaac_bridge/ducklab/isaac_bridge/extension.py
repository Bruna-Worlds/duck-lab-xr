# Copyright 2026 BRUNA GOODS LLC
# SPDX-License-Identifier: Apache-2.0
"""Duck Lab XR bridge for Isaac Sim (Isaac Sim 2022.2 / Kit 104 and 4.5 / Kit 106).

Duck Lab XR, the browser app, connects to ws://<host>:8211/ducklab/ws on
Kit's own web server, sends its scene (the room's and the course's
colliders, the terrain, Pip's meshes, the ball) and then Pip's pose every
frame. On Isaac Sim 4.x the same messages can come over the WebRTC stream's
own data channel instead (the transport section below). This extension builds that scene in the open stage and mirrors the
pose (stage.py). The viewport goes back to the app over Isaac Sim's WebRTC
stream, whose player the app runs in its own page: CORS lets that page call
Kit's /streaming/ endpoints (2022.2), or the bridge serves it NVIDIA's
streaming library from tools/isaac/vendor/ (4.5: fetch-streaming-library.mjs).

Messages (JSON text), app to Isaac Sim:
  scene      statics (shapes posed in the world), terrain (a height field), or null
  terrain    a new height field only
  duck       body names (the order poses use) and the ball
  duck-body  one body's triangles, one entry per material
  camera     follow: whether the viewport camera follows Pip; eye and target
             (MuJoCo frame) place it once
  view       ui: Isaac Sim's own panels and the viewport's readout of frame rate
             and memory (false: the viewport alone fills the stream); they come
             back when the app disconnects
  clear      removes the scene
  ping       answered with pong
  part       a slice of a longer message (id, index, count, data): Kit's web server
             takes 1 MiB at most per WebSocket message, so long ones come in parts
and every frame a pose as binary: little-endian float32, seven per body
(x, y, z, qw, qx, qy, qz in the order of the duck message, the trunk first),
then seven for the ball (NaN when there is none).
Isaac Sim answers hello on connect, ack for scene messages, and error.

Over the WebRTC stream's data channel (Isaac Sim 4.x, omni.kit.livestream.webrtc),
each message is the JSON {"event_type": "ducklab", "payload": <message>}; Kit
puts it on its message bus as omni.kit.livestream.receive_message. The app
says hello first (answered with hello), poses are {"type": "pose", "data":
<the binary frame in base64>}, and replies go back the same way
(omni.kit.livestream.send_message). The channel takes 64 KiB per message, so
parts are smaller there, and each part is answered with {"type": "got", "id",
"index"}: the browser drops what overflows its send buffer, so the app keeps
only a few MB unconfirmed. The channel has no close of its own: it
counts as gone after CHANNEL_QUIET_S without a message (the app pings).
One app drives the stage: a hello on either transport takes it from the
other (the socket is closed with 4000; the channel gets {"type": "bye",
"code": 4000}).

Test cases (Isaac Sim 4.x, testcase.py): POST /ducklab/testcase {folder, title,
options} runs a scenario pack exported by the trainer under PhysX in the stage,
beside MuJoCo's run of it as an orange ghost Pip, in real time; GET
/ducklab/testcase is its progress and result; POST /ducklab/testcase/again plays
it again from the start; POST /ducklab/testcase/stop removes it and shows the
live mirror again.

Also GET /ducklab/status (what is mirrored, and which stream player this Isaac
Sim needs), GET /ducklab/player/streaming.js (NVIDIA's library, when fetched),
GET /ducklab/capture (a PNG of the viewport) and GET /ducklab/prims?root=&depth=
(the stage tree), for checks.
"""
import asyncio
import base64
import json
import os
import re
import tempfile
import time

import carb
import carb.events
import carb.settings
import numpy as np
import omni.ext
import omni.kit.app
import omni.usd
from omni.services.core import main as services
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse
from starlette.websockets import WebSocket, WebSocketDisconnect

from .stage import DuckStage
from .testcase import TestCase

VERSION = "0.1.0"
SOCKET_PATH = "/ducklab/ws"
ORIGINS_SETTING = "/exts/ducklab.isaac_bridge/origins"
HIDE_UI_SETTING = "/app/window/hideUi"  # the viewport window watches it and fills the window
# RTX Eco Mode (on in Isaac Sim 4.5) stops drawing frames it judges unchanged: with Pip moving every
# frame, the stream then shows black frames between drawn ones. Off while an app drives the stage.
ECO_SETTING = "/rtx/ecoMode/enabled"
DEFAULT_ORIGINS = r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$"
# Where the viewport camera sits relative to Pip when following (MuJoCo frame, metres):
# high enough to look over a sofa or a table edge in a scanned room.
FOLLOW_OFFSET = (-0.45, -0.5, 0.8)
FOLLOW_EASE = 0.12
# The WebRTC stream's data channel (Kit 105+): message bus events, and the event_type of ours.
RECEIVE_EVENT = "omni.kit.livestream.receive_message"
SEND_EVENT = "omni.kit.livestream.send_message"
CHANNEL_EVENT = "ducklab"
CHANNEL_QUIET_S = 6.0
# NVIDIA's WebRTC streaming library for Isaac Sim 4.x+, fetched by tools/isaac/fetch-streaming-library.mjs.
STREAMING_LIBRARY = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "vendor", "omniverse-webrtc-streaming-library", "index.js"))


async def close_quietly(websocket, code):
    """Closes a socket that may already be closed."""
    try:
        await websocket.close(code=code)
    except Exception:
        pass


class PrivateNetworkAccess:
    """Answers Chrome's private-network preflight (a page on the web reaching this computer)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not any(k == b"access-control-request-private-network" for k, _ in scope.get("headers", [])):
            await self.app(scope, receive, send)
            return

        async def send_allowing(message):
            if message["type"] == "http.response.start":
                message = dict(message, headers=list(message.get("headers", [])) + [(b"access-control-allow-private-network", b"true")])
            await send(message)

        await self.app(scope, receive, send_allowing)


class Extension(omni.ext.IExt):
    def on_startup(self, ext_id):
        pattern = carb.settings.get_settings().get(ORIGINS_SETTING) or DEFAULT_ORIGINS
        self._origins = re.compile(pattern)
        self._scene = None
        self._socket = None
        self._alive = True
        self._follow = True
        self._camera = None
        self._camera_at = 0.0
        self._eye = None
        self._target = None
        self._parts = {}
        self._ui_before = None  # Isaac Sim's own hideUi, while the app has changed it
        self._hud_before = None  # (setting, value) of the viewport's readout, likewise
        self._channel = False  # the app drives the stage over the stream's data channel
        self._channel_at = 0.0
        self._stats = {"connections": 0, "poses": 0, "lastPoseAt": 0.0, "scenes": 0, "triangles": 0, "lastMessageMs": 0.0}
        self._testcase = TestCase(focus=self._follow_point, view=self._testcase_view)
        self._stage_events = omni.usd.get_context().get_stage_event_stream().create_subscription_to_pop(self._on_stage_event, name="ducklab bridge")
        bus = omni.kit.app.get_app().get_message_bus_event_stream()
        self._channel_events = bus.create_subscription_to_pop_by_type(
            carb.events.type_from_string(RECEIVE_EVENT), self._on_channel, name="ducklab channel")
        self._channel_watch = asyncio.ensure_future(self._watch_channel())
        services.register_websocket_endpoint(SOCKET_PATH, self._on_socket)
        services.register_endpoint("get", "/ducklab/status", self._status)
        services.register_endpoint("get", "/ducklab/capture", self._capture)
        services.register_endpoint("get", "/ducklab/prims", self._prims)
        services.register_endpoint("get", "/ducklab/player/streaming.js", self._streaming_library)
        services.register_endpoint("get", "/ducklab/testcase", self._testcase_status)
        services.register_endpoint("post", "/ducklab/testcase", self._testcase_start)
        services.register_endpoint("post", "/ducklab/testcase/again", self._testcase_again)
        services.register_endpoint("post", "/ducklab/testcase/stop", self._testcase_stop)
        app = services.get_app()
        # Newer Starlette (Isaac Sim 4.5) refuses middleware once its stack is built: clear it, and it
        # rebuilds on the next request; older Starlette (2022.2) rebuilds it in add_middleware.
        app.middleware_stack = None
        app.add_middleware(CORSMiddleware, allow_origin_regex=pattern, allow_methods=["*"], allow_headers=["*"])
        app.add_middleware(PrivateNetworkAccess)
        carb.log_info("[ducklab] Duck Lab XR bridge %s: ws://<this computer>:8211%s" % (VERSION, SOCKET_PATH))

    def on_shutdown(self):
        services.deregister_endpoint("get", "/ducklab/status")
        services.deregister_endpoint("get", "/ducklab/capture")
        services.deregister_endpoint("get", "/ducklab/prims")
        services.deregister_endpoint("get", "/ducklab/player/streaming.js")
        services.deregister_endpoint("get", "/ducklab/testcase")
        services.deregister_endpoint("post", "/ducklab/testcase")
        services.deregister_endpoint("post", "/ducklab/testcase/again")
        services.deregister_endpoint("post", "/ducklab/testcase/stop")
        if self._testcase is not None:
            self._testcase.shutdown()
            self._testcase = None
        app = services.get_app()
        if app is not None:
            app.router.routes[:] = [r for r in app.router.routes if getattr(r, "path", None) != SOCKET_PATH]
            app.user_middleware[:] = [m for m in app.user_middleware if m.cls not in (CORSMiddleware, PrivateNetworkAccess)]
            app.middleware_stack = app.build_middleware_stack()
        self._restore_ui()
        # The open connection outlives this object (a hot reload, a shutdown): end it, so its
        # handler stops; the app reconnects to whatever comes next (1012: service restart).
        self._alive = False
        socket, self._socket = self._socket, None
        if socket is not None:
            asyncio.ensure_future(close_quietly(socket, 1012))
        if self._channel:
            self._send_channel({"type": "bye", "code": 1012})
        self._channel = False
        self._channel_events = None
        if self._channel_watch is not None:
            self._channel_watch.cancel()
            self._channel_watch = None
        self._stage_events = None
        self._scene = None

    # --- The socket -----------------------------------------------------------------

    async def _on_socket(self, websocket: WebSocket):
        origin = websocket.headers.get("origin")
        if origin and not self._origins.match(origin):
            carb.log_warn("[ducklab] refused a connection from %s" % origin)
            await websocket.close(code=4403)
            return
        await websocket.accept()
        # One app drives the stage: a new connection replaces the last.
        previous, self._socket = self._socket, websocket
        self._parts = {}
        self._take_from_channel()
        if previous is not None:
            await close_quietly(previous, 4000)
        try:
            if self._socket is not websocket:
                return  # yet another connection took over while the last one closed
            self._stats["connections"] += 1
            await websocket.send_text(json.dumps(self._hello("socket")))
            while getattr(self, "_alive", False) and self._socket is websocket:
                message = await websocket.receive()
                if message["type"] == "websocket.disconnect":
                    break
                if message.get("bytes") is not None:
                    self._pose(message["bytes"])
                    continue
                reply = self._handle(json.loads(message.get("text") or "{}"))
                if reply is not None:
                    await websocket.send_text(json.dumps(reply))
        except (WebSocketDisconnect, RuntimeError):
            pass  # closed by the app, or taken over by another connection
        except Exception as err:  # a bad message, or a message for a bridge that has shut down
            if getattr(self, "_alive", False):
                carb.log_warn("[ducklab] connection ended: %r" % err)
        finally:
            if getattr(self, "_socket", None) is websocket:
                self._socket = None
                self._restore_ui()

    # --- The stream's data channel -------------------------------------------------------

    def _on_channel(self, event):
        try:
            envelope = json.loads(event.payload["message"])
        except Exception:
            return
        if not isinstance(envelope, dict) or envelope.get("event_type") != CHANNEL_EVENT:
            return  # someone else's message
        message = envelope.get("payload") or {}
        kind = message.get("type")
        if kind == "hello":
            # The app over the stream takes the stage from any WebSocket.
            socket, self._socket = self._socket, None
            if socket is not None:
                asyncio.ensure_future(close_quietly(socket, 4000))
            self._parts = {}
            self._channel = True
            self._channel_at = time.time()
            self._stats["connections"] += 1
            self._send_channel(self._hello("channel"))
            return
        if not self._channel:
            return  # not driving the stage (another app took it, or no hello yet)
        self._channel_at = time.time()
        try:
            if kind == "pose":
                self._pose(base64.b64decode(message.get("data") or ""))
                return
            if kind == "part":
                self._send_channel({"type": "got", "id": message.get("id"), "index": message.get("index")})
            reply = self._handle(message)
        except Exception as err:
            carb.log_warn("[ducklab] bad message over the stream: %r" % err)
            reply = {"type": "error", "message": str(err)}
        if reply is not None:
            self._send_channel(reply)

    def _send_channel(self, message):
        bus = omni.kit.app.get_app().get_message_bus_event_stream()
        envelope = json.dumps({"event_type": CHANNEL_EVENT, "payload": message})
        bus.push(carb.events.type_from_string(SEND_EVENT), payload={"message": envelope})

    def _take_from_channel(self):
        if self._channel:
            self._send_channel({"type": "bye", "code": 4000})
            self._channel = False

    async def _watch_channel(self):
        """The channel has no close: the app counts as gone once it goes quiet."""
        while getattr(self, "_alive", False):
            await asyncio.sleep(1.0)
            if self._channel and time.time() - self._channel_at > CHANNEL_QUIET_S:
                self._channel = False
                self._restore_ui()

    def _hello(self, transport):
        settings = carb.settings.get_settings()
        if getattr(self, "_eco_before", None) is None:
            self._eco_before = (settings.get(ECO_SETTING),)
            settings.set(ECO_SETTING, False)
        return {
            "type": "hello",
            "bridge": VERSION,
            "transport": transport,
            "app": settings.get("/app/name") or "Kit",
            "appVersion": settings.get("/app/version") or omni.kit.app.get_app().get_build_version(),
            "stage": omni.usd.get_context().get_stage_url(),
        }

    # --- Messages -------------------------------------------------------------------------

    def _pose(self, data):
        """One binary pose frame (see the module docstring)."""
        scene = self._scene
        values = np.frombuffer(data, dtype="<f4")
        if scene is None or values.size % 7 != 0 or values.size < 14:
            return
        rows = values.reshape(-1, 7).astype(np.float64)
        bodies, ball = rows[:-1], rows[-1]
        scene.set_pose(bodies.tolist(), None if np.isnan(ball[0]) else ball.tolist())
        self._stats["poses"] += 1
        self._stats["lastPoseAt"] = time.time()
        if self._testcase is None or not self._testcase.active:  # a test case has the camera
            self._follow_camera(bodies[0][:3].tolist())

    def _handle(self, message):
        kind = message.get("type")
        if kind == "part":
            # A long message in slices: handle it once the last one is in.
            slices = self._parts.setdefault(message.get("id"), {})
            slices[int(message.get("index", 0))] = message.get("data") or ""
            count = int(message.get("count", 1))
            if len(slices) < count:
                return None
            del self._parts[message.get("id")]
            return self._handle(json.loads("".join(slices[i] for i in range(count))))
        started = time.perf_counter()
        if kind == "ping":
            return {"type": "pong", "t": message.get("t")}
        if kind == "camera":
            self._follow = bool(message.get("follow", True))
            self._target = None
            eye, target = message.get("eye"), message.get("target")
            camera = self._camera_state() if eye and target and self._scene is not None else None
            if camera is not None:
                camera.set_position_world(self._scene.to_stage(eye), True)
                camera.set_target_world(self._scene.to_stage(target), True)
            return {"type": "ack", "of": kind, "follow": self._follow}
        if kind == "view":
            settings = carb.settings.get_settings()
            ui = bool(message.get("ui", True))
            if self._ui_before is None:
                self._ui_before = bool(settings.get(HIDE_UI_SETTING))
                hud = self._hud_setting()
                self._hud_before = (hud, settings.get(hud)) if hud else None
            settings.set(HIDE_UI_SETTING, not ui)
            if self._hud_before is not None:
                # Kit 105+ draws frame rate and memory over the viewport: off with the panels.
                settings.set(self._hud_before[0], bool(self._hud_before[1] is not False) if ui else False)
            return {"type": "ack", "of": kind, "ui": bool(message.get("ui", True))}
        scene = self._scene_for_stage()
        reply = {"type": "ack", "of": kind}
        if kind == "scene":
            reply["statics"] = scene.set_statics(message.get("statics") or [])
            reply["terrainFaces"] = scene.set_terrain(message.get("terrain"))
            self._stats["scenes"] += 1
            self._target = None  # frame Pip afresh
        elif kind == "terrain":
            reply["terrainFaces"] = scene.set_terrain(message.get("terrain"))
        elif kind == "duck":
            scene.begin_duck(message.get("bodies") or [])
            scene.set_ball(message.get("ball"))
            self._stats["triangles"] = 0
            reply["bodies"] = len(scene.body_names)
        elif kind == "duck-body":
            triangles = scene.add_body_meshes(message.get("name"), message.get("meshes") or [])
            self._stats["triangles"] += triangles
            reply["name"] = message.get("name")
            reply["triangles"] = triangles
        elif kind == "clear":
            scene.clear()
            self._scene = None
        else:
            return {"type": "error", "message": "unknown message type %r" % kind}
        reply["ms"] = round((time.perf_counter() - started) * 1000, 1)
        self._stats["lastMessageMs"] = reply["ms"]
        return reply

    def _restore_ui(self):
        settings = carb.settings.get_settings()
        eco, self._eco_before = getattr(self, "_eco_before", None), None
        if eco is not None:
            if eco[0] is None:
                settings.destroy_item(ECO_SETTING)
            else:
                settings.set(ECO_SETTING, eco[0])
        if self._ui_before is not None:
            settings.set(HIDE_UI_SETTING, self._ui_before)
            self._ui_before = None
        hud, self._hud_before = getattr(self, "_hud_before", None), None
        if hud is not None:
            # A persistent setting (Kit saves it): put back exactly what was there.
            if hud[1] is None:
                settings.destroy_item(hud[0])
            else:
                settings.set(hud[0], hud[1])

    @staticmethod
    def _hud_setting():
        """The active viewport's readout setting (Kit 105+), or None."""
        try:
            from omni.kit.viewport.utility import get_active_viewport

            viewport = get_active_viewport()
            vid = getattr(viewport, "id", None) if viewport is not None else None
            return "/persistent/app/viewport/%s/hud/visible" % vid if vid else None
        except Exception:
            return None

    def _scene_for_stage(self):
        stage = omni.usd.get_context().get_stage()
        if self._scene is None or self._scene.stage != stage:
            self._scene = DuckStage(stage)
        return self._scene

    def _on_stage_event(self, event):
        if event.type in (int(omni.usd.StageEventType.OPENED), int(omni.usd.StageEventType.CLOSED)):
            self._scene = None  # a new stage: the app's next scene message builds there
            self._camera = None

    # --- The viewport camera ------------------------------------------------------------

    def _follow_camera(self, focus):
        if not self._follow or not focus or self._scene is None:
            return
        self._follow_point(focus, self._scene.to_stage)

    def _follow_point(self, focus, to_stage=None):
        """Eases the viewport camera to look at focus (MuJoCo frame; to_stage converts, else as is)."""
        if not self._follow or not focus:
            return
        from pxr import Gf

        to_stage = to_stage or (lambda p: Gf.Vec3d(*p))
        now = time.perf_counter()
        if now - self._camera_at < 1.0 / 30.0:
            return
        self._camera_at = now
        x, y, z = focus[0], focus[1], focus[2]
        target = to_stage((x, y, z))
        eye = to_stage((x + FOLLOW_OFFSET[0], y + FOLLOW_OFFSET[1], z + FOLLOW_OFFSET[2]))
        if self._target is None:
            self._eye, self._target = eye, target
        else:
            self._eye = self._eye + (eye - self._eye) * FOLLOW_EASE
            self._target = self._target + (target - self._target) * FOLLOW_EASE
        try:
            camera = self._camera_state()
            if camera is not None:
                camera.set_position_world(self._eye, True)
                camera.set_target_world(self._target, True)
        except Exception as err:
            carb.log_warn("[ducklab] camera follow off: %s" % err)
            self._follow = False

    def _camera_state(self):
        if self._camera is None:
            from pxr import Gf, Sdf
            from omni.kit.viewport.utility import get_active_viewport
            from omni.kit.viewport.utility.camera_state import ViewportCameraState

            viewport = get_active_viewport()
            if viewport is None:
                return None
            path = str(viewport.camera_path)
            prim = viewport.stage.GetPrimAtPath(path)
            interest = prim.GetProperty("omni:kit:centerOfInterest")
            if not interest or not interest.IsValid():
                prim.CreateAttribute("omni:kit:centerOfInterest", Sdf.ValueTypeNames.Vector3d, True, Sdf.VariabilityUniform).Set(Gf.Vec3d(0, 0, -10))
            self._camera = ViewportCameraState(path, viewport)
        return self._camera

    # --- HTTP -----------------------------------------------------------------------------

    def _status(self):
        scene = self._scene
        last = self._stats["lastPoseAt"]
        return JSONResponse({
            "bridge": VERSION,
            "connected": self._socket is not None or self._channel,
            "transport": "socket" if self._socket is not None else "channel" if self._channel else None,
            "connections": self._stats["connections"],
            "scenes": self._stats["scenes"],
            "statics": scene.statics if scene else 0,
            "terrainFaces": scene.terrain_faces if scene else 0,
            "bodies": len(scene.body_names) if scene else 0,
            "triangles": self._stats["triangles"],
            "poses": self._stats["poses"],
            "lastPoseAgoMs": round((time.time() - last) * 1000) if last else None,
            "follow": self._follow,
            "root": str(scene.root) if scene else None,
            "lastMessageMs": self._stats["lastMessageMs"],
            "kit": getattr(omni.kit.app.get_app(), "get_kit_version", omni.kit.app.get_app().get_build_version)(),
            "stream": self._stream_kind(),
            "streamingLibrary": os.path.isfile(STREAMING_LIBRARY),
            "testcase": self._testcase.state if self._testcase is not None else None,
        })

    # --- Test cases (testcase.py) -------------------------------------------------------------

    # Async, so they run on Kit's own loop (plain handlers run in a worker thread, without one).
    async def _testcase_status(self):
        return JSONResponse(self._testcase.status())

    async def _testcase_start(self, request: Request):
        try:
            body = await request.json()
        except Exception:
            body = {}
        folder = body.get("folder")
        if not folder or not os.path.isdir(folder):
            return JSONResponse({"ok": False, "error": "folder: an exported pack on this computer (replay.mjs --export)"}, status_code=400)
        self._testcase.start(os.path.abspath(folder), body.get("title"), body.get("options") or {})
        return JSONResponse({"ok": True, "state": "building"})

    async def _testcase_again(self):
        return JSONResponse({"ok": self._testcase.again()})

    def _testcase_view(self, ui):
        """The viewport alone in the stream while a test case runs (ui False), Isaac Sim's panels
        back after (None); a connected app decides for itself."""
        if self._socket is not None or self._channel:
            return
        if ui is None:
            self._restore_ui()
        else:
            self._handle({"type": "view", "ui": ui})

    async def _testcase_stop(self):
        self._testcase.stop()
        return JSONResponse({"ok": True})

    @staticmethod
    def _stream_kind():
        """Which browser player this Isaac Sim's WebRTC stream needs."""
        manager = omni.kit.app.get_app().get_extension_manager()
        # Kit 104's player extension runs on omni.kit.livestream.webrtc too: ask for it first.
        if manager.is_extension_enabled("omni.services.streamclient.webrtc"):
            return "kit-player"  # Kit 104: the player Kit serves at /streaming/webrtc-demo/
        if manager.is_extension_enabled("omni.kit.livestream.webrtc"):
            return "library"  # Kit 105+: NVIDIA's streaming library, signalling on port 49100
        return None

    def _streaming_library(self):
        if not os.path.isfile(STREAMING_LIBRARY):
            return JSONResponse({"error": "not fetched: run node tools/isaac/fetch-streaming-library.mjs"}, status_code=404)
        return FileResponse(STREAMING_LIBRARY, media_type="text/javascript", headers={"Cache-Control": "no-cache"})

    def _prims(self, root: str = "/", depth: int = 2):
        """The stage's prims under root (path, type, visibility), for checks."""
        from pxr import Usd, UsdGeom

        stage = omni.usd.get_context().get_stage()
        start = stage.GetPrimAtPath(root)
        if not start.IsValid():
            return JSONResponse({"error": "no prim at %s" % root}, status_code=404)
        found = []
        base = start.GetPath().pathElementCount
        for prim in Usd.PrimRange(start):
            if prim.GetPath().pathElementCount - base > depth:
                continue
            visible = UsdGeom.Imageable(prim).ComputeVisibility() != UsdGeom.Tokens.invisible if prim.IsA(UsdGeom.Imageable) else None
            found.append({"path": str(prim.GetPath()), "type": prim.GetTypeName(), "visible": visible})
            if len(found) >= 400:
                break
        return JSONResponse({"root": root, "prims": found})

    async def _capture(self):
        from omni.kit.viewport.utility import capture_viewport_to_file, get_active_viewport

        path = os.path.join(tempfile.gettempdir(), "ducklab-capture.png")
        if os.path.exists(path):
            os.remove(path)
        capture_viewport_to_file(get_active_viewport(), path)
        size = -1
        for _ in range(100):
            await asyncio.sleep(0.05)
            if os.path.exists(path):
                now = os.path.getsize(path)
                if now > 0 and now == size:
                    return FileResponse(path, media_type="image/png")
                size = now
        return JSONResponse({"error": "the viewport capture did not arrive"}, status_code=504)
