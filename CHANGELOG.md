# Changelog

## [Unreleased]

### Added
- **Installed version is now visible.** A `VERSION` file at the repository
  root is the single source of truth. `install.sh` records it in
  `/usr/lib/sqm/Seg_Layer_Cake.version`, the SQM script logs it at startup,
  `dscp-validate.sh` prints it in the report header, and the DSCP Policies tab
  shows it in LuCI. Makes forum support reports unambiguous.

### Changed
- **Rule order documented.** The four classification rules form a cascade and
  the docs never said so, which made two of them easy to misread: Bulk marks
  *all* web traffic of a priority device rather than only large downloads, and
  Browsing only ever sees what is still CS0. LuCI descriptions now number the
  rules and name what each one targets; the README gained a rule-order table.
  Big HTTPS Auto-Downgrade is also documented as a no-op unless 443 is removed
  from the browsing port list, since the Bulk rule already covers it.
- **Connections view colours now follow the CAKE tins.** They previously
  showed a generic DSCP hierarchy: CS4 appeared as medium priority although
  diffserv4 puts it in the Voice tin, and CS2/AF2x appeared as low priority
  although they sit in the Video tin. Bulk traffic (CS1, LE) now has its own
  grey instead of looking like ordinary traffic, and VA and LE are decoded
  rather than shown as raw numbers.
- **`priority_udp_dscp` now defaults to `ef` instead of `cs4`.** Measured on
  the bench and confirmed against the kernel tables in `sch_cake.c`: on
  diffserv3 — the sqm-scripts default — CS4 lands in Best Effort, so priority
  traffic gets no priority at all unless the shipped config (diffserv4) is in
  use. EF reaches the Voice tier on diffserv3, diffserv4 and diffserv8 alike,
  and `cfg80211_classify8021d()` maps it to AC_VO rather than AC_VI on Wi-Fi.
- **`enable_mq` now defaults to 0.** With `USE_MQ` exported from the UCI
  option, `select_cake()` installed cake_mq on any multi-queue NIC. Without
  system tuning (one queue per core, RPS off on the WAN, irqbalance) this can
  perform worse than plain cake, so the default now matches sqm-scripts 1.7.2.
  Existing configs keep whatever they already set.

### Fixed
- **Config lost on re-install.** The installer only ever wrote
  `/etc/config/sqm.orig`, and only when no `.orig` existed, so a second
  install overwrote a customised config with no backup and no message.
  The active config is now copied to `/etc/config/sqm.bak-<date>-<time>`
  before every overwrite, and the overwrite is skipped if that copy fails.
  `.orig` keeps its role unchanged: written once, restored by `uninstall.sh`.
  Reproduced on OpenWrt 25.12.4 / RB5009 with v1.7.0.
- **ctinfo mark storage was not limited to the WAN.** `StoreIPv4ctmark` and
  `StoreIPv6ctmark` had no interface condition, so download traffic on its
  way to the LAN could overwrite the mark stored for the upload direction,
  moving a single flow between CAKE tins. Both rules, in the ctinfo ON and
  ctinfo OFF branches, now match `oifname "$IFACE"`.

## [1.7.0]

### Removed
- **Micro-packet / Small-packet rules and their options** (`micro_pkt_enable`,
  `micro_pkt_dscp`, `micro_pkt_threshold`, `small_pkt_threshold`).
  These rules matched the same devices and ports as Priority UDP/TCP but
  excluded packets carrying the Priority DSCP, which the Priority rules had
  just set, so they could never match. Verified on OpenWrt 25.12.5: 0 packets
  after a full game session while Priority rules matched about 57,000.
  Traffic handling is unchanged. Existing `micro_pkt_*` / `small_pkt_*`
  options in `/etc/config/sqm` are ignored and can stay.

### Fixed
- **CAKE tier mapping** in README, LuCI labels and comments now matches the
  kernel `diffserv4` table: CS4 and CS5 map to Voice (not Video), CS2 and CS3
  to Video (not Best Effort), AF1x to Best Effort (not Bulk).
- **ctinfo guidance**: keep ctinfo enabled in every topology, including double
  NAT. Ingress traffic is redirected to the IFB before nftables prerouting
  runs, so with ctinfo off only upload traffic is classified. Previous docs
  recommended disabling ctinfo behind another NAT router.
- Browsing "gaming-first" profile now recommends AF11 (Best Effort); the
  previously recommended CS3 is in the Video tier.
- `dscp-validate.sh`: per-tin stats show the busiest `cake_mq` queue instead
  of the first one, which is often idle and displayed only zeros (tested on
  simulated `cake_mq` output; plain CAKE output verified on hardware). Section
  labels no longer hardcode default DSCP values.
- Default Priority UDP DSCP aligned to the recommended CS4 (was EF in the
  script and LuCI, CS5 in `sqm.config`). All three map to the Voice tier, so
  traffic handling is unchanged.
- README install URL updated to v1.7.0.

## [1.6.3]

