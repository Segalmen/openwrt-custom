# DSCP Policies for SQM – OpenWrt

Custom SQM setup for OpenWrt using **CAKE**, **DSCP**, and **nftables**,
designed to improve latency-sensitive traffic prioritization.

Works for VoIP, video conferencing, remote desktop, consoles, streaming — any
real-time application that benefits from low and stable latency.

This project provides:

- A custom SQM script (`Seg_Layer_Cake.qos`)
- nftables-based DSCP marking (IPv4 / IPv6)
- Traffic classification with priority rules and bulk downgrade
- Download classification through kernel `ctinfo` DSCP restore
- Automated installer with dependency handling
- Optional size tiers on priority traffic and network-wide service classes
  (DNS, SSH, video conferencing, live video, VoIP)
- LuCI tabs under **Network → SQM QoS**: SQM, Connections, Server Rules,
  Server History, Captures, Lag Simulator
- One-click conntrack flush button for the priority devices
- Server Rules: block remote server ranges, or name them as labels
- Packet captures (tcpdump) from LuCI, downloaded through the web interface
- Lag Simulator: added latency, jitter and loss per device (netem)
- Diagnostic tool to validate the full DSCP / SQM / CAKE pipeline
- **Tier-aware DSCP dropdowns** with full coverage of all CAKE tiers
- Optional **Bootstrap Dark Blue** LuCI theme (installed, not activated)

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

The classification rules form a cascade. They are evaluated in the order
below, and each one only sees what the previous ones left alone: a packet
already marked is not re-marked, because the Services and Browsing rules match
CS0 only.

| # | Rule | What it matches | Typical result |
|---|------|-----------------|----------------|
| 1 | Priority UDP | priority devices, Priority UDP ports | Voice tier |
| 2 | Priority TCP | priority devices, Priority TCP ports | your choice |
| 2b | Size tiers (optional) | rules 1 and 2, by packet size | medium / Bulk tier |
| 2c | Services (optional) | every device, service ports, still CS0 | per service |
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
configurable DSCP value. Suitable for VoIP, video calls and other real-time
apps.

The configured ports are matched on both sides of each flow: the local
port (consoles and clients with a fixed local port) and the remote server
port (clients that use a random local port, common on PC).

### Priority TCP Classification
Mark TCP traffic from/to priority devices (optional), with the same
local/remote port matching as Priority UDP.
Useful for remote desktop, video conferencing signalling, etc.

### Size tiers on priority traffic (optional, off by default)
Refines rules 1 and 2 by packet size. UDP: packets up to the small threshold
(default 160 bytes) keep the class set above, medium packets (up to 1300
bytes) get the medium class (default `CS4`), larger ones go to the Bulk class.
TCP: packets above the small threshold go to the Bulk class. A large packet
on a priority port is a transfer (update, download inside the application),
not real-time traffic.

### Network-wide services (optional, off by default)
Classes for every device on the network, each one marking only traffic that
is still CS0, so a mark set by an application or by the priority rules is
kept:

- ICMP (ping) — not marked by default, `CS3` or `CS5` selectable
- DNS and NTP → `CS3` (UDP 53, 853, 5353, 123; TCP 53, 853)
- SSH → `AF41` (TCP 22)
- Video conferencing → `AF41` (Teams, Zoom, Webex: UDP 3478-3481,
  8801-8810, 9000, 50000-50059; TCP 5004, 5349, 8801-8802)
- Live video streaming → `AF41` (RTMP, TCP 1935-1936, 2396, 2935)
- VoIP telephony → `EF` (SIP 5060-5061 UDP/TCP; IPsec/IKE 500 and 4500 used
  by Wi-Fi calling)

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

### Browsing Classification
Optionally classify web browsing traffic (HTTP/HTTPS/QUIC) with a specific
DSCP value. Only marks CS0 traffic — does not overwrite existing marks, so
with Bulk enabled it applies to every device except the priority ones.

### Common ports per use case

The Priority device and port lists ship empty. Add the devices and ports of
your own latency-sensitive uses; the table below gives common examples.

| Use case | Ports |
|----------|-------|
| Consoles and PC clients | UDP `3074`, `3478-3480`, `3659`, often somewhere in `10000-45000` |
| Remote desktop (RDP) | TCP `3389` |
| WireGuard | UDP `51820` |
| OpenVPN | UDP `1194` (can fall back to TCP, or to 443) |
| IPsec / IKEv2 | UDP `500` (key exchange), `4500` (NAT traversal) |
| Teams, Zoom media | UDP `3478-3481`, `50000-50059` |

Two things worth knowing. A VPN tunnel is a **single flow** for CAKE, so
everything inside it — a video call and a file download alike — gets the class
you set for it. And Teams screen sharing uses `3481`: include it when you
list the Teams ports.

