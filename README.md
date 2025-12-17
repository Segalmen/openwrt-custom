# Gaming_DSCP – SQM + CAKE + nftables (OpenWrt)

Custom SQM setup for OpenWrt using **CAKE**, **DSCP**, and **nftables**,  
designed to improve latency and gaming traffic prioritization.

This project provides:
- A custom SQM script (`Seg_Layer_Cake.qos`)
- nftables-based DSCP marking (IPv4 / IPv6)
- Optional Gaming_DSCP logic
- Automated installer with dependency handling
- LuCI custom view

---

## Requirements

-  Tested on OpenWrt 24.10+.
-  Older versions have not been tested.
-  luci-app-sqm must be installed and enabled

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

## Installation (one command)

Run the following command on your OpenWrt router:

```sh
cd /tmp && \
uclient-fetch -O - https://github.com/Segalmen/openwrt-custom/archive/refs/tags/v1.0.tar.gz | tar xz && \
cd openwrt-custom-1.0 && \
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
- Verify that the **Gaming_DSCP** section appears in LuCI after installation (visibility only)
- Gaming_DSCP becomes operational only when:
  - SQM is enabled in *Basic Settings*
  - **Seg_Layer_Cake.qos** is selected as the active SQM script

⚠️ The installer does not set bandwidth or overhead values automatically.

## Files installed

| File | Destination |
|------|------------|
| Seg_Layer_Cake.qos | /usr/lib/sqm/ |
| sqm.config | /etc/config/sqm |
| sqm.js | /www/luci-static/resources/view/network/ |

## Notes
- Gaming_DSCP does not require manual DiffServ configuration in LuCI.
  When using Seg_Layer_Cake.qos, CAKE automatically operates in DiffServ mode and honors DSCP markings.
- This project does not override existing firewall rules.
- nftables rules are created dynamically and cleaned up properly.
- Designed for users familiar with OpenWrt and SQM.
- The nftables table `sqm_dscp` is created and removed dynamically on SQM start/stop.
- The original LuCI SQM view is backed up as `sqm.js.orig` during installation.

## Uninstallation

To remove the Gaming_DSCP setup:

Disable SQM in LuCI (**Network → SQM QoS**)

Restore the original LuCI SQM view (if needed):

```sh
cp /www/luci-static/resources/view/network/sqm.js.orig \
   /www/luci-static/resources/view/network/sqm.js
```

Remove the custom SQM script:

```sh
rm /usr/lib/sqm/Seg_Layer_Cake.qos
```

Restart LuCI services:

```sh
/etc/init.d/uhttpd restart
/etc/init.d/rpcd restart
```



