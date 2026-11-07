# frozen_string_literal: true
#
# ArchRailing Pro - menus, toolbar, commands, observers and operations.
#
require 'sketchup.rb'
require 'json'

module ArchRailingPro
  PLUGIN_DIR = File.dirname(__FILE__) unless defined?(PLUGIN_DIR)

  require File.join(PLUGIN_DIR, 'defaults')
  require File.join(PLUGIN_DIR, 'generator')
  require File.join(PLUGIN_DIR, 'ui_dialog')

  module Main
    module_function

    # ---------------- operations ----------------

    def create_from_selection(params)
      model = Sketchup.active_model
      chains = Generator.chains_from_selection(model.selection)
      groups = nil
      model.start_operation('Create ArchRailing', true)
      begin
        groups = Generator.create(model, model.active_entities, chains, params)
        model.commit_operation
      rescue PathError, ParamError => e
        model.abort_operation
        UI.messagebox("ArchRailing Pro\n\n#{e.message}")
        return nil
      rescue StandardError => e
        model.abort_operation
        report(e)
        return nil
      end
      model.selection.clear
      model.selection.add(groups)
      groups
    rescue PathError => e
      UI.messagebox("ArchRailing Pro\n\n#{e.message}")
      nil
    end

    def update_railings(rails, params, live = false)
      model = Sketchup.active_model
      leave_railing_context(model, rails)
      stats = nil
      model.start_operation(live ? 'Adjust ArchRailing' : 'Update ArchRailing', true)
      begin
        rails.each { |g| stats = Generator.regenerate(model, g, params) }
        Generator.purge_builtin(model)
        model.commit_operation
      rescue PathError, ParamError => e
        model.abort_operation
        if live
          Dialog.status(e.message, 'warn')
        else
          UI.messagebox("ArchRailing Pro\n\n#{e.message}")
        end
        return nil
      rescue StandardError => e
        model.abort_operation
        report(e)
        return nil
      end
      stats
    end

    def regenerate_selected
      model = Sketchup.active_model
      rails = Generator.railings_in(model.selection)
      return UI.messagebox('Select one or more ArchRailing groups.') if rails.empty?
      model.start_operation('Regenerate ArchRailing', true)
      begin
        rails.each { |g| Generator.regenerate(model, g) }
        Generator.purge_builtin(model)
        model.commit_operation
      rescue PathError, ParamError => e
        model.abort_operation
        UI.messagebox("ArchRailing Pro\n\n#{e.message}")
      rescue StandardError => e
        model.abort_operation
        report(e)
      end
    end

    # Select one railing plus the new path edges, then run this.
    def repath_selected
      model = Sketchup.active_model
      rails = Generator.railings_in(model.selection)
      if rails.size != 1
        Dialog.status('Select exactly one railing together with the new path edges.', 'warn')
        return UI.messagebox('Select exactly one railing together with the edges of its new path.')
      end
      chains = Generator.chains_from_selection(model.selection)
      if chains.size != 1
        return UI.messagebox('The new path must be one continuous chain of edges.')
      end
      model.start_operation('Change ArchRailing Path', true)
      begin
        Generator.replace_path(model, rails.first, chains.first)
        Generator.purge_builtin(model)
        model.commit_operation
        model.selection.clear
        model.selection.add(rails.first)
        Dialog.status('Path replaced.', 'info')
      rescue PathError, ParamError => e
        model.abort_operation
        UI.messagebox("ArchRailing Pro\n\n#{e.message}")
      rescue StandardError => e
        model.abort_operation
        report(e)
      end
    rescue PathError => e
      UI.messagebox("ArchRailing Pro\n\n#{e.message}")
    end

    # Regenerating a railing while it is open for editing would mix up its
    # coordinates, so close any editing context that is inside it.
    def leave_railing_context(model, rails)
      path = model.active_path
      return unless path
      model.close_active while model.active_path && (model.active_path & rails).any?
    end

    def report(e)
      warn "ArchRailing Pro: #{e.class}: #{e.message}\n#{e.backtrace&.first(8)&.join("\n")}"
      UI.messagebox("ArchRailing Pro hit an unexpected error and undid the change.\n\n" \
                    "#{e.class}: #{e.message}\n\nDetails are in the Ruby Console.")
    end

    # ---------------- observers ----------------

    class SelectionWatcher < Sketchup::SelectionObserver
      def onSelectionBulkChange(_sel) push end
      def onSelectionCleared(_sel) push end
      def onSelectionAdded(_sel, _e) push end
      def onSelectionRemoved(_sel, _e) push end

      def push
        return unless Dialog.visible?
        # Defer: the selection can fire many times during one operation.
        return if @pending
        @pending = true
        UI.start_timer(0.15, false) do
          @pending = false
          Dialog.push_selection
        end
      end
    end

    class AppWatcher < Sketchup::AppObserver
      def onNewModel(model) Main.watch(model) end
      def onOpenModel(model) Main.watch(model) end
      def onActivateModel(model) Main.watch(model) end
    end

    def watch(model)
      return unless model
      @watched ||= {}
      key = model.respond_to?(:guid) ? model.guid : model.object_id
      return if @watched[key]
      @selection_watcher ||= SelectionWatcher.new
      model.selection.add_observer(@selection_watcher)
      @watched[key] = true
      Dialog.push_selection if Dialog.visible?
    end

    # ---------------- UI wiring ----------------

    def icon(name)
      ext = Sketchup.platform == :platform_win ? 'svg' : 'pdf'
      file = File.join(PLUGIN_DIR, 'icons', "#{name}.#{ext}")
      File.exist?(file) ? file : File.join(PLUGIN_DIR, 'icons', "#{name}.png")
    end

    def command(title, tip, icon_name, &block)
      cmd = UI::Command.new(title, &block)
      cmd.tooltip = title
      cmd.status_bar_text = tip
      if icon_name
        cmd.small_icon = icon("#{icon_name}_24")
        cmd.large_icon = icon("#{icon_name}_32")
      end
      cmd
    end

    def setup_ui
      cmd_panel = command('ArchRailing Pro', 'Open the railing panel: presets, parameters and live updates.', 'railing') { Dialog.show }
      cmd_quick = command('Quick Railing', 'Create a railing on the selected edges with the last used settings.', 'quick') do
        create_from_selection(Dialog.last_params)
      end
      cmd_regen = command('Regenerate Railing', 'Rebuild the selected railings from their stored settings.', 'regen') do
        regenerate_selected
      end
      cmd_path = command('Change Railing Path', 'Select one railing and new path edges, then replace its path.', 'repath') do
        repath_selected
      end

      menu = UI.menu('Extensions').add_submenu('ArchRailing Pro')
      menu.add_item(cmd_panel)
      menu.add_item(cmd_quick)
      menu.add_separator
      menu.add_item(cmd_regen)
      menu.add_item(cmd_path)
      menu.add_separator
      menu.add_item('About ArchRailing Pro') do
        UI.messagebox("ArchRailing Pro #{VERSION}\n\nProcedural railings, balustrades, glass guards " \
                      "and fences along any path.\n31 ready-made railings, live parametric editing.")
      end

      tb = UI::Toolbar.new('ArchRailing Pro')
      [cmd_panel, cmd_quick, cmd_regen, cmd_path].each { |c| tb.add_item(c) }
      tb.restore

      UI.add_context_menu_handler do |cm|
        model = Sketchup.active_model
        sel = model.selection
        if Generator.railings_in(sel).any?
          sub = cm.add_submenu('ArchRailing Pro')
          sub.add_item('Edit railing') { Dialog.show }
          sub.add_item('Regenerate') { regenerate_selected }
          sub.add_item('Change path (with selected edges)') { repath_selected } if sel.grep(Sketchup::Edge).any?
        elsif sel.grep(Sketchup::Edge).any?
          sub = cm.add_submenu('ArchRailing Pro')
          sub.add_item('Create railing...') { Dialog.show }
          sub.add_item('Quick railing (last settings)') { create_from_selection(Dialog.last_params) }
        end
      end

      Sketchup.add_observer(AppWatcher.new)
      watch(Sketchup.active_model)
    end
  end

  unless file_loaded?(__FILE__)
    Main.setup_ui
    file_loaded(__FILE__)
  end
end
