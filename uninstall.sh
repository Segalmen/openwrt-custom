#!/bin/sh
# =============================================================================
# uninstall.sh — OpenWrt Custom SQM / DSCP uninstaller
# Project : openwrt-custom (Segalmen)
# =============================================================================

set -e

# --- Colors ---
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
KEEP_CONFIG=0

for arg in "$@"; do
    case "$arg" in
        --dry-run)     DRY_RUN=1     ;;
        --force)       FORCE=1       ;;
        --keep-config) KEEP_CONFIG=1 ;;
        --help|-h)
            echo "Usage: sh uninstall.sh [OPTIONS]"
            echo ""
            echo "  --dry-run      Show what would be done without making changes"
            echo "  --force        No interactive confirmation"
            echo "  --keep-config  Keep /etc/config/sqm (do not restore original)"
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

safe_rm() {
    if [ "$DRY_RUN" = "1" ]; then
        printf "  [DRY-RUN] rm -f %s\n" "$*"
    else
        rm -f "$@" && ok "Removed: $*" || warn "Not found (skipped): $*"
    fi
}

# =============================================================================
# Check: root privileges
# =============================================================================
if [ "$(id -u)" != "0" ]; then
    err "This script must be run as root."
    exit 1
fi

# =============================================================================
# Interactive confirmation (unless --force or --dry-run)
# =============================================================================
if [ "$FORCE" = "0" ] && [ "$DRY_RUN" = "0" ]; then
    printf "\n${YEL}WARNING${RST}: This script will remove files installed by install.sh.\n"
    printf "Backups (.orig) will be restored if available.\n\n"
    printf "Continue? [y/N]: "
    read -r REPLY
    case "$REPLY" in
        [oOyY]) : ;;
        *)
            info "Uninstallation cancelled."
            exit 0
            ;;
    esac
fi

# =============================================================================
# Step 1: Stop SQM
# CRITICAL: nftables sqm_dscp rules must be removed by SQM
# before removing files, otherwise they remain active.
# =============================================================================
info "Step 1/7: Stopping SQM (removing nftables rules)"

if [ "$DRY_RUN" = "0" ]; then
    if [ -x /etc/init.d/sqm ]; then
        # Disable via UCI first
        if uci -q get sqm.@queue[0] >/dev/null 2>&1; then
            uci set sqm.@queue[0].enabled='0'
            uci commit sqm
        fi

        /etc/init.d/sqm stop 2>/dev/null && ok "SQM stopped" || warn "SQM already stopped or not found"
        /etc/init.d/sqm disable 2>/dev/null || true
    else
        warn "/etc/init.d/sqm not found — skipped"
    fi

    # Verify that the nftables sqm_dscp table has been removed
    if nft list table inet sqm_dscp >/dev/null 2>&1; then
        warn "nftables sqm_dscp table still present — forcing removal"
        nft delete table inet sqm_dscp 2>/dev/null && ok "sqm_dscp table removed" || \
            warn "Unable to remove sqm_dscp — remove it manually with: nft delete table inet sqm_dscp"
    else
        ok "nftables sqm_dscp table absent — OK"
    fi
else
    info "[DRY-RUN] Stop SQM + remove nftables sqm_dscp"
fi

# =============================================================================
# Step 2: Restore original sqm.js (LuCI SQM view)
# =============================================================================
info "Step 2/7: Restoring LuCI SQM view"

LUCI_SQM="/www/luci-static/resources/view/network/sqm.js"
LUCI_SQM_ORIG="${LUCI_SQM}.orig"

if [ "$DRY_RUN" = "0" ]; then
    if [ -f "$LUCI_SQM_ORIG" ]; then
        cp "$LUCI_SQM_ORIG" "$LUCI_SQM"
        rm -f "$LUCI_SQM_ORIG"
        ok "Original sqm.js restored"
    elif [ -f "$LUCI_SQM" ]; then
        warn "No sqm.js.orig backup found — removing custom file"
        rm -f "$LUCI_SQM"
    else
        warn "sqm.js not found — skipped"
    fi
