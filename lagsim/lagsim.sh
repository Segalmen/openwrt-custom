#!/bin/sh
# lagsim - per-device network condition simulator (netem)
# Matches devices by MAC with tc flower on one interface and redirects
# their packets through an ifb + netem queue per direction.
# Only adds latency / jitter / loss; never touches the root qdisc or SQM.
# SPDX-License-Identifier: GPL-2.0-or-later

. /lib/functions.sh

STATE=/var/run/lagsim
DISTDIR=/usr/lib/tc
PREF_BASE=49150
MAX_TARGETS=32

log() { logger -t lagsim "$*"; }

is_uint() { case "$1" in ''|*[!0-9]*) return 1;; esac; return 0; }

is_loss() {
	case "$1" in ''|*[!0-9.]*|*.*.*|.*|*.) return 1;; esac
	[ "${1%%.*}" -le 100 ] 2>/dev/null || return 1
	[ "${1%%.*}" -lt 100 ] || case "$1" in 100|100.0*) ;; *) return 1;; esac
	return 0
}

is_mac() { echo "$1" | grep -qiE '^([0-9a-f]{2}:){5}[0-9a-f]{2}$'; }

# netem arguments: netem_args <delay_ms> <jitter_ms> <loss_pct> <distribution>
netem_args() {
	local a="limit 10000"
	if [ "$1" -gt 0 ] || [ "$2" -gt 0 ]; then
		a="$a delay ${1}ms"
		if [ "$2" -gt 0 ]; then
			a="$a ${2}ms"
			[ "$4" = uniform ] || a="$a distribution $4"
		fi
	fi
	case "$3" in *[1-9]*) a="$a loss ${3}%";; esac
	echo "$a"
}

# one direction: add_dir <dev> <idx> <d|u> <mac> <delay> <jitter> <loss> <distribution>
add_dir() {
	local dev="$1" idx="$2" d="$3" mac="$4" ifb="lsim$2$3" pref=$((PREF_BASE + $2)) hook key err
	[ "$5" -gt 0 ] || [ "$6" -gt 0 ] || case "$7" in *[1-9]*) ;; *) return 0;; esac
	if [ "$d" = d ]; then hook=egress; key=dst_mac; else hook=ingress; key=src_mac; fi

	ip link add "$ifb" type ifb 2>/dev/null
	echo "$ifb" >> "$STATE/ifbs"
	ip link set "$ifb" up || { log "cannot bring up $ifb"; return 1; }
	if ! err="$(tc qdisc replace dev "$ifb" root netem $(netem_args "$5" "$6" "$7" "$8") 2>&1)"; then
		log "netem on $ifb failed: $err"; return 1
	fi
	if ! err="$(tc filter add dev "$dev" "$hook" pref "$pref" protocol all \
		flower "$key" "$mac" action mirred egress redirect dev "$ifb" 2>&1)"; then
		log "filter on $dev $hook failed: $err"; return 1
	fi
	echo "$hook $pref" >> "$STATE/filters"
}

