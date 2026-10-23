"""Serial local lifecycle transport; the Broker owns validation and authority."""
from __future__ import annotations

import ctypes
import json
import os
from pathlib import Path
import socket
import stat
import struct
import time
from uuid import UUID

from .core import Broker, BrokerError, json_load

MAX_FRAME_BYTES = 1_048_576
SOCKET_TIMEOUT_SECONDS = 5
_GENERIC_ERROR = "Local broker operation failed; details hidden. Reconcile attempted orders with the original proposal; never retry blindly."


def _require_same_user(connection):
    if hasattr(socket, "SO_PEERCRED"):
        credentials = connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        uid = struct.unpack("3i", credentials)[1]
    else:
        try:
            getpeereid = ctypes.CDLL(None, use_errno=True).getpeereid
        except (AttributeError, OSError):
            raise BrokerError("This platform cannot verify the local broker peer") from None
        getpeereid.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint)]
        getpeereid.restype = ctypes.c_int
        peer_uid, peer_gid = ctypes.c_uint(), ctypes.c_uint()
        if getpeereid(connection.fileno(), ctypes.byref(peer_uid), ctypes.byref(peer_gid)) != 0:
            raise BrokerError("Cannot verify the local broker peer")
        uid = peer_uid.value
    if uid != os.getuid():
        raise BrokerError("Local broker requests must come from the operator's user")


def _read_request(connection):
    data = bytearray()
    deadline = time.monotonic() + SOCKET_TIMEOUT_SECONDS
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise BrokerError("Broker request deadline exceeded")
        connection.settimeout(remaining)
        chunk = connection.recv(min(65_536, MAX_FRAME_BYTES + 2 - len(data)))
        if not chunk:
            raise BrokerError("Expected one newline-terminated broker request")
        data.extend(chunk)
        newline = data.find(b"\n")
        if newline >= 0:
            if newline > MAX_FRAME_BYTES:
                raise BrokerError("Broker request exceeds 1 MiB")
            if newline != len(data) - 1:
                raise BrokerError("Only one broker request is allowed per connection")
            try:
                return json_load(data[:newline].decode("utf-8"))
            except UnicodeDecodeError:
                raise BrokerError("Broker request must be UTF-8 JSON") from None
        if len(data) > MAX_FRAME_BYTES:
            raise BrokerError("Broker request exceeds 1 MiB")


def _dispatch(broker, request):
    if not isinstance(request, dict):
        raise BrokerError("Broker request must be an object")
    operation = request.get("operation")
    if not isinstance(operation, str) or operation not in {"capabilities", "preflight", "submit", "status", "cancel"}:
        raise BrokerError("Unknown broker operation")
    fields = {"operation", "expectedMode"}
    if "expectedGrantId" in request:
        fields.add("expectedGrantId")
    if operation != "capabilities":
        fields.add("proposal")
    if operation == "cancel":
        fields.add("leg")
    if set(request) != fields:
        raise BrokerError("Unexpected or missing broker request fields")
    if not isinstance(request["expectedMode"], str) or request["expectedMode"] not in {"per_order", "policy"}:
        raise BrokerError("Expected an explicit operator execution mode")
    if "expectedGrantId" in request:
        try:
            if request["expectedMode"] != "policy" or type(request["expectedGrantId"]) is not str or str(UUID(request["expectedGrantId"])) != request["expectedGrantId"]:
                raise ValueError
        except ValueError:
            raise BrokerError("Expected a canonical policy grant assertion") from None
    if operation != "capabilities" and not isinstance(request["proposal"], dict):
        raise BrokerError("Expected a canonical execution proposal object")
    if operation == "cancel" and (type(request["leg"]) is not int or request["leg"] not in (0, 1)):
        raise BrokerError("Cancel requires an exact zero-based proposal leg")
    capabilities = broker.capabilities()
    if request["expectedMode"] != capabilities["authority"]["mode"]:
        raise BrokerError("Configured broker mode does not match the expected operator mode")
    if "expectedGrantId" in request and request["expectedGrantId"] != capabilities["authority"].get("grantId"):
        raise BrokerError("Configured broker grant does not match the operator-pinned grant")
    if operation == "capabilities":
        return capabilities
    if operation == "preflight":
        return broker.preflight(request["proposal"])
    if operation == "submit":
        return broker.submit(request["proposal"])
    if operation == "status":
        return broker.status(request["proposal"])
    return broker.cancel(request["proposal"], request["leg"])


def _encode_response(response):
    encoded = json.dumps(response, ensure_ascii=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(encoded) > MAX_FRAME_BYTES:
        raise BrokerError("Broker response exceeds 1 MiB; reconcile with the original proposal")
    return encoded + b"\n"


def _handle_connection(connection, broker):
    connection.settimeout(SOCKET_TIMEOUT_SECONDS)
    try:
        _require_same_user(connection)
        request = _read_request(connection)
        response = _encode_response({"ok": True, "result": _dispatch(broker, request)})
    except BrokerError as error:
        response = _encode_response({"ok": False, "error": {"code": "broker_blocked", "message": str(error)[:2000]}})
    except Exception:
        response = _encode_response({"ok": False, "error": {"code": "broker_error", "message": _GENERIC_ERROR}})
    try:
        connection.sendall(response)
    except OSError:
        # A lost response does not undo an order and must not drive another attempt.
        pass


def serve_local(socket_path: Path, broker: Broker) -> None:
    """Serve one bounded JSON request per connection until operator interruption.

    The operator fixes the Broker, mode, authority and path before this call.
    Same-user permissions do not isolate credentials from hostile same-user code.
    Existing paths, including stale sockets, require explicit operator cleanup.
    """
    socket_path = Path(socket_path)
    if not socket_path.is_absolute():
        raise BrokerError("Broker socket path must be absolute operator configuration")
    try:
        parent = socket_path.parent.lstat()
    except OSError:
        raise BrokerError("Broker socket parent must already exist with mode 0700") from None
    if not stat.S_ISDIR(parent.st_mode) or parent.st_uid != os.getuid() or stat.S_IMODE(parent.st_mode) != 0o700:
        raise BrokerError("Broker socket parent must be operator-owned mode 0700, not a symlink")
    try:
        socket_path.lstat()
    except FileNotFoundError:
        pass
    else:
        raise BrokerError("Broker socket path already exists; inspect and remove it explicitly")

    owned = None
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
        try:
            listener.bind(str(socket_path))
            owned = socket_path.lstat()
            os.chmod(socket_path, 0o600)
            listener.listen(8)
            while True:
                connection, _ = listener.accept()
                with connection:
                    _handle_connection(connection, broker)
        finally:
            if owned is not None:
                try:
                    current = socket_path.lstat()
                    if (current.st_dev, current.st_ino) == (owned.st_dev, owned.st_ino) and stat.S_ISSOCK(current.st_mode):
                        socket_path.unlink()
                except FileNotFoundError:
                    pass
