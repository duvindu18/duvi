$degenerate = 0
$volumes = []
require_relative 'mock_su'
SRC = File.expand_path('../src/arch_railing_pro', __dir__)
require File.join(SRC, 'defaults')
require File.join(SRC, 'generator')
include ArchRailingPro

def arc(cx, cy, r, a0, a1, n, z = 0) (0..n).map { |i| a = a0 + (a1 - a0) * i / n; [cx + r * Math.cos(a), cy + r * Math.sin(a), z] } end
mm = 1 / 25.4
PATHS = {
  'straight' => [[[0,0,0],[3000*mm,0,0]], false],
  'L corner' => [[[0,0,0],[3000*mm,0,0],[3000*mm,2000*mm,0]], false],
  'arc' => [arc(0, 0, 2000*mm, 0, Math::PI, 24), false],
  'closed square' => [[[0,0,0],[4000*mm,0,0],[4000*mm,4000*mm,0],[0,4000*mm,0],[0,0,0]], true],
  'closed circle' => [arc(0, 0, 3000*mm, 0, 2*Math::PI, 48)[0..-2] , true],
  'stair+landing' => [[[0,0,0],[1000*mm,0,0],[3500*mm,0,1500*mm],[4500*mm,0,1500*mm],[4500*mm,1500*mm,1500*mm]], false],
  'collinear dup' => [[[0,0,0],[0,0,0],[1000*mm,0,0],[2000*mm,0,0],[3000*mm,0,0]], false]
}
fails = 0
Defaults.presets.each do |pr|
  PATHS.each do |pname, (pts, closed)|
    model = Sketchup::Model.new
    $volumes = []
    begin
      grp = Generator.create(model, model.active_entities, [{ 'points' => pts, 'closed' => closed }], pr['params']).first
      stats = Generator.regenerate(model, grp)
      neg = $volumes.count { |v| v <= 0 }
      if neg > 0
        fails += 1; puts "FAIL #{pr['id']} / #{pname}: #{neg} inside-out meshes of #{$volumes.size}"
      end
    rescue => e
      fails += 1; puts "FAIL #{pr['id']} / #{pname}: #{e.class}: #{e.message}\n  #{e.backtrace.first(3).join("\n  ")}"
    end
  end
end
puts "degenerate triangles: #{$degenerate}"

# Layout checks on a straight 3000 run
pp = Defaults.sanitize(Defaults.base.merge('post_spacing' => 1000))
path = Path.new([[0,0,0],[3000*mm,0,0]], false)
posts, bays = Layout.compute(path, pp)
p posts.map { |x| (x['s'] / mm).round }
raise 'fit layout' unless posts.map { |x| (x['s'] / mm).round } == [0, 1000, 2000, 3000]
pp['spacing_mode'] = 'fixed'; pp['post_spacing'] = 1200
posts, = Layout.compute(path, pp)
raise 'fixed layout' unless posts.map { |x| (x['s'] / mm).round } == [0, 1200, 2400, 3000]
# corner post at L
posts, = Layout.compute(Path.new(PATHS['L corner'][0], false), Defaults.base)
raise 'corner' unless posts.map { |x| x['kind'] }.include?(:corner)
# offset path: L corner offset 100 left -> inner corner point
o = Path.new(PATHS['L corner'][0], false).offset(100*mm, 0)
p o.pts.map { |q| q.map { |c| (c / mm).round } }
# closed sub_frames across seam
c = Path.new(PATHS['closed square'][0], true)
f = c.sub_frames(c.total - 500*mm, c.total + 500*mm)
p f.map { |q| q[0].map { |v| (v / mm).round } }
# errors
begin; Path.new([[0,0,0],[0,0,1000*mm]], false); puts 'no error!'; fails += 1; rescue PathError => e; puts "ok: #{e.message}"; end
begin; Path.new(PATHS['arc'][0], false).offset(2500*mm, 0); puts 'no error!'; fails += 1; rescue PathError => e; puts "ok: #{e.message}"; end
# open-context conversion: world points -> local of a group moved by (1000, 500, 0)
class TV; attr_reader :position; def initialize(*a) @position = Geom::Point3d.new(*a) end; end
class TE < Sketchup::Edge
  def initialize(a, b) @a, @b = a, b end
  def vertices; [@a, @b]; end
  def other_vertex(v) v == @a ? @b : @a end
  def curve; nil; end
end
inv = Geom::Transformation.new(Geom::Point3d.new(1000, 500, 0)).inverse
ch = Generator.chains_from_selection([TE.new(TV.new(1000, 500, 0), TV.new(1100, 500, 0))], inv)
if ch.first['points'].map { |q| q.map(&:round) } == [[0, 0, 0], [100, 0, 0]] then puts 'ok: open-context points converted'
else fails += 1; puts "FAIL open context: #{ch.inspect}" end
begin; Generator.chains_from_selection([]); fails += 1; rescue PathError; puts 'ok: empty selection refused'; end

# gallery test path (run, stair flight, landing, corner) for every preset inside a parent group
gm = Sketchup::Model.new
gal = gm.active_entities.add_group
gpath = [[0, 0, 0], [1500, 0, 0], [3300, 0, 900], [4300, 0, 900], [4300, 1800, 900]].map { |q| q.map { |c| c * mm } }
Defaults.presets.each do |pr|
  begin
    Generator.create(gm, gal.entities, [{ 'points' => gpath, 'closed' => false }], pr['params'])
  rescue => e
    fails += 1; puts "FAIL gallery #{pr['id']}: #{e.message}"
  end
end
puts "ok: gallery built #{gal.entities.items.size} railings"

puts fails.zero? ? "ALL PASSED (#{Defaults.presets.size} presets x #{PATHS.size} paths)" : "#{fails} FAILURES"
