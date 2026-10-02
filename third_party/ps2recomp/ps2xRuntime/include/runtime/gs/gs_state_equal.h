#pragma once
// GS state compared by value. The register structs carry padding (GSFrameReg is 16 bytes for 4 fields) that a
// value-initialised struct with default member initialisers does not zero, so a memcmp of two equal states can
// differ: in 2026-10-02's mission session 86.8 % of the GL draw batches ended on padding alone
// (gs_gl_flush_reasons.h, kPadding). Compare these structs with eq(), never with memcmp or a byte hash.
#include "runtime/gs/gs_types.h"

namespace GsStateEqual
{
    inline bool eq(const GSFrameReg &a, const GSFrameReg &b)
    { return a.fbp == b.fbp && a.fbw == b.fbw && a.psm == b.psm && a.fbmsk == b.fbmsk; }
    inline bool eq(const GSScissorReg &a, const GSScissorReg &b)
    { return a.x0 == b.x0 && a.x1 == b.x1 && a.y0 == b.y0 && a.y1 == b.y1; }
    inline bool eq(const GSTex0Reg &a, const GSTex0Reg &b)
    {
        return a.tbp0 == b.tbp0 && a.tbw == b.tbw && a.psm == b.psm && a.tw == b.tw && a.th == b.th &&
               a.tcc == b.tcc && a.tfx == b.tfx && a.cbp == b.cbp && a.cpsm == b.cpsm && a.csm == b.csm &&
               a.csa == b.csa && a.cld == b.cld;
    }
    inline bool eq(const GSXYOffsetReg &a, const GSXYOffsetReg &b) { return a.ofx == b.ofx && a.ofy == b.ofy; }
    inline bool eq(const GSZbufReg &a, const GSZbufReg &b)
    { return a.zbp == b.zbp && a.psm == b.psm && a.zmask == b.zmask; }
    inline bool eq(const GSPrimReg &a, const GSPrimReg &b)
    {
        return a.type == b.type && a.iip == b.iip && a.tme == b.tme && a.fge == b.fge && a.abe == b.abe &&
               a.aa1 == b.aa1 && a.fst == b.fst && a.ctxt == b.ctxt && a.fix == b.fix;
    }
    inline bool eq(const GSTexaReg &a, const GSTexaReg &b) { return a.ta0 == b.ta0 && a.aem == b.aem && a.ta1 == b.ta1; }
    inline bool eq(const GSTexClutReg &a, const GSTexClutReg &b)
    { return a.cbw == b.cbw && a.cou == b.cou && a.cov == b.cov; }
    inline bool eq(const GSContext &a, const GSContext &b)
    {
        return eq(a.frame, b.frame) && eq(a.scissor, b.scissor) && eq(a.tex0, b.tex0) && eq(a.xyoffset, b.xyoffset) &&
               eq(a.zbuf, b.zbuf) && a.tex1 == b.tex1 && a.miptbp1 == b.miptbp1 && a.miptbp2 == b.miptbp2 &&
               a.clamp == b.clamp && a.alpha == b.alpha && a.test == b.test && a.fba == b.fba && a.clutId == b.clutId;
    }
    inline bool eq(const GSDrawState &a, const GSDrawState &b)
    {
        return eq(a.context, b.context) && eq(a.prim, b.prim) && eq(a.texa, b.texa) && eq(a.texclut, b.texclut) &&
               a.pabe == b.pabe && a.scanmsk == b.scanmsk && a.dimx == b.dimx && a.dthe == b.dthe &&
               a.colclamp == b.colclamp && a.fogR == b.fogR && a.fogG == b.fogG && a.fogB == b.fogB &&
               a.textureWidth == b.textureWidth && a.textureHeight == b.textureHeight &&
               a.linearFilter == b.linearFilter;
    }
}