---

## DSCP Quick Reference

Each dropdown in the **DSCP Policies** tab now displays the target CAKE
tier directly in the option label, so you can choose values without
memorizing the diffserv4 mapping.

### CAKE diffserv4 tier mapping

| CAKE Tier | DSCP values | Typical use |
|-----------|-------------|-------------|
| **Voice** (highest) | CS4, CS5, CS6, CS7, EF, VA | Real-time interactive, VoIP, network control |
| **Video** | CS2, CS3, AF2x, AF3x, AF4x | Multimedia, conferencing, streaming, OAM |
| **Best Effort** | CS0, AF1x | Default traffic |
| **Bulk** (lowest) | CS1, LEPHB | Background, scavenger, bulk downloads |

Source: the `diffserv4` table in the Linux kernel (`net/sched/sch_cake.c`).

### Choosing the right value for browsing

The `browsing_dscp` dropdown spans three tiers (Video, Best Effort, Bulk),
with three recommended profiles:

- **Real-time-first setup** → use `AF11` (browsing stays in Best Effort,
  below the Video and Voice tiers)
- **Browsing-priority setup** → use `AF21` (default, boosts web into the
  Video tier, above Best Effort and Bulk)
- **Strong deprioritization** → use `CS1` or `LEPHB` (browsing yields
  to everything in Bulk tier)

### Recommended values per dropdown

| Dropdown | Recommended | Rationale |
|----------|-------------|-----------|
| Priority UDP | `EF` (default) | Voice tier on diffserv3, diffserv4 and diffserv8; Wi-Fi AC_VO |
| Priority TCP | `CS0` (default) | Login and control TCP shouldn't compete with real-time UDP |
| Browsing | `AF21` (default) or `AF11` (real-time-first) | See profiles above |
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
- `luci-lua-runtime` – Lua runtime used by the rpcd backend
- `kmod-sched-flower`, `kmod-netem` – Lag Simulator (per-device netem)
- `tcpdump` – packet captures
- `ca-bundle` – HTTPS for the CIDR suggestion (RIPEstat); a TLS backend for
  `uclient-fetch` (`libustream-mbedtls`) is added only when none is present

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
- **One-click conntrack flush** for the priority devices (LuCI)
- Optional **size tiers** on priority traffic and **network-wide services**
- **Server Rules**, **Server History**, **Captures** and **Lag Simulator**
  tabs (see below)
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

## LuCI tabs (Network → SQM QoS)

The installer turns **Network → SQM QoS** into a tabbed page. The first tab,
**SQM**, is the SQM page itself with its four sub-tabs (Basic Settings, Queue
Discipline, Link Layer Adaptation, DSCP Policies). The menu change lives in its
own file (`luci-app-sqm_dscp.json`); `luci-app-sqm` itself is not modified, and
uninstalling gives it its original menu back.

### Connections

A **real-time DSCP Connections view**.

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
- Zoom levels (50%–100%), relative to the theme's text size
- **Flush Conntrack button** — clears active conntrack entries for the
  priority devices (IPv4 + IPv6) configured in DSCP Policies. Reads the IPs
  dynamically from UCI, asks for confirmation, then displays the number of
  flushed flows. Useful after changing DSCP rules to force re-classification
  of in-flight connections.
- Public destinations link to ipinfo.io, and show the name of the Server
  Rules entry that covers them
- Per-flow buttons:
  - **⛔ Ban / ▶ Enable** — add the server's range to Server Rules, or
    enable the rule that covers it. A new rule is always created disabled.
  - **📌 Log** (priority flows) — record the server in Server History
  - **🏷️ Label** (priority flows) — name the server's range. A new label
    is created as a disabled rule (label only, no blocking); adding the
    range to an existing active rule blocks it, and the dialog then warns
    and shows **Label and block**
  - **📷 Ports / 📷 Full / 📷 Capture** — start a tcpdump capture: the
    priority ports, all traffic with this server, or with this IP
- The suggested range is the real BGP prefix announced for the IP
  (RIPEstat), falling back to a /24 when the lookup fails. Always editable.
- Rule names accept letters, digits and `_`; spaces typed become `_`.

### Server Rules

Remote IPv4 ranges grouped in named rules (`/etc/config/serverrules`). An
enabled rule drops traffic to and from its ranges (nftables table
`inet serverrules`); a disabled rule is a label only, shown in Connections
and Server History. **Enable blocking** turns all rules on or off at once.

- **Reload** — the table is rebuilt in a single `nft` transaction: on any
  error the previous table stays in place. Overlapping or adjacent ranges
  are merged, and the drop counters restart from zero at each reload.
- **Enable blocking** — section `global`, option `enabled`, an OpenWrt
  boolean (`0`/`off`/`false`/`no`/`disabled` = off). Blocking is on by
  default (no section, no option); a single `global` section set to off is
  enough to disable it, which removes the table. The `enabled` option of a
  rule is read the same way.
