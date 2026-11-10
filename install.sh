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

# --- Version (single source of truth: the VERSION file in this repo) ---
VERSION="$(cat VERSION 2>/dev/null)"
VERSION="${VERSION:-unknown}"
VERSION_FILE="/usr/lib/sqm/Seg_Layer_Cake.version"

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
        "$@"
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
        AVAIL=$(df / 2>/dev/null | awk 'NR==2 {print $4}')
    fi
    # Validate AVAIL is purely numeric — empty or non-numeric means df failed
    case "$AVAIL" in
        ''|*[!0-9]*)
            warn "Could not determine available disk space — proceeding without check."
            return 0
            ;;
    esac
    # Threshold: 5120 KB = 5 MB
    if [ "$AVAIL" -lt 5120 ]; then
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
    "sqm/Seg_Layer_Cake.qos" \
    "sqm/sqm.config" \
    "sqm/sqm.js" \
    "connections/rpcd/luci.dscp" \
    "connections/view/connections.js" \
    "connections/view/serverrules.js" \
    "connections/view/history.js" \
    "connections/view/captures.js" \
    "connections/view/lagsim.js" \
    "connections/menu/luci-app-sqm_dscp.json" \
    "connections/acl/luci-app-dscp.json" \
    "serverrules/serverrules.sh" \
    "serverrules/serverrules.init" \
    "serverrules/serverrules.config" \
    "lagsim/lagsim.sh" \
    "lagsim/lagsim.init" \
    "lagsim/lagsim.config" \
    "lagsim/lagsim.hotplug" \
    "theme/darkblue/ucode/template/themes/bootstrap-darkblue/header.ut"
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
luci-lua-runtime
conntrack
kmod-sched-flower
kmod-netem
tcpdump
ca-bundle
"

# Critical packages — install MUST fail if any of these are missing.
# Anything not listed here is best-effort (LuCI UI helpers, optional tools).
CRITICAL_PKGS="sqm-scripts kmod-sched-cake kmod-ifb kmod-sched-ctinfo kmod-nf-conntrack kmod-nft-core nftables $PKG_TC"

is_critical_pkg() {
    case " $CRITICAL_PKGS " in
        *" $1 "*) return 0 ;;
        *) return 1 ;;
    esac
}

info "Updating package index"
if [ "$DRY_RUN" = "0" ]; then
    if ! pkg_update; then
        warn "Unable to update index — installing from cache"
    fi
fi

INSTALL_ERRORS=0
CRITICAL_FAIL=0
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
            if is_critical_pkg "$pkg"; then
                err "Failed to install CRITICAL package: $pkg"
                CRITICAL_FAIL=$((CRITICAL_FAIL + 1))
            else
                warn "Failed to install $pkg — continuing (non-critical)"
            fi
            INSTALL_ERRORS=$((INSTALL_ERRORS + 1))
        fi
    fi
done

if [ "$CRITICAL_FAIL" -gt 0 ]; then
    err "$CRITICAL_FAIL critical package(s) failed to install — SQM cannot run without them."
    err "Resolve repository/network issues and re-run install.sh."
    exit 1
fi

# HTTPS for the CIDR suggestion (RIPEstat) in Connections / Server History:
# uclient-fetch needs one TLS backend. Only add one when none is present, so an
# image built with openssl or wolfssl is left as it is.
if [ "$DRY_RUN" = "1" ]; then
    printf "  [DRY-RUN] Checking: libustream TLS backend\n"
elif ls /lib/libustream-ssl.so* >/dev/null 2>&1; then
    ok "libustream TLS backend already present"
else
    info "Installing libustream-mbedtls ..."
    if pkg_install libustream-mbedtls; then
        ok "libustream-mbedtls installed"
    else
        warn "Failed to install libustream-mbedtls — CIDR suggestion falls back to /24"
        INSTALL_ERRORS=$((INSTALL_ERRORS + 1))
    fi
