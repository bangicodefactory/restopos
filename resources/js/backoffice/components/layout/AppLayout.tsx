/**
 * The persistent shell: sidebar, breadcrumb, user menu, flash toasts.
 *
 * Every page renders it as its outermost element. State that must survive navigation (sidebar
 * collapse) lives in `localStorage` rather than in component state, so it behaves identically
 * whether Inertia re-mounts the shell or not.
 *
 * Keyboard: a skip link jumps to `<main>`, the sidebar is a `<nav>` with grouped lists, the
 * mobile drawer traps nothing (it is a plain overlay that closes on Escape and on navigation),
 * and every control keeps the shared focus ring.
 */

import { Link, router, usePage } from '@inertiajs/react';
import { Button, FOCUS_RING, cn, useToast } from '@shared/ui';
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type JSX,
    type ReactNode,
} from 'react';

import { useT } from '../../i18n';
import { initials } from '../../lib/format';
import { routes } from '../../lib/routes';
import type { SharedProps } from '../../types/inertia';

import { NAV, findActive } from './nav';

const COLLAPSE_KEY = 'restopos.bo.sidebar.collapsed';

export type Crumb = {
    label: string;
    href?: string;
};

export type AppLayoutProps = {
    children: ReactNode;
    /** Page heading. Also used as the last breadcrumb when none is given. */
    title: string;
    description?: ReactNode;
    /** Breadcrumb trail *excluding* the current page. */
    breadcrumbs?: Crumb[];
    actions?: ReactNode;
    /** Wide pages (floor editor, analytics) opt out of the reading-width cap. */
    fullWidth?: boolean;
};

