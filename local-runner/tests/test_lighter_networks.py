"""Explicit Lighter domains with inert SDK ports; no credentials or venue requests."""
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from verdict_broker.adapters import Lighter
from verdict_broker.core import BrokerError
from verdict_broker.public import public_market


class LighterNetworkTest(unittest.TestCase):
    def test_all_networks_use_exact_host_and_explicit_chain(self):
        calls = []

        class Signer:
            def __init__(self, **kwargs):
                calls.append(kwargs)
                self.api_client = object()

            async def close(self):
                pass

        sdk = SimpleNamespace(SignerClient=Signer, OrderApi=lambda _: object())
        for network, host, chain in [
            ("devnet", "https://devnet.zklighter.elliot.ai", 300),
            ("testnet", "https://testnet.zklighter.elliot.ai", 300),
            ("mainnet", "https://mainnet.zklighter.elliot.ai", 304),
        ]:
            with self.subTest(network=network), patch.dict("sys.modules", {"lighter": sdk}), patch("verdict_broker.adapters.secret", return_value="inert-sdk-port"):
                adapter = Lighter({"network": network, "account": 42, "apiKeyIndex": 5})
                try:
                    self.assertEqual(adapter.host, host)
                    self.assertEqual(calls[-1]["url"], host)
                    self.assertEqual(calls[-1]["chain_id"], chain)
                finally:
                    adapter.close()

    def test_unknown_network_fails_before_loading_credentials_or_sdk(self):
        sdk = Mock()
        for network in ["unknown", "polygon", "", None]:
            with self.subTest(network=network), patch.dict("sys.modules", {"lighter": sdk}), patch("verdict_broker.adapters.secret") as secret:
                with self.assertRaisesRegex(BrokerError, "Lighter network"):
                    Lighter({"network": network, "account": 42, "apiKeyIndex": 5})
                secret.assert_not_called()
                sdk.SignerClient.assert_not_called()

    def test_public_bridge_preserves_testnet_and_rejects_unknown_before_call(self):
        with patch("verdict_broker.public.node_call", side_effect=[{"network": "testnet"}, {"network": "testnet"}]) as bridge:
            result = public_market("lighter", "testnet", "123")
            self.assertEqual(result["network"], "testnet")
            self.assertEqual(result["market"]["network"], "testnet")
            self.assertEqual([call.args for call in bridge.call_args_list], [
                (["lighter", "market", "123"], {"LIGHTER_NETWORK": "testnet"}),
                (["lighter", "book", "123"], {"LIGHTER_NETWORK": "testnet"}),
            ])
        with patch("verdict_broker.public.node_call") as bridge:
            with self.assertRaisesRegex(BrokerError, "Lighter network"):
                public_market("lighter", "unknown", "123")
            bridge.assert_not_called()


if __name__ == "__main__":
    unittest.main()
