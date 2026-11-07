# frozen_string_literal: true
#
# ArchRailing Pro - HtmlDialog bridge between the panel (ui/dialog.html)
# and the Ruby generator.
#
require 'json'

module ArchRailingPro
  module Dialog
    PREF = 'ArchRailingPro'

    class << self
      def show
        if @dialog && @dialog.visible?
          @dialog.bring_to_front
          push_selection
          return
        end
        @dialog = build
        @dialog.show
      end

      def visible?
        @dialog && @dialog.visible?
      end

      def build
        dlg = UI::HtmlDialog.new(
          dialog_title: 'ArchRailing Pro',
          preferences_key: 'com.archrailingpro.dialog',
          scrollable: false, resizable: true,
          width: 1180, height: 820, min_width: 440, min_height: 560,
          style: UI::HtmlDialog::STYLE_DIALOG
        )
        dlg.set_file(File.join(PLUGIN_DIR, 'ui', 'dialog.html'))

        dlg.add_action_callback('ready') { |_c| send_init }
        dlg.add_action_callback('create') { |_c, json| on_create(json) }
        dlg.add_action_callback('update') { |_c, json| on_update(json, false) }
        dlg.add_action_callback('live') { |_c, json| on_update(json, true) }
        dlg.add_action_callback('repath') { |_c| on_repath }
        dlg.add_action_callback('refresh_defs') { |_c| call_js('ARP.setDefinitions', definition_names) }
        dlg.add_action_callback('save_user_preset') { |_c, name, json| save_user_preset(name, json) }
        dlg.add_action_callback('delete_user_preset') { |_c, id| delete_user_preset(id) }
        dlg.add_action_callback('remember') { |_c, json| remember(json) }
        dlg.add_action_callback('undo') { |_c| Sketchup.undo }
        dlg.add_action_callback('close') { |_c| dlg.close }
        dlg.set_on_closed { @dialog = nil }
        dlg
      end

      # ---------------- Ruby -> JS ----------------

      def call_js(fn, *args)
        return unless @dialog
        payload = args.map { |a| JSON.generate(a) }.join(',')
        @dialog.execute_script("#{fn}(#{payload});")
      end

      def status(text, kind = 'info')
        call_js('ARP.status', text.to_s, kind)
      end

      def send_init
        call_js('ARP.init', {
          'version' => VERSION,
          'presets' => Defaults.presets,
          'userPresets' => user_presets,
          'params' => last_params,
          'definitions' => definition_names,
          'units' => 'mm'
        })
        push_selection
      end

      # Tell the panel what is selected: railing(s) to edit, or edges to use.
      def push_selection
        return unless @dialog
        model = Sketchup.active_model
        return unless model
        rails = Generator.railings_in(model.selection)
        edges = model.selection.grep(Sketchup::Edge).size
        info = { 'railings' => rails.size, 'edges' => edges }
        info['params'] = Generator.params_of(rails.first) if rails.size == 1
        call_js('ARP.setSelection', info)
      end

      def definition_names
        model = Sketchup.active_model
        return [] unless model
        model.definitions.reject { |d| d.group? || d.image? || d.get_attribute(DICT, 'builtin') }
             .map(&:name).sort
      end

      # ---------------- JS -> Ruby ----------------

      def parse(json)
        Defaults.sanitize(JSON.parse(json.to_s))
      rescue JSON::ParserError
        Defaults.base
      end

      def on_create(json)
        params = parse(json)
        remember_params(params)
        groups = Main.create_from_selection(params)
        return unless groups && !groups.empty?
        status("Generated #{groups.size} railing#{groups.size == 1 ? '' : 's'}. Select one to edit it.", 'done')
      end

      def on_update(json, live)
        params = parse(json)
        remember_params(params)
        model = Sketchup.active_model
        rails = Generator.railings_in(model.selection)
        if rails.empty?
          status('Select a railing to update.', 'note') unless live
          return
        end
        stats = Main.update_railings(rails, params, live)
        return unless stats
        status("Updated #{rails.size} railing#{rails.size == 1 ? '' : 's'}: " \
               "#{stats['posts']} posts, #{stats['length_mm']} mm.", live ? 'info' : 'done')
      end

      def on_repath
        Main.repath_selected
      end

      # ---------------- preferences ----------------

      def remember(json)
        remember_params(parse(json))
      end

      def remember_params(params)
        Sketchup.write_default(PREF, 'last_params', [JSON.generate(params)].pack('m0'))
      end

      def last_params
        raw = Sketchup.read_default(PREF, 'last_params', nil)
        return Defaults.preset('glass_round_post_clamp')['params'] unless raw
        Defaults.sanitize(JSON.parse(raw.unpack1('m0')))
      rescue StandardError
        Defaults.base
      end

      def user_presets
        raw = Sketchup.read_default(PREF, 'user_presets', nil)
        return [] unless raw
        list = JSON.parse(raw.unpack1('m0'))
        list.is_a?(Array) ? list.map { |u| u.merge('params' => Defaults.sanitize(u['params'])) } : []
      rescue StandardError
        []
      end

      def write_user_presets(list)
        Sketchup.write_default(PREF, 'user_presets', [JSON.generate(list)].pack('m0'))
        call_js('ARP.setUserPresets', list)
      end

      def save_user_preset(name, json)
        name = name.to_s.strip[0, 60]
        return status('Name the preset before saving it.', 'warn') if name.empty?
        list = user_presets.reject { |u| u['name'] == name }
        list << { 'id' => "user_#{Time.now.to_i}_#{rand(1000)}", 'category' => 'Saved', 'name' => name,
                  'params' => parse(json) }
        write_user_presets(list)
        status("Saved preset \"#{name}\".", 'info')
      end

      def delete_user_preset(id)
        write_user_presets(user_presets.reject { |u| u['id'] == id })
        status('Preset deleted.', 'note')
      end
    end
  end
end
