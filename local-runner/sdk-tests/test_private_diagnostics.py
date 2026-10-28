"""Failure observability exposes code locations only, including at HTTP/native boundaries."""
import json
import unittest
from unittest.mock import Mock, patch

from verdict_broker.diagnostics import log_failure_location
from verdict_broker.provisioner import _native_process
import test_private_signer as signer_fixture
from verdict_broker.core import BrokerError

SECRET = "synthetic-private-key signature-token user-wallet database-password"


class PrivateDiagnosticsTest(unittest.TestCase):
    def test_exception_message_and_external_path_are_not_logged(self):
        try:
            exec(compile("raise ValueError(secret)", "/" + SECRET + "/external.py", "exec"), {"secret": SECRET})
        except ValueError as error:
            with self.assertLogs("verdict_broker.diagnostics", level="WARNING") as captured:
                log_failure_location(error)
        self.assertEqual(captured.output, ["WARNING:verdict_broker.diagnostics:Private operation failed at dependency:1"])

    def test_native_failure_keeps_payload_generic_and_logs_only_location(self):
        pipe = Mock()
        with patch("lighter.create_api_key", side_effect=RuntimeError(SECRET)):
            with self.assertLogs("verdict_broker.diagnostics", level="WARNING") as captured:
                _native_process(pipe, "generate", {})
        pipe.send.assert_called_once_with({"error": "Private native operation unavailable"})
        self.assertNotIn(SECRET, "".join(captured.output))
        pipe.close.assert_called_once()

    def test_http_blocked_failure_keeps_response_generic_and_logs_only_location(self):
        fixture = signer_fixture.PrivateSignerHTTPTest()
        fixture.setUp()
        fixture.runtime.operation.side_effect = BrokerError(SECRET)
        with self.assertLogs("verdict_broker.diagnostics", level="WARNING") as captured:
            status, result = fixture.call({"operation": "status", "subject": SECRET})
        self.assertEqual(status, 409)
        self.assertNotIn(SECRET, json.dumps(result) + "".join(captured.output))
        fixture.runtime.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
