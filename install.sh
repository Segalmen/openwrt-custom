#!/bin/sh
set -e

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

# --- Restart services ---
[ -x /etc/init.d/rpcd ] && /etc/init.d/rpcd restart
[ -x /etc/init.d/uhttpd ] && /etc/init.d/uhttpd restart

echo "=== Installation completed successfully ==="
