# Minimal SketchUp API stand-in for exercising the generator.
module Geom
  class Vector3d
    attr_reader :x, :y, :z
    def initialize(x = 0, y = 0, z = 0) @x, @y, @z = x.to_f, y.to_f, z.to_f end
    def to_a; [@x, @y, @z]; end
    def length; Math.sqrt(x*x + y*y + z*z); end
    def dot(o) x*o.x + y*o.y + z*o.z end
    def cross(o) Vector3d.new(y*o.z - z*o.y, z*o.x - x*o.z, x*o.y - y*o.x) end
    def normalize; l = length; Vector3d.new(x/l, y/l, z/l); end
    def angle_between(o) Math.acos((dot(o) / (length * o.length)).clamp(-1, 1)) end
    def reverse; Vector3d.new(-x, -y, -z); end
  end
  class Point3d
    attr_reader :x, :y, :z
    def initialize(x = 0, y = 0, z = 0)
      x, y, z = x if x.is_a?(Array)
      @x, @y, @z = x.to_f, y.to_f, z.to_f
    end
    def to_a; [@x, @y, @z]; end
    def -(o) Vector3d.new(x - o.x, y - o.y, z - o.z) end
  end
  class Transformation
    attr_reader :m # 3x4 row-major [r|t]
    def initialize(pt = nil)
      @m = [[1,0,0,0],[0,1,0,0],[0,0,1,0]].map { |r| r.map(&:to_f) }
      if pt
        a = pt.to_a
        3.times { |i| @m[i][3] = a[i] }
      end
    end
    def self.axes(o, xa, ya, za)
      raise 'axes not unit' unless (xa.length - 1).abs < 1e-6 && (ya.length - 1).abs < 1e-6
      raise 'axes not orthogonal' unless xa.dot(ya).abs < 1e-6
      t = new
      cols = [xa, ya, za].map(&:to_a)
      3.times { |i| 3.times { |j| t.m[i][j] = cols[j][i] } ; t.m[i][3] = o.to_a[i] }
      t
    end
    def inverse
      t = Transformation.new
      3.times { |i| 3.times { |j| t.m[i][j] = @m[j][i] } }
      3.times { |i| t.m[i][3] = -(0..2).sum { |j| t.m[i][j] * @m[j][3] } }
      t
    end
    def *(p)
      a = p.to_a
      Point3d.new(*(0..2).map { |i| (0..2).sum { |j| @m[i][j] * a[j] } + @m[i][3] })
    end
  end
  class PolygonMesh
    attr_reader :points, :polys
    def initialize(*) @points = []; @polys = [] end
    def add_point(pt) @points << pt; @points.size end
    def add_polygon(*idx)
      idx = idx.flatten
      raise "bad polygon #{idx.inspect}" if idx.size < 3 || idx.any? { |i| i < 1 || i > @points.size } || idx.uniq.size != idx.size
      @polys << idx
    end
  end
end

module Sketchup
  def self.platform; :platform_win; end
  class Color; def initialize(*a) @a = a end; end
  module Attr
    def set_attribute(d, k, v) ((@attrs ||= {})[d] ||= {})[k] = v end
    def get_attribute(d, k, default = nil) ((@attrs ||= {})[d] || {}).fetch(k, default) end
  end
  class Material; attr_accessor :color, :alpha, :name; def initialize(n) @name = n end; end
  class Materials
    def initialize; @h = {}; end
    def [](n) @h[n] end
    def add(n) @h[n] = Material.new(n) end
    def size; @h.size; end
  end
  class Face
    attr_reader :normal
    def initialize(n) @normal = Geom::Vector3d.new(*n) end
    def reverse!; @normal = @normal.reverse; end
    def pushpull(h) raise 'pushpull <= 0' unless h > 0; @h = h end
  end
  class Edge; attr_accessor :soft, :smooth; def faces; []; end; end
  class Entities
    include Enumerable
    attr_reader :items, :meshes, :owner
    def initialize(owner = nil) @items = []; @meshes = []; @owner = owner end
    def each(&b) @items.each(&b) end
    def clear!; @items.clear; @meshes.clear; end
    def add_group; g = Group.new(DEF_STUB); @items << g; g end
    def add_instance(d, tr) raise 'nil def' unless d; i = ComponentInstance.new(d, tr); d.count += 1; @items << i; i end
    def add_circle(c, n, r, seg) raise 'radius' unless r > 0; [:circle, seg] end
    def add_face(*pts)
      pts = pts.flatten(1) if pts.size == 1
      f = Face.new([0, 0, -1]); @items << f; f
    end
    def fill_from_mesh(mesh, *)
      raise 'fill_from_mesh on non-empty entities' unless @items.empty?
      @meshes << mesh
      vol = 0.0
      mesh.polys.each do |poly|
        a = mesh.points[poly[0] - 1].to_a
        (1...(poly.size - 1)).each do |k|
          b = mesh.points[poly[k] - 1].to_a
          c = mesh.points[poly[k + 1] - 1].to_a
          ab = [b[0]-a[0], b[1]-a[1], b[2]-a[2]]; ac = [c[0]-a[0], c[1]-a[1], c[2]-a[2]]
          cr = [ab[1]*ac[2]-ab[2]*ac[1], ab[2]*ac[0]-ab[0]*ac[2], ab[0]*ac[1]-ab[1]*ac[0]]
          area = Math.sqrt(cr.sum { |q| q*q }) / 2
          $degenerate += 1 if area < 1e-9
          vol += (a[0]*(b[1]*c[2]-b[2]*c[1]) - a[1]*(b[0]*c[2]-b[2]*c[0]) + a[2]*(b[0]*c[1]-b[1]*c[0])) / 6.0
        end
      end
      $volumes << vol
      true
    end
    def grep(k) @items.grep(k) end
  end
  class ComponentDefinition
    include Attr
    attr_accessor :count, :name
    attr_reader :entities
    def initialize(n) @name = n; @entities = Entities.new; @count = 0 end
    def group?; false; end
    def image?; false; end
    def valid?; true; end
    def count_instances; @count; end
  end
  DEF_STUB = ComponentDefinition.new('stub')
  DEF_STUB.count = 1
  class DefinitionList
    include Enumerable
    def initialize; @a = []; end
    def each(&b) @a.each(&b) end
    def [](n) @a.find { |d| d.name == n } end
    def add(n) d = ComponentDefinition.new(n); @a << d; d end
    def remove(d) @a.delete(d) end
    def to_a; @a.dup; end
  end
  class Drawingelement; include Attr; attr_accessor :name, :material, :transformation; def valid?; true; end; end
  class Group < Drawingelement
    attr_reader :entities, :definition
    def initialize(d) @entities = Entities.new(self); @definition = d; @transformation = Geom::Transformation.new end
    def make_unique; @definition = ComponentDefinition.new('u'); @definition.count = 1; end
  end
  class ComponentInstance < Drawingelement
    attr_reader :definition
    def initialize(d, tr) @definition = d; @transformation = tr end
  end
  class Model
    attr_reader :definitions, :materials, :active_entities
    def initialize; @definitions = DefinitionList.new; @materials = Materials.new; @active_entities = Entities.new end
  end
end
