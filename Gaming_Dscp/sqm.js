'use strict';
'require fs';
'require ui';
'require rpc';
'require uci';
'require view';
'require form';
'require tools.widgets as widgets';

return view.extend({

    handleGetHelpText: function(scriptName, tbl) {
        return fs.read('/usr/lib/sqm/' + scriptName + '.help').then(function(text) {
            if (text) return [scriptName, text];
        });
    },

    handleEnableSQM: rpc.declare({
        object: 'luci',
        method: 'setInitAction',
        params: ['sqm', 'enable'],
        expect: { result: false }
    }),

    load: function() {
        return Promise.all([
            L.resolveDefault(fs.list('/var/run/sqm/available_qdiscs'), []),
            L.resolveDefault(
                fs.list('/usr/lib/sqm').then(L.bind(function(scripts) {
                    var tasks = [];
                    for (var i = 0; i < scripts.length; i++) {
                        if (scripts[i].name.search(/\.qos$/) !== -1) {
                            tasks.push(L.resolveDefault(
                                this.handleGetHelpText(scripts[i].name, {}),
                                [scripts[i].name, null]
                            ));
                        }
                    }
                    return Promise.all(tasks);
                }, this)),
                []
            ),
            uci.load('sqm')
        ]);
    },

    render: function(data) {
        var qdiscs  = data[0];
        var scripts = data[1];

        if (qdiscs.length === 0) {
            ui.addNotification(null, E('div', { class: 'left' }, [
                E('p', _('The SQM service seems to be disabled. Please use the button below to activate this service.')),
                E('button', {
                    class: 'btn cbi-button-active',
                    click: ui.createHandlerFn(this, function() {
                        return fs.exec('/etc/init.d/sqm', ['enable'])
                            .then(function() { return fs.exec('/etc/init.d/sqm', ['start']); })
                            .then(function() { location.reload(); });
                    })
                }, _('Enable SQM'))
            ]));
        }

        var m, s, o;
        m = new form.Map('sqm', _('Smart Queue Management'));
        m.description = _('With <abbr title="Smart Queue Management">SQM</abbr> you ' +
            'can enable traffic shaping, better mixing (Fair Queueing), ' +
            'active queue length management (AQM) ' +
            'and prioritisation on one network interface.');

        s = m.section(form.TypedSection, 'queue', _('Queues'));
        s.anonymous  = true;
        s.addremove  = true;

        s.tab('tab_basic',     _('Basic Settings'));
        s.tab('tab_qdisc',     _('Queue Discipline'));
        s.tab('tab_linklayer', _('Link Layer Adaptation'));
        s.tab('tab_dscp',      _('DSCP Policies'));
		

        // ==================================================================
        // Helper: validate port lists (comma-separated ports and ranges)
        // ==================================================================
        // Accepted: "443", "80,443", "3000-4000", "80,443,3000-4000"
        // Rejected: spaces, non-digit chars, ports out of range, inverted ranges
        var validatePortList = function(section_id, value) {
            // Empty allowed (all port fields use rmempty:true)
            if (value == null || value === '')
                return true;

            // No whitespace anywhere
            if (/\s/.test(value))
                return _('Spaces are not allowed. Use commas without spaces (e.g. "80,443,3000-4000").');

            // Only digits, commas and dashes
            if (!/^[0-9,\-]+$/.test(value))
                return _('Only digits, commas and dashes are allowed (e.g. "80,443,3000-4000").');

            // Per-element validation: each must be a valid port or range
            var parts = value.split(',');
            for (var i = 0; i < parts.length; i++) {
                var p = parts[i];
                if (p === '')
                    return _('Empty element in the list (double comma or trailing comma?).');

                if (p.indexOf('-') !== -1) {
                    // Range "start-end"
                    var range = p.split('-');
                    if (range.length !== 2 || range[0] === '' || range[1] === '')
                        return _('Invalid range: "%s". Use "start-end" (e.g. "3000-4000").').format(p);

                    var start = parseInt(range[0], 10);
                    var end   = parseInt(range[1], 10);

                    if (isNaN(start) || isNaN(end))
                        return _('Invalid range: "%s".').format(p);
                    if (start < 1 || start > 65535 || end < 1 || end > 65535)
                        return _('Port out of range (1-65535) in "%s".').format(p);
                    if (start >= end)
                        return _('Range "%s": start must be less than end.').format(p);
                } else {
                    // Single port
                    var port = parseInt(p, 10);
                    if (isNaN(port) || port < 1 || port > 65535)
                        return _('Invalid port "%s" (must be 1-65535).').format(p);
                }
            }
            return true;
        };

        // ==================================================================
        // Tab: DSCP Policies
        // ==================================================================

        // --- Multi-queue ---
        o = s.taboption('tab_dscp', form.Flag, 'enable_mq',
            _('Enable Multi-Queue (cake_mq)'));
        o.default     = '1';
        o.rmempty     = false;
        o.description = _('Use cake_mq for multi-core hardware or NIC queue support. ' +
                          'Recommended on routers with 2+ CPU cores.');

        // --- ctinfo ---
        o = s.taboption('tab_dscp', form.Flag, 'ctinfo_enable',
            _('Enable DSCP restore via conntrack (ctinfo)'));
        o.default     = '1';
        o.rmempty     = false;
        o.description = _('Store DSCP into conntrack mark and restore it on ingress using ctinfo. ' +
                          'Required for correct CAKE DiffServ behaviour on download traffic.');

        // --- Priority IPs ---
        o = s.taboption('tab_dscp', form.Value, 'gaming_ip',
            _('Priority device IPv4 address(es)'));
        o.placeholder = '192.168.1.100,192.168.1.101';
        o.rmempty     = true;
        o.description = _('One or more IPv4 addresses of latency-sensitive devices ' +
                          '(console, gaming PC, VoIP phone, workstation...), separated by commas.');

        o = s.taboption('tab_dscp', form.Value, 'gaming_ip6',
            _('Priority device IPv6 address(es) or prefix(es)'));
        o.placeholder = 'fd00::100,fd00::101';
        o.rmempty     = true;
        o.description = _('One or more IPv6 addresses or prefixes of latency-sensitive devices, ' +
                          'separated by commas.');

        // ==== UDP ====
        o = s.taboption('tab_dscp', form.Flag, 'priority_udp_enable',
            _('Enable Priority UDP classification'));
        o.default     = '0';
        o.rmempty     = false;
        o.description = _('Mark UDP traffic from/to priority devices on the specified ports ' +
                          'with the selected DSCP value. Suitable for gaming, VoIP, real-time apps.');

        o = s.taboption('tab_dscp', form.ListValue, 'priority_udp_dscp',
            _('Priority DSCP — UDP'));
        o.value('ef',   _('EF — Expedited Forwarding (highest)'));
        o.value('cs5',  _('CS5 — Real-Time / High Priority'));
        o.value('cs4',  _('CS4 — High Priority'));
        o.value('af41', _('AF41 — Interactive'));
        o.value('cs0',  _('CS0 — Default'));
        o.default     = 'ef';
        o.rmempty     = false;
        o.depends('priority_udp_enable', '1');
        o.description = _('DSCP value applied to matched UDP traffic.');

        o = s.taboption('tab_dscp', form.Value, 'gaming_udp_ports',
            _('Priority UDP ports'));
        o.placeholder = '3659,3074,3478-3480,10000-45000';
        o.rmempty     = true;
        o.depends('priority_udp_enable', '1');
        o.validate    = validatePortList;
        o.description = _('Comma-separated ports or ranges used by latency-sensitive UDP applications.');

        // ==== TCP ====
        o = s.taboption('tab_dscp', form.Flag, 'priority_tcp_enable',
            _('Enable Priority TCP classification'));
        o.default     = '0';
        o.rmempty     = false;
        o.description = _('Mark TCP traffic from/to priority devices on the specified ports. ' +
                          'Useful for remote desktop, video conferencing signalling, etc.');

        o = s.taboption('tab_dscp', form.ListValue, 'priority_tcp_dscp',
            _('Priority DSCP — TCP'));
        o.value('ef',   _('EF — Expedited Forwarding (highest)'));
        o.value('cs4',  _('CS4 — High Priority'));
        o.value('af41', _('AF41 — Interactive'));
        o.value('cs0',  _('CS0 — Default'));
        o.default     = 'af41';
        o.rmempty     = false;
        o.depends('priority_tcp_enable', '1');
        o.description = _('DSCP value applied to matched TCP traffic.');

        o = s.taboption('tab_dscp', form.Value, 'gaming_tcp_ports',
            _('Priority TCP ports'));
        o.placeholder = '3074,3659';
        o.rmempty     = true;
        o.depends('priority_tcp_enable', '1');
        o.validate    = validatePortList;
        o.description = _('Comma-separated TCP ports used by latency-sensitive applications.');

        // ==== Micro-packet priority ====
        o = s.taboption('tab_dscp', form.Flag, 'micro_pkt_enable',
            _('Enable micro-packet priority'));
        o.default     = '1';
        o.rmempty     = false;
        o.description = _('Automatically boost very small packets from priority devices to the ' +
                          'highest CAKE tin. Ideal for TCP ACKs, UDP keepalives, VoIP signalling ' +
                          'and real-time control packets. Default thresholds (configurable below) ' +
                          'are tuned to NOT match modern gaming traffic. Packets in the small ' +
                          'range get the Priority UDP DSCP value.');

        o = s.taboption('tab_dscp', form.ListValue, 'micro_pkt_dscp',
            _('Micro-packet DSCP'));
        o.value('cs6', _('CS6 — Network Control (highest CAKE tin)'));
        o.value('cs7', _('CS7 — Network Control (absolute highest)'));
        o.value('ef',  _('EF — Expedited Forwarding'));
        o.default     = 'cs6';
        o.rmempty     = false;
        o.depends('micro_pkt_enable', '1');
        o.description = _('DSCP value applied to ultra-small packets from priority devices.');
		
		// ==== Micro / Small packet thresholds ====
        o = s.taboption('tab_dscp', form.Value, 'micro_pkt_threshold',
            _('Micro-packet size threshold (bytes)'));
        o.placeholder = '60';
        o.default     = '60';
        o.rmempty     = true;
        o.datatype    = 'and(uinteger,min(40),max(200))';
        o.depends('micro_pkt_enable', '1');
        o.description = _('Packets smaller than this size from priority devices are upgraded to ' +
                          'the Micro-packet DSCP. Default 60 bytes captures pure control traffic ' +
                          '(TCP ACKs, UDP keepalives) without affecting gaming flows. Modern FPS/sports ' +
                          'games average 70-150 bytes/packet, so values above 60 may saturate the ' +
                          'Voice tin codel under load. Range 40-200.');

        o = s.taboption('tab_dscp', form.Value, 'small_pkt_threshold',
            _('Small-packet size threshold (bytes)'));
        o.placeholder = '200';
        o.default     = '200';
        o.rmempty     = true;
        o.datatype    = 'and(uinteger,min(100),max(500))';
        o.depends('micro_pkt_enable', '1');
        o.description = _('Packets between Micro and this size are upgraded to the Priority UDP DSCP. ' +
                          'Default 200 bytes captures small interactive packets like VoIP RTP. ' +
                          'Must be greater than Micro threshold. Range 100-500.');

        // ==== Browsing ====
        o = s.taboption('tab_dscp', form.Flag, 'browsing_enable',
            _('Enable web browsing classification'));
        o.default     = '0';
        o.rmempty     = false;
        o.description = _('Apply a specific DSCP to web traffic (HTTP/HTTPS/QUIC). ' +
                          'Can be used to deprioritize bulk web traffic relative to real-time flows.');

        o = s.taboption('tab_dscp', form.Value, 'browsing_tcp_ports',
            _('Browsing TCP ports'));
        o.placeholder = '80,8080,443,853';
        o.rmempty     = true;
        o.depends('browsing_enable', '1');
        o.validate    = validatePortList;
        o.description = _('TCP ports for web traffic (HTTP, HTTPS, DoT...).');

        o = s.taboption('tab_dscp', form.Value, 'browsing_udp_ports',
            _('Browsing UDP ports'));
        o.placeholder = '443';
        o.rmempty     = true;
        o.depends('browsing_enable', '1');
        o.validate    = validatePortList;
        o.description = _('UDP ports for web traffic (QUIC/HTTP3).');

        o = s.taboption('tab_dscp', form.ListValue, 'browsing_dscp',
            _('Browsing DSCP'));
        o.value('af21', _('AF21 — Low-latency web'));
        o.value('af31', _('AF31 — Higher priority'));
        o.value('af41', _('AF41 — Multimedia / Streaming'));
		o.value('cs1',  _('CS1 — Background'));
        o.value('cs0',  _('CS0 — Default'));
        o.default     = 'af21';
        o.rmempty     = true;
        o.depends('browsing_enable', '1');
        o.description = _('DSCP value applied to web browsing traffic.');

        // ==== Bulk ====
        o = s.taboption('tab_dscp', form.Flag, 'gaming_bulk_enable',
            _('Enable bulk traffic classification'));
        o.default     = '0';
        o.rmempty     = false;
        o.description = _('Mark large downloads (HTTP/HTTPS) from priority devices with a ' +
                          'lower DSCP value so they do not compete with real-time traffic.');

        o = s.taboption('tab_dscp', form.ListValue, 'gaming_bulk_dscp',
            _('Bulk traffic DSCP'));
        o.value('cs1',  _('CS1 — Background / Bulk'));
        o.value('af11', _('AF11 — Bulk but not lowest'));
        o.value('cs0',  _('CS0 — Default'));
        o.default     = 'cs1';
        o.rmempty     = true;
        o.depends('gaming_bulk_enable', '1');
        o.description = _('DSCP value applied to bulk download traffic from priority devices.');

        // ==== Big HTTPS auto-downgrade ====
        o = s.taboption('tab_dscp', form.Flag, 'big_https_downgrade',
            _('Enable big HTTPS auto-downgrade'));
        o.default     = '1';
        o.rmempty     = false;
        o.depends('gaming_bulk_enable', '1');
        o.description = _('Automatically downgrade large HTTPS packets (&gt;1000 bytes) from ' +
                          'priority devices to the Bulk DSCP value. ' +
                          'Prevents big downloads from stealing bandwidth from real-time traffic.');
						  


        // ==================================================================
        // Tab: Basic Settings
        // ==================================================================

        o = s.taboption('tab_basic', form.Flag, 'enabled',
            _('Enable this SQM instance.'));
        o.rmempty = false;
        o.write   = L.bind(function(section, value) {
            if (value === '1') {
                this.handleEnableSQM();
                ui.addNotification(null, E('p', _('The SQM GUI has just enabled the sqm initscript on your behalf. ' +
                    'Remember to disable the sqm initscript manually under System → Startup if this was not intended.')));
            }
            return uci.set('sqm', section, 'enabled', value);
        }, this);

        o = s.taboption('tab_basic', widgets.DeviceSelect, 'interface',
            _('Interface name'));
        o.rmempty = false;

        o = s.taboption('tab_basic', form.Value, 'download',
            _('Download speed (ingress)'),
            _('Speed in kbit/s. Set to 0 to disable ingress shaping.'));
        o.datatype = 'and(uinteger,min(0))';
        o.rmempty  = false;

        o = s.taboption('tab_basic', form.Value, 'upload',
            _('Upload speed (egress)'),
            _('Speed in kbit/s. Set to 0 to disable egress shaping.'));
        o.datatype = 'and(uinteger,min(0))';
        o.rmempty  = false;

        o = s.taboption('tab_basic', form.Flag, 'debug_logging',
            _('Enable debug logging'),
            _('Write logs to /var/run/sqm/${Interface_name}.[start|stop]-sqm.log'));
        o.rmempty = false;

        o = s.taboption('tab_basic', form.ListValue, 'verbosity',
            _('Log verbosity'),
            _('Controls SQM output detail in syslog.'));
        o.value('0',  _('Silent'));
        o.value('1',  _('Error'));
        o.value('2',  _('Warning'));
        o.value('5',  _('Info (default)'));
        o.value('8',  _('Debug'));
        o.value('10', _('Trace'));
        o.default = '5';

        // ==================================================================
        // Tab: Queue Discipline
        // ==================================================================

        o = s.taboption('tab_qdisc', form.ListValue, 'qdisc',
            _('Queueing discipline'),
            _('Available qdiscs on this system. Restart the router after installing a new qdisc.'));
        for (var i = 0; i < qdiscs.length; i++) {
            o.value(qdiscs[i].name);
        }
        o.default  = 'cake';
        o.rmempty  = false;

        var qosDesc = '';
        o = s.taboption('tab_qdisc', form.ListValue, 'script',
            _('Queue setup script'));
        for (i = 0; i < scripts.length; i++) {
            o.value(scripts[i][0]);
            qosDesc += '<p><b>' + scripts[i][0] + ':</b><br />';
            qosDesc += scripts[i][1] ? scripts[i][1] + '</p>' : _('No help text') + '</p>';
        }
        o.default     = 'piece_of_cake.qos';
        o.rmempty     = false;
        o.description = qosDesc;

        o = s.taboption('tab_qdisc', form.Flag, 'qdisc_advanced',
            _('Advanced Configuration'),
            _('Advanced options are only used when this box is checked.'));
        o.default = false;

        o = s.taboption('tab_qdisc', form.ListValue, 'squash_dscp',
            _('Squash DSCP (ingress)'),
            _('Squash DSCP markings on inbound packets.'));
        o.value('1', 'SQUASH');
        o.value('0', 'DO NOT SQUASH');
        o.default = '1';
        o.depends('qdisc_advanced', '1');

        o = s.taboption('tab_qdisc', form.ListValue, 'squash_ingress',
            _('Ignore DSCP (ingress)'),
            _('Ignore DSCP markings on inbound packets.'));
        o.value('1', _('Ignore'));
        o.value('0', _('Allow'));
        o.default = '1';
        o.depends('qdisc_advanced', '1');

        o = s.taboption('tab_qdisc', form.ListValue, 'ingress_ecn',
            _('ECN (ingress)'),
            _('Explicit congestion notification on inbound packets.'));
        o.value('ECN',   'ECN (' + _('default') + ')');
        o.value('NOECN', 'NOECN');
        o.default = 'ECN';
        o.depends('qdisc_advanced', '1');

        o = s.taboption('tab_qdisc', form.ListValue, 'egress_ecn',
            _('ECN (egress)'),
            _('Explicit congestion notification on outbound packets.'));
        o.value('NOECN', 'NOECN (' + _('default') + ')');
        o.value('ECN',   'ECN');
        o.default = 'NOECN';
        o.depends('qdisc_advanced', '1');

        o = s.taboption('tab_qdisc', form.Flag, 'qdisc_really_really_advanced',
            _('Dangerous Configuration'),
            _('Dangerous options — only active when checked.'));
        o.default = false;
        o.depends('qdisc_advanced', '1');

        o = s.taboption('tab_qdisc', form.Value, 'ilimit',
            _('Hard queue limit (ingress)'),
            _('Hard limit on ingress queues; leave empty for default.'));
        o.datatype = 'and(uinteger,min(0))';
        o.depends('qdisc_really_really_advanced', '1');

        o = s.taboption('tab_qdisc', form.Value, 'elimit',
            _('Hard queue limit (egress)'),
            _('Hard limit on egress queues; leave empty for default.'));
        o.datatype = 'and(uinteger,min(0))';
        o.depends('qdisc_really_really_advanced', '1');

        o = s.taboption('tab_qdisc', form.Value, 'itarget',
            _('Latency target (ingress)'),
            _('e.g. 5ms [s, ms, or us]; leave empty for automatic selection.'));
        o.datatype = 'string';
        o.depends('qdisc_really_really_advanced', '1');

        o = s.taboption('tab_qdisc', form.Value, 'etarget',
            _('Latency target (egress)'),
            _('e.g. 5ms [s, ms, or us]; leave empty for automatic selection.'));
        o.datatype = 'string';
        o.depends('qdisc_really_really_advanced', '1');

        o = s.taboption('tab_qdisc', form.Value, 'iqdisc_opts',
            _('Qdisc options (ingress)'),
            _('Advanced option string passed to the ingress qdisc; no error checking, use carefully.'));
        o.depends('qdisc_really_really_advanced', '1');

        o = s.taboption('tab_qdisc', form.Value, 'eqdisc_opts',
            _('Qdisc options (egress)'),
            _('Advanced option string passed to the egress qdisc; no error checking, use carefully.'));
        o.depends('qdisc_really_really_advanced', '1');

        // ==================================================================
        // Tab: Link Layer Adaptation
        // ==================================================================

        o = s.taboption('tab_linklayer', form.ListValue, 'linklayer',
            _('Link layer'),
            _('Which link layer technology to account for.'));
        o.value('none',     'none (' + _('default') + ')');
        o.value('ethernet', _('Ethernet with overhead (e.g. VDSL2)'));
        o.value('atm',      _('ATM (e.g. ADSL1, ADSL2, ADSL2+)'));
        o.default = 'none';

        o = s.taboption('tab_linklayer', form.Value, 'overhead',
            _('Per Packet Overhead (bytes)'));
        o.datatype = 'and(integer,min(-1500))';
        o.default  = 0;
        o.depends('linklayer', 'ethernet');
        o.depends('linklayer', 'atm');

        o = s.taboption('tab_linklayer', form.Flag, 'linklayer_advanced',
            _('Advanced Link Layer Options'),
            _('Only needed if MTU > 1500.'));
        o.depends('linklayer', 'ethernet');
        o.depends('linklayer', 'atm');

        o = s.taboption('tab_linklayer', form.Value, 'tcMTU',
            _('Maximum packet size'),
            _('tcMTU (bytes); must be ≥ interface MTU + overhead.'));
        o.datatype = 'and(uinteger,min(0))';
        o.default  = 2047;
        o.depends('linklayer_advanced', '1');

        o = s.taboption('tab_linklayer', form.Value, 'tcTSIZE',
            _('Rate table size'),
            _('TSIZE entries; for ATM use TSIZE = (tcMTU + 1) / 16.'));
        o.datatype = 'and(uinteger,min(0))';
        o.default  = 128;
        o.depends('linklayer_advanced', '1');

        o = s.taboption('tab_linklayer', form.Value, 'tcMPU',
            _('Minimum packet size'),
            _('MPU (bytes); must be > 0 for Ethernet size tables.'));
        o.datatype = 'and(uinteger,min(0))';
        o.default  = 0;
        o.depends('linklayer_advanced', '1');

        o = s.taboption('tab_linklayer', form.ListValue, 'linklayer_adaptation_mechanism',
            _('Link layer adaptation mechanism'),
            _('Which mechanism to use; for testing only.'));
        o.value('default',     'default (' + _('default') + ')');
        o.value('cake',        'cake');
        o.value('htb_private', 'htb_private');
        o.value('tc_stab',     'tc_stab');
        o.default = 'default';
        o.depends('linklayer_advanced', '1');

        return m.render();
    }
});
