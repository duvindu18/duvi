package com.veil.cam.gl

/**
 * GLSL ES 3.00 shaders. Conventions: "image" space is the upright camera frame
 * (x right, y down, in pixels of the ring textures); textures store row 0 at the
 * bottom, so image (u, v) is sampled at (u, 1 - v).
 */
object Shaders {
    /** Full-screen triangle: no vertex buffers needed. */
    const val VS = """#version 300 es
void main() {
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
"""

    /** Camera OES frame -> ring texture (upright image, unmodified colours). */
    const val COPY_OES = """#version 300 es
#extension GL_OES_EGL_image_external_essl3 : require
precision highp float;
uniform samplerExternalOES uOes;
uniform mat4 uSt;
uniform mat3 uPre;     // optional quarter-turn when the producer did not rotate the frame
uniform vec2 uSize;
out vec4 frag;
void main() {
    vec2 t = (uPre * vec3(gl_FragCoord.xy / uSize, 1.0)).xy;
    frag = vec4(texture(uOes, (uSt * vec4(t, 0.0, 1.0)).xy).rgb, 1.0);
}
"""

    /** 4x downsample with a 4-tap box (each tap is a bilinear 2x2). */
    const val DOWN = """#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uSrcTexel;
uniform vec2 uDstSize;
out vec4 frag;
void main() {
    vec2 t = gl_FragCoord.xy / uDstSize;
    vec3 c = texture(uSrc, t + uSrcTexel * vec2(-1.0, -1.0)).rgb
           + texture(uSrc, t + uSrcTexel * vec2( 1.0, -1.0)).rgb
           + texture(uSrc, t + uSrcTexel * vec2(-1.0,  1.0)).rgb
           + texture(uSrc, t + uSrcTexel * vec2( 1.0,  1.0)).rgb;
    frag = vec4(c * 0.25, 1.0);
}
"""

    /** Separable 9-tap Gaussian (sigma ~2 texels) using linear sampling. */
    const val BLUR = """#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uStep;
uniform vec2 uDstSize;
out vec4 frag;
void main() {
    vec2 t = gl_FragCoord.xy / uDstSize;
    vec3 c = texture(uSrc, t).rgb * 0.2270270270;
    c += texture(uSrc, t + uStep * 1.3846153846).rgb * 0.3162162162;
    c += texture(uSrc, t - uStep * 1.3846153846).rgb * 0.3162162162;
    c += texture(uSrc, t + uStep * 3.2307692308).rgb * 0.0702702703;
    c += texture(uSrc, t - uStep * 3.2307692308).rgb * 0.0702702703;
    frag = vec4(c, 1.0);
}
"""

    /** Detector canvas: the image warped by the pass transform (black outside). */
    const val PASS = """#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform mat3 uCanvasToImg;   // canvas px (y down) -> image px
uniform vec2 uImgSize;
uniform float uCanvasH;
out vec4 frag;
void main() {
    vec2 q = vec2(gl_FragCoord.x, uCanvasH - gl_FragCoord.y);
    vec2 p = (uCanvasToImg * vec3(q, 1.0)).xy / uImgSize;
    if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) { frag = vec4(0.0, 0.0, 0.0, 1.0); return; }
    frag = vec4(texture(uSrc, vec2(p.x, 1.0 - p.y)).rgb, 1.0);
}
"""

    const val MAX_FACES = 12

