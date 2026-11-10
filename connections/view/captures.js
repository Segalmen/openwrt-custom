'use strict';
'require view';
'require rpc';
'require ui';
'require fs';
'require poll';

// =============================================================================
// Packet Captures — list/download/delete tcpdump captures.
// Captures are launched from the Connections tab (📷 Ports / 📷 Full / 📷 Capture),
// stored in /tmp/dscp-captures (RAM, not under /www). Download goes through
// fs.read_direct (cgi-io, authenticated) so files are never publicly served.
// =============================================================================

var callListCaptures = rpc.declare({
    object: 'luci.dscp',
    method: 'listCaptures',
    expect: { }
});

var callDeleteCapture = rpc.declare({
    object: 'luci.dscp',
    method: 'deleteCapture',
    params: [ 'name' ],
    expect: { }
});

function fmtSize(n) {
    n = n || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KiB';
    return (n / (1024 * 1024)).toFixed(2) + ' MiB';
}

// Parse the unix timestamp embedded in the filename: capture-<tag>-<ts>.pcap
function tsFromName(name) {
    var m = (name || '').match(/-(\d+)\.pcap/);
    if (!m) return null;
    var d = new Date(parseInt(m[1], 10) * 1000);
    var p = function(x) { return (x < 10 ? '0' : '') + x; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
         + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

return view.extend({

    pollInterval: 3,

    load: function() {
        return callListCaptures().catch(function() { return {}; });
    },

    // Download a capture file as a blob via authenticated cgi-io.
    downloadCapture: function(name) {
        var path = '/tmp/dscp-captures/' + name;
        return fs.read_direct(path, 'blob').then(function(blob) {
            var url = window.URL.createObjectURL(blob);
            var a = E('a', { href: url, download: name, style: 'display:none;' });
            document.body.appendChild(a);
            a.click();
            window.setTimeout(function() {
                document.body.removeChild(a);
                window.URL.revokeObjectURL(url);
            }, 1000);
        }).catch(function(e) {
            ui.addNotification(null, E('p', _('Download failed: %s').format(e.message || e)), 'error');
        });
    },

    deleteOne: function(name) {
        var self = this;
        return callDeleteCapture(name).then(function() { self.refresh(); });
    },

    refresh: function() {
        var self = this;
        return callListCaptures().then(function(d) {
            self.lastData = d || {};
            self.renderBody(self.lastData);
        });
    },

    renderBody: function(data) {
        var self = this;
        var files = (data && data.files) ? data.files : [];
        var running = (data && data.running) || 0;
        var host = document.getElementById('cap_body');
        if (!host) return;
        while (host.firstChild) host.removeChild(host.firstChild);

        // running indicator (running is now a count of live captures)
        var nrun = (typeof running === 'number') ? running : (running ? 1 : 0);
        var status = E('div', { style: 'margin-bottom:10px; font-size:90%;' },
            nrun > 0
                ? [ E('span', { style: 'color:#e0a23f; font-weight:bold;' }, '● '),
                    (nrun === 1 ? _('A capture is running…')
                                : _('%d captures are running…').format(nrun)) ]
                : [ E('span', { style: 'color:#4caf6e;' }, '● '),
                    _('Idle — no capture running.') ]);
        host.appendChild(status);

        if (!files.length) {
            host.appendChild(E('p', { style: 'opacity:.7;' },
                _('No captures yet. Use the 📷 buttons on a flow in the Connections tab.')));
            return;
        }

        var head = E('tr', {}, [
            E('th', { style: 'text-align:left;' }, _('When')),
            E('th', { style: 'text-align:left;' }, _('File')),
            E('th', { style: 'text-align:right;' }, _('Size')),
            E('th', { style: 'text-align:right;' }, _('Actions'))
        ]);
        var trs = [ head ];
        files.sort(function(a, b) { return (b.name || '').localeCompare(a.name || ''); });
        files.forEach(function(f) {
            trs.push(E('tr', {}, [
                E('td', {}, tsFromName(f.name) || '–'),
                E('td', { style: 'font-family:monospace; font-size:90%;' }, f.name),
                E('td', { style: 'text-align:right; font-variant-numeric:tabular-nums;' },
                  fmtSize(f.size)),
                E('td', { style: 'text-align:right; white-space:nowrap;' }, [
                    E('button', {
                        class: 'btn cbi-button-action',
                        style: 'padding:2px 8px; font-size:90%;',
                        disabled: (f.size > 0) ? null : '',
                        title: (f.size > 0) ? _('Download this capture') : _('Empty capture'),
                        click: ui.createHandlerFn(self, 'downloadCapture', f.name)
                    }, '⬇ ' + _('Download')),
                    ' ',
                    E('button', {
                        class: 'btn cbi-button-negative',
                        style: 'padding:2px 8px; font-size:90%;',
                        click: ui.createHandlerFn(self, 'deleteOne', f.name)
                    }, '✕')
                ])
            ]));
        });

        host.appendChild(E('table', {
            class: 'table',
            style: 'width:100%; border-collapse:collapse;'
        }, trs));
    },

    render: function(data) {
        var self = this;
        self.lastData = data || {};

        var refreshBtn = E('button', {
            class: 'btn',
            click: ui.createHandlerFn(self, 'refresh')
        }, _('Refresh'));

        var v = E('div', { class: 'cbi-map' }, [
            E('h2', {}, _('Packet Captures')),
            E('div', { class: 'cbi-section' }, [
                E('p', { style: 'opacity:.75; font-size:90%;' },
                  _('Captures are stored in RAM (/tmp) and lost on reboot. '
                    + 'Download the ones you want to keep, then delete them to free memory.')),
                E('div', { style: 'display:flex; justify-content:flex-end; margin-bottom:8px;' },
                  [ refreshBtn ]),
                E('div', { id: 'cap_body' }, [])
            ])
        ]);

        setTimeout(function() { self.renderBody(self.lastData); }, 0);

        // light auto-refresh so a running capture's status/size updates
        poll.add(function() {
            return callListCaptures().then(function(d) {
                self.lastData = d || {};
                self.renderBody(self.lastData);
            });
        }, self.pollInterval);

        return v;
    },

    handleSaveApply: null,
    handleSave:      null,
    handleReset:     null
});
