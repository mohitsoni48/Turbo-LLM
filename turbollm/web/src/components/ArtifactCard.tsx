import { useState, useEffect, useRef } from 'react'
import { Download, Loader2, ChevronDown, Maximize2, Minimize2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '../lib/utils'
import { useUiStore, resolveDark } from '../stores/ui'

// Fenced-block language → artifact MIME type
const ARTIFACT_LANGS: Record<string, string> = {
  html: 'text/html',
  svg: 'image/svg+xml',
  mermaid: 'application/vnd.mermaid',
}

/** Returns the artifact MIME type if the language tag is renderable, otherwise null. */
export function isArtifactLang(lang: string): string | null {
  return ARTIFACT_LANGS[lang.toLowerCase()] ?? null
}

/** Build a sandboxed srcdoc that reports its NATURAL content size ({w,h}). The card
 *  scales the whole iframe to fit; injects a CSP (blocks external network) and
 *  (HTML only) self-rasterizers for PNG/JPEG and GIF export. */
function buildSrcdoc(type: string, code: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;">`
  const resizeHtml = `<script>(function(){function r(){var h=Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0);var w=Math.max(document.documentElement.scrollWidth,document.body?document.body.scrollWidth:0);parent.postMessage({type:'tllm-size',w:w,h:h},'*')}window.addEventListener('load',r);if(document.readyState!=='loading')r();try{new ResizeObserver(r).observe(document.documentElement)}catch(e){}})()</script>`
  const resizeSvg = `<script>(function(){function r(){var s=document.querySelector('svg');var b=s?s.getBoundingClientRect():null;var w=b?Math.ceil(b.width):Math.ceil(document.documentElement.scrollWidth);var h=b?Math.ceil(b.height):Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0);parent.postMessage({type:'tllm-size',w:w,h:h},'*')}window.addEventListener('load',r);if(document.readyState!=='loading')r();try{new ResizeObserver(r).observe(document.documentElement)}catch(e){}setTimeout(r,60)})()</script>`
  const norm = `<style>html,body{height:auto!important;min-height:0!important}img,svg,canvas,video{max-width:100%}</style>`
  const shot = `<script>window.addEventListener('message',function(e){if(!e.data||e.data.type!=='tllm-shot')return;try{var el=document.documentElement;var w=Math.max(el.scrollWidth,document.body?document.body.scrollWidth:0)||800;var h=Math.max(el.scrollHeight,document.body?document.body.scrollHeight:0)||600;var ser=new XMLSerializer().serializeToString(el);var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"><foreignObject width="100%" height="100%">'+ser+'</foreignObject></svg>';var img=new Image();img.onload=function(){try{var c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(img,0,0);parent.postMessage({type:'tllm-shot-result',png:c.toDataURL('image/png')},'*')}catch(err){parent.postMessage({type:'tllm-shot-result',png:null},'*')}};img.onerror=function(){parent.postMessage({type:'tllm-shot-result',png:null},'*')};img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg)}catch(err){parent.postMessage({type:'tllm-shot-result',png:null},'*')}})</script>`
  // Single still frame grabbed straight off a <canvas> (no taint, unlike foreignObject).
  const frame = `<script>window.addEventListener('message',function(e){if(!e.data||e.data.type!=='tllm-frame')return;var s=document.querySelector('canvas');if(!s){parent.postMessage({type:'tllm-frame-result',png:null},'*');return}try{parent.postMessage({type:'tllm-frame-result',png:s.toDataURL('image/png')},'*')}catch(err){parent.postMessage({type:'tllm-frame-result',png:null},'*')}})</script>`
  const gif = `<script>window.addEventListener('message',function(e){if(!e.data||e.data.type!=='tllm-gif')return;var s=document.querySelector('canvas');if(!s){parent.postMessage({type:'tllm-gif-result',frames:null},'*');return}var sw=s.width||s.clientWidth||300,sh=s.height||s.clientHeight||150;var sc=Math.min(1,480/Math.max(sw,sh));var w=Math.max(1,Math.round(sw*sc)),h=Math.max(1,Math.round(sh*sc));var t=document.createElement('canvas');t.width=w;t.height=h;var x=t.getContext('2d');var fr=[],n=0,m=24;var iv=setInterval(function(){try{x.clearRect(0,0,w,h);x.drawImage(s,0,0,w,h);fr.push(x.getImageData(0,0,w,h).data.buffer.slice(0))}catch(err){}if(++n>=m){clearInterval(iv);try{parent.postMessage({type:'tllm-gif-result',w:w,h:h,frames:fr},'*',fr)}catch(err){parent.postMessage({type:'tllm-gif-result',frames:null},'*')}}},70)})</script>`

  if (type === 'text/html') {
    const head = `${csp}\n${resizeHtml}\n${norm}\n${shot}\n${frame}\n${gif}`
    if (/<head[\s>]/i.test(code)) return code.replace(/(<head[^>]*>)/i, `$1\n${head}`)
    return `<!doctype html><html><head>${head}</head><body>${code}</body></html>`
  }
  if (type === 'image/svg+xml') {
    return `<!doctype html><html><head>${csp}${resizeSvg}<style>html,body{height:auto;margin:0}body{display:flex;justify-content:flex-start;align-items:flex-start;background:transparent}svg{max-width:100%;height:auto}</style></head><body>${code}</body></html>`
  }
  return ''
}

/** Render an iframe scaled by `scale` and sized to the result, so the card hugs
 *  the content. Renders full-width to measure first; DOM shape is identical in
 *  both states (no reload). */
function FittedIframe({
  srcDoc, frameRef, naturalW, naturalH, scale, cap, ready,
}: {
  srcDoc: string
  frameRef: React.RefObject<HTMLIFrameElement | null>
  naturalW: number
  naturalH: number
  scale: number
  cap: number
  ready: boolean
}) {
  const boxW = ready ? Math.round(naturalW * scale) : undefined
  const boxH = ready ? Math.round(naturalH * scale) : Math.min(naturalH, cap)
  return (
    <div className={ready ? '' : 'w-full'} style={{ width: boxW, height: boxH, overflow: 'hidden' }}>
      <iframe
        ref={frameRef}
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        title="Artifact"
        className={cn('block border-0', ready ? '' : 'w-full')}
        style={ready
          ? { width: naturalW, height: naturalH, transform: scale !== 1 ? `scale(${scale})` : undefined, transformOrigin: 'top left' }
          : { height: naturalH }}
      />
    </div>
  )
}

// ── Image / animation export helpers ────────────────────────────────────────────

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  URL.revokeObjectURL(url)
}

