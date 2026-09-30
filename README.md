# DSCP Policies for SQM – OpenWrt

Custom SQM setup for OpenWrt using **CAKE**, **DSCP**, and **nftables**,
designed to improve latency-sensitive traffic prioritization.

Works great for gaming, VoIP, video conferencing, streaming — any real-time
application that benefits from low and stable latency.

This project provides:

- A custom SQM script (`Seg_Layer_Cake.qos`)
- nftables-based DSCP marking (IPv4 / IPv6)
- Traffic classification with priority rules and bulk downgrade
- Download classification through kernel `ctinfo` DSCP restore
- Automated installer with dependency handling
- LuCI custom view with real-time DSCP Connections monitor
- One-click conntrack flush button for the priority device
- Diagnostic tool to validate the full DSCP / SQM / CAKE pipeline
- **Tier-aware DSCP dropdowns** with full coverage of all CAKE tiers

---

## DSCP Policies (LuCI)

The custom SQM interface adds a **DSCP Policies** tab in LuCI.

### Multi-Queue Support
`cake_mq` spreads the queue across multiple CPU cores or NIC queues. It is
**off by default**: without system tuning (one queue per core, RPS off on the
WAN, irqbalance) it can perform worse than plain `cake`. sqm-scripts made the
same choice in 1.7.2. Turn it on only if you can measure the difference.

### DSCP Restore via conntrack (ctinfo)
Store DSCP into conntrack mark and restore it on ingress using the `ctinfo`
kernel action. All classification rules run in postrouting, and the kernel
restores the mark on download traffic before CAKE sees it.

> **Keep ctinfo enabled in every topology, including double NAT.**
> On Linux, ingress traffic is redirected to the IFB (and shaped by CAKE)
> *before* nftables prerouting runs, so download traffic can only be
> classified through ctinfo. Verified on a router sitting behind another
> OpenWrt router: download priority rules matched with ctinfo ON.
>
> With ctinfo OFF, rules move to prerouting and only **upload** traffic is
> classified; download traffic reaches CAKE with the DSCP it arrived with.

### Rule order — read this first

The four classification rules form a cascade. They are evaluated in the order
below, and each one only sees what the previous ones left alone: a packet
already marked is not re-marked, because the Browsing rule matches CS0 only.

| # | Rule | What it matches | Typical result |
|---|------|-----------------|----------------|
| 1 | Priority UDP | priority devices, gaming UDP ports | Voice tier |
| 2 | Priority TCP | priority devices, gaming TCP ports | your choice |
| 3 | Bulk | priority devices, Bulk port lists | Bulk tier |
| 3b | Big HTTPS | priority devices, HTTPS packets > 1000 bytes | Bulk tier |
| 4 | Browsing | anything still CS0 — in practice the rest of the LAN | Video tier |

Two consequences worth knowing. Whatever the Bulk rule marks never reaches
Browsing, so with Bulk on, Browsing applies to your other devices only. And
Big HTTPS only acts on ports the Bulk rule left alone — which is why 443 is
absent from the default Bulk TCP ports: plain HTTP goes to Bulk wholesale,
while on HTTPS each packet is judged by size, keeping browsing responsive and
sending large downloads to the Bulk tier.

### Priority UDP Classification
Mark UDP traffic from/to priority devices on the specified ports with a
configurable DSCP value. Suitable for gaming, VoIP, and real-time apps.

The configured ports are matched on both sides of each flow: the local
port (consoles and clients with a fixed local port) and the remote server
port (clients that use a random local port, common on PC).

### Priority TCP Classification
Mark TCP traffic from/to priority devices (optional), with the same
local/remote port matching as Priority UDP.
Useful for remote desktop, video conferencing signalling, etc.

### Browsing Classification
Optionally classify web browsing traffic (HTTP/HTTPS/QUIC) with a specific
DSCP value. Only marks CS0 traffic — does not overwrite existing marks, so
with Bulk enabled it applies to every device except the priority ones.

