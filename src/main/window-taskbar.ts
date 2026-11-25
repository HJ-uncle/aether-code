import { app, type BrowserWindow, nativeImage, screen } from 'electron'
import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import { createCanvas } from '@napi-rs/canvas'
import { normalizeTaskbarBadgeCount, taskbarBadgeText } from '../shared/taskbar'

const BADGE_SIZE = 16
const BADGE_BACKGROUND = '#1b1b20'
const BADGE_FOREGROUND = '#ffffff'
const pendingWindowsBadges = new WeakMap<BrowserWindow, number>()

export function updateTaskbarCompletionBadge(window: BrowserWindow, value: number): void {
  const count = normalizeTaskbarBadgeCount(value)
  if (process.platform === 'win32') {
    setWindowsBadge(window, count)
    return
  }
  if (process.platform === 'darwin') {
    app.dock?.setBadge(count > 0 ? taskbarBadgeText(count) : '')
    return
  }
  if (process.platform === 'linux') {
    app.setBadgeCount(count)
  }
}

function setWindowsBadge(window: BrowserWindow, count: number): void {
  if (window.isDestroyed()) return
  if (pendingWindowsBadges.has(window)) {
    pendingWindowsBadges.set(window, count)
    return
  }
  if (!count) {
    window.setOverlayIcon(null, '')
    return
  }

  const label = taskbarBadgeText(count)
  const description = `${label} 个已完成会话待查看`
  const scale = screen.getPrimaryDisplay().scaleFactor
  const png = createBadgePng(label, Math.round(BADGE_SIZE * scale))
  const handle = window.getNativeWindowHandle()
  const hwnd = handle.length === 8 ? handle.readBigInt64LE() : handle.readInt32LE()
  const powershell = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const command = `& { ${WINDOWS_OVERLAY_SCRIPT} } ${hwnd} ${process.pid} '${png.toString('base64')}' '${description}'`
  const encoded = Buffer.from(command, 'utf16le').toString('base64')

  // The Electron overlay API downsamples to 16×16 before the taskbar gets the image.
  pendingWindowsBadges.set(window, count)
  execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 10000 }, error => {
    const latest = pendingWindowsBadges.get(window) ?? count
    pendingWindowsBadges.delete(window)
    if (window.isDestroyed()) return
    if (latest !== count) {
      setWindowsBadge(window, latest)
    } else if (error) {
      console.warn('[taskbar] Direct Windows overlay failed; using Electron overlay:', error.code ?? error.name)
      window.setOverlayIcon(nativeImage.createFromBuffer(png), description)
    }
  })
}

function createBadgePng(label: string, size: number): Buffer {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  const center = size / 2
  ctx.fillStyle = BADGE_BACKGROUND
  ctx.beginPath()
  ctx.arc(center, center, center, 0, Math.PI * 2)
  ctx.fill()

  const fontSize = label.length === 1 ? 13 : label.length === 2 ? 11 : 9
  ctx.fillStyle = BADGE_FOREGROUND
  ctx.font = `500 ${fontSize * size / BADGE_SIZE}px "Segoe UI"`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(label, center, center + size * 0.08)

  return canvas.toBuffer('image/png')
}