/** Rasterize a self-contained SVG string to PNG or JPEG (2× for crispness). JPEG
 *  has no alpha, so a white background is painted first. */
function svgToRaster(svg: string, mime: 'image/png' | 'image/jpeg', scale = 2): Promise<Blob | null> {
  return new Promise((resolve) => {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      let w = img.naturalWidth, h = img.naturalHeight
      if (!w || !h) {
        const m = /viewBox="([^"]+)"/.exec(svg)
        const p = m ? m[1].trim().split(/\s+/).map(Number) : []
        if (p.length === 4) { w = p[2]; h = p[3] } else { w = 800; h = 600 }
      }
      const canvas = document.createElement('canvas')
      const effectiveScale = Math.max(scale, 2048 / Math.min(w, h))
      canvas.width = Math.max(1, Math.round(w * effectiveScale))
      canvas.height = Math.max(1, Math.round(h * effectiveScale))
      const ctx = canvas.getContext('2d')
      if (!ctx) { URL.revokeObjectURL(url); return resolve(null) }
      if (mime === 'image/jpeg') {
        ctx.fillStyle = '#ffffff'
      } else {
        // PNG: fill with the app's background so the export matches the current theme.
        ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#ffffff'
      }
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.scale(effectiveScale, effectiveScale); ctx.drawImage(img, 0, 0, w, h)
      URL.revokeObjectURL(url)
      try { canvas.toBlob((b) => resolve(b), mime, 0.95) } catch { resolve(null) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    img.src = url
  })
}

