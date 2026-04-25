#!/bin/sh
# =============================================================================
# DSCP / SQM / CAKE Validation Report
# =============================================================================
# Auto-detects:
#   - nftables table sqm_dscp + all rule counters
#   - WAN interface from UCI sqm config
#   - IFB ingress interface (ifb4<wan>)
#   - CAKE per-tin stats (upload + download)
#   - UCI config of priority/gaming policies
#
# Usage:
#   /root/dscp-validate.sh                     # full report (with real IPs/hostname)
#   /root/dscp-validate.sh --anonymize         # mask IPs and hostname (safe to share)
#   /root/dscp-validate.sh --anonymize | tee report.txt
#
# Output is plain text, safe to redirect to a file and share for support.
# Designed for openwrt-custom v1.3+ (Seg_Layer_Cake.qos).
# =============================================================================

# Parse command-line arguments
ANONYMIZE=0
for arg in "$@"; do
    case "$arg" in
        --anonymize|-a)
            ANONYMIZE=1
            ;;
        --help|-h)
            echo "Usage: $0 [--anonymize|-a] [--help|-h]"
            echo ""
            echo "  --anonymize, -a   Mask IPs, hostname and IPv6 prefix in output"
            echo "                    (recommended when sharing the report publicly)"
            echo "  --help, -h        Show this help message"
            exit 0
            ;;
    esac
done

DATE_STR="$(date '+%Y-%m-%d %H:%M:%S')"
HOSTNAME_STR="$(uname -n)"
KERNEL_STR="$(uname -r)"
OPENWRT_VER="$(grep DISTRIB_DESCRIPTION /etc/openwrt_release 2>/dev/null | sed -e "s/^[^=]*=//" -e "s/^['\"]//" -e "s/['\"]$//")"

if [ "$ANONYMIZE" = "1" ]; then
    HOSTNAME_STR="<anonymized-host>"
fi

print_header() {
    echo "===================================================================="
    echo "          openwrt-custom — DSCP / SQM / CAKE VALIDATION"
    echo "===================================================================="
    echo "  Date         : $DATE_STR"
    echo "  Host         : $HOSTNAME_STR"
    echo "  OpenWrt      : ${OPENWRT_VER:-unknown}"
    echo "  Kernel       : $KERNEL_STR"
    if [ "$ANONYMIZE" = "1" ]; then
        echo "  Mode         : ANONYMIZED (safe to share publicly)"
    fi
    echo "===================================================================="
    echo ""
}

print_section() {
    echo ""
    echo "--- $1 ---"
}

# ----------------------------------------------------------------------------
# Section 1 — Detect WAN + IFB interfaces from UCI/kernel
# ----------------------------------------------------------------------------
detect_interfaces() {
    WAN_IF="$(uci -q get sqm.@queue[0].interface)"
    if [ -z "$WAN_IF" ]; then
        WAN_IF="$(ip route | awk '/^default/ {print $5; exit}')"
    fi
    IFB_IF="ifb4${WAN_IF}"
    if ! ip link show "$IFB_IF" >/dev/null 2>&1; then
        IFB_IF="$(ip link show 2>/dev/null | awk -F': ' '/ifb/ {print $2; exit}')"
    fi
}

print_header
detect_interfaces

# ----------------------------------------------------------------------------
print_section "1. Interfaces detected"
echo "  WAN interface  : ${WAN_IF:-(not detected)}"
echo "  IFB interface  : ${IFB_IF:-(not detected)}"

# ----------------------------------------------------------------------------
print_section "2. UCI SQM configuration (active)"
if uci -q show sqm >/dev/null 2>&1; then
    if [ "$ANONYMIZE" = "1" ]; then
        # Replace gaming_ip values with placeholders
        uci -q show sqm | grep -E "@queue\[0\]" | sed \
            -e "s|gaming_ip='[^']*'|gaming_ip='<USER-IPV4>'|g" \
            -e "s|gaming_ip6='[^']*'|gaming_ip6='<USER-IPV6-PREFIX>'|g" \
            | sed 's/^/  /'
    else
        uci -q show sqm | grep -E "@queue\[0\]" | sed 's/^/  /'
    fi
