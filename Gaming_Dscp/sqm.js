'use strict';'require fs';'require ui';'require rpc';'require uci';'require view';'require form';'require tools.widgets as widgets';return view.extend({handleGetHelpText:function(script_name,tbl){return fs.read("/usr/lib/sqm/"+script_name+".help").then(function(text){if(text)
return[script_name,text];});},handleEnableSQM:rpc.declare({object:'luci',method:'setInitAction',params:['sqm','enable'],expect:{result:false}}),load:function(){return Promise.all([L.resolveDefault(fs.list('/var/run/sqm/available_qdiscs'),[]),L.resolveDefault(fs.list('/usr/lib/sqm'),[]).then(L.bind(function(scripts){var tasks=[],scriptHelpTbl={};for(var i=0;i<scripts.length;i++)
if(scripts[i].name.search(/\.qos$/)!=-1)
tasks.push(L.resolveDefault(this.handleGetHelpText(scripts[i].name,scriptHelpTbl),[scripts[i].name,null]));return Promise.all(tasks);},this)),uci.load('sqm')]);},render:function(data){var qdiscs=data[0],scripts=data[1];if(qdiscs.length===0){ui.addNotification(null,E('div',{'class':'left'},[E('p',_("The SQM service seems to be disabled. Please use the button below to activate this service.")),E('button',{'class':'btn cbi-button-active','click':ui.createHandlerFn(this,function(){return fs.exec('/etc/init.d/sqm',['enable']).then(function(){return fs.exec('/etc/init.d/sqm',['start']);}).then(function(){location.reload();});})},_('Enable SQM'))]));}
let m,s,o;m=new form.Map('sqm',_('Smart Queue Management'));m.description=_("With <abbr title=\"Smart Queue Management\">SQM</abbr> you "+"can enable traffic shaping, better mixing (Fair Queueing),"+" active queue length management (AQM) "+" and prioritisation on one "+"network interface.");s=m.section(form.TypedSection,'queue',_('Queues'));s.tab("tab_basic",_("Basic Settings"));s.tab("tab_qdisc",_("Queue Discipline"));s.tab("tab_linklayer",_("Link Layer Adaptation"));	    /*
     * Onglet Gaming (PS5 / DSCP / Ports / Browsing)
     */
    s.tab("tab_gaming", _("Gaming & DSCP"));
	
    // IP de l'appareil de jeu (PS5, PC, etc.)
    o = s.taboption("tab_gaming", form.Value, "gaming_ip", _("Gaming IP address(es)"));
	o.placeholder = "192.168.2.157";
	o.rmempty     = true;
	// PAS de o.datatype ici → LuCI accepte une chaîne libre
	o.description = _("One or several IPv4 addresses of your gaming device (e.g. PS5,PC).");
	
	    // IPv6 de l'appareil de jeu (PS5, PC, etc.)
    o = s.taboption("tab_gaming", form.Value, "gaming_ip6", _("Gaming IPv6 address(es)"));
    o.placeholder = "2a02:168:c01b::157";
    o.rmempty     = true;
    // Pas de datatype non plus → permet les listes séparées par virgule
    o.description = _("One or several IPv6 addresses of your gaming device (e.g. PS5).");
	
	    // --- Gaming BULK (PS5 downloads via HTTP/HTTPS) ---
    o = s.taboption("tab_gaming", form.Flag, "gaming_bulk_enable",
        _("Enable PS5 bulk class"));
    o.default     = o.disabled;
    o.rmempty     = false;
    o.description = _("If enabled, PS5 HTTP/HTTPS traffic (downloads, updates) " +
                      "will be marked with a separate DSCP, lower than in-game.");

    o = s.taboption("tab_gaming", form.ListValue, "gaming_bulk_dscp",
        _("PS5 bulk DSCP"));
    o.value("cs1",  "CS1 (background / bulk)");
    o.value("af11", "AF11 (bulk but not worst)");
    o.value("cs0",  "CS0 (default)");
    o.default     = "cs1";
    o.depends("gaming_bulk_enable", "1");
    o.rmempty     = true;
    o.description = _("DSCP used for PS5 downloads (HTTP/HTTPS) when bulk class is enabled.");

    // DSCP pour le trafic gaming
    o = s.taboption("tab_gaming", form.ListValue, "gaming_dscp", _("Gaming DSCP"));
    o.value("ef",  "EF (Expedited Forwarding - très prioritaire)");
    o.value("cs4", "CS4 (High Priority)");
    o.value("af41","AF41 (Interactive)");
    o.value("cs0", "CS0 (Default / no special priority)");
    o.default     = "ef";
    o.rmempty     = false;
    o.description = _("DSCP to apply to gaming UDP/TCP traffic.");

    // Ports UDP gaming
    o = s.taboption("tab_gaming", form.Value, "gaming_udp_ports", _("Gaming UDP ports"));
    o.placeholder = "3659,3074,3478-3480,10000-45000";
    o.rmempty     = true;
    o.description = _("Comma-separated UDP ports or ranges used by your games.");

    // Ports TCP gaming (optionnel)
    o = s.taboption("tab_gaming", form.Value, "gaming_tcp_ports", _("Gaming TCP ports"));
    o.placeholder = "3659,3074";
    o.rmempty     = true;
    o.description = _("Optional: TCP ports for gaming / game services.");

    // -------- Browsing (web) --------
    o = s.taboption("tab_gaming", form.Flag, "browsing_enable", _("Enable browsing DSCP"));
    o.default     = o.disabled;
    o.rmempty     = false;
    o.description = _("If enabled, marks web traffic with a chosen DSCP.");

    // Ports TCP pour le web
    o = s.taboption("tab_gaming", form.Value, "browsing_tcp_ports", _("Browsing TCP ports"));
    o.placeholder = "80,8080,443";
    o.rmempty     = true;
    o.depends("browsing_enable", "1");
    o.description = _("Comma-separated TCP ports for browsing (default: 80,8080,443).");

    // Ports UDP pour le web (QUIC, etc.)
    o = s.taboption("tab_gaming", form.Value, "browsing_udp_ports", _("Browsing UDP ports"));
    o.placeholder = "443";
    o.rmempty     = true;
    o.depends("browsing_enable", "1");
    o.description = _("Comma-separated UDP ports for browsing (e.g. QUIC on 443).");

    // DSCP pour le web
    o = s.taboption("tab_gaming", form.ListValue, "browsing_dscp", _("Browsing DSCP"));
    o.value("af21", "AF21 (low-latency web)");
    o.value("af31", "AF31 (more priority)");
    o.value("cs1",  "CS1 (background)");
    o.value("cs0",  "CS0 (default)");
    o.default     = "af21";
    o.depends("browsing_enable", "1");
    o.rmempty     = true;
    o.description = _("DSCP used for browsing traffic if enabled.");	
	
s.anonymous=true;s.addremove=true;o=s.taboption("tab_basic",form.Flag,"enabled",_("Enable this SQM instance."));o.rmempty=false;o.write=L.bind(function(section,value){if(value=="1"){this.handleEnableSQM();ui.addNotification(null,E('p',_("The SQM GUI has just enabled the sqm initscript on your behalf. Remember to disable the sqm initscript manually under System Startup menu in case this change was not wished for.")));}
return uci.set("sqm",section,"enabled",value);},this);o=s.taboption("tab_basic",widgets.DeviceSelect,"interface",_("Interface name"));o.rmempty=false;o=s.taboption("tab_basic",form.Value,"download",_("Download speed (ingress)"),_("Download speed (kbit/s) (ingress) set to 0 to disable ingress shaping selectively"));o.datatype="and(uinteger,min(0))";o.rmempty=false;o=s.taboption("tab_basic",form.Value,"upload",_("Upload speed (egress)"),_("Upload speed (kbit/s) (egress) set to 0 to selectively disable egress shaping"));o.datatype="and(uinteger,min(0))";o.rmempty=false;o=s.taboption("tab_basic",form.Flag,"debug_logging",_("Enable debug logging"),_("Create log file for this SQM instance under /var/run/sqm/${Interface_name}.[start|stop]-sqm.log."));o.rmempty=false;o=s.taboption("tab_basic",form.ListValue,"verbosity",_("Log verbosity"),_("Verbosity of SQM's output into the system log."));o.value("0","silent");o.value("1","error");o.value("2","warning");o.value("5","info ("+_("default")+")");o.value("8","debug");o.value("10","trace");o.default="5";o=s.taboption("tab_qdisc",form.ListValue,"qdisc",_("Queueing discipline"),_("Lists queuing disciplines useable on this system. After installing a new qdisc, you need to restart the router to see updates!"));for(var i=0;i<qdiscs.length;i++){o.value(qdiscs[i].name);}
o.default="cake";o.rmempty=false;var qos_desc="";o=s.taboption("tab_qdisc",form.ListValue,"script",_("Queue setup script"));for(i=0;i<scripts.length;i++){o.value(scripts[i][0]);qos_desc+="<p><b>"+scripts[i][0]+":</b><br />";if(scripts[i][1])
qos_desc+=scripts[i][1]+"</p>";else
qos_desc+="No help text</p>";}
o.default="piece_of_cake.qos";o.rmempty=false;o.description=qos_desc;o=s.taboption("tab_qdisc",form.Flag,"qdisc_advanced",_("Advanced Configuration"),_("Advanced options will only be used as long as this box is checked."));o.default=false;o=s.taboption("tab_qdisc",form.ListValue,"squash_dscp",_("Squash DSCP (ingress)"),_("Squash DSCP markings on inbound packets"));o.value("1","SQUASH");o.value("0","DO NOT SQUASH");o.default="1";o.depends("qdisc_advanced","1");o=s.taboption("tab_qdisc",form.ListValue,"squash_ingress",_("Ignore DSCP (ingress)"),_("Ignore DSCP markings on inbound packets"));o.value("1","Ignore");o.value("0","Allow");o.default="1";o.depends("qdisc_advanced","1");o=s.taboption("tab_qdisc",form.ListValue,"ingress_ecn",_("ECN (ingress)"),_("Explicit congestion notification (ECN) status on inbound packets"));o.value("ECN","ECN ("+_("default")+")");o.value("NOECN");o.default="ECN";o.depends("qdisc_advanced","1");o=s.taboption("tab_qdisc",form.ListValue,"egress_ecn",_("ECN (egress)"),_("Explicit congestion notification (ECN) status on outbound packets"));o.value("NOECN","NOECN ("+_("default")+")");o.value("ECN");o.default="NOECN";o.depends("qdisc_advanced","1");o=s.taboption("tab_qdisc",form.Flag,"qdisc_really_really_advanced",_("Dangerous Configuration"),_("Dangerous options will only be used as long as this box is checked."));o.default=false
o.depends("qdisc_advanced","1");o=s.taboption("tab_qdisc",form.Value,"ilimit",_("Hard queue limit (ingress)"),_("Hard limit on ingress queues; leave empty for default."));o.datatype="and(uinteger,min(0))";o.depends("qdisc_really_really_advanced","1");o=s.taboption("tab_qdisc",form.Value,"elimit",_("Hard queue limit (egress)"),_("Hard limit on egress queues; leave empty for default."));o.datatype="and(uinteger,min(0))";o.depends("qdisc_really_really_advanced","1");o=s.taboption("tab_qdisc",form.Value,"itarget",_("Latency target (ingress)"),_("Latency target for ingress, e.g 5ms [units: s, ms, or  us]; leave empty for automatic selection, put in the word default for the qdisc's default."));o.datatype="string";o.depends("qdisc_really_really_advanced","1");o=s.taboption("tab_qdisc",form.Value,"etarget",_("Latency target (egress)"),_("Latency target for egress, e.g. 5ms [units: s, ms, or  us]; leave empty for automatic selection, put in the word default for the qdisc's default."));o.datatype="string";o.depends("qdisc_really_really_advanced","1");o=s.taboption("tab_qdisc",form.Value,"iqdisc_opts",_("Qdisc options (ingress)"),_("Advanced option string to pass to the ingress queueing disciplines; no error checking, use very carefully."));o.depends("qdisc_really_really_advanced","1");o=s.taboption("tab_qdisc",form.Value,"eqdisc_opts",_("Qdisc options (egress)"),_("Advanced option string to pass to the egress queueing disciplines; no error checking, use very carefully."));o.depends("qdisc_really_really_advanced","1");o=s.taboption("tab_linklayer",form.ListValue,"linklayer",_("Link layer"),_("Which link layer technology to account for"));o.value("none","none ("+_("default")+")");o.value("ethernet","Ethernet with overhead: select for e.g. VDSL2.");o.value("atm","ATM: select for e.g. ADSL1, ADSL2, ADSL2+.");o.default="none";o=s.taboption("tab_linklayer",form.Value,"overhead",_("Per Packet Overhead (bytes)"));o.datatype="and(integer,min(-1500))";o.default=0
o.depends("linklayer","ethernet");o.depends("linklayer","atm");o=s.taboption("tab_linklayer",form.Flag,"linklayer_advanced",_("Advanced Linklayer Options"),_("Advanced options will only be used as long as this box is checked (only needed if MTU > 1500)."));o.depends("linklayer","ethernet");o.depends("linklayer","atm");o=s.taboption("tab_linklayer",form.Value,"tcMTU",_("Maximum packet size"),_("Maximal Size for size and rate calculations, tcMTU (byte); needs to be >= interface MTU + overhead"));o.datatype="and(uinteger,min(0))";o.default=2047
o.depends("linklayer_advanced","1");o=s.taboption("tab_linklayer",form.Value,"tcTSIZE",_("Rate table size"),_("Number of entries in size/rate tables, TSIZE; for ATM choose TSIZE = (tcMTU + 1) / 16"));o.datatype="and(uinteger,min(0))";o.default=128
o.depends("linklayer_advanced","1");o=s.taboption("tab_linklayer",form.Value,"tcMPU",_("Minimum packet size"),_("Minimal packet size, MPU (byte); needs to be > 0 for ethernet size tables"));o.datatype="and(uinteger,min(0))";o.default=0
o.depends("linklayer_advanced","1");o=s.taboption("tab_linklayer",form.ListValue,"linklayer_adaptation_mechanism",_("Linklayer adaptation mechanism"),_("Which linklayer adaptation mechanism to use; for testing only"));o.value("default","default ("+_("default")+")");o.value("cake");o.value("htb_private");o.value("tc_stab");o.default="default";o.depends("linklayer_advanced","1");return m.render();}})