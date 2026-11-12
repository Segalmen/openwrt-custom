#!/bin/sh
# =============================================================================
# serverrules.sh — block remote server ranges (IPv4 CIDR), both directions
# Project : openwrt-custom (Segalmen)
# Config  : /etc/config/serverrules  (disabled rules are labels only)
# nft     : table inet serverrules, set "blocked", chain prerouting (-150)
# The whole table is rebuilt in ONE nft transaction: either the new table
# replaces the old one, or nothing changes (the previous table stays).
# =============================================================================

. /lib/functions.sh

TABLE="serverrules"
SET="blocked"
NFT="/usr/sbin/nft"
MIN_PREFIX=8

log() { logger -t serverrules "$*"; }

config_load serverrules

# Global switch, read as an OpenWrt boolean (0/off/false/no/disabled = off;
# missing section, missing option or unknown value = enabled). A config may
# hold several global sections (e.g. an empty anonymous one left by a
# template): any of them set to off disables blocking, whatever their order.
GLOBAL_ENABLED=1
GLOBAL_COUNT=0
read_global() {
    local enabled
    config_get_bool enabled "$1" enabled 1
    GLOBAL_COUNT=$((GLOBAL_COUNT + 1))
    [ "$enabled" = "0" ] && GLOBAL_ENABLED=0
    return 0
}
config_foreach read_global global
[ "$GLOBAL_COUNT" -gt 1 ] && \
    log "Multiple global sections found ($GLOBAL_COUNT): any of them set to off disables blocking"

# Globally disabled: remove the table and stop here
if [ "$GLOBAL_ENABLED" != "1" ]; then
    $NFT delete table inet $TABLE 2>/dev/null
    log "Blocking globally disabled: table removed"
    exit 0
fi

ELEMENTS=""
COUNT=0
PFX=""

# parse_range <a.b.c.d[/p]> : strict IPv4 check, sets PFX (32 if absent).
# Returns 1 on anything else, so nothing unchecked ever reaches nft.
parse_range() {
    local ip o
    case "$1" in
        */*) ip="${1%/*}"; PFX="${1##*/}" ;;
        *)   ip="$1"; PFX=32 ;;
    esac
    case "$PFX" in ''|*[!0-9]*|0?*|???*) return 1 ;; esac
    [ "$PFX" -le 32 ] || return 1
    case "$ip" in ''|*[!0-9.]*|.*|*.|*..*) return 1 ;; esac
    local IFS=.
    set -- $ip
    [ $# -eq 4 ] || return 1
    for o in "$@"; do
        case "$o" in 0?*|????*) return 1 ;; esac
        [ "$o" -le 255 ] || return 1
    done
    return 0
}

add_range() {
    # Guard: skip private/reserved ranges (self-ban protection). Mirrors the
    # UI validation in case /etc/config/serverrules is edited by hand.
    case "$1" in
        10.*|127.*|0.*|192.168.*|169.254.*|22[4-9].*|2[3-5][0-9].*|\
        172.1[6-9].*|172.2[0-9].*|172.3[01].*)
            log "Refused private/reserved range: $1"
            return 0 ;;
    esac
    if ! parse_range "$1"; then
        log "Invalid range skipped: $1"
        return 0
    fi
    if [ "$PFX" -lt "$MIN_PREFIX" ]; then
        log "Refused range wider than /$MIN_PREFIX: $1"
        return 0
    fi
    ELEMENTS="${ELEMENTS:+$ELEMENTS, }$1"
    COUNT=$((COUNT + 1))
}

# Rule state, read as an OpenWrt boolean like the global switch: only an
# off value makes the rule a label; missing or unknown value = blocking.
load_rule() {
    local enabled
    config_get_bool enabled "$1" enabled 1
    [ "$enabled" = "0" ] && return 0
    config_list_foreach "$1" range add_range
}
config_foreach load_rule rule

# One transaction: "table" makes sure it exists so that "delete" cannot
# fail, then the table is created again with its full content. Any error
# aborts the whole transaction and the previous table is left untouched.
ERR=$({
    echo "table inet $TABLE"
    echo "delete table inet $TABLE"
    echo "table inet $TABLE {"
    echo "    set $SET {"
    echo "        type ipv4_addr"
    echo "        flags interval"
    echo "        auto-merge"
    [ -n "$ELEMENTS" ] && echo "        elements = { $ELEMENTS }"
    echo "    }"
    echo "    chain prerouting {"
    echo "        type filter hook prerouting priority -150; policy accept;"
    echo "        ip daddr @$SET counter drop comment \"serverrules: to blocked range\""
    echo "        ip saddr @$SET counter drop comment \"serverrules: from blocked range\""
    echo "    }"
    echo "}"
} | $NFT -f - 2>&1) || {
    log "nft load failed, previous table left unchanged: $ERR"
    exit 1
}

log "Loaded $COUNT range(s)"
exit 0