add_target() {
	local cfg="$1" en mac dir delay jitter loss dist name dd dj ud uj
	[ "$IDX" -lt "$MAX_TARGETS" ] || { log "more than $MAX_TARGETS devices - $cfg ignored"; return; }
	config_get_bool en "$cfg" enabled 1
	[ "$en" = 1 ] || return
	config_get mac "$cfg" mac
	config_get name "$cfg" name "$cfg"
	config_get dir "$cfg" direction both
	config_get delay "$cfg" delay 0
	config_get jitter "$cfg" jitter 0
	config_get loss "$cfg" loss 0
	config_get dist "$cfg" distribution uniform

	is_mac "$mac" || { log "$name: invalid MAC '$mac' - ignored"; return; }
	is_uint "$delay" && [ "$delay" -le 5000 ] || { log "$name: invalid delay - ignored"; return; }
	is_uint "$jitter" && [ "$jitter" -le 2000 ] || { log "$name: invalid jitter - ignored"; return; }
	is_loss "$loss" || { log "$name: invalid loss - ignored"; return; }
	case "$dist" in
		uniform) ;;
		normal|pareto|paretonormal)
			[ -f "$DISTDIR/$dist.dist" ] || { log "$name: $DISTDIR/$dist.dist missing - uniform used"; dist=uniform; };;
		*) log "$name: unknown distribution '$dist' - uniform used"; dist=uniform;;
	esac

	# "both": the round trip passes the queue twice, so delay and jitter are
	# split between the two directions (the total equals what was asked)
	case "$dir" in
		down) dd=$delay; dj=$jitter; ud=0; uj=0;;
		up)   dd=0; dj=0; ud=$delay; uj=$jitter;;
		*)    dir=both; dd=$((delay / 2)); ud=$((delay - dd)); dj=$((jitter / 2)); uj=$((jitter - dj));;
	esac

	[ "$dir" = up ]   || add_dir "$DEV" "$IDX" d "$mac" "$dd" "$dj" "$loss" "$dist"
	[ "$dir" = down ] || add_dir "$DEV" "$IDX" u "$mac" "$ud" "$uj" "$loss" "$dist"
	log "$name ($mac): $dir, delay ${delay}ms, jitter ${jitter}ms ($dist), loss ${loss}%"
	IDX=$((IDX + 1))
}

teardown() {
	local dev hook pref ifb
	[ -d "$STATE" ] || return 0
	dev="$(cat "$STATE/device" 2>/dev/null)"
	if [ -n "$dev" ] && [ -f "$STATE/filters" ]; then
		while read -r hook pref; do
			tc filter del dev "$dev" "$hook" pref "$pref" 2>/dev/null
		done < "$STATE/filters"
	fi
	# clsact is removed only if lagsim added it and nothing else uses it
	if [ -n "$dev" ] && [ -f "$STATE/clsact_created" ] && \
	   [ -z "$(tc filter show dev "$dev" ingress 2>/dev/null)" ] && \
	   [ -z "$(tc filter show dev "$dev" egress 2>/dev/null)" ]; then
		tc qdisc del dev "$dev" clsact 2>/dev/null
	fi
	if [ -f "$STATE/ifbs" ]; then
		for ifb in $(sort -u "$STATE/ifbs"); do
			ip link del "$ifb" 2>/dev/null
		done
	fi
	rm -rf "$STATE"
}

apply() {
	local en
	teardown
	config_load lagsim
	config_get_bool en globals enabled 0
	config_get DEV globals device br-lan
	[ "$en" = 1 ] || { log "disabled"; return 0; }
	case "$DEV" in ''|-*|*[!A-Za-z0-9._@-]*) log "invalid interface '$DEV'"; return 1;; esac
	[ -d "/sys/class/net/$DEV" ] || { log "interface $DEV not present - nothing applied"; return 0; }

	mkdir -p "$STATE"
	echo "$DEV" > "$STATE/device"
	if ! tc qdisc show dev "$DEV" | grep -q 'clsact'; then
		tc qdisc add dev "$DEV" clsact || { log "cannot add clsact on $DEV"; teardown; return 1; }
		: > "$STATE/clsact_created"
	fi
	IDX=0
	config_foreach add_target target
	[ "$IDX" -gt 0 ] || { log "no active device"; teardown; }
	return 0
}

status() {
	local ifb
	if [ ! -d "$STATE" ]; then
		echo "inactive"
		return 0
	fi
	echo "interface: $(cat "$STATE/device")"
	for ifb in $(sort -u "$STATE/ifbs" 2>/dev/null); do
		case "$ifb" in *d) echo "-- $ifb (download)";; *) echo "-- $ifb (upload)";; esac
		tc -s qdisc show dev "$ifb" 2>/dev/null | grep -E 'netem|Sent'
	done
}

case "$1" in
	apply) apply;;
	teardown|stop) teardown;;
	status) status;;
	*) echo "usage: $0 apply|teardown|status"; exit 1;;
esac
