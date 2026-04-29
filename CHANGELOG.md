# Changelog

## v1.5

### Added

- **Configurable Micro-packet threshold** — new `micro_pkt_threshold` option
  exposed in LuCI (DSCP Policies tab). Default: 60 bytes, range 40–200.
- **Configurable Small-packet threshold** — new `small_pkt_threshold` option
  exposed in LuCI (DSCP Policies tab). Default: 200 bytes, range 100–500.
- Both fields visible only when "Enable micro-packet priority" is checked.

### Improved

- **MicroPkt and SmallPkt rules** now reference `$BULK_DSCP` dynamically
  instead of hardcoding `cs1`. Guards remain consistent if `gaming_bulk_dscp`
  is set to a non-default value (e.g. `af11`). Functionally identical for
  users keeping the default `cs1`.

### Changed

- **Default Micro/Small thresholds tightened from 150/300 to 60/200 bytes**
  to better target true control-plane packets:
  - Under 60 bytes: TCP ACKs, UDP keepalives, STUN/ICE probes, DNS
  - 60 to 200 bytes: small interactive packets (VoIP RTP, telemetry)
- LuCI labels for Micro-packet section reworded to reflect general use cases
  (not gaming-specific terminology)

### Fixed

- **Egress hash mode corrected** — `eqdisc_opts` now uses `dual-srchost` in
  egress (was `dual-dsthost`), matching CAKE's documented best practice:
  source-based isolation on egress, destination-based isolation on ingress.
  Throughput tests showed measurable improvement on saturated WAN links
  without any impact on bufferbloat scores.

### Migration notes

- Users who had calibrated their setup on the old 150/300 byte defaults can
  preserve the previous behavior by setting `micro_pkt_threshold=150` and
  `small_pkt_threshold=300` in DSCP Policies after upgrade.

---

## v1.4

### Added

- **One-click Flush Conntrack button** in the DSCP Connections view. Clears
  active conntrack entries for the priority device (IPv4 + IPv6) configured
  in DSCP Policies. Reads the IPs dynamically from UCI at click time, asks
  for confirmation, then displays the number of flushed flows. Useful after
  changing DSCP rules to force re-classification of in-flight connections.
- **Diagnostic tool** `tools/dscp-validate.sh` — standalone shell script
  that validates the full DSCP / SQM / CAKE pipeline. Generates a 19-section
  read-only report covering nftables rule counters, CAKE per-tin latency,
  conntrack stats, and a final verdict line.
- `--anonymize` flag in the diagnostic tool — masks IPv4, IPv6, and hostname
  in the report for safe public sharing on forums or GitHub issues.
- `flushConntrack` method in `luci.dscp` rpcd backend, with shell-metacharacter
  input validation (`safe_ip` helper) and parsed flow-count return.
- `write` ACL section in `luci-app-dscp.json` granting access to the new
  `flushConntrack` method.
- New required package: `conntrack-tools` (auto-installed by `install.sh`).

### Improved

- **`install.sh`** — adds optional file check for `tools/dscp-validate.sh`,
  installs the diagnostic tool to `/root/dscp-validate.sh` with chmod +x,
  and mentions it in the post-install summary.
- **`uninstall.sh`** — renumbered steps from 1/6 to 1/7, new step 6 removes
  the diagnostic tool from `/root/`.
- **README** updated with full documentation of new features, including
  a dedicated "Diagnostic tool" section with usage examples and the list
  of 19 report sections.

### Fixed

- **Sort direction inverted** in DSCP Connections view — `_sortValue`
  comparator was using the wrong sign convention, causing all "descending"
  sorts to actually sort ascending. The bug existed since the initial
  release and affected every column (Bytes, Packets, DSCP, etc.).
- **SQM view cleanup** — removed a non-functional Flush Conntrack button
  that used `rpc.declare({object:'system', method:'exec'})`, which is not
  exposed by rpcd by default. Functionality is now properly implemented
  via the new `flushConntrack` rpcd method.

---

## v1.3

### Added

- Strict client-side validation on all port-list fields in DSCP Policies
  LuCI form (rejects invalid characters, validates ranges)

### Improved

- **DSCP rules refactoring** — six major reorderings for cleaner pipeline:
  - Bulk classification now runs **before** MicroPkt/SmallPkt rules
  - MicroPkt/SmallPkt rules now have strict port gating to avoid Voice tin
    pollution (only matches gaming UDP/TCP ports, never default range)
  - Browsing classification scope tightened (CS0-only, never overwrites
    existing DSCP marks)
  - Removed redundant AWS-specific hack from earlier versions
