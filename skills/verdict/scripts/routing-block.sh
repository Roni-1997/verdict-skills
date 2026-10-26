#!/usr/bin/env bash
# Shared exact-line matching for install.sh and uninstall.sh. No network or build.
find_exact_routing_block() {
  local block_file="$1"
  local user_file="$2"
  awk '
    NR == FNR { block[++n] = $0; next }
    { line[++m] = $0 }
    END {
      for (i = 1; i + n - 1 <= m; i++) {
        if (line[i] != block[1]) continue
        ok = 1
        for (j = 2; j <= n; j++) if (line[i + j - 1] != block[j]) { ok = 0; break }
        if (ok) { print i; exit }
      }
      print 0
    }' "$block_file" "$user_file"
}
