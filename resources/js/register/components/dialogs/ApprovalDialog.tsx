import { Button, Dialog, NumPad, cn } from '@shared/ui';
import type { JSX } from 'react';
import { useState } from 'react';

import { useT } from '../../i18n';
import { cancelApproval, managerCandidates, submitApproval } from '../../domain/approval';
import { useUiStore } from '../../state/ui-store';

/** Manager approval prompt (REG-045). */
export function ApprovalDialog(): JSX.Element | null {
    const t = useT();
    const dialog = useUiStore((state) => state.dialog);
    const [managerId, setManagerId] = useState<number | null>(null);
    const [pin, setPin] = useState('');
    const [error, setError] = useState<string | null>(null);

    if (dialog?.kind !== 'approval') return null;
    const ability = typeof dialog.payload?.['ability'] === 'string' ? dialog.payload['ability'] : '';
    const managers = managerCandidates(ability);

    return (
        <Dialog
            open
            dismissible={false}
            onClose={cancelApproval}
            title={t('reg.approval.title')}
            description={t('reg.approval.for', { ability })}
            footer={
                <>
                    <Button variant="ghost" onClick={cancelApproval}>
                        {t('common.cancel')}
                    </Button>
                    <Button
                        disabled={managerId === null || pin.length < 3}
                        onClick={async () => {
                            if (managerId === null) return;
                            const result = await submitApproval({ managerEmployeeId: managerId, pin });
                            if (!result.ok) {
                                setError(
                                    result.reason === 'offline_override_disabled'
                                        ? t('reg.approval.offlineDisabled')
                                        : t('reg.approval.denied'),
                                );
                                setPin('');
                            }
                        }}
                    >
                        {t('common.confirm')}
                    </Button>
                </>
            }
        >
            <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                    {managers.map((manager) => (
                        <button
                            key={manager.id}
                            type="button"
                            onClick={() => setManagerId(manager.id)}
                            className={cn(
                                'min-h-touch-lg rounded-pos px-4 font-semibold ring-1 ring-inset',
                                manager.id === managerId
                                    ? 'bg-brand-600 text-white ring-brand-700'
                                    : 'bg-white ring-slate-300',
                            )}
                        >
                            {manager.name}
                        </button>
                    ))}
                    {managers.length === 0 ? <p className="text-danger">{t('reg.approval.denied')}</p> : null}
                </div>

                <div className="rounded-pos bg-slate-900 px-4 py-3 text-center font-mono text-3xl tracking-[0.4em] text-white">
                    {'•'.repeat(pin.length) || '····'}
                </div>
                {error ? <p className="text-danger">{error}</p> : null}
                <NumPad value={pin} onChange={setPin} mode="plain" decimals={0} scannerGuardMs={0} />
            </div>
        </Dialog>
    );
}
