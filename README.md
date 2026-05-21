# DSCP Policies for SQM – OpenWrt

Custom SQM setup for OpenWrt using **CAKE**, **DSCP**, and **nftables**,
designed to improve latency-sensitive traffic prioritization.

Works great for gaming, VoIP, video conferencing, streaming — any real-time
application that benefits from low and stable latency.

This project provides:

- A custom SQM script (`Seg_Layer_Cake.qos`)
- nftables-based DSCP marking (IPv4 / IPv6)
- Smart traffic classification with micro-packet boost and bulk downgrade
- Dual-mode ingress pipeline (ctinfo kernel or nftables prerouting)
- Automated installer with dependency handling
- LuCI custom view with real-time DSCP Connections monitor
- One-click conntrack flush button for the priority device
- Diagnostic tool to validate the full DSCP / SQM / CAKE pipeline
- **Tier-aware DSCP dropdowns** with full coverage of all CAKE tiers

---

## DSCP Policies (LuCI)

The custom SQM interface adds a **DSCP Policies** tab in LuCI.

### Multi-Queue Support
Enable `cake_mq` for hardware with multiple CPU cores or NIC queues.
Recommended on routers with 2+ CPU cores for better throughput distribution.

### DSCP Restore via conntrack (ctinfo)
Store DSCP into conntrack mark and restore it on ingress using the `ctinfo`
kernel module. When enabled, all classification rules run in postrouting
and the kernel handles ingress restore efficiently.
When disabled, classification rules move to prerouting, marking download
traffic **before** IFB redirection so CAKE sees the correct DSCP.

> **Double NAT / downstream router use case:**
> If this router sits behind another NAT device (e.g. a secondary
> router or access point), disable ctinfo. In this topology, ingress
> reply packets arrive with the upstream WAN IP as destination —
> not the LAN client IP — making postrouting IP-based rules ineffective.
> With ctinfo OFF, prerouting rules fire before NAT translation,
> where port-based classification (browsing, bulk) works correctly
> across all LAN clients regardless of the NAT layer.

### Priority UDP Classification
Mark UDP traffic from/to priority devices on the specified ports with a
configurable DSCP value. Suitable for gaming, VoIP, and real-time apps.

### Priority TCP Classification
Mark TCP traffic from/to priority devices (optional).
Useful for remote desktop, video conferencing signalling, etc.

### Micro-Packet Priority
Automatically boost very small packets (default: < 60 bytes) from priority
devices to the highest CAKE tin. Ideal for gaming ACKs, VoIP signalling,
TCP keepalives, STUN/ICE probes, and real-time control packets.
Packets between the micro and small thresholds (default: 60–200 bytes)
receive the Priority UDP DSCP value.

Both thresholds are now **configurable** in DSCP Policies:
- `micro_pkt_threshold` — default: 60 bytes, range 40–200
- `small_pkt_threshold` — default: 200 bytes, range 100–500

The micro-packet DSCP value is also configurable (CS6, CS7, EF, VA).

### Browsing Classification
Optionally classify web browsing traffic (HTTP/HTTPS/QUIC) with a specific
DSCP value. Only marks CS0 traffic — does not overwrite existing marks.

### Bulk Traffic Classification
Mark large downloads (HTTP/HTTPS) from priority devices with a lower DSCP
value so they do not compete with real-time traffic.

### Big HTTPS Auto-Downgrade
Automatically downgrade large HTTPS packets (> 1000 bytes) from priority
devices to the Bulk DSCP value. Prevents big downloads from stealing
bandwidth from real-time traffic, even when using port 443.

---

## DSCP Quick Reference

Each dropdown in the **DSCP Policies** tab now displays the target CAKE
tier directly in the option label, so you can choose values without
memorizing the diffserv4 mapping.

### CAKE diffserv4 tier mapping

| CAKE Tier | DSCP values | Typical use |
|-----------|-------------|-------------|
| **Voice** (highest) | CS6, CS7, EF, VA | Network control, VoIP, gaming micro-packets |
| **Video** | CS4, CS5, AF2x, AF3x, AF4x | Real-time interactive, multimedia, signaling |
| **Best Effort** | CS0, CS2, CS3 | Default web, OAM, broadcast |
| **Bulk** (lowest) | CS1, AF1x, LEPHB | Background, scavenger, bulk downloads |

### Choosing the right value for browsing

The `browsing_dscp` dropdown now spans all four tiers, with three
recommended profiles:

