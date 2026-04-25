#!/bin/sh
# =============================================================================
# install.sh — OpenWrt Custom SQM / DSCP installer
# Project : openwrt-custom (Segalmen)
# Requires: OpenWrt 24.10 or newer
# =============================================================================

set -e

# --- Colors (if terminal supports it) ---
RED='\033[0;31m'
YEL='\033[1;33m'
GRN='\033[0;32m'
BLU='\033[1;34m'
RST='\033[0m'

ok()   { printf "${GRN}[OK]${RST}  %s\n" "$*"; }
info() { printf "${BLU}[*]${RST}  %s\n"  "$*"; }
warn() { printf "${YEL}[!]${RST}  %s\n"  "$*"; }
err()  { printf "${RED}[ERROR]${RST} %s\n" "$*" >&2; }

# =============================================================================
# Options
# =============================================================================
DRY_RUN=0
FORCE=0

for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --force)   FORCE=1   ;;
        --help|-h)
            echo "Usage: sh install.sh [--dry-run] [--force]"
            echo ""
            echo "  --dry-run   Show what would be done without making changes"
            echo "  --force     Overwrite existing SQM config without confirmation"
            exit 0
            ;;
    esac
done

# =============================================================================
# Dry-run mode
# =============================================================================
do_run() {
    if [ "$DRY_RUN" = "1" ]; then
        printf "  [DRY-RUN] %s\n" "$*"
    else
        eval "$@"
    fi
}

# =============================================================================
# Cleanup on error (trap)
# =============================================================================
INSTALL_OK=0

cleanup() {
    if [ "$INSTALL_OK" = "0" ] && [ "$DRY_RUN" = "0" ]; then
        warn "Installation interrupted — please check system state."
        warn "Run 'sh uninstall.sh' if needed to clean up."
    fi
}
trap cleanup EXIT

# =============================================================================
# Check: root privileges
# =============================================================================
if [ "$(id -u)" != "0" ]; then
    err "This script must be run as root."
    exit 1
fi

# =============================================================================
# Check: OpenWrt system
# =============================================================================
if [ ! -f /etc/openwrt_release ]; then
    err "This script is designed for OpenWrt only."
    exit 1
fi

# =============================================================================
# Check: available disk space (minimum 5 MB on /overlay)
# =============================================================================
check_disk_space() {
    AVAIL=$(df /overlay 2>/dev/null | awk 'NR==2 {print $4}')
    if [ -z "$AVAIL" ]; then
        AVAIL=$(df / | awk 'NR==2 {print $4}')
    fi
    # Threshold: 5120 KB = 5 MB
    if [ "$AVAIL" -lt 5120 ] 2>/dev/null; then
        err "Insufficient disk space on /overlay: ${AVAIL}K available (minimum 5 MB required)."
        err "Free up some space before continuing."
        exit 1
    fi
    info "Disk space: ${AVAIL}K available — OK"
}

if [ "$DRY_RUN" = "0" ]; then
    check_disk_space
else
    info "[DRY-RUN] Disk space check skipped"
fi

# =============================================================================
# Check: required source files are present
# =============================================================================
MISSING=0
for f in \
    "Gaming_Dscp/Seg_Layer_Cake.qos" \
    "Gaming_Dscp/sqm.config" \
    "Gaming_Dscp/sqm.js" \
    "connections/rpcd/luci.dscp" \
    "connections/view/connections.js"
do
    if [ ! -f "$f" ]; then
        err "Missing source file: $f"
        MISSING=1
    fi
done
if [ "$MISSING" = "1" ]; then
    err "Some source files are missing. Make sure to run install.sh"
    err "from the project root directory (openwrt-custom-main/)."
    exit 1
fi

# Optional file (warn but do not fail)
if [ ! -f "tools/dscp-validate.sh" ]; then
    warn "Optional file missing: tools/dscp-validate.sh"
    warn "→ Diagnostic tool will not be installed."
fi

# =============================================================================
# Detect package manager
# =============================================================================
if command -v apk >/dev/null 2>&1; then
    PKG_MGR="apk"
    pkg_update()     { apk update; }
    pkg_install()    { apk add "$@"; }
    pkg_installed()  { apk info -e "$1" >/dev/null 2>&1; }
    PKG_TC="tc-full"
    info "OpenWrt 25.x+ detected — package manager: apk"
else
    PKG_MGR="opkg"
    pkg_update()     { opkg update; }
    pkg_install()    { opkg install "$@"; }
    pkg_installed()  { opkg list-installed | grep -q "^$1 "; }
    PKG_TC="tc"
    info "OpenWrt 24.x detected — package manager: opkg"
fi

