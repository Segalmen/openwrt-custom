#!/bin/sh
# =============================================================================
# serverrules.sh — block remote server ranges (IPv4 CIDR), both directions
# Project : openwrt-custom (Segalmen)
# Config  : /etc/config/serverrules  (rules with enabled='0' are labels only)
# nft     : table inet serverrules, set "blocked", chain prerouting
# =============================================================================

. /lib/functions.sh

TABLE="serverrules"
SET="blocked"
NFT="/usr/sbin/nft"

config_load serverrules

GLOBAL_ENABLED=1
read_global() {
    local enabled
    config_get enabled "$1" enabled 1
    GLOBAL_ENABLED="$enabled"
}
config_foreach read_global global

# Globally disabled: remove the table and stop here
if [ "$GLOBAL_ENABLED" != "1" ]; then
    $NFT delete table inet $TABLE 2>/dev/null
    exit 0
fi

# Rebuild the table from scratch (idempotent)
$NFT delete table inet $TABLE 2>/dev/null
$NFT -f - <<EOF || { logger -t serverrules "nft table creation failed"; exit 1; }
table inet $TABLE {
    set $SET {
        type ipv4_addr
        flags interval
        auto-merge
    }
    chain prerouting {
        type filter hook prerouting priority -150; policy accept;
        ip daddr @$SET counter drop comment "serverrules: to blocked range"
        ip saddr @$SET counter drop comment "serverrules: from blocked range"
    }
}
EOF

add_range() {
    # Guard: skip private/reserved ranges (self-ban protection). Mirrors the
    # UI validation in case /etc/config/serverrules is edited by hand.
    case "$1" in
        10.*|127.*|0.*|192.168.*|169.254.*|22[4-9].*|2[3-5][0-9].*|\
        172.1[6-9].*|172.2[0-9].*|172.3[01].*)
            logger -t serverrules "Refused private/reserved range: $1"
            return 0 ;;
    esac
    $NFT add element inet $TABLE $SET "{ $1 }" 2>/dev/null || \
        logger -t serverrules "Invalid range skipped: $1"
}

load_rule() {
    local enabled
    config_get enabled "$1" enabled 1
    [ "$enabled" = "1" ] || return 0
    config_list_foreach "$1" range add_range
}

config_foreach load_rule rule
exit 0
