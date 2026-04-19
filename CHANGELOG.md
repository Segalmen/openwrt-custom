# Changelog

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