# =============================================================================
# Install required packages
# =============================================================================
REQUIRED_PKGS="
luci-app-sqm
sqm-scripts
kmod-sched-cake
kmod-ifb
kmod-sched-ctinfo
kmod-nf-conntrack
kmod-nft-core
nftables
$PKG_TC
ip-full
lua
luci-lib-jsonc
conntrack-tools
"

info "Updating package index"
if [ "$DRY_RUN" = "0" ]; then
    if ! pkg_update; then
        warn "Unable to update index — installing from cache"
    fi
fi

INSTALL_ERRORS=0
info "Checking and installing required packages"

for pkg in $REQUIRED_PKGS; do
    [ -z "$pkg" ] && continue
    if [ "$DRY_RUN" = "1" ]; then
        printf "  [DRY-RUN] Checking: %s\n" "$pkg"
        continue
    fi
    if pkg_installed "$pkg"; then
        ok "$pkg already installed"
    else
        info "Installing $pkg ..."
        if pkg_install "$pkg"; then
            ok "$pkg installed"
        else
            warn "Failed to install $pkg — continuing without interruption"
            INSTALL_ERRORS=$((INSTALL_ERRORS + 1))
        fi
    fi
done

if [ "$INSTALL_ERRORS" -gt 0 ]; then
    warn "$INSTALL_ERRORS package(s) could not be installed."
    warn "The system may not work correctly."
fi

# =============================================================================
# Install: LuCI DSCP Connections view
# =============================================================================
info "Installing LuCI DSCP Connections view"

do_run mkdir -p /usr/libexec/rpcd
do_run mkdir -p /usr/share/luci/menu.d
do_run mkdir -p /usr/share/rpcd/acl.d
do_run mkdir -p /www/luci-static/resources/view/dscp

do_run cp connections/rpcd/luci.dscp /usr/libexec/rpcd/luci.dscp
do_run chmod +x /usr/libexec/rpcd/luci.dscp

