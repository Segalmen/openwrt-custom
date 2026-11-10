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
            echo "  --keep-config  Keep /etc/config/sqm (do not restore original),"
            echo "                 /etc/config/serverrules, /etc/config/lagsim"
            echo "                 and the server history (/etc/sqm-dscp)"
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
        "$@"
    fi
}

# True when a package owns the file (then it is left in place)
pkg_owned() {
    if command -v apk >/dev/null 2>&1; then
        apk info --who-owns "$1" 2>/dev/null | grep -q "owned by"
    else
        opkg search "$1" 2>/dev/null | grep -q .
    fi
}

LAGSIM_PKG=0
if command -v apk >/dev/null 2>&1; then
    apk info -e lagsim >/dev/null 2>&1 && LAGSIM_PKG=1
else
    opkg list-installed 2>/dev/null | grep -q "^lagsim " && LAGSIM_PKG=1
fi

safe_rm() {
    if [ "$DRY_RUN" = "1" ]; then
        printf "  [DRY-RUN] rm -f %s\n" "$*"
        return 0
    fi
    for f in "$@"; do
        if [ -e "$f" ] || [ -L "$f" ]; then
            if rm -f "$f"; then
                ok "Removed: $f"
            else
                warn "Failed to remove: $f"
            fi
        else
            info "Not present (skipped): $f"
        fi
    done
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
info "Step 1/9: Stopping SQM (removing nftables rules)"

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
info "Step 2/9: Restoring LuCI SQM view"

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
info "Step 3/9: Removing SQM script Seg_Layer_Cake.qos"

safe_rm /usr/lib/sqm/Seg_Layer_Cake.qos
safe_rm /usr/lib/sqm/Seg_Layer_Cake.version

# =============================================================================
# Step 4: Restore or remove SQM configuration
# =============================================================================
info "Step 4/9: Restoring SQM configuration"

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
# Step 5: Remove Server Rules (nft table inet serverrules)
# =============================================================================
info "Step 5/9: Removing Server Rules"

if [ "$DRY_RUN" = "0" ]; then
    if [ -x /etc/init.d/serverrules ]; then
        /etc/init.d/serverrules stop 2>/dev/null || true
        /etc/init.d/serverrules disable 2>/dev/null || true
    fi
    nft delete table inet serverrules 2>/dev/null && ok "nftables serverrules table removed" || \
        info "nftables serverrules table absent — OK"
else
    info "[DRY-RUN] Stop serverrules + remove nftables serverrules"
fi

safe_rm /etc/init.d/serverrules
safe_rm /usr/libexec/serverrules/serverrules.sh
do_run rmdir /usr/libexec/serverrules 2>/dev/null || true
if [ "$KEEP_CONFIG" = "0" ]; then
    safe_rm /etc/config/serverrules
else
    info "Option --keep-config: /etc/config/serverrules kept"
fi

# =============================================================================
# Step 6: Remove Lag Simulator (skipped when the lagsim package owns it)
# =============================================================================
info "Step 6/9: Removing Lag Simulator"

if [ "$LAGSIM_PKG" = "1" ]; then
    info "Package 'lagsim' installed — its files are kept"
else
    if [ "$DRY_RUN" = "0" ]; then
        [ -x /usr/sbin/lagsim ] && /usr/sbin/lagsim teardown 2>/dev/null || true
        [ -x /etc/init.d/lagsim ] && /etc/init.d/lagsim disable 2>/dev/null || true
    else
        info "[DRY-RUN] lagsim teardown + disable"
    fi
    safe_rm /etc/init.d/lagsim /usr/sbin/lagsim /etc/hotplug.d/net/30-lagsim
    # netem distribution tables: only the ones no package owns
    for d in experimental normal normmix20-64 pareto paretonormal; do
        f="/usr/lib/tc/$d.dist"
        [ -f "$f" ] || continue
        if pkg_owned "$f"; then
            info "Kept (owned by a package): $f"
        else
            safe_rm "$f"
        fi
    done
    if [ "$KEEP_CONFIG" = "0" ]; then
        safe_rm /etc/config/lagsim
    else
        info "Option --keep-config: /etc/config/lagsim kept"
    fi
fi

# =============================================================================
# Step 7: Remove LuCI pages (SQM QoS tabs) and their data
# =============================================================================
info "Step 7/9: Removing LuCI pages (SQM QoS tabs)"

safe_rm /usr/libexec/rpcd/luci.dscp

# Glob removal — install.sh deploys via `for f in connections/{menu,acl}/*.json`.
# luci-app-dscp*.json: ACL (and the menu of 1.x); luci-app-sqm_dscp*.json:
# the tabs menu. Removing it gives luci-app-sqm its original menu back.
for f in /usr/share/luci/menu.d/luci-app-dscp*.json /usr/share/luci/menu.d/luci-app-sqm_dscp*.json; do
    [ -f "$f" ] && safe_rm "$f"
done
for f in /usr/share/rpcd/acl.d/luci-app-dscp*.json; do
    [ -f "$f" ] && safe_rm "$f"
done

# Our own directories — rm -rf is safe here: we created them.
for d in /www/luci-static/resources/view/dscp /tmp/dscp-captures; do
    if [ "$DRY_RUN" = "0" ]; then
        if [ -d "$d" ]; then
            rm -rf "$d" && ok "Removed: $d" || warn "Failed to remove: $d"
        else
            info "Not present (skipped): $d"
        fi
    else
        info "[DRY-RUN] rm -rf $d"
    fi
done

if [ "$KEEP_CONFIG" = "0" ]; then
    if [ "$DRY_RUN" = "0" ]; then
        if [ -d /etc/sqm-dscp ]; then
            rm -rf /etc/sqm-dscp && ok "Removed: /etc/sqm-dscp (server history)"
        else
            info "Not present (skipped): /etc/sqm-dscp"
        fi
    else
        info "[DRY-RUN] rm -rf /etc/sqm-dscp"
    fi
else
    info "Option --keep-config: /etc/sqm-dscp (server history) kept"
fi

# Bootstrap Dark Blue theme (skipped when its own package is installed).
# If it is the active theme, LuCI goes back to bootstrap first.
DB_PKG=0
if command -v apk >/dev/null 2>&1; then
    apk info -e luci-theme-bootstrap-darkblue >/dev/null 2>&1 && DB_PKG=1
else
    opkg list-installed 2>/dev/null | grep -q "^luci-theme-bootstrap-darkblue " && DB_PKG=1
fi
if [ "$DB_PKG" = "1" ]; then
    info "Package 'luci-theme-bootstrap-darkblue' installed — theme kept"
elif [ "$DRY_RUN" = "0" ]; then
    if [ "$(uci -q get luci.main.mediaurlbase)" = "/luci-static/bootstrap-darkblue" ]; then
        uci set luci.main.mediaurlbase=/luci-static/bootstrap
        ok "Active theme switched back to bootstrap"
    fi
    uci -q delete luci.themes.BootstrapDarkBlue
    uci commit luci
    rm -rf /www/luci-static/bootstrap-darkblue \
           /www/luci-static/resources/view/bootstrap-darkblue \
           /usr/share/ucode/luci/template/themes/bootstrap-darkblue
    rm -f /www/luci-static/resources/menu-bootstrap-darkblue.js
    ok "Bootstrap Dark Blue theme removed"
else
    info "[DRY-RUN] Remove Bootstrap Dark Blue theme (back to bootstrap if active)"
fi

# Directories install.sh may have created: removed only when empty and not
# owned by a package (rmdir never removes a directory that still has files).
for d in /usr/lib/tc /usr/libexec/rpcd /usr/share/ucode/luci/template/themes; do
    [ -d "$d" ] || continue
    pkg_owned "$d" && continue
    if [ "$DRY_RUN" = "0" ]; then
        rmdir "$d" 2>/dev/null && ok "Removed empty directory: $d" || true
    else
        info "[DRY-RUN] rmdir $d (if empty)"
    fi
done

# =============================================================================
# Step 8: Remove diagnostic tool
# =============================================================================
info "Step 8/9: Removing diagnostic tool"

safe_rm /root/dscp-validate.sh

# =============================================================================
# Step 9: Restart LuCI services
# =============================================================================
info "Step 9/9: Restarting services"

if [ "$DRY_RUN" = "0" ]; then
    # LuCI caches the menu tree; drop it so the original menu is back at once
    rm -f /tmp/luci-indexcache* 2>/dev/null || true
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
printf "   - /usr/lib/sqm/Seg_Layer_Cake.version\n"
printf "   - /etc/config/sqm (restored or removed)\n"
printf "   - /www/luci-static/resources/view/network/sqm.js (restored or removed)\n"
printf "   - /www/luci-static/resources/view/dscp/ (entire directory)\n"
printf "   - /usr/libexec/rpcd/luci.dscp\n"
printf "   - /usr/share/luci/menu.d/luci-app-dscp*.json, luci-app-sqm_dscp*.json\n"
printf "   - /usr/share/rpcd/acl.d/luci-app-dscp*.json\n"
printf "   - /root/dscp-validate.sh (diagnostic tool)\n"
printf "   - Server Rules: /etc/init.d/serverrules, /usr/libexec/serverrules/,\n"
printf "     /etc/config/serverrules (unless --keep-config)\n"
printf "   - Lag Simulator: /usr/sbin/lagsim, /etc/init.d/lagsim, hotplug, .dist,\n"
printf "     /etc/config/lagsim (unless --keep-config or lagsim package)\n"
printf "   - /etc/sqm-dscp (server history, unless --keep-config), /tmp/dscp-captures\n"
printf "   - Bootstrap Dark Blue theme (unless its package is installed)\n"
printf "\n"
printf "  Timestamped backups /etc/config/sqm.bak-* are kept — remove them\n"
printf "  yourself if you no longer need them.\n"
printf "\n"
printf "  Installed packages (CAKE, nftables, conntrack, etc.) are kept.\n"
if command -v apk >/dev/null 2>&1; then
    printf "  Use 'apk del <package>' if you wish to remove them.\n"
else
    printf "  Use 'opkg remove <package>' if you wish to remove them.\n"
fi
printf "\n"
printf "  System restored to a clean OpenWrt state.\n"
printf "\n"
