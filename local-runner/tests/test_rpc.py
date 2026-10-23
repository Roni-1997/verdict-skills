"""Real local socket tests using public fake broker state, without venue SDKs."""
from contextlib import redirect_stderr, redirect_stdout
import io
import json
import os
from pathlib import Path
import socket
import stat
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from verdict_broker.core import BrokerError
from verdict_broker import rpc
from verdict_broker import __main__ as operator_cli


class FakeBroker:
    def __init__(self, root, mode="per_order"):
        self.root, self.mode = root, mode
        self.calls = []
        self.stop = False
        self.grant_id = "11111111-1111-4111-8111-111111111111"

    def capabilities(self):
        if self.stop:
            raise KeyboardInterrupt
        authority = {"mode": "per_order", "approval": "operator_terminal"}
        if self.mode == "policy":
            authority = {"mode": "policy", "grantId": self.grant_id, "grantHash": "a" * 64,
                         "expiresAt": 9999999999999, "newRisk": "active", "remainingDebitUSDC": "10",
                         "remainingOrders": 2, "cancelOwnOrders": True}
        return {"kind": "local_execution_capabilities", "authority": authority, "fundedAcceptanceVerified": False}

    def _status(self, proposal):
        attempted = (self.root / proposal["digest"]).exists()
        return {"digest": proposal["digest"], "state": "needs_reconciliation",
                "legs": [{"leg": 0, "state": "unknown" if attempted else "not_attempted", "filled": None if attempted else "0",
                          "netInventoryChange": None if attempted else "0", "settled": False}],
                "automaticRetry": False, "note": "Public fake lifecycle."}

    def preflight(self, proposal):
        self.calls.append("preflight")
        return {"state": "ready", "digest": proposal["digest"], "authorization": "none", "authority": self.capabilities()["authority"],
                "legs": [{"leg": 0, "inventoryShares": "0", "availableUSDC": "10", "feeBoundUSDC": "0.01",
                          "checkedAt": 1, "validUntil": 2}]}

    def submit(self, proposal):
        self.calls.append("submit")
        fence = self.root / proposal["digest"]
        if not fence.exists():
            with fence.open("x") as stream:
                stream.write("durable public attempt\n")
                stream.flush()
                os.fsync(stream.fileno())
            with (self.root / "send-count").open("a") as stream:
                stream.write("send\n")
        return self._status(proposal)

    def status(self, proposal):
        self.calls.append("status")
        return self._status(proposal)

    def cancel(self, proposal, leg):
        self.calls.append(("cancel", leg))
        return self._status(proposal)


class RunningService:
    def __init__(self, root, broker):
        self.path, self.broker = root / "broker.sock", broker
        self.errors = []
        def run():
            try:
                rpc.serve_local(self.path, broker)
            except KeyboardInterrupt:
                pass
            except Exception as error:
                self.errors.append(error)
        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()
        deadline = time.monotonic() + 2
        ready = False
        while self.thread.is_alive() and time.monotonic() < deadline:
            try:
                self.call({"operation": "capabilities", "expectedMode": self.broker.mode})
                ready = True
                break
            except (FileNotFoundError, ConnectionRefusedError):
                pass
            time.sleep(0.005)
        if not ready:
            raise AssertionError(f"Service failed to start: {self.errors}")

    def call(self, request, *, half_close=False):
        raw = request if isinstance(request, bytes) else (json.dumps(request) + "\n").encode()
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(3)
            connection.connect(str(self.path))
            try:
                connection.sendall(raw)
                if half_close:
                    connection.shutdown(socket.SHUT_WR)
            except BrokenPipeError:
                pass
            response = bytearray()
            while not response.endswith(b"\n"):
                chunk = connection.recv(65_536)
                if not chunk:
                    break
                response.extend(chunk)
            return json.loads(response) if response else None

    def close(self):
        if self.thread.is_alive():
            self.broker.stop = True
            self.call({"operation": "capabilities", "expectedMode": self.broker.mode})
            self.thread.join(3)
        if self.thread.is_alive() or self.errors:
            raise AssertionError(f"Service did not stop cleanly: {self.errors}")


class RpcTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="verdict-rpc-", dir="/tmp")
        self.root = Path(self.temporary.name)
        self.broker = FakeBroker(self.root)
        self.service = RunningService(self.root, self.broker)
        self.proposal = {"digest": "a" * 64}

    def tearDown(self):
        self.service.close()
        self.temporary.cleanup()

    def request(self, operation, **fields):
        return {"operation": operation, "expectedMode": "per_order", **fields}

    def test_real_socket_lifecycle_uses_fixed_broker(self):
        cap = self.service.call(self.request("capabilities"))
        self.assertTrue(cap["ok"])
        self.assertEqual(cap["result"]["authority"]["mode"], "per_order")
        ready = self.service.call(self.request("preflight", proposal=self.proposal))
        self.assertEqual(ready["result"]["state"], "ready")
        sent = self.service.call(self.request("submit", proposal=self.proposal))
        self.assertEqual(sent["result"]["legs"][0]["state"], "unknown")
        self.assertEqual(self.service.call(self.request("status", proposal=self.proposal))["result"], sent["result"])
        self.assertTrue(self.service.call(self.request("cancel", proposal=self.proposal, leg=0))["ok"])
        self.assertEqual(self.broker.calls, ["preflight", "submit", "status", ("cancel", 0)])

    def test_socket_and_parent_permissions(self):
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.service.path.stat().st_mode), 0o600)

    def test_exact_mode_assertion_for_every_operation(self):
        for operation in ["capabilities", "preflight", "submit", "status", "cancel"]:
            fields = {"proposal": self.proposal} if operation != "capabilities" else {}
            if operation == "cancel":
                fields["leg"] = 0
            response = self.service.call({"operation": operation, "expectedMode": "policy", **fields})
            self.assertFalse(response["ok"])
            self.assertIn("mode", response["error"]["message"])
        self.assertEqual(self.broker.calls, [])

    def test_pinned_grant_is_asserted_on_the_selected_broker_for_every_operation(self):
        self.broker.mode = "policy"
        for operation in ["capabilities", "preflight", "submit", "status", "cancel"]:
            fields = {"proposal": self.proposal} if operation != "capabilities" else {}
            if operation == "cancel":
                fields["leg"] = 0
            calls = list(self.broker.calls)
            rejected = self.service.call({"operation": operation, "expectedMode": "policy", "expectedGrantId": "22222222-2222-4222-8222-222222222222", **fields})
            self.assertFalse(rejected["ok"])
            self.assertIn("grant", rejected["error"]["message"])
            self.assertEqual(self.broker.calls, calls)
            matching = self.service.call({"operation": operation, "expectedMode": "policy", "expectedGrantId": self.broker.grant_id, **fields})
            self.assertTrue(matching["ok"], matching)

    def test_replacing_policy_grant_after_capabilities_does_not_spend_new_budget(self):
        self.broker.mode = "policy"
        old = self.broker.grant_id
        self.assertTrue(self.service.call({"operation": "capabilities", "expectedMode": "policy", "expectedGrantId": old})["ok"])
        self.broker.grant_id = "22222222-2222-4222-8222-222222222222"
        result = self.service.call({"operation": "submit", "expectedMode": "policy", "expectedGrantId": old, "proposal": self.proposal})
        self.assertFalse(result["ok"])
        self.assertFalse((self.root / "send-count").exists())
        self.assertEqual(self.broker.calls, [])

    def test_unknown_missing_and_agent_authority_fields_rejected(self):
        requests = [{"operation": "capabilities"}, self.request("grant-create"), self.request("capabilities", proposal={}),
                    self.request("submit"), self.request("submit", proposal=[], approved=True),
                    self.request("cancel", proposal=self.proposal, leg=True),
                    self.request("cancel", proposal=self.proposal, leg=2),
                    self.request("capabilities", expectedGrantId="11111111-1111-4111-8111-111111111111"),
                    {"operation": "capabilities", "expectedMode": "policy", "expectedGrantId": "secret-invalid"},
                    {"operation": "capabilities", "expectedMode": "policy", "expectedGrantId": True},
                    {"operation": [], "expectedMode": "per_order"}, {"operation": "capabilities", "expectedMode": []}]
        for field in ["approved", "authority", "grantId", "socketPath", "stateDir", "factory", "privateKey", "mode"]:
            requests.append(self.request("submit", proposal=self.proposal, **{field: "forged"}))
        for request in requests:
            with self.subTest(request=request):
                response = self.service.call(request)
                self.assertFalse(response["ok"])
                self.assertEqual(response["error"]["code"], "broker_blocked")
        self.assertEqual(self.broker.calls, [])

    def test_duplicate_nonfinite_invalid_utf8_and_multiple_frames_rejected(self):
        for raw in [b'{"operation":"capabilities","operation":"submit","expectedMode":"per_order"}\n',
                    b'{"operation":"submit","expectedMode":"per_order","proposal":{"n":NaN}}\n',
                    b'\xff\n', b'[]\n', b'{}\n{}\n']:
            with self.subTest(raw=raw):
                response = self.service.call(raw)
                self.assertFalse(response["ok"])
                self.assertEqual(response["error"]["code"], "broker_blocked")
        self.assertEqual(self.broker.calls, [])

    def test_incomplete_frame_and_oversized_request_rejected(self):
        self.assertFalse(self.service.call(b'{"operation":', half_close=True)["ok"])
        raw = b'{' + b' ' * rpc.MAX_FRAME_BYTES + b'}\n'
        self.assertFalse(self.service.call(raw)["ok"])
        self.assertEqual(self.broker.calls, [])

    def test_read_timeout_is_bounded(self):
        with patch.object(rpc, "SOCKET_TIMEOUT_SECONDS", 0.03):
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(1)
                connection.connect(str(self.service.path))
                response = json.loads(connection.recv(10_000))
                self.assertFalse(response["ok"])

    def test_slow_progress_does_not_extend_request_deadline(self):
        connection = Mock()
        connection.recv.side_effect = [b'{', b'"']
        with patch.object(rpc, "SOCKET_TIMEOUT_SECONDS", 0.05), patch.object(rpc.time, "monotonic", side_effect=[0, 0.01, 0.03, 0.06]):
            with self.assertRaisesRegex(BrokerError, "deadline"):
                rpc._read_request(connection)
        self.assertEqual(connection.recv.call_count, 2)

    def test_sdk_exceptions_and_invalid_results_are_sanitized(self):
        with patch.object(self.broker, "submit", side_effect=RuntimeError("credential-signed-secret")):
            response = self.service.call(self.request("submit", proposal=self.proposal))
            self.assertEqual(response["error"]["code"], "broker_error")
            self.assertNotIn("credential-signed-secret", json.dumps(response))
        with patch.object(self.broker, "status", return_value={"unsafe": float("nan")}):
            response = self.service.call(self.request("status", proposal=self.proposal))
            self.assertEqual(response["error"]["code"], "broker_error")
        with patch.object(self.broker, "preflight", side_effect=BrokerError("Fresh fees exceed reserve")):
            self.assertEqual(self.service.call(self.request("preflight", proposal=self.proposal))["error"]["message"], "Fresh fees exceed reserve")

    def test_peer_must_be_same_operator_user(self):
        with patch.object(rpc, "_require_same_user", side_effect=BrokerError("Wrong operator user")):
            # Peer rejection precedes request reading. Do not race a write
            # against the server deliberately closing an unauthorized peer.
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                connection.settimeout(1)
                connection.connect(str(self.service.path))
                response = json.loads(connection.recv(10_000))
        self.assertFalse(response["ok"])
        self.assertEqual(self.broker.calls, [])

    def test_disconnect_and_daemon_restart_do_not_resend(self):
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.connect(str(self.service.path))
            connection.sendall((json.dumps(self.request("submit", proposal=self.proposal)) + "\n").encode())
        deadline = time.monotonic() + 1
        while not (self.root / "send-count").exists() and time.monotonic() < deadline:
            time.sleep(0.005)
        self.service.close()
        self.broker = FakeBroker(self.root)
        self.service = RunningService(self.root, self.broker)
        result = self.service.call(self.request("submit", proposal=self.proposal))
        self.assertEqual(result["result"]["legs"][0]["state"], "unknown")
        self.assertEqual((self.root / "send-count").read_text().splitlines(), ["send"])

    def test_service_is_serial(self):
        entered, release = threading.Event(), threading.Event()
        original = self.broker.submit
        def slow(proposal):
            entered.set()
            release.wait(1)
            return original(proposal)
        responses = []
        with patch.object(self.broker, "submit", side_effect=slow):
            first = threading.Thread(target=lambda: responses.append(self.service.call(self.request("submit", proposal=self.proposal))))
            first.start()
            self.assertTrue(entered.wait(1))
            second = threading.Thread(target=lambda: responses.append(self.service.call(self.request("status", proposal=self.proposal))))
            second.start()
            time.sleep(0.02)
            self.assertNotIn("status", self.broker.calls)
            release.set()
            first.join(2)
            second.join(2)
        self.assertEqual(len(responses), 2)
        self.assertEqual(self.broker.calls, ["submit", "status"])

    def test_shutdown_never_unlinks_replacement_path(self):
        original = self.service.path
        moved = self.root / "moved.sock"
        original.rename(moved)
        original.write_text("operator replacement")
        self.service.path = moved
        self.service.close()
        self.assertEqual(original.read_text(), "operator replacement")
        self.assertTrue(moved.exists())