- **Range checks** — only IPv4 CIDR is accepted (`a.b.c.d/p` or a single
  address; `a-b` ranges are no longer accepted). Private/reserved ranges,
  prefixes shorter than `/8` and malformed entries are refused in the
  pages; in a hand-edited config the script skips and logs them:
  `logread -e serverrules`.

### Server History

Servers recorded with **📌 Log**, with the rule that covers them today, the
port, the DSCP class and how many times they were logged
(`/etc/sqm-dscp/server-history.jsonl`).

### Captures

Captures started from Connections, stored in RAM (`/tmp/dscp-captures`),
never served publicly: download goes through the authenticated LuCI session.
At most 300 seconds per capture, one capture per interface, four at once.
Capture on `br-lan` to see the client IP, on the WAN device to see the DSCP
marks as they leave the router.

### Lag Simulator

Adds latency, jitter and packet loss to selected devices, matched by MAC
address, with netem (`/etc/config/lagsim`, off by default). It only makes a
connection worse, never better, and does not touch the SQM qdiscs. *Both*
splits the delay and jitter between the two directions, so a ping shows the
value you set; loss applies in each direction, so a round trip loses about
twice the value you set. When the standalone `lagsim`
package is installed, its files are used and left in place.

These pages only act on explicit clicks; Ban, Enable, Flush Conntrack and
Clear all ask for confirmation.

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

# Save to a timestamped file in RAM (and display on screen)
/root/dscp-validate.sh | tee /tmp/dscp-report-$(date +%Y%m%d-%H%M).txt