/** Re-encode a (PNG) blob as JPEG on a white background. */
function blobToJpeg(blob: Blob): Promise<Blob | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const c = document.createElement('canvas')
      c.width = img.naturalWidth || 800; c.height = img.naturalHeight || 600
      const ctx = c.getContext('2d')
      if (!ctx) { URL.revokeObjectURL(url); return resolve(null) }
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height); ctx.drawImage(img, 0, 0)
      URL.revokeObjectURL(url)
      try { c.toBlob((b) => resolve(b), 'image/jpeg', 0.95) } catch { resolve(null) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    img.src = url
  })
}

/** Ask the sandboxed HTML iframe to rasterize itself to a PNG blob (best-effort). */
function htmlIframeToPng(iframe: HTMLIFrameElement | null): Promise<Blob | null> {
  return new Promise((resolve) => {
    const win = iframe?.contentWindow
    if (!win) return resolve(null)
    const onMsg = (e: MessageEvent) => {
      if (e.source !== win) return
      if (typeof e.data !== 'object' || e.data?.type !== 'tllm-shot-result') return
      window.removeEventListener('message', onMsg)
      if (e.data.png && typeof e.data.png === 'string' && e.data.png.startsWith('data:')) fetch(e.data.png).then((r) => r.blob()).then(resolve).catch(() => resolve(null))
      else resolve(null)
    }
    window.addEventListener('message', onMsg)
    win.postMessage({ type: 'tllm-shot' }, '*')
    setTimeout(() => { window.removeEventListener('message', onMsg); resolve(null) }, 4000)
  })
}

/** Grab a single still frame from the iframe's <canvas> as a PNG blob (reliable for
 *  canvas content, where foreignObject rasterization would taint the canvas). */
function htmlIframeFrame(iframe: HTMLIFrameElement | null): Promise<Blob | null> {
  return new Promise((resolve) => {
    const win = iframe?.contentWindow
    if (!win) return resolve(null)
    const onMsg = (e: MessageEvent) => {
      if (e.source !== win) return
      if (typeof e.data !== 'object' || e.data?.type !== 'tllm-frame-result') return
      window.removeEventListener('message', onMsg)
      if (e.data.png && typeof e.data.png === 'string' && e.data.png.startsWith('data:')) fetch(e.data.png).then((r) => r.blob()).then(resolve).catch(() => resolve(null))
      else resolve(null)
    }
    window.addEventListener('message', onMsg)
    win.postMessage({ type: 'tllm-frame' }, '*')
    setTimeout(() => { window.removeEventListener('message', onMsg); resolve(null) }, 3000)
  })
}

/** Capture a <canvas> animation from the iframe and encode it to an animated GIF. */
function captureGif(iframe: HTMLIFrameElement | null): Promise<Blob | null> {
  return new Promise((resolve) => {
    const win = iframe?.contentWindow
    if (!win) return resolve(null)
    const onMsg = async (e: MessageEvent) => {
      if (e.source !== win) return
      if (typeof e.data !== 'object' || e.data?.type !== 'tllm-gif-result') return
      window.removeEventListener('message', onMsg)
      const { w, h, frames } = e.data as { w?: number; h?: number; frames?: ArrayBuffer[] | null }
      if (!frames || !frames.length || !w || !h) return resolve(null)
      try {
        const { GIFEncoder, quantize, applyPalette } = await import('gifenc')
        const enc = GIFEncoder()
        for (const buf of frames) {
          const data = new Uint8Array(buf)
          const palette = quantize(data, 256)
          const index = applyPalette(data, palette)
          enc.writeFrame(index, w, h, { palette, delay: 70 })
        }
        enc.finish()
        resolve(new Blob([new Uint8Array(enc.bytes())], { type: 'image/gif' }))
      } catch { resolve(null) }
    }
    window.addEventListener('message', onMsg)
    win.postMessage({ type: 'tllm-gif' }, '*')
    setTimeout(() => { window.removeEventListener('message', onMsg); resolve(null) }, 10000)
  })
}

