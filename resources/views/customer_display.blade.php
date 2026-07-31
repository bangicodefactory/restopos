{{--
    Customer display — /pos/{config}/display

    A passive render target driven either by a BroadcastChannel from the register on the same
    machine (zero latency, fully offline) or by Reverb when it runs on a second device.

    Not a PWA: it has no service worker and no manifest. It is always attached to a running
    register, so it has nothing useful to do offline, and precaching a second copy of the shared
    chunks on the same machine buys nothing.

    Propless like the other shells — the config id comes from the URL.
--}}
<!DOCTYPE html>
<html lang="en" class="h-full">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
    <meta name="theme-color" content="#0f172a">

    <title>Customer display</title>

    <link rel="icon" href="/icons/register-192.png" type="image/png">

    @viteReactRefresh
    @vite(['resources/css/app.css', 'resources/js/register/customer-display.tsx'])
</head>
<body class="h-full overflow-hidden bg-slate-900 font-sans text-white antialiased select-none">
    <div id="root" class="h-full"></div>
</body>
</html>