- **Gaming-first setup** → use `CS3` (browsing in Best Effort, keeps
  Video tier reserved for real-time gaming)
- **Browsing-priority setup** → use `AF21` (default, boosts web above
  bulk downloads in Video tier)
- **Strong deprioritization** → use `CS1` or `LEPHB` (browsing yields
  to everything in Bulk tier)

### Recommended values per dropdown

| Dropdown | Recommended | Rationale |
|----------|-------------|-----------|
| Priority UDP | `CS4` | Isolates gaming in Video tier |
| Priority TCP | `CS0` | Gaming TCP (auth, login) shouldn't compete with real-time UDP |
| Micro-packet | `CS6` | Standard network control class |
| Browsing | `AF21` (default) or `CS3` (gaming-first) | See profiles above |
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
- `conntrack-tools` – required for the Flush Conntrack button

### Permissions
- Root access on the router is required
- `rpcd` and `uhttpd` services must be running

---

## Features

- CAKE queue discipline for upload and download
- Optional **CAKE multi-queue (cake_mq)** support for multi-core hardware
- Dual-mode ingress pipeline:
  - **ctinfo ON** → postrouting rules + kernel ctinfo restore (efficient)
  - **ctinfo OFF** → prerouting rules mark download before IFB redirect
- nftables-based DSCP marking (IPv4 / IPv6)
- Separate **UDP and TCP priority classification**
- **Configurable Micro-packet priority** (default: < 60 bytes → CS6/CS7/EF/VA)
- **Configurable Small packet boost** (default: 60–200 bytes → Priority DSCP)
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
  → DSCP mark (download — before IFB redirect)

nftables postrouting
  → Store conntrack mark only

tc ingress (simple redirect)
  → CAKE diffserv classification
```
> Recommended when the router operates behind another NAT device.
> Port-based rules (browsing, bulk) remain fully functional.
> IP-based priority rules (gaming_ip) are not effective in this mode
> for ingress traffic due to NAT address rewriting.
Both modes result in correct CAKE DiffServ behaviour for all traffic directions.

---

## DSCP Connections (LuCI)

This project also installs a **real-time DSCP Connections view** in LuCI.

### Features
- Live conntrack-based connection monitoring
- IPv4 and IPv6 visibility
- Source / Destination IP + Port (with full IPv6 tooltip)
- DSCP class decoding (CS0–CS7, AFxx, EF) with colour coding:
  - 🔴 Red — high priority (CS5, CS6, CS7, EF)
  - 🔵 Teal — medium priority (CS3, CS4, AF3x, AF4x)
  - 🟡 Gold — default / low priority (CS0, CS1, CS2)
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
policies are properly active. It produces a structured 19-section report
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
3. nftables `sqm_dscp` table status and rule count (42 rules expected)
4. Priority UDP rule counters (per IPv4/IPv6 × upload/download)
5. Priority TCP rule counters
6. Bulk TCP/UDP rule counters
7. Big HTTPS auto-downgrade counters
8. MicroPkt and SmallPkt UDP/TCP counters
9. Browsing classification counters
10. Conntrack ctmark storage stats
11. CAKE qdisc summary (upload + download)
12. CAKE per-tin latency (Bulk / Best Effort / Video / Voice)
13. Total bytes shaped and packets dropped
14. Active conntrack entries for the priority device
15. ctinfo / kernel module status
16. Quick health check verdict (gaming detected, web traffic classified)

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
uclient-fetch -O - https://github.com/Segalmen/openwrt-custom/archive/refs/tags/v1.6.1.tar.gz | tar xz && \
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
  existing file is already the custom version).
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

**Backup behavior** — the installer creates `.orig` backups of
`/etc/config/sqm` and `sqm.js` when an `.orig` is missing. The backup
is **skipped if the existing file is already the custom version**
(byte-identical to what we ship). This prevents a re-install from
clobbering a real `.orig` (your original from before any install) with
a copy of the custom file.

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
   - Enable and configure UDP/TCP priority, micro-packets, bulk, browsing
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
- Original files are backed up as `.orig` during installation.
- Compatible with Lua 5.1 (OpenWrt rpcd environment).
- The Flush Conntrack button reads the priority device IPs from UCI at
  page load — change the IPs in DSCP Policies and reload the page to use
  the new values.
- The diagnostic tool runs read-only operations only (nft list, tc -s,
  uci -q get) — it never modifies the system.
- Designed for users familiar with OpenWrt and SQM.