const WINDOWS_OVERLAY_SCRIPT = String.raw`
param([long] $Window, [uint32] $Owner, [string] $Png, [string] $Description)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies 'System.Drawing.dll' -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AetherTaskbarOverlay {
  [ComImport, Guid("EA1AFB91-9E28-4B86-90E9-9E9F8A5EEFAF"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  private interface ITaskbarList3 {
    [PreserveSig] int HrInit();
    [PreserveSig] int AddTab(IntPtr hwnd);
    [PreserveSig] int DeleteTab(IntPtr hwnd);
    [PreserveSig] int ActivateTab(IntPtr hwnd);
    [PreserveSig] int SetActiveAlt(IntPtr hwnd);
    [PreserveSig] int MarkFullscreenWindow(IntPtr hwnd, int fullscreen);
    [PreserveSig] int SetProgressValue(IntPtr hwnd, ulong completed, ulong total);
    [PreserveSig] int SetProgressState(IntPtr hwnd, int state);
    [PreserveSig] int RegisterTab(IntPtr tab, IntPtr mdi);
    [PreserveSig] int UnregisterTab(IntPtr tab);
    [PreserveSig] int SetTabOrder(IntPtr tab, IntPtr insertBefore);
    [PreserveSig] int SetTabActive(IntPtr tab, IntPtr mdi, uint reserved);
    [PreserveSig] int ThumbBarAddButtons(IntPtr hwnd, uint count, IntPtr buttons);
    [PreserveSig] int ThumbBarUpdateButtons(IntPtr hwnd, uint count, IntPtr buttons);
    [PreserveSig] int ThumbBarSetImageList(IntPtr hwnd, IntPtr images);
    [PreserveSig] int SetOverlayIcon(IntPtr hwnd, IntPtr icon, [MarshalAs(UnmanagedType.LPWStr)] string description);
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct BitmapHeader {
    public uint size;
    public int width, height;
    public ushort planes, depth;
    public uint compression, imageSize;
    public int xResolution, yResolution;
    public uint colors, importantColors;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct IconInfo {
    public int icon;
    public uint xHotspot, yHotspot;
    public IntPtr mask, color;
  }

  [DllImport("gdi32.dll")]
  private static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapHeader header, uint usage, out IntPtr bits, IntPtr section, uint offset);

  [DllImport("gdi32.dll")]
  private static extern IntPtr CreateBitmap(int width, int height, uint planes, uint depth, byte[] bits);

  [DllImport("gdi32.dll")]
  private static extern bool DeleteObject(IntPtr bitmap);

  [DllImport("user32.dll")]
  private static extern IntPtr CreateIconIndirect(ref IconInfo info);

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

  [DllImport("user32.dll")]
  public static extern bool DestroyIcon(IntPtr icon);

  public static IntPtr CreateOverlayIcon(System.Drawing.Bitmap bitmap) {
    int width = bitmap.Width, height = bitmap.Height;
    int maskStride = ((width + 15) / 16) * 2;
    var colors = new byte[width * height * 4];
    var mask = new byte[maskStride * height];
    for (int y = 0; y < height; y++) {
      for (int x = 0; x < width; x++) {
        var pixel = bitmap.GetPixel(x, y);
        if (pixel.A == 0) {
          mask[y * maskStride + x / 8] |= (byte)(128 >> (x % 8));
          continue;
        }
        int index = (y * width + x) * 4;
        // Explorer's overlay compositing darkens already-premultiplied edges.
        colors[index] = pixel.B;
        colors[index + 1] = pixel.G;
        colors[index + 2] = pixel.R;
        colors[index + 3] = pixel.A;
      }
    }

    var header = new BitmapHeader { size = 40, width = width, height = -height, planes = 1, depth = 32 };
    var info = new IconInfo { icon = 1 };
    try {
      IntPtr bits;
      info.color = CreateDIBSection(IntPtr.Zero, ref header, 0, out bits, IntPtr.Zero, 0);
      if (info.color == IntPtr.Zero || bits == IntPtr.Zero) throw new InvalidOperationException("Cannot allocate overlay colors.");
      Marshal.Copy(colors, 0, bits, colors.Length);
      info.mask = CreateBitmap(width, height, 1, 1, mask);
      if (info.mask == IntPtr.Zero) throw new InvalidOperationException("Cannot allocate overlay mask.");
      IntPtr icon = CreateIconIndirect(ref info);
      if (icon == IntPtr.Zero) throw new InvalidOperationException("Cannot create overlay icon.");
      return icon;
    } finally {
      if (info.mask != IntPtr.Zero) DeleteObject(info.mask);
      if (info.color != IntPtr.Zero) DeleteObject(info.color);
    }
  }

  public static void SetIcon(long window, uint owner, IntPtr icon, string description) {
    var hwnd = new IntPtr(window);
    uint processId;
    if (GetWindowThreadProcessId(hwnd, out processId) == 0 || processId != owner) return;

    var type = Type.GetTypeFromCLSID(new Guid("56FDF344-FD6D-11D0-958A-006097C9A090"));
    var taskbar = (ITaskbarList3)Activator.CreateInstance(type);
    try {
      Marshal.ThrowExceptionForHR(taskbar.HrInit());
      Marshal.ThrowExceptionForHR(taskbar.SetOverlayIcon(hwnd, icon, description));
    } finally { Marshal.ReleaseComObject(taskbar); }
  }
}
'@
$stream = [System.IO.MemoryStream]::new([Convert]::FromBase64String($Png))
try {
  $bitmap = [System.Drawing.Bitmap]::new($stream)
  try {
    $icon = [AetherTaskbarOverlay]::CreateOverlayIcon($bitmap)
    try { [AetherTaskbarOverlay]::SetIcon($Window, $Owner, $icon, $Description) }
    finally { [void] [AetherTaskbarOverlay]::DestroyIcon($icon) }
  } finally { $bitmap.Dispose() }
} finally { $stream.Dispose() }
`
