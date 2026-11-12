'use strict';
// SPDX-License-Identifier: GPL-3.0-or-later
// DSCP Connections view (Network -> SQM QoS -> Connections).
// Derived from the Connections view of luci-app-qosmate by hudra0
// (https://github.com/hudra0/luci-app-qosmate, GPL-3.0-or-later),
// modified and extended by Segalmen for openwrt-custom.
'require view';
'require poll';
'require rpc';
'require ui';
'require uci';

// =============================================================================
// RPC call declarations
// =============================================================================
var callGetConntrackDSCP = rpc.declare({
    object: 'luci.dscp',
    method: 'getConntrackDSCP',
    expect: {}
});

var callFlushConntrack = rpc.declare({
    object: 'luci.dscp',
    method: 'flushConntrack',
    params: [ 'ip4', 'ip6' ],
    expect: {}
});

// manual server-history logging (explicit click only)
var callLogServer = rpc.declare({
    object: 'luci.dscp',
    method: 'logServer',
    params: [ 'ip', 'port', 'region', 'dscp' ],
    expect: {}
});

// create/extend a label rule (serverrules, enabled=0)
var callLabelServer = rpc.declare({
    object: 'luci.dscp',
    method: 'labelServer',
    params: [ 'name', 'cidr' ],
    expect: {}
});

// suggest a CIDR for an IP (read-only, no external API)
var callSuggestCidr = rpc.declare({
    object: 'luci.dscp',
    method: 'suggestCidr',
    params: [ 'ip' ],
    expect: {}
});

// start a tcpdump capture (br-lan, port-based by default)
var callStartCapture = rpc.declare({
    object: 'luci.dscp',
    method: 'startCapture',
    params: [ 'iface', 'ip', 'ports', 'duration', 'label' ],
    expect: {}
});

// list interfaces for the capture selector
var callListInterfaces = rpc.declare({
    object: 'luci.dscp',
    method: 'listInterfaces',
    expect: {}
});

// Ports captured by the 📷 Ports button: the priority UDP + TCP ports of
// the SQM DSCP policy (sqm.@queue[0].priority_udp_ports/priority_tcp_ports).
// Filled in render(); empty = no 📷 Ports button.
var PRIORITY_CAPTURE_PORTS = '';

// Split a UCI value written as "a,b c" (or a list) into clean tokens.
function splitList(v) {
    if (Array.isArray(v)) v = v.join(',');
    return String(v || '').split(/[\s,]+/).filter(function(x) { return x !== ''; });
}

// =============================================================================
// DSCP value → label mapping
// =============================================================================
var DSCP_MAP = {
    0:  'CS0',
    1:  'LE',
    8:  'CS1',
    10: 'AF11', 12: 'AF12', 14: 'AF13',
    16: 'CS2',
    18: 'AF21', 20: 'AF22', 22: 'AF23',
    24: 'CS3',
    26: 'AF31', 28: 'AF32', 30: 'AF33',
    32: 'CS4',
    34: 'AF41', 36: 'AF42', 38: 'AF43',
    40: 'CS5',
    44: 'VA',
    46: 'EF',
    48: 'CS6',
    56: 'CS7'
};

function dscpToString(mark) {
    var dscp = (mark || 0) & 0x3F;
    return DSCP_MAP[dscp] || String(dscp);
}

// =============================================================================
// DSCP colour coding — CAKE diffserv4 tin mapping (sch_cake.c, kernel 6.12)
// Voice       (red) : CS4, CS5, CS6, CS7, EF, VA
// Video      (teal) : CS2, CS3, AF2x, AF3x, AF4x
// Best Effort (gold): CS0, AF1x, and anything else
// Bulk       (grey) : CS1, LE
// =============================================================================
var TIN_COLORS = {
    voice: '#FF4500',
    video: '#00CED1',
    be:    '#FFD700',
    bulk:  '#9E9E9E'
};

function getDscpColor(dscpName) {
    var name = String(dscpName).toUpperCase();
    if (['CS4', 'CS5', 'CS6', 'CS7', 'EF', 'VA'].indexOf(name) !== -1)
        return TIN_COLORS.voice;
    if (['CS2', 'CS3',
         'AF21', 'AF22', 'AF23',
         'AF31', 'AF32', 'AF33',
         'AF41', 'AF42', 'AF43'].indexOf(name) !== -1)
        return TIN_COLORS.video;
    if (['CS1', 'LE'].indexOf(name) !== -1)
        return TIN_COLORS.bulk;
    return TIN_COLORS.be;
}

// =============================================================================
// DSCP legend — one line above the connections table
// =============================================================================
function buildDscpLegend() {
    function pill(label, color) {
        return E('span', { 'style':
            'display:inline-flex; align-items:center; gap:6px; ' +
            'margin-right:16px; font-size:0.9em;' },
        [
            E('span', { 'style':
                'display:inline-block; width:10px; height:10px; ' +
                'border-radius:50%; background:' + color + ';' }),
            label
        ]);
    }
    return E('div', { 'style':
        'padding:6px 4px; margin:8px 0; font-size:0.9em; opacity:0.85;' },
    [
        E('strong', {}, _('DSCP classes:') + ' '),
        pill(_('Voice'),       TIN_COLORS.voice),
        pill(_('Video'),       TIN_COLORS.video),
        pill(_('Best Effort'), TIN_COLORS.be),
        pill(_('Bulk'),        TIN_COLORS.bulk)
    ]);
}