    /** Final picture: face anonymization + white balance + LUT (+ monitoring tools on the preview). */
    const val COMPOSITE = """#version 300 es
precision highp float;
precision mediump sampler3D;
#define MAXF 12
uniform sampler2D uColor;
uniform sampler2D uBlur;      // 1/4-res blurred copy with mipmaps
uniform sampler3D uLut;
uniform sampler2D uMask;
uniform mat3 uOutToImg;       // output px (y down) -> image px
uniform vec2 uImgSize;
uniform vec2 uBlurSize;
uniform float uOutH;
uniform int uFaceCount;
uniform vec4 uFA[MAXF];       // centre x, y, half w, half h (image px)
uniform vec4 uFB[MAXF];       // cos, sin, feather band (px), effect parameter
uniform int uStyle;           // 0 gaussian, 1 pixelate, 2 black box, 3 mask
uniform int uEllipse;
uniform int uMaskTex;         // 1 = custom PNG mask in uMask
uniform int uFullBlur;        // privacy-safe start: hide the whole frame
uniform vec3 uGains;
uniform int uLutOn;
uniform float uLutAmount;
uniform float uLutSize;
uniform int uZebra;
uniform float uZebraLevel;
uniform int uFalse;
uniform int uPeak;
uniform vec3 uPeakColor;
uniform float uPeakThresh;
uniform float uPxPerOut;      // image px per output px (for peaking taps)
out vec4 frag;

vec3 img(vec2 p) { return texture(uColor, vec2(p.x / uImgSize.x, 1.0 - p.y / uImgSize.y)).rgb; }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 blurAt(vec2 p, float lod) {
    vec2 t = vec2(p.x / uImgSize.x, 1.0 - p.y / uImgSize.y);
    vec2 o = exp2(lod) * 0.5 / uBlurSize;
    vec3 c = textureLod(uBlur, t + vec2( o.x,  o.y * 0.3), lod).rgb
           + textureLod(uBlur, t + vec2(-o.x * 0.3,  o.y), lod).rgb
           + textureLod(uBlur, t + vec2(-o.x, -o.y * 0.3), lod).rgb
           + textureLod(uBlur, t + vec2( o.x * 0.3, -o.y), lod).rgb;
    return c * 0.25;
}

vec3 lut(vec3 c) {
    if (uLutOn == 0) return c;
    vec3 s = clamp(c, 0.0, 1.0) * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize;
    return mix(c, texture(uLut, s).rgb, uLutAmount);
}

vec3 falseColor(float y) {
    if (y < 0.02) return vec3(0.45, 0.0, 0.6);
    if (y < 0.10) return vec3(0.0, 0.25, 1.0);
    if (y < 0.38) return vec3(y);
    if (y < 0.45) return vec3(0.1, 0.8, 0.2);
    if (y < 0.52) return vec3(y);
    if (y < 0.58) return vec3(1.0, 0.55, 0.7);
    if (y < 0.90) return vec3(y);
    if (y < 0.97) return vec3(1.0, 0.9, 0.0);
    return vec3(1.0, 0.0, 0.0);
}

void main() {
    vec2 q = vec2(gl_FragCoord.x, uOutH - gl_FragCoord.y);
    vec2 p = (uOutToImg * vec3(q, 1.0)).xy;
    if (p.x < 0.0 || p.y < 0.0 || p.x > uImgSize.x || p.y > uImgSize.y) { frag = vec4(0.0, 0.0, 0.0, 1.0); return; }
    vec3 base = img(p) * uGains;

    // Strongest face mask at this pixel.
    float m = 0.0;
    int best = -1;
    vec2 bestLocal = vec2(0.0);
    for (int i = 0; i < MAXF; i++) {
        if (i >= uFaceCount) break;
        vec2 d = p - uFA[i].xy;
        vec2 l = vec2(uFB[i].x * d.x + uFB[i].y * d.y, -uFB[i].y * d.x + uFB[i].x * d.y);
        vec2 hs = uFA[i].zw;
        float dist;
        if (uEllipse == 1) dist = (length(l / hs) - 1.0) * min(hs.x, hs.y);
        else dist = max(abs(l.x) - hs.x, abs(l.y) - hs.y);
        float band = uFB[i].z;
        float mi = band > 0.0 ? 1.0 - smoothstep(0.0, band, dist) : clamp(0.5 - dist, 0.0, 1.0);
        if (mi > m) { m = mi; best = i; bestLocal = l; }
    }
    if (uFullBlur == 1) { m = 1.0; best = -2; }

    vec3 col = base;
    vec3 solid = vec3(0.0);
    bool useSolid = false;
    if (m > 0.0) {
        if (best == -2) {
            col = mix(base, blurAt(p, 4.0) * uGains, m);
        } else if (uStyle == 0) {
            col = mix(base, blurAt(p, uFB[best].w) * uGains, m);
        } else if (uStyle == 1) {
            float blk = uFB[best].w;
            vec2 lq = (floor(bestLocal / blk) + 0.5) * blk;
            vec2 c = uFA[best].xy;
            vec2 ex = vec2(uFB[best].x, uFB[best].y);
            vec2 ey = vec2(-uFB[best].y, uFB[best].x);
            col = mix(base, img(c + lq.x * ex + lq.y * ey) * uGains, m);
        } else if (uStyle == 2) {
            solid = vec3(0.0); useSolid = true;
        } else {
            vec2 hs = uFA[best].zw;
            vec2 n = bestLocal / hs;             // -1..1 across the face
            float blk = max(hs.x, hs.y) * 0.5;   // pixelated base so transparent art never shows the face
            vec2 lq = (floor(bestLocal / blk) + 0.5) * blk;
            vec2 c = uFA[best].xy;
            vec2 ex = vec2(uFB[best].x, uFB[best].y);
            vec2 ey = vec2(-uFB[best].y, uFB[best].x);
            vec3 under = img(c + lq.x * ex + lq.y * ey) * uGains;
            vec4 art;
            if (uMaskTex == 1) {
                art = texture(uMask, vec2(n.x * 0.5 + 0.5, 0.5 - n.y * 0.5));
            } else {
                float r = length(n);
                vec3 g = mix(vec3(0.894, 0.945, 0.478), vec3(0.16, 0.17, 0.08), clamp(n.y * 0.5 + 0.5, 0.0, 1.0));
                float eyes = step(length((n - vec2(-0.28, -0.12)) * vec2(1.0, 1.6)), 0.12) + step(length((n - vec2(0.28, -0.12)) * vec2(1.0, 1.6)), 0.12);
                art = vec4(mix(g, vec3(0.04), clamp(eyes, 0.0, 1.0)), smoothstep(1.02, 0.96, r));
            }
            solid = mix(under, art.rgb, art.a); useSolid = true;
        }
    }

    vec3 graded = lut(col);
    if (useSolid) graded = mix(graded, solid, m);

    // Monitoring tools (preview only; disabled for the recording).
    float y = luma(graded);
    if (uFalse == 1) graded = falseColor(luma(base));
    if (uPeak == 1) {
        float s = 1.5 * uPxPerOut;
        float l00 = luma(img(p + vec2(-s, -s))), l10 = luma(img(p + vec2(0.0, -s))), l20 = luma(img(p + vec2(s, -s)));
        float l01 = luma(img(p + vec2(-s, 0.0))), l21 = luma(img(p + vec2(s, 0.0)));
        float l02 = luma(img(p + vec2(-s, s))), l12 = luma(img(p + vec2(0.0, s))), l22 = luma(img(p + vec2(s, s)));
        float gx = (l20 + 2.0 * l21 + l22) - (l00 + 2.0 * l01 + l02);
        float gy = (l02 + 2.0 * l12 + l22) - (l00 + 2.0 * l10 + l20);
        if (length(vec2(gx, gy)) > uPeakThresh && m < 0.5) graded = uPeakColor;
    }
    if (uZebra == 1 && y >= uZebraLevel) {
        float stripe = mod(gl_FragCoord.x + gl_FragCoord.y, 16.0);
        if (stripe < 8.0) graded = mix(graded, vec3(0.0), 0.75);
    }
    frag = vec4(graded, 1.0);
}
"""
}
