"""Real isolated native startup under a hosting entrypoint that must not be rerun."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from verdict_broker.workers import start_private_worker, stop_private_worker


class PrivateWorkerTest(unittest.TestCase):
    def test_native_startup_does_not_reexecute_hosting_main(self):
        source = '''
import json
if __name__ == "__mp_main__":
    raise RuntimeError("Hosting bootstrap must never be reexecuted")
from verdict_broker.provisioner import native_call
if __name__ == "__main__":
    result = native_call("generate", {})
    print(json.dumps({"generated": bool(result.get("privateKey") and result.get("publicKey"))}))
'''
        with tempfile.TemporaryDirectory() as directory:
            entry = Path(directory) / "hosting_entry.py"
            entry.write_text(source)
            environment = {**os.environ, "PYTHONPATH": os.pathsep.join(path for path in sys.path if path)}
            result = subprocess.run([sys.executable, str(entry)], env=environment, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"generated": True})

    def test_unknown_worker_never_dispatches(self):
        pipe, process = start_private_worker({"kind": "not-a-worker", "secret": "synthetic-secret"})
        try:
            self.assertTrue(pipe.poll(5))
            with self.assertRaises(EOFError):
                pipe.recv()
        finally:
            pipe.close()
            stop_private_worker(process)


if __name__ == "__main__":
    unittest.main()
