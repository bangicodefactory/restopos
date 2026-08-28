import io

p = 'resources/js/backoffice/components/layout/nav.ts'
s = io.open(p, encoding='utf-8', newline='').read()
old = "            { key: 'presets', labelKey: 'nav.presets', href: null, disabledReasonKey: 'nav.unavailable' },"
assert old in s
s = s.replace(old, """            {
                key: 'presets',
                labelKey: 'nav.presets',
                href: routes.presets.index(),
                match: startsWith('/presets'),
            },""", 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)

p = 'resources/js/backoffice/lib/routes.ts'
s = io.open(p, encoding='utf-8', newline='').read()
old = """    productAttributes: {"""
assert old in s
s = s.replace(old, """    presets: {
        index: (): string => '/presets',
        store: (): string => '/presets',
        edit: (id: number): string => `/presets/${id}/edit`,
        update: (id: number): string => `/presets/${id}`,
        destroy: (id: number): string => `/presets/${id}`,
    },

    serviceWindows: {
        store: (presetId: number): string => `/presets/${presetId}/service-windows`,
        update: (presetId: number, id: number): string => `/presets/${presetId}/service-windows/${id}`,
        destroy: (presetId: number, id: number): string => `/presets/${presetId}/service-windows/${id}`,
    },

    productAttributes: {""", 1)
io.open(p, 'w', encoding='utf-8', newline='').write(s)
print('nav + routes wired')
