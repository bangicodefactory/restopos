<!DOCTYPE html>
<html lang="{{ str_replace('_', '-', app()->getLocale()) }}" class="h-full">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="csrf-token" content="{{ csrf_token() }}">
    <meta name="theme-color" content="#0f172a">

    <title inertia>{{ config('app.name', 'RestoPOS') }}</title>

    <link rel="icon" href="/favicon.ico" sizes="any">
    <link rel="icon" href="/icons/backoffice-192.png" type="image/png">

    {{-- The back-office is the ONE surface that is a normal, always-online Inertia app. --}}
    @viteReactRefresh
    @vite(['resources/css/app.css', 'resources/js/backoffice/app.tsx'])
    @inertiaHead
</head>
<body class="h-full bg-slate-50 font-sans text-slate-900 antialiased">
    @inertia
</body>
</html>