### Bulk Traffic Classification
Mark the web traffic of priority devices with a lower DSCP value so it does
not compete with real-time traffic. Since v1.8.0 it has its own port lists,
`bulk_tcp_ports` and `bulk_udp_ports`, independent of the browsing ones.
Defaults: `80,8080` for TCP, empty for UDP. Leaving either empty falls back
to the matching browsing list, which is how installs before v1.8.0 behaved.

### Big HTTPS Auto-Downgrade
Downgrades large HTTPS packets (> 1000 bytes) from priority devices to the
Bulk DSCP value — the per-packet half of the Bulk rule. It lives inside the
Bulk rule, so it requires Bulk Classification to be enabled, and it only acts
on ports the Bulk lists leave alone. Keep 443 out of `bulk_tcp_ports` for it
to do anything.

---

## DSCP Quick Reference

Each dropdown in the **DSCP Policies** tab now displays the target CAKE
tier directly in the option label, so you can choose values without
memorizing the diffserv4 mapping.

### CAKE diffserv4 tier mapping

| CAKE Tier | DSCP values | Typical use |
|-----------|-------------|-------------|
| **Voice** (highest) | CS4, CS5, CS6, CS7, EF, VA | Real-time interactive, gaming, VoIP, network control |
| **Video** | CS2, CS3, AF2x, AF3x, AF4x | Multimedia, conferencing, streaming, OAM |
| **Best Effort** | CS0, AF1x | Default traffic |
| **Bulk** (lowest) | CS1, LEPHB | Background, scavenger, bulk downloads |

Source: the `diffserv4` table in the Linux kernel (`net/sched/sch_cake.c`).

### Choosing the right value for browsing

The `browsing_dscp` dropdown spans three tiers (Video, Best Effort, Bulk),
with three recommended profiles:

- **Gaming-first setup** → use `AF11` (browsing stays in Best Effort,
  below the Video and Voice tiers)
- **Browsing-priority setup** → use `AF21` (default, boosts web into the
  Video tier, above Best Effort and Bulk)
- **Strong deprioritization** → use `CS1` or `LEPHB` (browsing yields
  to everything in Bulk tier)

### Recommended values per dropdown

| Dropdown | Recommended | Rationale |
|----------|-------------|-----------|
| Priority UDP | `EF` (default) | Voice tier on diffserv3, diffserv4 and diffserv8; Wi-Fi AC_VO |
| Priority TCP | `CS0` | Gaming TCP (auth, login) shouldn't compete with real-time UDP |
| Browsing | `AF21` (default) or `AF11` (gaming-first) | See profiles above |
| Bulk | `CS1` | Classic background; `LEPHB` for the modern RFC8622 equivalent |

---

All required dependencies are handled automatically by the installer.

---

## Requirements

### Supported system
- OpenWrt **25.x** (apk) — fully supported, tested target.
- OpenWrt **24.x** (opkg) — best-effort. The installer detects opkg and uses it,
  but package names may have shifted on older trees; critical kernel modules
  are validated at install time (the install aborts if any are missing).
- Earlier versions are not supported.

### Required packages

The following packages are required for full functionality
(all are automatically installed by `install.sh`):

- `luci-app-sqm` – SQM LuCI interface
- `sqm-scripts` – SQM framework
- `kmod-sched-cake` – CAKE queue discipline
- `kmod-ifb` – IFB support (for ingress shaping)
- `kmod-sched-ctinfo` – TC ctinfo action (DSCP restore from conntrack)
- `nftables` – DSCP marking and classification
- `kmod-nft-core` – nftables kernel support
- `tc` / `tc-full` – traffic control utilities
- `ip-full` – advanced IP tooling
- `lua` – required for rpcd backend
- `luci-lib-jsonc` – JSON handling for LuCI / rpcd
- `conntrack` – required for the Flush Conntrack button

### Permissions
- Root access on the router is required
- `rpcd` and `uhttpd` services must be running

---

## Features

- CAKE queue discipline for upload and download
- Installed version recorded at install time and shown in the DSCP Policies
  tab, in the `dscp-validate.sh` report header and in the system log at startup
- Optional **CAKE multi-queue (cake_mq)** support for multi-core hardware
- Dual-mode ingress pipeline:
  - **ctinfo ON** → postrouting rules + kernel ctinfo restore (recommended, required for download)
  - **ctinfo OFF** → prerouting rules, upload classification only
