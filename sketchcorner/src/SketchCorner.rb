# frozen_string_literal: true
#
# .SketchCorner - extension loader.
#
# SketchUp loads every *.rb file in the Plugins folder at startup. This file
# only registers the extension; the code in SketchCorner/ is loaded when the
# extension is enabled (Extension Manager), so a disabled extension costs
# nothing at startup.
#
# Note on the name: Ruby constants cannot start with a dot and SketchUp skips
# hidden (dot-prefixed) files in Plugins, so the module and file are named
# SketchCorner while every user-facing label reads ".SketchCorner".

require 'sketchup.rb'
require 'extensions.rb'

module SketchCorner
  NAME = '.SketchCorner'
  VERSION = '1.0.0'

  unless file_loaded?(__FILE__)
    extension = SketchupExtension.new(NAME, File.join(__dir__, 'SketchCorner', 'main'))
    extension.description = 'Parametric fillets, chamfers, coves and custom profiles with live ' \
                            'preview, corner patches, variable radius and non-destructive editing.'
    extension.version = VERSION
    extension.creator = '.SketchCorner'
    extension.copyright = "#{Time.now.year} .SketchCorner"
    Sketchup.register_extension(extension, true)
    file_loaded(__FILE__)
  end
end