- **LuCI form** — default flag values fixed (some toggles were off-by-default
  but visually appeared on)
- **README** rewritten for clarity and structure

### Changed

- AWS-specific bulk classification rule removed (was too narrow, now handled
  by generic `BulkTCPdwn` rules)
- LuCI labels and help texts updated for consistency

### Fixed

- Default flag values mismatch in LuCI form (visual / actual state)
- Order-dependent rule matching that could leave Bulk traffic in Voice tin

---

## v1.2

### Added

- **Micro-packet priority** — packets < 150 bytes from priority devices are
  automatically boosted to the highest CAKE tin (CS6/CS7/EF, configurable via LuCI)
- **Small packet boost** — packets between 150–300 bytes from priority devices
  receive the Priority UDP DSCP value automatically
- **Big HTTPS auto-downgrade** — large HTTPS packets (> 1000 bytes) from priority
  devices are automatically downgraded to Bulk DSCP to prevent download flooding
- **Dual-mode ingress pipeline**:
  - ctinfo ON → all DSCP rules in postrouting, kernel ctinfo handles ingress restore
  - ctinfo OFF → all DSCP rules move to prerouting, marking download traffic
    before IFB redirect so CAKE sees correct DSCP on ingress
- **Adaptive polling** in DSCP Connections view — adjusts interval (1–10s)
  based on rpcd response time
- **Pause / Resume** button in DSCP Connections view
- **Connection counter** with filter display (e.g. `16 / 221 total`)
- **Multi-term AND filter** in Connections view (e.g. `192.168.1.100 udp ef`)
- **Micro-packet DSCP** option in LuCI (CS6 / CS7 / EF)
- **Big HTTPS downgrade** toggle in LuCI (depends on bulk being enabled)
- IPv6 prefix support for priority devices (e.g. `fd00::/48`)

### Improved

- **ctinfo ON** — prerouting chain is now intentionally empty; no redundant rules
- **ctinfo OFF** — prerouting mirrors postrouting rules, postrouting only stores
  conntrack mark — correct pipeline for both upload and download
- **Browsing classification** now conditioned on `ip dscp cs0` — never overwrites
  an existing DSCP mark applied by earlier rules
- **install.sh** — fully translated to English; added disk space check, source
  file verification, dry-run mode, non-blocking package install
- **uninstall.sh** — fully translated to English; added dry-run, --force,
  --keep-config options; nftables cleanup verified before file removal
- Lua 5.1 compatibility fix in `luci.dscp` rpcd backend (bitwise operators
  replaced with arithmetic equivalents for OpenWrt rpcd environment)
- DSCP Connections view — colour-coded DSCP cells, IPv6 address truncation
  with full address in tooltip, improved sort indicators
- `sqm.js` — reformatted from minified to readable code; tab renamed to
  `DSCP Policies`; descriptions updated for general use (not gaming-specific)
- `Seg_Layer_Cake.qos` — MQ support fixed (`USE_MQ` and `SUPPORT_MQ` both
  exported correctly for `select_cake` and `start-sqm`)
- `uci_get` helper replaces fragile `|| echo` subshell pattern
- `make_nft_set` helper ensures correct nftables set syntax for single IPs

### Changed

- DSCP rules are now built by a single `_build_dscp_rules()` function called
  with either `prerouting` or `postrouting` depending on ctinfo mode
- `set -x` removed from production script (was flooding syslog)
- Comments in nftables rules no longer contain spaces (shell quoting fix)
- `sqm.config` defaults updated: all DSCP options disabled by default,
  personal IP/bandwidth values replaced with generic placeholders

### Fixed

- nftables `comment` syntax error when comments contained spaces
- `select_cake` not activating `cake_mq` due to missing `USE_MQ` export
- Lua bitwise `&` operator incompatibility with Lua 5.1 in rpcd backend
- prerouting rules matching 0 packets when ctinfo was enabled (now empty)

---

## v1.1

### Added

- Support for **CAKE multi-queue (cake_mq)** for multi-core hardware
- Optional **DSCP restore via conntrack (ctinfo)**
- Separate **UDP and TCP priority classification**
- Early **prerouting DSCP marking** for download traffic
- Conditional DSCP rule creation based on LuCI options

### Improved

- More reliable download classification for CAKE
- Cleaner nftables rule structure
- Better DSCP policy flexibility
- Improved SQM integration with hardware multi-queue NICs

### Changed

- Gaming traffic classification redesigned
- Priority UDP and TCP rules now configurable independently
- DSCP marking pipeline now uses prerouting + postrouting

### Fixed

- Improved IFB redirection behaviour
- Better cleanup of nftables rules on SQM stop
