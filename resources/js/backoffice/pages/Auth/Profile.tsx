/**
 * `Auth/Profile` — the signed-in user and the abilities the server granted them.
 *
 * **Contract gap.** There is no `/profile` route and no profile-update endpoint, so this is a
 * read-only view of the shared `auth` prop. It is genuinely useful as it stands: "which abilities
 * do I actually have" is the first question when a button is missing, and the answer is otherwise
 * invisible.
 */

import { Head, usePage } from '@inertiajs/react';
import type { JSX } from 'react';

import { AppLayout } from '../../components/layout/AppLayout';
import { Badge, Card, CardBody, CardHeader, DefinitionList, Notice } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import type { SharedProps } from '../../types/inertia';

export default function Profile(): JSX.Element {
    const t = useT();
    const { auth } = usePage<SharedProps>().props;

    return (
        <AppLayout title={t('auth.profile')} description={t('auth.profileHint')}>
            <Head title={t('auth.profile')} />

            <div className="grid gap-6 lg:grid-cols-2">
                <Card>
                    <CardHeader title={t('auth.profile')} />
                    <CardBody>
                        <DefinitionList
                            columns={1}
                            items={[
                                { label: 'Nom', value: auth?.user.name ?? '—' },
                                { label: t('auth.email'), value: auth?.user.email ?? '—' },
                                { label: 'ID', value: auth?.user.id ?? '—' },
                            ]}
                        />
                    </CardBody>
                </Card>

                <Card>
                    <CardHeader title={t('auth.abilities')} />
                    <CardBody>
                        {auth === null || auth.abilities.length === 0 ? (
                            <p className="text-sm text-slate-500">{t('state.none')}</p>
                        ) : (
                            <ul className="flex flex-wrap gap-1.5">
                                {auth.abilities.map((ability) => (
                                    <li key={ability}>
                                        <Badge tone="brand">{ability}</Badge>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </CardBody>
                </Card>
            </div>

            <Notice tone="info" className="mt-6">
                {t('auth.notCashier')}
            </Notice>
        </AppLayout>
    );
}
