# Review and execute a Lighter order

Signable only through the separate authorized SDK broker. Preparation is unsigned.

Execution requires a provisioned connection to the operator-owned SDK broker or private hosted signer. The default research MCP only prepares unsigned SDK arguments. See the configured connection's capabilities before using execution tools.

## Prepare exact terms

For a hosted maximum-spend buy, call `execution_prepare_lighter_intent` with a stable UUID `intentId`, numeric `market`, `side` of `yes` or `no`, and decimal-string `maxSpendUSDC` including fees. Optional limits are `maxSlippageBps` and `limitPrice`. The service supplies the linked account and reviewed creator scope, reads fresh depth, and derives an IOC proposal. Reusing an intent ID returns its original proposal.

For an operator-specified order, `execution_prepare` accepts one Lighter leg with explicit account, network, API key index, creator, market, action, side, shares, limit price, fee reserve, and time in force. Other venues and pairs are rejected by the active MCP. The proposal is unsigned and grants no authority.

Persist the returned proposal unchanged. Review it with `execution_review` and check current constraints with `execution_preflight` when available. Do not edit the payload, digest, timestamps, or original order identity.

## Per-order confirmation

Show every confirmation line, including account, network, creator, market, full settlement rule, action, side, price, size, maximum spend, fee reserve and caps, and expiry. Do not round amounts. Explain that a sell can open the opposite position because reduce-only is unsupported.

In `per_order` mode, ask for confirmation and end your message. Wait for an explicit reply in a new message. Preparation and independent approval happen in separate turns. Never fabricate confirmation. A review URL, digest, model statement, or tool result is not approval.

Hosted `execution_submit` returns a review URL for the independently signed-in user to approve the exact order. Local execution requires exact approval in the operator's terminal. Never complete either approval on the user's behalf. A chat reply alone does not authorize the signer.

An abort means stop. Do not ask again. An abort closes the request; a later override is a new request. A changed parameter invalidates the confirmation. Prepare the revised terms and show them again. Urgency does not shorten the approval flow.

## Existing bounded policy

In explicitly operator-selected `policy` mode, use only a previously owner-approved bounded grant. Check its account, network, reviewed terms, spend, order count, and expiry. Never change mode, create authority, expand limits, or infer a policy grant from a request to skip approval.

## Submit and reconcile

Submit the unchanged original proposal. The broker rechecks authority, market state, balances, fees, and account permissions before official SDK signing. These checks cannot guarantee a fill.

On uncertain delivery, call `execution_status` with the original proposal. Never automatically resubmit or reprepare. A status call can reconcile an original order after proposal or grant expiry. Report acknowledgements, fills, and unknown state separately.

`execution_cancel` takes that original proposal and `leg: 0`. Cancellation can race fills. Reconcile after requesting it, and never substitute an exchange ID for an original client order identity.

## Unsigned SDK arguments

`lighter_build_order` and `lighter_build_cancel` return unsigned `sdkArgs`. The separate operator-controlled signer owns the official SDK handoff and a fresh nonce. They are not submission tools. The market fee estimate includes no configured integrator fee.

Keys, authentication tokens, and signed transactions never enter chat, agent arguments, or the public MCP. Never write ad-hoc signing code at trade time, print a key or signed payload, or use a default research process as a signer.

## Errors

A validation error sends no order. `delivery_unknown` requires reconciliation, not a read-style retry. Expired or changed proposals need a new review only for a genuinely new trade after the original attempt is resolved. Never declare a failed transport to be a rejected order.
