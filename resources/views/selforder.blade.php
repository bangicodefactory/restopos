{{--
    Self-order PWA shell — /menu/{token}

    PROPLESS BY CONTRACT — see the note in register.blade.php.

    Extra reason here: this document is fetched by anonymous customers on their own phones, so it
    must not leak a single byte of venue configuration. Branding (name, colours, logo) is applied at
    runtime from the anonymous bootstrap profile, which is scoped by the token in the URL.
--}}
<!DOCTYPE html>
<html lang="en" class="h-full">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="theme-color" content="#0f172a">
    <meta name="referrer" content="same-origin">
    <meta name="robots" content="noindex">

    <title>Menu</title>

    <link rel="manifest" href="/manifest.selforder.json">
    <link rel="icon" href="/icons/selforder-192.png" type="image/png">
    <link rel="apple-touch-icon" href="/icons/selforder-192.png">

    @viteReactRefresh
    @vite(['resources/css/app.css', 'resources/js/selforder/main.tsx'])
</head>
<body class="h-full bg-white font-sans text-slate-900 antialiased">
    <div id="root" class="min-h-full"></div>
    <noscript>This application requires JavaScript.</noscript>
</body>
</html>