else
    info "[DRY-RUN] Restore $LUCI_SQM_ORIG → $LUCI_SQM"
fi

# =============================================================================
# Step 3: Remove SQM script .qos
# =============================================================================
info "Step 3/7: Removing SQM script Seg_Layer_Cake.qos"

safe_rm /usr/lib/sqm/Seg_Layer_Cake.qos

# =============================================================================
# Step 4: Restore or remove SQM configuration
# =============================================================================
info "Step 4/7: Restoring SQM configuration"

if [ "$KEEP_CONFIG" = "0" ]; then
    if [ "$DRY_RUN" = "0" ]; then
        if [ -f /etc/config/sqm.orig ]; then
            cp /etc/config/sqm.orig /etc/config/sqm
            rm -f /etc/config/sqm.orig
            ok "Original SQM config restored"
        else
            warn "No sqm.orig found — removing /etc/config/sqm"
            rm -f /etc/config/sqm
        fi
    else
        info "[DRY-RUN] Restore /etc/config/sqm.orig → /etc/config/sqm"
    fi
else
    info "Option --keep-config: /etc/config/sqm kept"
fi

# =============================================================================
# Step 5: Remove DSCP Connections view
# =============================================================================
info "Step 5/7: Removing DSCP Connections view"

safe_rm /www/luci-static/resources/view/dscp/connections.js
safe_rm /usr/libexec/rpcd/luci.dscp
safe_rm /usr/share/luci/menu.d/luci-app-dscp.json
safe_rm /usr/share/rpcd/acl.d/luci-app-dscp.json

# Remove dscp/ directory if empty
if [ "$DRY_RUN" = "0" ]; then
    rmdir /www/luci-static/resources/view/dscp 2>/dev/null && \
        ok "dscp/ directory removed (was empty)" || \
        warn "dscp/ directory not empty — kept"
else
    info "[DRY-RUN] rmdir /www/luci-static/resources/view/dscp (if empty)"
fi

# =============================================================================
# Step 6: Remove diagnostic tool
# =============================================================================
info "Step 6/7: Removing diagnostic tool"

safe_rm /root/dscp-validate.sh

# =============================================================================
# Step 7: Restart LuCI services
# =============================================================================
info "Step 7/7: Restarting services"

if [ "$DRY_RUN" = "0" ]; then
    [ -x /etc/init.d/rpcd ]   && /etc/init.d/rpcd restart   && ok "rpcd restarted"
    [ -x /etc/init.d/uhttpd ] && /etc/init.d/uhttpd restart && ok "uhttpd restarted"
else
    info "[DRY-RUN] Restart rpcd / uhttpd skipped"
fi

# =============================================================================
# Summary
# =============================================================================
printf "\n"
printf "${GRN}============================================================${RST}\n"
printf "${GRN}  Uninstallation completed${RST}\n"
printf "${GRN}============================================================${RST}\n"
printf "\n"
printf "  Files removed / restored:\n"
printf "   - /usr/lib/sqm/Seg_Layer_Cake.qos\n"
printf "   - /www/luci-static/resources/view/network/sqm.js (restored or removed)\n"
printf "   - /www/luci-static/resources/view/dscp/connections.js\n"
printf "   - /usr/libexec/rpcd/luci.dscp\n"
printf "   - /usr/share/luci/menu.d/luci-app-dscp.json\n"
printf "   - /usr/share/rpcd/acl.d/luci-app-dscp.json\n"
printf "   - /root/dscp-validate.sh (diagnostic tool)\n"
printf "\n"
printf "  Installed packages (CAKE, nftables, conntrack-tools, etc.) are kept.\n"
printf "  Use opkg/apk remove if you wish to remove them.\n"
printf "\n"
printf "  System restored to a clean OpenWrt state.\n"
printf "\n"