export function AppLayout({
    children,
    title,
    description,
    breadcrumbs,
    actions,
    fullWidth = false,
}: AppLayoutProps): JSX.Element {
    const t = useT();
    const page = usePage<SharedProps>();
    const [collapsed, setCollapsed] = useState(() => readCollapsed());
    const [drawerOpen, setDrawerOpen] = useState(false);

    const path = useMemo(() => new URL(page.url, 'http://x').pathname, [page.url]);
    const active = findActive(path);

    useEffect(() => {
        try {
            globalThis.localStorage?.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
        } catch {
            // Preference only; a browser that refuses storage still renders the sidebar.
        }
    }, [collapsed]);

    // Any navigation closes the mobile drawer — otherwise it hides the page you just opened.
    useEffect(() => setDrawerOpen(false), [path]);

    useEffect(() => {
        if (!drawerOpen) return undefined;
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') setDrawerOpen(false);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [drawerOpen]);

    useFlashToasts();

    return (
        <div className="flex min-h-full bg-slate-50">
            <a
                href="#bo-main"
                className={cn(
                    'sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-50',
                    'focus:rounded-pos focus:bg-white focus:px-4 focus:py-2 focus:font-semibold focus:shadow-pos',
                )}
            >
                {t('nav.skipToContent')}
            </a>

            <Sidebar
                collapsed={collapsed}
                onToggleCollapse={() => setCollapsed((value) => !value)}
                activeKey={active?.item.key ?? null}
                drawerOpen={drawerOpen}
                onCloseDrawer={() => setDrawerOpen(false)}
            />

            <div className="flex min-w-0 flex-1 flex-col">
                <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80">
                    <div className="flex items-center gap-3 px-4 py-2">
                        <Button
                            variant="ghost"
                            size="md"
                            className="lg:hidden"
                            aria-label={t('nav.open')}
                            aria-expanded={drawerOpen}
                            onClick={() => setDrawerOpen(true)}
                        >
                            ☰
                        </Button>

                        <Breadcrumb
                            trail={
                                breadcrumbs ??
                                (active && active.item.href
                                    ? [{ label: t(active.item.labelKey), href: active.item.href }]
                                    : [])
                            }
                            current={title}
                        />

                        <div className="ms-auto">
                            <UserMenu />
                        </div>
                    </div>
                </header>

                <main id="bo-main" tabIndex={-1} className={cn('flex-1 px-4 py-6', FOCUS_RING)}>
                    <div className={cn('mx-auto w-full', fullWidth ? 'max-w-none' : 'max-w-7xl')}>
                        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                                <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
                                {description ? (
                                    <p className="mt-1 max-w-3xl text-sm text-slate-600">{description}</p>
                                ) : null}
                            </div>
                            {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
                        </div>

                        {children}
                    </div>
                </main>
            </div>
        </div>
    );
}

// ───────────────────────────────────────────────────────────── sidebar

function Sidebar({
    collapsed,
    onToggleCollapse,
    activeKey,
    drawerOpen,
    onCloseDrawer,
}: {
    collapsed: boolean;
    onToggleCollapse: () => void;
    activeKey: string | null;
    drawerOpen: boolean;
    onCloseDrawer: () => void;
}): JSX.Element {
    const t = useT();

    const body = (
        <nav aria-label={t('app.title')} className="flex h-full flex-col gap-1 overflow-y-auto p-2">
            <div className={cn('mb-2 flex items-center gap-2 px-2 py-2', collapsed && 'justify-center')}>
                <span
                    aria-hidden
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-pos bg-brand-600 font-bold text-white"
                >
                    R
                </span>
                {!collapsed ? <span className="truncate font-semibold text-slate-900">RestoPOS</span> : null}
            </div>

            {NAV.map((group) => (
                <div key={group.key} className="mb-2">
                    {group.labelKey && !collapsed ? (
                        <h2 className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                            {t(group.labelKey)}
                        </h2>
                    ) : null}
                    <ul className="space-y-0.5">
                        {group.items.map((item) => {
                            const label = t(item.labelKey);
                            const isActive = item.key === activeKey;

                            if (item.href === null) {
                                return (
                                    <li key={item.key}>
                                        <span
                                            aria-disabled
                                            title={item.disabledReasonKey ? t(item.disabledReasonKey) : undefined}
                                            className={cn(
                                                'flex min-h-touch cursor-not-allowed items-center gap-2 rounded-pos px-3 text-sm text-slate-400',
                                                collapsed && 'justify-center px-0',
                                            )}
                                        >
                                            {collapsed ? label.slice(0, 2) : label}
                                            {!collapsed ? (
                                                <span aria-hidden className="ms-auto text-xs">
                                                    ∅
                                                </span>
                                            ) : null}
                                        </span>
                                    </li>
                                );
                            }

                            return (
                                <li key={item.key}>
                                    <Link
                                        href={item.href}
                                        onClick={onCloseDrawer}
                                        aria-current={isActive ? 'page' : undefined}
                                        title={collapsed ? label : undefined}
                                        className={cn(
                                            'flex min-h-touch items-center gap-2 rounded-pos px-3 text-sm font-medium',
                                            FOCUS_RING,
                                            isActive
                                                ? 'bg-brand-50 text-brand-800 ring-1 ring-inset ring-brand-200'
                                                : 'text-slate-700 hover:bg-slate-100',
                                            collapsed && 'justify-center px-0',
                                        )}
                                    >
                                        <span className={cn(collapsed && 'sr-only')}>{label}</span>
                                        {collapsed ? <span aria-hidden>{label.slice(0, 2)}</span> : null}
                                    </Link>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            ))}

            <button
                type="button"
                onClick={onToggleCollapse}
                className={cn(
                    'mt-auto hidden min-h-touch items-center gap-2 rounded-pos px-3 text-sm text-slate-500 hover:bg-slate-100 lg:flex',
                    FOCUS_RING,
                    collapsed && 'justify-center px-0',
                )}
            >
                <span aria-hidden>{collapsed ? '»' : '«'}</span>
                {!collapsed ? t('nav.collapse') : <span className="sr-only">{t('nav.expand')}</span>}
            </button>
        </nav>
    );

    return (
        <>
            <aside
                className={cn(
                    'hidden shrink-0 border-e border-slate-200 bg-white lg:block',
                    collapsed ? 'w-16' : 'w-64',
                )}
            >
                <div className="sticky top-0 h-screen">{body}</div>
            </aside>

            {drawerOpen ? (
                <div className="fixed inset-0 z-40 lg:hidden">
                    <button
                        type="button"
                        aria-label={t('action.close')}
                        className="absolute inset-0 bg-black/40"
                        onClick={onCloseDrawer}
                    />
                    <div className="absolute inset-y-0 start-0 w-72 bg-white shadow-pos-lg">{body}</div>
                </div>
            ) : null}
        </>
    );
}

// ───────────────────────────────────────────────────────────── breadcrumb

function Breadcrumb({ trail, current }: { trail: Crumb[]; current: string }): JSX.Element {
    const t = useT();
    return (
        <nav aria-label={t('nav.breadcrumb')} className="min-w-0">
            <ol className="flex flex-wrap items-center gap-1 text-sm text-slate-500">
                <li>
                    <Link href={routes.dashboard()} className={cn('rounded-pos px-1 hover:text-slate-900', FOCUS_RING)}>
                        {t('nav.dashboard')}
                    </Link>
                </li>
                {trail.map((crumb) => (
                    <li key={`${crumb.label}-${crumb.href ?? ''}`} className="flex items-center gap-1">
                        <span aria-hidden>/</span>
                        {crumb.href ? (
                            <Link href={crumb.href} className={cn('rounded-pos px-1 hover:text-slate-900', FOCUS_RING)}>
                                {crumb.label}
                            </Link>
                        ) : (
                            <span>{crumb.label}</span>
                        )}
                    </li>
                ))}
                <li className="flex min-w-0 items-center gap-1">
                    <span aria-hidden>/</span>
                    <span aria-current="page" className="truncate font-medium text-slate-900">
                        {current}
                    </span>
                </li>
            </ol>
        </nav>
    );
}

// ───────────────────────────────────────────────────────────── user menu

function UserMenu(): JSX.Element {
    const t = useT();
    const { auth } = usePage<SharedProps>().props;
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return undefined;
        const onDown = (event: MouseEvent): void => {
            if (!ref.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const logout = useCallback(() => router.post(routes.logout()), []);

    if (auth === null) return <span />;

    return (
        <div className="relative" ref={ref}>
            <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={t('user.menu')}
                onClick={() => setOpen((value) => !value)}
                className={cn(
                    'flex min-h-touch items-center gap-2 rounded-pos px-2 text-sm hover:bg-slate-100',
                    FOCUS_RING,
                )}
            >
                <span
                    aria-hidden
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-800 text-xs font-bold text-white"
                >
                    {initials(auth.user.name)}
                </span>
                <span className="hidden max-w-[12rem] truncate sm:inline">{auth.user.name}</span>
            </button>

            {open ? (
                <div
                    role="menu"
                    className="absolute end-0 z-40 mt-1 w-64 rounded-pos bg-white p-1 shadow-pos-lg ring-1 ring-slate-200"
                >
                    <div className="border-b border-slate-100 px-3 py-2">
                        <div className="truncate font-medium text-slate-900">{auth.user.name}</div>
                        <div className="truncate text-xs text-slate-500">{auth.user.email}</div>
                    </div>

                    <Link
                        href="/profile"
                        role="menuitem"
                        onClick={(event) => {
                            // No `/profile` route exists in routes/web.php — see Auth/Profile.
                            event.preventDefault();
                            setOpen(false);
                        }}
                        aria-disabled
                        title={t('auth.profileHint')}
                        className="flex min-h-touch cursor-not-allowed items-center rounded-pos px-3 text-sm text-slate-400"
                    >
                        {t('user.profile')}
                    </Link>

                    <button
                        type="button"
                        role="menuitem"
                        onClick={logout}
                        className={cn(
                            'flex min-h-touch w-full items-center rounded-pos px-3 text-start text-sm text-slate-700 hover:bg-slate-100',
                            FOCUS_RING,
                        )}
                    >
                        {t('user.logout')}
                    </button>
                </div>
            ) : null}
        </div>
    );
}

// ───────────────────────────────────────────────────────────── flash

/**
 * Turns the server's `flash` prop into a toast.
 *
 * Keyed on the message text so a repeated "Product saved." after two consecutive saves replaces
 * the previous toast rather than stacking a second identical one.
 */
function useFlashToasts(): void {
    const { flash } = usePage<SharedProps>().props;
    const toast = useToast();
    const lastRef = useRef<string>('');

    useEffect(() => {
        const success = flash?.success ?? null;
        const error = flash?.error ?? null;
        const signature = `${success ?? ''}|${error ?? ''}`;
        if (signature === '|' || signature === lastRef.current) return;
        lastRef.current = signature;

        if (success !== null) toast.show({ id: 'flash', tone: 'success', title: success });
        if (error !== null) toast.show({ id: 'flash', tone: 'danger', title: error, durationMs: 8_000 });
    }, [flash, toast]);
}

function readCollapsed(): boolean {
    try {
        return globalThis.localStorage?.getItem(COLLAPSE_KEY) === '1';
    } catch {
        return false;
    }
}
