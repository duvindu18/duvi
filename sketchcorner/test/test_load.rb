# frozen_string_literal: true
#
# Loads the extension the way SketchUp does (loader -> main.rb) against the
# API double and checks that menus, toolbar and context menu are installed.

require 'minitest/autorun'
require_relative 'support/fake_sketchup'

module UI
  class << self
    attr_accessor :installed
    def menu(_n) Menu.new end
    def add_context_menu_handler(&b) (self.installed ||= []) << [:context, b] end
    def messagebox(*) end
  end
  class Menu
    def add_submenu(n) UI.installed ||= []; UI.installed << [:submenu, n]; self end
    def add_item(c, &_b) UI.installed << [:item, c.respond_to?(:name) ? c.name : c] end
    def add_separator() end
  end
  class Command
    attr_accessor :tooltip, :status_bar_text, :small_icon, :large_icon
    attr_reader :name
    def initialize(n, &b) @name = n; @b = b end
    def set_validation_proc(&b) @v = b end
  end
  class Toolbar
    def initialize(n) UI.installed << [:toolbar, n]; @items = [] end
    def add_item(c) UI.installed << [:tool, c.name]; File.exist?(c.small_icon) or raise "missing #{c.small_icon}" end
    def restore() end
  end
  class HtmlDialog
    STYLE_DIALOG = 0
  end
end

class SketchupExtension
  attr_accessor :description, :version, :creator, :copyright
  def initialize(name, path) @name = name; @path = path end
  def load() require @path end
end

module Sketchup
  def self.register_extension(ext, _on) ext.load end
end

$LOADED_FEATURES << 'sketchup.rb' << 'extensions.rb'

class TestLoad < Minitest::Test
  def test_loader_installs_ui
    load File.expand_path('../src/SketchCorner.rb', __dir__)
    names = UI.installed.map(&:last)
    assert_includes names, '.SketchCorner'
    assert_includes names, 'Fillet Tool'
    assert_includes names, 'Edit Fillet'
    assert_equal 3, UI.installed.count { |k, _| k == :tool }
    assert UI.installed.any? { |k, _| k == :context }
    assert defined?(SketchCorner::CONTROLLER)
  end
end
