#version 440
layout(location = 0) in vec3 a_pos;
layout(std140, binding = 0) uniform Line { mat4 mvp; vec4 color; vec4 extent; } u;
layout(location = 0) out vec3 v_p;
void main() { v_p = a_pos; gl_Position = u.mvp * vec4(a_pos, 1.0); }