fi

if [ "$INSTALL_ERRORS" -gt 0 ]; then
    warn "$INSTALL_ERRORS non-critical package(s) could not be installed."
    warn "Core SQM should work, but some UI features may be degraded."
fi

# =============================================================================
# Install: LuCI pages under Network → SQM QoS
# (SQM, Connections, Server Rules, Server History, Captures, Lag Simulator)
# =============================================================================
info "Installing LuCI pages (SQM QoS tabs)"

do_run mkdir -p /usr/libexec/rpcd
do_run mkdir -p /usr/share/luci/menu.d
do_run mkdir -p /usr/share/rpcd/acl.d
do_run mkdir -p /www/luci-static/resources/view/dscp

do_run cp connections/rpcd/luci.dscp /usr/libexec/rpcd/luci.dscp
do_run chmod 0755 /usr/libexec/rpcd/luci.dscp

# Menu of 1.x (separate "DSCP" entry) replaced by the SQM QoS tabs
if [ -f /usr/share/luci/menu.d/luci-app-dscp.json ]; then
    do_run rm -f /usr/share/luci/menu.d/luci-app-dscp.json
    info "Old DSCP menu entry removed (now tabs under SQM QoS)"
fi

# JSON menus (tolerant if directory is empty). The menu file name must sort
# after luci-app-sqm.json: LuCI merges menu.d files in name order and ours
# turns "SQM QoS" into a tabbed entry.
for f in connections/menu/*.json; do
    [ -f "$f" ] && do_run cp "$f" /usr/share/luci/menu.d/
done
for f in connections/acl/*.json; do
    [ -f "$f" ] && do_run cp "$f" /usr/share/rpcd/acl.d/
done
for f in connections/view/*.js; do
    [ -f "$f" ] && do_run cp "$f" /www/luci-static/resources/view/dscp/
done

ok "LuCI pages installed"

# =============================================================================
# Install: Server Rules (block remote server ranges, nft table inet serverrules)
# =============================================================================
info "Installing Server Rules"

do_run mkdir -p /usr/libexec/serverrules
do_run cp serverrules/serverrules.sh /usr/libexec/serverrules/serverrules.sh
do_run chmod 0755 /usr/libexec/serverrules/serverrules.sh
do_run cp serverrules/serverrules.init /etc/init.d/serverrules
do_run chmod 0755 /etc/init.d/serverrules
if [ -f /etc/config/serverrules ]; then
    info "Existing /etc/config/serverrules kept"
else
    do_run cp serverrules/serverrules.config /etc/config/serverrules
fi

ok "Server Rules installed"

# =============================================================================
# Install: Lag Simulator (netem per device, by MAC)
# Skipped when the standalone lagsim package is installed: its files are the
# same paths and stay owned by the package.
# =============================================================================
LAGSIM_PKG=0
if [ "$DRY_RUN" = "0" ] && pkg_installed lagsim; then
    LAGSIM_PKG=1
    warn "Package 'lagsim' is installed — its files are kept, the Lag Simulator tab uses them"
else
    info "Installing Lag Simulator"
    do_run cp lagsim/lagsim.sh /usr/sbin/lagsim
    do_run chmod 0755 /usr/sbin/lagsim
    do_run cp lagsim/lagsim.init /etc/init.d/lagsim
    do_run chmod 0755 /etc/init.d/lagsim
    do_run mkdir -p /etc/hotplug.d/net
    do_run cp lagsim/lagsim.hotplug /etc/hotplug.d/net/30-lagsim
    do_run mkdir -p /usr/lib/tc
    for f in lagsim/tc-dists/*.dist; do
        [ -f "$f" ] && do_run cp "$f" /usr/lib/tc/
    done
    if [ -f /etc/config/lagsim ]; then
        info "Existing /etc/config/lagsim kept"
    else
        do_run cp lagsim/lagsim.config /etc/config/lagsim
    fi
    ok "Lag Simulator installed (disabled until enabled in LuCI)"
fi

# =============================================================================
# Install: Bootstrap Dark Blue LuCI theme (Apache-2.0, derived from LuCI's
# bootstrap theme). Registered only: the active theme is left as it is, pick
# it in System → System → Language and Style. Skipped when the package
# luci-theme-bootstrap-darkblue is installed.
# =============================================================================
if [ "$DRY_RUN" = "0" ] && pkg_installed luci-theme-bootstrap-darkblue; then
    info "Package 'luci-theme-bootstrap-darkblue' installed — theme files kept"
else
    info "Installing Bootstrap Dark Blue theme (not activated)"
    do_run mkdir -p /www/luci-static/bootstrap-darkblue \
        /www/luci-static/resources/view/bootstrap-darkblue \
        /usr/share/ucode/luci/template/themes/bootstrap-darkblue
    for f in theme/darkblue/htdocs/luci-static/bootstrap-darkblue/*; do
        [ -f "$f" ] && do_run cp "$f" /www/luci-static/bootstrap-darkblue/
    done
    do_run cp theme/darkblue/htdocs/luci-static/resources/menu-bootstrap-darkblue.js /www/luci-static/resources/
    do_run cp theme/darkblue/htdocs/luci-static/resources/view/bootstrap-darkblue/sysauth.js /www/luci-static/resources/view/bootstrap-darkblue/
    for f in theme/darkblue/ucode/template/themes/bootstrap-darkblue/*.ut; do
        [ -f "$f" ] && do_run cp "$f" /usr/share/ucode/luci/template/themes/bootstrap-darkblue/
    done
    if [ "$DRY_RUN" = "0" ]; then
        uci -q get luci.themes.BootstrapDarkBlue >/dev/null || {
            uci set luci.themes.BootstrapDarkBlue=/luci-static/bootstrap-darkblue
            uci commit luci
        }
    else
        info "[DRY-RUN] uci set luci.themes.BootstrapDarkBlue=/luci-static/bootstrap-darkblue"
    fi
    ok "Theme installed — select it in System → System → Language and Style"
fi

# Spectra marks DSCP with its own nftables table: both together would mark
# the same traffic twice.
if [ "$DRY_RUN" = "0" ] && pkg_installed spectra; then
    warn "Package 'spectra' is installed: it also marks DSCP. Disable or remove it"
    warn "→ apk del luci-app-spectra spectra"
fi

# =============================================================================
# Install: SQM configuration
# =============================================================================
info "Installing SQM configuration"

do_run mkdir -p /etc/config

SQM_CFG_REPLACED=0

# Bandwidth of the config being replaced, when it was already ours. Reapplied
# after the overwrite so an update never drops the user back to the example
# rates shipped in sqm.config.
PREV_DOWNLOAD=""
PREV_UPLOAD=""
# Priority devices and ports of the config being replaced (user data, empty by
# default in sqm.config). Read under the 2.0.0 name, else under the 1.x name.
KEEP_OPTIONS="priority_ip:gaming_ip priority_ip6:gaming_ip6 priority_udp_ports:gaming_udp_ports priority_tcp_ports:gaming_tcp_ports"
PREV_KEEP=""
if [ "$DRY_RUN" = "0" ] && [ -f /etc/config/sqm ]; then
    if [ "$(uci -q get sqm.@queue[0].script)" = "Seg_Layer_Cake.qos" ]; then
        PREV_DOWNLOAD="$(uci -q get sqm.@queue[0].download)"
        PREV_UPLOAD="$(uci -q get sqm.@queue[0].upload)"
        for _pair in $KEEP_OPTIONS; do
            _new="${_pair%%:*}"; _old="${_pair#*:}"
            _val="$(uci -q get "sqm.@queue[0].$_new")" || _val="$(uci -q get "sqm.@queue[0].$_old")" || _val=""
            [ -n "$_val" ] && PREV_KEEP="$PREV_KEEP $_new=$_val"
        done
    fi
fi

# Back up the ACTIVE config before overwriting it. Unlike .orig (written once,
# at first install, and restored by uninstall.sh), this runs on EVERY overwrite
# so an update never discards a user-customised config.
backup_active_sqm() {
    [ -f /etc/config/sqm ] || return 0

    # Skip when the active config is already saved: either as .orig (first
    # install) or as the most recent .bak- (nothing changed since). Comparing
    # against the shipped sqm.config would never match, since install.sh
    # rewrites interface/enabled/script via UCI right after copying it.
    if [ -f /etc/config/sqm.orig ] && cmp -s /etc/config/sqm /etc/config/sqm.orig; then
        info "Active SQM config already saved as /etc/config/sqm.orig — no backup needed"
        return 0
    fi

    _last=""
    for _f in /etc/config/sqm.bak-*; do
        [ -f "$_f" ] && _last="$_f"
    done
    if [ -n "$_last" ] && cmp -s /etc/config/sqm "$_last"; then
        info "Active SQM config unchanged since $_last — no backup needed"
        return 0
    fi
    _bak="/etc/config/sqm.bak-$(date +%Y%m%d-%H%M%S)"
    if cp /etc/config/sqm "$_bak"; then
        ok "Active SQM config backed up → $_bak"
    else
        warn "Could not back up active SQM config — aborting overwrite"
        return 1
    fi
}

if [ "$DRY_RUN" = "0" ]; then
    if [ -f /etc/config/sqm ] && [ ! -f /etc/config/sqm.orig ]; then
        if cmp -s /etc/config/sqm sqm/sqm.config; then
            info "Existing /etc/config/sqm is already the custom version — skipping backup"
        else
            info "Backing up existing SQM config → /etc/config/sqm.orig"
            cp /etc/config/sqm /etc/config/sqm.orig
        fi
    fi

    if [ -f /etc/config/sqm ] && [ "$FORCE" = "0" ]; then
        printf "\n${YEL}[?]${RST} An SQM configuration already exists.\n"
        printf "    Overwrite with custom config? [y/N]: "
        read -r REPLY
        case "$REPLY" in
            [oOyY])
                if backup_active_sqm; then
                    info "Replacing SQM config"
                    cp sqm/sqm.config /etc/config/sqm
                    SQM_CFG_REPLACED=1
                else
                    warn "SQM config kept — backup failed"
                fi
                ;;
            *)
                warn "SQM config kept — you will need to select Seg_Layer_Cake.qos manually in LuCI"
                ;;
        esac
    else
        if backup_active_sqm; then
            cp sqm/sqm.config /etc/config/sqm
            SQM_CFG_REPLACED=1
        else
            warn "SQM config kept — backup failed"
        fi
    fi
else
    info "[DRY-RUN] Copy sqm/sqm.config → /etc/config/sqm"
fi

# =============================================================================
# Migrate option names renamed in 2.0.0 (old name -> new name), on every
# SQM queue section. The value moves to the new name; the old one is removed.
# An option already set under its new name is left as it is.
# =============================================================================
LEGACY_OPTIONS="gaming_ip:priority_ip gaming_ip6:priority_ip6 gaming_udp_ports:priority_udp_ports gaming_tcp_ports:priority_tcp_ports gaming_bulk_enable:bulk_enable gaming_bulk_dscp:bulk_dscp"

migrate_legacy_options() {
    [ -f /etc/config/sqm ] || return 0
    _moved=0
    for _sec in $(uci -q show sqm | sed -n "s/^sqm\.\([^.=]*\)=queue$/\1/p"); do
        for _pair in $LEGACY_OPTIONS; do
            _old="${_pair%%:*}"; _new="${_pair#*:}"
            _val="$(uci -q get "sqm.$_sec.$_old")" || continue
            if [ -z "$(uci -q get "sqm.$_sec.$_new")" ]; then
                uci set "sqm.$_sec.$_new=$_val"
            fi
            uci delete "sqm.$_sec.$_old"
            _moved=$((_moved + 1))
        done
    done
    if [ "$_moved" -gt 0 ]; then
        uci commit sqm
        ok "Migrated $_moved option(s) to their 2.0.0 names"
    else
        info "No option to migrate"
    fi
}

if [ "$DRY_RUN" = "0" ]; then
    migrate_legacy_options
else
    info "[DRY-RUN] Migrate renamed options in /etc/config/sqm (if any)"
fi

# =============================================================================
# Install: SQM script .qos
# =============================================================================
info "Installing SQM script Seg_Layer_Cake.qos (v$VERSION)"

do_run mkdir -p /usr/lib/sqm
do_run cp sqm/Seg_Layer_Cake.qos /usr/lib/sqm/Seg_Layer_Cake.qos
do_run chmod 0755 /usr/lib/sqm/Seg_Layer_Cake.qos

ok "Seg_Layer_Cake.qos installed"

if [ "$DRY_RUN" = "0" ]; then
    printf '%s\n' "$VERSION" > "$VERSION_FILE"
    ok "Version $VERSION recorded → $VERSION_FILE"
else
    info "[DRY-RUN] echo $VERSION > $VERSION_FILE"
fi

# =============================================================================
# Install: custom LuCI SQM view (sqm.js)
# =============================================================================
info "Installing custom LuCI SQM view"

do_run mkdir -p /www/luci-static/resources/view/network

if [ "$DRY_RUN" = "0" ]; then
    if [ -f /www/luci-static/resources/view/network/sqm.js ] && \
       [ ! -f /www/luci-static/resources/view/network/sqm.js.orig ]; then
        if cmp -s /www/luci-static/resources/view/network/sqm.js sqm/sqm.js; then
            info "Existing sqm.js is already the custom version — skipping backup"
        else
            info "Backing up original sqm.js → sqm.js.orig"
            cp /www/luci-static/resources/view/network/sqm.js \
               /www/luci-static/resources/view/network/sqm.js.orig
        fi
    fi
    cp sqm/sqm.js /www/luci-static/resources/view/network/sqm.js
else
    info "[DRY-RUN] Copy sqm/sqm.js → /www/luci-static/resources/view/network/sqm.js"
fi

ok "LuCI SQM view installed"

# =============================================================================
# Install: diagnostic tool (optional)
# =============================================================================
if [ -f "tools/dscp-validate.sh" ]; then
    info "Installing diagnostic tool"
    do_run cp tools/dscp-validate.sh /root/dscp-validate.sh
    do_run chmod 0755 /root/dscp-validate.sh
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

if [ "$DRY_RUN" = "0" ] && [ "$SQM_CFG_REPLACED" = "1" ]; then
    # Defensive: ensure @queue[0] exists before setting (A2-4)
    uci -q get sqm.@queue[0] >/dev/null 2>&1 || uci add sqm queue >/dev/null
    uci set sqm.@queue[0].interface="$WAN_IFACE"
    uci set sqm.@queue[0].enabled='1'
    uci set sqm.@queue[0].script='Seg_Layer_Cake.qos'

    if [ -n "$PREV_DOWNLOAD" ] && [ -n "$PREV_UPLOAD" ]; then
        uci set sqm.@queue[0].download="$PREV_DOWNLOAD"
        uci set sqm.@queue[0].upload="$PREV_UPLOAD"
        ok "Bandwidth kept from the previous install: ${PREV_DOWNLOAD}/${PREV_UPLOAD} Kbps"
    else
        warn "SQM will start at the example rates of sqm.config (100000/20000 Kbps)."
        warn "→ Set your measured rates in LuCI: Network → SQM QoS → Basic Settings"
    fi

    # Values never hold spaces (IP / port lists are comma separated)
    for _kv in $PREV_KEEP; do
        uci set "sqm.@queue[0].$_kv"
        ok "Kept from the previous install: ${_kv%%=*}"
    done

    uci commit sqm
    ok "SQM UCI configuration applied"
elif [ "$DRY_RUN" = "0" ]; then
    info "Existing SQM config preserved — UCI pre-configuration skipped"
    info "→ In LuCI: select 'Seg_Layer_Cake.qos' as Queue Discipline script"
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

        # SQM is not a procd daemon, so `/etc/init.d/sqm running` always
        # reports false; test the qdisc instead. Calling `restart` while
        # stopped makes procd print "Command failed: Not found" from the
        # stop half of the restart, which happens on any install following
        # an uninstall.
        if tc qdisc show dev "$WAN_IFACE" 2>/dev/null | grep -q cake; then
            if /etc/init.d/sqm restart; then
                ok "SQM service restarted"
            else
                warn "SQM did not start correctly — check bandwidth settings in LuCI"
            fi
        else
            if /etc/init.d/sqm start; then
                ok "SQM service started"
            else
                warn "SQM did not start correctly — check bandwidth settings in LuCI"
            fi
        fi
    fi

    if [ -x /etc/init.d/serverrules ]; then
        /etc/init.d/serverrules enable
        # start, not restart: no procd instance, so the stop half of restart
        # prints "Command failed: ... (Not found)". start reloads the rules.
        /etc/init.d/serverrules start && ok "Server Rules started" || \
            warn "Server Rules did not start — check: /usr/libexec/serverrules/serverrules.sh"
    fi
    if [ "$LAGSIM_PKG" = "0" ] && [ -x /etc/init.d/lagsim ]; then
        # start registers the reload trigger with procd: without it, Save &
        # Apply in LuCI changes /etc/config/lagsim but nothing is applied.
        # Harmless while disabled (apply only tears down).
        /etc/init.d/lagsim enable
        /etc/init.d/lagsim start
        ok "Lag Simulator service enabled"
    fi

    # LuCI caches the menu tree; drop it so the new tabs show up at once
    rm -f /tmp/luci-indexcache* 2>/dev/null || true
    [ -x /etc/init.d/rpcd ]   && /etc/init.d/rpcd restart   && ok "rpcd restarted"
    [ -x /etc/init.d/uhttpd ] && /etc/init.d/uhttpd restart && ok "uhttpd restarted"
else
    info "[DRY-RUN] Start serverrules, enable lagsim, restart sqm / rpcd / uhttpd skipped"
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
if [ "$SQM_CFG_REPLACED" = "1" ] || [ "$DRY_RUN" = "1" ]; then
    printf "  Installed version        : v%s\n" "$VERSION"
    printf "  Configured WAN interface: %s\n" "$WAN_IFACE"
    printf "  Active SQM script        : Seg_Layer_Cake.qos\n"
else
    printf "  Detected WAN interface   : %s (existing config preserved — verify in LuCI)\n" "$WAN_IFACE"
    printf "  Active SQM script        : (existing config preserved — set manually in LuCI)\n"
fi
printf "\n"
printf "${YEL}  IMPORTANT — Post-installation steps:${RST}\n"
printf "  1. LuCI → Network → SQM QoS\n"
printf "     → Verify the WAN interface\n"
printf "     → Configure download / upload bandwidth\n"
printf "     → Configure Link layer / overhead\n"
printf "  2. LuCI → Network → SQM QoS → tabs\n"
printf "     → Connections, Server Rules, Server History, Captures, Lag Simulator\n"
if [ -f /root/dscp-validate.sh ] || [ -f tools/dscp-validate.sh ]; then
    printf "  3. Validate the install:\n"
    printf "     /root/dscp-validate.sh\n"
    printf "     (use --anonymize when sharing the report publicly)\n"
fi
printf "\n"
printf "  To uninstall: sh uninstall.sh\n"
printf "\n"
