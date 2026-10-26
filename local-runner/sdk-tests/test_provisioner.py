"""Synthetic owners, inert venue ports and native signing with transport forbidden."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from eth_account import Account
from eth_account.messages import encode_defunct

from verdict_broker.authority import PolicyAuthority, recover_owner
from verdict_broker.core import BrokerError, Store
from verdict_broker.provisioner import Provisioner, _native_process, funding_message

# Public synthetic fixture only; it is never funded or sent to a venue.
WALLET = Account.from_key("11" * 32)
OTHER = Account.from_key("22" * 32)
OWNER = WALLET.address.lower()
PUBLIC = "0x" + "1" * 80


def sign(message, wallet=WALLET):
    return "0x" + wallet.sign_message(encode_defunct(text=message)).signature.hex().removeprefix("0x")


class Venue:
    def __init__(self):
        self.index = 42
        self.owner = OWNER
        self.slots = {4: "0x" + "2" * 80}
        self.sends = 0
        self.faucets = 0
        self.accept = True
        self.lost = False

    def account(self, owner):
        if owner != self.owner:
            raise BrokerError("wrong owner")
        return self.index

    def verify_owner(self, index, owner):
        if index != self.index or owner != self.owner:
            raise BrokerError("wrong owner")

    def keys(self, index):
        return self.slots.copy()

    def nonce(self, index, slot):
        return 7

    def generate(self):
        return {"privateKey": "synthetic-private-api-key", "publicKey": PUBLIC}

    def registration(self, record):
        message = ("Register Lighter Account\n\npubkey: " + record["publicKey"] + "\nnonce: 0x0000000000000007\naccount index: 0x000000000000002a"
                   + "\napi key index: 0x" + format(record["apiKeyIndex"], "016x") + "\nOnly sign this message for a trusted client!")
        return {"txType": 8, "txInfo": json.dumps({"AccountIndex": 42}), "txHash": "synthetic-hash", "message": message}

    def send(self, record, signature):
        self.sends += 1
        if self.accept:
            self.slots[record["apiKeyIndex"]] = record["publicKey"]
        if self.lost:
            raise OSError("lost response")
        return {"accepted": True}

    def ready(self, record):
        return self.slots.get(record["apiKeyIndex"]) == record["publicKey"]

    def faucet(self, owner):
        self.faucets += 1
        self.index = 42


class ProvisionerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.key = self.root / "wrap"
        self.key.write_bytes(os.urandom(32))
        self.key.chmod(0o600)
        self.now = 1_800_000_000
        self.config = {"origin": "https://mcp.staging.example", "stateDir": str(self.root / "state"), "socketDir": str(self.root / "sockets"),
                       "wrappingKeyFile": str(self.key), "mode": "per_order", "creators": [7], "maxOrderDebitUSDC": "10",
                       "maxDebitUSDC": "25", "maxOrders": 3, "grantTtlSeconds": 3600}
        self.venue, self.workers = Venue(), Mock()
        self.service = Provisioner(self.config, venue=self.venue, workers=self.workers, clock=lambda: self.now)

    def tearDown(self):
        self.service.close()
        self.temp.cleanup()

    def call(self, operation, **fields):
        return self.service.dispatch({"operation": operation, "subject": "did:privy:synthetic", **fields})

    def prepare(self):
        return self.call("prepare", walletAddress=OWNER)

    def ready(self):
        view = self.prepare()
        result = self.call("register", enrollmentId=view["enrollmentId"], revision=view["revision"], signature=sign(view["message"]))
        self.assertEqual(result["state"], "ready")
        return result

    def activate(self):
        ready = self.ready()
        plan = self.call("preview", enrollmentId=ready["enrollmentId"])
        request = {"enrollmentId": ready["enrollmentId"], "planId": plan["planId"], "revision": plan["revision"], "signature": sign(plan["message"])}
        return plan, request, self.call("activate", **request)["binding"]

    def test_one_key_slot_and_public_only_view(self):
        view = self.prepare()
        self.assertEqual(view["apiKeyIndex"], 5)
        self.assertEqual((view["network"], view["chainId"], view["nonce"]), ("testnet", 300, 7))
        self.assertEqual(view, self.prepare())
        for secret in ("privateKey", "synthetic-private", "txInfo", "txHash"):
            self.assertNotIn(secret, json.dumps(view))
        self.assertEqual(self.venue.slots[4], "0x" + "2" * 80)
        self.assertEqual(self.venue.sends, 0)

    def test_wrong_owner_revision_and_foreign_slot_never_send(self):
        view = self.prepare()
        request = {"enrollmentId": view["enrollmentId"], "revision": view["revision"], "signature": sign(view["message"])}
        for change in ({"revision": "f" * 64}, {"signature": sign(view["message"], OTHER)}):
            with self.assertRaises(BrokerError):
                self.call("register", **{**request, **change})
        self.venue.slots[5] = "0x" + "3" * 80
        with self.assertRaises(BrokerError):
            self.call("register", **request)
        self.assertEqual(self.venue.sends, 0)

    def test_unknown_send_restarts_only_reconcile_and_never_resend(self):
        view = self.prepare()
        self.venue.lost = True
        request = {"enrollmentId": view["enrollmentId"], "revision": view["revision"], "signature": sign(view["message"])}
        self.assertEqual(self.call("register", **request)["state"], "registering")
        self.service.close()
        self.service = Provisioner(self.config, venue=self.venue, workers=self.workers, clock=lambda: self.now)
        self.assertEqual(self.call("status", enrollmentId=view["enrollmentId"])["state"], "ready")
        self.assertEqual(self.call("register", **request)["state"], "ready")
        self.assertEqual(self.venue.sends, 1)
        with self.assertRaises(BrokerError):
            self.call("register", **{**request, "signature": sign(view["message"], OTHER)})

    def test_unaccepted_claim_stays_uncertain_across_retries(self):
        view = self.prepare()
        self.venue.accept, self.venue.lost = False, True
        request = {"enrollmentId": view["enrollmentId"], "revision": view["revision"], "signature": sign(view["message"])}
        self.call("register", **request)
        for _ in range(3):
            self.assertEqual(self.call("register", **request)["state"], "registering")
        self.assertEqual(self.venue.sends, 1)

    def test_faucet_is_explicit_exact_owner_proof_and_claimed_once(self):
        self.venue.index = None
        view = self.prepare()
        self.assertEqual(view["state"], "funding_required")
        self.assertEqual(self.venue.faucets, 0)
        request = {"enrollmentId": view["enrollmentId"], "revision": view["revision"], "signature": sign(view["message"])}
        with self.assertRaises(BrokerError):
            self.call("faucet", **{**request, "signature": sign(view["message"], OTHER)})
        self.assertEqual(self.call("faucet", **request)["state"], "signature_required")
        with self.assertRaises(BrokerError):
            self.call("faucet", **request)
        self.assertEqual(self.venue.faucets, 1)
        self.assertEqual(view["message"], funding_message({"id": view["enrollmentId"], "owner": OWNER, "revision": view["revision"], "expiresAt": view["expiresAt"]}))

    def test_activation_owner_scope_proof_is_exact_replay_idempotent_and_revocation_durable(self):
        plan, request, binding = self.activate()
        self.assertEqual(binding["mode"], "per_order")
        self.assertEqual(binding["accounts"], [{"venue": "lighter", "network": "testnet", "account": 42, "apiKeyIndex": 5}])
        self.assertEqual(self.call("activate", **request)["binding"], binding)
        with self.assertRaises(BrokerError):
            self.call("activate", **{**request, "signature": sign(plan["message"], OTHER)})
        with self.assertRaises(BrokerError):
            self.call("activate", **{**request, "revision": "a" * 64})
        self.call("revoke", profileId=binding["id"])
        self.assertEqual(self.call("revoke", profileId=binding["id"]), {"revoked": True})
        self.assertIsNone(self.call("binding")["binding"])
        with self.assertRaises(BrokerError):
            self.call("activate", **request)
        store = Store(Path(self.config["stateDir"]) / plan["enrollmentId"])
        self.assertEqual(PolicyAuthority(store, binding["grantId"], clock=lambda: self.now).describe()["newRisk"], "revoked")

    def test_encrypted_vault_tamper_and_wrong_wrap_key_fail_closed(self):
        view = self.prepare()
        for suffix in ("", "-wal"):
            path = Path(self.config["stateDir"]) / ("enrollments.sqlite" + suffix)
            if path.exists():
                self.assertNotIn(b"synthetic-private-api-key", path.read_bytes())
        self.service.vault.db.execute("UPDATE enrollments SET body=?", (b"corrupt" * 10,))
        self.service.vault.db.commit()
        with self.assertRaises(BrokerError):
            self.call("status", enrollmentId=view["enrollmentId"])

    def test_wrong_wrapping_credential_cannot_restore_keys(self):
        view = self.prepare()
        self.service.close()
        self.key.write_bytes(os.urandom(32))
        self.service = Provisioner(self.config, venue=self.venue, workers=self.workers, clock=lambda: self.now)
        with self.assertRaises(BrokerError):
            self.call("status", enrollmentId=view["enrollmentId"])

    def test_subject_owner_cannot_be_rebound_or_shared(self):
        self.prepare()
        with self.assertRaises(BrokerError):
            self.call("prepare", walletAddress=OTHER.address)
        with self.assertRaises(BrokerError):
            self.service.dispatch({"operation": "prepare", "subject": "did:privy:another-subject", "walletAddress": OWNER})

    def test_configuration_and_protocol_refuse_network_keys_modes_or_paths(self):
        for extra in ({"network": "mainnet"}, {"privateKey": "no"}, {"mode": "policy"}, {"socket": "/tmp/not-allowed"}):
            with self.assertRaises(BrokerError):
                self.call("prepare", walletAddress=OWNER, **extra)
        for change in ({"mode": "automatic"}, {"creators": []}, {"maxOrderDebitUSDC": "26"}, {"origin": "http://example.com"}):
            with self.assertRaises(BrokerError):
                Provisioner({**self.config, **change}, venue=self.venue, workers=self.workers)

    def test_expired_unclaimed_registration_refreshes_same_key_slot_and_rejects_old_proof(self):
        view = self.prepare()
        original = self.service.vault.read("did:privy:synthetic")
        self.now += 301
        refreshed = self.prepare()
        self.assertEqual({k: refreshed[k] for k in ("enrollmentId", "account", "apiKeyIndex", "publicKey")},
                         {k: view[k] for k in ("enrollmentId", "account", "apiKeyIndex", "publicKey")})
        self.assertNotEqual(refreshed["revision"], view["revision"])
        self.assertEqual(self.service.vault.read("did:privy:synthetic")["privateKey"], original["privateKey"])
        with self.assertRaises(BrokerError):
            self.call("register", enrollmentId=view["enrollmentId"], revision=view["revision"], signature=sign(view["message"]))
        self.assertEqual(self.call("register", enrollmentId=refreshed["enrollmentId"], revision=refreshed["revision"],
                                   signature=sign(refreshed["message"]))["state"], "ready")

    def test_expired_unclaimed_funding_refreshes_same_enrollment(self):
        self.venue.index = None
        view = self.prepare()
        self.now += 301
        refreshed = self.call("status", enrollmentId=view["enrollmentId"])
        self.assertEqual(refreshed["enrollmentId"], view["enrollmentId"])
        self.assertNotEqual(refreshed["revision"], view["revision"])
        with self.assertRaises(BrokerError):
            self.call("faucet", enrollmentId=view["enrollmentId"], revision=view["revision"], signature=sign(view["message"]))
        self.assertEqual(self.call("faucet", enrollmentId=refreshed["enrollmentId"], revision=refreshed["revision"],
                                   signature=sign(refreshed["message"]))["state"], "signature_required")
        self.assertEqual(self.venue.faucets, 1)

    def test_claimed_registration_never_refreshes_after_expiry(self):
        self.venue.accept, self.venue.lost = False, True
        view = self.prepare()
        request = {"enrollmentId": view["enrollmentId"], "revision": view["revision"], "signature": sign(view["message"])}
        self.call("register", **request)
        self.now += 301
        result = self.call("status", enrollmentId=view["enrollmentId"])
        self.assertEqual((result["state"], result["revision"]), ("registering", view["revision"]))
        self.call("register", **request)
        self.assertEqual(self.venue.sends, 1)

    def test_expired_scope_plan_does_not_recreate_grant(self):
        ready = self.ready()
        plan = self.call("preview", enrollmentId=ready["enrollmentId"])
        self.now += 3601
        with self.assertRaises(BrokerError):
            self.call("preview", enrollmentId=ready["enrollmentId"])
        self.assertEqual(self.service.vault.read("did:privy:synthetic")["plan"], plan)


class NativeBridgeTest(unittest.TestCase):
    def test_real_pinned_native_external_signature_without_transport(self):
        import lighter
        private, public, error = lighter.create_api_key()
        self.assertIsNone(error)
        pipe = Mock()
        with patch("requests.sessions.Session.request", side_effect=AssertionError("no transport")), patch("aiohttp.ClientSession._request", side_effect=AssertionError("no transport")):
            _native_process(pipe, "registration", {"account": 42, "apiKeyIndex": 5, "nonce": 7,
                                                  "privateKey": private, "publicKey": public})
        result = pipe.send.call_args.args[0]
        self.assertNotIn("error", result)
        expected = ("Register Lighter Account\n\npubkey: 0x" + public.removeprefix("0x") + "\nnonce: 0x0000000000000007"
                    + "\naccount index: 0x000000000000002a\napi key index: 0x0000000000000005\nOnly sign this message for a trusted client!")
        self.assertEqual(result["message"], expected)
        self.assertEqual(recover_owner(result["message"], sign(result["message"])), OWNER)
        tx = json.loads(result["txInfo"])
        self.assertEqual((tx["AccountIndex"], tx["ApiKeyIndex"], tx["Nonce"]), (42, 5, 7))


if __name__ == "__main__":
    unittest.main()