### Fixed
- **Priority UDP/TCP rules now also match the remote (server) port.**
  Previous releases matched only the port on the priority device's side
  (`sport` upload, `dport` download). Clients using an ephemeral local port
  (observed with a PC game, Delta Force) were never classified, whatever the
  configured port list. Each Priority rule now has a twin (comment suffix
  `srv`) matching the server port. Clients with a fixed local port (consoles,
  EA FC on PC) are unaffected. Verified on OpenWrt 25.12.5 (IPv4 UDP, both
  directions).
- README install URL pointed to v1.6.1.
- `SHA256SUMS` regenerated from LF files; the previous file was generated from
  CRLF checkouts and did not verify.

## [1.6.2]

### Fixed
- **Package name**: `conntrack-tools` replaced by `conntrack` in `REQUIRED_PKGS`.
  `conntrack-tools` is the OpenWrt *source* package name and is not installable;
  the binary packages it produces are `conntrack` and `conntrackd`. The install
  silently reported a non-critical failure on every release since v1.6, leaving
  the Flush Conntrack button without its backend.

### Correction notice
- v1.6 CHANGELOG stated "New required package: `conntrack-tools`". The correct
  package name is `conntrack`.

## v1.6.1

### Fixed (QoS / CAKE)

- **Egress hash mode now correctly set to `dual-srchost`** in the default
  `sqm.config`. The v1.5 changelog mistakenly claimed this fix had already
  shipped — see Correction notice below.
- Clearer error message when the CAKE qdisc is unavailable (kmod-sched-cake
  missing).
- SQM section detection now escapes `.` in interface names, avoiding false
  matches on VLAN-style names like `eth1.2`.

### Changed (QoS defaults)

- **`rtt 1ms` removed from default `sqm.config` opts** — CAKE now auto-tunes
  RTT (~100ms), which is the right choice for most home setups. Users with
  short-path gaming LANs can re-add `rtt 1ms` to `iqdisc_opts` / `eqdisc_opts`
  via LuCI's advanced qdisc options.

### Improved (installer)

- **Critical kernel modules now abort the install on failure** —
  `kmod-sched-cake`, `kmod-ifb`, `kmod-sched-ctinfo`, `kmod-nf-conntrack`,
  `kmod-nft-core`, `nftables`, `sqm-scripts`, `tc`/`tc-full`. Previously
  the installer reported "completed successfully" even with broken core SQM.
- **Keeping existing `/etc/config/sqm` now skips UCI pre-configuration** —
  if you answer N to the overwrite prompt, the installer no longer forces
  `enabled='1'` on your existing config. Select `Seg_Layer_Cake.qos`
  manually in LuCI: Network → SQM QoS.
- Disk space check is now robust to non-numeric `df` output (warns and
  proceeds instead of silently bypassing the check).
- Backup of existing `sqm.config` / `sqm.js` now compares against the custom
  version first — if the existing file already is the custom, no `.orig`
  is created (prevents clobbering a real `.orig` on re-install).
- Final installer summary now reflects actual state (does not claim
  "Active SQM script: Seg_Layer_Cake.qos" when the user kept their config).
- Explicit `chmod 0755` on installed files instead of `chmod +x` (umask-safe).

### Improved (uninstaller)

- **Uninstall now removes the entire `/www/luci-static/resources/view/dscp/`
  directory and uses a glob pattern `luci-app-dscp*.json`** in shared
  directories — aligned with the installer's glob-based deployment.
- `safe_rm` now reports the actual outcome (Removed / Failed / Not present)
  instead of a misleading "Not found" message that never triggered.
- Final summary now lists `/etc/config/sqm` (previously omitted).

### Improved (LuCI UI)

- **`gaming_ip` / `gaming_ip6` fields now validate input** — comma-separated
  IPv4/IPv6 addresses, with optional CIDR. Typos no longer silently produce
  broken nftables rules.
- The IPv4 field description now mentions prefix (CIDR) support, matching
  the IPv6 field and the underlying nftables behavior.

### Security

- **Conntrack flush button (RPC backend) now rejects overly broad CIDR masks**
  — IPv4 < /24 and IPv6 < /64 are blocked. Previously `0.0.0.0/0` would
  wipe the entire conntrack table.

### Correction notice

The v1.5 changelog "Fixed" section claimed `eqdisc_opts now uses dual-srchost`,
but the actual code change to `sqm.config` was missing — both `v1.5` and
`v1.6` tags ship with `dual-dsthost`. The fix has now correctly landed in
v1.6.1.

---

## v1.6

### Added

- **Tier-aware DSCP dropdowns** — every value in the LuCI DSCP Policies tab
  now displays its target CAKE tier (Voice / Video / Best Effort / Bulk)
  directly in the option label, so users can pick values without memorizing
  the diffserv4 mapping.
- **AF41** option added to the browsing DSCP dropdown (Multimedia Conferencing,
  Video tier, low-drop).
- **DSCP Quick Reference** section in the README with CAKE tier mapping
  table and recommended values per dropdown.

### Improved

- README rewritten with ctinfo behavior, UDP classification details, and
  updated installation instructions.

---

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