# Anonymized mode — masks IPs, hostname, and IPv6 prefix
# Recommended when sharing the report on forums, GitHub issues, etc.
/root/dscp-validate.sh --anonymize | tee /tmp/report-public.txt
```

Reports are written to `/tmp` (RAM): nothing is written to flash, and they
are gone after a reboot. To copy one to your computer, run this on the
computer — `scp` is built into Windows 10/11, macOS and Linux:

```sh
scp -O root@192.168.1.1:/tmp/report-public.txt .
```

Replace `192.168.1.1` with your router's address. `-O` makes recent
OpenSSH clients use the classic SCP protocol, the one OpenWrt's Dropbear
server speaks (it has no SFTP server by default). If your `scp` reports
`-O` as an unknown option, it is an older client: run the command without
it.

### What the report includes

1. Detected WAN and IFB interfaces
2. Full UCI SQM configuration snapshot
3. nftables `sqm_dscp` table status and rule count (depends on enabled options)
4. Priority UDP rule counters (per IPv4/IPv6 × upload/download)
5. Priority TCP rule counters
6. Size tier counters (when enabled)
7. Network-wide service counters (when enabled)
8. Bulk TCP rule counters
9. Bulk UDP rule counters
10. Big HTTPS auto-downgrade counters
11. Browsing classification counters
12. Conntrack ctmark storage stats
13. CAKE qdisc summary (upload + download)
14. CAKE per-tin latency (Bulk / Best Effort / Video / Voice)
15. Total bytes shaped and packets dropped
16. Active conntrack entries for each priority device
17. ctinfo status: kernel module, UCI option, filter on the WAN ingress
18. Server Rules: ranges loaded, packets dropped, rules configured
19. Lag Simulator status

Then a quick health check verdict (priority traffic matched, web traffic
deprioritized).

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
uclient-fetch -O - https://github.com/Segalmen/openwrt-custom/archive/refs/tags/v2.0.0.tar.gz | tar xz && \
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
- Install Server Rules, the Lag Simulator and the Bootstrap Dark Blue theme
  (registered, not activated) — existing `/etc/config/serverrules` and
  `/etc/config/lagsim` are kept
- Restart required services
- Install the diagnostic tool to `/root/dscp-validate.sh`

### Upgrading from an earlier version

Running `sh install.sh` on a system that already has an earlier version
installed behaves as follows.

**Code files are replaced unconditionally** — this is the point of the
upgrade. The following files are overwritten without prompting:

- `Seg_Layer_Cake.qos` (SQM script)
- `sqm.js` (custom LuCI SQM view)
- `luci.dscp` (rpcd backend) and the LuCI tab pages
- LuCI menu / ACL JSON files (the 1.x "Network → DSCP" entry is removed)
- Server Rules and Lag Simulator scripts
- `dscp-validate.sh` (diagnostic tool)

**Your configuration in `/etc/config/sqm` is preserved by default** — the
installer prompts you before touching it:

| Answer | `/etc/config/sqm` | UCI pre-config (interface, script, enabled) |
|--------|-------------------|---------------------------------------------|
| **Y** (overwrite) | replaced with shipped defaults | applied automatically |
| **N** (keep)      | preserved as-is | **skipped** — select `Seg_Layer_Cake.qos` manually in LuCI |
| `--force` flag    | replaced unconditionally (no prompt) | applied automatically |

The device, port and bulk options renamed in 2.0.0 are migrated
automatically to their new names (`priority_ip`, `priority_ip6`,
`priority_udp_ports`, `priority_tcp_ports`, `bulk_enable`, `bulk_dscp`), on
every SQM queue. When you answer **Y**, the priority devices and ports of the
replaced config are kept, like the bandwidth.

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

After installing or updating, force-reload LuCI with Ctrl+F5. If some pages
still look old, the browser is keeping cached files: open the developer tools
(F12), tick "Disable cache" in the Network tab and reload the page, or log out
of LuCI and log back in.

⚠️ The installer does not set bandwidth or overhead values automatically.

DSCP policy logic becomes operational only when:
- SQM is enabled in *Basic Settings*
- **Seg_Layer_Cake.qos** is selected as the active SQM script

### SQM QoS tabs

After installation, **Network → SQM QoS** shows the Connections, Server
Rules, Server History, Captures and Lag Simulator tabs next to SQM. No
configuration required; the Lag Simulator stays off until you enable it.

### Validate the install

```sh
/root/dscp-validate.sh
```

Look at the bottom of the report for the health check verdict:
- ✓ Priority UDP IPv4 has matched ... packets
- ✓ Bulk / Big HTTPS has matched ... packets (deprioritization active)

---

## Files installed

| Component | Destination |
|-----------|-------------|
| `Seg_Layer_Cake.qos` | `/usr/lib/sqm/` |
| `sqm.config` | `/etc/config/sqm` |
| `sqm.js` (custom SQM LuCI view) | `/www/luci-static/resources/view/network/` |
| Tab pages (`connections.js`, `serverrules.js`, `history.js`, `captures.js`, `lagsim.js`) | `/www/luci-static/resources/view/dscp/` |
| `luci.dscp` (rpcd backend) | `/usr/libexec/rpcd/` |
| LuCI menu (`luci-app-sqm_dscp.json`) | `/usr/share/luci/menu.d/` |
| LuCI ACL rules (`luci-app-dscp.json`) | `/usr/share/rpcd/acl.d/` |
| Server Rules (`serverrules.sh`, init, config) | `/usr/libexec/serverrules/`, `/etc/init.d/serverrules`, `/etc/config/serverrules` |
| Lag Simulator (`lagsim`, init, hotplug, config, netem tables) | `/usr/sbin/`, `/etc/init.d/`, `/etc/hotplug.d/net/`, `/etc/config/`, `/usr/lib/tc/` |
| Bootstrap Dark Blue theme | `/www/luci-static/bootstrap-darkblue/`, `/usr/share/ucode/luci/template/themes/bootstrap-darkblue/` |
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
5. Stop Server Rules and remove its table, script and config
6. Stop the Lag Simulator and remove its files (kept when the standalone
   `lagsim` package is installed)
7. Remove the LuCI tabs, the rpcd backend, the server history, the captures
   and the Bootstrap Dark Blue theme (LuCI goes back to Bootstrap if it was
   active), plus the empty directories the installer created
8. Remove the diagnostic tool from `/root/`
9. Restart LuCI services

### Uninstaller options

```sh
sh uninstall.sh --dry-run      # Show what would be done without changes
sh uninstall.sh --force        # No interactive confirmation
sh uninstall.sh --keep-config  # Keep /etc/config/sqm, serverrules, lagsim
                               # and the server history as-is
```

---

## Notes

- Default qdisc opts no longer hardcode `rtt 1ms`. CAKE auto-tunes RTT
  (≈100 ms), which is correct for most home setups. If you have a very
  short LAN (e.g. a setup with sub-millisecond local paths only),
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

---

## License and credits

openwrt-custom is free software, released under the
[GNU General Public License v3.0 or later](LICENSE).

It builds on the work of others:

- The Connections view (`connections/view/connections.js`) and its rpcd
  backend (`connections/rpcd/luci.dscp`) are derived from
  [luci-app-qosmate](https://github.com/hudra0/luci-app-qosmate) by hudra0,
  GPL-3.0-or-later.
- The Bootstrap Dark Blue theme (`theme/darkblue/`) is a variant of the
  Bootstrap theme of [LuCI](https://github.com/openwrt/luci), Apache-2.0; the
  original copyright notices are kept in its files.
- `Seg_Layer_Cake.qos` runs inside
  [sqm-scripts](https://github.com/tohojo/sqm-scripts) (GPL-2.0) and uses its
  framework functions.
- The Lag Simulator (`lagsim/`) is GPL-2.0-or-later.
