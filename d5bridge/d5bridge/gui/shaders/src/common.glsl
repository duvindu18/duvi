layout(std140, binding = 0) uniform Draw {
    mat4 mvp;
    mat4 model;
    mat4 nmat;
    vec4 base;      // rgb, opacity
    vec4 params;    // roughness, metallic, foliage, selected
    vec4 flags;     // has_base, has_opacity, has_normal, has_roughness
    vec4 flags2;    // base_alpha, rough_invert, flip_green, clay
    vec4 uvx_base;
    vec4 uvx_op;
    vec4 uvx_nrm;
    vec4 uvx_rough;
    vec4 cam;       // xyz camera, w = dFdy sign (framebuffer y direction)
    vec4 sel_col;
    vec4 wire_col;
} u;
