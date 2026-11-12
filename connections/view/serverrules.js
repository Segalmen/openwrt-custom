'use strict';
'require view';
'require form';
'require uci';
'require ui';

return view.extend({

    load: function() {
        return Promise.all([
            uci.load('serverrules')
        ]);
    },

    render: function() {

        var m, s, o;

        m = new form.Map('serverrules', _('Server Rules'),
            _('Block remote server ranges (IPv4 CIDR) in both directions. Disabled rules act as labels only (shown in Connections and Server History).'));

        s = m.section(form.TypedSection, 'global', _('General'));
        s.anonymous = true;
        s.addremove = false;

        o = s.option(form.Flag, 'enabled', _('Enable blocking'),
            _('Off: no range is blocked, rules stay as labels.'));
        o.default = '1';
        o.rmempty = false;

        s = m.section(form.TypedSection, 'rule', _('Rules'));
        s.anonymous = true;
        s.addremove = true;

        o = s.option(form.Value, 'name', _('Name'));
        o.placeholder = 'Server_EU';
        // Mandatory: a rule without a name would only show its generated
        // section id (cfgXXXXXX) in Connections and Server History.
        o.rmempty = false;
        // Spaces become _ (same rule as the Ban / Label dialogs)
        o.validate = function(section_id, value) {
            if (!/^[A-Za-z0-9_ ]+$/.test(value || ''))
                return _('Letters, digits and _ only');
            return true;
        };
        o.write = function(section_id, value) {
            return form.Value.prototype.write.call(this, section_id,
                String(value).trim().replace(/\s+/g, '_'));
        };

        o = s.option(form.Flag, 'enabled', _('Enabled'));
        o.default = '1';

        o = s.option(form.DynamicList, 'range', _('IP Ranges'));
        o.datatype = 'cidr4';
        o.placeholder = '203.0.113.0/24';
        // Guard: refuse private/reserved ranges (self-ban protection).
        // Checked three times: while typing (red field, + refused), on save
        // (any such entry is dropped with a notice) and in serverrules.sh.
        var isReserved = function(cidr) {
            var ip = String(cidr || '').split('/')[0].split('.').map(Number);
            if (ip.length !== 4) return false; // cidr4 datatype handles format
            return (ip[0] === 10) ||
                (ip[0] === 127) ||
                (ip[0] === 0) ||
                (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) ||
                (ip[0] === 192 && ip[1] === 168) ||
                (ip[0] === 169 && ip[1] === 254) ||
                (ip[0] >= 224);
        };
        // Prefixes shorter than /8 are refused too (range too wide).
        var isTooWide = function(cidr) {
            var m = String(cidr || '').trim().match(/\/(\d+)$/);
            return !!m && +m[1] < 8;
        };
        var isRefused = function(cidr) {
            return isReserved(cidr) || isTooWide(cidr);
        };
        var refusalText = function(cidr) {
            return isReserved(cidr)
                ? _('Refused: private/reserved range (self-ban protection)')
                : _('Refused: range too wide, prefix must be /8 or longer');
        };
        o.validate = function(section_id, value) {
            var bad = L.toArray(value).filter(isRefused);
            if (bad.length)
                return refusalText(bad[0]);
            return true;
        };
        o.write = function(section_id, value) {
            var all = L.toArray(value);
            var kept = all.filter(function(c) { return !isRefused(c); });
            if (kept.length !== all.length)
                ui.addNotification(null, E('p',
                    _('Refused and removed: %s (private/reserved range or prefix shorter than /8)')
                        .format(all.filter(isRefused).join(', '))), 'warning');
            if (!kept.length)
                return this.remove(section_id);
            return form.DynamicList.prototype.write.call(this, section_id, kept);
        };
        // Visible refusal under the field, whatever the theme: some themes
        // show an invalid list entry only through the field colour.
        o.renderWidget = function(section_id, option_index, cfgvalue) {
            var node = form.DynamicList.prototype.renderWidget.call(this,
                section_id, option_index, cfgvalue);
            var hint = E('div', { 'style': 'display:none; color:#e0524f; font-weight:bold; margin-top:4px;' }, '');
            var input = node.querySelector('.add-item > input[type="text"]');
            if (input) {
                var check = function() {
                    var refused = isRefused(input.value);
                    hint.textContent = refused ? refusalText(input.value) : '';
                    hint.style.display = refused ? '' : 'none';
                };
                input.addEventListener('input', check);
                input.addEventListener('keyup', check);
                input.addEventListener('blur', check);
                // "+" and Enter must not add a refused range to the list.
                // ui.DynamicList adds on click / keydown handlers bound on
                // this node (bubble phase) and only skips an input flagged
                // cbi-input-invalid; these capture-phase guards run first
                // and do not depend on that flag.
                var block = function(ev) {
                    ev.stopPropagation();
                    ev.preventDefault();
                    check();
                };
                node.addEventListener('click', function(ev) {
                    if (ev.target && ev.target.classList &&
                        ev.target.classList.contains('cbi-button-add') &&
                        isRefused(input.value))
                        block(ev);
                }, true);
                node.addEventListener('keydown', function(ev) {
                    if (ev.target === input &&
                        (ev.keyCode === 13 || ev.key === 'Enter') &&
                        isRefused(input.value))
                        block(ev);
                }, true);
            }
            return E('div', {}, [ node, hint ]);
        };
        // LuCI ignores an invalid entry still in the list's input field and
        // saves the rest. Here such an entry blocks the save, like any other
        // invalid field, so a refused range is never dropped silently.
        o.isValid = function(section_id) {
            var el = this.getUIElement(section_id);
            var input = el && el.node
                ? el.node.querySelector('.add-item > input[type="text"]') : null;
            // checked here directly: on LuCI 25.12 the field's own validator
            // only runs the datatype check, not ours
            if (input && input.value.match(/\S/) &&
                (isRefused(input.value) ||
                 input.classList.contains('cbi-input-invalid')))
                return false;
            return form.DynamicList.prototype.isValid.call(this, section_id);
        };
        o.getValidationError = function(section_id) {
            var el = this.getUIElement(section_id);
            var input = el && el.node
                ? el.node.querySelector('.add-item > input[type="text"]') : null;
            if (input && isRefused(input.value))
                return refusalText(input.value);
            if (input && input.value.match(/\S/))
                return _('"%s" is not a valid IPv4 range (CIDR).').format(input.value.trim());
            return form.DynamicList.prototype.getValidationError.call(this, section_id);
        };
        // A rule without any range matches nothing: it is not kept. LuCI
        // calls remove() when the list ends up empty, so the whole rule goes.
        // Not when the rule was just added: "Add" saves the form silently
        // before anything is typed, with the name still empty.
        o.remove = function(section_id) {
            var nm = uci.get('serverrules', section_id, 'name');
            if (!nm)
                return form.DynamicList.prototype.remove.call(this, section_id);
            uci.remove('serverrules', section_id);
            ui.addNotification(null, E('p',
                _('Rule "%s" not saved: it has no valid IP range.').format(nm)), 'warning');
        };

        return m.render();
    }
});