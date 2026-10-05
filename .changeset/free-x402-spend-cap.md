---
"@routedock/routedock": patch
---

`pay()` releases the local spend-cap reservation when an x402 endpoint answers 200 without a 402 challenge, so free responses no longer count against `spendCap.daily` or endpoint caps.
