"""Fixed private worker entrypoint; never reexecutes a hosting server's __main__."""
import multiprocessing
import os
from pathlib import Path
import subprocess
import sys


def start_private_worker(request):
    parent, child = multiprocessing.Pipe(duplex=True)
    environment = {key: os.environ[key] for key in ("PATH", "LANG", "LC_ALL", "VERDICT_NODE_BINARY") if key in os.environ}
    # Vercel adds its reviewed dependency directories to sys.path at bootstrap.
    environment["PYTHONPATH"] = os.pathsep.join(path for path in sys.path if path)
    environment["PYTHONNOUSERSITE"] = "1"
    process = None
    try:
        process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), str(child.fileno())],
                                   pass_fds=(child.fileno(),), stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, env=environment)
        child.close()
        parent.send(request)
        return parent, process
    except BaseException:
        parent.close()
        child.close()
        if process is not None:
            stop_private_worker(process)
        raise


def stop_private_worker(process):
    try:
        process.wait(timeout=1)
    except subprocess.TimeoutExpired:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)


def _main():
    from multiprocessing.connection import Connection
    from verdict_broker.diagnostics import log_failure_location
    pipe = Connection(int(sys.argv[1]))
    try:
        request = pipe.recv()
        if not isinstance(request, dict):
            raise ValueError("Invalid private worker frame")
        if request.get("kind") == "native" and set(request) == {"kind", "operation", "data", "transport_check"}:
            if request["operation"] not in {"generate", "registration", "check", "send"} or type(request["transport_check"]) is not bool:
                raise ValueError("Invalid native worker operation")
            from verdict_broker.provisioner import _native_child
            _native_child(pipe, request["operation"], request["data"], request["transport_check"])
        elif request.get("kind") == "broker" and set(request) == {"kind", "config", "record", "request"}:
            from verdict_broker.signer_http import _broker_child
            _broker_child(pipe, request["config"], request["record"], request["request"])
        else:
            raise ValueError("Unknown private worker")
    except Exception as error:
        log_failure_location(error)
    finally:
        pipe.close()


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    _main()
