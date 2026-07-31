{{--
    Register PWA shell — /pos/{config}

    PROPLESS BY CONTRACT. This document must render byte-identically for every device, every
    employee and every tenant, because the service worker precaches it and serves it for every
    navigation under /pos/ (docs/spec/03-architecture.md §1.2).

    That means, and a code review must reject any of these:
      - no @inertia, no page props, no `$variables` of any kind;
      - no CSRF token (the register authenticates with a Sanctum device bearer token from
        IndexedDB, not a cookie session);
      - no user, employee, config or session data — all state comes from IndexedDB + the
        bootstrap API;
      - nothing that varies by request, including the locale (the app reads it from IndexedDB).

    The config id in the URL is read client-side from `location.pathname`.
--}}
<!DOCTYPE html>
<html lang="en" class="h-full">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no">
    <meta name="mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="theme-color" content="#0f172a">

    <title>Register</title>

    <link rel="manifest" href="/manifest.register.json">
    <link rel="icon" href="/icons/register-192.png" type="image/png">
    <link rel="apple-touch-icon" href="/icons/register-192.png">

    @viteReactRefresh
    @vite(['resources/css/app.css', 'resources/js/register/main.tsx'])
</head>
<body class="h-full overflow-hidden overscroll-none bg-slate-100 font-sans text-slate-900 antialiased select-none">
    <div id="root" class="h-full"></div>
    <noscript>This application requires JavaScript.</noscript>
</body>
</html>