- nftables-based DSCP marking (IPv4 / IPv6)
- Separate **UDP and TCP priority classification**
- **Big HTTPS auto-downgrade** (> 1000 bytes → Bulk DSCP)
- Optional **web browsing traffic classification** (CS0-only, non-destructive)
- Optional **bulk traffic classification**
- Browsing conditioned on CS0 — never overwrites existing DSCP marks
- IPv4 and IPv6 support throughout
- **Tier-aware DSCP dropdowns** — every option shows its target CAKE tier
- **Full DSCP coverage** — all standard PHBs available across dropdowns,
  including LEPHB (RFC8622) for modern scavenger traffic
- Automatic SQM lifecycle integration (start/stop/restart)
- Clean nftables setup and teardown hooks
- Automatic dependency installation using **opkg** or **apk**
- Robust installer with disk space check, WAN auto-detection, dry-run mode
- **One-click conntrack flush** for the priority device (LuCI)
- **Diagnostic tool** with full pipeline validation report

---

## DSCP processing pipeline

### ctinfo ON (recommended)

```
nftables postrouting
  → DSCP mark (upload + download)
  → Store DSCP into conntrack mark

tc ingress (ctinfo)
  → Restore DSCP from conntrack mark on download

CAKE diffserv classification
```

### ctinfo OFF

```
nftables prerouting
  → DSCP mark (upload only)

nftables postrouting
  → Store conntrack mark only

tc ingress (simple redirect — runs before prerouting)
  → CAKE sees download traffic with the DSCP it arrived with
```
> Not recommended. Download traffic is redirected to the IFB before
> nftables prerouting runs, so no rule can classify it. Use ctinfo ON
> in every topology, including double NAT.

---

## DSCP Connections (LuCI)

This project also installs a **real-time DSCP Connections view** in LuCI.

### Features
- Live conntrack-based connection monitoring
- IPv4 and IPv6 visibility
- Source / Destination IP + Port (with full IPv6 tooltip)
- DSCP class decoding (CS0–CS7, AFxx, EF, VA, LE) coloured by CAKE tin, as
  mapped by `diffserv4` — the mode shipped in `sqm.config`:
  - 🔴 Red — Voice tin (CS4, CS5, CS6, CS7, EF, VA)
  - 🔵 Teal — Video tin (CS2, CS3, AF2x, AF3x, AF4x)
  - 🟡 Gold — Best Effort tin (CS0, AF1x, anything unlisted)
  - ⚪ Grey — Bulk tin (CS1, LE)

  On `diffserv3` or `diffserv8` these colours no longer match the tins.
- Real-time PPS / BPS statistics with moving average
- **Adaptive polling** — adjusts interval (1–10s) based on router load
- **Pause / Resume** button to freeze the view for analysis
- **Connection counter** with filter display (`X / Y total`)
- Multi-term filter with AND logic (e.g. `192.168.1.100 udp ef`)
- Column sorting
- Zoom levels (50%–100%)
- **Flush Conntrack button** — clears active conntrack entries for the
  priority device (IPv4 + IPv6) configured in DSCP Policies. Reads the IPs
  dynamically from UCI, asks for confirmation, then displays the number of
  flushed flows. Useful after changing DSCP rules to force re-classification
  of in-flight connections.

Location in LuCI: **Network → DSCP → Connections**

This view is purely observational — the only action available (Flush
Conntrack) explicitly requires user confirmation.

---

## Diagnostic tool

A standalone shell script is included to validate that all DSCP / SQM / CAKE
policies are properly active. It produces a structured 15-section report
showing rule counters, CAKE per-tin latency, conntrack health, and a final
verdict.

### Usage

```sh
# Generate a full report (with real IPs, hostname, and prefixes)
/root/dscp-validate.sh

# Save to a timestamped file (and display on screen)
/root/dscp-validate.sh | tee /root/dscp-report-$(date +%Y%m%d-%H%M).txt

# Anonymized mode — masks IPs, hostname, and IPv6 prefix
# Recommended when sharing the report on forums, GitHub issues, etc.
/root/dscp-validate.sh --anonymize | tee /tmp/report-public.txt
```

