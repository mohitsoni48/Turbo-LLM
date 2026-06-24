import { useState, useEffect, useRef } from 'react'
import { Code2, Eye, Download, Loader2, ChevronDown, Maximize2, Minimize2 } from 'lucide-react'
import { CopyButton } from './ui/copy-button'
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
 *  then scales the whole iframe to fit both the height cap and the column width, and
 *  sizes itself to the result (FittedIframe). Injects a CSP (blocks external network)
 *  and (HTML only) self-rasterizers for PNG and GIF export. */
function buildSrcdoc(type: string, code: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;">`
  // HTML: report the document's content box. `norm` forces height:auto so a `100vh`
  // artifact can't feed back against the auto-sizing iframe.
  const resizeHtml = `<script>(function(){function r(){var h=Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0);var w=Math.max(document.documentElement.scrollWidth,document.body?document.body.scrollWidth:0);parent.postMessage({type:'tllm-size',w:w,h:h},'*')}window.addEventListener('load',r);if(document.readyState!=='loading')r();try{new ResizeObserver(r).observe(document.documentElement)}catch(e){}})()</script>`
  // SVG/mermaid: measure the <svg> itself so the card fits the diagram, not the iframe.
  const resizeSvg = `<script>(function(){function r(){var s=document.querySelector('svg');var b=s?s.getBoundingClientRect():null;var w=b?Math.ceil(b.width):Math.ceil(document.documentElement.scrollWidth);var h=b?Math.ceil(b.height):Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0);parent.postMessage({type:'tllm-size',w:w,h:h},'*')}window.addEventListener('load',r);if(document.readyState!=='loading')r();try{new ResizeObserver(r).observe(document.documentElement)}catch(e){}setTimeout(r,60)})()</script>`
  const norm = `<style>html,body{height:auto!important;min-height:0!important}img,svg,canvas,video{max-width:100%}</style>`
  // Best-effort PNG export via foreignObject (may taint on some browsers → caught).
  const shot = `<script>window.addEventListener('message',function(e){if(!e.data||e.data.type!=='tllm-shot')return;try{var el=document.documentElement;var w=Math.max(el.scrollWidth,document.body?document.body.scrollWidth:0)||800;var h=Math.max(el.scrollHeight,document.body?document.body.scrollHeight:0)||600;var ser=new XMLSerializer().serializeToString(el);var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"><foreignObject width="100%" height="100%">'+ser+'</foreignObject></svg>';var img=new Image();img.onload=function(){try{var c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d').drawImage(img,0,0);parent.postMessage({type:'tllm-shot-result',png:c.toDataURL('image/png')},'*')}catch(err){parent.postMessage({type:'tllm-shot-result',png:null},'*')}};img.onerror=function(){parent.postMessage({type:'tllm-shot-result',png:null},'*')};img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg)}catch(err){parent.postMessage({type:'tllm-shot-result',png:null},'*')}})</script>`
  // GIF export: grab frames straight off a <canvas> (same-origin within the iframe).
  const gif = `<script>window.addEventListener('message',function(e){if(!e.data||e.data.type!=='tllm-gif')return;var s=document.querySelector('canvas');if(!s){parent.postMessage({type:'tllm-gif-result',frames:null},'*');return}var sw=s.width||s.clientWidth||300,sh=s.height||s.clientHeight||150;var sc=Math.min(1,480/Math.max(sw,sh));var w=Math.max(1,Math.round(sw*sc)),h=Math.max(1,Math.round(sh*sc));var t=document.createElement('canvas');t.width=w;t.height=h;var x=t.getContext('2d');var fr=[],n=0,m=24;var iv=setInterval(function(){try{x.clearRect(0,0,w,h);x.drawImage(s,0,0,w,h);fr.push(x.getImageData(0,0,w,h).data.buffer.slice(0))}catch(err){}if(++n>=m){clearInterval(iv);try{parent.postMessage({type:'tllm-gif-result',w:w,h:h,frames:fr},'*',fr)}catch(err){parent.postMessage({type:'tllm-gif-result',frames:null},'*')}}},70)})</script>`

  if (type === 'text/html') {
    const head = `${csp}\n${resizeHtml}\n${norm}\n${shot}\n${gif}`
    if (/<head[\s>]/i.test(code)) return code.replace(/(<head[^>]*>)/i, `$1\n${head}`)
    return `<!doctype html><html><head>${head}</head><body>${code}</body></html>`
  }
  if (type === 'image/svg+xml') {
    return `<!doctype html><html><head>${csp}${resizeSvg}<style>html,body{height:auto;margin:0}body{display:flex;justify-content:flex-start;align-items:flex-start;background:transparent}svg{max-width:100%;height:auto}</style></head><body>${code}</body></html>`
  }
  return ''
}

/** Render an iframe scaled by `scale` (preserving aspect) and sized to the scaled
 *  result, so the card hugs the content. Before the first size report it renders
 *  full-width to measure; the DOM shape is identical in both states (no reload). */
