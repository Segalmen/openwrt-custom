#!/bin/sh
set -e

echo "[*] Checking required packages"

REQUIRED_PKGS="
sqm-scripts
kmod-sched-cake
kmod-ifb
kmod-nft-core
kmod-nft-conntrack
tc
nftables
ip-full
"

opkg update

for pkg in $REQUIRED_PKGS; do
    if ! opkg list-installed | grep -q "^$pkg "; then
        echo "    Installing $pkg"
        opkg install "$pkg"
    else
        echo "    $pkg already installed"
    fi
done


echo "=== Gaming_DSCP OpenWrt installer ==="

# --- SQM config ---
echo "[*] Installing SQM configuration"
mkdir -p /etc/config
cp Gaming_Dscp/sqm.config /etc/config/sqm

# --- SQM script ---
echo "[*] Installing custom SQM script"
mkdir -p /usr/lib/sqm
cp Gaming_Dscp/Seg_Layer_Cake.qos /usr/lib/sqm/Seg_Layer_Cake.qos
chmod +x /usr/lib/sqm/Seg_Layer_Cake.qos

# --- LuCI custom JS ---
echo "[*] Installing LuCI custom SQM view"
mkdir -p /www/luci-static/resources/view/network
cp Gaming_Dscp/sqm.js /www/luci-static/resources/view/network/sqm.js

echo "[*] Preconfiguring SQM"

uci set sqm.@queue[0].enabled='1'
uci set sqm.@queue[0].script='Seg_Layer_Cake.qos'
uci commit sqm

# --- Restart services ---
[ -x /etc/init.d/rpcd ] && /etc/init.d/rpcd restart
[ -x /etc/init.d/uhttpd ] && /etc/init.d/uhttpd restart

echo "=== Installation completed successfully ==="
echo "=== SQM is enabled with Seg_Layer_Cake.qos ==="
echo "=== Please configure bandwidth, overhead and Gaming_DSCP settings in LuCI ==="

