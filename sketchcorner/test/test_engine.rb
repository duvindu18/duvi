# frozen_string_literal: true

require_relative 'test_helper'

class TestEngine < Minitest::Test
  include MeshFixtures

  def test_single_edge_fillet_volume
    m = box
    res = bevel(m, [[4, 5]], 'radius' => 1.0, 'segments' => 32)
    assert res.ok, res.fatal
    assert_closed_manifold(res)
    expected = 1000.0 - removed_section(1.0, 32) * 10.0
    assert_in_delta expected, volume(res), 1e-6
  end

  def test_fillet_points_lie_on_cylinder
    res = bevel(box, [[4, 5]], 'radius' => 2.0, 'segments' => 8)
    strip = res.polygons.select { |p| p[:kind] == :strip }
    assert_equal 8, strip.size
    strip.flat_map { |p| p[:loops][0] }.uniq.each do |i|
      y, z = res.points[i][1], res.points[i][2]
      assert_in_delta 2.0, Math.hypot(y - 2.0, z - 8.0), 1e-9
    end
  end

  def test_three_edge_corner_makes_sphere_patch
    res = bevel(box, [[4, 5], [5, 6], [1, 5]], 'radius' => 1.0, 'segments' => 6, 'miter' => 'smooth')
    assert res.ok, res.fatal
    assert_closed_manifold(res)
    patch = res.polygons.select { |p| p[:kind] == :patch }
    refute_empty patch
    patch.flat_map { |p| p[:loops][0] }.uniq.each do |i|
      assert_in_delta 1.0, V.dist(res.points[i], [9.0, 1.0, 9.0]), 1e-6
    end
    assert_equal 1, res.stats['junctions']
  end

  def test_corner_strategies_all_close
    %w[smooth sharp blend].each do |mode|
      res = bevel(box, [[4, 5], [5, 6], [1, 5]], 'radius' => 1.5, 'miter' => mode)
      assert res.ok, "#{mode}: #{res.fatal}"
      assert_closed_manifold(res)
    end
  end

  def test_top_loop_sharp_miter_needs_no_patch
    res = bevel(box, [[4, 5], [5, 6], [6, 7], [7, 4]], 'radius' => 1.0, 'segments' => 5)
    assert res.ok, res.fatal
    assert_closed_manifold(res)
    assert_empty res.polygons.select { |p| p[:kind] == :patch }
    assert_equal 1, res.stats['chains']
  end

  def test_all_twelve_box_edges
    edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]
    res = bevel(box, edges, 'radius' => 2.0, 'segments' => 4)
    assert res.ok, res.fatal
    assert_closed_manifold(res)
    assert_equal 8, res.stats['patches']
  end

  def test_profiles
    [{ 'profile' => 'conic', 'ratio' => 2.0, 'rho' => 0.6 },
     { 'profile' => 'bevel', 'bevel_mode' => 'chamfer' },
     { 'profile' => 'bevel', 'bevel_mode' => 'stepped', 'steps' => 3 },
     { 'profile' => 'bevel', 'bevel_mode' => 'facet', 'segments' => 3 },
     { 'profile' => 'cove' },
     { 'profile' => 'custom', 'custom_profile' => [[1, 0], [0.6, 0.1], [0.2, 0.3], [0, 1]] }].each do |p|
      res = bevel(box, [[4, 5], [5, 6], [1, 5]], p.merge('radius' => 1.0))
      assert res.ok, "#{p}: #{res.fatal}"
      assert_closed_manifold(res)
    end
  end

  def test_chamfer_volume
    res = bevel(box, [[4, 5]], 'profile' => 'bevel', 'radius' => 2.0, 'measure' => 'setback')
    assert_in_delta 1000.0 - 2.0 * 10.0, volume(res), 1e-6
  end

  def test_cove_removes_more_than_chamfer
    cove = volume(bevel(box, [[4, 5]], 'profile' => 'cove', 'radius' => 2.0, 'segments' => 16))
    assert_in_delta 1000.0 - (Math::PI * 4 / 4) * 10.0, cove, 0.2
  end

  def test_variable_radius
    res = bevel(box, [[4, 5], [5, 6], [6, 7]], 'radius' => 0.5, 'radius_end' => 2.0, 'variable' => true)
    assert res.ok, res.fatal
    assert_closed_manifold(res)
    tri = res.polygons.count { |p| p[:kind] == :strip && p[:loops][0].size == 3 }
    assert tri.positive?, 'non-uniform strips are triangulated'
  end

  def test_cylinder_rim_chain_is_continuous
    m = prism(24)
    rim = (0...24).map { |i| [24 + i, 24 + (i + 1) % 24] }
    res = bevel(m, rim, 'radius' => 0.8, 'segments' => 4)
    assert res.ok, res.fatal
    assert_closed_manifold(res)
    assert_empty res.polygons.select { |p| p[:kind] == :patch }
    seam = res.edge_flags.select do |(a, b), _f|
      ma = res.point_meta[a]
      mb = res.point_meta[b]
      [[ma, mb], [mb, ma]].any? { |x, y| x[:v] && x[:v] < 24 && y[:e] && y[:e][0] == x[:v] }
    end
    refute_empty seam
    assert seam.values.all? { |f| f['soft'] }, 'soft side seams stay soft after trimming'
  end

  def test_concave_edge_adds_material
    m = l_block
    res = bevel(m, [[3, 9]], 'radius' => 1.0, 'segments' => 32)
    assert res.ok, res.fatal
    assert_closed_manifold(res)
    base = 10 * 4 * 5 + 4 * 6 * 5
    assert_in_delta base + removed_section(1.0, 32) * 5.0, volume(res), 1e-6
  end

  def test_clamp_limits_radius
    res = bevel(box, [[4, 5], [6, 7]], 'radius' => 8.0)
    assert res.ok, res.fatal
    assert_closed_manifold(res)
    refute_empty res.collisions
    res.collisions.each_value { |r| assert r < 5.0 }
  end

  def test_no_clamp_reports_collision
    res = bevel(box, [[4, 5], [6, 7]], 'radius' => 8.0, 'clamp' => false)
    refute res.ok
    refute_empty res.collisions
  end

  def test_rejects_open_border_edge
    m = box
    m.faces.pop # remove left face -> edges on the border
    res = bevel(m, [[3, 7]], 'radius' => 1.0)
    refute res.ok
    assert_match(/open border/, res.fatal)
  end

  def test_edge_flags_internal_soft_boundary_hard
    res = bevel(box, [[4, 5]], 'radius' => 1.0, 'segments' => 4)
    strip_ids = res.polygons.select { |p| p[:kind] == :strip }.flat_map { |p| p[:loops][0] }
    soft = res.edge_flags.select { |_k, f| f['soft'] }.keys
    hard = res.edge_flags.reject { |_k, f| f['soft'] }.keys
    assert_equal 3, soft.size, 'three rails between four strip facets'
    boundary = hard.select { |a, b| strip_ids.include?(a) && strip_ids.include?(b) }
    assert_equal 2 + 2 * 4, boundary.size, 'two tangent lines plus both end profiles stay hard'
  end

  def test_uv_strip_matches_face_maps
    m = box
    map_top = SketchCorner::UV.map_from_samples([0, 0, 10], [1, 0, 10], [0, 1, 10], [0, 0], [1, 0], [0, 1])
    map_front = SketchCorner::UV.map_from_samples([0, 0, 0], [1, 0, 0], [0, 0, 1], [0, 0], [1, 0], [0, 1])
    m.faces[1].attrs = { 'material' => 'Wood', 'uv' => map_top }
    m.faces[2].attrs = { 'material' => 'Wood', 'uv' => map_front }
    res = bevel(m, [[4, 5]], 'radius' => 1.0, 'segments' => 4)
    strips = res.polygons.select { |p| p[:kind] == :strip }
    strips.each { |p| assert_equal 'Wood', p[:attrs]['material'] }
    first = strips.first
    # B0/A0 corners sit on the start face: UV equals that face's map
    i = first[:loops][0][1]
    uv = first[:uv][1]
    expect = SketchCorner::UV.apply(m.faces[res.polygons.find { |p| p[:kind] == :face && p[:loops][0].include?(i) && p[:attrs]['uv'] }[:group][1]].attrs['uv'], res.points[i])
    assert_in_delta expect[0], uv[0], 1e-9
    assert_in_delta expect[1], uv[1], 1e-9
  end

  def test_custom_profile_normalisation
    arc = (0..8).map { |i| a = Math::PI / 2 * i / 8; [Math.cos(a), Math.sin(a), 0.0] }
    unit = SketchCorner::Profiles.normalize_custom(arc)
    assert_in_delta 1.0, unit.first[0], 1e-9
    assert_in_delta 1.0, unit.last[1], 1e-9
    mid = unit[4]
    assert mid[0] < 0.5 && mid[1] < 0.5, 'arc bulges toward the apex'
  end

  def test_mesh_round_trip
    m = prism(8)
    m2 = SketchCorner::Mesh.from_h(JSON.parse(JSON.generate(m.to_h)))
    a = bevel(m, [[8, 9]], 'radius' => 0.5)
    b = bevel(m2, [[8, 9]], 'radius' => 0.5)
    assert_in_delta volume(a), volume(b), 1e-9
  end
end