class StartupTest(unittest.TestCase):
    def test_refuses_existing_file_symlink_and_stale_socket(self):
        with tempfile.TemporaryDirectory(prefix="verdict-rpc-", dir="/tmp") as directory:
            root = Path(directory)
            path = root / "broker.sock"
            path.write_text("preserve")
            for kind in ["file", "symlink", "socket"]:
                if kind == "symlink":
                    path.unlink()
                    path.symlink_to(root / "missing")
                elif kind == "socket":
                    path.unlink()
                    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as stale:
                        stale.bind(str(path))
                with self.subTest(kind=kind), self.assertRaises(BrokerError):
                    rpc.serve_local(path, FakeBroker(root))
                self.assertTrue(path.exists() or path.is_symlink())

    def test_refuses_insecure_or_symlink_parent_and_relative_path(self):
        with tempfile.TemporaryDirectory(prefix="verdict-rpc-", dir="/tmp") as directory:
            root = Path(directory)
            os.chmod(root, 0o755)
            with self.assertRaises(BrokerError):
                rpc.serve_local(root / "broker.sock", FakeBroker(root))
            os.chmod(root, 0o700)
            alias = root / "alias"
            alias.symlink_to(root)
            with self.assertRaises(BrokerError):
                rpc.serve_local(alias / "broker.sock", FakeBroker(root))
            with self.assertRaises(BrokerError):
                rpc.serve_local(Path("relative.sock"), FakeBroker(root))

    def test_operator_cli_rejects_implicit_or_agent_selected_authority(self):
        from verdict_broker.__main__ import main
        for argv in [["serve"], ["serve", "--mode", "policy", "--socket", "/tmp/unused"],
                     ["serve", "--mode", "per_order", "--grant-id", "forged", "--socket", "/tmp/unused"],
                     ["submit", "--mode", "policy"], ["grant-create"], ["grant-revoke"]]:
            with self.subTest(argv=argv), redirect_stderr(io.StringIO()), redirect_stdout(io.StringIO()):
                self.assertEqual(main(argv), 1)


class OperatorCliTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="verdict-cli-", dir="/tmp")
        self.root = Path(self.temporary.name)
        self.authority = SimpleNamespace(HumanAuthority=unittest.mock.Mock(), PolicyAuthority=unittest.mock.Mock(),
                                         issue_grant=unittest.mock.Mock(return_value={"id": "issued"}),
                                         inspect_grant=unittest.mock.Mock(return_value={"id": "issued"}),
                                         revoke_grant=unittest.mock.Mock(return_value={"revoked": True}))
        self.adapters = SimpleNamespace(create_adapter=unittest.mock.Mock())
        self.modules = patch.dict("sys.modules", {"verdict_broker.authority": self.authority, "verdict_broker.adapters": self.adapters})
        self.modules.start()

    def tearDown(self):
        self.modules.stop()
        self.temporary.cleanup()

    def invoke(self, argv):
        with redirect_stderr(io.StringIO()), redirect_stdout(io.StringIO()):
            return operator_cli.main([*argv, "--state-dir", str(self.root / "state")])

    def test_policy_serve_uses_only_operator_selected_named_grant(self):
        cli = operator_cli
        with patch.object(cli, "Broker") as broker, patch.object(rpc, "serve_local") as serve:
            self.assertEqual(self.invoke(["serve", "--mode", "policy", "--grant-id", "issued", "--socket", str(self.root / "broker.sock")]), 0)
        self.assertEqual(self.authority.PolicyAuthority.call_args.args[1], "issued")
        self.authority.HumanAuthority.assert_not_called()
        self.assertIs(broker.call_args.kwargs["authority"], self.authority.PolicyAuthority.return_value)
        serve.assert_called_once_with(self.root / "broker.sock", broker.return_value)

    def test_per_order_serve_requires_terminal_and_keeps_confirmation_local(self):
        cli = operator_cli
        with patch.object(cli, "Broker") as broker, patch.object(rpc, "serve_local") as serve:
            with patch("sys.stdin.isatty", return_value=False):
                self.assertEqual(self.invoke(["serve", "--mode", "per_order", "--socket", str(self.root / "broker.sock")]), 1)
                broker.assert_not_called()
            with patch("sys.stdin.isatty", return_value=True):
                self.assertEqual(self.invoke(["serve", "--mode", "per_order", "--socket", str(self.root / "broker.sock")]), 0)
        self.authority.HumanAuthority.assert_called_once_with(cli.confirmation)
        self.authority.PolicyAuthority.assert_not_called()
        serve.assert_called_once()

    def test_one_shot_submit_and_cancel_always_construct_human_authority(self):
        cli = operator_cli
        proposal = {"digest": "a" * 64}
        with patch.object(cli, "load_proposal", return_value=proposal), patch.object(cli, "Broker") as broker:
            broker.return_value.submit.return_value = {"state": "needs_reconciliation"}
            broker.return_value.cancel.return_value = {"state": "needs_reconciliation"}
            self.assertEqual(self.invoke(["submit", "--proposal", "operator.json"]), 0)
            broker.return_value.submit.assert_called_once_with(proposal)
            self.assertEqual(self.invoke(["cancel", "--proposal", "operator.json", "--leg", "1"]), 0)
            broker.return_value.cancel.assert_called_once_with(proposal, 1)
        self.assertEqual(self.authority.HumanAuthority.call_count, 2)
        self.authority.PolicyAuthority.assert_not_called()

    def test_grant_creation_passes_reviewed_templates_and_exact_operator_limits(self):
        cli = operator_cli
        templates = [{"digest": "a" * 64}, {"digest": "b" * 64}]
        with patch.object(cli, "load_proposal", side_effect=templates):
            self.assertEqual(self.invoke(["grant-create", "--template", "a.json", "--template", "b.json",
                                          "--max-debit-usdc", "12.5", "--max-orders", "4", "--expires-at", "9999999999999", "--cancel-own-orders"]), 0)
        call = self.authority.issue_grant.call_args
        self.assertEqual(call.args[1], templates)
        self.assertEqual(call.kwargs, {"max_debit_usdc": "12.5", "max_orders": 4, "expires_at_ms": 9999999999999,
                                      "cancel_own_orders": True, "confirm": cli.confirmation})

    def test_grant_confirmation_cannot_be_answered_from_noninteractive_input(self):
        cli = operator_cli
        def require_confirmation(*args, **kwargs):
            kwargs["confirm"]({"digest": "reviewed-grant", "confirmation": ["Approve reviewed grant limits"]})
        self.authority.issue_grant.side_effect = require_confirmation
        with patch.object(cli, "load_proposal", return_value={"digest": "a" * 64}), patch("sys.stdin.isatty", return_value=False):
            self.assertEqual(self.invoke(["grant-create", "--template", "a.json", "--max-debit-usdc", "1", "--max-orders", "1", "--expires-at", "9999999999999"]), 1)

    def test_grant_inspection_and_revocation_are_operator_commands(self):
        self.assertEqual(self.invoke(["grant-inspect", "--grant-id", "issued"]), 0)
        self.assertEqual(self.invoke(["grant-revoke", "--grant-id", "issued"]), 0)
        self.assertEqual(self.authority.inspect_grant.call_args.args[1], "issued")
        self.assertEqual(self.authority.revoke_grant.call_args.args[1], "issued")


if __name__ == "__main__":
    unittest.main()
