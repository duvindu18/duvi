# frozen_string_literal: true
#
# ArchRailing Pro - SketchUp extension loader.
# Procedural railings, balustrades, glass guards and fences along any path.
#
require 'sketchup.rb'
require 'extensions.rb'

module ArchRailingPro
  VERSION    = '1.0.0'
  PLUGIN_ID  = 'arch_railing_pro'
  PLUGIN_DIR = File.join(File.dirname(__FILE__), PLUGIN_ID)

  unless file_loaded?(__FILE__)
    ext = SketchupExtension.new('ArchRailing Pro', File.join(PLUGIN_DIR, 'main'))
    ext.description = 'Procedural railings, balustrades, glass guards and fences along any path: ' \
                      'arc-length post spacing, corners, stair slopes, 31 ready-made railings and ' \
                      'non-destructive live editing.'
    ext.version   = VERSION
    ext.creator   = 'ArchRailing Pro'
    ext.copyright = "#{Time.now.year} ArchRailing Pro"
    Sketchup.register_extension(ext, true)
    file_loaded(__FILE__)
  end
end
