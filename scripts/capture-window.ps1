# Saves a PNG of the test Chrome window (found by part of its title).
# Used by scripts/screenshots.mjs. Windows only.
param(
  [Parameter(Mandatory = $true)][string]$TitlePart,
  [Parameter(Mandatory = $true)][string]$OutFile
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class Cap {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, int flags, int extra);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  public static IntPtr Find(string part, uint[] pids) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, pid) >= 0 && sb.ToString().Contains(part)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

[Cap]::SetProcessDPIAware() | Out-Null
$pids = [uint32[]]@(Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*puppeteer*' } | ForEach-Object { $_.Id })
$h = [Cap]::Find($TitlePart, $pids)
if ($h -eq [IntPtr]::Zero) { Write-Output 'NO_WINDOW'; exit 2 }

[Cap]::keybd_event(0x12, 0, 0, 0); [Cap]::keybd_event(0x12, 0, 2, 0)
[Cap]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 500

# DWMWA_EXTENDED_FRAME_BOUNDS (9) gives the visible window edges without the shadow.
$r = New-Object Cap+RECT
[Cap]::DwmGetWindowAttribute($h, 9, [ref]$r, [System.Runtime.InteropServices.Marshal]::SizeOf($r)) | Out-Null
$w = $r.R - $r.L; $hgt = $r.B - $r.T
# Park the mouse pointer over empty page space so no tooltip shows up.
[Cap]::SetCursorPos($r.L + [int]($w * 0.4), $r.B - 60) | Out-Null
Start-Sleep -Milliseconds 600
$bmp = New-Object System.Drawing.Bitmap $w, $hgt
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.L, $r.T, 0, 0, $bmp.Size)
$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "SAVED ${w}x${hgt}"
