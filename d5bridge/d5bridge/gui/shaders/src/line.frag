#version 440
layout(std140, binding = 0) uniform Line { mat4 mvp; vec4 color; vec4 extent; } u;
layout(location = 0) in vec3 v_p;
layout(location = 0) out vec4 frag;
void main() {
    float f = 1.0 - smoothstep(0.2 * u.extent.x, u.extent.x, length(v_p.xz - u.extent.yz));
    frag = vec4(u.color.rgb, 0.35 * f);
}
