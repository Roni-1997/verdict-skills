"""Run with python -m verdict_broker from local-runner, in an operator-owned shell."""
import argparse
import importlib.metadata
import json
import logging
from pathlib import Path
import sys

from .core import Broker, BrokerError, Store, identity, json_load, load_proposal, node_call


def confirmation(review):
    print("\n".join(json.dumps(line, ensure_ascii=True) for line in review["confirmation"]), file=sys.stderr)
    if not sys.stdin.isatty():
        raise BrokerError("Submission/cancellation requires the operator's interactive terminal; no approval bypass flag")
    # Public text only; do not let untrusted market descriptions inject terminal control codes.
    return input(f"Type APPROVE {review['digest']} to proceed: ") == "APPROVE " + review["digest"]


def main(argv=None):
    parser = argparse.ArgumentParser(description="Local SDK trading broker; agents prepare unsigned proposals, operators approve here")
    parser.add_argument("command", choices=["review", "submit", "status", "cancel", "account", "doctor", "public-market", "public-quote"])
    parser.add_argument("--proposal", type=Path)
    parser.add_argument("--leg", type=int, default=0, help="Zero-based leg for account/cancel")
    parser.add_argument("--venue", choices=["hl", "lighter", "polymarket"])
    parser.add_argument("--network", choices=["testnet", "devnet", "mainnet", "polygon"])
    parser.add_argument("--market-id")
    parser.add_argument("--snapshot", type=Path, help="Saved public Polymarket snapshot for quote replay")
    parser.add_argument("--side", choices=["yes", "no"])
    parser.add_argument("--action", choices=["buy", "sell"])
    parser.add_argument("--shares")
    parser.add_argument("--limit-price")
    parser.add_argument("--at", type=int, help="Explicit replay evaluation time in Unix milliseconds")
    parser.add_argument("--max-age-ms", type=int, default=5000)
    parser.add_argument("--state-dir", type=Path, default=Path.home() / ".local/state/verdict-broker")
    args = parser.parse_args(argv)
    # SDK DEBUG logs may contain signed transaction data. Never enable them here.
    logging.disable(logging.DEBUG)
    try:
        if args.command == "public-quote":
            from .quotes import quote_polymarket
            if args.snapshot is not None:
                if args.venue is not None or args.network is not None or args.market_id is not None:
                    raise BrokerError("Use a saved snapshot or live venue/network/market arguments, not both")
                if not args.snapshot.is_file() or args.snapshot.stat().st_size > 1_048_576:
                    raise BrokerError("Expected snapshot file of at most 1 MiB")
                snapshot = json_load(args.snapshot.read_text())
            else:
                if args.venue != "polymarket" or args.network != "polygon" or args.at is not None:
                    raise BrokerError("Live quotes require --venue polymarket --network polygon; --at applies only to saved replay")
                from .public import public_market
                snapshot = public_market(args.venue, args.network, args.market_id)
            result = quote_polymarket(snapshot, args.side, args.action, args.shares, limit_price=args.limit_price, at=args.at, max_age_ms=args.max_age_ms)
            result["sourceMode"] = "saved_snapshot" if args.snapshot is not None else "live_capture"
        elif args.command == "public-market":
            from .public import public_market
            result = public_market(args.venue, args.network, args.market_id)
        elif args.command == "doctor":
            result = {"python": sys.version.split()[0], "credentialsLoaded": False,
                      "sdkVersions": {name: importlib.metadata.version(name) for name in ["hyperliquid-python-sdk", "lighter-sdk", "polymarket-client"]},
                      "execution": node_call(["execution", "capabilities"])}
        else:
            if args.proposal is None:
                raise BrokerError("--proposal is required")
            proposal = load_proposal(args.proposal)
            if args.command == "review":
                result = node_call(["execution", "review", "--input", json.dumps(proposal)])
            else:
                from .adapters import create_adapter
                store = Store(args.state_dir)
                broker = Broker(store, create_adapter)
                if args.command == "submit":
                    result = broker.submit(proposal, confirmation)
                elif args.command == "status":
                    result = broker.status(proposal)
                elif args.command == "cancel":
                    result = broker.cancel(proposal, args.leg, confirmation)
                else:
                    legs = proposal["payload"]["legs"]
                    if not 0 <= args.leg < len(legs):
                        raise BrokerError("Invalid leg index")
                    with store.locked(legs):
                        adapter = create_adapter(legs[args.leg])
                        try:
                            check = adapter.preflight(legs[args.leg], identity(proposal, args.leg))
                            result = {"venue": legs[args.leg]["venue"], "network": legs[args.leg]["network"], "account": legs[args.leg]["account"],
                                      "inventoryShares": check.inventory, "availableUSDC": check.available_usdc, "feeBoundUSDC": check.required_fee,
                                      "note": "Read-only preflight; no signing or submission. Dedicated account with no external writers required."}
                        finally:
                            adapter.close()
        print(json.dumps(result, ensure_ascii=True))
        return 0
    except BrokerError as e:
        print(json.dumps({"error": "broker_blocked", "message": str(e)}), file=sys.stderr)
        return 1
    except Exception:
        print(json.dumps({"error": "broker_error", "message": "SDK/local operation failed; details hidden because SDK exceptions may contain credentials or signed payloads. Reconcile attempted orders; never retry blindly."}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
