# frozen_string_literal: true

require 'minitest/autorun'
require 'json'
require_relative '../src/SketchCorner/core/engine'

module MeshFixtures
  V = SketchCorner::VMath

  # Axis-aligned box with outward normals and counter-clockwise loops.
  def box(lx = 10.0, ly = 10.0, lz = 10.0)
    m = SketchCorner::Mesh.new
    pts = [[0, 0, 0], [lx, 0, 0], [lx, ly, 0], [0, ly, 0],
           [0, 0, lz], [lx, 0, lz], [lx, ly, lz], [0, ly, lz]]
    pts.each { |p| m.add_point(p) }
    faces = [
      [[0, 3, 2, 1], [0, 0, -1]], # bottom
      [[4, 5, 6, 7], [0, 0, 1]],  # top
      [[0, 1, 5, 4], [0, -1, 0]], # front
      [[1, 2, 6, 5], [1, 0, 0]],  # right
      [[2, 3, 7, 6], [0, 1, 0]],  # back
      [[3, 0, 4, 7], [-1, 0, 0]]  # left
    ]
    faces.each { |l, n| m.add_face([l], n, { 'material' => nil }) }
    m
  end

  # Prism over a regular n-gon (a faceted cylinder) with soft side seams.
  def prism(n = 24, r = 5.0, h = 6.0)
    m = SketchCorner::Mesh.new
    n.times { |i| a = 2 * Math::PI * i / n; m.add_point([r * Math.cos(a), r * Math.sin(a), 0.0]) }
    n.times { |i| a = 2 * Math::PI * i / n; m.add_point([r * Math.cos(a), r * Math.sin(a), h]) }
    m.add_face([(0...n).to_a.reverse], [0, 0, -1])
    m.add_face([(n...2 * n).to_a], [0, 0, 1])
    n.times do |i|
      j = (i + 1) % n
      l = [i, j, n + j, n + i]
      nrm = V.norm(V.cross(V.sub(m.points[j], m.points[i]), V.sub(m.points[n + i], m.points[i])))
      m.add_face([l], nrm)
      m.set_edge_flags(i, n + i, 'soft' => true, 'smooth' => true, 'hidden' => false)
    end
    m
  end

  # L-shaped extrusion: has a concave (inside) edge.
  def l_block
    m = SketchCorner::Mesh.new
    outline = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]]
    outline.each { |x, y| m.add_point([x, y, 0.0]) }
    outline.each { |x, y| m.add_point([x, y, 5.0]) }
    n = outline.size
    m.add_face([(0...n).to_a.reverse], [0, 0, -1])
    m.add_face([(n...2 * n).to_a], [0, 0, 1])
    n.times do |i|
      j = (i + 1) % n
      l = [i, j, n + j, n + i]
      nrm = V.norm(V.cross(V.sub(m.points[j], m.points[i]), V.sub(m.points[n + i], m.points[i])))
      m.add_face([l], nrm)
    end
    m
  end

  def bevel(mesh, edges, params = {})
    SketchCorner::Engine.run(mesh, edges, params)
  end

  # Every edge used exactly twice, in opposite directions.
  def assert_closed_manifold(res)
    dir = Hash.new(0)
    res.polygons.each do |p|
      p[:loops].each do |l|
        l.each_with_index { |a, i| dir[[a, l[(i + 1) % l.size]]] += 1 }
      end
    end
    bad = dir.reject { |(a, b), c| c == 1 && dir[[b, a]] == 1 }
    assert bad.empty?, "non-manifold edges: #{bad.keys.first(6).inspect}"
  end

  def volume(res)
    vol = 0.0
    res.polygons.each do |p|
      p[:loops].each do |l|
        pts = l.map { |i| res.points[i] }
        (1...(pts.size - 1)).each do |k|
          vol += V.dot(pts[0], V.cross(pts[k], pts[k + 1])) / 6.0
        end
      end
    end
    vol
  end

  # Area removed from a 90 deg corner by a fillet of radius r drawn with n
  # straight segments: the R x R square minus the inscribed polygonal sector.
  def removed_section(r, n)
    r * r - 0.5 * r * r * Math.sin(Math::PI / 2 / n) * n
  end
end
