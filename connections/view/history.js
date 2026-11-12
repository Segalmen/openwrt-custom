'use strict';
'require view';
'require rpc';
'require ui';
'require uci';

// =============================================================================
// Server History — manually logged servers.
// Entries are appended by the 📌 Log button in the Connections tab.
// =============================================================================

var callGetServerHistory = rpc.declare({
    object: 'luci.dscp',
    method: 'getServerHistory',
    expect: { }
});

var callClearServerHistory = rpc.declare({
    object: 'luci.dscp',
    method: 'clearServerHistory',
    expect: { }
});

// label a server by range (single write path in backend)
var callLabelServer = rpc.declare({
    object: 'luci.dscp',
    method: 'labelServer',
    params: [ 'name', 'cidr' ],
    expect: { }
});

// suggest a CIDR for an IP (read-only). KEEP IN SYNC with connections.js
var callSuggestCidr = rpc.declare({
    object: 'luci.dscp',
    method: 'suggestCidr',
    params: [ 'ip' ],
    expect: { }
});

// Minimal public-CIDR check. KEEP IN SYNC with connections.js isPublicCidr.
function isPublicCidr(cidr) {
    var m = (cidr || '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
    if (!m) return false;
    var a = +m[1], b = +m[2], pfx = +m[5];
    if (a > 255 || b > 255 || +m[3] > 255 || +m[4] > 255 || pfx < 8 || pfx > 32) return false;
    if (a === 10) return false;                          // 10/8
    if (a === 172 && b >= 16 && b <= 31) return false;   // 172.16/12
    if (a === 192 && b === 168) return false;            // 192.168/16
    if (a === 127 || a === 0) return false;              // loopback / this
    if (a === 169 && b === 254) return false;            // link-local
    if (a >= 224) return false;                          // multicast/reserved
    return true;
}

// True when `cidr` has a valid shape but a prefix shorter than /8 (too wide).
// KEEP IN SYNC with connections.js cidrTooWide.
function cidrTooWide(cidr) {
    var m = (cidr || '').match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
    return !!m && +m[5] < 8;
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

function fmtTime(ts) {
    if (!ts) return '–';
    var d = new Date(ts * 1000);
    var p = function(n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
         + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

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

function ipInCidr4(ip, cidr) {
    var c = parseCidr4(cidr);
    if (!c || !ip || ip.indexOf(':') >= 0) return false;
    var o = ip.split('.').map(Number);
    if (o.length !== 4 || o.some(function(x){ return isNaN(x); })) return false;
    var addr = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
    if (c.prefix === 0) return true;
    var mask = (0xFFFFFFFF << (32 - c.prefix)) >>> 0;
    return (addr & mask) >>> 0 === (c.base & mask) >>> 0;
}

// Name of the serverrules rule covering ip today (label or ban), or ''.
// The region stored at log time stays empty when the server was labelled
// afterwards; this keeps the Region column current.
// Same range matching as connections.js findCoveringRule, but a rule with
// no name option in an anonymous section is skipped: its generated section
// id (cfgXXXXXX) is not a readable region. The search then goes on, and
// the stored region stays when no readable rule covers the IP.
function coveringRuleName(ip) {
    var hit = '';
    uci.sections('serverrules', 'rule', function(s) {
        if (hit) return;
        var label = s.name || (s['.anonymous'] ? '' : s['.name']);
        if (!label) return;
        L.toArray(s.range).forEach(function(r) {
            if (!hit && ipInCidr4(ip, r)) hit = label;
        });
    });
    return hit;
}

return view.extend({

    load: function() {
        // load serverrules so uci.sections works in the label dropdown
        return Promise.all([
            callGetServerHistory().catch(function() { return {}; }),
            uci.load('serverrules').catch(function() { return null; })
        ]).then(function(r) { return r[0]; });
    },

    // Aggregate entries by IP: count "seen X times" + keep last timestamp + region.
    aggregate: function(entries) {
        var byIp = {};
        var order = [];
        entries.forEach(function(e) {
            var ip = e.ip || '?';
            if (!byIp[ip]) {
                byIp[ip] = { ip: ip, region: e.region || '', port: e.port || '',
                             dscp: e.dscp || '', count: 0, last: 0 };
                order.push(ip);
            }
            var a = byIp[ip];
            a.count += 1;
            if ((e.ts || 0) > a.last) a.last = e.ts || 0;
            if (e.region) a.region = e.region;
        });
        order.forEach(function(ip) {
            if (!byIp[ip].region) byIp[ip].region = coveringRuleName(ip);
        });
        return order.map(function(ip) { return byIp[ip]; })
                    .sort(function(a, b) { return b.last - a.last; });
    },

    renderBody: function(data) {
        var self = this;
        var entries = (data && data.entries) ? data.entries : [];
        var host = document.getElementById('srv_hist_body');
        if (!host) return;
        while (host.firstChild) host.removeChild(host.firstChild);

        if (!entries.length) {
            host.appendChild(E('p', { style: 'opacity:.7;' },
                _('No servers logged yet. Use the 📌 Log button on a priority flow in the Connections tab.')));
            return;
        }

        var rows = self.aggregate(entries);
        var distinctRegions = {};
        rows.forEach(function(r) { if (r.region) distinctRegions[r.region] = 1; });

        host.appendChild(E('p', { style: 'opacity:.75; font-size:90%; margin-bottom:8px;' },
            _('%d distinct server(s), %d region(s), %d total log(s).').format(
                rows.length, Object.keys(distinctRegions).length, entries.length)));

        var head = E('tr', {}, [
            E('th', { style: 'text-align:left;' }, _('Last seen')),
            E('th', { style: 'text-align:left;' }, _('Server IP')),
            E('th', { style: 'text-align:left;' }, _('Region / rule')),
            E('th', { style: 'text-align:left;' }, _('Port')),
            E('th', { style: 'text-align:left;' }, _('DSCP')),
            E('th', { style: 'text-align:right;' }, _('Seen')),
            E('th', { style: 'text-align:right;' }, _('Action'))
        ]);

        var trs = [ head ];
        rows.forEach(function(r) {
            // offer Label only when this IP has no covering rule yet
            var labelCell = r.region
                ? E('td', { style: 'text-align:right; opacity:.5;' }, '—')
                : E('td', { style: 'text-align:right;' }, E('button', {
                      class: 'btn',
                      style: 'padding:2px 8px; font-size:90%;',
                      title: _('Name this server / range'),
                      click: ui.createHandlerFn(self, 'labelDialog', r.ip)
                  }, '🏷️ ' + _('Label')));
            trs.push(E('tr', {}, [
                E('td', {}, fmtTime(r.last)),
                E('td', {}, E('a', {
                    href: 'https://ipinfo.io/' + r.ip, target: '_blank', rel: 'noopener',
                    style: 'text-decoration:underline dotted;'
                }, r.ip)),
                E('td', {}, r.region || '—'),
                E('td', {}, r.port || '—'),
                E('td', { style: 'font-weight:bold;' }, r.dscp || '—'),
                E('td', { style: 'text-align:right; font-variant-numeric:tabular-nums;' },
                  String(r.count)),
                labelCell
            ]));
        });

        host.appendChild(E('table', {
            class: 'table',
            style: 'width:100%; border-collapse:collapse;'
        }, trs));
    },

    handleClear: function() {
        var self = this;
        ui.showModal(_('Clear server history'), [
            E('p', _('This permanently deletes all logged servers. Continue?')),
            E('div', { class: 'right', style: 'margin-top:12px;' }, [
                E('button', { class: 'btn', click: ui.hideModal }, _('Cancel')),
                ' ',
                E('button', {
                    class: 'btn cbi-button-negative',
                    click: function() {
                        callClearServerHistory().then(function() {
                            ui.hideModal();
                            self.refresh();
                        });
                    }
                }, _('Clear all'))
            ])
        ]);
    },

    // label a server by range. KEEP IN SYNC with
    // connections.js labelDialog (same modal, same backend call).
    labelDialog: function(ip) {
        var self = this;
        var base = (ip || '').split('.').slice(0, 3).join('.') + '.0/24';
        var cidrInput = E('input', {
            type: 'text', class: 'cbi-input-text', style: 'width:100%;', value: base
        });
        // label dropdown via uci.sections (pattern Ban, no rpc).
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
            class: 'btn', style: 'padding:2px 8px; font-size:85%; margin-top:4px;'
        }, _('Widen to /16'));
        widenBtn.style.display = 'none';
        var errBox = E('div', { style: 'color:#e0524f; margin-top:8px; min-height:1.2em;' }, '');

        // smart suggestion + preselect neighbour rule.
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
        }).catch(function() {});

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
                                ui.addNotification(null, E('p', _('Label "%s" %s %s.').format(nm,
                                    res.created ? _('created with') : _('extended with'), cidr)), 'info');
                                self.refresh();
                            } else {
                                ui.addNotification(null, E('p', _('Label failed: %s')
                                    .format((res && res.error) || _('unknown'))), 'error');
                            }
                        }).catch(function(e) {
                            ui.addNotification(null, E('p', _('Label failed: %s').format(e.message || e)), 'error');
                        });
                    }
                }, _('Save label')))
            ])
        ]);
        // the button exists now: apply the current selection to its label
        syncNameField();
    },

    refresh: function() {
        var self = this;
        // reload serverrules too: labels are written by the backend
        uci.unload('serverrules');
        return Promise.all([
            callGetServerHistory(),
            uci.load('serverrules').catch(function() { return null; })
        ]).then(function(r) {
            var d = r[0];
            self.lastData = d || {};
            self.renderBody(self.lastData);
        });
    },

    render: function(data) {
        var self = this;
        self.lastData = data || {};

        var clearBtn = E('button', {
            class: 'btn cbi-button-negative',
            click: ui.createHandlerFn(self, 'handleClear')
        }, _('Clear all'));

        var refreshBtn = E('button', {
            class: 'btn',
            style: 'margin-right:6px;',
            click: ui.createHandlerFn(self, 'refresh')
        }, _('Refresh'));

        var v = E('div', { class: 'cbi-map' }, [
            E('h2', {}, _('Server History')),
            E('div', { class: 'cbi-section' }, [
                E('div', { style: 'display:flex; justify-content:flex-end; margin-bottom:8px;' },
                  [ refreshBtn, clearBtn ]),
                E('div', { id: 'srv_hist_body' }, [])
            ])
        ]);

        setTimeout(function() { self.renderBody(self.lastData); }, 0);
        return v;
    },

    handleSaveApply: null,
    handleSave:      null,
    handleReset:     null
});