/** Rasterize an SVG string to a PNG data URL (2048px minimum on shortest side).
 *  Returns null on failure. */
function svgToPreview(svg: string): Promise<string | null> {
  return new Promise((resolve) => {
    const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      let w = img.naturalWidth, h = img.naturalHeight
      if (!w || !h) {
        const m = /viewBox="([^"]+)"/.exec(svg)
        const p = m ? m[1].trim().split(/\s+/).map(Number) : []
        if (p.length === 4) { w = p[2]; h = p[3] } else { w = 800; h = 600 }
      }
      const scale = Math.max(2, 2048 / Math.min(w, h))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(w * scale))
      canvas.height = Math.max(1, Math.round(h * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) { URL.revokeObjectURL(url); return resolve(null) }
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.scale(scale, scale); ctx.drawImage(img, 0, 0, w, h)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    img.src = url
  })
}

/** Capture an HTML iframe to a PNG data URL (2048px min). Waits 300 ms for paint
 *  to settle, tries canvas-grab first, falls back to foreignObject screenshot. */
async function captureHtmlPreview(iframe: HTMLIFrameElement | null): Promise<string | null> {
  await new Promise((r) => setTimeout(r, 300))
  const blob = (await htmlIframeFrame(iframe)) ?? (await htmlIframeToPng(iframe))
  if (!blob) return null
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const w = img.naturalWidth || 800, h = img.naturalHeight || 600
      const scale = Math.max(1, 2048 / Math.min(w, h))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale)
      const ctx = canvas.getContext('2d')
      if (!ctx) { URL.revokeObjectURL(url); return resolve(null) }
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/png'))
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    img.src = url
  })
}

/** Post the preview to the vision model for quality verification.
 *  Returns true if OK or if the model doesn't support vision. */
async function verifyWithVision(dataUrl: string): Promise<boolean> {
  try {
    const res = await fetch('/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: 'Does this diagram or UI render correctly with no visual errors or garbled content? Reply only "ok" or briefly describe any issue.' },
        ]}],
        max_tokens: 30,
        stream: false,
      }),
    })
    if (!res.ok) return true
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
    const text = (data.choices?.[0]?.message?.content ?? 'ok').toLowerCase().trim()
    return text.startsWith('ok') || text.length <= 2
  } catch {
    return true
  }
}

const DEFAULT_H = 200
const MIN_CARD_W = 300
const SETTLE_MS = 350

/** Cap the preview to ~60% of the visible screen height. */
function screenCap(): number {
  const v = typeof window !== 'undefined' ? window.innerHeight : 800
  return Math.max(200, Math.round((v * 0.6) / 10) * 10)
}

type Fmt = 'png' | 'jpeg' | 'svg' | 'gif' | 'html'
const FMT_LABEL: Record<Fmt, string> = { png: 'PNG', jpeg: 'JPEG', svg: 'SVG', gif: 'GIF', html: 'HTML' }

interface ArtifactCardProps {
  lang: string
  code: string
}

/** Renders a code artifact (HTML / SVG / Mermaid) as an IMAGE. The underlying type
 *  is intentionally hidden — no language tag, no code view — so it reads as a
 *  rendered result with applicable image-format downloads. */
