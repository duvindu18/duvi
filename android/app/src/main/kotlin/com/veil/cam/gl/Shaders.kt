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

    /**
     * 4x downsample with a 4-tap box (each tap is a bilinear 2x2). Colour sums are
     * mediump (FP16 on Mali: twice the throughput, half the register file); texture
     * coordinates stay highp.
     */
    const val DOWN = """#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uSrcTexel;
uniform vec2 uDstSize;
out vec4 frag;
void main() {
    vec2 t = gl_FragCoord.xy / uDstSize;
    mediump vec3 c = texture(uSrc, t + uSrcTexel * vec2(-1.0, -1.0)).rgb
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
    mediump vec3 c = texture(uSrc, t).rgb * 0.2270270270;
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
uniform sampler2D uPeople;    // person mask (cinematic depth), canvas of the detector base pass
uniform mat3 uImgToPeople;    // image px -> person-mask uv (y up)
uniform float uDepth;         // background blur level (0 = off)
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

void main() {
    vec2 q = vec2(gl_FragCoord.x, uOutH - gl_FragCoord.y);
    vec2 p = (uOutToImg * vec3(q, 1.0)).xy;
    if (p.x < 0.0 || p.y < 0.0 || p.x > uImgSize.x || p.y > uImgSize.y) { frag = vec4(0.0, 0.0, 0.0, 1.0); return; }
    vec3 base = img(p) * uGains;
    if (uDepth > 0.0) {
        // Cinematic depth: people stay sharp, the background is defocused.
        vec2 mu = (uImgToPeople * vec3(p, 1.0)).xy;
        float person = (mu.x < 0.0 || mu.y < 0.0 || mu.x > 1.0 || mu.y > 1.0) ? 0.0 : texture(uPeople, mu).r;
        person = smoothstep(0.35, 0.75, person);
        base = mix(blurAt(p, uDepth) * uGains, base, person);
    }

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

    frag = vec4(graded, 1.0);
}
"""

    /**
     * Film emulation and monitoring on the finished (already anonymized) picture,
     * so no effect can ever bring back original face pixels.
     */
    const val FILM = """#version 300 es
precision highp float;
uniform sampler2D uStage;     // anonymized + graded picture, mipmapped
uniform vec2 uSize;
uniform float uTime;
uniform float uGrain;
uniform float uGrainSize;
uniform float uHalation;
uniform float uBloom;
uniform float uAberration;
uniform float uLeak;
uniform float uBurn;
uniform float uVignette;
uniform int uZebra;
uniform float uZebraLevel;
uniform int uFalse;
uniform int uPeak;
uniform vec3 uPeakColor;
uniform float uPeakThresh;
out vec4 frag;

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float hash(vec3 p) {
    p = fract(p * vec3(443.897, 441.423, 437.195));
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
}
float vnoise(vec2 x, float t) {
    vec2 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash(vec3(i, t)), b = hash(vec3(i + vec2(1, 0), t));
    float c = hash(vec3(i + vec2(0, 1), t)), d = hash(vec3(i + vec2(1, 1), t));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 x, float t) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * vnoise(x, t); x *= 2.03; a *= 0.5; }
    return v;
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
    vec2 uv = gl_FragCoord.xy / uSize;
    vec3 c;
    if (uAberration > 0.0) {
        // Lateral chromatic aberration: red and blue scale apart towards the edges.
        vec2 d = (uv - 0.5) * uAberration * 0.0045;
        c = vec3(texture(uStage, uv + d).r, texture(uStage, uv).g, texture(uStage, uv - d).b);
    } else {
        c = texture(uStage, uv).rgb;
    }
    if (uBloom > 0.0 || uHalation > 0.0) {
        vec3 wide = textureLod(uStage, uv, 5.0).rgb * 0.5 + textureLod(uStage, uv, 4.0).rgb * 0.5;
        vec3 near = textureLod(uStage, uv, 2.5).rgb;
        // Bloom: only the top of the range glows, screen-blended so it can never blow out.
        vec3 bright = clamp((wide - 0.8) / 0.2, 0.0, 1.0);
        c = 1.0 - (1.0 - c) * (1.0 - bright * uBloom * 0.45);
        // Halation: a tight red-orange fringe around strong highlights (light reflected
        // back through the emulsion by the film base); dark areas next to them pick it up.
        float h = clamp((luma(near) - 0.86) / 0.14, 0.0, 1.0) * 0.7 + clamp((luma(wide) - 0.86) / 0.14, 0.0, 1.0) * 0.3;
        float room = 1.0 - luma(c);
        c = 1.0 - (1.0 - c) * (1.0 - vec3(1.0, 0.32, 0.12) * h * uHalation * 0.5 * (0.35 + 0.65 * room));
    }
    if (uLeak > 0.0) {
        // Slowly drifting warm light leaks from the frame edges (screen blend).
        float t = uTime * 0.07;
        vec2 q = uv * vec2(uSize.x / uSize.y, 1.0);
        float f = fbm(q * 1.3 + vec2(t, -t * 0.6), 0.0);
        float edge = smoothstep(0.55, 1.0, max(abs(uv.x - 0.5), abs(uv.y - 0.5)) * 2.0 * (0.75 + 0.5 * sin(t * 2.0 + uv.y * 3.0)));
        vec3 leak = mix(vec3(1.0, 0.35, 0.1), vec3(1.0, 0.8, 0.35), f) * edge * smoothstep(0.35, 0.8, f) * uLeak;
        c = 1.0 - (1.0 - c) * (1.0 - clamp(leak, 0.0, 1.0));
    }
    if (uBurn > 0.0) {
        // Film burn: occasional over-exposed bursts that flare in from a corner.
        float cycle = floor(uTime / 7.0);
        float phase = fract(uTime / 7.0);
        float env = smoothstep(0.0, 0.15, phase) * (1.0 - smoothstep(0.25, 0.55, phase)) * step(0.45, hash(vec3(cycle, 3.1, 7.7)));
        vec2 corner = vec2(step(0.5, hash(vec3(cycle, 1.0, 2.0))), step(0.5, hash(vec3(cycle, 5.0, 9.0))));
        float dist = length(uv - corner);
        float n = fbm(uv * 3.0 + cycle, cycle);
        float burn = clamp((1.0 - dist * 1.4) + n * 0.6 - 0.35, 0.0, 1.0) * env * uBurn;
        c = mix(c, vec3(1.0, 0.55, 0.15) * 1.4, burn * 0.8);
        c += vec3(1.0, 0.85, 0.6) * burn * burn * 0.6;
    }
    if (uVignette > 0.0) {
        vec2 d = (uv - 0.5) * vec2(uSize.x / uSize.y, 1.0);
        c *= mix(1.0, smoothstep(1.05, 0.25, length(d)), uVignette);
    }
    if (uGrain > 0.0) {
        // Luminance-dependent grain: strongest in the mid-tones, as with real stock.
        vec2 gp = gl_FragCoord.xy / uGrainSize;
        float t = floor(uTime * 24.0);
        float g = (vnoise(gp, t) + vnoise(gp * 1.9 + 7.3, t) * 0.5) / 1.5 - 0.5;
        float y = luma(c);
        c += g * uGrain * 0.16 * (1.0 - abs(y - 0.45) * 1.2);
    }
    c = clamp(c, 0.0, 1.0);

    // Monitoring tools (preview only; never recorded).
    float y = luma(c);
    if (uFalse == 1) c = falseColor(y);
    if (uPeak == 1) {
        vec2 px = 1.5 / uSize;
        float l00 = luma(texture(uStage, uv + vec2(-px.x, -px.y)).rgb), l10 = luma(texture(uStage, uv + vec2(0.0, -px.y)).rgb);
        float l20 = luma(texture(uStage, uv + vec2(px.x, -px.y)).rgb), l01 = luma(texture(uStage, uv + vec2(-px.x, 0.0)).rgb);
        float l21 = luma(texture(uStage, uv + vec2(px.x, 0.0)).rgb), l02 = luma(texture(uStage, uv + vec2(-px.x, px.y)).rgb);
        float l12 = luma(texture(uStage, uv + vec2(0.0, px.y)).rgb), l22 = luma(texture(uStage, uv + vec2(px.x, px.y)).rgb);
        float gx = (l20 + 2.0 * l21 + l22) - (l00 + 2.0 * l01 + l02);
        float gy = (l02 + 2.0 * l12 + l22) - (l00 + 2.0 * l10 + l20);
        if (length(vec2(gx, gy)) > uPeakThresh) c = uPeakColor;
    }
    if (uZebra == 1 && y >= uZebraLevel) {
        if (mod(gl_FragCoord.x + gl_FragCoord.y, 16.0) < 8.0) c = mix(c, vec3(0.0), 0.75);
    }
    frag = vec4(c, 1.0);
}
"""
}