### What the report includes

1. Detected WAN and IFB interfaces
2. Full UCI SQM configuration snapshot
3. nftables `sqm_dscp` table status and rule count (depends on enabled options)
4. Priority UDP rule counters (per IPv4/IPv6 × upload/download)
5. Priority TCP rule counters
6. Bulk TCP/UDP rule counters
7. Big HTTPS auto-downgrade counters
8. Browsing classification counters
9. Conntrack ctmark storage stats
10. CAKE qdisc summary (upload + download)
11. CAKE per-tin latency (Bulk / Best Effort / Video / Voice)
12. Total bytes shaped and packets dropped
13. Active conntrack entries for the priority device
14. ctinfo / kernel module status
15. Quick health check verdict (gaming detected, web traffic classified)

### When to use it

- After installation, to confirm everything is working
- After modifying DSCP rules, to verify the new behaviour
- When asking for support on forums or GitHub issues (use `--anonymize`)
- For periodic health checks on long-running setups

---

## Installation

### Package manager compatibility

The installer automatically detects the package manager:

- **OpenWrt ≤ 24.x** → uses `opkg`
- **OpenWrt ≥ 25.x** → uses `apk`

### One-command install

```sh
cd /tmp && \
uclient-fetch -O - https://github.com/Segalmen/openwrt-custom/archive/refs/tags/v1.7.0.tar.gz | tar xz && \
cd openwrt-custom-* && \
sh install.sh
```

### Installer options

```sh
sh install.sh --dry-run   # Show what would be done without making changes
sh install.sh --force     # Overwrite existing SQM config without confirmation
```

### The installer will

- Check disk space and verify source files
- Install required packages — critical kmods (CAKE, IFB, ctinfo, nftables, ...)
  abort the install on failure; non-critical packages warn and continue.
- Copy all files to the correct locations
- Back up existing `sqm.js` and `sqm.config` as `.orig` (skipped if the
  existing file is already the custom version), and back up the active
  `/etc/config/sqm` as `sqm.bak-<date>-<time>` on every overwrite.
