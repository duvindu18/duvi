package com.veil.cam.gl

import android.opengl.GLES30
import android.util.Log

/**
 * Cinematic depth on the GPU, once per camera frame:
 *
 *  1. Edges: colour guided filter at ~640 px (the frame itself is the guide), turning
 *     the coarse person mask into coefficients a, b; the composite evaluates
 *     alpha = a . I + b at full resolution, so the outline follows hair and shoulders
 *     of this very frame.
 *  2. Lens blur at 1/4 resolution: background only (people weighted out: no halo),
 *     highlights opened into discs, shaped by the chosen aperture.
 *
 * Results are kept for the last few frames, so preview and recording share them.
 * Needs float render targets (EXT_color_buffer_float); without them [available] is
 * false and the renderer uses the plain mask.
 */
class DepthFx(private val loc: (Int, String) -> Int, private val bindTex: (Int, Int) -> Unit) {
    class Params(val radius: Float, val taps: Int, val shape: Int, val bloom: Float, val quarterTurn: Boolean)

    /** Depth-of-field inputs: depth texture (0 = none) and the focus plane. */
    class Dof(val depthTex: Int, val imgToDepth: FloatArray?, val focus: Float, val half: Float, val far: Float, val dof: Float, val range: Float)

    private class Tex(val w: Int, val h: Int, val format: Int, val linear: Boolean, val mips: Boolean = false) {
        val id: Int
        val levels = if (mips) 1 + (31 - Integer.numberOfLeadingZeros(maxOf(w, h))) else 1
        init {
            val t = IntArray(1)
            GLES30.glGenTextures(1, t, 0)
            id = t[0]
            GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, id)
            GLES30.glTexStorage2D(GLES30.GL_TEXTURE_2D, levels, format, w, h)
            val min = if (mips) GLES30.GL_LINEAR_MIPMAP_LINEAR else if (linear) GLES30.GL_LINEAR else GLES30.GL_NEAREST
            GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MIN_FILTER, min)
            GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_MAG_FILTER, if (linear) GLES30.GL_LINEAR else GLES30.GL_NEAREST)
            GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_S, GLES30.GL_CLAMP_TO_EDGE)
            GLES30.glTexParameteri(GLES30.GL_TEXTURE_2D, GLES30.GL_TEXTURE_WRAP_T, GLES30.GL_CLAMP_TO_EDGE)
        }
        fun release() = GLES30.glDeleteTextures(1, intArrayOf(id), 0)
    }

    /** Framebuffer over one or more textures (multiple render targets). */
    private class Fbo(val tex: List<Tex>) {
        val id: Int
        init {
            val f = IntArray(1)
            GLES30.glGenFramebuffers(1, f, 0)
            id = f[0]
            GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, id)
            tex.forEachIndexed { i, t -> GLES30.glFramebufferTexture2D(GLES30.GL_FRAMEBUFFER, GLES30.GL_COLOR_ATTACHMENT0 + i, GLES30.GL_TEXTURE_2D, t.id, 0) }
            GLES30.glDrawBuffers(tex.size, IntArray(tex.size) { GLES30.GL_COLOR_ATTACHMENT0 + it }, 0)
            val st = GLES30.glCheckFramebufferStatus(GLES30.GL_FRAMEBUFFER)
            GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, 0)
            check(st == GLES30.GL_FRAMEBUFFER_COMPLETE) { "depth framebuffer incomplete 0x${Integer.toHexString(st)}" }
        }
        fun bind() { GLES30.glBindFramebuffer(GLES30.GL_FRAMEBUFFER, id); GLES30.glViewport(0, 0, tex[0].w, tex[0].h) }
        fun release() = GLES30.glDeleteFramebuffers(1, intArrayOf(id), 0)
    }

    /** Outputs for one camera frame. */
    class Result(val coef: Int, val bokeh: Int)

    private class Entry(val coef: Tex, val coefFbo: Fbo, val bokeh: Tex, val bokehFbo: Fbo) {
        var key = ""
        var used = 0L
        fun release() { coefFbo.release(); bokehFbo.release(); coef.release(); bokeh.release() }
    }

    var available = false
        private set
    private var progPrep = 0; private var progBox4 = 0; private var progCoef = 0; private var progBox1 = 0
    private var progBPrep = 0; private var progBokeh = 0
    private var gW = 0; private var gH = 0; private var qW = 0; private var qH = 0
    private var fmt = GLES30.GL_RGBA32F
    private val owned = ArrayList<() -> Unit>()
    private lateinit var prep: Fbo; private lateinit var boxH: Fbo; private lateinit var boxV: Fbo
    private lateinit var coefRaw: Fbo; private lateinit var coefH: Fbo; private lateinit var bprep: Fbo
    private lateinit var bprepTex: Tex
    private lateinit var bcocTex: Tex
    private val entries = ArrayList<Entry>()
    private var clock = 0L

    /** Compile the programs (GL thread). */
    fun init() {
        val ext = GLES30.glGetString(GLES30.GL_EXTENSIONS) ?: ""
        fmt = when {
            "GL_EXT_color_buffer_float" in ext -> GLES30.GL_RGBA32F
            "GL_EXT_color_buffer_half_float" in ext -> GLES30.GL_RGBA16F
            else -> 0
        }
        if (fmt == 0) { Log.w(TAG, "no float render targets: cinematic depth uses the plain mask"); return }
        try {
            progPrep = GlUtil.program(Shaders.VS, Shaders.DEPTH_PREP)
            progBox4 = GlUtil.program(Shaders.VS, Shaders.DEPTH_BOX4)
            progCoef = GlUtil.program(Shaders.VS, Shaders.DEPTH_COEF)
            progBox1 = GlUtil.program(Shaders.VS, Shaders.DEPTH_BOX1)
            progBPrep = GlUtil.program(Shaders.VS, Shaders.BOKEH_PREP)
            progBokeh = GlUtil.program(Shaders.VS, Shaders.BOKEH)
            available = true
        } catch (e: Exception) {
            Log.e(TAG, "depth shaders", e)
        }
    }

    /** (Re)size for a camera image of [imgW] x [imgH] (GL thread). */
    fun configure(imgW: Int, imgH: Int) {
        if (!available) return
        val s = 640f / maxOf(imgW, imgH)
        val nw = maxOf(8, Math.round(imgW * s)); val nh = maxOf(8, Math.round(imgH * s))
        if (nw == gW && nh == gH && qW == maxOf(1, imgW / 4)) return
        release()
        gW = nw; gH = nh; qW = maxOf(1, imgW / 4); qH = maxOf(1, imgH / 4)
        try {
            fun mrt(): Fbo { val t = List(4) { Tex(gW, gH, fmt, false) }; val f = Fbo(t); owned += { f.release(); t.forEach { it.release() } }; return f }
            prep = mrt(); boxH = mrt(); boxV = mrt()
            coefRaw = Fbo(listOf(Tex(gW, gH, fmt, false))).also { f -> owned += { f.release(); f.tex.forEach { it.release() } } }
            coefH = Fbo(listOf(Tex(gW, gH, fmt, false))).also { f -> owned += { f.release(); f.tex.forEach { it.release() } } }
            bprepTex = Tex(qW, qH, GLES30.GL_RGBA16F, true, mips = true)
            bcocTex = Tex(qW, qH, GLES30.GL_R16F, true, mips = true)
            bprep = Fbo(listOf(bprepTex, bcocTex)).also { f -> owned += { f.release(); bprepTex.release(); bcocTex.release() } }
            repeat(4) {
                val c = Tex(gW, gH, GLES30.GL_RGBA16F, true); val b = Tex(qW, qH, GLES30.GL_RGBA16F, true)
                entries += Entry(c, Fbo(listOf(c)), b, Fbo(listOf(b)))
            }
        } catch (e: Exception) {
            Log.e(TAG, "depth targets", e)
            release(); available = false
        }
    }

    fun release() {
        owned.forEach { it() }; owned.clear()
        entries.forEach { it.release() }; entries.clear()
        gW = 0; gH = 0
    }

    /** Clear the cache (new camera, new mask format). */
    fun invalidate() = entries.forEach { it.key = "" }

    /**
     * Results for the frame [key] (slot identity and timestamp + mask serial + params):
     * computed once, then served from the cache. [color]: the frame; [people]: coarse mask
     * texture with [imgToPeople]; [local]: 1/4-res blurred frame with mipmaps.
     */
    fun ensure(key: String, color: Int, people: Int, imgToPeople: FloatArray, imgW: Int, imgH: Int, local: Int, p: Params, dof: Dof): Result? {
        if (!available || entries.isEmpty()) return null
        clock++
        entries.firstOrNull { it.key == key }?.let { it.used = clock; return Result(it.coef.id, it.bokeh.id) }
        val e = entries.minByOrNull { it.used }!!
        // ---- guided filter
        prep.bind()
        GLES30.glUseProgram(progPrep)
        bindTex(0, color); GLES30.glUniform1i(loc(progPrep, "uColor"), 0)
        bindTex(1, people); GLES30.glUniform1i(loc(progPrep, "uPeople"), 1)
        GLES30.glUniformMatrix3fv(loc(progPrep, "uImgToPeople"), 1, false, imgToPeople, 0)
        GLES30.glUniform2f(loc(progPrep, "uImgSize"), imgW.toFloat(), imgH.toFloat())
        GLES30.glUniform2f(loc(progPrep, "uSize"), gW.toFloat(), gH.toFloat())
        val haveDepth = dof.depthTex != 0 && dof.imgToDepth != null
        bindTex(2, if (haveDepth) dof.depthTex else people); GLES30.glUniform1i(loc(progPrep, "uDepthMap"), 2)
        GLES30.glUniformMatrix3fv(loc(progPrep, "uImgToDepth"), 1, false, dof.imgToDepth ?: imgToPeople, 0)
        GLES30.glUniform1i(loc(progPrep, "uHaveDepth"), if (haveDepth) 1 else 0)
        GLES30.glUniform1f(loc(progPrep, "uFocus"), dof.focus)
        GLES30.glUniform1f(loc(progPrep, "uFocusHalf"), dof.half)
        GLES30.glUniform1f(loc(progPrep, "uFar"), dof.far)
        GLES30.glUniform1f(loc(progPrep, "uDof"), dof.dof)
        GLES30.glUniform1f(loc(progPrep, "uRange"), dof.range)
        draw()
        box4(prep, boxH, 1, 0)
        box4(boxH, boxV, 0, 1)
        coefRaw.bind()
        GLES30.glUseProgram(progCoef)
        for (i in 0 until 4) { bindTex(i, boxV.tex[i].id); GLES30.glUniform1i(loc(progCoef, "uT$i"), i) }
        GLES30.glUniform1f(loc(progCoef, "uEps"), EPS)
        draw()
        box1(coefRaw.tex[0].id, coefH, 1, 0)
        box1(coefH.tex[0].id, e.coefFbo, 0, 1)
        // ---- lens blur
        bprep.bind()
        GLES30.glUseProgram(progBPrep)
        bindTex(0, color); GLES30.glUniform1i(loc(progBPrep, "uColor"), 0)
        bindTex(1, e.coef.id); GLES30.glUniform1i(loc(progBPrep, "uCoef"), 1)
        bindTex(2, local); GLES30.glUniform1i(loc(progBPrep, "uLocal"), 2)
        GLES30.glUniform2f(loc(progBPrep, "uSize"), qW.toFloat(), qH.toFloat())
        GLES30.glUniform1f(loc(progBPrep, "uBloom"), p.bloom)
        draw()
        for (t in listOf(bprepTex, bcocTex)) { GLES30.glBindTexture(GLES30.GL_TEXTURE_2D, t.id); GLES30.glGenerateMipmap(GLES30.GL_TEXTURE_2D) }
        e.bokehFbo.bind()
        GLES30.glUseProgram(progBokeh)
        bindTex(0, bprepTex.id); GLES30.glUniform1i(loc(progBokeh, "uPrep"), 0)
        bindTex(1, bcocTex.id); GLES30.glUniform1i(loc(progBokeh, "uCoc"), 1)
        GLES30.glUniform2f(loc(progBokeh, "uSize"), qW.toFloat(), qH.toFloat())
        GLES30.glUniform1f(loc(progBokeh, "uRadius"), p.radius * minOf(qW, qH))
        GLES30.glUniform1i(loc(progBokeh, "uTaps"), p.taps)
        GLES30.glUniform1i(loc(progBokeh, "uShape"), p.shape)
        // Anamorphic ovals stand upright in the recorded frame.
        if (p.quarterTurn) { GLES30.glUniform2f(loc(progBokeh, "uAxisX"), 0f, 1f); GLES30.glUniform2f(loc(progBokeh, "uAxisY"), 1f, 0f) }
        else { GLES30.glUniform2f(loc(progBokeh, "uAxisX"), 1f, 0f); GLES30.glUniform2f(loc(progBokeh, "uAxisY"), 0f, 1f) }
        draw()
        e.key = key; e.used = clock
        return Result(e.coef.id, e.bokeh.id)
    }

    private fun box4(src: Fbo, dst: Fbo, dx: Int, dy: Int) {
        dst.bind()
        GLES30.glUseProgram(progBox4)
        for (i in 0 until 4) { bindTex(i, src.tex[i].id); GLES30.glUniform1i(loc(progBox4, "uT$i"), i) }
        GLES30.glUniform2i(loc(progBox4, "uDir"), dx, dy)
        GLES30.glUniform1i(loc(progBox4, "uR"), RADIUS)
        draw()
    }

    private fun box1(src: Int, dst: Fbo, dx: Int, dy: Int) {
        dst.bind()
        GLES30.glUseProgram(progBox1)
        bindTex(0, src); GLES30.glUniform1i(loc(progBox1, "uT0"), 0)
        GLES30.glUniform2i(loc(progBox1, "uDir"), dx, dy)
        GLES30.glUniform1i(loc(progBox1, "uR"), RADIUS)
        draw()
    }

    private fun draw() = GLES30.glDrawArrays(GLES30.GL_TRIANGLES, 0, 3)

    companion object {
        private const val TAG = "VeilDepth"
        const val RADIUS = 7 // guided filter window radius at the ~640 px guide resolution
        const val EPS = 0.0008f
    }
}
