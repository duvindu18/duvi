# frozen_string_literal: true
#
# Builds the .SketchCorner installer: release/SketchCorner-<version>.rbz
#
#   ruby tools/build_rbz.rb            # from the sketchcorner/ folder
#
# An .rbz is a plain ZIP whose root holds the loader (SketchCorner.rb) and the
# support folder (SketchCorner/). This script writes the ZIP itself with
# Zlib so it needs no gems and no zip command (works on Windows and macOS).

require 'zlib'
require 'fileutils'

ROOT = File.expand_path('..', __dir__)
SRC = File.join(ROOT, 'src')
version = File.read(File.join(SRC, 'SketchCorner.rb'))[/VERSION = '([^']+)'/, 1] or abort 'VERSION not found'
OUT_DIR = File.join(ROOT, 'release')
OUT = File.join(OUT_DIR, "SketchCorner-#{version}.rbz")

# Only ship what SketchUp needs: no tests, no dot-files, no editor backups.
files = Dir.chdir(SRC) do
  (['SketchCorner.rb'] + Dir.glob('SketchCorner/**/*', File::FNM_DOTMATCH))
    .select { |f| File.file?(f) }
    .reject { |f| File.basename(f).start_with?('.') || f.end_with?('~') }
    .sort
end

abort 'Loader SketchCorner.rb missing' unless files.include?('SketchCorner.rb')
abort 'SketchCorner/main.rb missing' unless files.include?('SketchCorner/main.rb')

# Syntax-check every Ruby file before packaging.
files.grep(/\.rb\z/).each do |f|
  ok = system(RbConfig.ruby, '-c', File.join(SRC, f), out: File::NULL)
  abort "Syntax error in #{f}" unless ok
end

def dos_time(t)
  time = (t.hour << 11) | (t.min << 5) | (t.sec / 2)
  date = ((t.year - 1980) << 9) | (t.month << 5) | t.day
  [time, date]
end

FileUtils.mkdir_p(OUT_DIR)
central = []
offset = 0
File.open(OUT, 'wb') do |zip|
  files.each do |name|
    data = File.binread(File.join(SRC, name))
    crc = Zlib.crc32(data)
    deflated = Zlib::Deflate.new(Zlib::BEST_COMPRESSION, -Zlib::MAX_WBITS).then { |z| z.deflate(data, Zlib::FINISH).tap { z.close } }
    method, body = deflated.bytesize < data.bytesize ? [8, deflated] : [0, data]
    time, date = dos_time(File.mtime(File.join(SRC, name)))
    header = [0x04034b50, 20, 0x0800, method, time, date, crc, body.bytesize, data.bytesize, name.bytesize, 0]
             .pack('VvvvvvVVVvv')
    zip.write(header, name, body)
    central << [0x02014b50, 0x0314, 20, 0x0800, method, time, date, crc, body.bytesize, data.bytesize,
                name.bytesize, 0, 0, 0, 0, 0o100644 << 16, offset].pack('VvvvvvvVVVvvvvvVV') + name
    offset += header.bytesize + name.bytesize + body.bytesize
  end
  cd = central.join
  zip.write(cd)
  zip.write([0x06054b50, 0, 0, central.size, central.size, cd.bytesize, offset, 0].pack('VvvvvVVv'))
end

puts "Built #{OUT} (#{files.size} files, #{File.size(OUT)} bytes)"
files.each { |f| puts "  #{f}" }
