{{--
    Kitchen display PWA shell — /kitchen/{display}

    PROPLESS BY CONTRACT — see the note in register.blade.php. The display id in the URL is read
    client-side; the display's access token lives in IndexedDB after pairing.

    Dark by default: this screen hangs over a hot line and is read from two metres away.
--}}
<!DOCTYPE html>
<html lang="en" class="h-full dark">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="theme-color" content="#0a0f14">

    <title>Kitchen</title>

    <link rel="manifest" href="/manifest.kitchen.json">
    <link rel="icon" href="/icons/kitchen-192.png" type="image/png">
    <link rel="apple-touch-icon" href="/icons/kitchen-192.png">

    @viteReactRefresh
    @vite(['resources/css/app.css', 'resources/js/kitchen/main.tsx'])
</head>
<body class="h-full overflow-hidden overscroll-none bg-kitchen-bg font-sans text-kitchen-text antialiased select-none">
    <div id="root" class="h-full"></div>
    <noscript>This application requires JavaScript.</noscript>
</body>
</html>
