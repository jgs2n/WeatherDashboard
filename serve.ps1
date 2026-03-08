$port = if ($env:PORT) { $env:PORT } else { "9876" }
$root = "C:\Users\John\Desktop\WeatherDashboard"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Serving on http://localhost:$port/"
[Console]::Out.Flush()
while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $path = $ctx.Request.Url.LocalPath
    if ($path -eq "/" -or $path -eq "") { $path = "/index.html" }
    $file = Join-Path $root $path.TrimStart("/")
    if (Test-Path $file -PathType Leaf) {
        $bytes = [System.IO.File]::ReadAllBytes($file)
        $ctx.Response.ContentLength64 = $bytes.Length
        $ext = [System.IO.Path]::GetExtension($file)
        $ctx.Response.ContentType = if ($ext -eq ".html") { "text/html; charset=utf-8" } elseif ($ext -eq ".js") { "application/javascript" } elseif ($ext -eq ".css") { "text/css" } else { "application/octet-stream" }
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
        $ctx.Response.StatusCode = 404
    }
    $ctx.Response.Close()
}