else
    echo "  (UCI sqm config not available)"
fi

# ----------------------------------------------------------------------------
print_section "3. nftables table 'sqm_dscp' status"
if nft list table inet sqm_dscp >/dev/null 2>&1; then
    echo "  ✓ Table sqm_dscp is LOADED"
    RULES_TOTAL="$(nft list table inet sqm_dscp | grep -c 'comment')"
    echo "  Total rules with comments: $RULES_TOTAL"
else
    echo "  ✗ Table sqm_dscp is NOT loaded"
    echo "  (SQM script may not be active — check Seg_Layer_Cake.qos installation)"
    exit 1
fi

# ----------------------------------------------------------------------------
# Helper: list rules matching a comment pattern, formatted with packets/bytes
# Usage: print_rules <pattern> <label>
# ----------------------------------------------------------------------------
print_rules() {
    pattern="$1"
    label="$2"
    matches="$(nft list table inet sqm_dscp 2>/dev/null | grep -E "comment.*$pattern")"
    if [ -z "$matches" ]; then
        echo "  (no rules found for pattern: $pattern)"
        return
    fi
    echo "$matches" | while IFS= read -r line; do
        cmt="$(echo "$line" | sed -n 's/.*comment "\([^"]*\)".*/\1/p')"
        pkts="$(echo "$line" | sed -n 's/.*counter packets \([0-9]*\) .*/\1/p')"
        bytes="$(echo "$line" | sed -n 's/.*counter packets [0-9]* bytes \([0-9]*\) .*/\1/p')"
        # Format bytes human-readable
        if [ -z "$bytes" ] || [ "$bytes" = "0" ]; then
            hr="0 B"
        elif [ "$bytes" -lt 1024 ]; then
            hr="${bytes} B"
        elif [ "$bytes" -lt 1048576 ]; then
            hr="$((bytes / 1024)) KB"
        elif [ "$bytes" -lt 1073741824 ]; then
            hr="$((bytes / 1048576)) MB"
        else
            hr="$((bytes / 1073741824)) GB"
        fi
        printf "  %-20s  pkts=%-12s  bytes=%-15s\n" "$cmt" "${pkts:-?}" "$hr"
    done
}

# ----------------------------------------------------------------------------
print_section "4. Priority UDP rules (gaming traffic → CS4 by default)"
print_rules "PrioUDP" "Priority UDP"

# ----------------------------------------------------------------------------
print_section "5. Priority TCP rules (gaming traffic → AF41 by default)"
print_rules "PrioTCP" "Priority TCP"

# ----------------------------------------------------------------------------
print_section "6. Bulk TCP rules (web/HTTPS → CS1)"
print_rules "BulkTCP" "Bulk TCP"

# ----------------------------------------------------------------------------
print_section "7. Bulk UDP rules (UDP web → CS1)"
print_rules "BulkUDP" "Bulk UDP"

# ----------------------------------------------------------------------------
print_section "8. Big HTTPS auto-downgrade (>1000 bytes → CS1)"
print_rules "BigHTTPS" "Big HTTPS"

# ----------------------------------------------------------------------------
print_section "9. MicroPkt UDP rules (<150 bytes on gaming ports → CS6)"
print_rules "MicroPktUDP" "MicroPkt UDP"

# ----------------------------------------------------------------------------
print_section "10. SmallPkt UDP rules (150-300 bytes on gaming ports → priority DSCP)"
print_rules "SmallPktUDP" "SmallPkt UDP"

# ----------------------------------------------------------------------------
print_section "11. MicroPkt TCP rules"
print_rules "MicroPktTCP" "MicroPkt TCP"

# ----------------------------------------------------------------------------
print_section "12. SmallPkt TCP rules"
print_rules "SmallPktTCP" "SmallPkt TCP"

# ----------------------------------------------------------------------------
print_section "13. Browsing rules (CS0 web traffic → AF21)"
print_rules "Brows" "Browsing"

# ----------------------------------------------------------------------------
print_section "14. Conntrack mark storage (DSCP→ctmark)"
print_rules "Store" "Store ctmark"

# ----------------------------------------------------------------------------
print_section "15. CAKE qdisc summary"
echo ""
echo "  >>> UPLOAD direction (dev $WAN_IF) <<<"
if [ -n "$WAN_IF" ] && tc qdisc show dev "$WAN_IF" 2>/dev/null | grep -q cake; then
    tc -s qdisc show dev "$WAN_IF" 2>/dev/null | head -5 | sed 's/^/    /'
else
    echo "    (no CAKE qdisc on $WAN_IF)"
fi

echo ""
echo "  >>> DOWNLOAD direction (dev $IFB_IF) <<<"
if [ -n "$IFB_IF" ] && tc qdisc show dev "$IFB_IF" 2>/dev/null | grep -q cake; then
    tc -s qdisc show dev "$IFB_IF" 2>/dev/null | head -5 | sed 's/^/    /'
else
    echo "    (no CAKE qdisc on $IFB_IF)"
fi

# ----------------------------------------------------------------------------
print_section "16. CAKE per-tin latency (Voice = gaming tin)"
echo ""
print_tin_summary() {
    dev="$1"
    direction="$2"
    if [ -z "$dev" ] || ! tc qdisc show dev "$dev" 2>/dev/null | grep -q cake; then
        return
    fi
    echo "  >>> $direction ($dev) <<<"
    # Take only the first qdisc block for clarity (one CPU thread shows the pattern)
    tc -s qdisc show dev "$dev" 2>/dev/null | awk '
        /Bulk  Best Effort/ {found=1; print "    " $0; next}
        found && /^[[:space:]]+(thresh|target|interval|pk_delay|av_delay|backlog|pkts|bytes|drops|marks|max_len)/ {
            print "    " $0
            count++
            if (count >= 11) exit
        }
    '
    echo ""
}
print_tin_summary "$WAN_IF" "UPLOAD"
print_tin_summary "$IFB_IF" "DOWNLOAD"

# ----------------------------------------------------------------------------
print_section "17. Overall packet count summary"
SENT_UP="$(tc -s qdisc show dev "$WAN_IF" 2>/dev/null | awk '/Sent/ {print $2; exit}')"
SENT_DOWN="$(tc -s qdisc show dev "$IFB_IF" 2>/dev/null | awk '/Sent/ {print $2; exit}')"
DROP_UP="$(tc -s qdisc show dev "$WAN_IF" 2>/dev/null | sed -n 's/.*dropped \([0-9]*\).*/\1/p' | head -1)"
DROP_DOWN="$(tc -s qdisc show dev "$IFB_IF" 2>/dev/null | sed -n 's/.*dropped \([0-9]*\).*/\1/p' | head -1)"

# Helper to format bytes humanly
hr_bytes() {
    n="${1:-0}"
    if [ "$n" -lt 1024 ] 2>/dev/null; then echo "$n B"
    elif [ "$n" -lt 1048576 ] 2>/dev/null; then echo "$((n / 1024)) KB"
    elif [ "$n" -lt 1073741824 ] 2>/dev/null; then echo "$((n / 1048576)) MB"
    else echo "$((n / 1073741824)) GB"
    fi
}

echo "  Upload   sent: $(hr_bytes "${SENT_UP:-0}")    dropped: ${DROP_UP:-0} pkts"
echo "  Download sent: $(hr_bytes "${SENT_DOWN:-0}")  dropped: ${DROP_DOWN:-0} pkts"

# ----------------------------------------------------------------------------
print_section "18. Conntrack statistics for priority device"
PRIO_IP4="$(uci -q get sqm.@queue[0].gaming_ip)"
PRIO_IP6="$(uci -q get sqm.@queue[0].gaming_ip6)"

# Display labels (anonymized or real)
if [ "$ANONYMIZE" = "1" ]; then
    PRIO_IP4_DISP="<USER-IPV4>"
    PRIO_IP6_DISP="<USER-IPV6-PREFIX>"
else
    PRIO_IP4_DISP="$PRIO_IP4"
    PRIO_IP6_DISP="$PRIO_IP6"
fi

echo "  Priority IPv4 : ${PRIO_IP4_DISP:-(not set)}"
echo "  Priority IPv6 : ${PRIO_IP6_DISP:-(not set)}"
if [ -n "$PRIO_IP4" ]; then
    CT_IP4_S="$(conntrack -L -s "$PRIO_IP4" 2>/dev/null | grep -cE 'tcp|udp|icmp')"
    CT_IP4_D="$(conntrack -L -d "$PRIO_IP4" 2>/dev/null | grep -cE 'tcp|udp|icmp')"
    echo "  Active conntrack entries (IPv4 src=$PRIO_IP4_DISP): ${CT_IP4_S:-0}"
    echo "  Active conntrack entries (IPv4 dst=$PRIO_IP4_DISP): ${CT_IP4_D:-0}"
fi
if [ -n "$PRIO_IP6" ]; then
    PRIO_IP6_PREFIX="$(echo "$PRIO_IP6" | cut -d/ -f1 | sed 's/::$/:/')"
    CT_IP6="$(conntrack -L -f ipv6 2>/dev/null | grep -E 'tcp|udp|icmp' | grep -c "$PRIO_IP6_PREFIX")"
    echo "  Active conntrack entries (IPv6 prefix $PRIO_IP6_DISP): ${CT_IP6:-0}"
fi

# ----------------------------------------------------------------------------
print_section "19. ctinfo / kernel module status"
echo "  ct_dscpremark module : $(grep -c '^xt_dscp\|^cls_ctinfo' /proc/modules 2>/dev/null) loaded matches"
CTINFO_ENABLE="$(uci -q get sqm.@queue[0].ctinfo_enable)"
echo "  UCI ctinfo_enable    : ${CTINFO_ENABLE:-0} (1=ON, 0=OFF)"

# ----------------------------------------------------------------------------
echo ""
echo "===================================================================="
echo "  Quick health check :"
echo ""
PRIO_PKTS="$(nft list table inet sqm_dscp 2>/dev/null | grep -E 'PrioUDPup4|PrioUDPdwn4' | sed -n 's/.*counter packets \([0-9]*\) .*/\1/p' | awk '{s+=$1} END {print s}')"
BULK_PKTS="$(nft list table inet sqm_dscp 2>/dev/null | grep -E 'BulkTCP' | sed -n 's/.*counter packets \([0-9]*\) .*/\1/p' | awk '{s+=$1} END {print s}')"

[ "${PRIO_PKTS:-0}" -gt 0 ] 2>/dev/null \
    && echo "  ✓ Priority UDP IPv4 has matched ${PRIO_PKTS} packets (gaming detected)" \
    || echo "  ⚠ No Priority UDP IPv4 traffic seen yet (start a game session)"

[ "${BULK_PKTS:-0}" -gt 0 ] 2>/dev/null \
    && echo "  ✓ Bulk TCP has matched ${BULK_PKTS} packets (web traffic classified)" \
    || echo "  ⚠ No Bulk TCP traffic seen yet"

echo ""
if [ "$ANONYMIZE" = "1" ]; then
    echo "  [ANONYMIZED MODE — IPs and hostname masked for safe public sharing]"
fi
echo "  End of report. Generated $DATE_STR"
echo "===================================================================="