// =============================================================================
// Formatting helpers
// =============================================================================
function formatBytes(bytes) {
    var units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    bytes = Number(bytes) || 0;
    if (bytes === 0) return '0 B';
    var i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

function toKbps(bytesPerSec) {
    return ((Number(bytesPerSec) || 0) * 8 / 1000).toFixed(2) + ' Kbit/s';
}

function shortIPv6(ip) {
    if (!ip || ip.indexOf(':') === -1) return ip;
    var parts = ip.split(':').filter(Boolean);
    if (parts.length <= 3) return ip;
    var short = parts[0] + ':' + parts[1] + '::' + parts[parts.length - 1];
    return short.length > 18 ? short.slice(0, 18) + '…' : short;
}

function formatAddr(ip, port) {
    if (!ip) return '-';
    var p = (port && port !== '-') ? ':' + port : '';
    if (ip.indexOf(':') !== -1) return shortIPv6(ip) + p;
    return ip + p;
}

function fullAddr(ip, port) {
    if (!ip) return '-';
    return ip + ((port && port !== '-') ? ':' + port : '');
}

// public-IP test — only public destinations get an ipinfo.io link
function isPublicIp(ip) {
    if (!ip) return false;
    if (ip.indexOf(':') >= 0) {
        // IPv6: skip link-local, ULA, multicast, loopback
        var l = ip.toLowerCase();
        return !(l.indexOf('fe80') === 0 || l.indexOf('fd') === 0 ||
                 l.indexOf('fc') === 0  || l.indexOf('ff') === 0 || l === '::1');
    }
    var o = ip.split('.').map(Number);
    if (o.length !== 4) return false;
    return !((o[0] === 10) || (o[0] === 127) || (o[0] === 0) ||
             (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
             (o[0] === 192 && o[1] === 168) ||
             (o[0] === 169 && o[1] === 254) || (o[0] >= 224));
}

// =============================================================================
// Ban workflow helpers (IPv4 CIDR only — matches serverrules backend)
// =============================================================================

// Parse "a.b.c.d/p" -> { base: uint32, prefix: int } or null if malformed.
function parseCidr4(cidr) {
    if (!cidr) return null;
    var m = String(cidr).trim().match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
    if (!m) return null;
    var o = [ +m[1], +m[2], +m[3], +m[4] ], p = +m[5];
    if (p < 0 || p > 32) return null;
    if (o.some(function(x){ return x < 0 || x > 255; })) return null;
    var base = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
    return { base: base, prefix: p };
}

// Shortest prefix accepted in a ban / label range. Anything wider than /8
// is refused everywhere (dialogs, Server Rules tab, labelServer backend,
// serverrules.sh).
var MIN_CIDR_PREFIX = 8;

// True when `cidr` parses but its prefix is shorter than /8 (too wide).
// KEEP IN SYNC with history.js cidrTooWide.
function cidrTooWide(cidr) {
    var c = parseCidr4(cidr);
    return !!c && c.prefix < MIN_CIDR_PREFIX;
}

// Refuse private/reserved CIDRs (self-ban guard, same families as isPublicIp)
// and prefixes shorter than /8.
function isPublicCidr(cidr) {
    var c = parseCidr4(cidr);
    if (!c) return false;
    if (c.prefix < MIN_CIDR_PREFIX) return false;
    var o0 = (c.base >>> 24) & 255, o1 = (c.base >>> 16) & 255;
    return !((o0 === 10) || (o0 === 127) || (o0 === 0) ||
             (o0 === 172 && o1 >= 16 && o1 <= 31) ||
             (o0 === 192 && o1 === 168) ||
             (o0 === 169 && o1 === 254) || (o0 >= 224));
}

// Is plain IPv4 `ip` inside CIDR `cidr`?
function ipInCidr4(ip, cidr) {
    var c = parseCidr4(cidr);
    if (!c) return false;
    var o = ip.split('.').map(Number);
    if (o.length !== 4 || o.some(function(x){ return isNaN(x); })) return false;
    var addr = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
    if (c.prefix === 0) return true;
    var mask = (0xFFFFFFFF << (32 - c.prefix)) >>> 0;
    return (addr & mask) >>> 0 === (c.base & mask) >>> 0;
}

// Find existing serverrules rule whose ranges already cover `ip`.
// Returns { sid, name } or null. (IPv4 only; v6 bans handled manually for now.)
function findCoveringRule(ip) {
    if (!ip || ip.indexOf(':') >= 0) return null;
    var hit = null;
    uci.sections('serverrules', 'rule', function(s) {
        if (hit) return;
        var ranges = L.toArray(s.range);
        for (var i = 0; i < ranges.length; i++) {
            if (ipInCidr4(ip, ranges[i])) {
                // Backend treats missing/'1' as enabled (serverrules.sh L52),
                // only explicit '0' is disabled. Mirror that here.
                hit = { sid: s['.name'], name: s.name || s['.name'],
                        enabled: (s.enabled !== '0' && s.enabled !== 0),
                        ranges: ranges.length };
                return;
            }
        }
    });
    return hit;
}

// Is the Server Rules rule that labelServer would extend for `name` ACTIVE?
// Same lookup as the backend (rule whose name option equals `name`, last
// match wins) and same reading of `enabled` as serverrules.sh
// (config_get_bool, default on): only an off value disables a rule; a
// missing or unknown value means active.
// KEEP IN SYNC between connections.js and history.js.
function labelTargetIsActive(name) {
    var off = [ '0', 'off', 'false', 'no', 'disabled' ];
    var active = false;
    uci.sections('serverrules', 'rule', function(s) {
        if ((s.name || '') === name)
            active = (off.indexOf(String(s.enabled)) < 0);
    });
    return active;
}

// self-dismissing toast. ui.addNotification's Dismiss can become
// inert on a polling page after uci.apply(); this is fully self-contained.
// kind: 'info' | 'positive' | 'danger'. Auto-removes after `ms` (default 4s).
function toast(msg, kind, ms) {
    var colors = {
        info:     { bg: '#1d3a5f', fg: '#cfe3ff' },
        positive: { bg: '#1f4d2e', fg: '#bfeccb' },
        danger:   { bg: '#5a2230', fg: '#ffd0d6' }
    };
    var c = colors[kind] || colors.info;
    var host = document.getElementById('dscp_toast_host');
    if (!host) {
        host = E('div', {
            id: 'dscp_toast_host',
            style: 'position:fixed; top:12px; left:50%; transform:translateX(-50%); '
                 + 'z-index:10000; display:flex; flex-direction:column; gap:6px; '
                 + 'max-width:360px; align-items:center;'
        });
        document.body.appendChild(host);
    }
    var el = E('div', {
        style: 'background:' + c.bg + '; color:' + c.fg + '; padding:10px 14px; '
             + 'border-radius:10px; font-size:90%; box-shadow:0 4px 14px rgba(0,0,0,.4); '
             + 'cursor:pointer; transition:opacity .3s;',
        click: function() { if (el.parentNode) el.parentNode.removeChild(el); }
    }, msg);
    host.appendChild(el);
    setTimeout(function() {
        el.style.opacity = '0';
        setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
    }, ms || 4000);
}

// =============================================================================
// Moving average history helper
// =============================================================================
var HISTORY_LEN = 10;

function updateHistory(hist, inPkts, outPkts, inBytes, outBytes, timeDiff) {
    if (!hist) return null;

    if (timeDiff > 0) {
        hist.inPpsH.push(Math.max(0, Math.round((inPkts  - hist.lastInPkts)  / timeDiff)));
        hist.outPpsH.push(Math.max(0, Math.round((outPkts - hist.lastOutPkts) / timeDiff)));
        hist.inBpsH.push(Math.max(0, Math.round((inBytes  - hist.lastInBytes)  / timeDiff)));
        hist.outBpsH.push(Math.max(0, Math.round((outBytes - hist.lastOutBytes) / timeDiff)));

        if (hist.inPpsH.length > HISTORY_LEN) {
            hist.inPpsH.shift(); hist.outPpsH.shift();
            hist.inBpsH.shift(); hist.outBpsH.shift();
        }
    }

    hist.lastInPkts   = inPkts;
    hist.lastOutPkts  = outPkts;
    hist.lastInBytes  = inBytes;
    hist.lastOutBytes = outBytes;

    var avg = function(arr) {
        return arr.length
            ? Math.round(arr.reduce(function(a, b) { return a + b; }, 0) / arr.length)
            : 0;
    };
    var max = function(arr) {
        return arr.length ? Math.max.apply(null, arr) : 0;
    };

    return {
        avgInPps:  avg(hist.inPpsH),
        avgOutPps: avg(hist.outPpsH),
        maxInPps:  max(hist.inPpsH),
        maxOutPps: max(hist.outPpsH),
        avgInBps:  avg(hist.inBpsH),
        avgOutBps: avg(hist.outBpsH)
    };
}

// =============================================================================
// per-flow regularity sparkline (priority flows only)
// =============================================================================

// A flow is "priority" if its DSCP is a real-time priority class.
function isPriorityDscp(dscpStr) {
    var n = (dscpStr || '').toUpperCase();
    return ['CS5', 'CS4', 'EF', 'AF41', 'AF42', 'AF43'].indexOf(n) !== -1;
}

// Coefficient of variation (stddev/mean) as a percentage — a proxy for
// jitter: a steady 30Hz tick has low CV, a stuttering flow has high CV.
// Returns null if not enough samples or mean ~ 0.
function cvPercent(arr) {
    if (!arr || arr.length < 3) return null;
    var n = arr.length;
    var mean = arr.reduce(function(a, b) { return a + b; }, 0) / n;
    if (mean < 1) return null; // idle flow, CV meaningless
    var variance = arr.reduce(function(a, b) {
        var d = b - mean; return a + d * d;
    }, 0) / n;
    return Math.round((Math.sqrt(variance) / mean) * 100);
}

// CV colour: green steady, orange wobbly, red erratic.
function cvColor(cv) {
    if (cv === null) return '#888';
    if (cv > 60) return '#e0524f';
    if (cv > 30) return '#e0a23f';
    return '#4caf6e';
}

// Tiny inline SVG sparkline from a numeric array (download pps history).
// NB: LuCI's E() uses createElement (HTML namespace) which does not render
// SVG children correctly, so we build the markup as a string and let the
// HTML parser handle the SVG namespace via innerHTML.
function sparklineSvg(arr, color) {
    var W = 64, H = 16, n = (arr || []).length;
    var span = E('span', { style: 'display:inline-block; vertical-align:middle; line-height:0;' });
    if (n < 2) {
        span.textContent = '—';
        span.style.opacity = '0.4';
        return span;
    }
    var max = Math.max.apply(null, arr) || 1;
    var pts = arr.map(function(v, i) {
        var x = (i / (n - 1)) * (W - 2) + 1;
        var y = H - 1 - (v / max) * (H - 2);
        return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    span.innerHTML =
        '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" '
        + 'xmlns="http://www.w3.org/2000/svg" style="vertical-align:middle;">'
        + '<polyline points="' + pts + '" fill="none" stroke="' + (color || '#4caf6e')
        + '" stroke-width="1" stroke-linejoin="round"/></svg>';
    return span;
}
// Adaptive polling
// Mesure le temps de réponse rpcd et ajuste l'intervalle automatiquement :
//   > 2000ms réponse → ralentit jusqu'à 10s max
//   < 1000ms réponse → accélère jusqu'à 1s min
// =============================================================================
function adaptivePoll(self) {
    if (!self.autoRefresh) return;

    var startTime = Date.now();

    callGetConntrackDSCP().then(function(result) {
        // refresh serverrules UCI each cycle so rule badges
        // reflect enable/disable/edits done in the Server Rules tab.
        uci.unload('serverrules');
        return uci.load('serverrules').then(function() { return result; });
    }).then(function(result) {
        var responseTime = Date.now() - startTime;

        // Premier poll : démarre à 3s pour laisser le temps au système
        if (!self.hasPolledOnce) {
            self.pollInterval = 3;
            self.hasPolledOnce = true;
        } else if (responseTime > 2000) {
            self.pollInterval = Math.min(self.pollInterval + 1, 10);
        } else if (responseTime < 1000 && self.pollInterval > 1) {
            self.pollInterval = Math.max(self.pollInterval - 1, 1);
        }

        // Mise à jour affichage intervalle
        var pollDisplay = document.getElementById('dscp_poll_interval');
        if (pollDisplay) {
            pollDisplay.textContent = _('Polling: ') + self.pollInterval + 's';
        }

        if (result && result.connections) {
            self.renderRows(Object.values(result.connections));
        } else {
            self._showError(_('No connection data received'));
        }

    }).catch(function(err) {
        console.error('DSCP poll error:', err);
        self._showError(_('Connection error — check rpcd service'));

    }).finally(function() {
        if (self.autoRefresh) {
            self.refreshTimeout = setTimeout(function() {
                adaptivePoll(self);
            }, self.pollInterval * 1000);
        }
    });
}

// =============================================================================
// View definition
// =============================================================================
// Rule names: letters, digits and _ only (UCI-safe). Spaces typed by the
// user become _ as they type, so "Server EU" is accepted as "Server_EU".
function underscoreSpaces(input) {
    input.addEventListener('input', function() {
        var v = input.value.replace(/\s/g, '_');
        if (v !== input.value) {
            var pos = input.selectionStart;
            input.value = v;
            try { input.setSelectionRange(pos, pos); } catch (e) {}
        }
    });
    return input;
}

return view.extend({

    // State
    pollInterval:      3,
    filter:            '',
    sortColumn:        'bytes',
    sortDescending:    true,
    lastData:          {},
    connectionHistory: {},
    lastUpdateTime:    0,
    tableEl:           null,
    autoRefresh:       true,
    refreshTimeout:    null,
    hasPolledOnce:     false,

    // ------------------------------------------------------------------
    // load() — données initiales
    // ------------------------------------------------------------------
load: function() {
        return Promise.all([
            callGetConntrackDSCP(),
            uci.load('sqm'),
            uci.load('serverrules')
        ]);
    },

    // ------------------------------------------------------------------
    // render() — construction du DOM
    // ------------------------------------------------------------------
render: function(data) {
        var self = this;
        // data is now [connectionsResult, uciLoaded]
        var connectionsData = (data && data[0]) ? data[0] : {};
        // Priority devices of the SQM DSCP policy: comma/space separated
        // strings in sqm.@queue[0] (priority_ip / priority_ip6). The flush
        // backend takes the whole list and flushes each address.
        var priorityIp4 = splitList(uci.get('sqm', '@queue[0]', 'priority_ip')).join(',');
        var priorityIp6 = splitList(uci.get('sqm', '@queue[0]', 'priority_ip6')).join(',');
        var capPorts = splitList(uci.get('sqm', '@queue[0]', 'priority_udp_ports'))
            .concat(splitList(uci.get('sqm', '@queue[0]', 'priority_tcp_ports')));
        PRIORITY_CAPTURE_PORTS = capPorts.filter(function(x, i) {
            return /^[0-9]+(-[0-9]+)?$/.test(x) && capPorts.indexOf(x) === i;
        }).join(',');

        var initialConns = (connectionsData && connectionsData.connections)
            ? Object.values(connectionsData.connections)
            : [];

        // --- Filtre ---
        var filterInput = E('input', {
            type:        'text',
            placeholder: _('Filter: IP, port, protocol, DSCP, label — multiple terms with spaces (AND logic)'),
            style:       'width:340px; margin-right:8px;',
            value:       self.filter
        });
        filterInput.addEventListener('input', function(ev) {
            self.filter = ev.target.value.toLowerCase();
            self.renderRows(Object.values(self.lastData));
        });

        // --- Bouton tri DSCP ---
        var dscpBtn = E('button', {
            class: 'cbi-button cbi-button-add',
            style: 'margin-right:8px;',
            click: function() {
                self.sortColumn     = 'dscp';
                self.sortDescending = true;
                self.renderRows(Object.values(self.lastData));
            }
        }, _('Sort by DSCP (active first)'));

        // --- Bouton Pause / Resume ---
        var pauseBtn = E('button', {
            class: 'cbi-button cbi-button-neutral',
            style: 'margin-right:8px;'
        }, _('Pause'));

        pauseBtn.addEventListener('click', function() {
            if (self.autoRefresh) {
                clearTimeout(self.refreshTimeout);
                self.autoRefresh     = false;
                pauseBtn.textContent = _('Resume');
                pauseBtn.className   = 'cbi-button cbi-button-action';
            } else {
                self.autoRefresh     = true;
                pauseBtn.textContent = _('Pause');
                pauseBtn.className   = 'cbi-button cbi-button-neutral';
                adaptivePoll(self);
            }
        });

        // --- Zoom ---
        var zoomSelect = E('select', {
            class:  'zoom-select',
            change: function(ev) {
                var t = self.tableEl;
                t.className = t.className.replace(/\bzoom-\d+\b/g, '').trim();
                t.classList.add(ev.target.value);
            }
        }, ['100','90','80','70','60','50'].map(function(z) {
            return E('option', { value: 'zoom-' + z }, z + '%');
        }));

        // --- Compteur de connexions ---
        var connCount = E('span', {
            id:    'dscp_conn_count',
            style: 'font-weight:bold; margin-left:12px; line-height:2.5em;'
        }, _('Connections: 0'));

        // --- Affichage intervalle de poll ---
        var pollDisplay = E('span', {
            id:    'dscp_poll_interval',
            style: 'margin-left:12px; color:#888; font-size:0.85em;'
        }, _('Polling: 3s'));

        // --- Colonnes de la table ---
        var cols = [
            { key: 'protocol', label: _('Protocol')           },
            { key: 'src',      label: _('Source & Port')      },
            { key: 'dst',      label: _('Destination & Port') },
            { key: 'dscp',     label: _('DSCP')               },
            { key: 'bytes',    label: _('Bytes')              },
            { key: 'packets',  label: _('Packets')            },
            { key: 'avgPps',   label: _('Avg PPS')            },
            { key: 'maxPps',   label: _('Max PPS')            },
            { key: 'avgBps',   label: _('Avg BPS')            },
            { key: 'action',   label: _('Action'), noSort: true }
        ];

        var headerRow = E('tr', { class: 'tr table-titles' },
            cols.map(function(col) {
                if (col.noSort)
                    return E('th', { class: 'th' }, col.label);
                var indicator = E('span', {
                    class:      'sort-indicator',
                    'data-col': col.key
                }, '');
                var link = E('a', {
                    href:  '#',
                    click: function(ev) {
                        ev.preventDefault();
                        setTimeout(function() {
                            if (self.sortColumn === col.key) {
                                self.sortDescending = !self.sortDescending;
                            } else {
                                self.sortColumn     = col.key;
                                self.sortDescending = true;
                            }
                            self.renderRows(Object.values(self.lastData));
                        }, 0);
                    }
                }, [col.label, indicator]);
                return E('th', { class: 'th' }, link);
            })
        );

        var table = E('table', {
            class: 'table cbi-section-table zoom-100',
            id:    'dscp_connections'
        }, [headerRow]);

        self.tableEl = table;

        // --- CSS ---
        var style = E('style', {}, [
            '.sort-indicator { display:inline-block; margin-left:4px; }',
            // Zoom in em: 100% = the theme's own text size (13px on
            // bootstrap). rem followed the browser root (16px), so the
            // table was bigger than the rest of the page.
            '.zoom-100 { font-size:1em; }',
            '.zoom-90  { font-size:.9em; }',
            '.zoom-80  { font-size:.8em; }',
            '.zoom-70  { font-size:.7em; }',
            '.zoom-60  { font-size:.6em; }',
            '.zoom-50  { font-size:.5em; }',
            '.cbi-section-table td, .cbi-section-table th {',
            '  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;',
            '  max-width:160px; padding:.3rem; }',
            '@media(max-width:600px){',
            '  .cbi-section-table td:nth-child(5),',
            '  .cbi-section-table th:nth-child(5),',
            '  .cbi-section-table td:nth-child(6),',
            '  .cbi-section-table th:nth-child(6){ display:none; }}'
        ].join('\n'));


        // --- Flush Conntrack handler ---
        var handleFlush = function() {
            if (!priorityIp4 && !priorityIp6) {
                toast(_("No priority device configured. Set one in SQM → DSCP Policies → Priority Devices first."), 'info');
                return;
            }

            var msg = _("Flush all conntrack entries for:") + "\n";
            if (priorityIp4) msg += "  IPv4: " + priorityIp4 + "\n";
            if (priorityIp6) msg += "  IPv6: " + priorityIp6 + "\n";
            msg += "\n" + _("Active connections will be reset. Continue?");

            if (!confirm(msg)) return;

            callFlushConntrack(priorityIp4, priorityIp6)
                .then(function(res) {
                    var r = res || {};
                    var total = r.total || 0;
                    var v4    = r.ipv4_count || 0;
                    var v6    = r.ipv6_count || 0;
                    toast(_("Conntrack result: %d flow entries deleted (%d IPv4, %d IPv6)")
                        .format(total, v4, v6), 'positive');
                })
                .catch(function(err) {
                    toast(_("Flush error: %s").format((err && err.message) || "unknown"), 'danger');
                });
        };

        var flushBtn = E("button", {
            class: "btn cbi-button cbi-button-negative",
            style: "margin-right:8px;",
            click: handleFlush
        }, _("Flush Conntrack"));

        // Rendu initial + démarrage polling adaptatif
        self.renderRows(initialConns);
        adaptivePoll(self);

        return E('div', { class: 'cbi-map' }, [
            style,
            E('h2', _('DSCP Connections')),
            E('div', {
                style: 'margin-bottom:10px; display:flex; flex-wrap:wrap; gap:6px; align-items:center;'
            }, [
                flushBtn,
                filterInput,
                dscpBtn,
                pauseBtn,
                E('label', { style: 'margin-left:4px;' }, _('Zoom:')),
                zoomSelect,
                pollDisplay,
                connCount
            ]),
            buildDscpLegend(),
            E('div', { class: 'cbi-section' }, [
                E('div', {
                    class: 'cbi-section-node',
                    style: 'overflow-x:auto;'
                }, [table])
            ])
        ]);
    },

    // ------------------------------------------------------------------
    // _showError() — message d'erreur dans la table
    // ------------------------------------------------------------------
    // ------------------------------------------------------------------
    // Ban dialog — add a CIDR to a serverrules rule (or new one)
    // ------------------------------------------------------------------
    banDialog: function(ip) {
        var self = this;

        // Build the rule list + detect a rule already covering this IP.
        var rules = [];
        uci.sections('serverrules', 'rule', function(s) {
            rules.push({ sid: s['.name'], name: s.name || s['.name'] });
        });
        var covering = findCoveringRule(ip);

        var NEW = '__new__';
        var ruleSelect = E('select', { class: 'cbi-input-select', style: 'width:100%;' },
            rules.map(function(r) {
                return E('option', {
                    value: r.sid,
                    selected: (covering && covering.sid === r.sid) ? '' : null
                }, r.name);
            }).concat([ E('option', {
                value: NEW,
                // No covering rule: default to a new (disabled) rule, never
                // to the first existing one, which may be unrelated and active.
                selected: covering ? null : ''
            }, '➕ ' + _('New location…')) ])
        );

        var cidrInput = E('input', {
            type: 'text', class: 'cbi-input-text', style: 'width:100%;',
            value: ip + '/32'
        });
        var nameRow = E('div', { style: 'display:none; margin-top:8px;' }, [
            E('label', { style: 'display:block; margin-bottom:4px;' }, _('New rule name')),
            E('input', { type: 'text', class: 'cbi-input-text', style: 'width:100%;',
                         placeholder: 'Server_EU' })
        ]);
        var nameInput = underscoreSpaces(nameRow.querySelector('input'));
        var errBox = E('div', { style: 'color:#e0524f; margin-top:8px; min-height:1.2em;' }, '');

        var syncNameRow = function() {
            nameRow.style.display = (ruleSelect.value === NEW) ? 'block' : 'none';
        };
        ruleSelect.addEventListener('change', syncNameRow);
        // "New location" is preselected whenever no rule covers the IP, and
        // no change event fires for a default: show the name field at once.
        syncNameRow();

        var hint = covering
            ? E('p', { style: 'color:#4caf50;' },
                _('%s is already covered by rule "%s" — adding here widens that rule.')
                  .format(ip, covering.name))
            : E('p', {}, _('%s is not in any existing rule.').format(ip));

        // real BGP prefix suggestion (same as labelDialog).
        // Pre-fills the CIDR with the exact announced range; editable. The ban
        // logic (banConfirm) is untouched — we only improve the default value.
        var cidrTip = E('div', { style: 'font-size:90%; opacity:.7; margin-top:2px;' },
            _('Tip: replace /32 with the range from ipinfo.io (e.g. /20).'));
        callSuggestCidr(ip).then(function(res) {
            if (!res || !res.success) return;
            // only override the /32 default if the user hasn't typed yet
            if (cidrInput.value === ip + '/32' && res.suggested) {
                cidrInput.value = res.suggested;
            }
            if (res.reason === 'bgp') {
                cidrTip.textContent = _('Real BGP prefix %s (AS%s) — the exact announced range. Editable.')
                    .format(res.suggested, res.asn || '?');
            } else if (res.bgp_prefix) {
                cidrTip.textContent = _('BGP %s. Editable — widen/narrow as needed.').format(res.bgp_prefix);
            }
        }).catch(function() { /* keep /32 + manual tip on failure */ });

        ui.showModal(_('Ban server range'), [
            hint,
            E('div', { class: 'cbi-value' }, [
                E('label', { class: 'cbi-value-title' }, _('CIDR to block')),
                E('div', { class: 'cbi-value-field' }, [
                    cidrInput,
                    cidrTip
                ])
            ]),
            E('div', { class: 'cbi-value' }, [
                E('label', { class: 'cbi-value-title' }, _('Target rule')),
                E('div', { class: 'cbi-value-field' }, [ ruleSelect, nameRow ])
            ]),
            errBox,
            E('div', { class: 'right', style: 'margin-top:12px;' }, [
                E('button', {
                    class: 'btn',
                    click: ui.hideModal
                }, _('Cancel')),
                ' ',
                E('button', {
                    class: 'btn cbi-button-negative',
                    click: ui.createHandlerFn(self, 'banConfirm',
                        cidrInput, ruleSelect, nameInput, errBox, NEW)
                }, _('Add to block list'))
            ])
        ]);
    },

    // Validate + write UCI. Returns a Promise; keeps modal open on error.
    banConfirm: function(cidrInput, ruleSelect, nameInput, errBox, NEW) {
        var cidr = (cidrInput.value || '').trim();

        if (cidrTooWide(cidr)) {
            errBox.textContent = _('Range too wide: prefix must be /8 or longer — refused.');
            return;
        }
        if (!isPublicCidr(cidr)) {
            errBox.textContent = _('Invalid or private/reserved CIDR — refused.');
            return;
        }

        var sid, isNew = (ruleSelect.value === NEW);
        if (isNew) {
            var nm = (nameInput.value || '').trim().replace(/\s+/g, '_');
            if (!/^[a-zA-Z0-9_]+$/.test(nm)) {
                errBox.textContent = _('Rule name required (letters, digits, _).');
                return;
            }
            // refuse duplicate name
            var dup = false;
            uci.sections('serverrules', 'rule', function(s) {
                if ((s.name || '') === nm) dup = true;
            });
            if (dup) { errBox.textContent = _('A rule named "%s" already exists.').format(nm); return; }

            sid = uci.add('serverrules', 'rule');
            uci.set('serverrules', sid, 'name', nm);
            uci.set('serverrules', sid, 'enabled', '0'); // never auto-enable
            uci.set('serverrules', sid, 'range', [ cidr ]);
        } else {
            sid = ruleSelect.value;
            var ranges = L.toArray(uci.get('serverrules', sid, 'range'));
            if (ranges.indexOf(cidr) >= 0) {
                errBox.textContent = _('That CIDR is already in this rule.');
                return;
            }
            ranges.push(cidr);
            uci.set('serverrules', sid, 'range', ranges);
        }

        ui.hideModal();
        return uci.save()
            .then(function() { return uci.apply(); })
            .then(function() {
                toast(_('Added %s to serverrules. Rule stays %s.')
                        .format(cidr, isNew ? _('disabled (enable it in Server Rules)')
                                            : _('in its current state')), 'info');
            })
            .catch(function(e) {
                toast(_('Ban write failed: %s').format(e.message || e), 'danger');
            });
    },

    // enable/disable a whole serverrules rule from Connections.
    // `enable` true -> ban (set enabled='1'), false -> unban (enabled='0').
    // Acts on the entire rule (all its ranges); delete stays in Server Rules.
    // write one server-history entry (explicit 📌 click).
    logServerEntry: function(ip, port, region, dscp) {
        return callLogServer(ip, port, region, dscp).then(function(res) {
            if (res && res.success) {
                toast(_('Server logged: %s%s').format(
                    ip, region ? (' (' + region + ')') : ''), 'positive');
            } else {
                toast(_('Log failed: %s').format((res && res.error) || _('unknown')), 'danger');
            }
        }).catch(function(e) {
            toast(_('Log failed: %s').format(e.message || e), 'danger');
        });
    },

    // label a server by range (creates a disabled
    // serverrules rule = pure label). Default /24 (editable). The backend
    // labelServer is the single write path; suggestCidr injects an
    // auto-suggested CIDR into the input below. KEEP IN SYNC with history.js.
    labelDialog: function(ip) {
        var self = this;
        var base = (ip || '').split('.').slice(0, 3).join('.') + '.0/24';
        var cidrInput = E('input', {
            type: 'text', class: 'cbi-input-text', style: 'width:100%;', value: base
        });
        // label name dropdown of existing labels + "New label".
        // Same pattern as banDialog: read rules client-side via uci.sections
        // (no extra rpc). labelServer expects a NAME, so we key options by name.
        var NEW = '__new__';
        var ruleNames = [];
        // A rule with no name option in an anonymous section is left out:
        // labelServer finds its target by name, so picking the generated
        // section id (cfgXXXXXX) would create a new rule of that name.
        uci.sections('serverrules', 'rule', function(s) {
            var n = s.name || (s['.anonymous'] ? '' : s['.name']);
            if (n) ruleNames.push(n);
        });
        var nameSelect = E('select', { class: 'cbi-input-select', style: 'width:100%;' },
            ruleNames.map(function(n) {
                return E('option', { value: n }, n);
            }).concat([ E('option', { value: NEW }, '\u002B ' + _('New label…')) ])
        );
        // default to "New label" when there are rules, else stays on New anyway
        nameSelect.value = NEW;
        var newNameInput = E('input', {
            type: 'text', class: 'cbi-input-text', style: 'width:100%; margin-top:4px;', placeholder: 'Server_EU'
        });
        underscoreSpaces(newNameInput);
        // Red warning under the select + explicit button label when the
        // chosen rule is active: the label would then be a real ban.
        var activeWarn = E('div', {
            style: 'display:none; color:#e0524f; font-weight:bold; margin-top:6px;'
        }, '');
        // Intro sentence: follows the selected rule state, like activeWarn.
        var introText = E('p', {}, '');
        var saveBtn = null;
        function syncNameField() {
            var isNew = (nameSelect.value === NEW);
            var active = !isNew && labelTargetIsActive(nameSelect.value);
            newNameInput.style.display = isNew ? '' : 'none';
            activeWarn.textContent = active
                ? _('Rule "%s" is ACTIVE: this range will be BLOCKED. Choose New label to only name it.')
                    .format(nameSelect.value)
                : '';
            activeWarn.style.display = active ? '' : 'none';
            introText.textContent = active
                ? _('Create a named label for %s and its range. The range is added '
                    + 'to an ACTIVE rule and will be blocked.').format(ip)
                : _('Create a named label for %s and its range. This makes a '
                    + 'disabled serverrules rule (label only, no blocking).').format(ip);
            if (saveBtn)
                saveBtn.textContent = active ? _('Label and block') : _('Save label');
        }
        nameSelect.addEventListener('change', syncNameField);
        syncNameField();

        var hint = E('div', { style: 'font-size:90%; opacity:.7; margin-top:2px;' },
            _('Default /24 covers 256 neighbour IPs. Widen (/20, /16) if you know the range.'));
        var widenBtn = E('button', {
            class: 'btn', style: 'padding:2px 8px; font-size:85%; margin-top:4px;',
            click: function() { /* set by suggestion load */ }
        }, _('Widen to /16'));
        widenBtn.style.display = 'none';
        var errBox = E('div', { style: 'color:#e0524f; margin-top:8px; min-height:1.2em;' }, '');

        // smart CIDR suggestion + preselect the neighbour rule.
        callSuggestCidr(ip).then(function(res) {
            if (!res || !res.success) return;
            cidrInput.value = res.suggested || base;
            if (res.rule) {
                var opt = Array.prototype.slice.call(nameSelect.options)
                    .filter(function(o) { return o.value === res.rule; })[0];
                if (opt) { nameSelect.value = res.rule; syncNameField(); }
            }
            if (res.reason === 'covered' && res.rule) {
                hint.textContent = _('This IP is already covered by your "%s" rule (%s). Saving will extend it.').format(res.rule, res.suggested);
            } else if (res.reason === 'bgp') {
                hint.textContent = (res.rule)
                    ? _('Real BGP prefix %s (AS%s). Near your "%s" rule. Editable.').format(res.suggested, res.asn || '?', res.rule)
                    : _('Real BGP prefix %s (AS%s) — the exact announced range. Editable.').format(res.suggested, res.asn || '?');
            } else if (res.reason === 'neighbour' && res.rule) {
                hint.textContent = _('Near your "%s" rule — suggested %s to extend it. Editable.').format(res.rule, res.suggested);
            } else {
                hint.textContent = _('Suggested %s (precise). Widen if you know the provider range.').format(res.suggested);
            }
            if (res.wide16 && res.wide16 !== cidrInput.value) {
                widenBtn.onclick = function() { cidrInput.value = res.wide16; };
                widenBtn.style.display = '';
            }
        }).catch(function() { /* keep /24 default on any error */ });

        ui.showModal(_('Label this server'), [
            introText,
            E('div', { class: 'cbi-value' }, [
                E('label', { class: 'cbi-value-title' }, _('Label name')),
                E('div', { class: 'cbi-value-field' }, [ nameSelect, newNameInput, activeWarn ])
            ]),
            E('div', { class: 'cbi-value' }, [
                E('label', { class: 'cbi-value-title' }, _('Range (CIDR)')),
                E('div', { class: 'cbi-value-field' }, [
                    cidrInput, hint, widenBtn
                ])
            ]),
            errBox,
            E('div', { class: 'right', style: 'margin-top:12px;' }, [
                E('button', { class: 'btn', click: ui.hideModal }, _('Cancel')),
                ' ',
                (saveBtn = E('button', {
                    class: 'btn cbi-button-action',
                    click: function() {
                        var nm = (nameSelect.value === NEW)
                            ? (newNameInput.value || '').trim().replace(/\s+/g, '_')
                            : nameSelect.value;
                        var cidr = (cidrInput.value || '').trim();
                        if (!/^[a-zA-Z0-9_]+$/.test(nm)) {
                            errBox.textContent = _('Name required (letters, digits, _).'); return;
                        }
                        if (cidrTooWide(cidr)) {
                            errBox.textContent = _('Range too wide: prefix must be /8 or longer — refused.'); return;
                        }
                        if (!isPublicCidr(cidr)) {
                            errBox.textContent = _('Invalid or private/reserved CIDR — refused.'); return;
                        }
                        callLabelServer(nm, cidr).then(function(res) {
                            ui.hideModal();
                            if (res && res.success) {
                                toast(_('Label "%s" %s %s.').format(nm,
                                    res.created ? _('created with') : _('extended with'), cidr), 'positive');
                            } else {
                                toast(_('Label failed: %s').format((res && res.error) || _('unknown')), 'danger');
                            }
                        }).catch(function(e) {
                            toast(_('Label failed: %s').format(e.message || e), 'danger');
                        });
                    }
                }, _('Save label')))
            ])
        ]);
        // the button exists now: apply the current selection to its label
        syncNameField();
    },

    // Capture dialog. mode 'ports' = port-based on br-lan
    // (robust to matchmaking, both directions); mode 'full' = this server's IP.
    captureDialog: function(mode, ip) {
        var self = this;
        var isFull = (mode === 'full');

        var durInput = E('input', {
            type: 'number', class: 'cbi-input-text', style: 'width:100px;',
            value: '120', min: '1', max: '300'
        });

        // interface selector — defaults to br-lan, lets the user pick WAN to
        // observe real on-the-wire DSCP (br-lan sees the flow before egress marking)
        var ifaceSelect = E('select', { class: 'cbi-input-select', style: 'min-width:160px;' }, [
            E('option', { value: 'br-lan' }, 'br-lan')
        ]);
        var ifaceHint = E('div', { style: 'font-size:85%; opacity:.7; margin-top:4px;' },
            _('br-lan: flow & client IP, both directions. WAN: real DSCP marks on the wire (after NAT, client IP hidden).'));

        var errBox = E('div', { style: 'color:#e0524f; margin-top:8px; min-height:1.2em;' }, '');

        var desc = isFull
            ? _('Capture ALL traffic to/from this server (%s), both directions.').format(ip)
            : _('Capture the priority ports (%s), both directions. Works whatever server the application picked.').format(PRIORITY_CAPTURE_PORTS);

        // populate interfaces (best effort; br-lan stays the default)
        callListInterfaces().then(function(res) {
            if (!res || !res.interfaces) return;
            while (ifaceSelect.firstChild) ifaceSelect.removeChild(ifaceSelect.firstChild);
            res.interfaces.forEach(function(it) {
                var label = it.name
                    + (it.role === 'lan' ? ' — LAN (flow/IP)' : '')
                    + (it.role === 'wan' ? ' — WAN (real DSCP)' : '');
                ifaceSelect.appendChild(E('option', { value: it.name }, label));
            });
            ifaceSelect.value = 'br-lan';
        }).catch(function() {});

        ui.showModal(isFull ? _('Capture server traffic') : _('Capture priority ports'), [
            E('p', {}, desc),
            E('div', { class: 'cbi-value' }, [
                E('label', { class: 'cbi-value-title' }, _('Interface')),
                E('div', { class: 'cbi-value-field' }, [ ifaceSelect, ifaceHint ])
            ]),
            E('div', { class: 'cbi-value' }, [
                E('label', { class: 'cbi-value-title' }, _('Duration (seconds, max 300)')),
                E('div', { class: 'cbi-value-field' }, [ durInput ])
            ]),
            E('p', { style: 'font-size:90%; opacity:.7;' },
              _('The capture runs in the background. Find it in the Captures tab when done.')),
            errBox,
            E('div', { class: 'right', style: 'margin-top:12px;' }, [
                E('button', { class: 'btn', click: ui.hideModal }, _('Cancel')),
                ' ',
                E('button', {
                    class: 'btn cbi-button-action',
                    click: function() {
                        var dur = parseInt(durInput.value, 10);
                        if (isNaN(dur) || dur < 1 || dur > 300) {
                            errBox.textContent = _('Duration must be between 1 and 300 seconds.'); return;
                        }
                        var iface    = ifaceSelect.value || 'br-lan';
                        var capIp    = isFull ? ip : '';
                        var capPorts = isFull ? '' : PRIORITY_CAPTURE_PORTS;
                        // ports mode: pass the server IP seen at click time as an
                        // indicative label for the filename (filter stays port-based)
                        var capLabel = isFull ? '' : (ip || '');
                        callStartCapture(iface, capIp, capPorts, dur, capLabel).then(function(res) {
                            ui.hideModal();
                            if (res && res.success) {
                                toast(_('Capture started (%ds) on %s. See the Captures tab.').format(dur, iface), 'positive');
                            } else {
                                toast(_('Capture failed: %s').format((res && res.error) || _('unknown')), 'danger');
                            }
                        }).catch(function(e) {
                            ui.hideModal();
                            toast(_('Capture failed: %s').format(e.message || e), 'danger');
                        });
                    }
                }, _('Start capture'))
            ])
        ]);
    },

    toggleRule: function(sid, name, ranges, enable) {
        var self = this;
        var verb  = enable ? _('Enable') : _('Disable');
        var effect = enable
            ? _('This bans its whole range (%d subnet(s)).').format(ranges)
            : _('This unbans its whole range (%d subnet(s)).').format(ranges);

        ui.showModal(verb + ' ' + _('rule') + ' "' + name + '"', [
            E('p', effect),
            E('p', { style: 'opacity:.7; font-size:90%;' },
              _('To edit ranges or delete the rule, use the Server Rules tab.')),
            E('div', { class: 'right', style: 'margin-top:12px;' }, [
                E('button', { class: 'btn', click: ui.hideModal }, _('Cancel')),
                ' ',
                E('button', {
                    class: 'btn ' + (enable ? 'cbi-button-negative' : 'cbi-button-positive'),
                    click: ui.createHandlerFn(self, 'toggleRuleConfirm', sid, name, enable)
                }, verb)
            ])
        ]);
    },

    toggleRuleConfirm: function(sid, name, enable) {
        ui.hideModal();
        uci.set('serverrules', sid, 'enabled', enable ? '1' : '0');
        return uci.save()
            .then(function() { return uci.apply(); })
            .then(function() {
                toast(_('Rule "%s" %s.').format(name,
                        enable ? _('enabled (banned)') : _('disabled (unbanned)')),
                      enable ? 'danger' : 'positive');
            })
            .catch(function(e) {
                toast(_('Toggle failed: %s').format(e.message || e), 'danger');
            });
    },

    _showError: function(msg) {
        var table = this.tableEl;
        if (!table) return;
        while (table.rows.length > 1) table.deleteRow(1);
        table.appendChild(E('tr', { class: 'tr' }, [
            E('td', {
                class:   'td',
                colspan: '10',
                style:   'text-align:center; color:red; padding:20px;'
            }, msg)
        ]));
    },

    // ------------------------------------------------------------------
    // renderRows() — reconstruction du corps de la table
    // ------------------------------------------------------------------
    renderRows: function(conns) {
        var self  = this;
        var table = self.tableEl;
        if (!table) return;

        try {
            var now      = Date.now() / 1000;
            var timeDiff = now - (self.lastUpdateTime || now);
            self.lastUpdateTime = now;

            // Calcul stats par connexion
            conns.forEach(function(conn) {
                var key = conn.layer3 + ':' + conn.protocol + ':' +
                          conn.src    + ':' + (conn.sport || '-') + ':' +
                          conn.dst    + ':' + (conn.dport || '-');

                if (!self.connectionHistory[key]) {
                    self.connectionHistory[key] = {
                        inPpsH: [], outPpsH: [], inBpsH: [], outBpsH: [],
                        lastInPkts:   Number(conn.in_packets)  || 0,
                        lastOutPkts:  Number(conn.out_packets) || 0,
                        lastInBytes:  Number(conn.in_bytes)    || 0,
                        lastOutBytes: Number(conn.out_bytes)   || 0
                    };
                }

                var hist  = self.connectionHistory[key];
                var stats = updateHistory(
                    hist,
                    Number(conn.in_packets)  || 0,
                    Number(conn.out_packets) || 0,
                    Number(conn.in_bytes)    || 0,
                    Number(conn.out_bytes)   || 0,
                    timeDiff
                );

                conn._key   = key;
                conn._hist  = hist;
                conn._stats = stats || {
                    avgInPps:0, avgOutPps:0,
                    maxInPps:0, maxOutPps:0,
                    avgInBps:0, avgOutBps:0
                };
                self.lastData[key] = conn;
            });

            // Tri
            var sorted = conns.slice().sort(function(a, b) {
                return self._sortValue(a, b);
            });

            // Filtre multi-termes (ET entre termes, OU entre champs)
            var tokens = self.filter
                ? self.filter.split(/\s+/).filter(Boolean)
                : [];

            // Reconstruction du tbody
            while (table.rows.length > 1) table.deleteRow(1);

            var displayed = 0;

            sorted.forEach(function(conn) {
                var dscpStr = dscpToString(conn.dscp);
                var srcDisp = formatAddr(conn.src, conn.sport);
                var dstDisp = formatAddr(conn.dst, conn.dport);
                var srcFull = fullAddr(conn.src,  conn.sport);
                var dstFull = fullAddr(conn.dst,  conn.dport);
                var proto   = (conn.protocol || '').toUpperCase();
                var s       = conn._stats;

                // serverrules rule label (red=enabled/banned, grey=listed)
                // Clickable -> Server Rules tab to edit/toggle the rule.
                var gsRule = isPublicIp(conn.dst) ? findCoveringRule(conn.dst) : null;

                // regularity sparklines for priority flows only.
                // ↓ download (server -> device = the tick you receive)
                // ↑ upload   (device -> server = your inputs going out)
                // Comparing both isolates one-sided delay: steady ↓ + steady ↑
                // but bad real-time quality points to the server/opponent, not your link.
                var sparkEl = null;
                if (isPriorityDscp(dscpStr) && conn._hist) {
                    var mkRow = function(arrow, ppsH, titleTxt) {
                        var cv  = cvPercent(ppsH);
                        var col = cvColor(cv);
                        return E('div', {
                            style: 'display:flex; align-items:center; gap:5px;',
                            title: titleTxt.format((ppsH || []).length)
                        }, [
                            E('span', { style: 'font-size:80%; opacity:.6; width:10px;' }, arrow),
                            sparklineSvg(ppsH, col),
                            E('span', { style: 'font-size:80%; color:' + col + ';' },
                              cv === null ? _('idle') : ('CV ' + cv + '%'))
                        ]);
                    };
                    sparkEl = E('div', { style: 'margin-top:3px; display:flex; flex-direction:column; gap:2px;' }, [
                        mkRow('↓', conn._hist.inPpsH,
                              _('Download regularity (CV of pps, last %d samples). Lower = steadier tick.')),
                        mkRow('↑', conn._hist.outPpsH,
                              _('Upload regularity (CV of pps, last %d samples). Lower = your inputs go out steadily.'))
                    ]);
                }
                var gsBadge = gsRule
                    ? E('a', {
                          href: L.url('admin/network/sqm/serverrules'),
                          title: gsRule.name
                               + (gsRule.enabled ? _(' (banned)') : _(' (listed, not active)'))
                               + ' — ' + _('click to manage'),
                          style: 'margin-left:6px; padding:1px 6px; border-radius:8px; '
                               + 'font-size:80%; white-space:nowrap; text-decoration:none; '
                               + (gsRule.enabled
                                    ? 'background:#e0524f; color:#fff;'
                                    : 'background:var(--info, #1d3a5f); color:var(--info-foreground, #60a5fa);')
                      }, gsRule.name)
                    : null;
                if (tokens.length > 0) {
                    var fields = [
                        proto.toLowerCase(),
                        srcFull.toLowerCase(),
                        dstFull.toLowerCase(),
                        dscpStr.toLowerCase(),
                        (gsRule && gsRule.name ? gsRule.name.toLowerCase() : '')
                    ];
                    var pass = tokens.every(function(t) {
                        return fields.some(function(f) { return f.includes(t); });
                    });
                    if (!pass) return;
                }

                displayed++;

                var inOut = function(inVal, outVal) {
                    return E('div', {}, [
                        E('span', {}, '↓ ' + inVal),
                        E('br'),
                        E('span', {}, '↑ ' + outVal)
                    ]);
                };

                table.appendChild(E('tr', { class: 'tr' }, [
                    E('td', { class: 'td' }, proto),
                    E('td', { class: 'td', title: srcFull }, srcDisp),
                    // public destination IP links to ipinfo.io (CIDR lookup)
                    // + serverrules rule badge when the IP is covered
                    E('td', { class: 'td', title: dstFull }, [
                        E('div', {}, [
                            isPublicIp(conn.dst)
                                ? E('a', {
                                      href: 'https://ipinfo.io/' + conn.dst,
                                      target: '_blank',
                                      rel: 'noopener',
                                      title: dstFull + ' — ipinfo.io',
                                      style: 'color:#e0524f; text-decoration:underline dotted;'
                                  }, dstDisp)
                                : dstDisp
                        ].concat(gsBadge ? [ gsBadge ] : []))
                    ].concat(sparkEl ? [ sparkEl ] : [])),
                    E('td', {
                        class: 'td',
                        style: 'color:' + getDscpColor(dscpStr) + '; font-weight:bold;'
                    }, dscpStr),
                    E('td', { class: 'td' }, inOut(
                        formatBytes(conn.in_bytes),
                        formatBytes(conn.out_bytes)
                    )),
                    E('td', { class: 'td' }, inOut(
                        Number(conn.in_packets)  || 0,
                        Number(conn.out_packets) || 0
                    )),
                    E('td', { class: 'td' }, inOut(s.avgInPps,  s.avgOutPps)),
                    E('td', { class: 'td' }, inOut(s.maxInPps,  s.maxOutPps)),
                    E('td', { class: 'td' }, inOut(
                        toKbps(s.avgInBps),
                        toKbps(s.avgOutBps)
                    )),
                    // Action button — Ban / Unban / Enable
                    // + a 📌 Log button on priority flows.
                    E('td', { class: 'td' }, (function() {
                        var actionBtn = (function() {
                            if (!(isPublicIp(conn.dst) && conn.dst.indexOf(':') < 0))
                                return null;
                            if (!gsRule)
                                return E('button', {
                                    class: 'btn cbi-button-negative',
                                    style: 'padding:2px 8px; font-size:90%;',
                                    title: _('Add this server to the block list'),
                                    click: ui.createHandlerFn(self, 'banDialog', conn.dst)
                                }, '⛔ ' + _('Ban'));
                            if (gsRule.enabled)
                                return E('button', {
                                    class: 'btn cbi-button-positive',
                                    style: 'padding:2px 8px; font-size:90%;',
                                    title: _('Disable rule "%s" (unbans its whole range)').format(gsRule.name),
                                    click: ui.createHandlerFn(self, 'toggleRule', gsRule.sid, gsRule.name, gsRule.ranges, false)
                                }, '✅ ' + _('Unban'));
                            return E('button', {
                                class: 'btn',
                                style: 'padding:2px 8px; font-size:90%;',
                                title: _('Enable rule "%s" (bans its whole range)').format(gsRule.name),
                                click: ui.createHandlerFn(self, 'toggleRule', gsRule.sid, gsRule.name, gsRule.ranges, true)
                            }, '▶ ' + _('Enable'));
                        })();

                        // 📌 Log + 🏷️ Label — only for priority flows toward a public IP.
                        var logBtn = null, labelBtn = null;
                        if (isPriorityDscp(dscpStr) && isPublicIp(conn.dst)) {
                            var region = gsRule ? gsRule.name : '';
                            logBtn = E('button', {
                                class: 'btn',
                                style: 'padding:2px 8px; font-size:90%; margin-left:4px;',
                                title: _('Save this server to the history log'),
                                click: ui.createHandlerFn(self, 'logServerEntry',
                                        conn.dst, String(conn.dport || ''), region, dscpStr)
                            }, '📌 ' + _('Log'));
                            // only offer Label when the IP is not already covered
                            if (!gsRule && conn.dst.indexOf(':') < 0) {
                                labelBtn = E('button', {
                                    class: 'btn',
                                    style: 'padding:2px 8px; font-size:90%; margin-left:4px;',
                                    title: _('Name this server / range (creates a disabled label rule)'),
                                    click: ui.createHandlerFn(self, 'labelDialog', conn.dst)
                                }, '🏷️ ' + _('Label'));
                            }
                        }

                        // 📷 Capture. Priority flows keep the port-based + full pair.
                        // Any other flow toward an IP gets a single full (by-IP)
                        // capture button, so any traffic can be inspected.
                        var capG = null, capF = null, capC = null;
                        if (isPriorityDscp(dscpStr) && isPublicIp(conn.dst)) {
                            if (PRIORITY_CAPTURE_PORTS)
                                capG = E('button', {
                                    class: 'btn',
                                    style: 'padding:2px 8px; font-size:90%; margin-left:4px;',
                                    title: _('Capture the priority ports (whatever server is picked)'),
                                    click: ui.createHandlerFn(self, 'captureDialog', 'ports', conn.dst)
                                }, '📷 ' + _('Ports'));
                            if (conn.dst.indexOf(':') < 0) {
                                capF = E('button', {
                                    class: 'btn',
                                    style: 'padding:2px 8px; font-size:90%; margin-left:4px;',
                                    title: _('Capture all traffic to/from this server'),
                                    click: ui.createHandlerFn(self, 'captureDialog', 'full', conn.dst)
                                }, '📷 ' + _('Full'));
                            }
                        } else if (conn.dst) {
                            capC = E('button', {
                                class: 'btn',
                                style: 'padding:2px 8px; font-size:90%; margin-left:4px;',
                                title: _('Capture all traffic to/from this IP'),
                                click: ui.createHandlerFn(self, 'captureDialog', 'full', conn.dst)
                            }, '📷 ' + _('Capture'));
                        }

                        if (!actionBtn && !logBtn && !labelBtn && !capG && !capF && !capC) return '';
                        return E('div', { style: 'display:flex; align-items:center; flex-wrap:wrap; gap:2px;' },
                            [ actionBtn, logBtn, labelBtn, capG, capF, capC ].filter(Boolean));
                    })())
                ]));
            });

            // Compteur — affiche "X / Y total" quand un filtre est actif
            var countEl = document.getElementById('dscp_conn_count');
            if (countEl) {
                countEl.textContent = tokens.length
                    ? _('Connections: ') + displayed + ' / ' + conns.length + ' total'
                    : _('Connections: ') + displayed;
            }

            self._updateSortIndicators();

        } catch (e) {
            console.error('renderRows error:', e);
            self._showError(_('Error displaying connections — system may be overloaded'));
        }
    },

    // ------------------------------------------------------------------
    // Comparateur de tri
    // ------------------------------------------------------------------
    _sortValue: function(a, b) {
        var col  = this.sortColumn;
        var desc = this.sortDescending ? 1 : -1;
        var av, bv;

        switch (col) {
            case 'bytes':
                av = (Number(a.in_bytes)   || 0) + (Number(a.out_bytes)   || 0);
                bv = (Number(b.in_bytes)   || 0) + (Number(b.out_bytes)   || 0);
                break;
            case 'packets':
                av = (Number(a.in_packets) || 0) + (Number(a.out_packets) || 0);
                bv = (Number(b.in_packets) || 0) + (Number(b.out_packets) || 0);
                break;
            case 'avgPps':
                av = a._stats ? a._stats.avgInPps + a._stats.avgOutPps : 0;
                bv = b._stats ? b._stats.avgInPps + b._stats.avgOutPps : 0;
                break;
            case 'maxPps':
                av = a._stats ? Math.max(a._stats.maxInPps, a._stats.maxOutPps) : 0;
                bv = b._stats ? Math.max(b._stats.maxInPps, b._stats.maxOutPps) : 0;
                break;
            case 'avgBps':
                av = a._stats ? a._stats.avgInBps + a._stats.avgOutBps : 0;
                bv = b._stats ? b._stats.avgInBps + b._stats.avgOutBps : 0;
                break;
            case 'dscp':
                av = Number(a.dscp) || 0;
                bv = Number(b.dscp) || 0;
                break;
            default:
                av = String(a[col] || '').toLowerCase();
                bv = String(b[col] || '').toLowerCase();
        }

        if (av < bv) return desc;
        if (av > bv) return -desc;
        return 0;
    },

    // ------------------------------------------------------------------
    // Indicateurs de tri visuels
    // ------------------------------------------------------------------
    _updateSortIndicators: function() {
        var col  = this.sortColumn;
        var desc = this.sortDescending;
        document.querySelectorAll('.sort-indicator').forEach(function(el) {
            el.textContent = (el.dataset.col === col) ? (desc ? ' ▼' : ' ▲') : '';
        });
    },

    handleSaveApply: null,
    handleSave:      null,
    handleReset:     null
});
