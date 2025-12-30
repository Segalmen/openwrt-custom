# DSCP Policies for SQM (Latency-sensitive traffic) – OpenWrt

Custom SQM setup for OpenWrt using **CAKE**, **DSCP**, and **nftables**,  
designed to improve latency-sensitive traffic prioritization using DSCP.

This project provides:
- A custom SQM script (`Seg_Layer_Cake.qos`)
- nftables-based DSCP marking (IPv4 / IPv6)
- Optional DSCP policy logic for latency-sensitive and bulk traffic
- Automated installer with dependency handling
- LuCI custom view

---

All required dependencies are handled automatically by the installer.

## Requirements

### Supported system
- OpenWrt **24.10 or newer**
- Earlier versions may work but are **not supported nor tested**

### Required packages

The following packages are required for full functionality
(all are automatically installed by `install.sh`):

- `luci-app-sqm` – SQM LuCI interface
- `sqm-scripts` – SQM framework
- `kmod-sched-cake` – CAKE queue discipline
- `kmod-ifb` – IFB support (for ingress shaping)
- `kmod-sched-ctinfo` – TC ctinfo action (DSCP restore from conntrack on ingress)
- `nftables` – DSCP marking and classification
- `kmod-nft-core` – nftables kernel support
- `tc` – traffic control utilities
- `ip-full` – advanced IP tooling
- `lua` – required for rpcd backend
- `luci-lib-jsonc` – JSON handling for LuCI / rpcd

### Permissions
- Root access on the router is required
- `rpcd` and `uhttpd` services must be running

---

## Features

- CAKE queue discipline for upload and download
- DSCP restore via `ctinfo` (conntrack-based)
- nftables table `inet sqm_dscp` for DSCP handling
- IPv4 and IPv6 support
- Clean setup and cleanup hooks
- DSCP marking is applied in postrouting and restored on ingress using conntrack
- One-line installation on a fresh OpenWrt system

---

## DSCP Connections (LuCI)

This project also installs a **real-time DSCP Connections view** in LuCI.

It provides:
- Live conntrack-based connection monitoring
- IPv4 and IPv6 visibility
- Source / Destination IP + Port
- DSCP class decoding (CS0–CS7, AFxx, EF)
- Real-time PPS / BPS statistics
- Sorting and filtering
- Designed for analysis of latency-sensitive traffic

Location in LuCI:
- **Network → DSCP → Connections**

This view allows you to:
- Verify that latency-sensitive traffic is correctly marked (CS4 / EF / etc.)
- Instantly see which servers your console or PC is connected to
- Validate CAKE DiffServ behavior in real time

---

### How DSCP Connections works (technical overview)

The DSCP Connections view reads active connections directly from  
`/proc/net/nf_conntrack` via a lightweight `rpcd` backend.

DSCP values are extracted from conntrack marks and decoded in real time.  
Traffic is not intercepted, altered, or proxied — this view is purely
observational and has **zero impact on performance**.

The view is designed to:
- Validate DSCP marking correctness
- Observe real-time traffic behavior
- Identify remote servers used by games or applications


---

## Installation (one command)

Run the following command on your OpenWrt router:

```sh
cd /tmp && \
uclient-fetch -O - https://github.com/Segalmen/openwrt-custom/archive/refs/heads/main.tar.gz | tar xz && \
cd openwrt-custom-main && \
sh install.sh
```

### The installer will

- Install required packages
- Copy all files to the correct locations
- Enable the custom SQM script
- Restart required services


## Post-installation steps (IMPORTANT)


After installation, you must configure SQM settings in LuCI:

- Go to **Network → SQM QoS**
- Configure:
  - Interface (WAN)
  - Download / Upload bandwidth
  - Link layer adaptation / overhead
- Verify that the DSCP Policies section appears in LuCI after installation
- DSCP policy logic becomes operational only when:
  - SQM is enabled in *Basic Settings*
  - **Seg_Layer_Cake.qos** is selected as the active SQM script

⚠️ The installer does not set bandwidth or overhead values automatically.

### DSCP Connections (LuCI)

DSCP Connections is a later addition to the project, focused on real-time visibility and validation rather than traffic shaping.

After installation, a **DSCP Connections** menu is available in LuCI:

- Go to **Network → DSCP → Connections**
- This view is read-only and does not require any configuration
- It works independently from SQM and DSCP policy logic

You can use it to:
- Verify DSCP markings applied to live traffic
- Observe real-time connections (IPv4 / IPv6)
- Identify remote servers used by applications or services
- Validate CAKE DiffServ behavior

No bandwidth, interface, or firewall configuration is required.


## Files installed

| Component | Destination |
|---------|-------------|
| Seg_Layer_Cake.qos | /usr/lib/sqm/ |
| sqm.config | /etc/config/sqm |
| sqm.js (custom SQM LuCI view) | /www/luci-static/resources/view/network/ |
| DSCP Connections view | /www/luci-static/resources/view/dscp/ |
| rpcd backend (luci.dscp) | /usr/libexec/rpcd/ |
| LuCI menu entry | /usr/share/luci/menu.d/ |
| LuCI ACL rules | /usr/share/rpcd/acl.d/ |


## Notes
- DSCP policy logic does not require manual DiffServ configuration in LuCI.
  When using Seg_Layer_Cake.qos, CAKE automatically operates in DiffServ mode and honors DSCP markings.
- This project does not override existing firewall rules.
- nftables rules are created dynamically and cleaned up properly.
- Designed for users familiar with OpenWrt and SQM.
- The nftables table `sqm_dscp` is created and removed dynamically on SQM start/stop.
- The original LuCI SQM view is backed up as `sqm.js.orig` during installation.

## Uninstallation

⚠️ Important

This project creates nftables rules dynamically via SQM lifecycle hooks.
Before removing any files, SQM must be disabled or stopped, otherwise
DSCP rules may remain active.

Step 1: Disable SQM

Disable SQM in LuCI (Network → SQM QoS):

Uncheck Enable this SQM instance

Click Save & Apply

—or from CLI—

```sh
uci set sqm.@queue[0].enabled='0'
uci commit sqm
/etc/init.d/sqm stop
```

Stopping SQM ensures that:

CAKE qdiscs are removed

IFB interfaces are cleaned up

the inet sqm_dscp nftables table is deleted correctly


To remove the DSCP policy setup:

Step 2: Restore the original LuCI SQM view (optional)

If you want to restore the stock LuCI SQM interface:

```sh
cp /www/luci-static/resources/view/network/sqm.js.orig \
   /www/luci-static/resources/view/network/sqm.js
```

Step 3: Remove the custom SQM script:

```sh
rm /usr/lib/sqm/Seg_Layer_Cake.qos
```
Step 4: Restart LuCI services:

```sh
/etc/init.d/uhttpd restart
/etc/init.d/rpcd restart
```
### Optional: Remove DSCP Connections view

To completely remove the DSCP Connections LuCI view:

```sh
rm -f /www/luci-static/resources/view/dscp/connections.js
rm -f /usr/libexec/rpcd/luci.dscp
rm -f /usr/share/luci/menu.d/luci-app-dscp.json
rm -f /usr/share/rpcd/acl.d/luci-app-dscp.json
```

Restart LuCI services:

```sh
/etc/init.d/uhttpd restart
/etc/init.d/rpcd restart
```

## Notes

Removing DSCP Connections does not affect SQM, CAKE, or nftables
once SQM has been stopped

No firewall rules are modified outside of SQM lifecycle

The system is restored to a clean OpenWrt state
