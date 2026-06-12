// System info detection (spec 05 §6): GPU(s), CPU, RAM. Cached for the process
// lifetime. Used for VRAM-fit estimation, the settings UI, and engine-backend
// selection (ADR-025: vendor → fastest backend).
import { execFileSync } from 'node:child_process'
import os from 'node:os'

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'unknown'

export interface GpuInfo {
  name: string
  vramMb: number
  vendor: GpuVendor
}
export interface SysInfo {
  os: string
  cpu: string
  cores: number
  ramMB: number
  gpus: GpuInfo[]
}

let cached: SysInfo | null = null

export function getSysInfo(): SysInfo {
  if (cached) return cached
  cached = {
    os: `${process.platform}/${process.arch}`,
    cpu: os.cpus()[0]?.model?.trim() ?? '',
    cores: os.cpus().length || 1,
    ramMB: Math.round(os.totalmem() / 1e6),
    gpus: detectGpus(),
  }
  return cached
}

/** The vendor that drives backend selection: first discrete GPU, else unknown. */
export function primaryVendor(info: SysInfo = getSysInfo()): GpuVendor {
  // Prefer a discrete accelerator over an integrated one (Intel iGPU alongside
  // an NVIDIA/AMD dGPU is common): rank nvidia/amd/apple above intel.
  const rank: Record<GpuVendor, number> = { nvidia: 4, amd: 3, apple: 3, intel: 2, unknown: 1 }
  let best: GpuVendor = 'unknown'
  for (const g of info.gpus) if (rank[g.vendor] > rank[best]) best = g.vendor
  return best
}

export function classifyVendor(name: string): GpuVendor {
  const n = name.toLowerCase()
  if (/nvidia|geforce|rtx|gtx|quadro|tesla/.test(n)) return 'nvidia'
  if (/amd|radeon|\brx\b|instinct|vega|firepro/.test(n)) return 'amd'
  if (/intel|arc|iris|\buhd\b|\bhd graphics\b/.test(n)) return 'intel'
  if (/apple/.test(n)) return 'apple'
  return 'unknown'
}

function detectGpus(): GpuInfo[] {
  // 1) NVIDIA (Windows/Linux): nvidia-smi gives exact name + VRAM.
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], {
      timeout: 8000,
      windowsHide: true,
    }).toString()
    const gpus = out
      .trim()
      .split('\n')
      .map((line) => {
        const [name, mb] = line.split(',')
        return { name: (name ?? '').trim(), vramMb: parseInt((mb ?? '').trim(), 10) || 0, vendor: 'nvidia' as const }
      })
      .filter((g) => g.vramMb > 0)
    if (gpus.length) return gpus
  } catch {
    /* no nvidia-smi */
  }

  // 2) Apple Silicon: treat 65% of unified memory as the VRAM budget (spec 05 §6).
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('system_profiler', ['SPDisplaysDataType'], { timeout: 8000 }).toString()
      const m = out.match(/Chipset Model:\s*(.+)/)
      if (m && /Apple/.test(out)) {
        return [{ name: m[1].trim(), vramMb: Math.round((os.totalmem() / 1e6) * 0.65), vendor: 'apple' }]
      }
    } catch {
      /* ignore */
    }
  }

  // 3) AMD / Intel (and NVIDIA without nvidia-smi): enumerate adapters by name.
  //    VRAM is best-effort here; vendor is what backend selection needs.
  try {
    const gpus = process.platform === 'win32' ? enumWindowsGpus() : enumLinuxGpus()
    if (gpus.length) return gpus
  } catch {
    /* ignore */
  }

  return [] // CPU-only mode
}

function enumWindowsGpus(): GpuInfo[] {
  // Win32_VideoController: Name + AdapterRAM (AdapterRAM caps at 4GB for larger
  // cards and is unreliable — used only as a weak hint).
  const ps =
    'Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name)|$($_.AdapterRAM)" }'
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    timeout: 8000,
    windowsHide: true,
  }).toString()
  return out
    .trim()
    .split('\n')
    .map((line) => {
      const [name, ram] = line.split('|')
      const nm = (name ?? '').trim()
      const bytes = parseInt((ram ?? '').trim(), 10) || 0
      return { name: nm, vramMb: bytes > 0 ? Math.round(bytes / 1e6) : 0, vendor: classifyVendor(nm) }
    })
    .filter((g) => g.name && g.vendor !== 'unknown')
}

function enumLinuxGpus(): GpuInfo[] {
  // lspci lists display controllers; we only need the vendor from the description.
  const out = execFileSync('sh', ['-c', "lspci -mm 2>/dev/null | grep -iE 'VGA|3D|Display'"], {
    timeout: 8000,
  }).toString()
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const vendor = classifyVendor(line)
      return { name: line.replace(/"/g, '').trim().slice(0, 80), vramMb: 0, vendor }
    })
    .filter((g) => g.vendor !== 'unknown')
}
