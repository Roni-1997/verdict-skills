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
    token = review.get("approvalId", review["digest"])
    return input(f"Type APPROVE {token} to proceed: ") == "APPROVE " + token


def main(argv=None):
    parser = argparse.ArgumentParser(description="Operator-owned SDK broker with per-order or explicitly issued policy authority")
    parser.add_argument("command", choices=["review", "submit", "status", "cancel", "account", "doctor", "public-market", "public-quote", "serve", "grant-create", "grant-inspect", "grant-revoke"])
    parser.add_argument("--proposal", type=Path)
    parser.add_argument("--leg", type=int, help="Zero-based leg; required for proposal quotes, defaults to 0 for account/cancel")
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
    parser.add_argument("--mode", choices=["per_order", "policy"], help="Required explicit operator mode for serve")
    parser.add_argument("--socket", type=Path, help="Operator-configured absolute Unix socket path for serve")
    parser.add_argument("--grant-id", help="Previously issued policy grant; never a trade request field")
    parser.add_argument("--template", type=Path, action="append", help="Reviewed canonical proposal; repeat to authorize more templates")
    parser.add_argument("--max-debit-usdc", help="Finite cumulative gross debit reservation limit")
    parser.add_argument("--max-orders", type=int, help="Finite cumulative reserved order count")
    parser.add_argument("--expires-at", type=int, help="Grant expiry in Unix milliseconds")
    parser.add_argument("--cancel-own-orders", action="store_true", help="Grant exact original-order cleanup after expiry/revoke")
    args = parser.parse_args(argv)
    if args.command != "public-quote" and args.leg is None:
        args.leg = 0
    # SDK DEBUG logs may contain signed transaction data. Never enable them here.
    logging.disable(logging.DEBUG)
    try:
        if args.mode is not None and args.command != "serve":
            raise BrokerError("--mode applies only to serve; one-shot submit/cancel require per-order confirmation")
        if args.socket is not None and args.command != "serve":
            raise BrokerError("--socket applies only to serve")
        if args.grant_id is not None and args.command not in {"serve", "grant-inspect", "grant-revoke"}:
            raise BrokerError("--grant-id applies only to operator serve/inspect/revoke")
        grant_options = [args.template, args.max_debit_usdc, args.max_orders, args.expires_at]
        if args.command != "grant-create" and (any(value is not None for value in grant_options) or args.cancel_own_orders):
            raise BrokerError("Grant issuance options apply only to grant-create")
        if args.command == "serve":
            if args.mode is None or args.socket is None:
                raise BrokerError("serve requires explicit --mode and --socket operator configuration")
            if (args.mode == "policy") != (args.grant_id is not None):
                raise BrokerError("Policy mode requires --grant-id; per_order mode forbids a grant")
            if args.mode == "per_order" and not sys.stdin.isatty():
                raise BrokerError("Per-order broker service requires the operator's interactive terminal")
            from .adapters import create_adapter
            from .authority import HumanAuthority, PolicyAuthority
            from .rpc import serve_local
            store = Store(args.state_dir)
            authority = PolicyAuthority(store, args.grant_id) if args.mode == "policy" else HumanAuthority(confirmation)
            serve_local(args.socket, Broker(store, create_adapter, authority=authority))
            return 0
        elif args.command == "grant-create":
            if not args.template or any(value is None for value in [args.max_debit_usdc, args.max_orders, args.expires_at]):
                raise BrokerError("grant-create requires --template, --max-debit-usdc, --max-orders and --expires-at")
            from .authority import issue_grant
            result = issue_grant(Store(args.state_dir), [load_proposal(path) for path in args.template],
                                 max_debit_usdc=args.max_debit_usdc, max_orders=args.max_orders,
                                 expires_at_ms=args.expires_at, cancel_own_orders=args.cancel_own_orders,
                                 confirm=confirmation)
        elif args.command in {"grant-inspect", "grant-revoke"}:
            if args.grant_id is None:
                raise BrokerError("Grant inspect/revoke requires --grant-id")
            from .authority import inspect_grant, revoke_grant
            store = Store(args.state_dir)
            result = inspect_grant(store, args.grant_id) if args.command == "grant-inspect" else revoke_grant(store, args.grant_id)
        elif args.command == "public-quote":
            from .quotes import quote_polymarket, quote_proposal
            if args.proposal is not None and any(value is not None for value in [args.venue, args.network, args.market_id, args.side, args.action, args.shares, args.limit_price]):
                raise BrokerError("Proposal quotes derive all order fields; remove venue/network/market/side/action/shares/limit overrides")
            if args.proposal is None and args.leg is not None:
                raise BrokerError("--leg requires --proposal for public quotes")
            if args.snapshot is not None:
                if args.venue is not None or args.network is not None or args.market_id is not None:
                    raise BrokerError("Use a saved snapshot or live venue/network/market arguments, not both")
                if not args.snapshot.is_file() or args.snapshot.stat().st_size > 1_048_576:
                    raise BrokerError("Expected snapshot file of at most 1 MiB")
                snapshot = json_load(args.snapshot.read_text())
                if not isinstance(snapshot, dict):
                    raise BrokerError("Saved public snapshot must be a JSON object")
            else:
                if args.at is not None:
                    raise BrokerError("--at applies only to saved snapshot replay")
                if args.proposal is None and (args.venue != "polymarket" or args.network != "polygon"):
                    raise BrokerError("Live quotes require --venue polymarket --network polygon; --at applies only to saved replay")
                snapshot = None
            if args.proposal is not None:
                result = quote_proposal(args.proposal, args.leg, snapshot=snapshot, at=args.at, max_age_ms=args.max_age_ms)
            else:
                if snapshot is None:
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
                from .authority import HumanAuthority
                store = Store(args.state_dir)
                broker = Broker(store, create_adapter, authority=HumanAuthority(confirmation))
                if args.command == "submit":
                    result = broker.submit(proposal)
                elif args.command == "status":
                    result = broker.status(proposal)
                elif args.command == "cancel":
                    result = broker.cancel(proposal, args.leg)
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
