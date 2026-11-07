# frozen_string_literal: true
#
# ArchRailing Pro - parameter schema, sanitising and the 31 ready-made railings.
# All lengths in this file are millimetres. The generator converts to inches.
#
module ArchRailingPro
  module Defaults

    # key => [type, default, min, max]   (type :num, :int, :bool, :str, :enum, :color)
    # For :enum the 3rd element is the list of allowed values.
    SCHEMA = {
      # ---- overall ----
      'height'             => [:num,   1000,  100, 4000],
      'spacing_mode'       => [:enum,  'fit', %w[fit fixed]],
      'post_spacing'       => [:num,   1500,  50, 10000],
      'spacing_metric'     => [:enum,  '3d',  %w[3d plan]],
      'offset_h'           => [:num,   0,     -2000, 2000],
      'offset_v'           => [:num,   0,     -2000, 2000],
      'corner_angle'       => [:num,   20,    1, 179],
      'slope_break'        => [:num,   3,     0.5, 89],
      # ---- posts ----
      'show_start_post'    => [:bool,  true],
      'show_end_post'      => [:bool,  true],
      'show_corner_posts'  => [:bool,  true],
      'show_mid_posts'     => [:bool,  true],
      'post_profile'       => [:enum,  'rect', %w[rect round]],
      'post_width'         => [:num,   50,    5, 500],
      'post_depth'         => [:num,   50,    5, 500],
      'post_component'     => [:str,   ''],
      'base_plate'         => [:bool,  false],
      # ---- top rail ----
      'top_rail'           => [:bool,  true],
      'top_rail_profile'   => [:enum,  'rect', %w[rect round]],
      'top_rail_width'     => [:num,   60,    5, 500],
      'top_rail_height'    => [:num,   40,    5, 500],
      'top_rail_overhang'  => [:num,   0,     0, 1000],
      # ---- bottom rail ----
      'bottom_rail'        => [:bool,  false],
      'bottom_rail_profile'=> [:enum,  'rect', %w[rect round]],
      'bottom_rail_width'  => [:num,   40,    5, 500],
      'bottom_rail_height' => [:num,   40,    5, 500],
      'bottom_rail_elev'   => [:num,   100,   -1000, 3000],
      # ---- infill ----
      'infill_type'        => [:enum,  'balusters', %w[none balusters glass panel horizontal]],
      'infill_bottom'      => [:num,   100,   -1000, 3000],
      'infill_top_gap'     => [:num,   0,     0, 1000],
      'baluster_profile'   => [:enum,  'rect', %w[rect round]],
      'baluster_width'     => [:num,   20,    3, 400],
      'baluster_depth'     => [:num,   20,    3, 400],
      'baluster_spacing'   => [:num,   120,   10, 3000],
      'baluster_component' => [:str,   ''],
      'glass_thickness'    => [:num,   12,    2, 200],
      'glass_gap'          => [:num,   20,    0, 500],
      'glass_offset'       => [:num,   0,     -500, 500],
      'show_clamps'        => [:bool,  false],
      'clamp_width'        => [:num,   50,    5, 300],
      'clamp_depth'        => [:num,   30,    5, 300],
      'clamp_height'       => [:num,   60,    5, 300],
      'clamp_inset'        => [:num,   150,   0, 2000],
      'clamp_component'    => [:str,   ''],
      'hrail_count'        => [:int,   4,     1, 40],
      'hrail_profile'      => [:enum,  'round', %w[rect round]],
      'hrail_width'        => [:num,   12,    1, 400],
      'hrail_height'       => [:num,   12,    1, 400],
      # ---- secondary handrail on brackets ----
      'handrail2'          => [:bool,  false],
      'handrail2_elev'     => [:num,   900,   100, 3000],
      'handrail2_offset'   => [:num,   70,    -500, 500],
      'handrail2_diameter' => [:num,   42,    10, 200],
      'bracket_size'       => [:num,   16,    4, 100],
      # ---- materials ----
      'post_color'         => [:color, '#2b2b2b'],
      'rail_color'         => [:color, '#2b2b2b'],
      'infill_color'       => [:color, '#2b2b2b'],
      'glass_color'        => [:color, '#9cc3d5'],
      'glass_opacity'      => [:num,   0.35,  0.05, 1.0],
      'panel_opacity'      => [:num,   1.0,   0.05, 1.0],
      'hardware_color'     => [:color, '#b8b8b8'],
      # ---- quality ----
      'round_segments'     => [:int,   16,    6, 48]
    }.freeze

    def self.base
      h = {}
      SCHEMA.each { |k, spec| h[k] = spec[1] }
      h
    end

    # Coerce an untrusted hash (from JSON/UI/attributes) into a complete,
    # valid parameter hash. Unknown keys are dropped, bad values fall back.
    def self.sanitize(input)
      input ||= {}
      out = {}
      SCHEMA.each do |key, spec|
        type = spec[0]
        default = spec[1]
        raw = input.key?(key) ? input[key] : input[key.to_sym]
        out[key] =
          case type
          when :num
            v = Float(raw) rescue default.to_f
            v = default.to_f unless v.finite?
            v.clamp(spec[2].to_f, spec[3].to_f)
          when :int
            v = Integer(Float(raw)) rescue default
            v.clamp(spec[2], spec[3])
          when :bool
            case raw
            when true, 'true', 1, '1' then true
            when false, 'false', 0, '0' then false
            else default
            end
          when :enum
            spec[2].include?(raw.to_s) ? raw.to_s : default
          when :color
            s = raw.to_s.strip
            s =~ /\A#[0-9a-fA-F]{6}\z/ ? s.downcase : default
          else
            raw.nil? ? default : raw.to_s[0, 200]
          end
      end
      out
    end

    # Cross-field checks. Returns an Array of human readable errors.
    def self.validate(p)
      errs = []
      tr = p['top_rail'] ? rail_h(p['top_rail_profile'], p['top_rail_width'], p['top_rail_height']) : 0.0
      if p['height'] - tr < 20
        errs << "Height must be at least #{(tr + 20).round} mm with this top rail."
      end
      top = p['height'] - tr - p['infill_top_gap']
      bottom = infill_bottom(p)
      if p['infill_type'] != 'none' && top - bottom < 20
        errs << 'Infill has no room: lower the infill bottom or the top gap.'
      end
      errs
    end

    def self.rail_h(profile, w, h)
      profile == 'round' ? w : h
    end

    def self.infill_bottom(p)
      if p['bottom_rail']
        p['bottom_rail_elev'] + rail_h(p['bottom_rail_profile'], p['bottom_rail_width'], p['bottom_rail_height'])
      else
        p['infill_bottom']
      end
    end

    # ------------------------------------------------------------------
    # Ready-made railings (31). Each entry overrides the base defaults.
    # ------------------------------------------------------------------
    STEEL = '#2b2b2b'
    INOX  = '#b8bcc0'
    WHITE = '#f0f0ec'
    WOOD  = '#8a5a36'
    CEDAR = '#a8714a'
    GREY  = '#6e6e6e'

    GLASS_POSTLESS = {
      'show_start_post' => false, 'show_end_post' => false,
      'show_corner_posts' => false, 'show_mid_posts' => false,
      'infill_type' => 'glass', 'glass_gap' => 4
    }.freeze

    PRESETS = [
      # ---------------- Glass ----------------
      ['glass_shoe', 'Glass', 'Frameless glass, base shoe', GLASS_POSTLESS.merge(
        'height' => 1100, 'post_spacing' => 1200,
        'bottom_rail' => true, 'bottom_rail_elev' => 0, 'bottom_rail_width' => 70, 'bottom_rail_height' => 110,
        'top_rail' => true, 'top_rail_width' => 30, 'top_rail_height' => 30,
        'infill_top_gap' => 0, 'glass_thickness' => 17.5,
        'rail_color' => INOX, 'post_color' => INOX)],
      ['glass_round_post_clamp', 'Glass', 'Glass, round posts, clamps', {
        'infill_type' => 'glass', 'post_profile' => 'round', 'post_width' => 42.4, 'post_spacing' => 1200,
        'top_rail_profile' => 'round', 'top_rail_width' => 42.4, 'infill_bottom' => 80, 'infill_top_gap' => 80,
        'glass_thickness' => 10, 'glass_gap' => 30, 'show_clamps' => true, 'clamp_width' => 45, 'clamp_depth' => 25,
        'clamp_height' => 50, 'post_color' => INOX, 'rail_color' => INOX, 'hardware_color' => INOX }],
      ['glass_square_post_clamp', 'Glass', 'Glass, square posts, clamps', {
        'infill_type' => 'glass', 'post_width' => 50, 'post_depth' => 50, 'post_spacing' => 1300,
        'top_rail_width' => 60, 'top_rail_height' => 40, 'infill_bottom' => 80, 'infill_top_gap' => 60,
        'glass_thickness' => 10, 'glass_gap' => 30, 'show_clamps' => true, 'hardware_color' => INOX }],
      ['glass_wood_cap', 'Glass', 'Glass, timber posts and cap', {
        'infill_type' => 'glass', 'post_width' => 90, 'post_depth' => 90, 'post_spacing' => 1500,
        'top_rail_width' => 140, 'top_rail_height' => 40, 'top_rail_overhang' => 50,
        'infill_bottom' => 60, 'infill_top_gap' => 40, 'glass_thickness' => 10, 'glass_gap' => 25,
        'show_clamps' => true, 'clamp_width' => 40, 'clamp_depth' => 25, 'clamp_height' => 40,
        'post_color' => WOOD, 'rail_color' => WOOD, 'hardware_color' => INOX }],
      ['glass_side_mount', 'Glass', 'Side mounted glass, handrail', GLASS_POSTLESS.merge(
        'height' => 1100, 'post_spacing' => 1200, 'infill_bottom' => -150, 'glass_offset' => -40,
        'top_rail_profile' => 'round', 'top_rail_width' => 42.4, 'infill_top_gap' => 0,
        'glass_thickness' => 13.5, 'rail_color' => INOX, 'hardware_color' => INOX)],
      ['glass_standoff_handrail', 'Glass', 'Frameless glass, wall handrail', GLASS_POSTLESS.merge(
        'height' => 1100, 'post_spacing' => 1200, 'top_rail' => false,
        'bottom_rail' => true, 'bottom_rail_elev' => 0, 'bottom_rail_width' => 70, 'bottom_rail_height' => 110,
        'glass_thickness' => 13.5, 'handrail2' => true, 'handrail2_elev' => 900, 'handrail2_offset' => 70,
        'rail_color' => INOX, 'hardware_color' => INOX)],

      # ---------------- Metal ----------------
      ['steel_2rail', 'Metal', 'Steel tube, 2 rails', {
        'infill_type' => 'horizontal', 'hrail_count' => 1, 'hrail_profile' => 'round', 'hrail_width' => 33.7,
        'post_profile' => 'round', 'post_width' => 42.4, 'top_rail_profile' => 'round', 'top_rail_width' => 42.4,
        'infill_bottom' => 0, 'post_color' => INOX, 'rail_color' => INOX, 'infill_color' => INOX }],
      ['steel_3rail', 'Metal', 'Steel tube, 3 rails', {
        'infill_type' => 'horizontal', 'hrail_count' => 2, 'hrail_profile' => 'round', 'hrail_width' => 26.9,
        'post_profile' => 'round', 'post_width' => 42.4, 'top_rail_profile' => 'round', 'top_rail_width' => 42.4,
        'infill_bottom' => 0, 'post_color' => INOX, 'rail_color' => INOX, 'infill_color' => INOX }],
      ['steel_5rail', 'Metal', 'Steel tube, 5 rails', {
        'infill_type' => 'horizontal', 'hrail_count' => 4, 'hrail_profile' => 'round', 'hrail_width' => 16,
        'post_profile' => 'round', 'post_width' => 42.4, 'top_rail_profile' => 'round', 'top_rail_width' => 42.4,
        'infill_bottom' => 50, 'post_color' => INOX, 'rail_color' => INOX, 'infill_color' => INOX }],
      ['industrial_pipe', 'Metal', 'Industrial pipe, toe board', {
        'height' => 1100, 'post_spacing' => 1800, 'infill_type' => 'horizontal', 'hrail_count' => 1,
        'hrail_profile' => 'round', 'hrail_width' => 42.4, 'post_profile' => 'round', 'post_width' => 48.3,
        'top_rail_profile' => 'round', 'top_rail_width' => 48.3, 'base_plate' => true,
        'bottom_rail' => true, 'bottom_rail_elev' => 10, 'bottom_rail_width' => 6, 'bottom_rail_height' => 150,
        'post_color' => '#d9a400', 'rail_color' => '#d9a400', 'infill_color' => '#d9a400' }],
      ['square_tube_balusters', 'Metal', 'Square tube, square bars', {
        'post_width' => 40, 'post_depth' => 40, 'top_rail_width' => 40, 'top_rail_height' => 40,
        'bottom_rail' => true, 'bottom_rail_width' => 40, 'bottom_rail_height' => 20, 'bottom_rail_elev' => 80,
        'baluster_width' => 16, 'baluster_depth' => 16, 'baluster_spacing' => 110 }],
      ['flat_bar_vertical', 'Metal', 'Vertical flat bars', {
        'post_width' => 50, 'post_depth' => 10, 'top_rail_width' => 50, 'top_rail_height' => 10,
        'bottom_rail' => true, 'bottom_rail_width' => 50, 'bottom_rail_height' => 10, 'bottom_rail_elev' => 80,
        'baluster_width' => 10, 'baluster_depth' => 40, 'baluster_spacing' => 100 }],
      ['flat_bar_horizontal', 'Metal', 'Horizontal flat bars', {
        'post_width' => 50, 'post_depth' => 50, 'top_rail_width' => 50, 'top_rail_height' => 10,
        'infill_type' => 'horizontal', 'hrail_count' => 8, 'hrail_profile' => 'rect',
        'hrail_width' => 8, 'hrail_height' => 50, 'infill_bottom' => 60 }],
      ['stair_handrail', 'Metal', 'Stair handrail on posts', {
        'height' => 900, 'post_spacing' => 1500, 'infill_type' => 'none', 'base_plate' => true,
        'post_profile' => 'round', 'post_width' => 42.4, 'top_rail_profile' => 'round', 'top_rail_width' => 42.4,
        'top_rail_overhang' => 300, 'post_color' => INOX, 'rail_color' => INOX }],
      ['wall_handrail', 'Metal', 'Wall handrail on brackets', {
        'show_start_post' => false, 'show_end_post' => false, 'show_corner_posts' => false, 'show_mid_posts' => false,
        'top_rail' => false, 'infill_type' => 'none', 'post_spacing' => 1000,
        'handrail2' => true, 'handrail2_elev' => 900, 'handrail2_offset' => 70, 'handrail2_diameter' => 42.4,
        'rail_color' => INOX, 'hardware_color' => INOX }],

      # ---------------- Cable ----------------
      ['cable_steel_post', 'Cable', 'Cable rail, steel posts', {
        'infill_type' => 'horizontal', 'hrail_count' => 10, 'hrail_profile' => 'round', 'hrail_width' => 5,
        'post_width' => 50, 'post_depth' => 50, 'top_rail_width' => 60, 'top_rail_height' => 25,
        'infill_bottom' => 60, 'infill_color' => INOX }],
      ['cable_wood_post', 'Cable', 'Cable rail, timber posts', {
        'infill_type' => 'horizontal', 'hrail_count' => 10, 'hrail_profile' => 'round', 'hrail_width' => 5,
        'post_width' => 100, 'post_depth' => 100, 'top_rail_width' => 140, 'top_rail_height' => 40,
        'top_rail_overhang' => 50, 'infill_bottom' => 60,
        'post_color' => CEDAR, 'rail_color' => CEDAR, 'infill_color' => INOX }],
      ['cable_round_post', 'Cable', 'Cable rail, round posts', {
        'infill_type' => 'horizontal', 'hrail_count' => 6, 'hrail_profile' => 'round', 'hrail_width' => 6,
        'post_profile' => 'round', 'post_width' => 42.4, 'top_rail_profile' => 'round', 'top_rail_width' => 42.4,
        'infill_bottom' => 100, 'post_color' => INOX, 'rail_color' => INOX, 'infill_color' => INOX }],

      # ---------------- Balusters ----------------
      ['classic_balusters', 'Balusters', 'Classic square balusters', {
        'post_width' => 100, 'post_depth' => 100, 'top_rail_width' => 80, 'top_rail_height' => 60,
        'bottom_rail' => true, 'bottom_rail_width' => 60, 'bottom_rail_height' => 40, 'bottom_rail_elev' => 60,
        'baluster_width' => 40, 'baluster_depth' => 40, 'baluster_spacing' => 120,
        'post_color' => WHITE, 'rail_color' => WHITE, 'infill_color' => WHITE }],
      ['round_spindles', 'Balusters', 'Round spindles', {
        'post_width' => 90, 'post_depth' => 90, 'top_rail_profile' => 'round', 'top_rail_width' => 60,
        'bottom_rail' => true, 'bottom_rail_width' => 50, 'bottom_rail_height' => 35, 'bottom_rail_elev' => 60,
        'baluster_profile' => 'round', 'baluster_width' => 28, 'baluster_spacing' => 110,
        'post_color' => WOOD, 'rail_color' => WOOD, 'infill_color' => WOOD }],
      ['slim_rod_balusters', 'Balusters', 'Slim steel rods', {
        'post_width' => 40, 'post_depth' => 40, 'top_rail_width' => 50, 'top_rail_height' => 30,
        'bottom_rail' => true, 'bottom_rail_width' => 40, 'bottom_rail_height' => 20, 'bottom_rail_elev' => 80,
        'baluster_profile' => 'round', 'baluster_width' => 14, 'baluster_spacing' => 100 }],
      ['black_pickets', 'Balusters', 'Black square pickets', {
        'post_width' => 50, 'post_depth' => 50, 'top_rail_width' => 50, 'top_rail_height' => 30,
        'baluster_width' => 20, 'baluster_depth' => 20, 'baluster_spacing' => 100, 'infill_bottom' => 50 }],
      ['dense_rods', 'Balusters', 'Dense vertical rods', {
        'post_width' => 60, 'post_depth' => 60, 'top_rail_width' => 60, 'top_rail_height' => 20,
        'bottom_rail' => true, 'bottom_rail_width' => 60, 'bottom_rail_height' => 20, 'bottom_rail_elev' => 40,
        'baluster_profile' => 'round', 'baluster_width' => 10, 'baluster_spacing' => 45 }],

      # ---------------- Wood ----------------
      ['picket_fence', 'Wood', 'Picket fence', {
        'height' => 1000, 'post_spacing' => 2000, 'post_width' => 100, 'post_depth' => 100, 'top_rail' => false,
        'bottom_rail' => true, 'bottom_rail_width' => 25, 'bottom_rail_height' => 90, 'bottom_rail_elev' => 150,
        'infill_bottom' => 50, 'baluster_width' => 90, 'baluster_depth' => 20, 'baluster_spacing' => 150,
        'post_color' => WHITE, 'rail_color' => WHITE, 'infill_color' => WHITE }],
      ['ranch_fence', 'Wood', 'Ranch rail fence', {
        'height' => 1200, 'post_spacing' => 2400, 'post_width' => 120, 'post_depth' => 120, 'top_rail' => false,
        'infill_type' => 'horizontal', 'hrail_count' => 3, 'hrail_profile' => 'rect',
        'hrail_width' => 30, 'hrail_height' => 150, 'infill_bottom' => 150,
        'post_color' => CEDAR, 'infill_color' => CEDAR }],
      ['horizontal_slats', 'Wood', 'Horizontal slat screen', {
        'height' => 1800, 'post_spacing' => 1800, 'post_width' => 90, 'post_depth' => 90,
        'top_rail_width' => 110, 'top_rail_height' => 25,
        'infill_type' => 'horizontal', 'hrail_count' => 14, 'hrail_profile' => 'rect',
        'hrail_width' => 20, 'hrail_height' => 90, 'infill_bottom' => 30,
        'post_color' => GREY, 'rail_color' => CEDAR, 'infill_color' => CEDAR }],
      ['privacy_boards', 'Wood', 'Vertical board privacy fence', {
        'height' => 1800, 'post_spacing' => 2400, 'post_width' => 100, 'post_depth' => 100, 'top_rail' => false,
        'bottom_rail' => true, 'bottom_rail_width' => 40, 'bottom_rail_height' => 90, 'bottom_rail_elev' => 200,
        'infill_bottom' => 50, 'baluster_width' => 140, 'baluster_depth' => 20, 'baluster_spacing' => 145,
        'post_color' => CEDAR, 'rail_color' => CEDAR, 'infill_color' => CEDAR }],
      ['deck_railing', 'Wood', 'Timber deck railing', {
        'post_width' => 90, 'post_depth' => 90, 'top_rail_width' => 140, 'top_rail_height' => 40, 'top_rail_overhang' => 50,
        'bottom_rail' => true, 'bottom_rail_width' => 90, 'bottom_rail_height' => 45, 'bottom_rail_elev' => 60,
        'baluster_width' => 40, 'baluster_depth' => 40, 'baluster_spacing' => 125,
        'post_color' => WOOD, 'rail_color' => WOOD, 'infill_color' => WOOD }],

      # ---------------- Panel ----------------
      ['solid_panel', 'Panel', 'Solid metal panel', {
        'infill_type' => 'panel', 'post_width' => 50, 'post_depth' => 50, 'top_rail_width' => 50, 'top_rail_height' => 30,
        'glass_thickness' => 4, 'glass_gap' => 10, 'infill_bottom' => 60, 'infill_color' => '#3d4a52' }],
      ['perforated_panel', 'Panel', 'Perforated screen panel', {
        'infill_type' => 'panel', 'post_width' => 60, 'post_depth' => 60, 'top_rail_width' => 60, 'top_rail_height' => 40,
        'glass_thickness' => 3, 'glass_gap' => 15, 'infill_bottom' => 80, 'infill_top_gap' => 60,
        'panel_opacity' => 0.55, 'infill_color' => '#5a5a5a' }],
      ['parapet_wall', 'Panel', 'Solid parapet wall', {
        'show_start_post' => false, 'show_end_post' => false, 'show_corner_posts' => false, 'show_mid_posts' => false,
        'height' => 1100, 'post_spacing' => 6000, 'infill_type' => 'panel', 'glass_thickness' => 150, 'glass_gap' => 0,
        'infill_bottom' => 0, 'top_rail_width' => 200, 'top_rail_height' => 50, 'top_rail_overhang' => 0,
        'infill_color' => '#d8d4cc', 'rail_color' => '#bdb8ae' }]
    ].freeze

    def self.presets
      PRESETS.map do |id, cat, name, over|
        { 'id' => id, 'category' => cat, 'name' => name, 'params' => sanitize(base.merge(over)) }
      end
    end

    def self.preset(id)
      presets.find { |pr| pr['id'] == id }
    end
  end
end