export function ArtifactCard({ lang, code }: ArtifactCardProps) {
  const type = ARTIFACT_LANGS[lang.toLowerCase()] ?? 'text/html'
  const theme = useUiStore((s) => s.theme)
  // 'height' = fit within 60vh (card hugs content). 'width' = full column width.
  const [fitMode, setFitMode] = useState<'height' | 'width'>('height')
  const [naturalH, setNaturalH] = useState(DEFAULT_H)
  const [naturalW, setNaturalW] = useState(0)
  const [availW, setAvailW] = useState(0)
  const [maxH, setMaxH] = useState(screenCap)
  const [mermaid, setMermaid] = useState<{ svg?: string; error?: string; loading?: boolean }>({})
  const [menuOpen, setMenuOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [interactive, setInteractive] = useState(false)

  // Debounced code (handles any re-render churn; equals code once settled).
  const [stableCode, setStableCode] = useState(code)
  useEffect(() => {
    const t = setTimeout(() => setStableCode(code), SETTLE_MS)
    return () => clearTimeout(t)
  }, [code])

  useEffect(() => {
    const onResize = () => setMaxH((prev) => { const n = screenCap(); return n === prev ? prev : n })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setAvailW(el.clientWidth)
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // The iframe reports its NATURAL content size (scoped to THIS card). Threshold
  // updates so animated artifacts don't jitter the card.
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.source !== iframeRef.current?.contentWindow) return
      if (typeof e.data !== 'object' || e.data?.type !== 'tllm-size') return
      const w = Number(e.data.w), h = Number(e.data.h)
      if (!isNaN(h) && h > 0) { const nh = Math.min(Math.ceil(h) + 2, 15000); setNaturalH((p) => Math.abs(nh - p) > 4 ? nh : p) }
      if (!isNaN(w) && w > 0) { const nw = Math.min(Math.ceil(w), 15000); setNaturalW((p) => Math.abs(nw - p) > 4 ? nw : p) }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // Render mermaid; re-renders on app-theme change.
  useEffect(() => {
    if (type !== 'application/vnd.mermaid') return
    let cancelled = false
    void (async () => {
      setMermaid({ loading: true })
      try {
        const m = (await import('mermaid')).default
        // htmlLabels:false renders labels as native SVG <text> instead of <foreignObject>.
        // foreignObject taints the canvas when the SVG is rasterized via <img> for PNG/JPEG
        // export (Chrome SecurityError), so image downloads of mermaid artifacts fail. Native
        // <text> rasterizes cleanly. securityLevel:'strict' is the default — set explicitly.
        m.initialize({
          startOnLoad: false,
          theme: resolveDark(theme) ? 'dark' : 'default',
          suppressErrorRendering: true,
          securityLevel: 'strict',
          htmlLabels: false,
          flowchart: { htmlLabels: false },
        })
        await m.parse(stableCode)
        if (cancelled) return
        const id = `mmd${Math.random().toString(36).slice(2, 8)}`
        const { svg } = await m.render(id, stableCode)
        if (!cancelled) setMermaid({ svg })
      } catch (e) {
        if (!cancelled) setMermaid({ error: (e as Error).message })
      }
    })()
    return () => { cancelled = true }
  }, [type, stableCode, theme])

  // Computed here (before capture effects) so the effects can reference it safely.
  const fitReady = naturalW > 0 && availW > 0

  // Clear static preview whenever content or theme changes.
  useEffect(() => {
    setPreviewUrl(null)
    setInteractive(false)
  }, [stableCode, theme])

  // Capture Mermaid SVG → static preview image once the SVG is rendered.
  useEffect(() => {
    if (type !== 'application/vnd.mermaid' || !mermaid.svg) return
    let cancelled = false
    const svg = mermaid.svg
    void svgToPreview(svg).then((url) => {
      if (cancelled || !url) return
      setPreviewUrl(url)
      void verifyWithVision(url).then((ok) => {
        if (!ok && !cancelled) void svgToPreview(svg).then((u2) => { if (u2 && !cancelled) setPreviewUrl(u2) })
      })
    })
    return () => { cancelled = true }
  }, [type, mermaid.svg])

  // Capture SVG/HTML → static preview image once the iframe has sized itself.
  useEffect(() => {
    if (type === 'application/vnd.mermaid' || !fitReady) return
    let cancelled = false
    const doCapture = async () => {
      const url = type === 'image/svg+xml'
        ? await svgToPreview(stableCode)
        : await captureHtmlPreview(iframeRef.current)
      if (cancelled || !url) return
      setPreviewUrl(url)
      void verifyWithVision(url).then((ok) => {
        if (!ok && !cancelled) {
          const retry = type === 'image/svg+xml' ? svgToPreview(stableCode) : captureHtmlPreview(iframeRef.current)
          void retry.then((u2) => { if (u2 && !cancelled) setPreviewUrl(u2) })
        }
      })
    }
    void doCapture()
    return () => { cancelled = true }
  }, [type, fitReady, stableCode])

  useEffect(() => {
    if (!menuOpen) return
    const close = () => setMenuOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  const srcdoc = type !== 'application/vnd.mermaid' ? buildSrcdoc(type, stableCode) : ''
  const mermaidSrcdoc = mermaid.svg ? buildSrcdoc('image/svg+xml', mermaid.svg) : ''

  // Fit-height: scale to the 60vh cap, card hugs content. Fit-width: full column.
  const cap = maxH
  let scale = 1
  if (fitReady) {
    if (fitMode === 'width') {
      scale = availW / naturalW
    } else {
      const heightScale = naturalH > cap ? cap / naturalH : 1
      const wAfterH = naturalW * heightScale
      const widthScale = wAfterH > availW ? availW / wAfterH : 1
      scale = heightScale * widthScale
    }
  }
  const displayW = fitReady ? Math.round(naturalW * scale) : 0
  const cardWidth = fitReady && fitMode === 'height' ? `${displayW}px` : '100%'

  // Applicable image-format downloads — the underlying html/svg/mermaid is abstracted.
  const formats: Fmt[] = type === 'text/html' ? ['png', 'jpeg', 'gif', 'html'] : ['png', 'jpeg', 'svg']

  async function download(fmt: Fmt) {
    setMenuOpen(false)
    setBusy(true)
    try {
      if (fmt === 'svg') {
        const svg = type === 'application/vnd.mermaid' ? (mermaid.svg ?? '') : stableCode
        if (svg) downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), 'artifact.svg')
      } else if (fmt === 'html') {
        downloadBlob(new Blob([stableCode], { type: 'text/html' }), 'artifact.html')
      } else if (fmt === 'gif') {
        const blob = await captureGif(iframeRef.current)
        if (blob) downloadBlob(blob, 'artifact.gif')
        else {
          const png = await htmlIframeToPng(iframeRef.current)
          if (png) downloadBlob(png, 'artifact.png')
        }
      } else {
        // png | jpeg
        const mime = fmt === 'jpeg' ? 'image/jpeg' : 'image/png'
        let blob: Blob | null = null
        if (type === 'application/vnd.mermaid') blob = mermaid.svg ? await svgToRaster(mermaid.svg, mime) : null
        else if (type === 'image/svg+xml') blob = await svgToRaster(stableCode, mime)
        else {
          // Canvas grab is reliable; foreignObject is the fallback (taints on some browsers).
          const png = (await htmlIframeFrame(iframeRef.current)) ?? (await htmlIframeToPng(iframeRef.current))
          blob = png ? (fmt === 'jpeg' ? await blobToJpeg(png) : png) : null
        }
        if (blob) downloadBlob(blob, fmt === 'jpeg' ? 'artifact.jpg' : 'artifact.png')
        else toast.error('Couldn’t export this artifact as an image — try GIF or HTML.')
      }
    } finally {
      setBusy(false)
    }
  }

  // ── Body content ──────────────────────────────────────────────────────────────
  const showStatic = !!previewUrl && !interactive
  let body: React.ReactNode

  if (type === 'application/vnd.mermaid' && mermaid.error) {
    body = (
      <div className="flex items-center justify-center px-3 py-6 text-[12px] text-muted" style={{ minHeight: 100 }}>
        This artifact couldn&apos;t be rendered.
      </div>
    )
  } else if (type === 'application/vnd.mermaid' && (mermaid.loading || !mermaid.svg)) {
    body = (
      <div className="flex items-center justify-center" style={{ minHeight: 120 }}>
        <div className="flex items-center gap-2 text-faint">
          <Loader2 size={14} className="animate-spin" />
          <span className="text-[13px]">Rendering artifact…</span>
        </div>
      </div>
    )
  } else if (showStatic) {
    body = (
      <>
        <img
          src={previewUrl!}
          alt="Artifact"
          style={{ width: cardWidth, height: 'auto', display: 'block' }}
          className="min-w-0"
        />
        {/* HTML iframe stays alive (hidden) so GIF/canvas downloads still work. */}
        {type === 'text/html' && (
          <div style={{ height: 0, overflow: 'hidden' }} aria-hidden>
            <FittedIframe frameRef={iframeRef} srcDoc={srcdoc} naturalW={naturalW} naturalH={naturalH} scale={scale} cap={cap} ready={fitReady} />
          </div>
        )}
      </>
    )
  } else {
    const doc = type === 'application/vnd.mermaid' ? mermaidSrcdoc : srcdoc
    body = <FittedIframe frameRef={iframeRef} srcDoc={doc} naturalW={naturalW} naturalH={naturalH} scale={scale} cap={cap} ready={fitReady} />
  }

  return (
    // Outer container is full-width (measures availW); the card is left-aligned.
    <div ref={containerRef} className="my-2 flex justify-start">
      <div
        className="overflow-hidden rounded-lg border border-border"
        style={{ width: cardWidth, minWidth: 'min(100%, ' + MIN_CARD_W + 'px)' }}
      >
        {/* Header — no type tag, no code toggle; just view + download controls */}
        <div className="flex items-center justify-between border-b border-border bg-panel-2 px-3 py-1">
          <span className="text-[11px] text-faint">Artifact</span>
          <div className="flex items-center gap-0.5">
            {/* Interactive/Static toggle — HTML only, shown once preview is ready */}
            {type === 'text/html' && previewUrl && (
              <button
                type="button"
                onClick={() => setInteractive((v) => !v)}
                title={interactive ? 'Switch to static image' : 'Switch to interactive mode'}
                className="rounded px-1.5 py-0.5 text-[11px] text-faint transition-colors hover:text-ink"
              >
                {interactive ? 'Static' : 'Interactive'}
              </button>
            )}
            <button
              type="button"
              title={fitMode === 'height' ? 'Expand to full width' : 'Fit to screen height'}
              onClick={() => setFitMode((m) => (m === 'height' ? 'width' : 'height'))}
              className="rounded p-1 text-faint transition-colors hover:text-ink"
            >
              {fitMode === 'height' ? <Maximize2 size={12} /> : <Minimize2 size={12} />}
            </button>
            <div className="relative" onMouseDown={(e) => e.stopPropagation()}>
              <button
                type="button"
                title="Download"
                onClick={() => setMenuOpen((o) => !o)}
                className="flex items-center rounded p-1 text-faint transition-colors hover:text-ink"
              >
                {busy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                <ChevronDown size={9} className="ml-0.5" />
              </button>
              {menuOpen && (
                <div className="absolute right-0 z-10 mt-1 min-w-28 overflow-hidden rounded-md border border-border bg-panel shadow-lg">
                  {formats.map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => void download(f)}
                      className="block w-full px-3 py-1.5 text-left text-[12px] text-muted hover:bg-panel-2 hover:text-ink"
                    >
                      {FMT_LABEL[f]}
                      {f === 'gif' && <span className="ml-1 text-[10px] text-faint">animation</span>}
                      {f === 'html' && <span className="ml-1 text-[10px] text-faint">source</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Body */}
        {body}
      </div>
    </div>
  )
}