# JSON menus (tolerant if directory is empty)
for f in connections/menu/*.json; do
    [ -f "$f" ] && do_run cp "$f" /usr/share/luci/menu.d/
done
for f in connections/acl/*.json; do
    [ -f "$f" ] && do_run cp "$f" /usr/share/rpcd/acl.d/
done
for f in connections/view/*.js; do
    [ -f "$f" ] && do_run cp "$f" /www/luci-static/resources/view/dscp/
done

ok "DSCP Connections view installed"

# =============================================================================
# Install: SQM configuration
# =============================================================================
info "Installing SQM configuration"

do_run mkdir -p /etc/config

if [ "$DRY_RUN" = "0" ]; then
    if [ -f /etc/config/sqm ] && [ ! -f /etc/config/sqm.orig ]; then
        info "Backing up existing SQM config → /etc/config/sqm.orig"
        cp /etc/config/sqm /etc/config/sqm.orig
    fi

    if [ -f /etc/config/sqm ] && [ "$FORCE" = "0" ]; then
        printf "\n${YEL}[?]${RST} An SQM configuration already exists.\n"
        printf "    Overwrite with custom config? [y/N]: "
        read -r REPLY
        case "$REPLY" in
            [oOyY])
                info "Replacing SQM config"
                cp Gaming_Dscp/sqm.config /etc/config/sqm
                ;;
            *)
                warn "SQM config kept — you will need to select Seg_Layer_Cake.qos manually in LuCI"
                ;;
        esac
    else
        cp Gaming_Dscp/sqm.config /etc/config/sqm
    fi
else
    info "[DRY-RUN] Copy Gaming_Dscp/sqm.config → /etc/config/sqm"
fi

# =============================================================================
# Install: SQM script .qos
# =============================================================================
info "Installing SQM script Seg_Layer_Cake.qos"

do_run mkdir -p /usr/lib/sqm
do_run cp Gaming_Dscp/Seg_Layer_Cake.qos /usr/lib/sqm/Seg_Layer_Cake.qos
do_run chmod +x /usr/lib/sqm/Seg_Layer_Cake.qos

ok "Seg_Layer_Cake.qos installed"

# =============================================================================
# Install: custom LuCI SQM view (sqm.js)
# =============================================================================
info "Installing custom LuCI SQM view"

do_run mkdir -p /www/luci-static/resources/view/network

if [ "$DRY_RUN" = "0" ]; then
    if [ -f /www/luci-static/resources/view/network/sqm.js ] && \
       [ ! -f /www/luci-static/resources/view/network/sqm.js.orig ]; then
        info "Backing up original sqm.js → sqm.js.orig"
        cp /www/luci-static/resources/view/network/sqm.js \
           /www/luci-static/resources/view/network/sqm.js.orig
    fi
    cp Gaming_Dscp/sqm.js /www/luci-static/resources/view/network/sqm.js
else
    info "[DRY-RUN] Copy Gaming_Dscp/sqm.js → /www/luci-static/resources/view/network/sqm.js"
fi

ok "LuCI SQM view installed"

# =============================================================================
# Install: diagnostic tool (optional)
# =============================================================================
if [ -f "tools/dscp-validate.sh" ]; then
    info "Installing diagnostic tool"
    do_run cp tools/dscp-validate.sh /root/dscp-validate.sh
    do_run chmod +x /root/dscp-validate.sh
    ok "Diagnostic tool installed → /root/dscp-validate.sh"
else
    warn "Skipping diagnostic tool (tools/dscp-validate.sh not present)"
fi

# =============================================================================
# Auto-detect WAN interface
# =============================================================================
detect_wan() {
    WAN_DEV=""

    # Method 1: UCI network.wan.device
    WAN_DEV="$(uci -q get network.wan.device 2>/dev/null)"

    # Method 2: UCI network.wan.ifname (OpenWrt < 21)
    if [ -z "$WAN_DEV" ]; then
        WAN_DEV="$(uci -q get network.wan.ifname 2>/dev/null)"
    fi

    # Method 3: default route
    if [ -z "$WAN_DEV" ]; then
        WAN_DEV="$(ip route 2>/dev/null | awk '/^default/ {print $5; exit}')"
    fi

    echo "$WAN_DEV"
}

info "Detecting WAN interface"
WAN_IFACE="$(detect_wan)"

if [ -z "$WAN_IFACE" ]; then
    warn "WAN interface not detected automatically."
    warn "Using default value: eth1"
    warn "→ Fix the interface in LuCI: Network → SQM QoS"
    WAN_IFACE="eth1"
else
    ok "WAN interface detected: $WAN_IFACE"
    # Warn if interface looks like a bridge or alias
    case "$WAN_IFACE" in
        br-*|@*)
            warn "Detected interface ($WAN_IFACE) appears to be a bridge or alias."
            warn "On PPPoE/VLAN setups, you may need to fix it manually in LuCI."
            ;;
    esac
fi

# =============================================================================
# Configure SQM via UCI
# =============================================================================
info "Pre-configuring SQM via UCI"

if [ "$DRY_RUN" = "0" ]; then
    uci set sqm.@queue[0].interface="$WAN_IFACE"
    uci set sqm.@queue[0].enabled='1'
    uci set sqm.@queue[0].script='Seg_Layer_Cake.qos'
    uci commit sqm
    ok "SQM UCI configuration applied"
else
    info "[DRY-RUN] uci set sqm.@queue[0].interface=$WAN_IFACE"
    info "[DRY-RUN] uci set sqm.@queue[0].script=Seg_Layer_Cake.qos"
fi

# =============================================================================
# Start services
# =============================================================================
info "Restarting services"

if [ "$DRY_RUN" = "0" ]; then
    if [ -x /etc/init.d/sqm ]; then
        /etc/init.d/sqm enable
        if /etc/init.d/sqm restart; then
            ok "SQM service restarted"
        else
            warn "SQM did not start correctly — check bandwidth settings in LuCI"
        fi
    fi

    [ -x /etc/init.d/rpcd ]   && /etc/init.d/rpcd restart   && ok "rpcd restarted"
    [ -x /etc/init.d/uhttpd ] && /etc/init.d/uhttpd restart && ok "uhttpd restarted"
else
    info "[DRY-RUN] Restart sqm / rpcd / uhttpd skipped"
fi

# =============================================================================
# Final summary
# =============================================================================
INSTALL_OK=1

printf "\n"
printf "${GRN}============================================================${RST}\n"
printf "${GRN}  Installation completed successfully${RST}\n"
printf "${GRN}============================================================${RST}\n"
printf "\n"
printf "  Configured WAN interface: %s\n" "$WAN_IFACE"
printf "  Active SQM script        : Seg_Layer_Cake.qos\n"
printf "\n"
printf "${YEL}  IMPORTANT — Post-installation steps:${RST}\n"
printf "  1. LuCI → Network → SQM QoS\n"
printf "     → Verify the WAN interface\n"
printf "     → Configure download / upload bandwidth\n"
printf "     → Configure Link layer / overhead\n"
printf "  2. LuCI → Network → DSCP → Connections\n"
printf "     → Real-time connection view (with Flush Conntrack button)\n"
if [ -f /root/dscp-validate.sh ] || [ -f tools/dscp-validate.sh ]; then
    printf "  3. Validate the install:\n"
    printf "     /root/dscp-validate.sh\n"
    printf "     (use --anonymize when sharing the report publicly)\n"
fi
printf "\n"
printf "  To uninstall: sh uninstall.sh\n"
printf "\n"
