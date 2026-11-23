# frozen_string_literal: true
#
# .SketchCorner - UI controller.
#
# One HtmlDialog serves both tools. The active tool "attaches" itself; the
# dialog sends parameter changes and actions to it and receives the tool's
# state (parameters, selection stats, status message) as JSON.

require 'json'
require_relative 'engine'
require_relative 'parametric'

module SketchCorner
  class DialogController
    LENGTH_KEYS = %w[radius radius_end].freeze

    def initialize(root)
      @root = root
      @dialog = nil
      @owner = nil
      @mode = :create
    end

    def attach(owner, mode)
      @owner = owner
      @mode = mode
      show
    end

    def detach(owner)
      @owner = nil if @owner.equal?(owner)
      push
    end

    def visible?
      @dialog && @dialog.visible?
    end

    def show
      if visible?
        @dialog.bring_to_front
        push
        return
      end
      @dialog = UI::HtmlDialog.new(
        dialog_title: '.SketchCorner',
        preferences_key: 'SketchCorner.Dialog',
        scrollable: true,
        resizable: true,
        width: 380,
        height: 860,
        left: 80,
        top: 100,
        min_width: 320,
        min_height: 420,
        style: UI::HtmlDialog::STYLE_DIALOG
      )
      @dialog.set_file(File.join(@root, 'html', 'dialog.html'))
      register_callbacks
      @dialog.show
    end

    def toggle
      if visible?
        @dialog.close
      else
        show
      end
    end

    # Sends the current state to the page.
    def push
      return unless visible?
      state = @owner ? @owner.state : { 'mode' => 'idle', 'params' => Settings.load, 'stats' => {} }
      params = state['params'] || {}
      state = state.merge(
        'mode' => state['mode'] || @mode.to_s,
        'lengths' => LENGTH_KEYS.each_with_object({}) { |k, h| h[k] = Sketchup.format_length(params[k].to_f) },
        'materials' => Sketchup.active_model.materials.map(&:name).sort,
        'tags' => Sketchup.active_model.layers.map(&:name).reject { |n| n == 'Layer0' || n == 'Untagged' }.sort,
        'version' => VERSION
      )
      @dialog.execute_script("window.SC && SC.receive(#{JSON.generate(sanitize(state))})")
    rescue StandardError => e
      Diagnostics.report(e, 'dialog push')
    end

    private

    def sanitize(obj)
      case obj
      when Hash then obj.each_with_object({}) { |(k, v), h| h[k.to_s] = sanitize(v) }
      when Array then obj.map { |v| sanitize(v) }
      when Float then obj.finite? ? obj : 0.0
      when Length then obj.to_f
      when Symbol then obj.to_s
      else obj
      end
    end

    def register_callbacks
      @dialog.add_action_callback('ready') { |_ctx| push }

      @dialog.add_action_callback('params') do |_ctx, json|
        begin
          updates = JSON.parse(json.to_s)
          LENGTH_KEYS.each do |k|
            next unless updates[k].is_a?(String)
            updates[k] = parse_length(updates[k])
          end
          target = @owner || ensure_tool(:create)
          target.set_params(updates)
        rescue UserError, ArgumentError => e
          error(e.message)
        rescue StandardError => e
          Diagnostics.report(e, 'params')
          error("Could not apply that setting: #{e.message}")
        end
        push
      end

      @dialog.add_action_callback('action') do |_ctx, name|
        begin
          case name
          when 'mode_create' then ensure_tool(:create)
          when 'mode_edit' then ensure_tool(:edit)
          else
            (@owner || ensure_tool(:create)).action(name)
          end
        rescue StandardError => e
          Diagnostics.report(e, 'action')
          error(e.message)
        end
        push
      end

      @dialog.set_on_closed { @dialog = nil }
    end

    def ensure_tool(mode)
      return @owner if @owner && @mode == mode
      tool = mode == :edit ? EditTool.new(self) : FilletTool.new(self)
      Sketchup.active_model.select_tool(tool)
      tool
    end

    def parse_length(text)
      value = text.strip.to_l.to_f
      raise UserError, 'Radius must be greater than zero.' unless value.positive?
      value
    rescue ArgumentError
      raise UserError, "\"#{text}\" is not a length. Type a size such as 5 mm."
    end

    def error(message)
      return unless visible?
      @dialog.execute_script("window.SC && SC.error(#{JSON.generate(message.to_s)})")
    end
  end

  # ---------------------------------------------------------- menus/toolbar
  module Menus
    module_function

    def install(root, controller)
      ext = Sketchup.platform == :platform_win ? 'svg' : 'png'
      icon = ->(name, size) { File.join(root, 'icons', "#{name}_#{size}.#{ext}") }

      fillet = UI::Command.new('Fillet Tool') { Sketchup.active_model.select_tool(FilletTool.new(controller)) }
      fillet.tooltip = 'Round edges'
      fillet.status_bar_text = 'Round, chamfer or profile edges with a live preview.'
      fillet.small_icon = icon.call('fillet', 16)
      fillet.large_icon = icon.call('fillet', 24)

      edit = UI::Command.new('Edit Fillet') { Sketchup.active_model.select_tool(EditTool.new(controller)) }
      edit.tooltip = 'Edit a fillet'
      edit.status_bar_text = 'Change the parameters of a .SketchCorner fillet after the fact.'
      edit.small_icon = icon.call('edit', 16)
      edit.large_icon = icon.call('edit', 24)

      panel = UI::Command.new('Settings Panel') { controller.toggle }
      panel.tooltip = '.SketchCorner panel'
      panel.status_bar_text = 'Show or hide the .SketchCorner settings panel.'
      panel.small_icon = icon.call('panel', 16)
      panel.large_icon = icon.call('panel', 24)
      panel.set_validation_proc { controller.visible? ? MF_CHECKED : MF_UNCHECKED }

      menu = UI.menu('Extensions').add_submenu('.SketchCorner')
      menu.add_item(fillet)
      menu.add_item(edit)
      menu.add_separator
      menu.add_item(panel)
      menu.add_item('About .SketchCorner') do
        UI.messagebox(".SketchCorner #{VERSION}\n\nParametric fillets, chamfers and profiled " \
                      "edges for SketchUp.\nUndo with Ctrl+Z; edit later with Edit Fillet.")
      end

      UI.add_context_menu_handler do |cm|
        sel = Sketchup.active_model.selection
        if sel.any? { |e| e.is_a?(Sketchup::Edge) }
          cm.add_item('.SketchCorner: Round selected edges') do
            Sketchup.active_model.select_tool(FilletTool.new(controller))
          end
        end
        if sel.any? { |e| Parametric.sc_group?(e) }
          cm.add_item('.SketchCorner: Edit fillet') do
            Sketchup.active_model.select_tool(EditTool.new(controller))
          end
        end
      end

      tb = UI::Toolbar.new('.SketchCorner')
      tb.add_item(fillet)
      tb.add_item(edit)
      tb.add_item(panel)
      tb.restore
    end
  end
end
