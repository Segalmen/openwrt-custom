'use strict';
'require view';
'require form';
'require fs';
'require rpc';
'require tools.widgets as widgets';

var callHostHints = rpc.declare({
	object: 'luci-rpc',
	method: 'getHostHints',
	expect: { '': {} }
});

return view.extend({
	load: function() {
		return Promise.all([
			L.resolveDefault(callHostHints(), {}),
			L.resolveDefault(fs.exec('/usr/sbin/lagsim', [ 'status' ]), {})
		]);
	},

	render: function(data) {
		var hosts = data[0] || {}, st = data[1] || {}, m, s, o;

		m = new form.Map('lagsim', _('Lag Simulator'),
			_('Adds latency, jitter and packet loss to selected devices (netem). It can only make a connection worse, never better.'));

		s = m.section(form.NamedSection, 'globals', 'globals', _('General'));
		o = s.option(form.Flag, 'enabled', _('Enable'));
		o.rmempty = false;
		o = s.option(widgets.DeviceSelect, 'device', _('Interface'),
			_('Interface towards the devices. br-lan covers wired and Wi-Fi clients on most routers.'));
		o.rmempty = false;
		o.noaliases = true;
		o.default = 'br-lan';

		s = m.section(form.GridSection, 'target', _('Devices'));
		s.addremove = true;
		s.anonymous = true;
		s.nodescriptions = true;

		o = s.option(form.Flag, 'enabled', _('Active'));
		o.default = '1';
		o.editable = true;

		o = s.option(form.Value, 'name', _('Name'));

		o = s.option(form.Value, 'mac', _('MAC address'));
		o.datatype = 'macaddr';
		o.rmempty = false;
		Object.keys(hosts).sort().forEach(function(mac) {
			var h = hosts[mac], ip = (h.ipaddrs || h.ipv4 || [])[0];
			o.value(mac, '%s (%s)'.format(mac, h.name || ip || '?'));
		});

		o = s.option(form.ListValue, 'direction', _('Direction'));
		o.value('both', _('Both (split in half)'));
		o.value('down', _('Download only'));
		o.value('up', _('Upload only'));
		o.default = 'both';

		o = s.option(form.Value, 'delay', _('Delay (ms)'));
		o.datatype = 'range(0,5000)';
		o.default = '0';

		o = s.option(form.Value, 'jitter', _('Jitter (ms)'));
		o.datatype = 'range(0,2000)';
		o.default = '0';

		o = s.option(form.ListValue, 'distribution', _('Jitter shape'));
		o.value('uniform', _('Uniform'));
		o.value('normal', _('Normal'));
		o.value('pareto', _('Pareto'));
		o.value('paretonormal', _('Pareto-normal'));
		o.default = 'uniform';

		o = s.option(form.Value, 'loss', _('Loss (%)'));
		o.datatype = 'range(0,100)';
		o.default = '0';

		return m.render().then(function(node) {
			node.appendChild(E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Status')),
				E('pre', {}, (st.stdout || _('unavailable')).trim())
			]));
			return node;
		});
	}
});
