# Lyric Clipper - one-time setup for Windows.
# Downloads yt-dlp, deno (yt-dlp needs it for YouTube), ffmpeg, whisper.cpp and the models into tools\.
# Run from the project folder:  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
# Re-running is safe: anything already downloaded is skipped. Add -Force to re-download.

param([switch]$Force)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # makes Invoke-WebRequest much faster
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root   = Split-Path -Parent $PSScriptRoot
$tools  = Join-Path $root "tools"
$models = Join-Path $tools "models"
$tmp    = Join-Path $tools "_download"
New-Item -ItemType Directory -Force -Path $tools, $models, $tmp | Out-Null

function Get-File($url, $dest) {
  if ((Test-Path $dest) -and -not $Force) { Write-Host "  have $(Split-Path -Leaf $dest)"; return }
  Write-Host "  downloading $(Split-Path -Leaf $dest) ..."
  try {
    Invoke-WebRequest -Uri $url -OutFile "$dest.part" -UseBasicParsing
  } catch {
    Remove-Item -Force -ErrorAction SilentlyContinue "$dest.part"
    throw "Download failed: $url`n  $($_.Exception.Message)"
  }
  Move-Item -Force "$dest.part" $dest
}

# whisper.cpp publishes every build as a GitHub *pre-release*, and /releases/latest/ skips
# pre-releases (that link returns 404). So ask the API for recent releases and take the
# newest one that has the Windows x64 zip.
function Get-WhisperZipUrl {
  $api = "https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=30"
  try {
    $releases = Invoke-RestMethod -Uri $api -UseBasicParsing -Headers @{ "User-Agent" = "lyricclipper-setup" }
  } catch {
    throw "Could not list whisper.cpp releases ($($_.Exception.Message)).`n" +
      "  Manual fix: download whisper-bin-x64.zip from https://github.com/ggml-org/whisper.cpp/releases,`n" +
      "  unzip it, copy everything from the folder holding whisper-cli.exe into tools\whisper\, then re-run this script."
  }
  foreach ($r in $releases) {
    $asset = $r.assets | Where-Object { $_.name -eq "whisper-bin-x64.zip" } | Select-Object -First 1
    if ($asset) {
      Write-Host "  found whisper.cpp $($r.tag_name)"
      return $asset.browser_download_url
    }
  }
  throw "No recent whisper.cpp release has whisper-bin-x64.zip. Download a Windows x64 build by hand into tools\whisper\ and re-run."
}

function Get-Zip($url, $name) {
  $zip = Join-Path $tmp "$name.zip"
  $out = Join-Path $tmp $name
  Get-File $url $zip
  if (Test-Path $out) { Remove-Item -Recurse -Force $out }
  Expand-Archive -Path $zip -DestinationPath $out -Force
  return $out
}

Write-Host "1/5 yt-dlp"
Get-File "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" (Join-Path $tools "yt-dlp.exe")

Write-Host "2/5 deno (JavaScript runtime yt-dlp uses for YouTube)"
if (-not (Test-Path (Join-Path $tools "deno.exe")) -or $Force) {
  $d = Get-Zip "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip" "deno"
  Copy-Item -Force (Join-Path $d "deno.exe") $tools
} else { Write-Host "  have deno.exe" }

Write-Host "3/5 ffmpeg"
$ffdir = Join-Path $tools "ffmpeg"
if (-not (Test-Path (Join-Path $ffdir "ffmpeg.exe")) -or $Force) {
  $f = Get-Zip "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip" "ffmpeg"
  New-Item -ItemType Directory -Force -Path $ffdir | Out-Null
  Get-ChildItem -Recurse $f -Include ffmpeg.exe, ffprobe.exe | Copy-Item -Destination $ffdir -Force
} else { Write-Host "  have ffmpeg.exe" }

Write-Host "4/5 whisper.cpp"
$wdir = Join-Path $tools "whisper"
if (-not (Test-Path (Join-Path $wdir "whisper-cli.exe")) -or $Force) {
  $w = Get-Zip (Get-WhisperZipUrl) "whisper"
  $cli = Get-ChildItem -Recurse $w -Filter whisper-cli.exe | Select-Object -First 1
  if (-not $cli) { throw "whisper-cli.exe not found in the whisper.cpp download." }
  New-Item -ItemType Directory -Force -Path $wdir | Out-Null
  # The exe needs the DLLs next to it, so copy the whole folder it sits in.
  Copy-Item -Force -Recurse (Join-Path $cli.DirectoryName "*") $wdir
} else { Write-Host "  have whisper-cli.exe" }

Write-Host "5/5 models (about 240 MB)"
$hf = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
Get-File "$hf/ggml-small-q5_1.bin" (Join-Path $models "ggml-small-q5_1.bin")
Get-File "$hf/ggml-base-q5_1.bin"  (Join-Path $models "ggml-base-q5_1.bin")
Get-File "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin" (Join-Path $models "ggml-silero-v5.1.2.bin")

Remove-Item -Recurse -Force $tmp

$cfg = Join-Path $root "config.json"
if (-not (Test-Path $cfg)) { Copy-Item (Join-Path $root "config.example.json") $cfg; Write-Host "Created config.json" }

Write-Host ""
Write-Host "Checking tools:"
& (Join-Path $tools "yt-dlp.exe") --version
& (Join-Path $ffdir "ffmpeg.exe") -hide_banner -version | Select-Object -First 1
if (Test-Path (Join-Path $wdir "whisper-cli.exe")) { Write-Host "whisper-cli.exe OK" }

Write-Host ""
Write-Host "Done. Next:"
Write-Host "  npm install"
Write-Host "  npm run bench -- path\to\a-song.mp3     (M0: pick model + threads)"
Write-Host "  npm start                               (then open http://127.0.0.1:4321)"