- Auto-detect WAN interface
- Pre-configure SQM via UCI (skipped if you keep your existing config —
  you'll need to select `Seg_Layer_Cake.qos` manually in LuCI).
- Restart required services
- Install the diagnostic tool to `/root/dscp-validate.sh`

### Upgrading from an earlier version

Running `sh install.sh` on a system that already has an earlier version
installed behaves as follows.

**Code files are replaced unconditionally** — this is the point of the
upgrade. The following files are overwritten without prompting:

- `Seg_Layer_Cake.qos` (SQM script)
- `sqm.js` (custom LuCI SQM view)
- `luci.dscp` (rpcd backend)
- LuCI menu / ACL JSON files
- `dscp-validate.sh` (diagnostic tool)

**Your configuration in `/etc/config/sqm` is preserved by default** — the
installer prompts you before touching it:

| Answer | `/etc/config/sqm` | UCI pre-config (interface, script, enabled) |
|--------|-------------------|---------------------------------------------|
| **Y** (overwrite) | replaced with shipped defaults | applied automatically |
| **N** (keep)      | preserved as-is | **skipped** — select `Seg_Layer_Cake.qos` manually in LuCI |
| `--force` flag    | replaced unconditionally (no prompt) | applied automatically |

Existing UCI configurations remain fully compatible across versions —
the tier-aware dropdowns display your existing DSCP values correctly
regardless of which choice you make.

**Backup behavior** — two distinct backups protect your SQM config.

`/etc/config/sqm.orig` and `sqm.js.orig` are written **once**, when no
`.orig` exists yet. They hold your setup from before any install and are
what `uninstall.sh` restores. The backup is **skipped if the existing file
is already the custom version** (byte-identical to what we ship), so a
re-install never clobbers a real `.orig` with a copy of the custom file.

`/etc/config/sqm.bak-<date>-<time>` is written on **every** overwrite of the
active config, unless that exact config is already saved — as `.orig`, or as
the most recent `sqm.bak-`. Updating an install therefore keeps your
customised bandwidth, ports and priority addresses in a dated file next to
the config. These files are never removed automatically, not even by
`uninstall.sh` — delete them yourself once you no longer need them.

---

## Post-installation steps (IMPORTANT)

After installation, configure SQM in LuCI:

1. Go to **Network → SQM QoS**
2. Configure:
   - Interface (WAN) — verify auto-detected value
   - Download / Upload bandwidth
   - Link layer adaptation / overhead
3. Go to the **DSCP Policies** tab:
   - Enter your priority device IPv4/IPv6 addresses
   - Enable and configure UDP/TCP priority, bulk, browsing
   - See the [DSCP Quick Reference](#dscp-quick-reference) section above
     for guidance on choosing values
4. Click **Save & Apply**

⚠️ The installer does not set bandwidth or overhead values automatically.

DSCP policy logic becomes operational only when:
- SQM is enabled in *Basic Settings*
- **Seg_Layer_Cake.qos** is selected as the active SQM script

### DSCP Connections

After installation, go to **Network → DSCP → Connections** for the
real-time connection view. No configuration required — read-only,
with an optional **Flush Conntrack** button.

### Validate the install

```sh
/root/dscp-validate.sh
```

Look at the bottom of the report for the health check verdict:
- ✓ Priority UDP IPv4 has matched ... packets — gaming traffic is classified
- ✓ Bulk TCP has matched ... packets — web traffic is classified

---

## Files installed

| Component | Destination |
|-----------|-------------|
| `Seg_Layer_Cake.qos` | `/usr/lib/sqm/` |
| `sqm.config` | `/etc/config/sqm` |
| `sqm.js` (custom SQM LuCI view) | `/www/luci-static/resources/view/network/` |
| `connections.js` (DSCP Connections view) | `/www/luci-static/resources/view/dscp/` |
| `luci.dscp` (rpcd backend) | `/usr/libexec/rpcd/` |
| LuCI menu entry | `/usr/share/luci/menu.d/` |
| LuCI ACL rules | `/usr/share/rpcd/acl.d/` |
| `dscp-validate.sh` (diagnostic tool) | `/root/` |

---

## Uninstallation

Simply run:

```sh
sh uninstall.sh
```

The uninstaller will:
1. Stop SQM and remove nftables rules cleanly
2. Restore the original `sqm.js` from backup
3. Remove `Seg_Layer_Cake.qos`
4. Restore the original `sqm.config` from backup
5. Remove the DSCP Connections view and rpcd backend
6. Remove the diagnostic tool from `/root/`
7. Restart LuCI services

### Uninstaller options

```sh
sh uninstall.sh --dry-run      # Show what would be done without changes
sh uninstall.sh --force        # No interactive confirmation
sh uninstall.sh --keep-config  # Keep /etc/config/sqm as-is
```

---

## Notes

- Default qdisc opts no longer hardcode `rtt 1ms`. CAKE auto-tunes RTT
  (≈100 ms), which is correct for most home setups. If you have a very
  short LAN (e.g. gaming-only setup with sub-millisecond local paths),
  you can re-add `rtt 1ms` to `iqdisc_opts` / `eqdisc_opts` via LuCI's
  advanced qdisc options.
- DSCP policy logic does not require manual DiffServ configuration in LuCI.
  CAKE automatically operates in DiffServ mode when using `Seg_Layer_Cake.qos`.
- This project does not override existing firewall rules.
- nftables rules are created and removed dynamically on SQM start/stop.
- The nftables table `sqm_dscp` is fully managed by the SQM lifecycle.
- Original files are backed up as `.orig` during installation, and the
  active SQM config as `sqm.bak-<date>-<time>` on every overwrite.
- Compatible with Lua 5.1 (OpenWrt rpcd environment).
- The Flush Conntrack button reads the priority device IPs from UCI at
  page load — change the IPs in DSCP Policies and reload the page to use
  the new values.
- The diagnostic tool runs read-only operations only (nft list, tc -s,
  uci -q get) — it never modifies the system.
- Designed for users familiar with OpenWrt and SQM.