function FittedIframe({
  srcDoc, title, frameRef, naturalW, naturalH, scale, cap, ready,
}: {
  srcDoc: string
  title: string
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
        title={title}
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

/** Rasterize a self-contained SVG string to a PNG blob (2× for crispness). */
function svgToPng(svg: string, scale = 2): Promise<Blob | null> {
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
      canvas.width = Math.max(1, Math.round(w * scale))
      canvas.height = Math.max(1, Math.round(h * scale))
      const ctx = canvas.getContext('2d')
      if (!ctx) { URL.revokeObjectURL(url); return resolve(null) }
      ctx.scale(scale, scale); ctx.drawImage(img, 0, 0, w, h)
      URL.revokeObjectURL(url)
      try { canvas.toBlob((b) => resolve(b), 'image/png') } catch { resolve(null) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null) }
    img.src = url
  })
}

/** Ask the sandboxed HTML iframe to rasterize itself to PNG (best-effort). */
function htmlIframeToPng(iframe: HTMLIFrameElement | null): Promise<Blob | null> {
  return new Promise((resolve) => {
    const win = iframe?.contentWindow
    if (!win) return resolve(null)
    const onMsg = (e: MessageEvent) => {
      if (e.source !== win) return
      if (typeof e.data !== 'object' || e.data?.type !== 'tllm-shot-result') return
      window.removeEventListener('message', onMsg)
      if (e.data.png) fetch(e.data.png).then((r) => r.blob()).then(resolve).catch(() => resolve(null))
      else resolve(null)
    }
    window.addEventListener('message', onMsg)
    win.postMessage({ type: 'tllm-shot' }, '*')
    setTimeout(() => { window.removeEventListener('message', onMsg); resolve(null) }, 4000)
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

const DEFAULT_H = 200
const MIN_CARD_W = 300 // keep the header (Code/Preview + buttons) usable
// Debounce window: while a message streams, `code` grows every token. We only
// (re)render once it settles, so the iframe doesn't reload per token (no blink).
const SETTLE_MS = 350

/** Cap the preview to ~60% of the visible screen height. */
function screenCap(): number {
  const v = typeof window !== 'undefined' ? window.innerHeight : 800
  return Math.max(200, Math.round((v * 0.6) / 10) * 10)
}

interface ArtifactCardProps {
  lang: string
  code: string
}

export function ArtifactCard({ lang, code }: ArtifactCardProps) {
  const type = ARTIFACT_LANGS[lang.toLowerCase()] ?? 'text/html'
  const theme = useUiStore((s) => s.theme)
  const [mode, setMode] = useState<'code' | 'preview'>('preview')
  // 'height' = fit the whole artifact within 60vh (card hugs content). 'width' =
  // expand to the full column width (taller; the chat scrolls).
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

  // Debounced code → blink fix (render once the stream settles).
  const [stableCode, setStableCode] = useState(code)
  useEffect(() => {
    const t = setTimeout(() => setStableCode(code), SETTLE_MS)
    return () => clearTimeout(t)
  }, [code])
  const settling = code !== stableCode

  // Track the screen-height cap and the available column width.
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

  // The iframe reports its NATURAL content size; scoped to THIS card's iframe so
  // multiple artifacts don't cross-contaminate.
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.source !== iframeRef.current?.contentWindow) return
      if (typeof e.data !== 'object' || e.data?.type !== 'tllm-size') return
      // Threshold updates: animated artifacts fire ResizeObserver every frame with
      // sub-pixel deltas — without this the card jitters/resizes continuously.
      const w = Number(e.data.w), h = Number(e.data.h)
      if (!isNaN(h) && h > 0) { const nh = Math.min(Math.ceil(h) + 2, 15000); setNaturalH((p) => Math.abs(nh - p) > 4 ? nh : p) }
      if (!isNaN(w) && w > 0) { const nw = Math.min(Math.ceil(w), 15000); setNaturalW((p) => Math.abs(nw - p) > 4 ? nw : p) }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  const handlePreview = () => setMode('preview')

  // Render mermaid from the SETTLED code; re-renders on app-theme change.
  useEffect(() => {
    if (mode !== 'preview' || type !== 'application/vnd.mermaid') return
    let cancelled = false
    void (async () => {
      setMermaid({ loading: true })
      try {
        const m = (await import('mermaid')).default
        m.initialize({ startOnLoad: false, theme: resolveDark(theme) ? 'dark' : 'default', suppressErrorRendering: true })
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
  }, [mode, type, stableCode, theme])

  // Close the download menu on outside click.
  useEffect(() => {
    if (!menuOpen) return
    const close = () => setMenuOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuOpen])

  const srcdoc = type !== 'application/vnd.mermaid' ? buildSrcdoc(type, stableCode) : ''
  const mermaidSrcdoc = mermaid.svg ? buildSrcdoc('image/svg+xml', mermaid.svg) : ''

  // Fit-height: scale to the 60vh cap (and column width), card hugs content.
  // Fit-width: scale to the full column width, natural height (chat scrolls).
  const cap = maxH
  const fitReady = naturalW > 0 && availW > 0
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
  // Fit-height shrinks the card to the content; fit-width uses the full column.
  const cardWidth = mode === 'preview' && fitReady && fitMode === 'height' ? `${displayW}px` : '100%'

  // Images first; source as fallback. HTML can also export a GIF (canvas animations).
  const formats: Array<'gif' | 'png' | 'svg' | 'html'> =
    type === 'text/html' ? ['gif', 'png', 'html'] : ['png', 'svg']

  async function download(fmt: 'gif' | 'png' | 'svg' | 'html') {
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
          else downloadBlob(new Blob([stableCode], { type: 'text/html' }), 'artifact.html')
        }
      } else {
        let blob: Blob | null = null
        if (type === 'application/vnd.mermaid') blob = mermaid.svg ? await svgToPng(mermaid.svg) : null
        else if (type === 'image/svg+xml') blob = await svgToPng(stableCode)
        else blob = await htmlIframeToPng(iframeRef.current)
        if (blob) downloadBlob(blob, 'artifact.png')
        else if (type === 'text/html') downloadBlob(new Blob([stableCode], { type: 'text/html' }), 'artifact.html')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    // Outer container is full-width (measures availW); the card is left-aligned.
    <div ref={containerRef} className="my-2 flex justify-start">
      <div
        className="overflow-hidden rounded-lg border border-border"
        style={{ width: cardWidth, minWidth: 'min(100%, ' + MIN_CARD_W + 'px)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border bg-panel-2 px-3 py-1">
          <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted">
            {lang}
            {settling && mode === 'preview' && <Loader2 size={10} className="animate-spin text-faint" />}
          </span>
          <div className="flex items-center gap-0.5">
            {/* Code / Preview toggle */}
            <div className="mr-1 flex overflow-hidden rounded border border-border text-[11px]">
              <button
                type="button"
                onClick={() => setMode('code')}
                className={cn(
                  'flex items-center gap-1 px-2 py-0.5 transition-colors',
                  mode === 'code' ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink',
                )}
              >
                <Code2 size={10} />Code
              </button>
              <button
                type="button"
                onClick={handlePreview}
                className={cn(
                  'flex items-center gap-1 border-l border-border px-2 py-0.5 transition-colors',
                  mode === 'preview' ? 'bg-accent/15 text-accent' : 'text-muted hover:text-ink',
                )}
              >
                <Eye size={10} />Preview
              </button>
            </div>
            {mode === 'preview' && (
              <button
                type="button"
                title={fitMode === 'height' ? 'Expand to full width' : 'Fit to screen height'}
                onClick={() => setFitMode((m) => (m === 'height' ? 'width' : 'height'))}
                className="rounded p-1 text-faint transition-colors hover:text-ink"
              >
                {fitMode === 'height' ? <Maximize2 size={12} /> : <Minimize2 size={12} />}
              </button>
            )}
            <CopyButton text={code} size={12} />
            {/* Download as image / animation — source only as a fallback */}
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
                      {f.toUpperCase()}
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
        {mode === 'code' ? (
          <div className="overflow-x-auto overscroll-x-contain" onScroll={(e) => e.stopPropagation()}>
            <code className={`language-${lang} block p-3 font-mono text-[13px] leading-relaxed whitespace-pre`}>
              {code}
            </code>
          </div>
        ) : type === 'application/vnd.mermaid' ? (
          mermaid.error ? (
            <div className="p-3">
              <div className="mb-2 text-[12px]" style={{ color: 'var(--err)' }}>
                Diagram couldn&apos;t render: {mermaid.error}
              </div>
              <div className="overflow-x-auto overscroll-x-contain rounded bg-panel-2" onScroll={(e) => e.stopPropagation()}>
                <code className="block p-3 font-mono text-[12px] leading-relaxed whitespace-pre text-muted">{code}</code>
              </div>
            </div>
          ) : mermaid.loading || !mermaid.svg ? (
            <div className="flex items-center justify-center" style={{ minHeight: 120 }}>
              <div className="flex items-center gap-2 text-faint">
                <Loader2 size={14} className="animate-spin" />
                <span className="text-[13px]">{settling ? 'Generating…' : 'Rendering diagram…'}</span>
              </div>
            </div>
          ) : (
            <FittedIframe frameRef={iframeRef} srcDoc={mermaidSrcdoc} title="Mermaid diagram" naturalW={naturalW} naturalH={naturalH} scale={scale} cap={cap} ready={fitReady} />
          )
        ) : (
          <FittedIframe frameRef={iframeRef} srcDoc={srcdoc} title={`${lang} preview`} naturalW={naturalW} naturalH={naturalH} scale={scale} cap={cap} ready={fitReady} />
        )}
      </div>
    </div>
  )
}
