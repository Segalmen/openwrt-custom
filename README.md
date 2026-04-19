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

### Priority UDP Classification
Mark UDP traffic from/to priority devices on the specified ports with a
configurable DSCP value. Suitable for gaming, VoIP, and real-time apps.

### Priority TCP Classification
Mark TCP traffic from/to priority devices (optional).
Useful for remote desktop, video conferencing signalling, etc.

### Micro-Packet Priority
Automatically boost very small packets (< 150 bytes) from priority devices
to the highest CAKE tin. Ideal for gaming ACKs, VoIP signalling, and
real-time control packets.
Packets between 150–300 bytes receive the Priority UDP DSCP value.
The micro-packet DSCP value is configurable (CS6, CS7, or EF).

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

All required dependencies are handled automatically by the installer.

---

## Requirements

### Supported system
- OpenWrt **24.10 or newer**
- Earlier versions may work but are **not supported nor tested**
- OpenWrt **25.x** (apk-based) fully supported

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
- **Micro-packet priority** (< 150 bytes → CS6/CS7/EF)
- **Small packet boost** (150–300 bytes → Priority DSCP)
- **Big HTTPS auto-downgrade** (> 1000 bytes → Bulk DSCP)
- Optional **web browsing traffic classification** (CS0-only, non-destructive)
- Optional **bulk traffic classification**
- Browsing conditioned on CS0 — never overwrites existing DSCP marks
- IPv4 and IPv6 support throughout
- Automatic SQM lifecycle integration (start/stop/restart)
- Clean nftables setup and teardown hooks
- Automatic dependency installation using **opkg** or **apk**
- Robust installer with disk space check, WAN auto-detection, dry-run mode

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

Location in LuCI: **Network → DSCP → Connections**

This view is purely observational — zero impact on performance.

---

## Installation

### Package manager compatibility

The installer automatically detects the package manager:

- **OpenWrt ≤ 24.x** → uses `opkg`
- **OpenWrt ≥ 25.x** → uses `apk`

### One-command install

```sh
cd /tmp && \
uclient-fetch -O - https://github.com/Segalmen/openwrt-custom/archive/refs/tags/v1.2.tar.gz | tar xz && \
cd openwrt-custom-v1.2 && \
sh install.sh
```

### Installer options

```sh
sh install.sh --dry-run   # Show what would be done without making changes
sh install.sh --force     # Overwrite existing SQM config without confirmation
```

### The installer will

- Check disk space and verify source files
- Install required packages (non-blocking — continues on failure)
- Copy all files to the correct locations
- Back up existing `sqm.js` and `sqm.config` as `.orig`
- Auto-detect WAN interface
- Pre-configure SQM via UCI
- Restart required services

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
4. Click **Save & Apply**

⚠️ The installer does not set bandwidth or overhead values automatically.

DSCP policy logic becomes operational only when:
- SQM is enabled in *Basic Settings*
- **Seg_Layer_Cake.qos** is selected as the active SQM script

### DSCP Connections

After installation, go to **Network → DSCP → Connections** for the
real-time connection view. No configuration required — read-only.

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
6. Restart LuCI services

### Uninstaller options

```sh
sh uninstall.sh --dry-run      # Show what would be done without changes
sh uninstall.sh --force        # No interactive confirmation
sh uninstall.sh --keep-config  # Keep /etc/config/sqm as-is
```

---

## Notes

- DSCP policy logic does not require manual DiffServ configuration in LuCI.
  CAKE automatically operates in DiffServ mode when using `Seg_Layer_Cake.qos`.
- This project does not override existing firewall rules.
- nftables rules are created and removed dynamically on SQM start/stop.
- The nftables table `sqm_dscp` is fully managed by the SQM lifecycle.
- Original files are backed up as `.orig` during installation.
- Compatible with Lua 5.1 (OpenWrt rpcd environment).
- Designed for users familiar with OpenWrt and SQM.
