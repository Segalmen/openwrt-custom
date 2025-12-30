#!/bin/sh
set -e

echo "[*] Checking required packages"

REQUIRED_PKGS="
luci-app-sqm
sqm-scripts
kmod-sched-cake
kmod-ifb
kmod-nft-core
tc
kmod-sched-ctinfo
nftables
ip-full
lua
luci-lib-jsonc
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

echo "[*] Installing LuCI DSCP Connections menu"

mkdir -p /usr/libexec/rpcd
mkdir -p /usr/share/luci/menu.d
mkdir -p /usr/share/rpcd/acl.d
mkdir -p /www/luci-static/resources/view/dscp

cp connections/rpcd/luci.dscp        /usr/libexec/rpcd/
cp connections/menu/*.json           /usr/share/luci/menu.d/
cp connections/acl/*.json            /usr/share/rpcd/acl.d/
cp connections/view/*.js             /www/luci-static/resources/view/dscp/

chmod +x /usr/libexec/rpcd/luci.dscp


echo "=== Gaming_DSCP OpenWrt installer ==="

# --- SQM config ---
echo "[*] Installing SQM configuration"
mkdir -p /etc/config
if [ ! -f /etc/config/sqm ]; then
    echo "[*] Installing default SQM configuration"
    cp Gaming_Dscp/sqm.config /etc/config/sqm
else
    echo "[*] SQM config already exists, keeping current configuration"
fi

# --- SQM script ---
echo "[*] Installing custom SQM script"
mkdir -p /usr/lib/sqm
cp Gaming_Dscp/Seg_Layer_Cake.qos /usr/lib/sqm/Seg_Layer_Cake.qos
chmod +x /usr/lib/sqm/Seg_Layer_Cake.qos

# --- LuCI custom JS ---
echo "[*] Installing LuCI custom SQM view"
mkdir -p /www/luci-static/resources/view/network

if [ -f /www/luci-static/resources/view/network/sqm.js ] && \
   [ ! -f /www/luci-static/resources/view/network/sqm.js.orig ]; then
    echo "    Backing up original sqm.js"
    cp /www/luci-static/resources/view/network/sqm.js \
       /www/luci-static/resources/view/network/sqm.js.orig
fi

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

