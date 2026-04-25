'use strict';
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

// =============================================================================
// DSCP value → label mapping
// =============================================================================
var DSCP_MAP = {
    0:  'CS0',
    8:  'CS1',
    10: 'AF11', 12: 'AF12', 14: 'AF13',
    16: 'CS2',
    18: 'AF21', 20: 'AF22', 22: 'AF23',
    24: 'CS3',
    26: 'AF31', 28: 'AF32', 30: 'AF33',
    32: 'CS4',
    34: 'AF41', 36: 'AF42', 38: 'AF43',
    40: 'CS5',
    46: 'EF',
    48: 'CS6',
    56: 'CS7'
};

function dscpToString(mark) {
    var dscp = (mark || 0) & 0x3F;
    return DSCP_MAP[dscp] || String(dscp);
}

// =============================================================================
// DSCP colour coding
// Rouge  = haute priorité  (CS5, CS6, CS7, EF)
// Teal   = priorité moyenne (CS3, CS4, AFx1-AFx3)
// Or     = défaut / basse  (tout le reste)
// =============================================================================
function getDscpColor(dscpName) {
    var name = String(dscpName).toUpperCase();
    if (['CS5', 'CS6', 'CS7', 'EF'].indexOf(name) !== -1)
        return '#FF4500';
    if (['CS3', 'CS4', 'AF31', 'AF32', 'AF33', 'AF41', 'AF42', 'AF43'].indexOf(name) !== -1)
        return '#00CED1';
    return '#FFD700';
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
// Adaptive polling
// Mesure le temps de réponse rpcd et ajuste l'intervalle automatiquement :
//   > 2000ms réponse → ralentit jusqu'à 10s max
//   < 1000ms réponse → accélère jusqu'à 1s min
// =============================================================================
function adaptivePoll(self) {
    if (!self.autoRefresh) return;

    var startTime = Date.now();

    callGetConntrackDSCP().then(function(result) {
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
            uci.load('sqm')
        ]);
    },

    // ------------------------------------------------------------------
    // render() — construction du DOM
    // ------------------------------------------------------------------
render: function(data) {
        var self = this;
        // data is now [connectionsResult, uciLoaded]
        var connectionsData = (data && data[0]) ? data[0] : {};
        var priorityIp4 = uci.get('sqm', '@queue[0]', 'gaming_ip')  || '';
        var priorityIp6 = uci.get('sqm', '@queue[0]', 'gaming_ip6') || '';

        var initialConns = (connectionsData && connectionsData.connections)
            ? Object.values(connectionsData.connections)
            : [];

        // --- Filtre ---
        var filterInput = E('input', {
            type:        'text',
            placeholder: _('Filter: IP, port, protocol, DSCP — multiple terms with spaces (AND logic)'),
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
            { key: 'avgBps',   label: _('Avg BPS')            }
        ];

        var headerRow = E('tr', { class: 'tr table-titles' },
            cols.map(function(col) {
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
            '.zoom-100 { font-size:1rem; }',
            '.zoom-90  { font-size:.9rem; }',
            '.zoom-80  { font-size:.8rem; }',
            '.zoom-70  { font-size:.7rem; }',
            '.zoom-60  { font-size:.6rem; }',
            '.zoom-50  { font-size:.5rem; }',
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
                ui.addNotification(null, E("p", _("No priority IP configured. Set gaming_ip in SQM first.")), "warning");
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
                    ui.addNotification(null, E("p",
                        _("Conntrack result: %d flow entries deleted (%d IPv4, %d IPv6)").format(total, v4, v6)
                    ), "success");
                })
                .catch(function(err) {
                    ui.addNotification(null, E("p",
                        _("Flush error: %s").format((err && err.message) || "unknown")
                    ), "danger");
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
    _showError: function(msg) {
        var table = this.tableEl;
        if (!table) return;
        while (table.rows.length > 1) table.deleteRow(1);
        table.appendChild(E('tr', { class: 'tr' }, [
            E('td', {
                class:   'td',
                colspan: '9',
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

                // Application du filtre
                if (tokens.length > 0) {
                    var fields = [
                        proto.toLowerCase(),
                        srcFull.toLowerCase(),
                        dstFull.toLowerCase(),
                        dscpStr.toLowerCase()
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
                    E('td', { class: 'td', title: dstFull }, dstDisp),
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
                    ))
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
