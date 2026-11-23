# frozen_string_literal: true
#
# .SketchCorner - entry point, loaded by the SketchupExtension in
# ../SketchCorner.rb. Requires the core modules and installs the menu,
# toolbar and context menu once per session.

require 'sketchup.rb'

module SketchCorner
  ROOT = __dir__
  VERSION = '1.0.0' unless defined?(VERSION)

  %w[vmath mesh profiles uv engine bridge parametric tool ui].each do |name|
    require File.join(ROOT, 'core', name)
  end

  unless file_loaded?(__FILE__)
    CONTROLLER = DialogController.new(ROOT)
    Menus.install(ROOT, CONTROLLER)
    file_loaded(__FILE__)
  end
end
